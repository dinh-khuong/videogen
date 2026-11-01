"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api, formatDuration, useApi } from "@/lib/client";
import type { AssetItem, Contact, JobInput, JobItem, Page, TagCount } from "@/lib/types";
import { AssetPicker, MusicPicker } from "./assets-library";
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
  const [libraryMode, setLibraryMode] = useState<JobInput["libraryMode"]>("auto");
  const [libraryTag, setLibraryTag] = useState("");
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [webImages, setWebImages] = useState(true);
  const [webMedia, setWebMedia] = useState<NonNullable<JobInput["webMedia"]>>("auto");
  const [clipsPerStep, setClipsPerStep] = useState(3);
  const [imageStyle, setImageStyle] = useState<JobInput["imageStyle"]>("auto");
  const [contactId, setContactId] = useState(params.get("contact") ?? "");
  const [music, setMusic] = useState({ musicId: "", volume: 0.12 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const layout = LAYOUTS[layoutIndex];
  const bgVideos = useApi<Page<AssetItem>>(layout.layout === "split" ? "/api/assets?kind=video&limit=200" : null);
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
        webMedia,
        clipsPerStep,
        libraryMode,
        libraryTag: libraryMode === "auto" ? libraryTag || null : null,
        assetIds: libraryMode === "selected" ? assetIds : [],
        contactId: contactId || null,
        musicId: music.musicId || null,
        musicVolume: music.volume,
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
      <PageHeader title="Tạo video mới" subtitle="AI viết kịch bản, chọn ảnh/video từ Assets (hoặc tìm ảnh trên mạng), đọc lời bình và dựng video." />

      <Card className="space-y-4 p-5">
        <Field
          label="Chủ đề / yêu cầu cho AI"
          hint={
            <span className="flex justify-between gap-3">
              <span>
                Viết ngắn (“cách pha cà phê phin”) hoặc chi tiết như một prompt: nội dung cần nói, đối tượng xem, giọng văn, thông tin
                sản phẩm, giá...
              </span>
              {topic.length > 0 && <span className="shrink-0 tabular-nums">{topic.length.toLocaleString("vi-VN")} ký tự</span>}
            </span>
          }
        >
          <textarea
            className={`${inputClass} min-h-28 resize-y`}
            rows={5}
            required
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={"Bạn muốn làm video hướng dẫn về gì?\nVí dụ: Video giới thiệu quán cà phê Mộc cho dân văn phòng, giọng trẻ trung, nhấn mạnh combo sáng 35.000đ và chỗ ngồi làm việc yên tĩnh."}
          />
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
          <Field label="Video nền (nửa dưới, tắt tiếng)" hint={<>Tải video nền ở trang <Link href="/assets" className="text-brand-600 underline">Assets</Link>. Nên tự quay màn hình khi chơi game để tránh vi phạm bản quyền.</>}>
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
          <h2 className="font-semibold text-zinc-900">Ảnh & video trong video</h2>
          <p className="text-sm text-zinc-500">
            Asset có thể là nền minh họa hoặc là nội dung chính (ảnh sản phẩm, menu, ảnh chụp màn hình, clip quay sản phẩm...).
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <Choice active={libraryMode === "auto"} onClick={() => setLibraryMode("auto")} title="AI tự chọn từ Assets">
            AI đọc tóm tắt và chữ trong từng asset, tự chọn ảnh/video khớp với từng bước.
          </Choice>
          <Choice active={libraryMode === "selected"} onClick={() => setLibraryMode("selected")} title="Dùng asset tôi chọn">
            Ảnh/video bạn chọn là nội dung chính, AI viết lời bình dựa trên nội dung và chữ trong chúng.
          </Choice>
          <Choice active={libraryMode === "off"} onClick={() => setLibraryMode("off")} title="Chỉ tìm ảnh trên mạng">
            Không dùng Assets; AI tự đặt từ khóa và tìm ảnh cho từng bước.
          </Choice>
        </div>

        {libraryMode === "auto" && (
          <Field label="Giới hạn trong tag (tùy chọn)" hint="AI chỉ xem các asset có tag này. Để trống: cả thư viện (AI lọc theo chủ đề).">
            <select className={`${inputClass} max-w-xs`} value={libraryTag} onChange={(e) => setLibraryTag(e.target.value)}>
              <option value="">Toàn bộ thư viện</option>
              {tags.data
                ?.filter((t) => t.assets > 0)
                .map((t) => (
                  <option key={t.name} value={t.name}>
                    #{t.name} ({t.assets} asset)
                  </option>
                ))}
            </select>
          </Field>
        )}
        {libraryMode === "selected" && (
          <div className="rounded-xl bg-zinc-50 p-3 ring-1 ring-zinc-200">
            <p className="mb-3 text-sm text-zinc-600">
              Bấm vào asset để chọn theo thứ tự xuất hiện mong muốn. Đã chọn <b>{assetIds.length}</b> asset. AI dùng mô tả, tóm tắt và
              chữ đọc được trong từng asset để viết lời bình.
            </p>
            <AssetPicker selected={assetIds} onChange={setAssetIds} />
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Cách hiển thị ảnh/video">
            <select className={inputClass} value={imageStyle} onChange={(e) => setImageStyle(e.target.value as JobInput["imageStyle"])}>
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
              value={webImages ? webMedia : "off"}
              onChange={(e) => {
                setWebImages(e.target.value !== "off");
                if (e.target.value !== "off") setWebMedia(e.target.value as NonNullable<JobInput["webMedia"]>);
              }}
            >
              <option value="auto">AI tự chọn ảnh hay clip video cho từng bước</option>
              <option value="video">Ưu tiên clip video (thiếu thì dùng ảnh)</option>
              <option value="image">Chỉ ảnh</option>
              <option value="off">Không tìm (bước thiếu asset dùng nền chữ)</option>
            </select>
          </Field>
          {webImages && webMedia !== "image" && (
            <Field label="Số clip ghép trong mỗi bước" hint="Nhiều clip nối nhau làm video sinh động hơn; mở đầu và kết thúc tự ghép từ các clip.">
              <select className={inputClass} value={clipsPerStep} onChange={(e) => setClipsPerStep(Number(e.target.value))}>
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
        <MusicPicker musicId={music.musicId} volume={music.volume} onChange={setMusic} />
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
