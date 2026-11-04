import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { ensureHashtags, normalizeTag, textHashtags, withHashtags } from "@/lib/hashtags";
import type { JobInput, Script } from "@/lib/types";
import { analyzer } from "./analyzer";
import { addAssets, findAssetBySha1, getAsset, type NewAsset } from "./assets";
import { db } from "./db";
import { extOf, removeMedia, sha1File } from "./files";
import type { JobRow } from "./jobs";
import { TMP_DIR } from "./paths";
import { contactVideos, contacts, videoAssets } from "./schema";
import { insertVideo, moveVideoFiles, promptOf } from "./videos";

/** Kết quả engine ghi ra result.json (xem RunResult.to_dict trong engine/videogen/pipeline.py). */
export type EngineResult = {
  script: Script;
  /** ghi công cho clip/ảnh có giấy phép (Creative Commons, kho stock) */
  credits?: string[];
  video: {
    path: string;
    thumbnail: string | null;
    duration: number;
    width: number;
    height: number;
    title: string;
    description: string;
    hashtags: string[];
  } | null;
  images: {
    step: number;
    path: string;
    kind: "custom" | "library" | "web" | "placeholder";
    library_id: string | null;
    credit: { source: string; url: string; author?: string; license?: string } | null;
    query: string | null;
    media?: "image" | "video";
    position?: number;
    /** visual: đoạn hình chính | overlay: clip/ảnh lồng trên hình suốt cảnh | sticker: meme bật ra theo câu thoại */
    role?: "visual" | "overlay" | "sticker";
    /** vị trí trong kịch bản: "overlay" hoặc "line:<thứ tự câu>" */
    ref?: string | null;
    /** Đạo diễn AI đặt khi tải về: tên riêng, hashtag về nội dung hình và có phải meme không */
    title?: string;
    hashtags?: string[];
    meme?: boolean;
  }[];
};

