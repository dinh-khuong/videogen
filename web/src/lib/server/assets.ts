import "server-only";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { and, asc, count, desc, eq, getTableColumns, isNull, like, ne, or, sql, type SQL } from "drizzle-orm";
import { ASSET_HASHTAG_MIN, ensureHashtags, parseHashtags, textHashtags, withHashtags } from "@/lib/hashtags";
import type { AssetItem, AssetKind, Page } from "@/lib/types";
import { db, inList, nowIso } from "./db";
import { probe } from "./engine";
import { HttpError, moveFile, removeMedia } from "./files";
import { MEDIA_DIR, TMP_DIR, mediaPath, mediaUrl } from "./paths";
import { assets, jobs, videoAssets, videos } from "./schema";
import { hasAnyTag, setTags, tagsFor } from "./tags";

type AssetRow = typeof assets.$inferSelect & {
  usedIn: number;
  /** Chỉ có khi truy vấn sắp xếp theo "recent" */
  lastUsedAt?: string | null;
};

// Tiểu truy vấn tương quan viết bằng SQL thô: Drizzle bỏ tên bảng khỏi cột trong trường select của truy vấn một bảng,
// nên một cột như ${assets.id} ở đây sẽ thành "id" trần và mất tương quan với bảng ngoài.
const usedIn = sql<number>`(SELECT COUNT(DISTINCT va.video_id) FROM video_assets va WHERE va.asset_id = assets.id)`;

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
    sourceUrl: r.sourceUrl,
    width: r.width,
    height: r.height,
    duration: r.duration,
    sizeBytes: r.sizeBytes,
    usedIn: r.usedIn,
    ocrText: r.ocrText,
    aiSummary: r.aiSummary,
    aiTags: parseTags(r.aiTags),
    analysisStatus: r.analysisStatus,
    analysisError: r.analysisError,
    analyzedAt: r.analyzedAt,
    folderId: r.folderId,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt ?? null,
  }));
}

/** Câu lệnh trả về id các thư mục trong danh sách và mọi thư mục con cháu của chúng (dùng trong `IN (...)` hoặc `db.all`). */
export function subtreeSql(folderIds: string[]): SQL {
  return sql`WITH RECURSIVE sub(id) AS (
    SELECT value FROM json_each(${JSON.stringify(folderIds)})
    UNION SELECT f.id FROM asset_folders f JOIN sub ON f.parent_id = sub.id
  ) SELECT id FROM sub`;
}

export const ASSET_SORTS = {
  new: [desc(assets.createdAt)],
  old: [asc(assets.createdAt)],
  name: [sql`${assets.title} COLLATE NOCASE ASC`, desc(assets.createdAt)],
  size: [desc(assets.sizeBytes), desc(assets.createdAt)],
} as const;

/** Sắp xếp "recent" (asset dùng gần nhất lên đầu) có truy vấn riêng, xem recentAssets. */
const SORT_RECENT = "recent";

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

function where(query: AssetQuery): SQL | undefined {
  const conditions: (SQL | undefined)[] = [];
  if (query.q) {
    // Tìm cả trong tóm tắt AI và chữ đọc được trong asset
    const pattern = `%${query.q}%`;
    conditions.push(or(like(assets.title, pattern), like(assets.description, pattern), like(assets.aiSummary, pattern), like(assets.ocrText, pattern)));
  }
  if (query.tag) conditions.push(hasAnyTag("asset", assets.id, query.tag));
  if (query.kind) {
    // một loại ("audio") hoặc nhiều loại cách nhau bằng dấu phẩy ("image,video")
    const kinds = query.kind.split(",").filter((k) => k === "image" || k === "video" || k === "audio");
    if (kinds.length) conditions.push(inList(assets.kind, kinds));
  }
  if (query.status) conditions.push(inList(assets.analysisStatus, query.status.split(",")));
  if (query.folder === "none") {
    conditions.push(isNull(assets.folderId));
  } else if (query.folder && query.recursive) {
    conditions.push(sql`${assets.folderId} IN (${subtreeSql([query.folder])})`);
  } else if (query.folder) {
    conditions.push(eq(assets.folderId, query.folder));
  }
  if (query.folders?.length) conditions.push(sql`${assets.folderId} IN (${subtreeSql(query.folders)})`);
  if (query.ids) conditions.push(inList(assets.id, query.ids));
  return and(...conditions);
}

/**
 * Asset kèm lần cuối được dùng: lúc người dùng chọn nó cho một job (kể cả job chưa xong), hoặc lúc video có nó ra đời.
 * Ảnh/clip hệ thống tìm trên mạng không tính ở vế sau, nếu không chúng tràn ngập danh sách "dùng gần đây".
 */
