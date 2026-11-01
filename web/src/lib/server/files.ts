import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { MEDIA_DIR, TMP_DIR, ensureDirs } from "./paths";

export const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"];
export const VIDEO_EXTS = [".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"];
export const AUDIO_EXTS = [".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".flac", ".opus"];

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".flac": "audio/flac",
  ".opus": "audio/ogg",
};

export function extOf(name: string): string {
  return path.extname(name).toLowerCase();
}

/** Ghi body của request vào file tạm, trả về đường dẫn, kích thước và sha1. Không giữ cả file trong RAM. */
export async function saveUpload(
  body: ReadableStream<Uint8Array> | null,
  ext: string,
  maxBytes: number,
): Promise<{ path: string; size: number; sha1: string }> {
  if (!body) throw new HttpError(400, "Không có dữ liệu file");
  ensureDirs();
  const tmp = path.join(TMP_DIR, `${crypto.randomUUID()}${ext}`);
  const hash = crypto.createHash("sha1");
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) return cb(new HttpError(413, `File quá lớn (tối đa ${Math.round(maxBytes / 1e6)} MB)`));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(body as WebReadableStream<Uint8Array>), meter, fs.createWriteStream(tmp));
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  if (size === 0) {
    await fsp.rm(tmp, { force: true });
    throw new HttpError(400, "File rỗng");
  }
  return { path: tmp, size, sha1: hash.digest("hex") };
}

export async function sha1File(file: string): Promise<string> {
  const hash = crypto.createHash("sha1");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

/** Chuyển file (rename, hoặc copy + xóa nếu khác ổ đĩa). */
export async function moveFile(src: string, dest: string): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.rename(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await fsp.copyFile(src, dest);
    await fsp.rm(src, { force: true });
  }
}

export async function removeMedia(...rels: (string | null | undefined)[]): Promise<void> {
  await Promise.all(
    rels.filter((r): r is string => !!r).map((rel) => fsp.rm(path.join(MEDIA_DIR, rel), { force: true })),
  );
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Trả file kèm hỗ trợ Range (cần cho tua video trong trình duyệt). */
export async function serveFile(file: string, request: Request): Promise<Response> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error();
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const headers: Record<string, string> = {
    "Content-Type": MIME[extOf(file)] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "Last-Modified": stat.mtime.toUTCString(),
  };
  const url = new URL(request.url);
  if (url.searchParams.has("download")) {
    const name = url.searchParams.get("download") || path.basename(file);
    headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  }

  const range = request.headers.get("range");
  const match = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (match && (match[1] || match[2])) {
    let start = match[1] ? Number(match[1]) : stat.size - Number(match[2]);
    let end = match[1] && match[2] ? Number(match[2]) : stat.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, stat.size - 1);
    if (start > end || start >= stat.size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
    }
    const stream = fs.createReadStream(file, { start, end });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": String(end - start + 1) },
    });
  }
  const stream = fs.createReadStream(file);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: { ...headers, "Content-Length": String(stat.size) },
  });
}
