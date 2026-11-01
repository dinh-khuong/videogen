import { HttpError } from "@/lib/server/files";
import { route, json } from "@/lib/server/http";
import { runner } from "@/lib/server/runner";

export const POST = route(async (_req: Request, ctx: RouteContext<"/api/jobs/[id]/cancel">) => {
  if (!runner().cancel((await ctx.params).id)) throw new HttpError(409, "Job không ở trạng thái chờ hoặc đang chạy");
  return json({ ok: true });
});
