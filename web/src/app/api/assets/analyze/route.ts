import { analyzer } from "@/lib/server/analyzer";
import { queueAnalysis } from "@/lib/server/assets";
import { route, json, readJson } from "@/lib/server/http";

/** Xếp hàng phân tích lại: { ids: [...] } hoặc { failed: true } (mọi asset phân tích lỗi). */
export const POST = route(async (request: Request) => {
  const body = await readJson<{ ids?: unknown; failed?: unknown }>(request);
  const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 500) : [];
  const queued = queueAnalysis(ids, body.failed === true);
  if (queued) analyzer().kick();
  return json({ queued });
});
