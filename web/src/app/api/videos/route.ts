import { route, intParam, json, searchParams } from "@/lib/server/http";
import { listVideos } from "@/lib/server/videos";

export const GET = route(async (request: Request) => {
  const p = searchParams(request);
  return json(
    listVideos({
      q: p.get("q") || undefined,
      tag: p.get("tag") || undefined,
      limit: intParam(p.get("limit")),
      offset: intParam(p.get("offset")),
    }),
  );
});
