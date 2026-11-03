import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runEngine } from "@/lib/server/engine";
import { serveFile } from "@/lib/server/files";
import { json, route, searchParams } from "@/lib/server/http";
import { CACHE_DIR, ensureDirs } from "@/lib/server/paths";
import { VOICE_EFFECTS, VOICE_RE } from "@/lib/video-options";

const RATE_RE = /^[+-]\d{1,3}%$/;
const PITCH_RE = /^[+-]\d{1,3}Hz$/;
/** Tăng khi engine đổi cách tạo giọng: mẫu cũ trong cache không còn giống giọng trong video. */
const SAMPLE_VERSION = "2";

/** Mẫu đang tạo: kéo thanh trượt qua lại có thể gửi trùng một mẫu, chỉ chạy engine một lần cho mỗi mẫu. */
const inflight = new Map<string, Promise<{ ok: true } | { ok: false; error: string }>>();

/**
 * Mẫu nghe thử giọng đọc (mp3), tạo bằng engine qua đúng đường xử lý giọng của video (cùng giọng, tốc độ, cao độ,
 * hiệu ứng) và lưu cache theo các tham số đó.
 */
export const GET = route(async (request: Request) => {
  const p = searchParams(request);
  const voice = p.get("voice") ?? "";
  const rate = p.get("rate") || "+0%";
  const pitch = p.get("pitch") || "+0Hz";
  const language = (p.get("language") || "tiếng Việt").slice(0, 40);
  const effect = p.get("effect") || "none";
  if (!Object.hasOwn(VOICE_EFFECTS, effect)) return json({ error: "Hiệu ứng giọng không hợp lệ" }, 400);
  if (!VOICE_RE.test(voice) || !RATE_RE.test(rate) || !PITCH_RE.test(pitch)) {
    return json({ error: "Giọng, tốc độ hoặc cao độ không hợp lệ" }, 400);
  }
  ensureDirs();
  const key = crypto.createHash("sha1").update([SAMPLE_VERSION, voice, rate, pitch, language, effect].join("|")).digest("hex").slice(0, 16);
  const file = path.join(CACHE_DIR, "voice-samples", `${key}.mp3`);
  if (!fs.existsSync(file)) {
    let job = inflight.get(key);
    if (!job) {
      job = generate(file, { voice, rate, pitch, language, effect }).finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    const done = await job;
    if (!done.ok) return json({ error: done.error }, 502);
  }
  return serveFile(file, request);
});

async function generate(
  file: string,
  p: { voice: string; rate: string; pitch: string; language: string; effect: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { code, stdout, stderr } = await runEngine(
    // Dạng --khóa=giá trị: argparse sẽ hiểu nhầm giá trị âm như "-6Hz" là một tùy chọn
    ["voice-sample", `--voice=${p.voice}`, `--rate=${p.rate}`, `--pitch=${p.pitch}`, `--language=${p.language}`, `--effect=${p.effect}`, `--out=${file}`],
    // ZeroTTS: lần đầu phải tải mô hình ~900 MB và nạp vào bộ nhớ
    p.voice.startsWith("zerotts:") ? 900_000 : 90_000,
  );
  if (code === 0 && fs.existsSync(file)) return { ok: true };
  let message = "Không tạo được giọng mẫu";
  try {
    message = (JSON.parse(stdout.trim().split("\n").pop() || "{}") as { error?: string }).error || message;
  } catch {
    message = `${message}: ${(stderr || stdout).slice(-300)}`;
  }
  const hint =
    message.includes("FPT_AI_API_KEY") || p.voice.startsWith("zerotts:") ? "" : ". Kiểm tra kết nối mạng (giọng đọc cần Internet)";
  return { ok: false, error: `${message}${hint}.` };
}
