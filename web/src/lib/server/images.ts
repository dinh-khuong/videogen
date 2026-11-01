import "server-only";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { parseHashtags } from "@/lib/hashtags";
import type { ImageItem, Page } from "@/lib/types";
import { db, nowIso } from "./db";
import { probe } from "./engine";
import { HttpError, moveFile, removeMedia } from "./files";
import { MEDIA_DIR, TMP_DIR, mediaPath, mediaUrl } from "./paths";
import { setTags, tagFilterSql, tagsFor } from "./tags";

type ImageRow = {
  id: string;
  file: string;
  thumbnail: string | null;
  title: string;
  description: string;
  source: string;
  source_url: string | null;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  created_at: string;
  used_in: number;
};

const SELECT = `SELECT i.*, (SELECT COUNT(*) FROM video_images vi WHERE vi.image_id = i.id) AS used_in FROM images i`;

function toItems(rows: ImageRow[]): ImageItem[] {
  const tags = tagsFor("image", rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    url: mediaUrl(r.file)!,
    thumbUrl: mediaUrl(r.thumbnail ?? r.file)!,
    title: r.title,
    description: r.description,
    tags: tags.get(r.id) ?? [],
    source: r.source,
    sourceUrl: r.source_url,
    width: r.width,
    height: r.height,
    sizeBytes: r.size_bytes,
    usedIn: r.used_in,
    createdAt: r.created_at,
  }));
}

export type ImageQuery = { q?: string; tag?: string; ids?: string[]; limit?: number; offset?: number };

function where(query: ImageQuery): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.q) {
    clauses.push("(i.title LIKE ? OR i.description LIKE ?)");
    params.push(`%${query.q}%`, `%${query.q}%`);
  }
  if (query.tag) {
    clauses.push(tagFilterSql("image", "i"));
    params.push(query.tag);
  }
  if (query.ids) {
    clauses.push("i.id IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(query.ids));
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

export function listImages(query: ImageQuery = {}): Page<ImageItem> {
  const { sql, params } = where(query);
  const limit = Math.min(Math.max(query.limit ?? 60, 1), 500);
  const rows = db()
    .prepare(`${SELECT}${sql} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, query.offset ?? 0) as ImageRow[];
  const { total } = db().prepare(`SELECT COUNT(*) AS total FROM images i${sql}`).get(...params) as { total: number };
  return { items: toItems(rows), total };
}

export function getImage(id: string): ImageItem | null {
  const row = db().prepare(`${SELECT} WHERE i.id = ?`).get(id) as ImageRow | undefined;
  return row ? toItems([row])[0] : null;
}

/** Đường dẫn tuyệt đối + mô tả của ảnh, dùng để đưa vào spec của engine. */
export function imagesForEngine(query: ImageQuery): { id: string; path: string; description: string; tags: string[] }[] {
  const { sql, params } = where(query);
  const rows = db()
    .prepare(`SELECT i.id, i.file, i.title, i.description FROM images i${sql} ORDER BY i.created_at DESC LIMIT ?`)
    .all(...params, query.limit ?? 150) as Pick<ImageRow, "id" | "file" | "title" | "description">[];
  const tags = tagsFor("image", rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    path: mediaPath(r.file),
    description: [r.title, r.description].filter(Boolean).join(" — "),
    tags: tags.get(r.id) ?? [],
  }));
}

export function findImageBySha1(sha1: string): string | null {
  const row = db().prepare("SELECT id FROM images WHERE sha1 = ?").get(sha1) as { id: string } | undefined;
  return row?.id ?? null;
}

export type NewImage = {
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
 * Thêm ảnh vào thư viện từ file tạm (file tạm sẽ được chuyển vào thư mục media).
 * Ảnh trùng nội dung (cùng sha1) không thêm lại mà trả về id ảnh có sẵn.
 */
export async function addImages(items: NewImage[]): Promise<{ id: string; existed: boolean }[]> {
  const prepared = items.map((item) => ({ item, existing: findImageBySha1(item.sha1), id: crypto.randomUUID() }));
  const fresh = prepared.filter((p) => !p.existing);

  // Đọc kích thước + tạo thumbnail trong một lần gọi engine
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
    const bad = infos.find((i) => i.error);
    if (bad) throw new HttpError(415, `Ảnh không hợp lệ hoặc định dạng không hỗ trợ (${bad.error})`);

    for (const [k, p] of fresh.entries()) {
      const info = infos[k];
      const file = `images/${p.id}${p.item.ext}`;
      const thumb = info.thumbnail ? `thumbs/${p.id}.jpg` : null;
      await moveFile(named[k], path.join(MEDIA_DIR, file));
      if (info.thumbnail && thumb) await moveFile(info.thumbnail, path.join(MEDIA_DIR, thumb));
      try {
        db().transaction(() => {
          db()
            .prepare(
              `INSERT INTO images (id, file, thumbnail, title, description, source, source_url, width, height, size_bytes, sha1)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(p.id, file, thumb, p.item.title, p.item.description, p.item.source, p.item.sourceUrl ?? null,
              info.width ?? null, info.height ?? null, p.item.size, p.item.sha1);
          setTags("image", p.id, parseHashtags(p.item.description));
        })();
      } catch (e) {
        await removeMedia(file, thumb);
        // Hai request cùng thêm một ảnh: bản kia đã thắng, dùng lại ảnh đó
        const winner = findImageBySha1(p.item.sha1);
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

export function updateImage(id: string, patch: { title?: string; description?: string }): ImageItem | null {
  const current = getImage(id);
  if (!current) return null;
  const title = patch.title ?? current.title;
  const description = patch.description ?? current.description;
  db().transaction(() => {
    db().prepare("UPDATE images SET title = ?, description = ?, updated_at = ? WHERE id = ?").run(title, description, nowIso(), id);
    setTags("image", id, parseHashtags(description));
  })();
  return getImage(id);
}

export async function deleteImage(id: string): Promise<boolean> {
  const row = db().prepare("SELECT file, thumbnail FROM images WHERE id = ?").get(id) as
    | { file: string; thumbnail: string | null }
    | undefined;
  if (!row) return false;
  db().prepare("DELETE FROM images WHERE id = ?").run(id);
  await removeMedia(row.file, row.thumbnail);
  return true;
}
