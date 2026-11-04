import "server-only";
import crypto from "node:crypto";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { FOLDER_COLORS, type AssetFolder, type FolderColor, type FolderList } from "@/lib/types";
import { deleteAsset, subtreeSql } from "./assets";
import { db, inList, nowIso } from "./db";
import { HttpError } from "./files";
import { assetFolders, assets } from "./schema";

/** Mọi thư mục kèm số asset nằm trực tiếp trong đó và tổng dung lượng. */
function readFolders() {
  return db()
    .select({
      id: assetFolders.id,
      name: assetFolders.name,
      parentId: assetFolders.parentId,
      color: assetFolders.color,
      starred: assetFolders.starred,
      createdAt: assetFolders.createdAt,
      updatedAt: assetFolders.updatedAt,
      assetCount: count(assets.id),
      assetBytes: sql<number>`COALESCE(SUM(${assets.sizeBytes}), 0)`,
    })
    .from(assetFolders)
    .leftJoin(assets, eq(assets.folderId, assetFolders.id))
    .groupBy(assetFolders.id)
    .orderBy(sql`${assetFolders.name} COLLATE NOCASE`)
    .all();
}
type FolderRow = ReturnType<typeof readFolders>[number];

const MAX_NAME = 80;
const MAX_DEPTH = 20;

function cleanName(name: unknown): string {
  const value = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  if (!value) throw new HttpError(400, "Tên thư mục không được để trống");
  if (value.length > MAX_NAME) throw new HttpError(400, `Tên thư mục tối đa ${MAX_NAME} ký tự`);
  return value;
}

function cleanColor(color: unknown): FolderColor | null {
  if (color === null || color === undefined || color === "") return null;
  if (typeof color !== "string" || !Object.hasOwn(FOLDER_COLORS, color)) throw new HttpError(400, "Màu thư mục không hợp lệ");
  return color as FolderColor;
}

/** Mọi thư mục kèm số asset (trực tiếp và tính cả thư mục con), dung lượng, và số asset ở gốc. */
export function listFolders(): FolderList {
  const rows = readFolders();
  const lib = db()
    .select({
      total: count(),
      bytes: sql<number>`COALESCE(SUM(${assets.sizeBytes}), 0)`,
      unfiled: sql<number>`COALESCE(SUM(CASE WHEN ${assets.folderId} IS NULL THEN 1 ELSE 0 END), 0)`,
    })
    .from(assets)
    .get()!;

  // Cộng dồn số asset/dung lượng từ thư mục con lên thư mục cha
  const children = new Map<string | null, FolderRow[]>();
  for (const r of rows) children.set(r.parentId, [...(children.get(r.parentId) ?? []), r]);
  const totals = new Map<string, { assets: number; bytes: number }>();
  const visit = (r: FolderRow, depth: number): { assets: number; bytes: number } => {
    const sum = { assets: r.assetCount, bytes: r.assetBytes };
    if (depth < MAX_DEPTH * 2) {
      for (const c of children.get(r.id) ?? []) {
        const t = visit(c, depth + 1);
        sum.assets += t.assets;
        sum.bytes += t.bytes;
      }
    }
    totals.set(r.id, sum);
    return sum;
  };
  rows.forEach((r) => totals.has(r.id) || visit(r, 0));

  return {
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      parentId: r.parentId,
      color: r.color && Object.hasOwn(FOLDER_COLORS, r.color) ? (r.color as FolderColor) : null,
      starred: !!r.starred,
      assetCount: r.assetCount,
      totalAssets: totals.get(r.id)!.assets,
      totalBytes: totals.get(r.id)!.bytes,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    unfiled: lib.unfiled,
    totalAssets: lib.total,
    totalBytes: lib.bytes,
  };
}

export function getFolder(id: string): AssetFolder | null {
  return listFolders().items.find((f) => f.id === id) ?? null;
}

export function folderExists(id: string): boolean {
  return !!db().select({ one: sql`1` }).from(assetFolders).where(eq(assetFolders.id, id)).get();
}

/** Kiểm tra id thư mục gửi lên: null/"" = gốc thư viện (không thuộc thư mục nào). */
export function checkFolderId(value: unknown): string | null {
  if (value === null || value === undefined || value === "" || value === "none") return null;
  if (typeof value !== "string" || !folderExists(value)) throw new HttpError(400, "Thư mục không tồn tại");
  return value;
}

/** Id các thư mục và mọi thư mục con cháu của chúng. */
export function folderSubtree(ids: string[]): string[] {
  if (!ids.length) return [];
  return db().all<{ id: string }>(subtreeSql(ids)).map((r) => r.id);
}

/** Độ sâu của thư mục (thư mục ở gốc = 1). */
function depthOf(id: string | null): number {
  let depth = 0;
  for (let cur = id; cur && depth <= MAX_DEPTH + 1; depth++) {
    cur = db().select({ parentId: assetFolders.parentId }).from(assetFolders).where(eq(assetFolders.id, cur)).get()?.parentId ?? null;
  }
  return depth;
}

