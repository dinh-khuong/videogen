"use client";

import Link from "next/link";
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { JobStatus } from "@/lib/types";

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
const BUTTON: Record<ButtonVariant, string> = {
  primary: "bg-brand-500 text-white hover:bg-brand-600 shadow-sm",
  secondary: "bg-surface text-zinc-800 ring-1 ring-zinc-300 hover:bg-zinc-50",
  danger: "bg-surface text-red-600 ring-1 ring-red-200 hover:bg-red-50",
  ghost: "text-zinc-600 hover:bg-zinc-100",
};

export function buttonClass(variant: ButtonVariant = "secondary", size: "sm" | "md" = "md"): string {
  return cx(
    "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap",
    size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-sm",
    BUTTON[variant],
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  busy,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md"; busy?: boolean }) {
  return (
    <button type="button" {...props} disabled={props.disabled || busy} className={cx(buttonClass(variant, size), className)}>
      {busy && <Spinner className="size-3.5" />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx("inline-block animate-spin rounded-full border-2 border-current border-r-transparent", className ?? "size-4")}
    />
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-xl bg-surface ring-1 ring-zinc-200/80 shadow-[0_1px_2px_rgba(0,0,0,0.04)]", className)}>{children}</div>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1.5 block text-sm font-medium text-zinc-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border-0 bg-surface px-3 py-2 text-sm text-zinc-900 ring-1 ring-zinc-300 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500";

export function ErrorBox({ message, onRetry }: { message: string | null | undefined; onRetry?: () => void }) {
  if (!message) return null;
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg bg-red-50 px-3.5 py-2.5 text-sm text-red-700 ring-1 ring-red-200">
      <span className="whitespace-pre-wrap break-words">{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="shrink-0 font-medium underline">
          Thử lại
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-surface/60 px-6 py-12 text-center">
      <p className="font-medium text-zinc-700">{title}</p>
      {children && <div className="mt-2 text-sm text-zinc-500">{children}</div>}
    </div>
  );
}

export function Loading({ label = "Đang tải..." }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-zinc-500">
      <Spinner /> {label}
    </div>
  );
}

export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cx("h-2 overflow-hidden rounded-full bg-zinc-200", className)}>
      <div className="h-full rounded-full bg-brand-500 transition-[width] duration-500" style={{ width: `${Math.round(Math.min(Math.max(value, 0), 1) * 100)}%` }} />
    </div>
  );
}

export function TagList({ tags, hrefBase, onClick }: { tags: string[]; hrefBase?: string; onClick?: (tag: string) => void }) {
  if (!tags.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag) =>
        hrefBase ? (
          <Link key={tag} href={`${hrefBase}${encodeURIComponent(tag)}`} className="rounded-md bg-brand-50 px-1.5 py-0.5 text-xs font-medium text-brand-700 hover:bg-brand-100">
            #{tag}
          </Link>
        ) : (
          <button
            key={tag}
            type="button"
            onClick={() => onClick?.(tag)}
            className="rounded-md bg-brand-50 px-1.5 py-0.5 text-xs font-medium text-brand-700 hover:bg-brand-100"
          >
            #{tag}
          </button>
        ),
      )}
    </div>
  );
}

const JOB_STATUS: Record<JobStatus, { label: string; className: string }> = {
  queued: { label: "Đang chờ", className: "bg-zinc-100 text-zinc-700" },
  running: { label: "Đang chạy", className: "bg-blue-50 text-blue-700" },
  succeeded: { label: "Hoàn tất", className: "bg-emerald-50 text-emerald-700" },
  failed: { label: "Lỗi", className: "bg-red-50 text-red-700" },
  canceled: { label: "Đã hủy", className: "bg-zinc-100 text-zinc-500" },
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const s = JOB_STATUS[status];
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", s.className)}>
      {status === "running" && <Spinner className="size-3" />}
      {s.label}
    </span>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className={cx(
          "max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl",
          wide ? "sm:max-w-4xl" : "sm:max-w-lg",
        )}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-100 bg-surface px-5 py-3.5">
          <h2 className="font-semibold text-zinc-900">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Đóng" className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100">
            <svg viewBox="0 0 20 20" className="size-5" fill="currentColor">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/** Nút cần bấm hai lần để xác nhận (tránh xóa nhầm). */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = "Bấm lần nữa để xác nhận",
  ...props
}: Omit<Parameters<typeof Button>[0], "onClick"> & { onConfirm: () => void | Promise<void>; confirmLabel?: string }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      {...props}
      busy={busy}
      onClick={async () => {
        if (!armed) return setArmed(true);
        setBusy(true);
        try {
          await onConfirm();
        } finally {
          setBusy(false);
          setArmed(false);
        }
      }}
    >
      {armed ? confirmLabel : children}
    </Button>
  );
}

/** Ô mô tả kèm xem trước hashtag được nhận diện. */
export function DescriptionInput({
  value,
  onChange,
  rows = 4,
  placeholder = "Mô tả nội dung... thêm hashtag như #caphe #huongdan",
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  const tags = [...new Set([...value.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1].toLowerCase()))];
  return (
    <div>
      <textarea className={inputClass} rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      <div className="mt-1.5 min-h-5">
        {tags.length ? <TagList tags={tags} /> : <span className="text-xs text-zinc-400">Hashtag trong mô tả sẽ thành tag để lọc và để AI chọn ảnh.</span>}
      </div>
    </div>
  );
}

/** Ô lựa chọn dạng thẻ (một trong nhiều). */
export function Choice({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        "rounded-xl p-3 text-left ring-1 transition-colors",
        active ? "bg-brand-50 ring-2 ring-brand-500" : "bg-surface ring-zinc-200 hover:ring-zinc-300",
      )}
    >
      <p className={cx("text-sm font-medium", active ? "text-brand-700" : "text-zinc-800")}>{title}</p>
      {children && <div className="mt-0.5 text-xs text-zinc-500">{children}</div>}
    </button>
  );
}

/** Công tắc bật/tắt kèm nhãn và mô tả. */
export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx("relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors", checked ? "bg-brand-500" : "bg-zinc-300")}
      >
        <span className={cx("absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left]", checked ? "left-4.5" : "left-0.5")} />
      </button>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-zinc-800">{label}</span>
        {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
      </span>
    </label>
  );
}

/** Nhóm nút chọn một giá trị (vd nhịp dựng Chậm / Vừa / Nhanh). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; hint?: string }[];
}) {
  return (
    <div role="radiogroup" className="grid gap-1 rounded-xl bg-zinc-100 p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded-lg px-2 py-1.5 text-center transition-colors",
            value === o.value ? "bg-surface shadow-sm ring-1 ring-zinc-200" : "hover:bg-zinc-50",
          )}
        >
          <span className={cx("block text-sm font-medium", value === o.value ? "text-brand-700" : "text-zinc-700")}>{o.label}</span>
          {o.hint && <span className="block truncate text-[11px] text-zinc-500">{o.hint}</span>}
        </button>
      ))}
    </div>
  );
}

/** Chủ đề/prompt đầy đủ của job hoặc video; prompt dài được thu gọn, bấm để xem hết. */
export function TopicView({ topic }: { topic: string }) {
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
