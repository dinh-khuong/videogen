import { route, intParam, json, readJson, searchParams } from "@/lib/server/http";
import { createJob, listJobs, validateInput } from "@/lib/server/jobs";
import { runner } from "@/lib/server/runner";
import type { JobInput } from "@/lib/types";

export const GET = route(async (request: Request) => {
  runner(); // đảm bảo hàng đợi đang chạy (vd sau khi server khởi động lại)
  const p = searchParams(request);
  return json(listJobs({ status: p.get("status") || undefined, limit: intParam(p.get("limit")) }));
});

/** Tạo video: đưa yêu cầu vào hàng đợi, engine Python sẽ chạy ở tiến trình riêng. */
export const POST = route(async (request: Request) => {
  const input = validateInput(await readJson<Partial<JobInput>>(request));
  const job = createJob(input);
  runner().kick();
  return json(job, 201);
});
