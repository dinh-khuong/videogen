import "server-only";
import { spawn } from "node:child_process";
import type { EngineHealth } from "@/lib/types";
import { ENGINE_DIR, PYTHON_BIN } from "./paths";

/** Môi trường cho tiến trình Python: ép UTF-8 và không đệm stdout để nhận sự kiện ngay. */
export function engineEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
}

export function engineArgs(...args: string[]): string[] {
  return ["-m", "videogen", ...args];
}

/** Chạy một lệnh ngắn của engine (probe, doctor) và lấy stdout. */
export function runEngine(args: string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, engineArgs(...args), { cwd: ENGINE_DIR, env: engineEnv() });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`Không chạy được Python (${PYTHON_BIN}): ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export type ProbeInfo = {
  file: string;
  kind?: "image" | "video";
  width?: number;
  height?: number;
  duration?: number;
  thumbnail?: string;
  error?: string;
};

/** Đọc kích thước/thời lượng và tạo thumbnail (<thumbDir>/<tên file>.jpg) cho nhiều file trong một lần gọi. */
export async function probe(files: string[], thumbDir?: string): Promise<ProbeInfo[]> {
  if (!files.length) return [];
  const args = ["probe", ...files, ...(thumbDir ? ["--thumbnail-dir", thumbDir] : [])];
  const { stdout, stderr } = await runEngine(args, 120_000);
  try {
    return JSON.parse(stdout.trim().split("\n").pop() || "[]") as ProbeInfo[];
  } catch {
    throw new Error(`Engine probe lỗi: ${(stderr || stdout).slice(-500)}`);
  }
}

let healthCache: { at: number; value: EngineHealth } | null = null;

export async function engineHealth(force = false): Promise<EngineHealth> {
  if (!force && healthCache && Date.now() - healthCache.at < 60_000) return healthCache.value;
  let value: EngineHealth;
  try {
    const { stdout, stderr } = await runEngine(["doctor"], 30_000);
    try {
      value = JSON.parse(stdout.trim().split("\n").pop() || "");
    } catch {
      value = { ok: false, problems: [`Engine lỗi: ${(stderr || stdout).slice(-400) || "không có phản hồi"}`] };
    }
  } catch (e) {
    value = { ok: false, problems: [(e as Error).message] };
  }
  healthCache = { at: Date.now(), value };
  return value;
}
