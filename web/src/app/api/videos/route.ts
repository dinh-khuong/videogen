import { HttpError, VIDEO_EXTS, extOf, saveUpload } from "@/lib/server/files";
import { route, intParam, json, searchParams } from "@/lib/server/http";
import { addUploadedVideo, listVideos } from "@/lib/server/videos";

const MAX_VIDEO_BYTES = 4e9;

export const GET = route(async (request: Request) => {
  const p = searchParams(request);
  return json(
    listVideos({
      q: p.get("q") || undefined,
      tag: p.get("tag") || undefined,
      kind: p.get("kind") || undefined,
      limit: intParam(p.get("limit")),
      offset: intParam(p.get("offset")),
    }),
  );
});

/** Tải video lên (vd gameplay làm nền): body là nội dung file, tên file + mô tả trong query string. */
export const POST = route(async (request: Request) => {
  const p = searchParams(request);
  const filename = p.get("filename") || "video.mp4";
  const ext = extOf(filename);
  if (!VIDEO_EXTS.includes(ext)) {
    throw new HttpError(415, `Chỉ hỗ trợ video ${VIDEO_EXTS.join(", ")} (file ${filename})`);
  }
  const upload = await saveUpload(request.body, ext, MAX_VIDEO_BYTES);
  const title = (p.get("title") ?? filename.replace(/\.[^.]+$/, "")).trim();
  const video = await addUploadedVideo(upload.path, ext, upload.size, title, p.get("description") ?? "");
  return json(video, 201);
});
