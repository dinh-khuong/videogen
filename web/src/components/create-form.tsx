"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api, formatDuration, useApi } from "@/lib/client";
import type { Contact, JobInput, JobItem, Page, TagCount, VideoItem } from "@/lib/types";
import { ImagePicker } from "./images-library";
import { Button, Card, ErrorBox, Field, PageHeader, cx, inputClass } from "./ui";

const VOICES: Record<string, { value: string; label: string }[]> = {
  "tiếng Việt": [
    { value: "vi-VN-HoaiMyNeural", label: "Hoài My (nữ)" },
    { value: "vi-VN-NamMinhNeural", label: "Nam Minh (nam)" },
  ],
  English: [
    { value: "en-US-JennyNeural", label: "Jenny (female, US)" },
    { value: "en-US-GuyNeural", label: "Guy (male, US)" },
    { value: "en-GB-SoniaNeural", label: "Sonia (female, UK)" },
  ],
};

const LAYOUTS = [
  { aspect: "16:9", layout: "normal", label: "16:9 ngang", hint: "YouTube", box: "w-10 h-6" },
  { aspect: "9:16", layout: "normal", label: "9:16 dọc", hint: "TikTok, Shorts, Reels", box: "w-5 h-9" },
  { aspect: "1:1", layout: "normal", label: "1:1 vuông", hint: "Facebook, Instagram", box: "w-7 h-7" },
  { aspect: "9:16", layout: "split", label: "Shorts chia đôi", hint: "Nội dung trên, video nền dưới", box: "w-5 h-9" },
] as const;

function Choice({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children?: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "rounded-xl p-3 text-left ring-1 transition-colors",
        active ? "bg-brand-50 ring-2 ring-brand-500" : "bg-white ring-zinc-200 hover:ring-zinc-300",
      )}
    >
      <p className={cx("text-sm font-medium", active ? "text-brand-700" : "text-zinc-800")}>{title}</p>
      {children && <div className="mt-0.5 text-xs text-zinc-500">{children}</div>}
    </button>
  );
}

