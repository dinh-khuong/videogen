"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useApi } from "@/lib/client";
import type { AssetItem, EngineHealth, Page } from "@/lib/types";
import {
  ACCENTS,
  AI_TUNE_PITCH_LIMIT,
  AI_TUNE_RATE_LIMIT,
  COLOR_FILTERS,
  FPT_VOICES,
  LANGUAGES,
  MAX_CTA_CHARS,
  MULTILINGUAL_VOICES,
  PACINGS,
  PITCH_MAX,
  PITCH_MIN,
  RATES,
  SUBTITLE_STYLES,
  TRANSITIONS,
  VOICE_EFFECTS,
  VOICE_MOODS,
  VOICE_PERSONAS,
  gttsMaleVoice,
  gttsVoice,
  hzValue,
  languageOf,
  pitchHz,
  pitchLabel,
  voiceLabel,
  type ColorFilter,
  type Pacing,
  type SubtitleStyle,
  type TransitionKind,
  type VideoStyle,
  type VoiceEffect,
  type VoiceSettings,
} from "@/lib/video-options";
import { PAUSE_MEDIA_EVENT, pauseOtherMedia } from "./media-guard";
import { AssetThumb } from "./assets-library";
import { Button, Field, Segmented, Spinner, Toggle, cx, inputClass } from "./ui";

