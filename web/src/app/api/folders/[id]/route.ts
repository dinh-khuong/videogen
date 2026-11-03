import { deleteFolder, renameFolder } from "@/lib/server/folders";
import { route, json, notFound, readJson } from "@/lib/server/http";

/** Đổi tên thư mục: { name } */
export const PATCH = route(async (request: Request, ctx: RouteContext<"/api/folders/[id]">) => {
  const body = await readJson<{ name?: unknown }>(request);
  const folder = renameFolder((await ctx.params).id, body.name);
  return folder ? json(folder) : notFound("Không tìm thấy thư mục");
});

/** Xóa thư mục; asset bên trong được giữ lại và chuyển về "Chưa phân loại". */
export const DELETE = route(async (_req: Request, ctx: RouteContext<"/api/folders/[id]">) => {
  return deleteFolder((await ctx.params).id) ? json({ ok: true }) : notFound("Không tìm thấy thư mục");
});
