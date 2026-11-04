import { and, count, inArray, isNotNull, lte } from "drizzle-orm";
import { db } from "@/lib/server/db";
import { route, json } from "@/lib/server/http";
import { assets, contacts, jobs, videos } from "@/lib/server/schema";
import type { Stats } from "@/lib/types";

export const GET = route(async () => {
  const d = db();
  const stats: Stats = {
    videos: d.select({ n: count() }).from(videos).get()!.n,
    assets: d.select({ n: count() }).from(assets).get()!.n,
    assetsAnalyzing: d.select({ n: count() }).from(assets).where(inArray(assets.analysisStatus, ["pending", "running"])).get()!.n,
    contacts: d.select({ n: count() }).from(contacts).get()!.n,
    jobsActive: d.select({ n: count() }).from(jobs).where(inArray(jobs.status, ["queued", "running"])).get()!.n,
    followUpsDue: d
      .select({ n: count() })
      .from(contacts)
      .where(and(isNotNull(contacts.followUpAt), lte(contacts.followUpAt, new Date().toISOString().slice(0, 10))))
      .get()!.n,
  };
  return json(stats);
});
