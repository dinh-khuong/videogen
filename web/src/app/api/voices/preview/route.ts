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

/** Mẫu nghe thử giọng đọc (mp3), tạo bằng engine và lưu cache theo giọng + tốc độ + cao độ + ngôn ngữ. */
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
  const key = crypto.createHash("sha1").update([voice, rate, pitch, language, effect].join("|")).digest("hex").slice(0, 16);
  const file = path.join(CACHE_DIR, "voice-samples", `${key}.mp3`);
  if (!fs.existsSync(file)) {
    const { code, stdout, stderr } = await runEngine(
      // Dạng --khóa=giá trị: argparse sẽ hiểu nhầm giá trị âm như "-6Hz" là một tùy chọn
      ["voice-sample", `--voice=${voice}`, `--rate=${rate}`, `--pitch=${pitch}`, `--language=${language}`, `--effect=${effect}`, `--out=${file}`],
      90_000,
    );
    if (code !== 0 || !fs.existsSync(file)) {
      let message = "Không tạo được giọng mẫu";
      try {
        message = (JSON.parse(stdout.trim().split("\n").pop() || "{}") as { error?: string }).error || message;
      } catch {
        message = `${message}: ${(stderr || stdout).slice(-300)}`;
      }
      const hint = message.includes("FPT_AI_API_KEY") ? "" : ". Kiểm tra kết nối mạng (giọng đọc cần Internet)";
      return json({ error: `${message}${hint}.` }, 502);
    }
  }
  return serveFile(file, request);
});
