"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { api, formatDuration, useApi } from "@/lib/client";
import type { AssetItem, Contact, JobDetail, JobInput, JobItem, Page, TagCount } from "@/lib/types";
import {
  DEFAULT_STYLE,
  DEFAULT_VOICE,
  LANGUAGES,
  LEGACY_STYLE,
  LENGTHS,
  MAX_TONE_CHARS,
  PRESETS,
  TONES,
  VIDEO_TYPES,
  VOICE_EFFECTS,
  VOICE_RE,
  languageOf,
  normalizeStyle,
  type Preset,
  type VideoLength,
  type VideoStyle,
  type VideoType,
  type VoiceSettings,
} from "@/lib/video-options";
import { AssetPicker, MusicPicker } from "./assets-library";
import { TagPicker } from "./library-filters";
import { Button, Card, Choice, ErrorBox, Field, Loading, PageHeader, Segmented, Toggle, cx, inputClass } from "./ui";
import { StyleFields, VoiceFields } from "./video-style-fields";

const LAYOUTS = [
  { aspect: "16:9", layout: "normal", label: "16:9 ngang", hint: "YouTube", box: "w-10 h-6" },
  { aspect: "9:16", layout: "normal", label: "9:16 dọc", hint: "TikTok, Shorts, Reels", box: "w-5 h-9" },
  { aspect: "1:1", layout: "normal", label: "1:1 vuông", hint: "Facebook, Instagram", box: "w-7 h-7" },
  { aspect: "9:16", layout: "split", label: "Shorts chia đôi", hint: "Nội dung trên, video nền dưới", box: "w-5 h-9" },
] as const;

const STORAGE_KEY = "videogen:create-settings";
const MAX_BATCH = 20;

type WebMedia = NonNullable<JobInput["webMedia"]>;

/** Cài đặt được nhớ cho lần tạo sau (không gồm chủ đề, khách hàng, asset đã chọn). */
type Settings = {
  director: boolean;
  voice: VoiceSettings;
  style: VideoStyle;
  videoType: VideoType;
  tone: string;
  length: VideoLength;
  numSteps: string;
  layoutIndex: number;
  bgVideoId: string;
  imageStyle: JobInput["imageStyle"];
  webImages: boolean;
  webMedia: WebMedia;
  clipsPerStep: number;
  libraryMode: JobInput["libraryMode"];
  libraryTags: string[];
  music: { musicId: string; volume: number };
};

type FormState = Settings & { topic: string; batch: boolean; assetIds: string[]; contactId: string };

const DEFAULTS: Settings = {
  // Đạo diễn AI cho video sinh động hơn hẳn (meme, giọng biến hóa, tự duyệt): mặc định bật
  director: true,
  voice: DEFAULT_VOICE,
  style: DEFAULT_STYLE,
  videoType: "howto",
  tone: "",
  length: "medium",
  numSteps: "",
  layoutIndex: 0,
  bgVideoId: "",
  imageStyle: "auto",
  webImages: true,
  // Clip quay thật làm video sinh động hơn ảnh tĩnh: mặc định ưu tiên clip
  webMedia: "video",
  clipsPerStep: 3,
  libraryMode: "auto",
  libraryTags: [],
  music: { musicId: "", volume: 0.12 },
};

