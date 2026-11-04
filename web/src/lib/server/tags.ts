import "server-only";
import { and, eq, exists, or, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { normalizeTag, splitTags } from "@/lib/hashtags";
import type { TagCount } from "@/lib/types";
import { db, inList } from "./db";
import { assetTags, contactTags, tags, videoTags } from "./schema";

/** Bảng nối giữa từng loại bản ghi và tag. */
const LINKS = {
  asset: {
    table: assetTags,
    owner: assetTags.assetId,
    tag: assetTags.tagId,
    link: (id: string, tagId: number) => db().insert(assetTags).values({ assetId: id, tagId }).onConflictDoNothing().run(),
  },
  video: {
    table: videoTags,
    owner: videoTags.videoId,
    tag: videoTags.tagId,
    link: (id: string, tagId: number) => db().insert(videoTags).values({ videoId: id, tagId }).onConflictDoNothing().run(),
  },
  contact: {
    table: contactTags,
    owner: contactTags.contactId,
    tag: contactTags.tagId,
    link: (id: string, tagId: number) => db().insert(contactTags).values({ contactId: id, tagId }).onConflictDoNothing().run(),
  },
} as const;
export type TagEntity = keyof typeof LINKS;

/** Thay toàn bộ tag của một bản ghi. Gọi bên trong transaction của bản ghi đó. */
export function setTags(entity: TagEntity, id: string, names: string[]): void {
  const { table, owner, link } = LINKS[entity];
  const d = db();
  d.delete(table).where(eq(owner, id)).run();
  for (const name of new Set(names.map(normalizeTag).filter(Boolean))) {
    // DO UPDATE (không đổi gì) để RETURNING trả về id cả khi tag đã có
    const row = d.insert(tags).values({ name }).onConflictDoUpdate({ target: tags.name, set: { name } }).returning({ id: tags.id }).get();
    link(id, row.id);
  }
}

/** Map id -> danh sách tag cho nhiều bản ghi cùng lúc. */
export function tagsFor(entity: TagEntity, ids: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>(ids.map((id) => [id, []]));
  if (!ids.length) return result;
  const { table, owner, tag } = LINKS[entity];
  const rows = db()
    .select({ id: owner, name: tags.name })
    .from(table)
    .innerJoin(tags, eq(tags.id, tag))
    .where(inList(owner, ids))
    .orderBy(tags.name)
    .all();
  for (const row of rows) result.get(row.id)?.push(row.name);
  return result;
}

/**
 * Điều kiện lọc bản ghi có ít nhất một trong các tag. `id` là cột id của bảng đang truy vấn;
 * `tagNames` là một hoặc nhiều tag cách nhau bằng dấu phẩy.
 */
export function hasAnyTag(entity: TagEntity, id: AnySQLiteColumn, tagNames: string): SQL {
  const { table, owner, tag } = LINKS[entity];
  return exists(
    db()
      .select({ one: sql`1` })
      .from(table)
      .innerJoin(tags, eq(tags.id, tag))
      .where(and(eq(owner, id), inList(tags.name, splitTags(tagNames)))),
  );
}

export function listTags(): TagCount[] {
  const used = (link: typeof assetTags | typeof videoTags | typeof contactTags) =>
    exists(db().select({ one: sql`1` }).from(link).where(eq(link.tagId, tags.id)));
  // Tiểu truy vấn tương quan viết bằng SQL thô: trong truy vấn một bảng Drizzle bỏ tên bảng khỏi cột của trường select
  const countOf = (link: string) => sql<number>`(SELECT COUNT(*) FROM ${sql.raw(link)} WHERE tag_id = tags.id)`;
  return db()
    .select({
      name: tags.name,
      assets: countOf("asset_tags").as("assets"),
      videos: countOf("video_tags").as("videos"),
      contacts: countOf("contact_tags").as("contacts"),
    })
    .from(tags)
    .where(or(used(assetTags), used(videoTags), used(contactTags)))
    .orderBy(sql`(assets + videos + contacts) DESC`, tags.name)
    .all();
}
