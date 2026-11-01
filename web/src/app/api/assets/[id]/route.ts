import { deleteAsset, getAsset, updateAsset } from "@/lib/server/assets";
import { route, json, notFound, readJson } from "@/lib/server/http";

export const GET = route(async (_req: Request, ctx: RouteContext<"/api/assets/[id]">) => {
  const asset = getAsset((await ctx.params).id);
  return asset ? json(asset) : notFound("Không tìm thấy asset");
});

export const PATCH = route(async (request: Request, ctx: RouteContext<"/api/assets/[id]">) => {
  const body = await readJson<{ title?: string; description?: string; aiSummary?: string; ocrText?: string }>(request);
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  const asset = updateAsset((await ctx.params).id, {
    title: text(body.title)?.trim(),
    description: text(body.description),
    aiSummary: text(body.aiSummary)?.trim(),
    ocrText: text(body.ocrText)?.trim(),
  });
  return asset ? json(asset) : notFound("Không tìm thấy asset");
});

export const DELETE = route(async (_req: Request, ctx: RouteContext<"/api/assets/[id]">) => {
  return (await deleteAsset((await ctx.params).id)) ? json({ ok: true }) : notFound("Không tìm thấy asset");
});
