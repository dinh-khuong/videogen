import { checkFolderId, moveAssets } from "@/lib/server/folders";
import { route, json, readJson } from "@/lib/server/http";

/** Chuyển nhiều asset vào thư mục: { ids: [...], folderId } (folderId null = bỏ khỏi thư mục). */
export const POST = route(async (request: Request) => {
  const body = await readJson<{ ids?: unknown; folderId?: unknown }>(request);
  const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 1000) : [];
  return json({ moved: moveAssets(ids, checkFolderId(body.folderId)) });
});
