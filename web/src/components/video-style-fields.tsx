"use client";

import { useEffect, useRef, useState } from "react";
import { useApi } from "@/lib/client";
import type { AssetItem, Page } from "@/lib/types";
import {
  ACCENTS,
  COLOR_FILTERS,
  LANGUAGES,
  MAX_CTA_CHARS,
  MULTILINGUAL_VOICES,
  PACINGS,
  PITCHES,
  RATES,
  SUBTITLE_STYLES,
  TRANSITIONS,
  VOICE_MOODS,
  languageOf,
  voiceLabel,
  type ColorFilter,
  type Pacing,
  type SubtitleStyle,
  type TransitionKind,
  type VideoStyle,
  type VoiceSettings,
} from "@/lib/video-options";
import { AssetThumb } from "./assets-library";
import { Button, Field, Segmented, Spinner, Toggle, cx, inputClass } from "./ui";

function VoiceOptions({ language, current }: { language: string; current?: string }) {
  const lang = languageOf(language);
  const known = (v?: string) => !v || [...lang.voices, ...MULTILINGUAL_VOICES].some((x) => x.value === v);
  return (
    <>
      {!known(current) && <option value={current}>{voiceLabel(current)}</option>}
      <optgroup label={`Giọng ${lang.label}`}>
        {lang.voices.map((v) => (
          <option key={v.value} value={v.value}>
            {v.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="Giọng đa ngôn ngữ (đọc được mọi ngôn ngữ)">
        {MULTILINGUAL_VOICES.map((v) => (
          <option key={v.value} value={v.value}>
            {v.label}
          </option>
        ))}
      </optgroup>
    </>
  );
}

/** Nút nghe thử: engine đọc một câu mẫu bằng giọng, tốc độ, cao độ đang chọn. */
function VoicePreview({ voice, rate, pitch, language }: { voice: string; rate: string; pitch: string; language: string }) {
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);

  const play = async () => {
    if (state === "playing") {
      audio.current?.pause();
      setState("idle");
      return;
    }
    setState("loading");
    setError(null);
    try {
      const res = await fetch(`/api/voices/preview?${new URLSearchParams({ voice, rate, pitch, language })}`);
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error || `Lỗi ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      audio.current?.pause();
      const el = new Audio(url);
      audio.current = el;
      el.onended = () => {
        setState("idle");
        URL.revokeObjectURL(url);
      };
      await el.play();
      setState("playing");
    } catch (e) {
      setError((e as Error).message);
      setState("idle");
    }
  };

  return (
    <div className="space-y-1">
      <Button size="sm" onClick={play} className="w-full sm:w-auto">
        {state === "loading" ? <Spinner className="size-3.5" /> : state === "playing" ? "■" : "▶"}
        {state === "playing" ? "Dừng" : "Nghe thử"}
      </Button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

/** Ngôn ngữ, giọng chính, giọng thứ hai (xen kẽ), sắc thái, tốc độ, cao độ. */
export function VoiceFields({
  value,
  onChange,
  lockLanguage,
}: {
  value: VoiceSettings;
  onChange: (next: VoiceSettings) => void;
  /** sửa kịch bản có sẵn: không đổi ngôn ngữ (kịch bản đã viết bằng ngôn ngữ đó) */
  lockLanguage?: boolean;
}) {
  const set = (patch: Partial<VoiceSettings>) => onChange({ ...value, ...patch });
  const mood = VOICE_MOODS.find((m) => m.rate === value.rate && m.pitch === value.pitch);
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Ngôn ngữ" hint={lockLanguage ? "Theo kịch bản đã viết." : "AI viết kịch bản và nhãn trong video bằng ngôn ngữ này."}>
          <select
            className={inputClass}
            value={value.language}
            disabled={lockLanguage}
            onChange={(e) => {
              const lang = languageOf(e.target.value);
              // Giọng đa ngôn ngữ đọc được mọi ngôn ngữ: giữ nguyên; giọng bản địa thì đổi theo ngôn ngữ
              const keep = (v: string) => MULTILINGUAL_VOICES.some((m) => m.value === v);
              set({
                language: lang.value,
                voice: keep(value.voice) ? value.voice : lang.voices[0].value,
                voice2: value.voice2 && keep(value.voice2) ? value.voice2 : "",
              });
            }}
          >
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Giọng đọc">
          <div className="flex gap-2">
            <select className={inputClass} value={value.voice} onChange={(e) => set({ voice: e.target.value })}>
              <VoiceOptions language={value.language} current={value.voice} />
            </select>
            <VoicePreview voice={value.voice} rate={value.rate} pitch={value.pitch} language={value.language} />
          </div>
        </Field>
        <Field label="Giọng thứ hai (đọc xen kẽ)" hint="Các bước chẵn dùng giọng này, như hai người dẫn.">
          <div className="flex gap-2">
            <select className={inputClass} value={value.voice2} onChange={(e) => set({ voice2: e.target.value })}>
              <option value="">Không dùng</option>
              <VoiceOptions language={value.language} current={value.voice2} />
            </select>
            {value.voice2 && <VoicePreview voice={value.voice2} rate={value.rate} pitch={value.pitch} language={value.language} />}
          </div>
        </Field>
      </div>
      <div>
        <p className="mb-1.5 text-sm font-medium text-zinc-700">Sắc thái giọng</p>
        <div className="flex flex-wrap gap-1.5">
          {VOICE_MOODS.map((m) => (
            <button
              key={m.label}
              type="button"
              onClick={() => set({ rate: m.rate, pitch: m.pitch })}
              className={cx(
                "rounded-full px-3 py-1 text-sm ring-1 transition-colors",
                mood === m ? "bg-brand-50 font-medium text-brand-700 ring-brand-500" : "bg-surface text-zinc-600 ring-zinc-200 hover:ring-zinc-300",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Tốc độ đọc">
          <select className={inputClass} value={value.rate} onChange={(e) => set({ rate: e.target.value })}>
            {!RATES.some((r) => r.value === value.rate) && <option value={value.rate}>{value.rate}</option>}
            {RATES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Cao độ giọng">
          <select className={inputClass} value={value.pitch} onChange={(e) => set({ pitch: e.target.value })}>
            {!PITCHES.some((p) => p.value === value.pitch) && <option value={value.pitch}>{value.pitch}</option>}
            {PITCHES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label} ({p.value})
              </option>
            ))}
          </select>
        </Field>
      </div>
    </div>
  );
}

/** Chọn ảnh trong Assets làm logo (góc trên phải video). */
function LogoPicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const { data } = useApi<Page<AssetItem>>("/api/assets?kind=image&limit=300");
  const current = data?.items.find((a) => a.id === value);
  return (
    <div className="flex items-center gap-3">
      <div className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-zinc-100 ring-1 ring-zinc-200">
        {current ? <AssetThumb asset={current} className="size-full" /> : <span className="text-[10px] text-zinc-400">Logo</span>}
      </div>
      <select className={inputClass} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Không có logo</option>
        {value && data && !current && <option value={value}>(Ảnh đã bị xóa — chọn lại)</option>}
        {data?.items.map((a) => (
          <option key={a.id} value={a.id}>
            {a.title || a.id}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Nhịp dựng, chuyển cảnh, phụ đề, màu, màu chủ đạo, thanh tiến độ, âm thanh hiệu ứng, logo, lời kêu gọi. */
export function StyleFields({ value, onChange }: { value: VideoStyle; onChange: (next: VideoStyle) => void }) {
  const set = (patch: Partial<VideoStyle>) => onChange({ ...value, ...patch });
  const customAccent = !ACCENTS.some((a) => a.value === value.accent);
  return (
    <div className="space-y-5">
      <div>
        <p className="mb-1.5 text-sm font-medium text-zinc-700">Nhịp dựng</p>
        <Segmented<Pacing>
          value={value.pacing}
          onChange={(pacing) => set({ pacing })}
          options={(Object.keys(PACINGS) as Pacing[]).map((k) => ({ value: k, label: PACINGS[k].label, hint: PACINGS[k].hint }))}
        />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Chuyển cảnh">
          <select className={inputClass} value={value.transition} onChange={(e) => set({ transition: e.target.value as TransitionKind })}>
            {(Object.keys(TRANSITIONS) as TransitionKind[]).map((k) => (
              <option key={k} value={k}>
                {TRANSITIONS[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Phụ đề" hint="Phụ đề khớp từng từ với giọng đọc.">
          <select className={inputClass} value={value.subtitleStyle} onChange={(e) => set({ subtitleStyle: e.target.value as SubtitleStyle })}>
            {(Object.keys(SUBTITLE_STYLES) as SubtitleStyle[]).map((k) => (
              <option key={k} value={k}>
                {SUBTITLE_STYLES[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Màu phim">
          <select className={inputClass} value={value.colorFilter} onChange={(e) => set({ colorFilter: e.target.value as ColorFilter })}>
            {(Object.keys(COLOR_FILTERS) as ColorFilter[]).map((k) => (
              <option key={k} value={k}>
                {COLOR_FILTERS[k]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div>
        <p className="mb-1.5 text-sm font-medium text-zinc-700">Màu chủ đạo</p>
        <p className="mb-2 text-xs text-zinc-500">Dùng cho nhãn bước, chữ đang đọc (karaoke), thanh tiến độ và nút kêu gọi.</p>
        <div className="flex flex-wrap items-center gap-2">
          {ACCENTS.map((a) => (
            <button
              key={a.value}
              type="button"
              title={a.label}
              aria-label={a.label}
              aria-pressed={value.accent === a.value}
              onClick={() => set({ accent: a.value })}
              className={cx(
                "size-8 rounded-full ring-offset-2 ring-offset-[var(--surface)] transition-shadow",
                value.accent === a.value ? "ring-2 ring-zinc-900" : "ring-1 ring-black/10 hover:ring-2 hover:ring-zinc-300",
              )}
              style={{ background: a.value }}
            />
          ))}
          <label
            title="Màu khác"
            className={cx(
              "relative grid size-8 cursor-pointer place-items-center overflow-hidden rounded-full text-xs ring-offset-2 ring-offset-[var(--surface)]",
              customAccent ? "ring-2 ring-zinc-900" : "ring-1 ring-zinc-300",
            )}
            style={{ background: customAccent ? value.accent : "conic-gradient(red, yellow, lime, aqua, blue, magenta, red)" }}
          >
            <input type="color" value={value.accent} onChange={(e) => set({ accent: e.target.value })} className="absolute inset-0 cursor-pointer opacity-0" />
          </label>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Toggle checked={value.progressBar} onChange={(progressBar) => set({ progressBar })} label="Thanh tiến độ" hint="Vạch màu chạy ở mép trên, giữ chân người xem." />
        <Toggle checked={value.sfx} onChange={(sfx) => set({ sfx })} label="Hiệu ứng âm thanh" hint="Tiếng “vút” khi chuyển cảnh, “tách” khi hiện nhãn bước." />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Logo / thương hiệu" hint="Ảnh trong Assets (nên là PNG nền trong suốt), đặt ở góc trên phải.">
          <LogoPicker value={value.logoId} onChange={(logoId) => set({ logoId })} />
        </Field>
        <Field
          label="Lời kêu gọi cuối video"
          hint={
            <span className="flex justify-between gap-2">
              <span>Hiện nổi bật ở cảnh cuối, vd số điện thoại, ưu đãi.</span>
              <span className="tabular-nums">
                {value.cta.length}/{MAX_CTA_CHARS}
              </span>
            </span>
          }
        >
          <input
            className={inputClass}
            maxLength={MAX_CTA_CHARS}
            value={value.cta}
            onChange={(e) => set({ cta: e.target.value })}
            placeholder="VD: Gọi ngay 0909 123 456 · Theo dõi để xem thêm!"
          />
        </Field>
      </div>
    </div>
  );
}
