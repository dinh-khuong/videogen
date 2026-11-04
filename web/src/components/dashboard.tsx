"use client";

import Link from "next/link";
import { formatDate, useApi } from "@/lib/client";
import type { Contact, EngineHealth, JobItem, Page, Stats, VideoItem } from "@/lib/types";
import { JobRow, VideoCard } from "./cards";
import { Card, EmptyState, ErrorBox, Loading, PageHeader, buttonClass } from "./ui";

function StatCard({ label, value, href, accent }: { label: string; value: number | undefined; href: string; accent?: boolean }) {
  return (
    <Link href={href}>
      <Card className="p-4 transition-shadow hover:shadow-md">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
        <p className={`mt-1 text-2xl font-semibold tabular-nums ${accent ? "text-brand-600" : "text-zinc-900"}`}>{value ?? "–"}</p>
      </Card>
    </Link>
  );
}

function EngineStatus() {
  const { data, loading, reload } = useApi<EngineHealth>("/api/health");
  if (loading || !data) {
    return <p className="text-sm text-zinc-500">Đang kiểm tra engine Python...</p>;
  }
  if (data.ok) {
    return (
      <div className="space-y-1 text-sm text-zinc-600">
        <p className="font-medium text-emerald-700">● Engine sẵn sàng</p>
        <p>Python {data.python} · moviepy {data.moviepy}</p>
        <p>Nguồn ảnh: {data.image_providers?.join(", ")}</p>
        <p>Nguồn clip video: {data.video_providers?.length ? data.video_providers.join(", ") : "chưa có"}</p>
        {data.model && (
          <p>
            Model AI: {data.model}
            {data.director_model && data.director_model !== data.model ? ` · Đạo diễn: ${data.director_model}` : ""}
          </p>
        )}
        <p>Giọng đọc mặc định: {data.voice}</p>
        <p>Đọc chữ trong asset: {data.ocr ?? "chưa có Tesseract"}</p>
        {data.vision && <p>Mô hình thị giác: {data.vision}</p>}
        {data.warnings?.map((w) => (
          <p key={w} className="text-amber-700">
            ⚠ {w}
          </p>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-red-700">● Engine cần cấu hình</p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-600">
        {data.problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium">
        <Link href="/tokens" className="text-brand-600 hover:underline">
          Quản lý token API
        </Link>
        <button type="button" onClick={() => void reload()} className="text-brand-600 hover:underline">
          Kiểm tra lại
        </button>
      </div>
    </div>
  );
}

export function Dashboard() {
  const stats = useApi<Stats>("/api/stats", { refreshMs: 5000 });
  const jobs = useApi<JobItem[]>("/api/jobs?limit=6", { refreshMs: 2000 });
  const videos = useApi<Page<VideoItem>>("/api/videos?limit=6");
  const due = useApi<Page<Contact>>("/api/contacts?due=1&limit=5");

  return (
    <>
      <PageHeader
        title="Tổng quan"
        subtitle="Tạo video hướng dẫn bằng AI và quản lý thư viện, khách hàng."
        actions={
          <Link href="/create" className={buttonClass("primary")}>
            + Tạo video mới
          </Link>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Video" value={stats.data?.videos} href="/videos" />
        <StatCard label="Assets" value={stats.data?.assets} href="/assets" />
        <StatCard label="Khách hàng" value={stats.data?.contacts} href="/crm" />
        <StatCard label="Job đang chạy" value={stats.data?.jobsActive} href="/jobs" accent={!!stats.data?.jobsActive} />
        <StatCard label="Cần chăm sóc" value={stats.data?.followUpsDue} href="/crm?due=1" accent={!!stats.data?.followUpsDue} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold text-zinc-900">Job gần đây</h2>
              <Link href="/jobs" className="text-sm text-brand-600 hover:underline">
                Xem tất cả
              </Link>
            </div>
            <Card className="divide-y divide-zinc-100 overflow-hidden">
              {jobs.loading && !jobs.data ? (
                <div className="px-4">
                  <Loading />
                </div>
              ) : jobs.data?.length ? (
                jobs.data.map((job) => <JobRow key={job.id} job={job} />)
              ) : (
                <p className="px-4 py-6 text-sm text-zinc-500">Chưa có job nào. Bấm “Tạo video mới” để bắt đầu.</p>
              )}
            </Card>
            <ErrorBox message={jobs.error} />
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold text-zinc-900">Video mới tạo</h2>
              <Link href="/videos" className="text-sm text-brand-600 hover:underline">
                Thư viện video
              </Link>
            </div>
            {videos.data?.items.length ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {videos.data.items.map((v) => (
                  <VideoCard key={v.id} video={v} />
                ))}
              </div>
            ) : videos.loading ? (
              <Loading />
            ) : (
              <EmptyState title="Chưa có video nào" />
            )}
          </section>
        </div>

        <div className="space-y-6">
          <section>
            <h2 className="mb-3 font-semibold text-zinc-900">Engine Python</h2>
            <Card className="p-4">
              <EngineStatus />
            </Card>
          </section>
          <section>
            <h2 className="mb-3 font-semibold text-zinc-900">Khách cần chăm sóc</h2>
            <Card className="divide-y divide-zinc-100 overflow-hidden">
              {due.data?.items.length ? (
                due.data.items.map((c) => (
                  <Link key={c.id} href={`/crm/${c.id}`} className="block px-4 py-3 hover:bg-zinc-50">
                    <p className="text-sm font-medium text-zinc-900">{c.name}</p>
                    <p className="text-xs text-red-600">Hẹn: {formatDate(c.followUpAt, false)}</p>
                  </Link>
                ))
              ) : (
                <p className="px-4 py-6 text-sm text-zinc-500">Không có lịch hẹn đến hạn.</p>
              )}
            </Card>
          </section>
        </div>
      </div>
    </>
  );
}
