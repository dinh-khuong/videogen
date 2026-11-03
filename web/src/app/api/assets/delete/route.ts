import { deleteAsset } from "@/lib/server/assets";
import { route, json, readJson } from "@/lib/server/http";

/** Xóa vĩnh viễn nhiều asset: { ids: [...] }. */
export const POST = route(async (request: Request) => {
  const body = await readJson<{ ids?: unknown }>(request);
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))].slice(0, 1000) : [];
  let deleted = 0;
  for (const id of ids) if (await deleteAsset(id)) deleted++;
  return json({ deleted });
});
