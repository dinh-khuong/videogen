import { resetHealthCache } from "@/lib/server/engine";
import { route, json, notFound, readJson } from "@/lib/server/http";
import { deleteToken, updateToken } from "@/lib/server/tokens";

export const PATCH = route(async (request: Request, ctx: RouteContext<"/api/tokens/[id]">) => {
  const token = updateToken((await ctx.params).id, await readJson<Parameters<typeof updateToken>[1]>(request));
  if (!token) return notFound("Không tìm thấy token");
  resetHealthCache();
  return json(token);
});

export const DELETE = route(async (_req: Request, ctx: RouteContext<"/api/tokens/[id]">) => {
  if (!deleteToken((await ctx.params).id)) return notFound("Không tìm thấy token");
  resetHealthCache();
  return json({ ok: true });
});