/** Dạng so sánh của một đoạn chữ: bỏ dấu, hoa thường, dấu câu, khoảng trắng thừa. */
function comparable(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const MAX_NARRATION_IN_DESCRIPTION = 300;

/**
 * Tên riêng cho ảnh/clip lưu vào thư viện. Ưu tiên tên AI đặt cho đúng hình đó, rồi nhãn của bước, rồi từ khóa tìm kiếm;
 * không bao giờ trùng tiêu đề video hay lời bình (đó là nội dung cần minh họa, không phải tên của hình), và không trùng
 * tên của hình khác trong cùng video (thêm số thứ tự).
 */
function assetTitle(
  img: EngineResult["images"][number],
  step: Script["steps"][number] | undefined,
  script: Script,
  used: Set<string>,
): string {
  const videoTitle = comparable(script.title);
  const narration = comparable(step?.narration ?? "");
  const query = img.query?.trim();
  const candidates = [
    img.title,
    step?.heading,
    query ? query.charAt(0).toLocaleUpperCase("vi") + query.slice(1) : "",
    `${script.title} — ${img.media === "video" ? "clip" : "ảnh"} cảnh ${img.step}`,
  ];
  const picked = candidates.map((c) => c?.trim() ?? "").find((c) => c && ![videoTitle, narration].includes(comparable(c)));
  const base = (picked ?? `Cảnh ${img.step}`).slice(0, 120);
  let title = base;
  for (let n = 2; used.has(comparable(title)); n++) title = `${base} (${n})`;
  used.add(comparable(title));
  return title;
}

/** Tên nguồn ngắn dùng làm hashtag ("YouTube" -> youtube, "buzzfeed.com" -> buzzfeed). */
function sourceTag(source: string | undefined): string[] {
  const tag = normalizeTag((source ?? "").replace(/\.[a-z]{2,}$/i, ""));
  return tag && tag !== "upload" && tag !== "web" ? [tag] : [];
}

/**
 * Đưa kết quả của job vào thư viện: ảnh mới (tìm trên mạng) thành asset có mô tả + hashtag (rồi được phân tích như
 * asset khác), video chuyển vào thư mục media, liên kết asset theo từng bước và với khách hàng (nếu có). Trả về id video.
 */
export async function ingestResult(job: JobRow, result: EngineResult): Promise<string> {
  if (!result.video || !fs.existsSync(result.video.path)) throw new Error("Engine không tạo ra file video");
  const script = result.script;
  // bước -> (thứ tự trong bước -> id asset)
  const stepAssets = new Map<number, Map<number, string>>();
  // Clip lồng / sticker meme: gắn với video (để hiện trong "Assets dùng trong video") nhưng không phải hình chính của bước
  const extraLinks: { step: number; position: number; id: string; ref: string | null }[] = [];
  type Img = EngineResult["images"][number];
  const setAsset = (img: Img, position: number, id: string) => {
    if (img.role && img.role !== "visual") {
      extraLinks.push({ step: img.step, position, id, ref: img.ref ?? null });
      return;
    }
    if (!stepAssets.has(img.step)) stepAssets.set(img.step, new Map());
    stepAssets.get(img.step)!.set(position, id);
  };
  const pending: { img: Img; position: number; asset: NewAsset }[] = [];
  const usedTitles = new Set<string>();

  for (const img of result.images) {
    if (img.kind === "placeholder") continue;
    const position = img.position ?? 0;
    if (img.kind === "library" && img.library_id && getAsset(img.library_id)) {
      setAsset(img, position, img.library_id);
      continue;
    }
    if (!fs.existsSync(img.path)) continue;
    const sha1 = await sha1File(img.path);
    const existing = findAssetBySha1(sha1);
    if (existing) {
      setAsset(img, position, existing);
      continue;
    }
    const ext = extOf(img.path) || ".jpg";
    const tmp = path.join(/* turbopackIgnore: true */ TMP_DIR, `${crypto.randomUUID()}${ext}`);
    await fsp.copyFile(/* turbopackIgnore: true */ img.path, tmp);
    const step = script.steps[img.step - 1];
    const credit = img.credit;
    const creditNote = credit?.license
      ? `\nNguồn: ${[credit.source, credit.author, credit.license].filter(Boolean).join(" — ")} (${credit.url})`
      : "";
    const narration = (step?.narration ?? "").trim();
    const context = narration.length > MAX_NARRATION_IN_DESCRIPTION ? `${narration.slice(0, MAX_NARRATION_IN_DESCRIPTION - 1).trimEnd()}…` : narration;
    // Hashtag của đúng hình đó (AI đặt) rồi của bước; thiếu thì bổ sung từ từ khóa tìm kiếm, hashtag video, nhãn bước, nguồn
    const hashtags = ensureHashtags(
      [img.meme ? ["meme"] : [], img.hashtags, step?.hashtags],
      [textHashtags(img.query), script.hashtags, textHashtags(step?.heading), [img.media === "video" ? "video" : "hinhanh"], sourceTag(credit?.source)],
    );
    pending.push({
      img,
      position,
      asset: {
        tmpPath: tmp,
        ext,
        sha1,
        size: (await fsp.stat(/* turbopackIgnore: true */ tmp)).size,
        title: assetTitle(img, step, script, usedTitles),
        description: withHashtags(`${context}${creditNote}`, hashtags),
        source: img.credit?.source ?? (img.kind === "web" ? "web" : "upload"),
        sourceUrl: img.credit?.url ?? null,
      },
    });
  }
  const added = await addAssets(pending.map((p) => p.asset));
  pending.forEach((p, i) => setAsset(p.img, p.position, added[i].id));
  const orderedIds = (step: number) =>
    [...(stepAssets.get(step) ?? new Map<number, string>()).entries()].sort((a, b) => a[0] - b[0]).map(([, id]) => id);
  if (added.some((a) => !a.existed)) analyzer().kick();

  // Lưu kịch bản kèm id asset thư viện từng bước để có thể sửa và render lại
  const refId = (step: number, ref: string) => extraLinks.find((l) => l.step === step && l.ref === ref)?.id;
  const storedScript: Script = {
    ...script,
    steps: script.steps.map((s, i) => {
      const [first = null, ...extra] = [...new Set(orderedIds(i + 1))];
      // Clip lồng / sticker AI tải về cũng đã thành asset: trỏ bằng id để sửa kịch bản & tạo lại vẫn còn
      const overlayId = s.overlay ? refId(i + 1, "overlay") : undefined;
      const lines = s.lines?.map((l, j) => {
        const id = l.sticker ? refId(i + 1, `line:${j}`) : undefined;
        return id ? { ...l, sticker: { asset: id } } : l;
      });
      // Hình Đạo diễn AI tải về đã thành asset: visuals (đường dẫn file tạm) được thay bằng id asset theo đúng thứ tự
      return {
        ...s,
        image: null,
        visuals: undefined,
        library_image: first,
        extra_assets: extra,
        ...(lines ? { lines } : {}),
        ...(s.overlay && overlayId ? { overlay: { ...s.overlay, ref: { asset: overlayId } } } : {}),
      };
    }),
  };
  const video = {
    srcPath: result.video.path,
    thumbPath: result.video.thumbnail && fs.existsSync(result.video.thumbnail) ? result.video.thumbnail : null,
    ext: ".mp4",
    size: (await fsp.stat(result.video.path)).size,
    title: result.video.title,
    // Giấy phép Creative Commons yêu cầu ghi công: thêm nguồn vào mô tả video (dùng khi đăng)
    description: withHashtags(
      result.credits?.length ? `${result.video.description}\n\nNguồn hình ảnh:\n${result.credits.map((c) => `- ${c}`).join("\n")}` : result.video.description,
      // Engine đã bổ sung hashtag khi AI viết thiếu; đây là lớp bảo đảm cuối cho kịch bản cũ/sửa tay
      ensureHashtags([result.video.hashtags], [script.hashtags, script.steps.flatMap((s) => s.hashtags ?? []), textHashtags(result.video.title)]),
    ),
    kind: "generated" as const,
    duration: result.video.duration,
    width: result.video.width,
    height: result.video.height,
    script: storedScript,
    ...promptOf(JSON.parse(job.input) as JobInput, job.topic),
    jobId: job.id,
  };
  const files = await moveVideoFiles(video);
  try {
    db().transaction((tx) => {
      insertVideo(video, files);
      const link = (assetId: string, step: number, position: number) =>
        tx.insert(videoAssets).values({ videoId: files.id, assetId, step, position }).onConflictDoNothing().run();
      for (const [step, byPosition] of stepAssets) {
        for (const [position, assetId] of byPosition) {
          if (getAsset(assetId)) link(assetId, step, position);
        }
      }
      for (const l of extraLinks) {
        if (getAsset(l.id)) link(l.id, l.step, l.position);
      }
      // Nhạc nền gắn với video ở "bước 0"
      const musicId = (JSON.parse(job.input) as JobInput).musicId;
      if (musicId && getAsset(musicId)) link(musicId, 0, 0);
      if (job.contactId && tx.select({ one: sql`1` }).from(contacts).where(eq(contacts.id, job.contactId)).get()) {
        tx.insert(contactVideos).values({ contactId: job.contactId, videoId: files.id }).onConflictDoNothing().run();
      }
    });
  } catch (e) {
    await removeMedia(files.file, files.thumb);
    throw e;
  }
  return files.id;
}
