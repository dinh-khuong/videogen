import { analyzer } from "@/lib/server/analyzer";
import { addAssets, getAsset, listAssets } from "@/lib/server/assets";
import { AUDIO_EXTS, HttpError, IMAGE_EXTS, VIDEO_EXTS, extOf, saveUpload } from "@/lib/server/files";
import { route, intParam, json, searchParams } from "@/lib/server/http";

const MAX_IMAGE_BYTES = 40e6;
const MAX_VIDEO_BYTES = 4e9;
const MAX_AUDIO_BYTES = 500e6;

export const GET = route(async (request: Request) => {
  const p = searchParams(request);
  return json(
    listAssets({
      q: p.get("q") || undefined,
      tag: p.get("tag") || undefined,
      kind: p.get("kind") || undefined,
      status: p.get("status") || undefined,
      ids: p.get("ids") ? p.get("ids")!.split(",") : undefined,
      limit: intParam(p.get("limit")),
      offset: intParam(p.get("offset")),
    }),
  );
});

/** Tải một asset (ảnh, video hoặc audio) lên: body là nội dung file, tên file + mô tả trong query string. */
export const POST = route(async (request: Request) => {
  const p = searchParams(request);
  const filename = p.get("filename") || "file.jpg";
  const ext = extOf(filename);
  const maxBytes = IMAGE_EXTS.includes(ext) ? MAX_IMAGE_BYTES : VIDEO_EXTS.includes(ext) ? MAX_VIDEO_BYTES : AUDIO_EXTS.includes(ext) ? MAX_AUDIO_BYTES : 0;
  if (!maxBytes) {
    throw new HttpError(
      415,
      `Chỉ hỗ trợ ảnh ${IMAGE_EXTS.join(", ")}, video ${VIDEO_EXTS.join(", ")} hoặc audio ${AUDIO_EXTS.join(", ")} (file ${filename})`,
    );
  }
  const upload = await saveUpload(request.body, ext, maxBytes);
  const title = (p.get("title") ?? filename.replace(/\.[^.]+$/, "")).trim();
  const [result] = await addAssets([
    { tmpPath: upload.path, ext, sha1: upload.sha1, size: upload.size, title, description: p.get("description") ?? "", source: "upload" },
  ]);
  if (!result.existed) analyzer().kick();
  return json({ asset: getAsset(result.id), existed: result.existed }, result.existed ? 200 : 201);
});