/** Độ sâu của cây thư mục con dưới thư mục (chỉ thư mục đó = 1). */
function subtreeHeight(id: string): number {
  const row = db().get<{ h: number }>(sql`
    WITH RECURSIVE sub(id, d) AS (
      SELECT ${id}, 1 UNION ALL SELECT f.id, sub.d + 1 FROM asset_folders f JOIN sub ON f.parent_id = sub.id WHERE sub.d < 100
    ) SELECT MAX(d) AS h FROM sub`);
  return row!.h;
}

export function createFolder(input: { name?: unknown; parentId?: unknown; color?: unknown; reuse?: unknown }): AssetFolder {
  const name = cleanName(input.name);
  const parentId = checkFolderId(input.parentId);
  if (depthOf(parentId) >= MAX_DEPTH) throw new HttpError(400, `Thư mục lồng tối đa ${MAX_DEPTH} cấp`);
  if (input.reuse === true) {
    // Tải cả thư mục từ máy lên: thư mục cùng tên đã có thì dùng lại, không tạo bản trùng
    const existing = db()
      .select({ id: assetFolders.id })
      .from(assetFolders)
      .where(and(sql`${assetFolders.name} = ${name} COLLATE NOCASE`, parentId === null ? isNull(assetFolders.parentId) : eq(assetFolders.parentId, parentId)))
      .get();
    if (existing) return getFolder(existing.id)!;
  }
  const id = crypto.randomUUID();
  db().insert(assetFolders).values({ id, name, parentId, color: cleanColor(input.color) }).run();
  return getFolder(id)!;
}

/** Sửa thư mục: đổi tên, màu, gắn sao hoặc chuyển sang thư mục cha khác. */
export function updateFolder(
  id: string,
  patch: { name?: unknown; color?: unknown; starred?: unknown; parentId?: unknown },
): AssetFolder | null {
  if (!folderExists(id)) return null;
  const set: Partial<typeof assetFolders.$inferInsert> = {};
  if (patch.name !== undefined) set.name = cleanName(patch.name);
  if (patch.color !== undefined) set.color = cleanColor(patch.color);
  if (patch.starred !== undefined) set.starred = patch.starred ? 1 : 0;
  if (patch.parentId !== undefined) {
    const parentId = checkFolderId(patch.parentId);
    checkFolderMove(id, parentId);
    set.parentId = parentId;
  }
  if (Object.keys(set).length) db().update(assetFolders).set({ ...set, updatedAt: nowIso() }).where(eq(assetFolders.id, id)).run();
  return getFolder(id);
}

/** Không cho chuyển thư mục vào chính nó hay thư mục con của nó, và không vượt quá số cấp tối đa. */
function checkFolderMove(id: string, parentId: string | null): void {
  if (parentId && folderSubtree([id]).includes(parentId)) {
    throw new HttpError(400, "Không thể chuyển thư mục vào chính nó hoặc thư mục con của nó");
  }
  if (depthOf(parentId) + subtreeHeight(id) > MAX_DEPTH) throw new HttpError(400, `Thư mục lồng tối đa ${MAX_DEPTH} cấp`);
}

/**
 * Xóa thư mục. Mặc định asset và thư mục con bên trong được giữ lại và chuyển lên thư mục cha;
 * withContents = true thì xóa vĩnh viễn cả thư mục con và asset bên trong.
 */
export async function deleteFolder(id: string, withContents = false): Promise<boolean> {
  const row = db().select({ parentId: assetFolders.parentId }).from(assetFolders).where(eq(assetFolders.id, id)).get();
  if (!row) return false;
  if (withContents) {
    const inside = db().select({ id: assets.id }).from(assets).where(inList(assets.folderId, folderSubtree([id]))).all();
    for (const a of inside) await deleteAsset(a.id);
    // ON DELETE CASCADE xóa luôn thư mục con
    db().delete(assetFolders).where(eq(assetFolders.id, id)).run();
    return true;
  }
  db().transaction((tx) => {
    const now = nowIso();
    tx.update(assets).set({ folderId: row.parentId, updatedAt: now }).where(eq(assets.folderId, id)).run();
    tx.update(assetFolders).set({ parentId: row.parentId, updatedAt: now }).where(eq(assetFolders.parentId, id)).run();
    tx.delete(assetFolders).where(eq(assetFolders.id, id)).run();
  });
  return true;
}

/** Chuyển nhiều asset vào thư mục (folderId = null: ra gốc thư viện). Trả về số asset đã chuyển. */
export function moveAssets(ids: string[], folderId: string | null): number {
  if (!ids.length) return 0;
  return db().update(assets).set({ folderId, updatedAt: nowIso() }).where(inList(assets.id, ids)).run().changes;
}

/** Chuyển nhiều thư mục vào thư mục khác (null = ra gốc). Kiểm tra hết trước khi chuyển. */
export function moveFolders(ids: string[], parentId: string | null): number {
  let unique = [...new Set(ids)].filter(folderExists);
  // Thư mục con được chọn cùng thư mục cha thì đi theo cha, không tách ra
  const inside = new Set(unique.flatMap((id) => folderSubtree([id]).filter((x) => x !== id)));
  unique = unique.filter((id) => !inside.has(id));
  if (!unique.length) return 0;
  for (const id of unique) checkFolderMove(id, parentId);
  db().transaction((tx) => {
    const now = nowIso();
    for (const id of unique) tx.update(assetFolders).set({ parentId, updatedAt: now }).where(eq(assetFolders.id, id)).run();
  });
  return unique.length;
}
