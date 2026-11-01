import { route, json, notFound, readJson } from "@/lib/server/http";
import { deleteVideo, getVideoDetail, updateVideo } from "@/lib/server/videos";

export const GET = route(async (_req: Request, ctx: RouteContext<"/api/videos/[id]">) => {
  const video = getVideoDetail((await ctx.params).id);
  return video ? json(video) : notFound("Không tìm thấy video");
});

export const PATCH = route(async (request: Request, ctx: RouteContext<"/api/videos/[id]">) => {
  const body = await readJson<{ title?: string; description?: string }>(request);
  const video = updateVideo((await ctx.params).id, {
    title: typeof body.title === "string" ? body.title.trim() : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
  });
  return video ? json(video) : notFound("Không tìm thấy video");
});

export const DELETE = route(async (_req: Request, ctx: RouteContext<"/api/videos/[id]">) => {
  return (await deleteVideo((await ctx.params).id)) ? json({ ok: true }) : notFound("Không tìm thấy video");
});
