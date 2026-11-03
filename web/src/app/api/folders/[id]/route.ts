import { deleteFolder, updateFolder } from "@/lib/server/folders";
import { route, json, notFound, readJson, searchParams } from "@/lib/server/http";

/** Sửa thư mục: { name?, color?, starred?, parentId? } (parentId null = chuyển ra gốc thư viện). */
export const PATCH = route(async (request: Request, ctx: RouteContext<"/api/folders/[id]">) => {
  const body = await readJson<{ name?: unknown; color?: unknown; starred?: unknown; parentId?: unknown }>(request);
  const folder = updateFolder((await ctx.params).id, body);
  return folder ? json(folder) : notFound("Không tìm thấy thư mục");
});

/**
 * Xóa thư mục. Mặc định asset và thư mục con được giữ lại, chuyển lên thư mục cha;
 * ?contents=delete thì xóa vĩnh viễn cả nội dung bên trong.
 */
export const DELETE = route(async (request: Request, ctx: RouteContext<"/api/folders/[id]">) => {
  const withContents = searchParams(request).get("contents") === "delete";
  return (await deleteFolder((await ctx.params).id, withContents)) ? json({ ok: true }) : notFound("Không tìm thấy thư mục");
});
