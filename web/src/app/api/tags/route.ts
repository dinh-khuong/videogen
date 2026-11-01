import { route, json } from "@/lib/server/http";
import { listTags } from "@/lib/server/tags";

export const GET = route(async () => json(listTags()));
