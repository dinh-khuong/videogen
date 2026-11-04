import { route, json, notFound } from "@/lib/server/http";
import { testToken } from "@/lib/server/tokens";

/** Kiểm tra token bằng một lời gọi thử tới dịch vụ, lưu và trả về kết quả. */
export const POST = route(async (_req: Request, ctx: RouteContext<"/api/tokens/[id]/test">) => {
  const token = await testToken((await ctx.params).id);
  return token ? json(token) : notFound("Không tìm thấy token");
});
