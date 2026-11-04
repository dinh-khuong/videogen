import "server-only";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { ASSET_HASHTAG_MIN, ensureHashtags, parseHashtags, textHashtags, withHashtags } from "@/lib/hashtags";
import type { AnalysisStatus, AssetItem, AssetKind, Page } from "@/lib/types";
import { db, nowIso } from "./db";
import { probe } from "./engine";
import { HttpError, moveFile, removeMedia } from "./files";
import { MEDIA_DIR, TMP_DIR, mediaPath, mediaUrl } from "./paths";
import { setTags, tagFilterParam, tagFilterSql, tagsFor } from "./tags";

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
  folder_id: string | null;
  created_at: string;
  used_in: number;
  /** Chỉ có khi truy vấn sắp xếp theo "recent" */
  last_used_at?: string | null;
};

const SELECT = `SELECT a.*, (SELECT COUNT(DISTINCT va.video_id) FROM video_assets va WHERE va.asset_id = a.id) AS used_in FROM assets a`;

/**
 * Như SELECT, kèm lần cuối asset được dùng: lúc người dùng chọn nó cho một job (kể cả job chưa xong), hoặc lúc video
 * có nó ra đời. Ảnh/clip hệ thống tìm trên mạng không tính ở vế sau, nếu không chúng tràn ngập danh sách "dùng gần đây".
 */
const SELECT_RECENT = `WITH picks(asset_id, at) AS (
    SELECT je.value, MAX(j.created_at) FROM jobs j, json_each(j.input, '$.assetIds') je GROUP BY je.value
  ), made(asset_id, at) AS (
    SELECT va.asset_id, MAX(v.created_at) FROM video_assets va JOIN videos v ON v.id = va.video_id GROUP BY va.asset_id
  )
  SELECT a.*, (SELECT COUNT(DISTINCT va.video_id) FROM video_assets va WHERE va.asset_id = a.id) AS used_in,
    NULLIF(MAX(COALESCE(picks.at, ''), CASE WHEN a.source = 'upload' THEN COALESCE(made.at, '') ELSE '' END), '') AS last_used_at
  FROM assets a LEFT JOIN picks ON picks.asset_id = a.id LEFT JOIN made ON made.asset_id = a.id`;

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
    folderId: r.folder_id,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at ?? null,
  }));
}

/** SQL con trả về các thư mục trong json `?` và mọi thư mục con cháu của chúng. */
export const SUBTREE_SQL = `WITH RECURSIVE sub(id) AS (
  SELECT value FROM json_each(?)
  UNION SELECT f.id FROM asset_folders f JOIN sub ON f.parent_id = sub.id
) SELECT id FROM sub`;

export const ASSET_SORTS = {
  new: "a.created_at DESC",
  old: "a.created_at ASC",
  name: "a.title COLLATE NOCASE ASC, a.created_at DESC",
  size: "a.size_bytes DESC, a.created_at DESC",
  /** Asset dùng gần nhất lên đầu (chưa từng dùng thì theo ngày thêm); cần SELECT_RECENT */
  recent: "last_used_at DESC, a.created_at DESC",
} as const;

