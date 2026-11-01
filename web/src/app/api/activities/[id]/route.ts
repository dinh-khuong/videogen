import { deleteActivity } from "@/lib/server/contacts";
import { route, json, notFound } from "@/lib/server/http";

export const DELETE = route(async (_req: Request, ctx: RouteContext<"/api/activities/[id]">) => {
  return deleteActivity((await ctx.params).id) ? json({ ok: true }) : notFound("Không tìm thấy hoạt động");
});
