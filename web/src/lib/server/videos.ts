import "server-only";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { parseHashtags } from "@/lib/hashtags";
import type { Page, Script, VideoDetail, VideoItem } from "@/lib/types";
import { db, nowIso } from "./db";
import { probe } from "./engine";
import { HttpError, moveFile, removeMedia } from "./files";
import { getImage } from "./images";
import { MEDIA_DIR, TMP_DIR, mediaPath, mediaUrl } from "./paths";
import { setTags, tagFilterSql, tagsFor } from "./tags";

type VideoRow = {
  id: string;
  file: string;
  thumbnail: string | null;
  title: string;
  description: string;
  kind: "generated" | "upload";
  duration: number | null;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  script: string | null;
  job_id: string | null;
  created_at: string;
};

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
    sizeBytes: r.size_bytes,
    jobId: r.job_id,
    createdAt: r.created_at,
  }));
}

export type VideoQuery = { q?: string; tag?: string; kind?: string; limit?: number; offset?: number };

export function listVideos(query: VideoQuery = {}): Page<VideoItem> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.q) {
    clauses.push("(v.title LIKE ? OR v.description LIKE ?)");
    params.push(`%${query.q}%`, `%${query.q}%`);
  }
  if (query.tag) {
    clauses.push(tagFilterSql("video", "v"));
    params.push(query.tag);
  }
  if (query.kind === "generated" || query.kind === "upload") {
    clauses.push("v.kind = ?");
    params.push(query.kind);
  }
  const sql = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(query.limit ?? 48, 1), 500);
  const rows = db()
    .prepare(`SELECT v.* FROM videos v${sql} ORDER BY v.created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, query.offset ?? 0) as VideoRow[];
  const { total } = db().prepare(`SELECT COUNT(*) AS total FROM videos v${sql}`).get(...params) as { total: number };
  return { items: toVideoItems(rows), total };
}

function getRow(id: string): VideoRow | undefined {
  return db().prepare("SELECT * FROM videos WHERE id = ?").get(id) as VideoRow | undefined;
}

export function getVideo(id: string): VideoItem | null {
  const row = getRow(id);
  return row ? toVideoItems([row])[0] : null;
}

export function videoFilePath(id: string): string | null {
  const row = getRow(id);
  return row ? mediaPath(row.file) : null;
}

export function getVideoDetail(id: string): VideoDetail | null {
  const row = getRow(id);
  if (!row) return null;
  const images = (
    db().prepare("SELECT image_id, step FROM video_images WHERE video_id = ? ORDER BY step").all(id) as {
      image_id: string;
      step: number;
    }[]
  )
    .map((r) => {
      const img = getImage(r.image_id);
      return img ? { ...img, step: r.step } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  const contacts = db()
    .prepare(
      `SELECT c.id, c.name, c.company FROM contact_videos cv JOIN contacts c ON c.id = cv.contact_id
       WHERE cv.video_id = ? ORDER BY c.name`,
    )
    .all(id) as VideoDetail["contacts"];
  let script: Script | null = null;
  try {
    script = row.script ? (JSON.parse(row.script) as Script) : null;
  } catch {
    script = null;
  }
  return { ...toVideoItems([row])[0], script, images, contacts };
}

export type NewVideo = {
  id?: string;
  srcPath: string;
  thumbPath?: string | null;
  ext: string;
  size: number;
  title: string;
  description: string;
  kind: "generated" | "upload";
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
    .prepare(
      `INSERT INTO videos (id, file, thumbnail, title, description, kind, duration, width, height, size_bytes, script, job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(files.id, files.file, files.thumb, video.title, video.description, video.kind, video.duration ?? null,
      video.width ?? null, video.height ?? null, video.size, video.script ? JSON.stringify(video.script) : null,
      video.jobId ?? null);
  setTags("video", files.id, parseHashtags(video.description));
}

/** Video người dùng tải lên (vd gameplay làm nền). */
export async function addUploadedVideo(tmpPath: string, ext: string, size: number, title: string, description: string) {
  const id = crypto.randomUUID();
  const probeDir = path.join(TMP_DIR, id);
  await fsp.mkdir(probeDir, { recursive: true });
  try {
    const named = path.join(probeDir, `${id}${ext}`);
    await moveFile(tmpPath, named);
    const [info] = await probe([named], probeDir);
    if (!info || info.error || info.kind !== "video") {
      throw new HttpError(415, `Không đọc được video (${info?.error ?? "định dạng không hỗ trợ"})`);
    }
    const video: NewVideo = {
      id,
      srcPath: named,
      thumbPath: info.thumbnail ?? null,
      ext,
      size,
      title,
      description,
      kind: "upload",
      duration: info.duration,
      width: info.width,
      height: info.height,
    };
    const files = await moveVideoFiles(video);
    try {
      db().transaction(() => insertVideo(video, files))();
    } catch (e) {
      await removeMedia(files.file, files.thumb);
      throw e;
    }
    return getVideo(id)!;
  } finally {
    await fsp.rm(probeDir, { recursive: true, force: true });
    await fsp.rm(tmpPath, { force: true });
  }
}

export function updateVideo(id: string, patch: { title?: string; description?: string }): VideoItem | null {
  const current = getVideo(id);
  if (!current) return null;
  const title = patch.title ?? current.title;
  const description = patch.description ?? current.description;
  db().transaction(() => {
    db().prepare("UPDATE videos SET title = ?, description = ?, updated_at = ? WHERE id = ?").run(title, description, nowIso(), id);
    setTags("video", id, parseHashtags(description));
  })();
  return getVideo(id);
}

export async function deleteVideo(id: string): Promise<boolean> {
  const row = getRow(id);
  if (!row) return false;
  db().prepare("DELETE FROM videos WHERE id = ?").run(id);
  await removeMedia(row.file, row.thumbnail);
  return true;
}
