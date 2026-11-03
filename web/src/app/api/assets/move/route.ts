import { checkFolderId, moveAssets, moveFolders } from "@/lib/server/folders";
import { route, json, readJson } from "@/lib/server/http";

const ids = (value: unknown) => (Array.isArray(value) ? value.map(String).slice(0, 1000) : []);

/**
 * Chuyển nhiều asset và thư mục vào một thư mục: { ids: [...asset], folderIds: [...thư mục], folderId }
 * (folderId null = ra gốc thư viện).
 */
export const POST = route(async (request: Request) => {
  const body = await readJson<{ ids?: unknown; folderIds?: unknown; folderId?: unknown }>(request);
  const target = checkFolderId(body.folderId);
  const folders = moveFolders(ids(body.folderIds), target);
  return json({ moved: moveAssets(ids(body.ids), target), folders });
});