export type AssetQuery = {
  q?: string;
  tag?: string;
  kind?: string;
  ids?: string[];
  status?: string;
  /** id thư mục, hoặc "none" = asset chưa thuộc thư mục nào (nằm ở gốc) */
  folder?: string;
  /** Lấy cả asset trong thư mục con của `folder` */
  recursive?: boolean;
  /** Asset nằm trong một trong các thư mục này (tính cả thư mục con) */
  folders?: string[];
  sort?: string;
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
    params.push(tagFilterParam(query.tag));
  }
  if (query.kind) {
    // một loại ("audio") hoặc nhiều loại cách nhau bằng dấu phẩy ("image,video")
    const kinds = query.kind.split(",").filter((k) => k === "image" || k === "video" || k === "audio");
    if (kinds.length) {
      clauses.push("a.kind IN (SELECT value FROM json_each(?))");
      params.push(JSON.stringify(kinds));
    }
  }
  if (query.status) {
    clauses.push("a.analysis_status IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(query.status.split(",")));
  }
  if (query.folder === "none") {
    clauses.push("a.folder_id IS NULL");
  } else if (query.folder && query.recursive) {
    clauses.push(`a.folder_id IN (${SUBTREE_SQL})`);
    params.push(JSON.stringify([query.folder]));
  } else if (query.folder) {
    clauses.push("a.folder_id = ?");
    params.push(query.folder);
  }
  if (query.folders?.length) {
    clauses.push(`a.folder_id IN (${SUBTREE_SQL})`);
    params.push(JSON.stringify(query.folders));
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
  const order = query.sort && Object.hasOwn(ASSET_SORTS, query.sort) ? ASSET_SORTS[query.sort as keyof typeof ASSET_SORTS] : ASSET_SORTS.new;
  const rows = db()
    .prepare(`${query.sort === "recent" ? SELECT_RECENT : SELECT}${sql} ORDER BY ${order} LIMIT ? OFFSET ?`)
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
  folderId?: string | null;
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
                 duration, size_bytes, sha1, folder_id, analysis_status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
            )
            .run(p.id, info.kind, file, thumb, p.item.title, p.item.description, p.item.source, p.item.sourceUrl ?? null,
              info.width ?? null, info.height ?? null, info.duration ?? null, p.item.size, p.item.sha1, p.item.folderId ?? null);
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
  patch: { title?: string; description?: string; aiSummary?: string; ocrText?: string; folderId?: string | null },
): AssetItem | null {
  const current = getAsset(id);
  if (!current) return null;
  const description = patch.description ?? current.description;
  db().transaction(() => {
    db()
      .prepare("UPDATE assets SET title = ?, description = ?, ai_summary = ?, ocr_text = ?, folder_id = ?, updated_at = ? WHERE id = ?")
      .run(patch.title ?? current.title, description, patch.aiSummary ?? current.aiSummary, patch.ocrText ?? current.ocrText,
        patch.folderId === undefined ? current.folderId : patch.folderId, nowIso(), id);
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
    const saved = db()
      .prepare(
        `UPDATE assets SET analysis_status = 'done', analysis_error = NULL, ocr_text = ?, ai_summary = ?, ai_tags = ?, analyzed_at = ?
         WHERE id = ? AND analysis_status = 'running'`,
      )
      .run((result.ocr_text ?? "").slice(0, 4000), (result.summary ?? "").slice(0, 2000), JSON.stringify(result.tags ?? []),
        nowIso(), result.id);
    if (saved.changes) topUpHashtags(result.id, result.tags ?? []);
  } else {
    failAnalysis([result.id], result.error || "Lỗi không xác định");
  }
}

/** Asset không do người dùng tải lên (ảnh/clip hệ thống tìm về) mà mô tả còn quá ít hashtag. */
const SPARSE_DESCRIPTION_HASHTAGS = 3;

/**
 * Mô tả của asset hệ thống tìm về thường thiếu hashtag: thêm hashtag AI vừa gợi ý vào cuối mô tả để thấy và sửa được,
 * đồng thời thành tag để lọc. Chỉ thêm vào, không đụng tới chữ đã có; mô tả người dùng tự viết cho asset tải lên giữ nguyên.
 */
function topUpHashtags(id: string, aiTags: string[]): void {
  const row = db().prepare("SELECT description, source FROM assets WHERE id = ?").get(id) as
    | { description: string; source: string }
    | undefined;
  if (!row || row.source === "upload") return;
  // Bản cũ ghi dòng "Từ khóa tìm kiếm: ..." (từ khóa tiếng Anh) thay cho hashtag: bỏ dòng đó, các từ của nó thành hashtag
  const legacy = row.description.match(/\n?Từ khóa tìm kiếm: ([^\n]*)/);
  const base = legacy ? row.description.replace(legacy[0], "") : row.description;
  const existing = parseHashtags(base);
  if (!legacy && existing.length >= SPARSE_DESCRIPTION_HASHTAGS) return;
  const description = withHashtags(base, ensureHashtags([existing], [aiTags, textHashtags(legacy?.[1])], ASSET_HASHTAG_MIN));
  if (description === row.description.trim()) return;
  db().transaction(() => {
    db().prepare("UPDATE assets SET description = ?, updated_at = ? WHERE id = ?").run(description, nowIso(), id);
    setTags("asset", id, parseHashtags(description));
  })();
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

/** Số asset còn chờ/đang phân tích trong phạm vi (ids, tag hoặc thư mục; không có gì = toàn thư viện). */
export function countUnanalyzed(scope: { ids?: string[]; tag?: string | null; folders?: string[] }): number {
  // Chỉ ảnh/video: audio không được AI chọn cho từng bước nên job không cần chờ
  const { sql, params } = where({
    ids: scope.ids,
    tag: scope.tag ?? undefined,
    folders: scope.folders,
    kind: "image,video",
    status: "pending,running",
  });
  return (db().prepare(`SELECT COUNT(*) AS n FROM assets a${sql}`).get(...params) as { n: number }).n;
}