function VoiceOptions({ language, current, fpt }: { language: string; current?: string; fpt: boolean }) {
  const lang = languageOf(language);
  const google = [gttsVoice(lang.value), gttsMaleVoice(lang.value)];
  const vietnamese = lang.value === LANGUAGES[0].value;
  const all = [...lang.voices, ...google, ...MULTILINGUAL_VOICES, ...(vietnamese ? FPT_VOICES : [])];
  const known = (v?: string) => !v || all.some((x) => x.value === v);
  return (
    <>
      {!known(current) && <option value={current}>{voiceLabel(current)}</option>}
      <optgroup label={`Giọng ${lang.label}`}>
        {lang.voices.map((v) => (
          <option key={v.value} value={v.value}>
            {v.label}
          </option>
        ))}
        {google.map((v) => (
          <option key={v.value} value={v.value}>
            {v.label}
          </option>
        ))}
      </optgroup>
      {vietnamese && (
        <optgroup label={fpt ? "FPT.AI — giọng Việt tự nhiên" : "FPT.AI — cần FPT_AI_API_KEY trong engine/.env"}>
          {FPT_VOICES.map((v) => (
            <option key={v.value} value={v.value}>
              {v.label}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="Giọng đa ngôn ngữ (đọc tiếng Việt kiểu Tây, ngọng ngọng)">
        {MULTILINGUAL_VOICES.map((v) => (
          <option key={v.value} value={v.value}>
            {v.label}
          </option>
        ))}
      </optgroup>
    </>
  );
}

/** Những gì quyết định âm thanh của bản nghe thử — cùng các tham số engine dùng khi dựng video. */
export type PreviewParams = { voice: string; rate: string; pitch: string; language: string; effect: VoiceEffect };

const previewKey = (p: PreviewParams) => [p.voice, p.rate, p.pitch, p.language, p.effect].join("|");

/** Bản nghe thử còn đúng với cài đặt đang chọn không (đổi cao độ/tốc độ/hiệu ứng... là bản cũ không còn đúng). */
function previewMatches(p: PreviewParams, v: VoiceSettings): boolean {
  return (
    (p.voice === v.voice || (!!v.voice2 && p.voice === v.voice2)) &&
    p.rate === v.rate &&
    p.pitch === v.pitch &&
    p.language === v.language &&
    p.effect === v.effect
  );
}

export function previewParams(voice: string, v: Pick<VoiceSettings, "rate" | "pitch" | "language" | "effect">): PreviewParams {
  return { voice, rate: v.rate, pitch: v.pitch, language: v.language, effect: v.effect };
}

/** Mô tả những gì đang phát, để người dùng thấy rõ bản nghe thử là mức nào. */
function describePreview(p: PreviewParams): string {
  const parts = [voiceLabel(p.voice).split(" (")[0], `cao độ ${p.pitch}`, `tốc độ ${p.rate}`];
  if (p.effect !== "none") parts.push(VOICE_EFFECTS[p.effect].split(" (")[0].toLowerCase());
  return parts.join(" · ");
}

type PreviewState = { status: "idle" | "loading" | "playing"; params: PreviewParams | null; error: string | null };
const IDLE: PreviewState = { status: "idle", params: null, error: null };

/**
 * Bộ phát nghe thử dùng chung (mỗi lúc chỉ phát một mẫu). Mẫu do engine tạo bằng đúng giọng, tốc độ, cao độ,
 * hiệu ứng đang chọn qua cùng đường xử lý với video. Yêu cầu cũ bị hủy khi có yêu cầu mới, nên âm thanh phát ra
 * luôn là của lần chỉnh sau cùng.
 */
export function useVoicePreview() {
  const [state, setState] = useState<PreviewState>(IDLE);
  const audio = useRef<HTMLAudioElement | null>(null);
  const request = useRef<AbortController | null>(null);
  const seq = useRef(0);
  const urls = useRef(new Map<string, string>());

  const halt = useCallback(() => {
    seq.current++;
    request.current?.abort();
    request.current = null;
    audio.current?.pause();
    audio.current = null;
  }, []);

  useEffect(() => {
    const cache = urls.current;
    return () => {
      halt();
      cache.forEach((url) => URL.revokeObjectURL(url));
      cache.clear();
    };
  }, [halt]);

  // Giọng nghe thử không nằm trong DOM: dừng khi trang bị ẩn (thu nhỏ cửa sổ, chuyển tab/trang) hoặc nguồn khác phát
  useEffect(() => {
    const onPause = (e: Event) => {
      if (!audio.current && !request.current) return;
      if ((e as CustomEvent<HTMLMediaElement | null>).detail === audio.current && audio.current) return;
      halt();
      setState(IDLE);
    };
    window.addEventListener(PAUSE_MEDIA_EVENT, onPause);
    return () => window.removeEventListener(PAUSE_MEDIA_EVENT, onPause);
  }, [halt]);

  const stop = useCallback(() => {
    halt();
    setState(IDLE);
  }, [halt]);

  const play = useCallback(
    async (params: PreviewParams) => {
      halt();
      const id = seq.current;
      const key = previewKey(params);
      setState({ status: "loading", params, error: null });
      try {
        let url = urls.current.get(key);
        if (!url) {
          const ctrl = new AbortController();
          request.current = ctrl;
          const res = await fetch(`/api/voices/preview?${new URLSearchParams(params)}`, { signal: ctrl.signal });
          if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error || `Lỗi ${res.status}`);
          url = URL.createObjectURL(await res.blob());
          urls.current.set(key, url);
        }
        if (id !== seq.current) return; // đã có lần chỉnh mới hơn
        const el = new Audio(url);
        audio.current = el;
        pauseOtherMedia(el); // video/audio khác đang phát thì dừng lại
        el.onended = () => {
          if (audio.current !== el) return;
          audio.current = null;
          setState(IDLE);
        };
        await el.play();
        if (id !== seq.current) return el.pause();
        setState({ status: "playing", params, error: null });
      } catch (e) {
        if (id !== seq.current || (e as Error).name === "AbortError") return;
        setState({ status: "idle", params: null, error: (e as Error).message });
      }
    },
    [halt],
  );

  return { ...state, play, stop };
}

export type VoicePlayer = ReturnType<typeof useVoicePreview>;

/** Nút nghe thử một giọng với cài đặt cho trước. */
export function VoicePreview({
  player,
  params,
  onPlay,
  className,
}: {
  player: VoicePlayer;
  params: PreviewParams;
  onPlay?: () => void;
  className?: string;
}) {
  const mine = !!player.params && previewKey(player.params) === previewKey(params);
  const loading = mine && player.status === "loading";
  const playing = mine && player.status === "playing";
  return (
    <Button
      size="sm"
      onClick={() => {
        if (mine && player.status !== "idle") return player.stop();
        onPlay?.();
        void player.play(params);
      }}
      className={cx("w-full shrink-0 sm:w-auto", className)}
      title={`Nghe thử: ${describePreview(params)}`}
    >
      {loading ? <Spinner className="size-3.5" /> : playing ? "■" : "▶"}
      {playing ? "Dừng" : "Nghe thử"}
    </Button>
  );
}

/** Dòng trạng thái: đang tạo / đang phát mẫu nào, hoặc lỗi. */
export function PreviewStatus({ player }: { player: VoicePlayer }) {
  if (player.error) return <p className="text-xs text-red-600">{player.error}</p>;
  if (!player.params || player.status === "idle") return null;
  return (
    <p className="flex items-center gap-1.5 text-xs text-brand-700" aria-live="polite">
      {player.status === "loading" ? <Spinner className="size-3" /> : <span aria-hidden>🔊</span>}
      <span>
        {player.status === "loading" ? "Đang tạo giọng mẫu" : "Đang phát"}: <span className="font-medium">{describePreview(player.params)}</span>
      </span>
    </p>
  );
}

const PITCH_TICKS = [-12, -6, 0, 6, 12];

/** Thanh trượt cao độ; mỗi lần chỉnh xong (dừng kéo một chút) gọi onSettle để phát giọng mẫu đúng mức đó. */
function PitchSlider({ value, onChange, onSettle }: { value: string; onChange: (pitch: string) => void; onSettle: (pitch: string, delay: number) => void }) {
  const n = Math.min(Math.max(pitchHz(value), PITCH_MIN), PITCH_MAX);
  const pick = (hz: number, delay: number) => {
    const pitch = hzValue(hz);
    onChange(pitch);
    onSettle(pitch, delay);
  };
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-lg font-semibold tabular-nums text-zinc-900">{hzValue(n)}</span>
        <span className="text-sm text-zinc-500">{pitchLabel(n)}</span>
      </div>
      <input
        type="range"
        min={PITCH_MIN}
        max={PITCH_MAX}
        step={1}
        value={n}
        onChange={(e) => pick(Number(e.target.value), 450)}
        aria-label="Cao độ giọng"
        aria-valuetext={`${hzValue(n)}, ${pitchLabel(n)}`}
        className="w-full cursor-pointer accent-brand-500"
      />
      <div className="mt-1 flex justify-between text-[11px] text-zinc-500">
        <span>Trầm</span>
        <span>Cao</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {PITCH_TICKS.map((hz) => (
          <button
            key={hz}
            type="button"
            onClick={() => pick(hz, 0)}
            aria-pressed={n === hz}
            className={cx(
              "rounded-md px-2 py-0.5 text-xs ring-1 tabular-nums transition-colors",
              n === hz ? "bg-brand-50 font-medium text-brand-700 ring-brand-500" : "bg-surface text-zinc-600 ring-zinc-200 hover:ring-zinc-300",
            )}
          >
            {pitchLabel(hz)} ({hzValue(hz)})
          </button>
        ))}
      </div>
    </div>
  );
}

function Chip({ active, onClick, title, hint }: { active: boolean; onClick: () => void; title: string; hint?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={hint}
      className={cx(
        "rounded-full px-3 py-1 text-sm ring-1 transition-colors",
        active ? "bg-brand-50 font-medium text-brand-700 ring-brand-500" : "bg-surface text-zinc-600 ring-zinc-200 hover:ring-zinc-300",
      )}
    >
      {title}
    </button>
  );
}

/** Ngôn ngữ, giọng chính, giọng thứ hai (xen kẽ), giọng kiểu kênh, sắc thái, tốc độ, cao độ, hiệu ứng, quyền chỉnh của AI. */
export function VoiceFields({
  value,
  onChange,
  lockLanguage,
  allowAiTune,
  note,
}: {
  value: VoiceSettings;
  onChange: (next: VoiceSettings) => void;
  /** sửa kịch bản có sẵn: không đổi ngôn ngữ (kịch bản đã viết bằng ngôn ngữ đó) */
  lockLanguage?: boolean;
  /** hiện công tắc "Cho AI tinh chỉnh giọng" (chỉ khi AI viết kịch bản) */
  allowAiTune?: boolean;
  /** ghi chú thêm dưới phần cao độ */
  note?: ReactNode;
}) {
  const health = useApi<EngineHealth>("/api/health");
  const fpt = !!health.data?.fpt_tts;
  const player = useVoicePreview();
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastVoice = useRef<string | null>(null);
  useEffect(() => () => clearTimeout(settle.current ?? undefined), []);

  const set = (patch: Partial<VoiceSettings>) => {
    const next = { ...value, ...patch };
    // Mẫu đang phát/đang tạo không còn khớp cài đặt mới: dừng để không nghe nhầm mức cũ
    if (player.params && player.status !== "idle" && !previewMatches(player.params, next)) player.stop();
    onChange(next);
    return next;
  };
  /** Bấm "Nghe thử" một giọng: nhớ giọng đó để lần chỉnh cao độ sau tự phát đúng giọng ấy. */
  const rememberVoice = (voice: string) => {
    lastVoice.current = voice;
    clearTimeout(settle.current ?? undefined);
  };
  /** Chỉnh cao độ xong: tự phát mẫu của giọng vừa nghe gần nhất (mặc định giọng chính) với đúng mức mới. */
  const autoPreview = (next: VoiceSettings, delay: number) => {
    clearTimeout(settle.current ?? undefined);
    const voice = lastVoice.current && (lastVoice.current === next.voice || lastVoice.current === next.voice2) ? lastVoice.current : next.voice;
    settle.current = setTimeout(() => void player.play(previewParams(voice, next)), delay);
  };

  const mood = VOICE_MOODS.find((m) => m.rate === value.rate && m.pitch === value.pitch);
  const vietnamese = value.language === LANGUAGES[0].value;
  const isPersona = (p: (typeof VOICE_PERSONAS)[number]) =>
    (Object.keys(p.voice) as (keyof typeof p.voice)[]).every((k) => value[k] === p.voice[k]);
  return (
    <div className="space-y-4">
      {vietnamese && (
        <div>
          <p className="mb-1.5 text-sm font-medium text-zinc-700">Giọng kiểu kênh quen thuộc</p>
          <div className="flex flex-wrap gap-1.5">
            {VOICE_PERSONAS.map((p) => (
              <Chip key={p.label} active={isPersona(p)} onClick={() => set(p.voice)} title={p.label} hint={p.hint} />
            ))}
          </div>
          <p className="mt-1.5 text-xs text-zinc-500">Bấm một kiểu rồi “Nghe thử”; có thể chỉnh tiếp giọng, tốc độ, hiệu ứng bên dưới.</p>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Ngôn ngữ" hint={lockLanguage ? "Theo kịch bản đã viết." : "AI viết kịch bản và nhãn trong video bằng ngôn ngữ này."}>
          <select
            className={inputClass}
            value={value.language}
            disabled={lockLanguage}
            onChange={(e) => {
              const lang = languageOf(e.target.value);
              // Giọng đa ngôn ngữ đọc được mọi ngôn ngữ: giữ nguyên; giọng khác thì đổi theo ngôn ngữ
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
              <VoiceOptions language={value.language} current={value.voice} fpt={fpt} />
            </select>
            <VoicePreview player={player} params={previewParams(value.voice, value)} onPlay={() => rememberVoice(value.voice)} />
          </div>
        </Field>
        <Field label="Giọng thứ hai (đọc xen kẽ)" hint="Các bước chẵn dùng giọng này, như hai người dẫn.">
          <div className="flex gap-2">
            <select className={inputClass} value={value.voice2} onChange={(e) => set({ voice2: e.target.value })}>
              <option value="">Không dùng</option>
              <VoiceOptions language={value.language} current={value.voice2} fpt={fpt} />
            </select>
            {value.voice2 && (
              <VoicePreview player={player} params={previewParams(value.voice2, value)} onPlay={() => rememberVoice(value.voice2)} />
            )}
          </div>
        </Field>
      </div>
      <div>
        <p className="mb-1.5 text-sm font-medium text-zinc-700">Sắc thái giọng</p>
        <div className="flex flex-wrap gap-1.5">
          {VOICE_MOODS.map((m) => (
            <Chip
              key={m.label}
              active={mood === m}
              onClick={() => {
                const next = set({ rate: m.rate, pitch: m.pitch });
                autoPreview(next, 0);
              }}
              title={m.label}
            />
          ))}
        </div>
      </div>
      <div className="rounded-xl bg-zinc-50 p-3 ring-1 ring-zinc-200">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-sm font-medium text-zinc-700">Cao độ giọng</p>
          <p className="text-xs text-zinc-500">Kéo thanh trượt, dừng tay là tự phát giọng mẫu đúng mức vừa chỉnh.</p>
        </div>
        <PitchSlider value={value.pitch} onChange={(pitch) => set({ pitch })} onSettle={(pitch, delay) => autoPreview({ ...value, pitch }, delay)} />
        <div className="mt-2 min-h-4">
          <PreviewStatus player={player} />
        </div>
        {note && <div className="mt-1 text-xs text-zinc-500">{note}</div>}
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
        <Field label="Hiệu ứng giọng" hint="Áp dụng cho mọi giọng, phụ đề vẫn khớp.">
          <select className={inputClass} value={value.effect} onChange={(e) => set({ effect: e.target.value as VoiceEffect })}>
            {(Object.keys(VOICE_EFFECTS) as VoiceEffect[]).map((k) => (
              <option key={k} value={k}>
                {VOICE_EFFECTS[k]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {allowAiTune && (
        <Toggle
          checked={value.aiTune}
          onChange={(aiTune) => set({ aiTune })}
          label="Cho AI tinh chỉnh giọng cho hợp với video"
          hint={`AI được chỉnh thêm cao độ (±${AI_TUNE_PITCH_LIMIT}Hz) và tốc độ (±${AI_TUNE_RATE_LIMIT}%) quanh mức bạn chọn theo không khí video — vd chuyện ma trầm, chậm hơn; quảng cáo sáng, nhanh hơn. Mức AI chọn và lý do hiện ở trang video, nghe thử được.`}
        />
      )}
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
