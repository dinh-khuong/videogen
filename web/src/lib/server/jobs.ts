import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { JobDetail, JobInput, JobItem, JobStatus, Script } from "@/lib/types";
import { assetFilePath, assetsForEngine, countUnanalyzed } from "./assets";
import { db } from "./db";
import { HttpError } from "./files";
import { JOBS_DIR } from "./paths";
import { getVideo } from "./videos";

export type JobRow = {
  id: string;
  status: JobStatus;
  topic: string;
  input: string;
  progress: number;
  stage: string | null;
  message: string | null;
  error: string | null;
  video_id: string | null;
  contact_id: string | null;
  pid: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export function jobDir(id: string): string {
  return path.join(JOBS_DIR, id);
}

function toItem(r: JobRow): JobItem {
  return {
    id: r.id,
    status: r.status,
    topic: r.topic,
    input: JSON.parse(r.input) as JobInput,
    progress: r.progress,
    stage: r.stage,
    message: r.message,
    error: r.error,
    videoId: r.video_id,
    contactId: r.contact_id,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export function getJobRow(id: string): JobRow | undefined {
  return db().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
}

export function listJobs(query: { status?: string; limit?: number } = {}): JobItem[] {
  const active = query.status === "active";
  const rows = db()
    .prepare(
      `SELECT * FROM jobs ${active ? "WHERE status IN ('queued', 'running')" : query.status ? "WHERE status = ?" : ""}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...(query.status && !active ? [query.status] : []), Math.min(query.limit ?? 50, 500)) as JobRow[];
  return rows.map(toItem);
}

function tailFile(file: string, maxBytes = 24_000): string {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString("utf8");
      return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

export function getJobDetail(id: string): JobDetail | null {
  const row = getJobRow(id);
  if (!row) return null;
  return {
    ...toItem(row),
    log: tailFile(path.join(jobDir(id), "log.txt")),
    video: row.video_id ? getVideo(row.video_id) : null,
  };
}

const ASPECTS = ["16:9", "9:16", "1:1"];
/** Asset dùng làm hình trong từng bước (audio chỉ dùng làm nhạc nền) */
const VISUAL_KINDS = "image,video";
const DEFAULT_MUSIC_VOLUME = 0.12;
/** Chủ đề là prompt cho AI nên cho phép rất dài; giới hạn này chỉ để tránh vô tình dán cả tài liệu khổng lồ. */
export const MAX_TOPIC_CHARS = 30_000;

function validScript(script: unknown): script is Script {
  const s = script as Script;
  return (
    !!s &&
    typeof s.title === "string" &&
    Array.isArray(s.steps) &&
    s.steps.length > 0 &&
    s.steps.length <= 30 &&
    s.steps.every((st) => st && typeof st.narration === "string" && st.narration.trim().length > 0)
  );
}

/** Kiểm tra và chuẩn hóa yêu cầu tạo video từ client. */
export function validateInput(raw: Partial<JobInput>): JobInput {
  const script = raw.script ?? null;
  if (script && !validScript(script)) throw new HttpError(400, "Kịch bản không hợp lệ: mỗi bước cần có lời bình");
  const topic = String(raw.topic ?? script?.title ?? "").trim();
  if (!topic) throw new HttpError(400, "Hãy nhập chủ đề video");
  if (topic.length > MAX_TOPIC_CHARS) {
    throw new HttpError(400, `Chủ đề dài ${topic.length.toLocaleString("vi-VN")} ký tự, tối đa ${MAX_TOPIC_CHARS.toLocaleString("vi-VN")}`);
  }
  const aspect = raw.aspect && ASPECTS.includes(raw.aspect) ? raw.aspect : "16:9";
  const layout = raw.layout === "split" ? "split" : "normal";
  const imageStyle = raw.imageStyle === "cover" || raw.imageStyle === "frame" ? raw.imageStyle : "auto";
  const libraryMode = raw.libraryMode === "auto" || raw.libraryMode === "selected" ? raw.libraryMode : "off";
  const numSteps = raw.numSteps ? Math.round(Number(raw.numSteps)) : null;
  if (numSteps !== null && !(numSteps >= 1 && numSteps <= 15)) throw new HttpError(400, "Số bước phải từ 1 đến 15");
  const rate = raw.rate?.trim() || undefined;
  if (rate && !/^[+-]\d{1,3}%$/.test(rate)) throw new HttpError(400, "Tốc độ đọc dạng +10% hoặc -5%");
  const voice = raw.voice?.trim() || undefined;
  if (voice && !/^[a-z]{2,3}-[A-Z]{2,3}-\w+$/.test(voice)) throw new HttpError(400, "Tên giọng đọc không hợp lệ");

  const assetIds = [...new Set((raw.assetIds ?? []).map(String))].slice(0, 30);
  if (libraryMode === "selected" && !script) {
    if (!assetIds.length) throw new HttpError(400, "Hãy chọn ít nhất một asset trong thư viện");
    const found = assetsForEngine({ ids: assetIds, kind: VISUAL_KINDS, limit: assetIds.length });
    if (found.length !== assetIds.length) throw new HttpError(400, "Một số asset đã chọn không còn trong thư viện (hoặc là audio)");
  }
  const musicId = raw.musicId || null;
  if (musicId && !assetFilePath(musicId, "audio")) throw new HttpError(400, "Không tìm thấy nhạc nền trong Assets");
  const musicVolume = Math.min(Math.max(Number(raw.musicVolume ?? DEFAULT_MUSIC_VOLUME) || 0, 0.01), 1);
  const bgVideoId = layout === "split" ? raw.bgVideoId || null : null;
  if (layout === "split" && (!bgVideoId || !assetFilePath(bgVideoId, "video"))) {
    throw new HttpError(400, "Bố cục chia đôi cần chọn một video nền trong Assets");
  }
  const contactId = raw.contactId || null;
  if (contactId && !db().prepare("SELECT 1 FROM contacts WHERE id = ?").get(contactId)) {
    throw new HttpError(400, "Không tìm thấy khách hàng");
  }
  return {
    topic,
    numSteps: script ? null : numSteps,
    language: raw.language?.trim() || "tiếng Việt",
    voice,
    rate,
    aspect: aspect as JobInput["aspect"],
    layout,
    bgVideoId,
    imageStyle,
    webImages: raw.webImages !== false,
    webMedia: raw.webMedia === "video" || raw.webMedia === "auto" ? raw.webMedia : "image",
    clipsPerStep: Math.min(Math.max(Math.round(Number(raw.clipsPerStep) || 3), 1), 6),
    libraryMode: script ? "off" : libraryMode,
    libraryTag: libraryMode === "auto" ? raw.libraryTag?.trim() || null : null,
    assetIds: libraryMode === "selected" && !script ? assetIds : [],
    musicId,
    musicVolume: musicId ? musicVolume : undefined,
    contactId,
    script,
    sourceVideoId: raw.sourceVideoId || null,
  };
}

export function createJob(input: JobInput): JobItem {
  const id = crypto.randomUUID();
  db()
    .prepare("INSERT INTO jobs (id, topic, input, contact_id, message) VALUES (?, ?, ?, ?, ?)")
    .run(id, input.topic, JSON.stringify(input), input.contactId ?? null, "Đang chờ");
  return toItem(getJobRow(id)!);
}

/** Spec JSON cho `python -m videogen job` (xem engine/videogen/job.py). Dựng lúc chạy để dùng dữ liệu mới nhất. */
export function buildSpec(row: JobRow): Record<string, unknown> {
  const input = JSON.parse(row.input) as JobInput;
  const spec: Record<string, unknown> = {
    work_dir: jobDir(row.id),
    topic: input.topic,
    num_steps: input.numSteps ?? null,
    language: input.language,
    voice: input.voice ?? null,
    rate: input.rate ?? null,
    aspect: input.layout === "split" ? "9:16" : input.aspect,
    image_style: input.imageStyle,
    web_images: input.webImages,
    web_media: input.webMedia ?? "image",
    clips_per_step: input.clipsPerStep ?? 3,
    library_mode: input.libraryMode,
    library: [],
  };
  if (input.layout === "split" && input.bgVideoId) {
    const bg = assetFilePath(input.bgVideoId, "video");
    if (!bg || !fs.existsSync(bg)) throw new Error("Video nền đã bị xóa khỏi Assets");
    spec.bg_video = bg;
  }
  if (input.musicId) {
    const music = assetFilePath(input.musicId, "audio");
    if (!music || !fs.existsSync(music)) throw new Error("Nhạc nền đã bị xóa khỏi Assets");
    spec.music = music;
    spec.music_volume = input.musicVolume ?? DEFAULT_MUSIC_VOLUME;
  }
  if (input.script) {
    // Render lại: asset từng bước lấy theo library_image (id asset thư viện)
    const ids = input.script.steps.flatMap((s) => [s.library_image, ...(s.extra_assets ?? [])]).filter((x): x is string => !!x);
    spec.script = { ...input.script, steps: input.script.steps.map((s) => ({ ...s, image: null })) };
    spec.library = assetsForEngine({ ids, kind: VISUAL_KINDS, limit: ids.length || 1 });
    spec.library_mode = "auto";
  } else if (input.libraryMode === "selected") {
    const ids = selectedAssetIds(input);
    const assets = assetsForEngine({ ids, kind: VISUAL_KINDS, limit: 30 });
    const order = new Map(ids.map((id, i) => [id, i]));
    spec.library = assets.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  } else if (input.libraryMode === "auto") {
    // AI tự chọn: chỉ đưa asset có thông tin (mô tả, tag, tóm tắt AI hoặc chữ đọc được); engine lọc tiếp theo chủ đề
    spec.library = assetsForEngine({ tag: input.libraryTag ?? undefined, kind: VISUAL_KINDS, limit: 300 }).filter(
      (a) => a.description.trim() || a.tags.length || a.summary.trim() || a.ocr_text.trim(),
    );
  }
  return spec;
}

function selectedAssetIds(input: JobInput): string[] {
  return input.assetIds?.length ? input.assetIds : (input.imageIds ?? []);
}

/** Job chờ tối đa chừng này để asset liên quan được phân tích xong (đọc chữ + tóm tắt) trước khi viết kịch bản. */
const ANALYSIS_WAIT_MS = 3 * 60_000;

/** Job có nên chờ phân tích asset không (chỉ khi AI cần đọc thông tin asset để viết kịch bản). */
export function waitsForAnalysis(row: JobRow): boolean {
  if (Date.now() - Date.parse(row.created_at) > ANALYSIS_WAIT_MS) return false;
  const input = JSON.parse(row.input) as JobInput;
  if (input.script) return false;
  if (input.libraryMode === "selected") return countUnanalyzed({ ids: selectedAssetIds(input) }) > 0;
  if (input.libraryMode === "auto") return countUnanalyzed({ tag: input.libraryTag }) > 0;
  return false;
}

export async function deleteJob(id: string): Promise<boolean> {
  const row = getJobRow(id);
  if (!row) return false;
  if (row.status === "running" || row.status === "queued") throw new HttpError(409, "Hãy hủy job trước khi xóa");
  db().prepare("DELETE FROM jobs WHERE id = ?").run(id);
  await fsp.rm(jobDir(id), { recursive: true, force: true });
  return true;
}

export function updateJob(id: string, fields: Partial<Omit<JobRow, "id">>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db()
    .prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => fields[k as keyof typeof fields] ?? null), id);
}
