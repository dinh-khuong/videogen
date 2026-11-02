"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, formatDate, useApi, useDocumentTitle } from "@/lib/client";
import type { AgentEvent, JobDetail, JobItem } from "@/lib/types";
import { COLOR_FILTERS, LENGTHS, PACINGS, SUBTITLE_STYLES, TRANSITIONS, VIDEO_TYPES, VOICE_EFFECTS, voiceLabel } from "@/lib/video-options";
import { JobRow, STAGES, VideoCard } from "./cards";

function libraryTagsLabel(i: JobDetail["input"]): string {
  const tags = i.libraryTags?.length ? i.libraryTags : i.libraryTag ? [i.libraryTag] : [];
  return tags.length ? ` trong ${tags.map((t) => `#${t}`).join(", ")}` : "";
}
import { Button, Card, ConfirmButton, EmptyState, ErrorBox, JobStatusBadge, Loading, PageHeader, ProgressBar, buttonClass, cx, inputClass } from "./ui";

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
              status === f.value ? "bg-zinc-900 text-zinc-50" : "bg-surface text-zinc-600 ring-1 ring-zinc-200 hover:bg-zinc-50",
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
const DIRECTOR_STAGE_ORDER = ["director", "images", "audio", "render", "save"];

function StageSteps({ job }: { job: JobDetail }) {
  const order = job.input.director ? DIRECTOR_STAGE_ORDER : STAGE_ORDER;
  // Engine của Đạo diễn AI vẫn báo "script" một thoáng khi chuyển sang lấy hình
  const current = order.indexOf(job.input.director && job.stage === "script" ? "images" : (job.stage ?? ""));
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {order.map((stage, i) => {
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
      className="scroll-thin max-h-80 overflow-auto rounded-lg bg-neutral-900 p-3 font-mono text-xs leading-relaxed text-neutral-200 dark:ring-1 dark:ring-white/10"
    >
      {log.trim() || "Chưa có log."}
    </pre>
  );
}

function describeInput(job: JobDetail): string[] {
  const i = job.input;
  const lines = [
    i.script
      ? "Kịch bản: sửa tay (không gọi AI)"
      : i.director
        ? `Đạo diễn AI${i.feedback ? " · sửa theo góp ý" : ""} · số cảnh: ${i.numSteps ? `khoảng ${i.numSteps}` : "AI quyết định"}`
        : `Số bước: ${i.numSteps ?? "AI tự chọn (5-8)"}`,
    `Khung hình: ${i.layout === "split" ? "9:16 chia đôi với video nền" : i.aspect}`,
    `Hiển thị ảnh: ${{ auto: "tự động", cover: "phủ kín khung", frame: "trọn vẹn (nội dung chính)" }[i.imageStyle]}`,
    `Assets: ${{ off: "không dùng", auto: `AI tự chọn${libraryTagsLabel(i)}`, selected: `${(i.assetIds ?? i.imageIds)?.length ?? 0} asset đã chọn` }[i.libraryMode]}`,
    `Tìm trên mạng: ${i.webImages ? { image: "ảnh", video: "ưu tiên clip video", auto: "AI chọn ảnh/clip" }[i.webMedia ?? "image"] : "không"}${i.webImages && i.webMedia && i.webMedia !== "image" ? ` · ${i.clipsPerStep ?? 3} clip/bước` : ""}`,
  ];
  if (i.videoType || i.length) {
    lines.push(`Loại: ${VIDEO_TYPES[i.videoType ?? "howto"].label} · ${LENGTHS[i.length ?? "medium"].label}${i.tone ? ` · giọng văn ${i.tone}` : ""}`);
  }
  if (i.voice || i.rate || i.pitch || i.voiceEffect) {
    const voices = [voiceLabel(i.voice) || "mặc định", i.voice2 ? `${voiceLabel(i.voice2)} (xen kẽ)` : ""].filter(Boolean).join(" + ");
    lines.push(`Giọng: ${voices}${i.rate && i.rate !== "+0%" ? ` · tốc độ ${i.rate}` : ""}${i.pitch && i.pitch !== "+0Hz" ? ` · cao độ ${i.pitch}` : ""}${i.voiceEffect && i.voiceEffect !== "none" ? ` · hiệu ứng ${VOICE_EFFECTS[i.voiceEffect].toLowerCase()}` : ""}`);
  }
  if (i.style) {
    const st = i.style;
    lines.push(`Nhịp ${PACINGS[st.pacing].label.toLowerCase()} · chuyển cảnh ${TRANSITIONS[st.transition].split(" (")[0].toLowerCase()}`);
    lines.push(`Phụ đề: ${SUBTITLE_STYLES[st.subtitleStyle].split(" (")[0]} · màu ${COLOR_FILTERS[st.colorFilter].toLowerCase()}`);
    const extras = [st.progressBar && "thanh tiến độ", st.sfx && "hiệu ứng âm thanh", st.logoId && "logo", st.cta && `lời kêu gọi “${st.cta}”`].filter(Boolean);
    if (extras.length) lines.push(`Thêm: ${extras.join(", ")}`);
  }
  return lines;
}

function isActive(job: JobItem): boolean {
  return job.status === "queued" || job.status === "running";
}

/** Chủ đề/prompt đầy đủ của job; prompt dài được thu gọn, bấm để xem hết. */
function TopicView({ topic }: { topic: string }) {
  const long = topic.length > 160 || topic.includes("\n");
  if (!long) return <p className="text-sm text-zinc-700"><span className="text-zinc-500">Chủ đề:</span> {topic}</p>;
  return (
    <details className="group rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200">
      <summary className="cursor-pointer text-sm text-zinc-700">
        <span className="text-zinc-500">Yêu cầu ({topic.length.toLocaleString("vi-VN")} ký tự):</span>{" "}
        <span className="group-open:hidden">{topic.slice(0, 120).replace(/\s+/g, " ")}…</span>
      </summary>
      <p className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm text-zinc-700">{topic}</p>
    </details>
  );
}

const AGENT_STYLE: Record<AgentEvent["kind"], { dot: string; text: string }> = {
  thought: { dot: "bg-violet-500", text: "italic text-zinc-800" },
  action: { dot: "bg-brand-500", text: "font-medium text-zinc-900" },
  result: { dot: "bg-zinc-300", text: "text-zinc-500" },
  warn: { dot: "bg-amber-500", text: "text-amber-700" },
  done: { dot: "bg-emerald-500", text: "font-medium text-emerald-700" },
};

/** Từng suy nghĩ và hành động của Đạo diễn AI, cập nhật trực tiếp khi job đang chạy. */
function AgentTimeline({ events, live }: { events: AgentEvent[]; live: boolean }) {
  const ref = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  const turns = events.reduce((n, e) => Math.max(n, e.turn), 0);
  const actions = events.filter((e) => e.kind === "action").length;
  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-zinc-900">{live ? "Đạo diễn AI đang làm việc" : "Nhật ký Đạo diễn AI"}</h2>
        <span className="text-xs tabular-nums text-zinc-500">
          {turns} lượt suy nghĩ · {actions} hành động
        </span>
      </div>
      <ol
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="scroll-thin max-h-[28rem] space-y-1.5 overflow-auto pr-1 text-sm"
      >
        {events.map((e, k) => (
          <li key={k} className={cx("flex gap-2.5", e.kind === "result" && "pl-4")}>
            <span className={cx("mt-1.5 size-2 shrink-0 rounded-full", AGENT_STYLE[e.kind]?.dot ?? "bg-zinc-300")} />
            <span className={cx("min-w-0 whitespace-pre-wrap break-words", AGENT_STYLE[e.kind]?.text)}>{e.text}</span>
          </li>
        ))}
        {live && (
          <li className="flex gap-2.5 text-zinc-400">
            <span className="mt-1.5 size-2 shrink-0 animate-pulse rounded-full bg-violet-400" />
            Đang nghĩ...
          </li>
        )}
      </ol>
    </Card>
  );
}

const FEEDBACK_CHIPS = ["Hài hước hơn", "Thêm meme", "Hook 3 giây đầu mạnh hơn", "Ngắn gọn lại", "Giọng sôi nổi hơn", "Bớt hiệu ứng", "Dùng nhiều clip hơn"];

/** Góp ý cho Đạo diễn AI: tạo job mới sửa lại video này (giữ cài đặt, AI bắt đầu từ storyboard cũ). */
function FeedbackBox({ job }: { job: JobDetail }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api<JobItem>("/api/jobs", {
        method: "POST",
        json: { ...job.input, topic: job.topic, script: null, sourceVideoId: null, director: true, feedback: text.trim(), baseJobId: job.id },
      });
      router.push(`/jobs/${next.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Card className="p-5">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <h2 className="font-semibold text-zinc-900">Góp ý để Đạo diễn AI làm lại</h2>
          <p className="text-sm text-zinc-500">AI đọc góp ý, mở lại storyboard của video này rồi tự sửa từng cảnh (giữ nguyên cài đặt giọng, khung hình...).</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FEEDBACK_CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => setText((t) => (t.trim() ? `${t.trim()}. ${chip}` : chip))}
              className="rounded-full bg-surface px-3 py-1 text-xs font-medium text-zinc-600 ring-1 ring-zinc-200 hover:bg-zinc-50"
            >
              + {chip}
            </button>
          ))}
        </div>
        <textarea
          className={`${inputClass} min-h-20 resize-y`}
          rows={3}
          maxLength={2000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="VD: Cảnh 2 hơi dài, thêm một meme khi nói về giá, đoạn kết vui hơn..."
        />
        <ErrorBox message={error} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" busy={busy} disabled={!text.trim()}>
            Gửi góp ý và làm lại
          </Button>
        </div>
      </form>
    </Card>
  );
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
          <h1 className="line-clamp-2 min-w-0 break-words text-2xl font-semibold tracking-tight text-zinc-900" title={job.topic}>
            {job.video?.title || job.topic}
          </h1>
          <div className="flex flex-wrap gap-2">
            {active && (
              <Button variant="danger" onClick={() => act(async () => (await api(`/api/jobs/${id}/cancel`, { method: "POST" }), void reload()))}>
                Hủy job
              </Button>
            )}
            {!active && !job.input.script && (
              <Link href={`/create?from=${job.id}`} className={buttonClass("secondary")}>
                Tạo video tương tự
              </Link>
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
        {!job.input.script && <TopicView topic={job.topic} />}
        {job.input.feedback && (
          <p className="rounded-lg bg-violet-50 p-3 text-sm text-violet-900 ring-1 ring-violet-200 dark:bg-violet-500/10 dark:text-violet-200 dark:ring-violet-500/30">
            <span className="font-medium">Góp ý:</span> {job.input.feedback}
            {job.input.baseJobId && (
              <Link href={`/jobs/${job.input.baseJobId}`} className="ml-2 underline">
                xem bản trước
              </Link>
            )}
          </p>
        )}
        <ul className="grid gap-1 text-sm text-zinc-600 sm:grid-cols-2">
          {describeInput(job).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Card>

      {job.agent.length > 0 && <AgentTimeline events={job.agent} live={active && job.stage === "director"} />}

      {job.video && (
        <section>
          <h2 className="mb-3 font-semibold text-zinc-900">Video đã tạo</h2>
          <div className="max-w-sm">
            <VideoCard video={job.video} />
          </div>
        </section>
      )}

      {job.video && !active && <FeedbackBox job={job} />}

      <section>
        <h2 className="mb-3 font-semibold text-zinc-900">Log của engine</h2>
        <LogView log={job.log} />
      </section>
    </div>
  );
}
