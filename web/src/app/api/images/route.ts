import { HttpError, IMAGE_EXTS, extOf, saveUpload } from "@/lib/server/files";
import { route, intParam, json, searchParams } from "@/lib/server/http";
import { addImages, getImage, listImages } from "@/lib/server/images";

const MAX_IMAGE_BYTES = 40e6;

export const GET = route(async (request: Request) => {
  const p = searchParams(request);
  return json(
    listImages({
      q: p.get("q") || undefined,
      tag: p.get("tag") || undefined,
      ids: p.get("ids") ? p.get("ids")!.split(",") : undefined,
      limit: intParam(p.get("limit")),
      offset: intParam(p.get("offset")),
    }),
  );
});

/** Tải một ảnh lên: body là nội dung file, tên file + mô tả trong query string. */
export const POST = route(async (request: Request) => {
  const p = searchParams(request);
  const filename = p.get("filename") || "image.jpg";
  const ext = extOf(filename);
  if (!IMAGE_EXTS.includes(ext)) {
    throw new HttpError(415, `Chỉ hỗ trợ ảnh ${IMAGE_EXTS.join(", ")} (file ${filename})`);
  }
  const upload = await saveUpload(request.body, ext, MAX_IMAGE_BYTES);
  const title = (p.get("title") ?? filename.replace(/\.[^.]+$/, "")).trim();
  const [result] = await addImages([
    { tmpPath: upload.path, ext, sha1: upload.sha1, size: upload.size, title, description: p.get("description") ?? "", source: "upload" },
  ]);
  return json({ image: getImage(result.id), existed: result.existed }, result.existed ? 200 : 201);
});
