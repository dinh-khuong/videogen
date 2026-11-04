import { route, json, readJson } from "@/lib/server/http";
import { listModels } from "@/lib/server/tokens";

/** Danh sách model có trên dịch vụ AI, lấy bằng token đang nhập hoặc token đã lưu. Không lưu gì. */
export const POST = route(async (request: Request) => {
  const models = await listModels(await readJson<Parameters<typeof listModels>[0]>(request));
  return json({ models });
});
