"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, formatDate, useApi, useDocumentTitle } from "@/lib/client";
import type { JobDetail, JobItem } from "@/lib/types";
import { JobRow, STAGES, VideoCard } from "./cards";
import { Button, Card, ConfirmButton, EmptyState, ErrorBox, JobStatusBadge, Loading, PageHeader, ProgressBar, buttonClass, cx } from "./ui";

const FILTERS = [
  { value: "", label: "Tất cả" },
  { value: "active", label: "Đang chờ/chạy" },
  { value: "succeeded", label: "Hoàn tất" },
  { value: "failed", label: "Lỗi" },
  { value: "canceled", label: "Đã hủy" },
];

export function JobsList() {
  const [status, setStatus] = useState("");
  const { data, error, loading, reload } = useApi<JobItem[]>(`/api/jobs?limit=100${status ? `&status=${status}` : ""}`, {
    refreshMs: 2000,
  });
  return (
    <>
      <PageHeader
        title="Hàng đợi tạo video"
        subtitle="Mỗi job chạy engine Python ở một tiến trình riêng; các job lần lượt được xử lý."
        actions={
          <Link href="/create" className={buttonClass("primary")}>
            + Tạo video
          </Link>
        }
      />
      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setStatus(f.value)}
            className={cx(
              "rounded-full px-3 py-1 text-sm font-medium",
              status === f.value ? "bg-zinc-900 text-white" : "bg-white text-zinc-600 ring-1 ring-zinc-200 hover:bg-zinc-50",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      <ErrorBox message={error} onRetry={() => void reload()} />
      {loading && !data ? (
        <Loading />
      ) : data?.length ? (
        <Card className="divide-y divide-zinc-100 overflow-hidden">
          {data.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </Card>
      ) : (
        <EmptyState title="Không có job nào" />
      )}
    </>
  );
}

const STAGE_ORDER = ["script", "images", "audio", "render", "save"];

function StageSteps({ job }: { job: JobDetail }) {
  const current = STAGE_ORDER.indexOf(job.stage ?? "");
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {STAGE_ORDER.map((stage, i) => {
        const done = job.status === "succeeded" || i < current;
        const active = job.status === "running" && i === current;
        return (
          <li key={stage} className={cx("flex items-center gap-1.5", done ? "text-emerald-700" : active ? "font-semibold text-brand-700" : "text-zinc-400")}>
            <span className={cx("size-2 rounded-full", done ? "bg-emerald-500" : active ? "animate-pulse bg-brand-500" : "bg-zinc-300")} />
            {STAGES[stage]}
          </li>
        );
      })}
    </ol>
  );
}

function LogView({ log }: { log: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [log]);
  return (
    <pre
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="scroll-thin max-h-80 overflow-auto rounded-lg bg-zinc-900 p-3 font-mono text-xs leading-relaxed text-zinc-200"
    >
      {log.trim() || "Chưa có log."}
    </pre>
  );
}

function describeInput(job: JobDetail): string[] {
  const i = job.input;
  const lines = [
    i.script ? "Kịch bản: sửa tay (không gọi AI)" : `Số bước: ${i.numSteps ?? "AI tự chọn (5-8)"}`,
    `Khung hình: ${i.layout === "split" ? "9:16 chia đôi với video nền" : i.aspect}`,
    `Hiển thị ảnh: ${{ auto: "tự động", cover: "phủ kín khung", frame: "trọn vẹn (nội dung chính)" }[i.imageStyle]}`,
    `Ảnh thư viện: ${{ off: "không dùng", auto: `AI tự chọn${i.libraryTag ? ` trong #${i.libraryTag}` : ""}`, selected: `${i.imageIds?.length ?? 0} ảnh đã chọn` }[i.libraryMode]}`,
    `Tìm ảnh trên mạng: ${i.webImages ? "có" : "không"}`,
  ];
  if (i.voice || i.rate) lines.push(`Giọng: ${i.voice ?? "mặc định"} ${i.rate ?? ""}`.trim());
  return lines;
}

function isActive(job: JobItem): boolean {
  return job.status === "queued" || job.status === "running";
}

export function JobDetailView({ id }: { id: string }) {
  const router = useRouter();
  const { data: job, error, loading, reload } = useApi<JobDetail>(`/api/jobs/${id}`, {
    refreshMs: 1500,
    shouldRefresh: isActive,
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const active = !!job && isActive(job);
  useDocumentTitle(job?.topic);

  if (loading && !job) return <Loading />;
  if (!job) return <ErrorBox message={error ?? "Không tìm thấy job"} />;

  const act = async (fn: () => Promise<void>) => {
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <Link href="/jobs" className="text-sm text-zinc-500 hover:text-zinc-800">
          ← Hàng đợi
        </Link>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="min-w-0 text-2xl font-semibold tracking-tight text-zinc-900">{job.topic}</h1>
          <div className="flex flex-wrap gap-2">
            {active && (
              <Button variant="danger" onClick={() => act(async () => (await api(`/api/jobs/${id}/cancel`, { method: "POST" }), void reload()))}>
                Hủy job
              </Button>
            )}
            {!active && (
              <Button
                onClick={() =>
                  act(async () => {
                    const next = await api<JobItem>(`/api/jobs/${id}/retry`, { method: "POST" });
                    router.push(`/jobs/${next.id}`);
                  })
                }
              >
                Chạy lại
              </Button>
            )}
            {!active && (
              <ConfirmButton
                variant="ghost"
                confirmLabel="Xóa job + file tạm?"
                onConfirm={() =>
                  act(async () => {
                    await api(`/api/jobs/${id}`, { method: "DELETE" });
                    router.push("/jobs");
                  })
                }
              >
                Xóa job
              </ConfirmButton>
            )}
          </div>
        </div>
      </div>
      <ErrorBox message={actionError} />

      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <JobStatusBadge status={job.status} />
          <span className="text-xs text-zinc-500">
            Tạo lúc {formatDate(job.createdAt)}
            {job.finishedAt && ` · Xong lúc ${formatDate(job.finishedAt)}`}
          </span>
        </div>
        {job.status !== "queued" && <StageSteps job={job} />}
        {active && (
          <div>
            <div className="mb-1.5 flex justify-between text-sm">
              <span className="text-zinc-700">{job.message}</span>
              <span className="tabular-nums text-zinc-500">{Math.round(job.progress * 100)}%</span>
            </div>
            <ProgressBar value={job.progress} />
            {job.status === "queued" && <p className="mt-2 text-xs text-zinc-500">Job sẽ chạy khi các job trước hoàn tất.</p>}
          </div>
        )}
        {job.status === "failed" && job.error && <ErrorBox message={job.error} />}
        <ul className="grid gap-1 text-sm text-zinc-600 sm:grid-cols-2">
          {describeInput(job).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Card>

      {job.video && (
        <section>
          <h2 className="mb-3 font-semibold text-zinc-900">Video đã tạo</h2>
          <div className="max-w-sm">
            <VideoCard video={job.video} />
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 font-semibold text-zinc-900">Log của engine</h2>
        <LogView log={job.log} />
      </section>
    </div>
  );
}
