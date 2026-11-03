import "server-only";
import crypto from "node:crypto";
import { FOLDER_COLORS, type AssetFolder, type FolderColor, type FolderList } from "@/lib/types";
import { SUBTREE_SQL, deleteAsset } from "./assets";
import { db, nowIso } from "./db";
import { HttpError } from "./files";

type FolderRow = {
  id: string;
  name: string;
  parent_id: string | null;
  color: string | null;
  starred: number;
  created_at: string;
  updated_at: string;
  asset_count: number;
  asset_bytes: number;
};

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
  const rows = db()
    .prepare(
      `SELECT f.id, f.name, f.parent_id, f.color, f.starred, f.created_at, f.updated_at,
         COUNT(a.id) AS asset_count, COALESCE(SUM(a.size_bytes), 0) AS asset_bytes
       FROM asset_folders f LEFT JOIN assets a ON a.folder_id = f.id
       GROUP BY f.id ORDER BY f.name COLLATE NOCASE`,
    )
    .all() as FolderRow[];
  const lib = db()
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(size_bytes), 0) AS bytes,
         COALESCE(SUM(CASE WHEN folder_id IS NULL THEN 1 ELSE 0 END), 0) AS unfiled
       FROM assets`,
    )
    .get() as { total: number; bytes: number; unfiled: number };

  // Cộng dồn số asset/dung lượng từ thư mục con lên thư mục cha
  const children = new Map<string | null, FolderRow[]>();
  for (const r of rows) children.set(r.parent_id, [...(children.get(r.parent_id) ?? []), r]);
  const totals = new Map<string, { assets: number; bytes: number }>();
  const visit = (r: FolderRow, depth: number): { assets: number; bytes: number } => {
    const sum = { assets: r.asset_count, bytes: r.asset_bytes };
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
      parentId: r.parent_id,
      color: r.color && Object.hasOwn(FOLDER_COLORS, r.color) ? (r.color as FolderColor) : null,
      starred: !!r.starred,
      assetCount: r.asset_count,
      totalAssets: totals.get(r.id)!.assets,
      totalBytes: totals.get(r.id)!.bytes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
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
  return !!db().prepare("SELECT 1 FROM asset_folders WHERE id = ?").get(id);
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
  return (db().prepare(SUBTREE_SQL).all(JSON.stringify(ids)) as { id: string }[]).map((r) => r.id);
}

/** Độ sâu của thư mục (thư mục ở gốc = 1). */
function depthOf(id: string | null): number {
  let depth = 0;
  const parent = db().prepare("SELECT parent_id FROM asset_folders WHERE id = ?");
  for (let cur = id; cur && depth <= MAX_DEPTH + 1; depth++) {
    cur = (parent.get(cur) as { parent_id: string | null } | undefined)?.parent_id ?? null;
  }
  return depth;
}

/** Độ sâu của cây thư mục con dưới thư mục (chỉ thư mục đó = 1). */
function subtreeHeight(id: string): number {
  const row = db()
    .prepare(
      `WITH RECURSIVE sub(id, d) AS (
         SELECT ?, 1 UNION ALL SELECT f.id, sub.d + 1 FROM asset_folders f JOIN sub ON f.parent_id = sub.id WHERE sub.d < 100
       ) SELECT MAX(d) AS h FROM sub`,
    )
    .get(id) as { h: number };
  return row.h;
}

export function createFolder(input: { name?: unknown; parentId?: unknown; color?: unknown; reuse?: unknown }): AssetFolder {
  const name = cleanName(input.name);
  const parentId = checkFolderId(input.parentId);
  if (depthOf(parentId) >= MAX_DEPTH) throw new HttpError(400, `Thư mục lồng tối đa ${MAX_DEPTH} cấp`);
  if (input.reuse === true) {
    // Tải cả thư mục từ máy lên: thư mục cùng tên đã có thì dùng lại, không tạo bản trùng
    const existing = db()
      .prepare("SELECT id FROM asset_folders WHERE name = ? COLLATE NOCASE AND parent_id IS ?")
      .get(name, parentId) as { id: string } | undefined;
    if (existing) return getFolder(existing.id)!;
  }
  const id = crypto.randomUUID();
  db().prepare("INSERT INTO asset_folders (id, name, parent_id, color) VALUES (?, ?, ?, ?)").run(id, name, parentId, cleanColor(input.color));
  return getFolder(id)!;
}

/** Sửa thư mục: đổi tên, màu, gắn sao hoặc chuyển sang thư mục cha khác. */
export function updateFolder(
  id: string,
  patch: { name?: unknown; color?: unknown; starred?: unknown; parentId?: unknown },
): AssetFolder | null {
  if (!folderExists(id)) return null;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    params.push(cleanName(patch.name));
  }
  if (patch.color !== undefined) {
    sets.push("color = ?");
    params.push(cleanColor(patch.color));
  }
  if (patch.starred !== undefined) {
    sets.push("starred = ?");
    params.push(patch.starred ? 1 : 0);
  }
  if (patch.parentId !== undefined) {
    const parentId = checkFolderId(patch.parentId);
    checkFolderMove(id, parentId);
    sets.push("parent_id = ?");
    params.push(parentId);
  }
  if (sets.length) {
    db()
      .prepare(`UPDATE asset_folders SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...params, nowIso(), id);
  }
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
  const row = db().prepare("SELECT parent_id FROM asset_folders WHERE id = ?").get(id) as { parent_id: string | null } | undefined;
  if (!row) return false;
  if (withContents) {
    const subtree = folderSubtree([id]);
    const assets = db()
      .prepare("SELECT id FROM assets WHERE folder_id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(subtree)) as { id: string }[];
    for (const a of assets) await deleteAsset(a.id);
    // ON DELETE CASCADE xóa luôn thư mục con
    db().prepare("DELETE FROM asset_folders WHERE id = ?").run(id);
    return true;
  }
  db().transaction(() => {
    const now = nowIso();
    db().prepare("UPDATE assets SET folder_id = ?, updated_at = ? WHERE folder_id = ?").run(row.parent_id, now, id);
    db().prepare("UPDATE asset_folders SET parent_id = ?, updated_at = ? WHERE parent_id = ?").run(row.parent_id, now, id);
    db().prepare("DELETE FROM asset_folders WHERE id = ?").run(id);
  })();
  return true;
}

/** Chuyển nhiều asset vào thư mục (folderId = null: ra gốc thư viện). Trả về số asset đã chuyển. */
export function moveAssets(ids: string[], folderId: string | null): number {
  if (!ids.length) return 0;
  return db()
    .prepare("UPDATE assets SET folder_id = ?, updated_at = ? WHERE id IN (SELECT value FROM json_each(?))")
    .run(folderId, nowIso(), JSON.stringify(ids)).changes;
}

/** Chuyển nhiều thư mục vào thư mục khác (null = ra gốc). Kiểm tra hết trước khi chuyển. */
export function moveFolders(ids: string[], parentId: string | null): number {
  let unique = [...new Set(ids)].filter(folderExists);
  // Thư mục con được chọn cùng thư mục cha thì đi theo cha, không tách ra
  const inside = new Set(unique.flatMap((id) => folderSubtree([id]).filter((x) => x !== id)));
  unique = unique.filter((id) => !inside.has(id));
  if (!unique.length) return 0;
  for (const id of unique) checkFolderMove(id, parentId);
  const update = db().prepare("UPDATE asset_folders SET parent_id = ?, updated_at = ? WHERE id = ?");
  db().transaction(() => {
    const now = nowIso();
    for (const id of unique) update.run(parentId, now, id);
  })();
  return unique.length;
}
