import { db } from "@/lib/server/db";
import { route, json } from "@/lib/server/http";
import type { Stats } from "@/lib/types";

export const GET = route(async () => {
  const count = (sql: string, ...params: unknown[]) => (db().prepare(sql).get(...params) as { n: number }).n;
  const stats: Stats = {
    videos: count("SELECT COUNT(*) AS n FROM videos"),
    images: count("SELECT COUNT(*) AS n FROM images"),
    contacts: count("SELECT COUNT(*) AS n FROM contacts"),
    jobsActive: count("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running')"),
    followUpsDue: count(
      "SELECT COUNT(*) AS n FROM contacts WHERE follow_up_at IS NOT NULL AND follow_up_at <= ?",
      new Date().toISOString().slice(0, 10),
    ),
  };
  return json(stats);
});
