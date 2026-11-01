"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, useApi } from "@/lib/client";
import type { ImageItem, JobInput, JobItem, Page, Script, ScriptStep } from "@/lib/types";
import { ImagePicker } from "./images-library";
import { Button, ErrorBox, Field, Modal, inputClass } from "./ui";

/** Sửa kịch bản của video rồi tạo lại (không gọi LLM; ảnh theo từng bước lấy từ thư viện). */
export function ScriptEditor({
  initial,
  defaults,
  onCancel,
}: {
  initial: Script;
  defaults: Pick<JobInput, "aspect" | "contactId" | "sourceVideoId">;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [script, setScript] = useState<Script>(() => structuredClone(initial));
  const [aspect, setAspect] = useState(defaults.aspect);
  const [picking, setPicking] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ids = [...new Set(script.steps.map((s) => s.library_image).filter(Boolean))] as string[];
  const thumbs = useApi<Page<ImageItem>>(ids.length ? `/api/images?ids=${ids.join(",")}&limit=${ids.length}` : null);
  const thumbOf = (id?: string | null) => thumbs.data?.items.find((i) => i.id === id)?.thumbUrl;

  const setStep = (i: number, patch: Partial<ScriptStep>) =>
    setScript((s) => ({ ...s, steps: s.steps.map((st, k) => (k === i ? { ...st, ...patch } : st)) }));
  const moveStep = (i: number, dir: -1 | 1) =>
    setScript((s) => {
      const steps = [...s.steps];
      const j = i + dir;
      if (j < 0 || j >= steps.length) return s;
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...s, steps };
    });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const job = await api<JobItem>("/api/jobs", {
        method: "POST",
        json: {
          topic: script.title,
          script,
          aspect,
          layout: "normal",
          imageStyle: "auto",
          webImages: true,
          libraryMode: "off",
          contactId: defaults.contactId ?? null,
          sourceVideoId: defaults.sourceVideoId ?? null,
        } satisfies Partial<JobInput>,
      });
      router.push(`/jobs/${job.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <Field label="Tiêu đề">
          <input className={inputClass} value={script.title} onChange={(e) => setScript({ ...script, title: e.target.value })} />
        </Field>
        <Field label="Khung hình">
          <select className={inputClass} value={aspect} onChange={(e) => setAspect(e.target.value as JobInput["aspect"])}>
            <option value="16:9">16:9 ngang</option>
            <option value="9:16">9:16 dọc</option>
            <option value="1:1">1:1 vuông</option>
          </select>
        </Field>
      </div>
      <Field label="Lời mở đầu">
        <textarea className={inputClass} rows={2} value={script.intro} onChange={(e) => setScript({ ...script, intro: e.target.value })} />
      </Field>
      <div className="space-y-3">
        {script.steps.map((step, i) => (
          <div key={i} className="rounded-xl bg-zinc-50 p-3 ring-1 ring-zinc-200">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="rounded-md bg-brand-500 px-2 py-0.5 text-xs font-semibold text-white">Bước {i + 1}</span>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => moveStep(i, -1)} disabled={i === 0} aria-label="Lên">
                  ↑
                </Button>
                <Button size="sm" variant="ghost" onClick={() => moveStep(i, 1)} disabled={i === script.steps.length - 1} aria-label="Xuống">
                  ↓
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={script.steps.length <= 1}
                  onClick={() => setScript((s) => ({ ...s, steps: s.steps.filter((_, k) => k !== i) }))}
                >
                  Xóa
                </Button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-[120px_1fr]">
              <button
                type="button"
                onClick={() => setPicking(i)}
                className="relative aspect-[4/3] overflow-hidden rounded-lg bg-zinc-200 text-xs text-zinc-500 ring-1 ring-zinc-300 hover:ring-brand-500"
              >
                {thumbOf(step.library_image) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={thumbOf(step.library_image)} alt="" className="size-full object-cover" />
                ) : (
                  <span className="px-2">Tự tìm ảnh trên mạng</span>
                )}
                <span className="absolute inset-x-0 bottom-0 bg-black/55 py-0.5 text-[11px] text-white">Đổi ảnh</span>
              </button>
              <div className="space-y-2">
                <input className={inputClass} placeholder="Tên bước" value={step.heading} onChange={(e) => setStep(i, { heading: e.target.value })} />
                <textarea className={inputClass} rows={3} placeholder="Lời bình" value={step.narration} onChange={(e) => setStep(i, { narration: e.target.value })} />
                <input
                  className={inputClass}
                  placeholder="Từ khóa tìm ảnh tiếng Anh, cách nhau bằng dấu phẩy"
                  value={step.image_queries.join(", ")}
                  onChange={(e) => setStep(i, { image_queries: e.target.value.split(",").map((q) => q.trim()).filter(Boolean) })}
                />
              </div>
            </div>
          </div>
        ))}
        <Button
          size="sm"
          onClick={() =>
            setScript((s) => ({ ...s, steps: [...s.steps, { heading: "", narration: "", image_queries: [], library_image: null }] }))
          }
        >
          + Thêm bước
        </Button>
      </div>
      <Field label="Lời kết">
        <textarea className={inputClass} rows={2} value={script.outro} onChange={(e) => setScript({ ...script, outro: e.target.value })} />
      </Field>
      <ErrorBox message={error} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Hủy
        </Button>
        <Button variant="primary" busy={busy} onClick={submit}>
          Tạo lại video
        </Button>
      </div>

      <Modal open={picking !== null} onClose={() => setPicking(null)} title={`Chọn ảnh cho bước ${(picking ?? 0) + 1}`} wide>
        <div className="mb-3 flex justify-end">
          <Button
            size="sm"
            onClick={() => {
              if (picking !== null) setStep(picking, { library_image: null });
              setPicking(null);
            }}
          >
            Không dùng ảnh thư viện (tự tìm trên mạng)
          </Button>
        </div>
        <ImagePicker
          single
          selected={picking !== null && script.steps[picking]?.library_image ? [script.steps[picking].library_image!] : []}
          onChange={([id]) => {
            if (picking !== null) setStep(picking, { library_image: id });
            setPicking(null);
          }}
        />
      </Modal>
    </div>
  );
}
