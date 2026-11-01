import { route, json, notFound } from "@/lib/server/http";
import { createJob, getJobRow, validateInput } from "@/lib/server/jobs";
import { runner } from "@/lib/server/runner";

/** Tạo job mới với cùng yêu cầu (kiểm tra lại vì ảnh/video nền có thể đã bị xóa). */
export const POST = route(async (_req: Request, ctx: RouteContext<"/api/jobs/[id]/retry">) => {
  const row = getJobRow((await ctx.params).id);
  if (!row) return notFound("Không tìm thấy job");
  const job = createJob(validateInput(JSON.parse(row.input)));
  runner().kick();
  return json(job, 201);
});