/** Ghép cài đặt (lưu trong trình duyệt hoặc từ job cũ) vào mặc định, bỏ giá trị không hợp lệ. */
function sanitize(p: Partial<Settings>): Settings {
  const lang = languageOf(p.voice?.language);
  const voiceOk = (v: unknown): v is string => typeof v === "string" && VOICE_RE.test(v);
  const pick = <T,>(value: unknown, ok: (v: unknown) => boolean, fallback: T): T => (ok(value) ? (value as T) : fallback);
  return {
    director: typeof p.director === "boolean" ? p.director : DEFAULTS.director,
    voice: {
      language: lang.value,
      voice: voiceOk(p.voice?.voice) ? p.voice.voice : lang.voices[0].value,
      voice2: voiceOk(p.voice?.voice2) ? p.voice.voice2 : "",
      rate: pick(p.voice?.rate, (v) => typeof v === "string" && /^[+-]\d{1,3}%$/.test(v), DEFAULTS.voice.rate),
      pitch: pick(p.voice?.pitch, (v) => typeof v === "string" && /^[+-]\d{1,3}Hz$/.test(v), DEFAULTS.voice.pitch),
      effect: pick(p.voice?.effect, (v) => typeof v === "string" && Object.hasOwn(VOICE_EFFECTS, v), DEFAULTS.voice.effect),
      aiTune: typeof p.voice?.aiTune === "boolean" ? p.voice.aiTune : DEFAULTS.voice.aiTune,
    },
    style: p.style ? normalizeStyle(p.style) : DEFAULTS.style,
    videoType: pick(p.videoType, (v) => typeof v === "string" && Object.hasOwn(VIDEO_TYPES, v), DEFAULTS.videoType),
    tone: typeof p.tone === "string" ? p.tone.slice(0, MAX_TONE_CHARS) : "",
    length: pick(p.length, (v) => typeof v === "string" && Object.hasOwn(LENGTHS, v), DEFAULTS.length),
    numSteps: typeof p.numSteps === "string" && /^\d{0,2}$/.test(p.numSteps) ? p.numSteps : "",
    layoutIndex: pick(p.layoutIndex, (v) => typeof v === "number" && v >= 0 && v < LAYOUTS.length, 0),
    bgVideoId: typeof p.bgVideoId === "string" ? p.bgVideoId : "",
    imageStyle: pick(p.imageStyle, (v) => v === "auto" || v === "cover" || v === "frame", DEFAULTS.imageStyle),
    webImages: typeof p.webImages === "boolean" ? p.webImages : DEFAULTS.webImages,
    webMedia: pick(p.webMedia, (v) => v === "image" || v === "video" || v === "auto", DEFAULTS.webMedia),
    clipsPerStep: pick(p.clipsPerStep, (v) => typeof v === "number" && v >= 1 && v <= 6, DEFAULTS.clipsPerStep),
    libraryMode: pick(p.libraryMode, (v) => v === "off" || v === "auto" || v === "selected", DEFAULTS.libraryMode),
    libraryTags: Array.isArray(p.libraryTags)
      ? p.libraryTags.filter((t): t is string => typeof t === "string").slice(0, 20)
      : // cài đặt lưu từ bản cũ (một tag)
        typeof (p as { libraryTag?: unknown }).libraryTag === "string" && (p as { libraryTag: string }).libraryTag
        ? [(p as { libraryTag: string }).libraryTag]
        : [],
    music: {
      musicId: typeof p.music?.musicId === "string" ? p.music.musicId : "",
      volume: typeof p.music?.volume === "number" ? Math.min(Math.max(p.music.volume, 0.02), 0.5) : DEFAULTS.music.volume,
    },
  };
}

function readSavedRaw(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return ""; // trình duyệt chặn localStorage
  }
}

function parseSaved(raw: string): Partial<Settings> {
  try {
    const data: unknown = JSON.parse(raw || "{}");
    return data && typeof data === "object" ? (data as Partial<Settings>) : {};
  } catch {
    return {};
  }
}

function saveSettings(s: FormState): void {
  const settings = Object.fromEntries((Object.keys(DEFAULTS) as (keyof Settings)[]).map((k) => [k, s[k]])) as Settings;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // trình duyệt chặn localStorage: bỏ qua
  }
}