function recentAssets(condition: SQL | undefined, limit: number, offset: number): AssetRow[] {
  const d = db();
  // Alias các cột của hai CTE phải khác nhau: Drizzle viết cột của CTE không kèm tên bảng
  const picks = d.$with("picks").as(
    d
      .select({ assetId: sql<string>`je.value`.as("picked_asset"), at: sql<string>`MAX(j.created_at)`.as("picked_at") })
      .from(sql`${jobs} j, json_each(j.input, '$.assetIds') je`)
      .groupBy(sql`je.value`),
  );
  const made = d.$with("made").as(
    d
      .select({ assetId: sql<string>`${videoAssets.assetId}`.as("made_asset"), at: sql<string>`MAX(${videos.createdAt})`.as("made_at") })
      .from(videoAssets)
      .innerJoin(videos, eq(videos.id, videoAssets.videoId))
      .groupBy(videoAssets.assetId),
  );
  return d
    .with(picks, made)
    .select({
      ...getTableColumns(assets),
      usedIn,
      lastUsedAt: sql<string | null>`NULLIF(MAX(COALESCE(${picks.at}, ''), CASE WHEN ${assets.source} = 'upload' THEN COALESCE(${made.at}, '') ELSE '' END), '')`.as(
        "last_used_at",
      ),
    })
    .from(assets)
    .leftJoin(picks, eq(picks.assetId, assets.id))
    .leftJoin(made, eq(made.assetId, assets.id))
    .where(condition)
    .orderBy(sql`last_used_at DESC`, desc(assets.createdAt))
    .limit(limit)
    .offset(offset)
    .all();
}

export function listAssets(query: AssetQuery = {}): Page<AssetItem> {
  const condition = where(query);
  const limit = Math.min(Math.max(query.limit ?? 60, 1), 500);
  const offset = query.offset ?? 0;
  const rows =
    query.sort === SORT_RECENT
      ? recentAssets(condition, limit, offset)
      : db()
          .select({ ...getTableColumns(assets), usedIn })
          .from(assets)
          .where(condition)
          .orderBy(...(query.sort && Object.hasOwn(ASSET_SORTS, query.sort) ? ASSET_SORTS[query.sort as keyof typeof ASSET_SORTS] : ASSET_SORTS.new))
          .limit(limit)
          .offset(offset)
          .all();
  const { total } = db().select({ total: count() }).from(assets).where(condition).get()!;
  return { items: toItems(rows), total };
}

export function getAsset(id: string): AssetItem | null {
  const row = db()
    .select({ ...getTableColumns(assets), usedIn })
    .from(assets)
    .where(eq(assets.id, id))
    .get();
  return row ? toItems([row])[0] : null;
}

/** Đường dẫn file của asset (kiểm tra loại nếu cần), null nếu không có. */
export function assetFilePath(id: string, kind?: AssetKind): string | null {
  const row = db().select({ file: assets.file, kind: assets.kind }).from(assets).where(eq(assets.id, id)).get();
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
  const rows = db()
    .select()
    .from(assets)
    .where(where(query))
    .orderBy(desc(assets.createdAt))
    .limit(query.limit ?? 150)
    .all();
  const tags = tagsFor("asset", rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    path: mediaPath(r.file),
    kind: r.kind,
    description: [r.title, r.description].filter(Boolean).join(" — "),
    tags: [...new Set([...(tags.get(r.id) ?? []), ...parseTags(r.aiTags)])],
    summary: r.aiSummary,
    ocr_text: r.ocrText,
    duration: r.duration,
  }));
}

export function findAssetBySha1(sha1: string): string | null {
  return db().select({ id: assets.id }).from(assets).where(eq(assets.sha1, sha1)).get()?.id ?? null;
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
        db().transaction((tx) => {
          tx.insert(assets)
            .values({
              id: p.id,
              kind: info.kind,
              file,
              thumbnail: thumb,
              title: p.item.title,
              description: p.item.description,
              source: p.item.source,
              sourceUrl: p.item.sourceUrl ?? null,
              width: info.width ?? null,
              height: info.height ?? null,
              duration: info.duration ?? null,
              sizeBytes: p.item.size,
              sha1: p.item.sha1,
              folderId: p.item.folderId ?? null,
              analysisStatus: "pending",
            })
            .run();
          setTags("asset", p.id, parseHashtags(p.item.description));
        });
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
  db().transaction((tx) => {
    tx.update(assets)
      .set({
        title: patch.title ?? current.title,
        description,
        aiSummary: patch.aiSummary ?? current.aiSummary,
        ocrText: patch.ocrText ?? current.ocrText,
        folderId: patch.folderId === undefined ? current.folderId : patch.folderId,
        updatedAt: nowIso(),
      })
      .where(eq(assets.id, id))
      .run();
    setTags("asset", id, parseHashtags(description));
  });
  return getAsset(id);
}