export function CreateVideoForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [topic, setTopic] = useState("");
  const [numSteps, setNumSteps] = useState("");
  const [language, setLanguage] = useState("tiếng Việt");
  const [voice, setVoice] = useState(VOICES["tiếng Việt"][0].value);
  const [rate, setRate] = useState("+0%");
  const [layoutIndex, setLayoutIndex] = useState(0);
  const [bgVideoId, setBgVideoId] = useState("");
  const [libraryMode, setLibraryMode] = useState<JobInput["libraryMode"]>("off");
  const [libraryTag, setLibraryTag] = useState("");
  const [imageIds, setImageIds] = useState<string[]>([]);
  const [webImages, setWebImages] = useState(true);
  const [imageStyle, setImageStyle] = useState<JobInput["imageStyle"]>("auto");
  const [contactId, setContactId] = useState(params.get("contact") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const layout = LAYOUTS[layoutIndex];
  const bgVideos = useApi<Page<VideoItem>>(layout.layout === "split" ? "/api/videos?kind=upload&limit=200" : null);
  const tags = useApi<TagCount[]>(libraryMode === "auto" ? "/api/tags" : null);
  const contacts = useApi<Page<Contact>>("/api/contacts?limit=500");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input: Partial<JobInput> = {
        topic,
        numSteps: numSteps ? Number(numSteps) : null,
        language,
        voice,
        rate,
        aspect: layout.aspect,
        layout: layout.layout,
        bgVideoId: layout.layout === "split" ? bgVideoId : null,
        imageStyle,
        webImages,
        libraryMode,
        libraryTag: libraryMode === "auto" ? libraryTag || null : null,
        imageIds: libraryMode === "selected" ? imageIds : [],
        contactId: contactId || null,
      };
      const job = await api<JobItem>("/api/jobs", { method: "POST", json: input });
      router.push(`/jobs/${job.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <PageHeader title="Tạo video mới" subtitle="AI viết kịch bản, lấy ảnh (thư viện hoặc trên mạng), đọc lời bình và dựng video." />

      <Card className="space-y-4 p-5">
        <Field label="Chủ đề video" hint="Ví dụ: “cách pha cà phê phin”, “giới thiệu menu mùa hè của quán”, “3 mẹo chăm sóc da”.">
          <textarea className={inputClass} rows={2} required maxLength={500} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Bạn muốn làm video hướng dẫn về gì?" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Số bước">
            <input className={inputClass} type="number" min={1} max={15} value={numSteps} onChange={(e) => setNumSteps(e.target.value)} placeholder="Tự động" />
          </Field>
          <Field label="Ngôn ngữ">
            <select
              className={inputClass}
              value={language}
              onChange={(e) => {
                setLanguage(e.target.value);
                setVoice(VOICES[e.target.value][0].value);
              }}
            >
              {Object.keys(VOICES).map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </Field>
          <Field label="Giọng đọc">
            <select className={inputClass} value={voice} onChange={(e) => setVoice(e.target.value)}>
              {VOICES[language].map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tốc độ đọc">
            <select className={inputClass} value={rate} onChange={(e) => setRate(e.target.value)}>
              {["-10%", "+0%", "+10%", "+20%"].map((r) => (
                <option key={r} value={r}>
                  {r === "+0%" ? "Bình thường" : r}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <h2 className="font-semibold text-zinc-900">Khung hình</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {LAYOUTS.map((l, i) => (
            <Choice key={l.label} active={layoutIndex === i} onClick={() => setLayoutIndex(i)} title={l.label}>
              <span className="mt-2 flex items-center gap-2">
                <span className={cx("inline-block rounded-sm border-2 border-current", l.box, l.layout === "split" && "border-dashed")} />
                {l.hint}
              </span>
            </Choice>
          ))}
        </div>
        {layout.layout === "split" && (
          <Field label="Video nền (nửa dưới, tắt tiếng)" hint={<>Tải video nền ở <Link href="/videos" className="text-brand-600 underline">Thư viện video</Link>. Nên tự quay màn hình khi chơi game để tránh vi phạm bản quyền.</>}>
            <select className={inputClass} value={bgVideoId} onChange={(e) => setBgVideoId(e.target.value)} required>
              <option value="">Chọn video nền...</option>
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
          <h2 className="font-semibold text-zinc-900">Ảnh trong video</h2>
          <p className="text-sm text-zinc-500">Ảnh có thể là nền minh họa hoặc là nội dung chính (vd ảnh sản phẩm, món ăn, ảnh chụp màn hình).</p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <Choice active={libraryMode === "off"} onClick={() => setLibraryMode("off")} title="Tìm ảnh trên mạng">
            AI tự đặt từ khóa và tìm ảnh cho từng bước.
          </Choice>
          <Choice active={libraryMode === "auto"} onClick={() => setLibraryMode("auto")} title="AI chọn từ thư viện">
            AI đọc mô tả ảnh trong thư viện và dùng ảnh khớp với bước.
          </Choice>
          <Choice active={libraryMode === "selected"} onClick={() => setLibraryMode("selected")} title="Dùng ảnh tôi chọn">
            Các ảnh bạn chọn là nội dung chính, AI viết kịch bản xoay quanh chúng.
          </Choice>
        </div>

        {libraryMode === "auto" && (
          <Field label="Giới hạn trong tag (tùy chọn)" hint="AI chỉ xem các ảnh có tag này. Để trống: xem 150 ảnh mới nhất có mô tả.">
            <select className={`${inputClass} max-w-xs`} value={libraryTag} onChange={(e) => setLibraryTag(e.target.value)}>
              <option value="">Toàn bộ thư viện</option>
              {tags.data
                ?.filter((t) => t.images > 0)
                .map((t) => (
                  <option key={t.name} value={t.name}>
                    #{t.name} ({t.images} ảnh)
                  </option>
                ))}
            </select>
          </Field>
        )}
        {libraryMode === "selected" && (
          <div className="rounded-xl bg-zinc-50 p-3 ring-1 ring-zinc-200">
            <p className="mb-3 text-sm text-zinc-600">
              Bấm vào ảnh để chọn theo thứ tự xuất hiện mong muốn. Đã chọn <b>{imageIds.length}</b> ảnh. Mô tả ảnh càng rõ, lời bình càng sát nội dung ảnh.
            </p>
            <ImagePicker selected={imageIds} onChange={setImageIds} />
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Cách hiển thị ảnh">
            <select className={inputClass} value={imageStyle} onChange={(e) => setImageStyle(e.target.value as JobInput["imageStyle"])}>
              <option value="auto">Tự động: ảnh thư viện hiện trọn vẹn, ảnh trên mạng phủ kín</option>
              <option value="frame">Luôn hiện trọn vẹn trong khung (ảnh là nội dung chính)</option>
              <option value="cover">Luôn phủ kín khung hình (ảnh làm nền)</option>
            </select>
          </Field>
          <label className="flex items-start gap-2.5 self-end rounded-lg p-2 text-sm text-zinc-700">
            <input type="checkbox" className="mt-0.5 size-4 accent-brand-500" checked={webImages} onChange={(e) => setWebImages(e.target.checked)} />
            <span>
              Tìm ảnh trên mạng cho các bước chưa có ảnh
              <span className="block text-xs text-zinc-500">Tắt: bước thiếu ảnh dùng nền chữ thay thế.</span>
            </span>
          </label>
        </div>
      </Card>

      <Card className="p-5">
        <Field label="Làm cho khách hàng (tùy chọn)" hint="Video sẽ được gắn vào hồ sơ khách hàng trong CRM.">
          <select className={`${inputClass} max-w-md`} value={contactId} onChange={(e) => setContactId(e.target.value)}>
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
      <div className="flex justify-end">
        <Button type="submit" variant="primary" busy={busy} disabled={!topic.trim()} className="px-6">
          Tạo video
        </Button>
      </div>
    </form>
  );
}
