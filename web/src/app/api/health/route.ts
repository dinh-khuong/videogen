import { engineHealth } from "@/lib/server/engine";
import { route, json, searchParams } from "@/lib/server/http";

/** Tình trạng engine Python (thư viện, API key, nguồn ảnh, font). */
export const GET = route(async (request: Request) => json(await engineHealth(searchParams(request).has("refresh"))));
