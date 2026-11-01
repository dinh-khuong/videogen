import "server-only";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { parseHashtags } from "@/lib/hashtags";
import type { AnalysisStatus, AssetItem, AssetKind, Page } from "@/lib/types";
import { db, nowIso } from "./db";
import { probe } from "./engine";
import { HttpError, moveFile, removeMedia } from "./files";
import { MEDIA_DIR, TMP_DIR, mediaPath, mediaUrl } from "./paths";
import { setTags, tagFilterSql, tagsFor } from "./tags";

type AssetRow = {
  id: string;
  kind: AssetKind;
  file: string;
  thumbnail: string | null;
  title: string;
  description: string;
  source: string;
  source_url: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  size_bytes: number | null;
  ocr_text: string;
  ai_summary: string;
  ai_tags: string;
  analysis_status: AnalysisStatus;
  analysis_error: string | null;
  analyzed_at: string | null;
  created_at: string;
  used_in: number;
};

const SELECT = `SELECT a.*, (SELECT COUNT(*) FROM video_assets va WHERE va.asset_id = a.id) AS used_in FROM assets a`;

function parseTags(json: string): string[] {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

function toItems(rows: AssetRow[]): AssetItem[] {
  const tags = tagsFor("asset", rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    url: mediaUrl(r.file)!,
    thumbUrl: mediaUrl(r.thumbnail ?? (r.kind === "image" ? r.file : null)),
    title: r.title,
    description: r.description,
    tags: tags.get(r.id) ?? [],
    source: r.source,
    sourceUrl: r.source_url,
    width: r.width,
    height: r.height,
    duration: r.duration,
    sizeBytes: r.size_bytes,
    usedIn: r.used_in,
    ocrText: r.ocr_text,
    aiSummary: r.ai_summary,
    aiTags: parseTags(r.ai_tags),
    analysisStatus: r.analysis_status,
    analysisError: r.analysis_error,
    analyzedAt: r.analyzed_at,
    createdAt: r.created_at,
  }));
}

export type AssetQuery = {
  q?: string;
  tag?: string;
  kind?: string;
  ids?: string[];
  status?: string;
  limit?: number;
  offset?: number;
};

