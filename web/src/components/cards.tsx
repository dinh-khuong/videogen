"use client";

import Link from "next/link";
import { formatDuration, timeAgo } from "@/lib/client";
import type { JobItem, VideoItem } from "@/lib/types";
import { JobStatusBadge, ProgressBar, cx } from "./ui";

export function VideoCard({ video, action }: { video: VideoItem; action?: React.ReactNode }) {
  const vertical = (video.height ?? 0) > (video.width ?? 0);
  return (
    <div className="group overflow-hidden rounded-xl bg-white ring-1 ring-zinc-200/80">
      <Link href={`/videos/${video.id}`} className="relative block aspect-video bg-zinc-900">
        {video.thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={video.thumbUrl} alt={video.title} loading="lazy" className={cx("size-full", vertical ? "object-contain" : "object-cover")} />
        ) : (
          <div className="grid size-full place-items-center text-xs text-zinc-400">Không có ảnh xem trước</div>
        )}
        {video.duration != null && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[11px] font-medium text-white">
            {formatDuration(video.duration)}
          </span>
        )}
        {video.kind === "upload" && (
          <span className="absolute left-1.5 top-1.5 rounded bg-white/90 px-1.5 py-0.5 text-[11px] font-medium text-zinc-700">Tải lên</span>
        )}
      </Link>
      <div className="flex items-start justify-between gap-2 p-3">
        <div className="min-w-0">
          <Link href={`/videos/${video.id}`} className="line-clamp-2 text-sm font-medium text-zinc-900 hover:text-brand-700">
            {video.title || "(Chưa đặt tên)"}
          </Link>
          <p className="mt-0.5 text-xs text-zinc-500">
            {timeAgo(video.createdAt)}
            {video.width && video.height ? ` · ${video.width}×${video.height}` : ""}
          </p>
        </div>
        {action}
      </div>
    </div>
  );
}

const STAGES: Record<string, string> = {
  script: "Viết kịch bản",
  images: "Lấy ảnh",
  audio: "Giọng đọc",
  render: "Dựng video",
  save: "Lưu thư viện",
};

export function JobRow({ job }: { job: JobItem }) {
  const active = job.status === "running" || job.status === "queued";
  return (
    <Link href={`/jobs/${job.id}`} className="block px-4 py-3 transition-colors hover:bg-zinc-50">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-medium text-zinc-900">{job.topic}</p>
        <JobStatusBadge status={job.status} />
      </div>
      {job.status === "running" ? (
        <div className="mt-2 flex items-center gap-3">
          <ProgressBar value={job.progress} className="flex-1" />
          <span className="w-10 text-right text-xs tabular-nums text-zinc-500">{Math.round(job.progress * 100)}%</span>
        </div>
      ) : null}
      <p className="mt-1 truncate text-xs text-zinc-500">
        {active
          ? `${job.stage ? `${STAGES[job.stage] ?? job.stage} · ` : ""}${job.message ?? ""}`
          : job.status === "failed"
            ? job.error?.split("\n").pop()
            : timeAgo(job.finishedAt ?? job.createdAt)}
      </p>
    </Link>
  );
}

export { STAGES };
