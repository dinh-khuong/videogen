import { createFolder, listFolders } from "@/lib/server/folders";
import { route, json, readJson } from "@/lib/server/http";

export const GET = route(async () => json(listFolders()));

/** Tạo thư mục: { name } */
export const POST = route(async (request: Request) => {
  const body = await readJson<{ name?: unknown }>(request);
  return json(createFolder(body.name), 201);
});