function where(query: AssetQuery): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.q) {
    // Tìm cả trong tóm tắt AI và chữ đọc được trong asset
    clauses.push("(a.title LIKE ? OR a.description LIKE ? OR a.ai_summary LIKE ? OR a.ocr_text LIKE ?)");
    params.push(...Array(4).fill(`%${query.q}%`));
  }
  if (query.tag) {
    clauses.push(tagFilterSql("asset", "a"));
    params.push(query.tag);
  }
  if (query.kind === "image" || query.kind === "video") {
    clauses.push("a.kind = ?");
    params.push(query.kind);
  }
  if (query.status) {
    clauses.push("a.analysis_status IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(query.status.split(",")));
  }
  if (query.ids) {
    clauses.push("a.id IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(query.ids));
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

export function listAssets(query: AssetQuery = {}): Page<AssetItem> {
  const { sql, params } = where(query);
  const limit = Math.min(Math.max(query.limit ?? 60, 1), 500);
  const rows = db()
    .prepare(`${SELECT}${sql} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, query.offset ?? 0) as AssetRow[];
  const { total } = db().prepare(`SELECT COUNT(*) AS total FROM assets a${sql}`).get(...params) as { total: number };
  return { items: toItems(rows), total };
}

export function getAsset(id: string): AssetItem | null {
  const row = db().prepare(`${SELECT} WHERE a.id = ?`).get(id) as AssetRow | undefined;
  return row ? toItems([row])[0] : null;
}

/** Đường dẫn file của asset (kiểm tra loại nếu cần), null nếu không có. */
export function assetFilePath(id: string, kind?: AssetKind): string | null {
  const row = db().prepare("SELECT file, kind FROM assets WHERE id = ?").get(id) as { file: string; kind: AssetKind } | undefined;
  if (!row || (kind && row.kind !== kind)) return null;
  return mediaPath(row.file);
}

export type EngineAsset = {
  id: string;
  path: string;
  kind: AssetKind;
  description: string;
  tags: string[];
  summary: string;
  ocr_text: string;
  duration: number | null;
};

/** Asset kèm mô tả, tóm tắt AI và chữ trong asset, để đưa vào spec của engine. */
export function assetsForEngine(query: AssetQuery): EngineAsset[] {
  const { sql, params } = where(query);
  const rows = db()
    .prepare(`SELECT a.* FROM assets a${sql} ORDER BY a.created_at DESC LIMIT ?`)
    .all(...params, query.limit ?? 150) as AssetRow[];
  const tags = tagsFor("asset", rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    path: mediaPath(r.file),
    kind: r.kind,
    description: [r.title, r.description].filter(Boolean).join(" — "),
    tags: [...new Set([...(tags.get(r.id) ?? []), ...parseTags(r.ai_tags)])],
    summary: r.ai_summary,
    ocr_text: r.ocr_text,
    duration: r.duration,
  }));
}

export function findAssetBySha1(sha1: string): string | null {
  const row = db().prepare("SELECT id FROM assets WHERE sha1 = ?").get(sha1) as { id: string } | undefined;
  return row?.id ?? null;
}

export type NewAsset = {
  tmpPath: string;
  ext: string;
  sha1: string;
  size: number;
  title: string;
  description: string;
  source: string;
  sourceUrl?: string | null;
};

/**
 * Thêm asset (ảnh hoặc video) từ file tạm; file tạm được chuyển vào thư mục media. Asset mới chờ phân tích (OCR + AI).
 * Asset trùng nội dung (cùng sha1) không thêm lại mà trả về id có sẵn.
 */
export async function addAssets(items: NewAsset[]): Promise<{ id: string; existed: boolean }[]> {
  const prepared = items.map((item) => ({ item, existing: findAssetBySha1(item.sha1), id: crypto.randomUUID() }));
  const fresh = prepared.filter((p) => !p.existing);

  // Đọc kích thước/thời lượng + tạo thumbnail trong một lần gọi engine
  const probeDir = path.join(TMP_DIR, crypto.randomUUID());
  await fsp.mkdir(probeDir, { recursive: true });
  try {
    const named = await Promise.all(
      fresh.map(async (p) => {
        const named = path.join(probeDir, `${p.id}${p.item.ext}`);
        await fsp.copyFile(p.item.tmpPath, named);
        return named;
      }),
    );
    const infos = await probe(named, path.join(probeDir, "thumbs"));
    const bad = infos.find((i) => i.error || !i.kind);
    if (bad) throw new HttpError(415, `File không hợp lệ hoặc định dạng không hỗ trợ (${bad.error ?? "không đọc được"})`);

    for (const [k, p] of fresh.entries()) {
      const info = infos[k];
      const file = `assets/${p.id}${p.item.ext}`;
      const thumb = info.thumbnail ? `thumbs/${p.id}.jpg` : null;
      await moveFile(named[k], path.join(MEDIA_DIR, file));
      if (info.thumbnail && thumb) await moveFile(info.thumbnail, path.join(MEDIA_DIR, thumb));
      try {
        db().transaction(() => {
          db()
            .prepare(
              `INSERT INTO assets (id, kind, file, thumbnail, title, description, source, source_url, width, height,
                 duration, size_bytes, sha1, analysis_status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
            )
            .run(p.id, info.kind, file, thumb, p.item.title, p.item.description, p.item.source, p.item.sourceUrl ?? null,
              info.width ?? null, info.height ?? null, info.duration ?? null, p.item.size, p.item.sha1);
          setTags("asset", p.id, parseHashtags(p.item.description));
        })();
      } catch (e) {
        await removeMedia(file, thumb);
        // Hai request cùng thêm một file: bản kia đã thắng, dùng lại asset đó
        const winner = findAssetBySha1(p.item.sha1);
        if (!winner) throw e;
        p.existing = winner;
      }
    }
  } finally {
    await fsp.rm(probeDir, { recursive: true, force: true });
    await Promise.all(items.map((i) => fsp.rm(i.tmpPath, { force: true })));
  }
  return prepared.map((p) => ({ id: p.existing ?? p.id, existed: !!p.existing }));
}

