import { route, json, notFound } from "@/lib/server/http";
import { deleteJob, getJobDetail } from "@/lib/server/jobs";
import { runner } from "@/lib/server/runner";

export const GET = route(async (_req: Request, ctx: RouteContext<"/api/jobs/[id]">) => {
  runner();
  const job = getJobDetail((await ctx.params).id);
  return job ? json(job) : notFound("Không tìm thấy job");
});

export const DELETE = route(async (_req: Request, ctx: RouteContext<"/api/jobs/[id]">) => {
  return (await deleteJob((await ctx.params).id)) ? json({ ok: true }) : notFound("Không tìm thấy job");
});