export async function deleteAsset(id: string): Promise<boolean> {
  const row = db().select({ file: assets.file, thumbnail: assets.thumbnail }).from(assets).where(eq(assets.id, id)).get();
  if (!row) return false;
  db().delete(assets).where(eq(assets.id, id)).run();
  await removeMedia(row.file, row.thumbnail);
  return true;
}

// ---- Hàng đợi phân tích (dùng bởi analyzer.ts) ----

/** Đưa asset về hàng đợi phân tích. ids rỗng + failedOnly: mọi asset phân tích lỗi. Trả về số asset được xếp hàng. */
export function queueAnalysis(ids: string[], failedOnly = false): number {
  const pending = { analysisStatus: "pending", analysisError: null } as const;
  if (failedOnly && !ids.length) {
    return db().update(assets).set(pending).where(eq(assets.analysisStatus, "failed")).run().changes;
  }
  return db().update(assets).set(pending).where(and(inList(assets.id, ids), ne(assets.analysisStatus, "running"))).run().changes;
}

/** Nhận nguyên tử tối đa `limit` asset đang chờ, chuyển sang 'running'. */
export function claimPendingAssets(limit: number): { id: string; path: string; kind: AssetKind; title: string; description: string }[] {
  return db().transaction((tx) => {
    const rows = tx
      .select({ id: assets.id, file: assets.file, kind: assets.kind, title: assets.title, description: assets.description })
      .from(assets)
      .where(eq(assets.analysisStatus, "pending"))
      .orderBy(asc(assets.createdAt))
      .limit(limit)
      .all();
    for (const r of rows) tx.update(assets).set({ analysisStatus: "running", analysisError: null }).where(eq(assets.id, r.id)).run();
    return rows.map((r) => ({ id: r.id, path: mediaPath(r.file), kind: r.kind, title: r.title, description: r.description }));
  });
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
      .update(assets)
      .set({
        analysisStatus: "done",
        analysisError: null,
        ocrText: (result.ocr_text ?? "").slice(0, 4000),
        aiSummary: (result.summary ?? "").slice(0, 2000),
        aiTags: JSON.stringify(result.tags ?? []),
        analyzedAt: nowIso(),
      })
      .where(and(eq(assets.id, result.id), eq(assets.analysisStatus, "running")))
      .run();
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
  const row = db().select({ description: assets.description, source: assets.source }).from(assets).where(eq(assets.id, id)).get();
  if (!row || row.source === "upload") return;
  // Bản cũ ghi dòng "Từ khóa tìm kiếm: ..." (từ khóa tiếng Anh) thay cho hashtag: bỏ dòng đó, các từ của nó thành hashtag
  const legacy = row.description.match(/\n?Từ khóa tìm kiếm: ([^\n]*)/);
  const base = legacy ? row.description.replace(legacy[0], "") : row.description;
  const existing = parseHashtags(base);
  if (!legacy && existing.length >= SPARSE_DESCRIPTION_HASHTAGS) return;
  const description = withHashtags(base, ensureHashtags([existing], [aiTags, textHashtags(legacy?.[1])], ASSET_HASHTAG_MIN));
  if (description === row.description.trim()) return;
  db().transaction((tx) => {
    tx.update(assets).set({ description, updatedAt: nowIso() }).where(eq(assets.id, id)).run();
    setTags("asset", id, parseHashtags(description));
  });
}

export function failAnalysis(ids: string[], error: string): void {
  db()
    .update(assets)
    .set({ analysisStatus: "failed", analysisError: error.slice(0, 1000), analyzedAt: nowIso() })
    .where(and(inList(assets.id, ids), eq(assets.analysisStatus, "running")))
    .run();
}

/** Asset đang 'running' khi server tắt: đưa lại hàng đợi. */
export function requeueInterruptedAnalysis(): void {
  db().update(assets).set({ analysisStatus: "pending" }).where(eq(assets.analysisStatus, "running")).run();
}

/** Số asset còn chờ/đang phân tích trong phạm vi (ids, tag hoặc thư mục; không có gì = toàn thư viện). */
export function countUnanalyzed(scope: { ids?: string[]; tag?: string | null; folders?: string[] }): number {
  // Chỉ ảnh/video: audio không được AI chọn cho từng bước nên job không cần chờ
  const condition = where({
    ids: scope.ids,
    tag: scope.tag ?? undefined,
    folders: scope.folders,
    kind: "image,video",
    status: "pending,running",
  });
  return db().select({ n: count() }).from(assets).where(condition).get()!.n;
}
