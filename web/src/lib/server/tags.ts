import "server-only";
import { normalizeTag, splitTags } from "@/lib/hashtags";
import type { TagCount } from "@/lib/types";
import { db } from "./db";

const LINKS = {
  asset: { table: "asset_tags", column: "asset_id" },
  video: { table: "video_tags", column: "video_id" },
  contact: { table: "contact_tags", column: "contact_id" },
} as const;
export type TagEntity = keyof typeof LINKS;

/** Thay toàn bộ tag của một bản ghi. Gọi bên trong transaction của bản ghi đó. */
export function setTags(entity: TagEntity, id: string, names: string[]): void {
  const { table, column } = LINKS[entity];
  const d = db();
  d.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(id);
  const insertTag = d.prepare("INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name = name RETURNING id");
  const link = d.prepare(`INSERT OR IGNORE INTO ${table} (${column}, tag_id) VALUES (?, ?)`);
  for (const name of new Set(names.map(normalizeTag).filter(Boolean))) {
    const { id: tagId } = insertTag.get(name) as { id: number };
    link.run(id, tagId);
  }
}

/** Map id -> danh sách tag cho nhiều bản ghi cùng lúc. */
export function tagsFor(entity: TagEntity, ids: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>(ids.map((id) => [id, []]));
  if (!ids.length) return result;
  const { table, column } = LINKS[entity];
  const rows = db()
    .prepare(
      `SELECT l.${column} AS id, t.name FROM ${table} l JOIN tags t ON t.id = l.tag_id
       WHERE l.${column} IN (SELECT value FROM json_each(?)) ORDER BY t.name`,
    )
    .all(JSON.stringify(ids)) as { id: string; name: string }[];
  for (const row of rows) result.get(row.id)?.push(row.name);
  return result;
}

/** Điều kiện SQL lọc bản ghi có ít nhất một trong các tag; tham số đi kèm là tagFilterParam(...). */
export function tagFilterSql(entity: TagEntity, alias: string): string {
  const { table, column } = LINKS[entity];
  return `EXISTS (SELECT 1 FROM ${table} l JOIN tags t ON t.id = l.tag_id WHERE l.${column} = ${alias}.id
    AND t.name IN (SELECT value FROM json_each(?)))`;
}

/** Tham số cho tagFilterSql từ chuỗi một hoặc nhiều tag cách nhau bằng dấu phẩy. */
export function tagFilterParam(tags: string): string {
  return JSON.stringify(splitTags(tags));
}

export function listTags(): TagCount[] {
  return db()
    .prepare(
      `SELECT t.name,
         (SELECT COUNT(*) FROM asset_tags WHERE tag_id = t.id) AS assets,
         (SELECT COUNT(*) FROM video_tags WHERE tag_id = t.id) AS videos,
         (SELECT COUNT(*) FROM contact_tags WHERE tag_id = t.id) AS contacts
       FROM tags t
       WHERE EXISTS (SELECT 1 FROM asset_tags WHERE tag_id = t.id)
          OR EXISTS (SELECT 1 FROM video_tags WHERE tag_id = t.id)
          OR EXISTS (SELECT 1 FROM contact_tags WHERE tag_id = t.id)
       ORDER BY (assets + videos + contacts) DESC, t.name`,
    )
    .all() as TagCount[];
}
