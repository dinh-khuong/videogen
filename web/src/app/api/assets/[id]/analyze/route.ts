import { analyzer } from "@/lib/server/analyzer";
import { getAsset, queueAnalysis } from "@/lib/server/assets";
import { HttpError } from "@/lib/server/files";
import { route, json, notFound } from "@/lib/server/http";

/** Phân tích lại một asset (đọc chữ + AI tóm tắt). */
export const POST = route(async (_req: Request, ctx: RouteContext<"/api/assets/[id]/analyze">) => {
  const id = (await ctx.params).id;
  const asset = getAsset(id);
  if (!asset) return notFound("Không tìm thấy asset");
  if (asset.analysisStatus === "running") throw new HttpError(409, "Asset đang được phân tích");
  queueAnalysis([id]);
  analyzer().kick();
  return json(getAsset(id));
});
