import { serveFile } from "@/lib/server/files";
import { route, notFound } from "@/lib/server/http";
import { MEDIA_SUBDIRS, mediaPath, type MediaSubdir } from "@/lib/server/paths";

/** Phục vụ file media (ảnh, video, thumbnail) từ thư mục dữ liệu local, hỗ trợ tua video. */
export const GET = route(async (request: Request, ctx: RouteContext<"/api/files/[...path]">) => {
  const parts = (await ctx.params).path;
  if (parts.length !== 2 || !MEDIA_SUBDIRS.includes(parts[0] as MediaSubdir) || parts[1].startsWith(".")) {
    return notFound();
  }
  return serveFile(mediaPath(parts.join("/")), request);
});
