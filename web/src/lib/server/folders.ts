import "server-only";
import crypto from "node:crypto";
import type { AssetFolder } from "@/lib/types";
import { db, nowIso } from "./db";
import { HttpError } from "./files";

type FolderRow = { id: string; name: string; created_at: string; asset_count: number };

const MAX_NAME = 80;

function cleanName(name: unknown): string {
  const value = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  if (!value) throw new HttpError(400, "Tên thư mục không được để trống");
  if (value.length > MAX_NAME) throw new HttpError(400, `Tên thư mục tối đa ${MAX_NAME} ký tự`);
  return value;
}

/** Thư mục theo tên (A→Z) kèm số asset, và số asset chưa thuộc thư mục nào. */
export function listFolders(): { items: AssetFolder[]; unfiled: number } {
  const rows = db()
    .prepare(
      `SELECT f.id, f.name, f.created_at,
         (SELECT COUNT(*) FROM assets a WHERE a.folder_id = f.id) AS asset_count
       FROM asset_folders f ORDER BY f.name COLLATE NOCASE`,
    )
    .all() as FolderRow[];
  const { unfiled } = db().prepare("SELECT COUNT(*) AS unfiled FROM assets WHERE folder_id IS NULL").get() as { unfiled: number };
  return {
    items: rows.map((r) => ({ id: r.id, name: r.name, assetCount: r.asset_count, createdAt: r.created_at })),
    unfiled,
  };
}

export function getFolder(id: string): AssetFolder | null {
  return listFolders().items.find((f) => f.id === id) ?? null;
}

export function folderExists(id: string): boolean {
  return !!db().prepare("SELECT 1 FROM asset_folders WHERE id = ?").get(id);
}

/** Kiểm tra id thư mục gửi lên: null/"" = không thuộc thư mục nào. */
export function checkFolderId(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !folderExists(value)) throw new HttpError(400, "Thư mục không tồn tại");
  return value;
}

export function createFolder(name: unknown): AssetFolder {
  const id = crypto.randomUUID();
  db().prepare("INSERT INTO asset_folders (id, name) VALUES (?, ?)").run(id, cleanName(name));
  return getFolder(id)!;
}

export function renameFolder(id: string, name: unknown): AssetFolder | null {
  const changes = db().prepare("UPDATE asset_folders SET name = ?, updated_at = ? WHERE id = ?").run(cleanName(name), nowIso(), id).changes;
  return changes ? getFolder(id) : null;
}

/** Xóa thư mục; asset bên trong không bị xóa mà chuyển về "Chưa phân loại" (ON DELETE SET NULL). */
export function deleteFolder(id: string): boolean {
  return db().prepare("DELETE FROM asset_folders WHERE id = ?").run(id).changes > 0;
}

/** Chuyển nhiều asset vào thư mục (folderId = null: bỏ khỏi thư mục). Trả về số asset đã chuyển. */
export function moveAssets(ids: string[], folderId: string | null): number {
  if (!ids.length) return 0;
  return db()
    .prepare("UPDATE assets SET folder_id = ?, updated_at = ? WHERE id IN (SELECT value FROM json_each(?))")
    .run(folderId, nowIso(), JSON.stringify(ids)).changes;
}
