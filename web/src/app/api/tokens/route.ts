import { resetHealthCache } from "@/lib/server/engine";
import { route, json, readJson } from "@/lib/server/http";
import { createToken, listTokens } from "@/lib/server/tokens";

/** Danh sách token (giá trị che bớt, không bao giờ trả về giá trị thật). */
export const GET = route(async () => json(listTokens()));

export const POST = route(async (request: Request) => {
  const token = createToken(await readJson<Parameters<typeof createToken>[0]>(request));
  resetHealthCache();
  return json(token, 201);
});
