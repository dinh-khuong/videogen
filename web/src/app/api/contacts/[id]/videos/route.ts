import { linkVideo, unlinkVideo } from "@/lib/server/contacts";
import { HttpError } from "@/lib/server/files";
import { route, json, readJson, searchParams } from "@/lib/server/http";

/** Gắn video với khách hàng. */
export const POST = route(async (request: Request, ctx: RouteContext<"/api/contacts/[id]/videos">) => {
  const { videoId } = await readJson<{ videoId?: string }>(request);
  if (!videoId) throw new HttpError(400, "Thiếu videoId");
  linkVideo((await ctx.params).id, videoId);
  return json({ ok: true }, 201);
});

export const DELETE = route(async (request: Request, ctx: RouteContext<"/api/contacts/[id]/videos">) => {
  const videoId = searchParams(request).get("videoId");
  if (!videoId) throw new HttpError(400, "Thiếu videoId");
  unlinkVideo((await ctx.params).id, videoId);
  return json({ ok: true });
});
