import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { claimPendingAssets, failAnalysis, requeueInterruptedAnalysis, saveAnalysis } from "./assets";
import { EVENT_PREFIX, engineArgs, engineEnv, killTree } from "./engine";
import { ENGINE_DIR, PYTHON_BIN, TMP_DIR, ensureDirs } from "./paths";

const BATCH_SIZE = 6;
const BATCH_TIMEOUT_MS = 15 * 60_000;
const LANGUAGE = "tiếng Việt";

type AssetEvent = {
  type: string;
  id?: string;
  status?: "done" | "failed";
  ocr_text?: string;
  summary?: string;
  tags?: string[];
  error?: string | null;
};

/**
 * Hàng đợi phân tích asset: đọc chữ (OCR) + AI tóm tắt nội dung để AI chọn asset khi viết kịch bản.
 * Mỗi lượt chạy `python -m videogen analyze --spec` cho một nhóm asset trong tiến trình riêng, song song với job dựng video.
 */
class AssetAnalyzer {
  private child: ChildProcess | null = null;
  private started = false;
  private listeners = new Set<() => void>();

  start(): void {
    if (this.started) return;
    this.started = true;
    ensureDirs();
    requeueInterruptedAnalysis();
    process.once("exit", () => {
      if (this.child) killTree(this.child, "SIGKILL");
    });
    this.tick();
  }

  /** Báo có asset mới cần phân tích. */
  kick(): void {
    this.start();
    this.tick();
  }

  /** Gọi sau mỗi lượt phân tích xong (vd để job đang chờ asset được chạy tiếp). */
  onBatchDone(listener: () => void): void {
    this.listeners.add(listener);
  }

  private tick(): void {
    if (this.child) return;
    const items = claimPendingAssets(BATCH_SIZE);
    if (!items.length) return;
    const ids = items.map((i) => i.id);
    const specPath = path.join(TMP_DIR, `analyze-${crypto.randomUUID()}.json`);
    fs.writeFileSync(specPath, JSON.stringify({ language: LANGUAGE, items }));

    const child = spawn(PYTHON_BIN, engineArgs("analyze", "--spec", specPath), {
      cwd: ENGINE_DIR,
      env: engineEnv(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    const tail: string[] = [];
    let error: string | null = null;
    const timer = setTimeout(() => {
      error = "Phân tích quá lâu, đã dừng";
      killTree(child, "SIGKILL");
    }, BATCH_TIMEOUT_MS);

    const onLine = (line: string) => {
      if (!line.startsWith(EVENT_PREFIX)) {
        if (line.trim()) tail.push(line);
        if (tail.length > 20) tail.shift();
        return;
      }
      try {
        const event = JSON.parse(line.slice(EVENT_PREFIX.length)) as AssetEvent;
        if (event.type === "asset" && event.id && event.status) {
          saveAnalysis({ ...event, id: event.id, status: event.status });
        }
      } catch {
        // dòng hỏng: bỏ qua
      }
    };
    readline.createInterface({ input: child.stdout! }).on("line", onLine);
    readline.createInterface({ input: child.stderr! }).on("line", onLine);

    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      fs.rm(specPath, { force: true }, () => {});
      // Asset chưa có kết quả (engine lỗi giữa chừng) -> đánh dấu lỗi để người dùng bấm phân tích lại
      failAnalysis(ids, error || tail.slice(-4).join("\n") || `Engine thoát với mã ${code}`);
      this.child = null;
      for (const listener of this.listeners) listener();
      setImmediate(() => this.tick());
    };
    child.on("error", (e) => {
      error = `Không chạy được Python (${PYTHON_BIN}): ${e.message}`;
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
  }
}

const globalForAnalyzer = globalThis as unknown as { __videogenAnalyzer?: AssetAnalyzer };

export function analyzer(): AssetAnalyzer {
  if (!globalForAnalyzer.__videogenAnalyzer) globalForAnalyzer.__videogenAnalyzer = new AssetAnalyzer();
  globalForAnalyzer.__videogenAnalyzer.start();
  return globalForAnalyzer.__videogenAnalyzer;
}
