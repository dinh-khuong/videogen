import { addActivity } from "@/lib/server/contacts";
import { route, json, readJson } from "@/lib/server/http";

export const POST = route(async (request: Request, ctx: RouteContext<"/api/contacts/[id]/activities">) => {
  const body = await readJson<{ type?: string; content?: string }>(request);
  addActivity((await ctx.params).id, body.type ?? "note", String(body.content ?? ""));
  return json({ ok: true }, 201);
});
