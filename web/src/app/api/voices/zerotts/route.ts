import { runEngine } from "@/lib/server/engine";
import { json, route } from "@/lib/server/http";
import type { Voice } from "@/lib/video-options";

type EngineVoice = { name: string; label: string; gender: string; description: string };

const globalCache = globalThis as unknown as { __zerottsVoices?: Voice[] };
/** Nhiều trang cùng hỏi lúc mô hình đang tải: chỉ chạy engine một lần. */
let inflight: Promise<{ voices: Voice[]; error?: string }> | null = null;

async function load(): Promise<{ voices: Voice[]; error?: string }> {
  // Lần đầu engine tải mô hình ZeroTTS (~900 MB) nên cho phép chạy lâu
  const { stdout, stderr } = await runEngine(["zerotts-voices"], 900_000);
  try {
    const data = JSON.parse(stdout.trim().split("\n").pop() || "{}") as { ok?: boolean; voices?: EngineVoice[]; error?: string };
    if (!data.ok || !data.voices) return { voices: [], error: data.error || "Không lấy được danh sách giọng ZeroTTS" };
    const voices = data.voices.map((v) => ({
      value: `zerotts:${v.name}`,
      label: `${v.label || v.name}${v.gender ? ` (${v.gender})` : ""}`,
    }));
    globalCache.__zerottsVoices = voices;
    return { voices };
  } catch {
    return { voices: [], error: `Engine lỗi: ${(stderr || stdout).slice(-300)}` };
  }
}

/** Các giọng có trong mô hình ZeroTTS (lưu lại sau lần đầu; ?refresh=1 để hỏi lại engine). */
export const GET = route(async (request: Request) => {
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  if (globalCache.__zerottsVoices && !refresh) return json({ voices: globalCache.__zerottsVoices });
  inflight ??= load().finally(() => (inflight = null));
  return json(await inflight);
});
