import "server-only";
import crypto from "node:crypto";
import path from "node:path";
import { and, asc, count, desc, eq, like, or, type SQL } from "drizzle-orm";
import { parseHashtags } from "@/lib/hashtags";
import type { Page, Script, VideoDetail, VideoItem } from "@/lib/types";
import { getAsset } from "./assets";
import { db, nowIso } from "./db";
import { moveFile, removeMedia } from "./files";
import { MEDIA_DIR, mediaUrl } from "./paths";
import { contactVideos, contacts, videoAssets, videos } from "./schema";
import { hasAnyTag, setTags, tagsFor } from "./tags";

type VideoRow = typeof videos.$inferSelect;

export function toVideoItems(rows: VideoRow[]): VideoItem[] {
  const tags = tagsFor("video", rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    url: mediaUrl(r.file)!,
    thumbUrl: mediaUrl(r.thumbnail),
    title: r.title,
    description: r.description,
    tags: tags.get(r.id) ?? [],
    kind: r.kind,
    duration: r.duration,
    width: r.width,
    height: r.height,
    sizeBytes: r.sizeBytes,
    jobId: r.jobId,
    createdAt: r.createdAt,
  }));
}

export type VideoQuery = { q?: string; tag?: string; limit?: number; offset?: number };

export function listVideos(query: VideoQuery = {}): Page<VideoItem> {
  const conditions: (SQL | undefined)[] = [];
  if (query.q) conditions.push(or(like(videos.title, `%${query.q}%`), like(videos.description, `%${query.q}%`)));
  if (query.tag) conditions.push(hasAnyTag("video", videos.id, query.tag));
  const where = and(...conditions);
  const limit = Math.min(Math.max(query.limit ?? 48, 1), 500);
  const rows = db().select().from(videos).where(where).orderBy(desc(videos.createdAt)).limit(limit).offset(query.offset ?? 0).all();
  const { total } = db().select({ total: count() }).from(videos).where(where).get()!;
  return { items: toVideoItems(rows), total };
}

function getRow(id: string): VideoRow | undefined {
  return db().select().from(videos).where(eq(videos.id, id)).get();
}

export function getVideo(id: string): VideoItem | null {
  const row = getRow(id);
  return row ? toVideoItems([row])[0] : null;
}

export function getVideoDetail(id: string): VideoDetail | null {
  const row = getRow(id);
  if (!row) return null;
  const assets = db()
    .select({ assetId: videoAssets.assetId, step: videoAssets.step, position: videoAssets.position })
    .from(videoAssets)
    .where(eq(videoAssets.videoId, id))
    .orderBy(asc(videoAssets.step), asc(videoAssets.position))
    .all()
    .map((r) => {
      const asset = getAsset(r.assetId);
      return asset ? { ...asset, step: r.step, position: r.position } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  const linked = db()
    .select({ id: contacts.id, name: contacts.name, company: contacts.company })
    .from(contactVideos)
    .innerJoin(contacts, eq(contacts.id, contactVideos.contactId))
    .where(eq(contactVideos.videoId, id))
    .orderBy(asc(contacts.name))
    .all();
  let script: Script | null = null;
  try {
    script = row.script ? (JSON.parse(row.script) as Script) : null;
  } catch {
    script = null;
  }
  return { ...toVideoItems([row])[0], script, assets, contacts: linked };
}

export type NewVideo = {
  id?: string;
  srcPath: string;
  thumbPath?: string | null;
  ext: string;
  size: number;
  title: string;
  description: string;
  kind: "generated";
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  script?: Script | null;
  jobId?: string | null;
};

/** Chuyển file vào thư mục media và ghi bản ghi. Trả về id. Gọi được bên trong transaction (phần DB là đồng bộ). */
export async function moveVideoFiles(video: NewVideo): Promise<{ id: string; file: string; thumb: string | null }> {
  const id = video.id ?? crypto.randomUUID();
  const file = `videos/${id}${video.ext}`;
  const thumb = video.thumbPath ? `thumbs/${id}.jpg` : null;
  await moveFile(video.srcPath, path.join(MEDIA_DIR, file));
  if (video.thumbPath && thumb) await moveFile(video.thumbPath, path.join(MEDIA_DIR, thumb));
  return { id, file, thumb };
}

export function insertVideo(video: NewVideo, files: { id: string; file: string; thumb: string | null }): void {
  db()
    .insert(videos)
    .values({
      id: files.id,
      file: files.file,
      thumbnail: files.thumb,
      title: video.title,
      description: video.description,
      kind: video.kind,
      duration: video.duration ?? null,
      width: video.width ?? null,
      height: video.height ?? null,
      sizeBytes: video.size,
      script: video.script ? JSON.stringify(video.script) : null,
      jobId: video.jobId ?? null,
    })
    .run();
  setTags("video", files.id, parseHashtags(video.description));
}

export function updateVideo(id: string, patch: { title?: string; description?: string }): VideoItem | null {
  const current = getVideo(id);
  if (!current) return null;
  const title = patch.title ?? current.title;
  const description = patch.description ?? current.description;
  db().transaction((tx) => {
    tx.update(videos).set({ title, description, updatedAt: nowIso() }).where(eq(videos.id, id)).run();
    setTags("video", id, parseHashtags(description));
  });
  return getVideo(id);
}

export async function deleteVideo(id: string): Promise<boolean> {
  const row = getRow(id);
  if (!row) return false;
  db().delete(videos).where(eq(videos.id, id)).run();
  await removeMedia(row.file, row.thumbnail);
  return true;
}