export function updateAsset(
  id: string,
  patch: { title?: string; description?: string; aiSummary?: string; ocrText?: string },
): AssetItem | null {
  const current = getAsset(id);
  if (!current) return null;
  const description = patch.description ?? current.description;
  db().transaction(() => {
    db()
      .prepare("UPDATE assets SET title = ?, description = ?, ai_summary = ?, ocr_text = ?, updated_at = ? WHERE id = ?")
      .run(patch.title ?? current.title, description, patch.aiSummary ?? current.aiSummary, patch.ocrText ?? current.ocrText,
        nowIso(), id);
    setTags("asset", id, parseHashtags(description));
  })();
  return getAsset(id);
}

export async function deleteAsset(id: string): Promise<boolean> {
  const row = db().prepare("SELECT file, thumbnail FROM assets WHERE id = ?").get(id) as
    | { file: string; thumbnail: string | null }
    | undefined;
  if (!row) return false;
  db().prepare("DELETE FROM assets WHERE id = ?").run(id);
  await removeMedia(row.file, row.thumbnail);
  return true;
}

// ---- Hàng đợi phân tích (dùng bởi analyzer.ts) ----

/** Đưa asset về hàng đợi phân tích. ids rỗng + failedOnly: mọi asset phân tích lỗi. Trả về số asset được xếp hàng. */
export function queueAnalysis(ids: string[], failedOnly = false): number {
  if (failedOnly && !ids.length) {
    return db().prepare("UPDATE assets SET analysis_status = 'pending', analysis_error = NULL WHERE analysis_status = 'failed'").run()
      .changes;
  }
  return db()
    .prepare(
      `UPDATE assets SET analysis_status = 'pending', analysis_error = NULL
       WHERE id IN (SELECT value FROM json_each(?)) AND analysis_status != 'running'`,
    )
    .run(JSON.stringify(ids)).changes;
}

/** Nhận nguyên tử tối đa `limit` asset đang chờ, chuyển sang 'running'. */
export function claimPendingAssets(limit: number): { id: string; path: string; kind: AssetKind; title: string; description: string }[] {
  return db().transaction(() => {
    const rows = db()
      .prepare("SELECT id, file, kind, title, description FROM assets WHERE analysis_status = 'pending' ORDER BY created_at LIMIT ?")
      .all(limit) as { id: string; file: string; kind: AssetKind; title: string; description: string }[];
    const mark = db().prepare("UPDATE assets SET analysis_status = 'running', analysis_error = NULL WHERE id = ?");
    for (const r of rows) mark.run(r.id);
    return rows.map((r) => ({ id: r.id, path: mediaPath(r.file), kind: r.kind, title: r.title, description: r.description }));
  })();
}

export function saveAnalysis(result: {
  id: string;
  status: "done" | "failed";
  ocr_text?: string;
  summary?: string;
  tags?: string[];
  error?: string | null;
}): void {
  if (result.status === "done") {
    db()
      .prepare(
        `UPDATE assets SET analysis_status = 'done', analysis_error = NULL, ocr_text = ?, ai_summary = ?, ai_tags = ?, analyzed_at = ?
         WHERE id = ? AND analysis_status = 'running'`,
      )
      .run((result.ocr_text ?? "").slice(0, 4000), (result.summary ?? "").slice(0, 2000), JSON.stringify(result.tags ?? []),
        nowIso(), result.id);
  } else {
    failAnalysis([result.id], result.error || "Lỗi không xác định");
  }
}

export function failAnalysis(ids: string[], error: string): void {
  db()
    .prepare(
      `UPDATE assets SET analysis_status = 'failed', analysis_error = ?, analyzed_at = ?
       WHERE id IN (SELECT value FROM json_each(?)) AND analysis_status = 'running'`,
    )
    .run(error.slice(0, 1000), nowIso(), JSON.stringify(ids));
}

/** Asset đang 'running' khi server tắt: đưa lại hàng đợi. */
export function requeueInterruptedAnalysis(): void {
  db().prepare("UPDATE assets SET analysis_status = 'pending' WHERE analysis_status = 'running'").run();
}

/** Số asset còn chờ/đang phân tích trong phạm vi (ids hoặc tag; không có gì = toàn thư viện). */
export function countUnanalyzed(scope: { ids?: string[]; tag?: string | null }): number {
  const { sql, params } = where({ ids: scope.ids, tag: scope.tag ?? undefined, status: "pending,running" });
  return (db().prepare(`SELECT COUNT(*) AS n FROM assets a${sql}`).get(...params) as { n: number }).n;
}
