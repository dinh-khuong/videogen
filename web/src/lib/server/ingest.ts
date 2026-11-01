import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { withHashtags } from "@/lib/hashtags";
import type { JobInput, Script } from "@/lib/types";
import { analyzer } from "./analyzer";
import { addAssets, findAssetBySha1, getAsset, type NewAsset } from "./assets";
import { db } from "./db";
import { extOf, removeMedia, sha1File } from "./files";
import type { JobRow } from "./jobs";
import { TMP_DIR } from "./paths";
import { insertVideo, moveVideoFiles } from "./videos";

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
  }[];
};

/**
 * Đưa kết quả của job vào thư viện: ảnh mới (tìm trên mạng) thành asset có mô tả + hashtag (rồi được phân tích như
 * asset khác), video chuyển vào thư mục media, liên kết asset theo từng bước và với khách hàng (nếu có). Trả về id video.
 */
export async function ingestResult(job: JobRow, result: EngineResult): Promise<string> {
  if (!result.video || !fs.existsSync(result.video.path)) throw new Error("Engine không tạo ra file video");
  const script = result.script;
  const stepAssets = new Map<number, string>();
  const pending: { step: number; asset: NewAsset }[] = [];

  for (const img of result.images) {
    if (img.kind === "placeholder") continue;
    if (img.kind === "library" && img.library_id && getAsset(img.library_id)) {
      stepAssets.set(img.step, img.library_id);
      continue;
    }
    if (!fs.existsSync(img.path)) continue;
    const sha1 = await sha1File(img.path);
    const existing = findAssetBySha1(sha1);
    if (existing) {
      stepAssets.set(img.step, existing);
      continue;
    }
    const ext = extOf(img.path) || ".jpg";
    const tmp = path.join(/* turbopackIgnore: true */ TMP_DIR, `${crypto.randomUUID()}${ext}`);
    await fsp.copyFile(/* turbopackIgnore: true */ img.path, tmp);
    const step = script.steps[img.step - 1];
    const queryNote = img.query ? `\nTừ khóa tìm kiếm: ${img.query}` : "";
    const credit = img.credit;
    const creditNote = credit?.license
      ? `\nNguồn: ${[credit.source, credit.author, credit.license].filter(Boolean).join(" — ")} (${credit.url})`
      : "";
    pending.push({
      step: img.step,
      asset: {
        tmpPath: tmp,
        ext,
        sha1,
        size: (await fsp.stat(/* turbopackIgnore: true */ tmp)).size,
        title: step?.heading || script.title,
        description: withHashtags(`${step?.narration ?? ""}${queryNote}${creditNote}`, step?.hashtags ?? []),
        source: img.credit?.source ?? (img.kind === "web" ? "web" : "upload"),
        sourceUrl: img.credit?.url ?? null,
      },
    });
  }
  const added = await addAssets(pending.map((p) => p.asset));
  pending.forEach((p, i) => stepAssets.set(p.step, added[i].id));
  if (added.some((a) => !a.existed)) analyzer().kick();

  // Lưu kịch bản kèm id asset thư viện từng bước để có thể sửa và render lại
  const storedScript: Script = {
    ...script,
    steps: script.steps.map((s, i) => ({ ...s, image: null, library_image: stepAssets.get(i + 1) ?? null })),
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
      result.video.hashtags,
    ),
    kind: "generated" as const,
    duration: result.video.duration,
    width: result.video.width,
    height: result.video.height,
    script: storedScript,
    jobId: job.id,
  };
  const files = await moveVideoFiles(video);
  try {
    db().transaction(() => {
      insertVideo(video, files);
      const link = db().prepare("INSERT OR IGNORE INTO video_assets (video_id, asset_id, step) VALUES (?, ?, ?)");
      for (const [step, assetId] of stepAssets) {
        if (getAsset(assetId)) link.run(files.id, assetId, step);
      }
      // Nhạc nền gắn với video ở "bước 0"
      const musicId = (JSON.parse(job.input) as JobInput).musicId;
      if (musicId && getAsset(musicId)) link.run(files.id, musicId, 0);
      if (job.contact_id && db().prepare("SELECT 1 FROM contacts WHERE id = ?").get(job.contact_id)) {
        db().prepare("INSERT OR IGNORE INTO contact_videos (contact_id, video_id) VALUES (?, ?)").run(job.contact_id, files.id);
      }
    })();
  } catch (e) {
    await removeMedia(files.file, files.thumb);
    throw e;
  }
  return files.id;
}