/** Cài đặt của một job cũ (nút "Tạo video tương tự"). */
function settingsFromJob(input: JobInput): Partial<Settings> {
  const layoutIndex = input.layout === "split" ? 3 : Math.max(0, LAYOUTS.findIndex((l) => l.aspect === input.aspect && l.layout === "normal"));
  const lang = LANGUAGES.find((l) => l.value === input.language) ?? languageOf(undefined);
  return {
    director: !!input.director,
    voice: {
      language: lang.value,
      voice: input.voice || lang.voices[0].value,
      voice2: input.voice2 || "",
      rate: input.rate || "+0%",
      pitch: input.pitch || "+0Hz",
      effect: input.voiceEffect ?? "none",
      // job cũ chưa có tùy chọn này: dùng mặc định
      aiTune: input.aiVoice ?? DEFAULTS.voice.aiTune,
    },
    style: input.style ?? LEGACY_STYLE,
    videoType: input.videoType,
    tone: input.tone,
    length: input.length,
    numSteps: input.numSteps ? String(input.numSteps) : "",
    layoutIndex,
    bgVideoId: input.bgVideoId ?? "",
    imageStyle: input.imageStyle,
    webImages: input.webImages,
    webMedia: input.webMedia,
    clipsPerStep: input.clipsPerStep,
    libraryMode: input.libraryMode,
    libraryTags: input.libraryTags?.length ? input.libraryTags : input.libraryTag ? [input.libraryTag] : [],
    music: { musicId: input.musicId ?? "", volume: input.musicVolume ?? DEFAULTS.music.volume },
  };
}

const noSubscribe = () => () => {};

/** Trang tạo video: nạp cài đặt đã nhớ (hoặc của job cũ khi có ?from=) rồi hiện form. */
export function CreateVideoForm() {
  const params = useSearchParams();
  const from = params.get("from");
  // Đọc localStorage không cần effect; lần render ở server/hydrate dùng null rồi render lại với giá trị thật
  const saved = useSyncExternalStore(noSubscribe, readSavedRaw, () => null);
  const job = useApi<JobDetail>(from ? `/api/jobs/${encodeURIComponent(from)}` : null);
  if (saved === null || (from && !job.data && !job.error)) return <Loading />;

  const base = job.data ? settingsFromJob(job.data.input) : parseSaved(saved);
  const initial: FormState = {
    ...sanitize(base),
    topic: job.data && !job.data.input.script ? job.data.input.topic : "",
    batch: false,
    assetIds: job.data?.input.assetIds ?? [],
    contactId: params.get("contact") ?? job.data?.input.contactId ?? "",
  };
  return (
    <>
      {from && job.error && <ErrorBox message={`Không nạp được cài đặt của job: ${job.error}`} />}
      <Form key={`${from ?? "new"}-${job.data ? "job" : "saved"}`} initial={initial} fromJob={!!job.data} />
    </>
  );
}

function matchesPreset(s: FormState, p: Preset): boolean {
  return (
    s.layoutIndex === p.layoutIndex &&
    s.videoType === p.videoType &&
    s.length === p.length &&
    s.voice.rate === p.voice.rate &&
    s.voice.pitch === p.voice.pitch &&
    (Object.keys(p.style) as (keyof Preset["style"])[]).every((k) => s.style[k] === p.style[k])
  );
}

