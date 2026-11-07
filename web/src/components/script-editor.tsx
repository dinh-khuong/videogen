"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { api, useApi } from "@/lib/client";
import type { AssetItem, JobDetail, JobInput, JobItem, Page, Script, ScriptStep } from "@/lib/types";
import { DEFAULT_VOICE, LEGACY_STYLE, VIDEO_TYPES, languageOf, type VideoType, type VoiceSettings } from "@/lib/video-options";
import { AssetPicker, AssetThumb, MusicPicker } from "./assets-library";
import { Button, ErrorBox, Field, Loading, Modal, inputClass } from "./ui";
import { StyleFields, VoiceFields } from "./video-style-fields";

type Defaults = Pick<JobInput, "aspect" | "contactId" | "sourceVideoId" | "musicId" | "musicVolume">;

/**
 * Sửa kịch bản của video rồi tạo lại (không gọi LLM; ảnh/video từng bước lấy từ Assets).
 * Giọng đọc và phong cách lấy từ job đã tạo video (nếu còn) và đổi được trước khi tạo lại.
 */
export function ScriptEditor({ jobId, ...props }: { initial: Script; defaults: Defaults; jobId?: string | null; onCancel: () => void }) {
  const job = useApi<JobDetail>(jobId ? `/api/jobs/${jobId}` : null);
  if (jobId && !job.data && !job.error) return <Loading />;
  return <ScriptEditorForm {...props} source={job.data?.input ?? null} />;
}

