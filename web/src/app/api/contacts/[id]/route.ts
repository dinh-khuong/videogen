import { deleteContact, getContactDetail, updateContact, type ContactInput } from "@/lib/server/contacts";
import { route, json, notFound, readJson } from "@/lib/server/http";

export const GET = route(async (_req: Request, ctx: RouteContext<"/api/contacts/[id]">) => {
  const contact = getContactDetail((await ctx.params).id);
  return contact ? json(contact) : notFound("Không tìm thấy khách hàng");
});

export const PATCH = route(async (request: Request, ctx: RouteContext<"/api/contacts/[id]">) => {
  const contact = updateContact((await ctx.params).id, await readJson<ContactInput>(request));
  return contact ? json(contact) : notFound("Không tìm thấy khách hàng");
});

export const DELETE = route(async (_req: Request, ctx: RouteContext<"/api/contacts/[id]">) => {
  return deleteContact((await ctx.params).id) ? json({ ok: true }) : notFound("Không tìm thấy khách hàng");
});