function Form({ initial, fromJob }: { initial: FormState; fromJob: boolean }) {
  const router = useRouter();
  const [s, setS] = useState<FormState>(initial);
  const [editingTone, setEditingTone] = useState(() => !TONES.some((t) => t.value === initial.tone));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setS((prev) => ({ ...prev, [key]: value }));

  const layout = LAYOUTS[s.layoutIndex];
  const bgVideos = useApi<Page<AssetItem>>(layout.layout === "split" ? "/api/assets?kind=video&limit=200" : null);
  const tags = useApi<TagCount[]>(s.libraryMode === "auto" ? "/api/tags" : null);
  const contacts = useApi<Page<Contact>>("/api/contacts?limit=500");

  const topics = s.batch
    ? s.topic
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean)
    : [s.topic.trim()].filter(Boolean);
  const tooMany = topics.length > MAX_BATCH;

  const applyPreset = (p: Preset) => {
    setS((prev) => ({
      ...prev,
      layoutIndex: p.layoutIndex,
      videoType: p.videoType,
      length: p.length,
      tone: p.tone,
      webImages: true,
      webMedia: p.webMedia,
      clipsPerStep: p.clipsPerStep,
      voice: { ...prev.voice, ...p.voice },
      style: { ...prev.style, ...p.style },
    }));
    setEditingTone(false);
  };

  const reset = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // bỏ qua
    }
    setS((prev) => ({ ...DEFAULTS, topic: prev.topic, batch: prev.batch, assetIds: prev.assetIds, contactId: prev.contactId }));
    setEditingTone(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topics.length || tooMany) return;
    setBusy(true);
    setError(null);
    const common: Omit<Partial<JobInput>, "topic"> = {
      director: s.director,
      numSteps: s.numSteps ? Number(s.numSteps) : null,
      language: s.voice.language,
      voice: s.voice.voice,
      voice2: s.voice.voice2 || null,
      rate: s.voice.rate,
      pitch: s.voice.pitch,
      voiceEffect: s.voice.effect,
      aiVoice: s.voice.aiTune,
      videoType: s.videoType,
      tone: s.tone.trim(),
      length: s.length,
      style: s.style,
      aspect: layout.aspect,
      layout: layout.layout,
      bgVideoId: layout.layout === "split" ? s.bgVideoId : null,
      imageStyle: s.imageStyle,
      webImages: s.webImages,
      webMedia: s.webMedia,
      clipsPerStep: s.clipsPerStep,
      libraryMode: s.libraryMode,
      libraryTags: s.libraryMode === "auto" ? s.libraryTags : [],
      assetIds: s.libraryMode === "selected" ? s.assetIds : [],
      contactId: s.contactId || null,
      musicId: s.music.musicId || null,
      musicVolume: s.music.volume,
    };
    let created: JobItem[] = [];
    try {
      for (const topic of topics) {
        created = [...created, await api<JobItem>("/api/jobs", { method: "POST", json: { ...common, topic } })];
      }
      saveSettings(s);
      router.push(created.length === 1 ? `/jobs/${created[0].id}` : "/jobs");
    } catch (err) {
      const done = created.length ? `Đã tạo ${created.length}/${topics.length} video. ` : "";
      setError(done + (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <PageHeader
        title="Tạo video mới"
        subtitle={
          fromJob
            ? "Đã điền sẵn cài đặt của job cũ. Sửa chủ đề hoặc tùy chọn rồi tạo video."
            : "AI lên kịch bản, chọn ảnh/clip/meme, đọc lời bình và dựng video. Cài đặt của lần tạo trước được nhớ sẵn."
        }
        actions={
          <Button variant="ghost" onClick={reset}>
            Đặt lại mặc định
          </Button>
        }
      />

      <Card className="space-y-3 p-5">
        <div>
          <h2 className="font-semibold text-zinc-900">Cách AI làm video</h2>
          <p className="text-sm text-zinc-500">Đạo diễn AI làm nhiều bước như người dựng phim thật; bạn xem được từng quyết định của AI ở trang job.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Choice active={s.director} onClick={() => set("director", true)} title="Đạo diễn AI (sinh động)">
            AI tự lên ý tưởng, tìm meme, ảnh và clip, dựng từng cảnh rồi tự duyệt và sửa. Số cảnh do AI quyết định, giọng đọc đổi cảm xúc
            theo từng câu, có giọng phụ chen ngang, âm thanh meme, zoom giật, sticker.
          </Choice>
          <Choice active={!s.director} onClick={() => set("director", false)} title="Kịch bản nhanh">
            AI viết kịch bản một lần theo khung cố định: mở đầu, các bước có nhãn, lời kết. Nhanh và tốn ít lượt gọi AI hơn.
          </Choice>
        </div>
      </Card>

      <Card className="space-y-3 p-5">
        <div>
          <h2 className="font-semibold text-zinc-900">Mẫu nhanh</h2>
          <p className="text-sm text-zinc-500">Chọn một phong cách có sẵn rồi tinh chỉnh bên dưới.</p>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
          {PRESETS.map((p) => (
            <Choice key={p.id} active={matchesPreset(s, p)} onClick={() => applyPreset(p)} title={p.label}>
              {p.hint}
            </Choice>
          ))}
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <Field
          label={s.batch ? "Danh sách chủ đề (mỗi dòng một video)" : "Chủ đề / yêu cầu cho AI"}
          hint={
            <span className="flex justify-between gap-3">
              <span>
                {s.batch
                  ? `Mỗi dòng tạo một video với cùng cài đặt (tối đa ${MAX_BATCH}).`
                  : "Viết ngắn (“cách pha cà phê phin”) hoặc chi tiết như một prompt: nội dung cần nói, đối tượng xem, thông tin sản phẩm, giá..."}
              </span>
              {s.batch ? (
                <span className={cx("shrink-0 tabular-nums", tooMany && "font-medium text-red-600")}>{topics.length} video</span>
              ) : (
                s.topic.length > 0 && <span className="shrink-0 tabular-nums">{s.topic.length.toLocaleString("vi-VN")} ký tự</span>
              )}
            </span>
          }
        >
          <textarea
            className={`${inputClass} min-h-28 resize-y`}
            rows={5}
            required
            value={s.topic}
            onChange={(e) => set("topic", e.target.value)}
            placeholder={
              s.batch
                ? "Cách pha cà phê phin\nCách làm bánh flan\n5 mẹo giữ rau tươi lâu"
                : "Bạn muốn làm video về gì?\nVí dụ: Video giới thiệu quán cà phê Mộc cho dân văn phòng, nhấn mạnh combo sáng 35.000đ và chỗ ngồi làm việc yên tĩnh."
            }
          />
        </Field>
        <Toggle checked={s.batch} onChange={(v) => set("batch", v)} label="Tạo hàng loạt" hint="Mỗi dòng là một chủ đề, tạo nhiều video cùng lúc (xếp hàng chạy lần lượt)." />

        <div>
          <p className="mb-1.5 text-sm font-medium text-zinc-700">Loại video</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {(Object.keys(VIDEO_TYPES) as VideoType[]).map((k) => (
              <Choice key={k} active={s.videoType === k} onClick={() => set("videoType", k)} title={VIDEO_TYPES[k].label}>
                {VIDEO_TYPES[k].hint}
              </Choice>
            ))}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_8rem]">
          <Field label="Giọng văn">
            <select
              className={inputClass}
              value={editingTone ? "__custom" : s.tone}
              onChange={(e) => {
                if (e.target.value === "__custom") return setEditingTone(true);
                setEditingTone(false);
                set("tone", e.target.value);
              }}
            >
              {TONES.map((t) => (
                <option key={t.label} value={t.value}>
                  {t.label}
                </option>
              ))}
              <option value="__custom">Tự nhập...</option>
            </select>
            {editingTone && (
              <input
                className={`${inputClass} mt-2`}
                maxLength={MAX_TONE_CHARS}
                value={s.tone}
                onChange={(e) => set("tone", e.target.value)}
                placeholder="VD: như một đầu bếp vui tính, hay pha trò"
              />
            )}
          </Field>
          <div>
            <p className="mb-1.5 text-sm font-medium text-zinc-700">Độ dài</p>
            <Segmented<VideoLength>
              value={s.length}
              onChange={(v) => set("length", v)}
              options={(Object.keys(LENGTHS) as VideoLength[]).map((k) => ({ value: k, label: LENGTHS[k].label, hint: LENGTHS[k].hint }))}
            />
          </div>
          <Field label={s.director ? "Số cảnh (gợi ý)" : "Số phần"}>
            <input
              className={inputClass}
              type="number"
              min={1}
              max={15}
              value={s.numSteps}
              onChange={(e) => set("numSteps", e.target.value)}
              placeholder={s.director ? "AI quyết định" : "Tự động"}
            />
          </Field>
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <div>
          <h2 className="font-semibold text-zinc-900">Giọng đọc</h2>
          <p className="text-sm text-zinc-500">Hơn 50 giọng ở 10 ngôn ngữ; giọng đa ngôn ngữ đọc được cả tiếng Việt. Bấm “Nghe thử” trước khi chọn.</p>
        </div>
        <VoiceFields
          value={s.voice}
          onChange={(v) => set("voice", v)}
          allowAiTune
          note={
            s.director
              ? "Đạo diễn AI còn đổi cảm xúc từng câu (hào hứng cao hơn, kịch tính trầm hơn...) quanh mức này; câu bình thường đọc đúng như bản nghe thử."
              : undefined
          }
        />
      </Card>

      <Card className="space-y-4 p-5">
        <h2 className="font-semibold text-zinc-900">Khung hình</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {LAYOUTS.map((l, i) => (
            <Choice key={l.label} active={s.layoutIndex === i} onClick={() => set("layoutIndex", i)} title={l.label}>
              <span className="mt-2 flex items-center gap-2">
                <span className={cx("inline-block rounded-sm border-2 border-current", l.box, l.layout === "split" && "border-dashed")} />
                {l.hint}
              </span>
            </Choice>
          ))}
        </div>
        {layout.layout === "split" && (
          <Field label="Video nền (nửa dưới, tắt tiếng)" hint={<>Tải video nền ở trang <Link href="/assets" className="text-brand-600 underline">Assets</Link>. Nên tự quay màn hình khi chơi game để tránh vi phạm bản quyền.</>}>
            <select className={inputClass} value={s.bgVideoId} onChange={(e) => set("bgVideoId", e.target.value)} required>
              <option value="">Chọn video nền...</option>
              {s.bgVideoId && bgVideos.data && !bgVideos.data.items.some((v) => v.id === s.bgVideoId) && (
                <option value={s.bgVideoId}>(Video đã bị xóa — chọn lại)</option>
              )}
              {bgVideos.data?.items.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.title} ({formatDuration(v.duration)})
                </option>
              ))}
            </select>
          </Field>
        )}
      </Card>

      <Card className="space-y-4 p-5">
        <div>
          <h2 className="font-semibold text-zinc-900">Hiệu ứng & phong cách</h2>
          <p className="text-sm text-zinc-500">Chuyển cảnh, chuyển động, phụ đề động và màu sắc làm video sinh động hơn.</p>
        </div>
        <StyleFields value={s.style} onChange={(v) => set("style", v)} />
      </Card>

      <Card className="space-y-4 p-5">
        <div>
          <h2 className="font-semibold text-zinc-900">Ảnh & video trong video</h2>
          <p className="text-sm text-zinc-500">
            Asset có thể là nền minh họa hoặc là nội dung chính (ảnh sản phẩm, menu, ảnh chụp màn hình, clip quay sản phẩm...).
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <Choice active={s.libraryMode === "auto"} onClick={() => set("libraryMode", "auto")} title="AI tự chọn từ Assets">
            AI đọc tóm tắt và chữ trong từng asset, tự chọn ảnh/video khớp với từng bước.
          </Choice>
          <Choice active={s.libraryMode === "selected"} onClick={() => set("libraryMode", "selected")} title="Dùng asset tôi chọn">
            Ảnh/video bạn chọn là nội dung chính, AI viết lời bình dựa trên nội dung và chữ trong chúng.
          </Choice>
          <Choice active={s.libraryMode === "off"} onClick={() => set("libraryMode", "off")} title="Chỉ tìm trên mạng">
            Không dùng Assets; AI tự đặt từ khóa và tìm clip/ảnh cho từng bước.
          </Choice>
        </div>

        {s.libraryMode === "auto" && (
          <div>
            <p className="mb-1.5 text-sm font-medium text-zinc-700">Giới hạn trong tag (tùy chọn)</p>
            <TagPicker
              placeholder="Toàn bộ thư viện"
              options={(tags.data ?? []).filter((t) => t.assets > 0).map((t) => ({ name: t.name, count: t.assets }))}
              value={s.libraryTags}
              onChange={(v) => set("libraryTags", v)}
            />
            <p className="mt-1 text-xs text-zinc-500">
              AI chỉ xem các asset có ít nhất một tag đã chọn (vd #meme + #meo). Để trống: cả thư viện (AI lọc theo chủ đề).
            </p>
          </div>
        )}
        {s.libraryMode === "selected" && (
          <div className="rounded-xl bg-zinc-50 p-3 ring-1 ring-zinc-200">
            <p className="mb-3 text-sm text-zinc-600">
              Bấm vào asset để chọn theo thứ tự xuất hiện mong muốn. Đã chọn <b>{s.assetIds.length}</b> asset. AI dùng mô tả, tóm tắt và
              chữ đọc được trong từng asset để viết lời bình.
            </p>
            <AssetPicker selected={s.assetIds} onChange={(ids) => set("assetIds", ids)} />
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Cách hiển thị ảnh/video">
            <select className={inputClass} value={s.imageStyle} onChange={(e) => set("imageStyle", e.target.value as JobInput["imageStyle"])}>
              <option value="auto">Tự động: asset của bạn hiện trọn vẹn, ảnh trên mạng phủ kín</option>
              <option value="frame">Luôn hiện trọn vẹn trong khung (asset là nội dung chính)</option>
              <option value="cover">Luôn phủ kín khung hình (làm nền)</option>
            </select>
          </Field>
          <Field
            label="Tìm trên mạng cho bước chưa có asset"
            hint="Clip chỉ lấy từ nguồn được phép dùng lại (Pexels, Pixabay, Wikimedia Commons, YouTube Creative Commons) và tự ghi nguồn vào mô tả video."
          >
            <select
              className={inputClass}
              value={s.webImages ? s.webMedia : "off"}
              onChange={(e) => {
                const v = e.target.value;
                setS((prev) => ({ ...prev, webImages: v !== "off", webMedia: v === "off" ? prev.webMedia : (v as WebMedia) }));
              }}
            >
              <option value="video">Ưu tiên clip video (thiếu thì dùng ảnh) — sinh động nhất</option>
              <option value="auto">AI tự chọn ảnh hay clip video cho từng bước</option>
              <option value="image">Chỉ ảnh</option>
              <option value="off">Không tìm (bước thiếu asset dùng nền chữ)</option>
            </select>
          </Field>
          {s.webImages && s.webMedia !== "image" && (
            <Field label="Số clip ghép trong mỗi bước" hint="Nhiều clip nối nhau làm video sinh động hơn; mở đầu và kết thúc tự ghép từ các clip.">
              <select className={inputClass} value={s.clipsPerStep} onChange={(e) => set("clipsPerStep", Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n} clip{n === 3 ? " (mặc định)" : ""}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      </Card>

      <Card className="space-y-2 p-5">
        <h2 className="font-semibold text-zinc-900">Nhạc nền</h2>
        <p className="text-sm text-zinc-500">Nhạc lặp lại suốt video, nhỏ hơn giọng đọc và mờ dần ở cuối.</p>
        <MusicPicker musicId={s.music.musicId} volume={s.music.volume} onChange={(m) => set("music", m)} />
      </Card>

      <Card className="p-5">
        <Field label="Làm cho khách hàng (tùy chọn)" hint="Video sẽ được gắn vào hồ sơ khách hàng trong CRM.">
          <select className={`${inputClass} max-w-md`} value={s.contactId} onChange={(e) => set("contactId", e.target.value)}>
            <option value="">Không gắn</option>
            {contacts.data?.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.company ? ` — ${c.company}` : ""}
              </option>
            ))}
          </select>
        </Field>
      </Card>

      <ErrorBox message={error} />
      <div className="flex flex-wrap items-center justify-end gap-3">
        {tooMany && <p className="text-sm text-red-600">Tối đa {MAX_BATCH} video mỗi lần.</p>}
        <Button type="submit" variant="primary" busy={busy} disabled={!topics.length || tooMany} className="px-6">
          {topics.length > 1 ? `Tạo ${topics.length} video` : "Tạo video"}
        </Button>
      </div>
    </form>
  );
}