function ScriptEditorForm({
  initial,
  defaults,
  source,
  onCancel,
}: {
  initial: Script;
  defaults: Defaults;
  source: JobInput | null;
  onCancel: () => void;
}) {
  const router = useRouter();
  // Phần giọng AI đã chỉnh được gộp vào thanh trượt bên dưới (kịch bản gửi lại không còn voice_tuning):
  // người dùng nghe thử và tạo lại đúng mức đang thấy, không bị cộng thêm lần nữa
  const tuning = initial.voice_tuning ?? null;
  const [script, setScript] = useState<Script>(() => ({ ...structuredClone(initial), voice_tuning: null }));
  const [aspect, setAspect] = useState(defaults.aspect);
  const [voice, setVoice] = useState<VoiceSettings>(() => {
    const lang = languageOf(source?.language);
    const base: VoiceSettings = source
      ? {
          language: lang.value,
          voice: source.voice || lang.voices[0].value,
          voice2: source.voice2 || "",
          rate: source.rate || "+0%",
          pitch: source.pitch || "+0Hz",
          effect: source.voiceEffect ?? "none",
          aiTune: false,
          cast: source.voiceCast ?? null,
          steady: source.voiceSteady === true,
        }
      : { ...DEFAULT_VOICE, aiTune: false };
    return tuning ? { ...base, rate: tuning.final_rate || base.rate, pitch: tuning.final_pitch || base.pitch } : base;
  });
  const [style, setStyle] = useState(() => source?.style ?? LEGACY_STYLE);
  const [videoType, setVideoType] = useState<VideoType>(source?.videoType ?? "howto");
  const [picking, setPicking] = useState<number | null>(null);
  const [music, setMusic] = useState({ musicId: defaults.musicId ?? "", volume: defaults.musicVolume ?? 0.12 });
  const [busy, setBusy] = useState(false);
  // Next giữ trang cũ ẩn (cacheComponents) nên phải tự tắt busy; transition giữ spinner tới khi chuyển trang xong
  const [navigating, startNavigation] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const ids = [...new Set(script.steps.map((s) => s.library_image).filter(Boolean))] as string[];
  const assets = useApi<Page<AssetItem>>(ids.length ? `/api/assets?ids=${ids.join(",")}&limit=${ids.length}` : null);
  const assetOf = (id?: string | null) => assets.data?.items.find((a) => a.id === id);

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
          language: voice.language,
          voice: voice.voice,
          voice2: voice.cast ? null : voice.voice2 || null,
          voiceCast: voice.cast,
          voiceSteady: voice.steady,
          rate: voice.rate,
          pitch: voice.pitch,
          voiceEffect: voice.effect,
          videoType,
          style,
          // Dựng lại bằng đúng engine của video gốc
          renderer: source?.renderer ?? "classic",
          contactId: defaults.contactId ?? null,
          sourceVideoId: defaults.sourceVideoId ?? null,
          musicId: music.musicId || null,
          musicVolume: music.volume,
        } satisfies Partial<JobInput>,
      });
      startNavigation(() => {
        setBusy(false);
        router.push(`/jobs/${job.id}`);
      });
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
                {assetOf(step.library_image) ? (
                  <AssetThumb asset={assetOf(step.library_image)!} className="size-full" />
                ) : (
                  <span className="px-2">Tự tìm ảnh trên mạng</span>
                )}
                {!!step.extra_assets?.length && (
                  <span className="absolute right-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
                    +{step.extra_assets.length} clip
                  </span>
                )}
                <span className="absolute inset-x-0 bottom-0 bg-black/55 py-0.5 text-[11px] text-white">Đổi asset</span>
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
      <div>
        <p className="mb-1.5 text-sm font-medium text-zinc-700">Nhạc nền</p>
        <MusicPicker musicId={music.musicId} volume={music.volume} onChange={setMusic} />
      </div>
      <details className="group rounded-xl bg-zinc-50 p-3 ring-1 ring-zinc-200">
        <summary className="cursor-pointer text-sm font-medium text-zinc-800">
          Giọng đọc & hiệu ứng <span className="font-normal text-zinc-500">— đổi giọng, chuyển cảnh, phụ đề, màu... rồi tạo lại</span>
        </summary>
        <div className="mt-4 space-y-6">
          <Field label="Kiểu nhãn">
            <select className={`${inputClass} max-w-xs`} value={videoType} onChange={(e) => setVideoType(e.target.value as VideoType)}>
              {(Object.keys(VIDEO_TYPES) as VideoType[]).map((k) => (
                <option key={k} value={k}>
                  {VIDEO_TYPES[k].label}
                </option>
              ))}
            </select>
          </Field>
          <VoiceFields
            value={voice}
            onChange={setVoice}
            lockLanguage={!!source}
            note={
              tuning?.final_pitch
                ? `Đang ở mức AI đã chỉnh cho video này (cao độ ${tuning.base_pitch} → ${tuning.final_pitch}, tốc độ ${tuning.base_rate} → ${tuning.final_rate}${tuning.reason ? ` — ${tuning.reason}` : ""}). Chỉnh tiếp tùy ý: video tạo lại dùng đúng mức bạn nghe thử.`
                : undefined
            }
          />
          <StyleFields value={style} onChange={setStyle} />
        </div>
      </details>
      <ErrorBox message={error} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Hủy
        </Button>
        <Button variant="primary" busy={busy || navigating} onClick={submit}>
          Tạo lại video
        </Button>
      </div>

      <Modal open={picking !== null} onClose={() => setPicking(null)} title={`Chọn ảnh/video cho bước ${(picking ?? 0) + 1}`} wide>
        <div className="mb-3 flex justify-end">
          <Button
            size="sm"
            onClick={() => {
              if (picking !== null) setStep(picking, { library_image: null, extra_assets: [] });
              setPicking(null);
            }}
          >
            Không dùng asset (tự tìm ảnh trên mạng)
          </Button>
        </div>
        <AssetPicker
          single
          selected={picking !== null && script.steps[picking]?.library_image ? [script.steps[picking].library_image!] : []}
          onChange={([id]) => {
            if (picking !== null) setStep(picking, { library_image: id, extra_assets: [] });
            setPicking(null);
          }}
        />
      </Modal>
    </div>
  );
}
