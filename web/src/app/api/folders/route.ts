import { createFolder, listFolders } from "@/lib/server/folders";
import { route, json, readJson } from "@/lib/server/http";

export const GET = route(async () => json(listFolders()));

/** Tạo thư mục: { name, parentId?, color?, reuse? } (reuse: thư mục cùng tên trong cùng thư mục cha đã có thì dùng lại). */
export const POST = route(async (request: Request) => {
  const body = await readJson<{ name?: unknown; parentId?: unknown; color?: unknown; reuse?: unknown }>(request);
  return json(createFolder(body), 201);
});
