import { route, json, notFound, readJson } from "@/lib/server/http";
import { deleteImage, getImage, updateImage } from "@/lib/server/images";

export const GET = route(async (_req: Request, ctx: RouteContext<"/api/images/[id]">) => {
  const image = getImage((await ctx.params).id);
  return image ? json(image) : notFound("Không tìm thấy ảnh");
});

export const PATCH = route(async (request: Request, ctx: RouteContext<"/api/images/[id]">) => {
  const body = await readJson<{ title?: string; description?: string }>(request);
  const image = updateImage((await ctx.params).id, {
    title: typeof body.title === "string" ? body.title.trim() : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
  });
  return image ? json(image) : notFound("Không tìm thấy ảnh");
});

export const DELETE = route(async (_req: Request, ctx: RouteContext<"/api/images/[id]">) => {
  return (await deleteImage((await ctx.params).id)) ? json({ ok: true }) : notFound("Không tìm thấy ảnh");
});
