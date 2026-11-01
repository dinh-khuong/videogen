import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { analyzer } from "./analyzer";
import { db, nowIso } from "./db";
import { EVENT_PREFIX, engineArgs, engineEnv, killTree } from "./engine";
import { ingestResult, type EngineResult } from "./ingest";
import { buildSpec, getJobRow, jobDir, updateJob, waitsForAnalysis, type JobRow } from "./jobs";
import { ENGINE_DIR, PYTHON_BIN, TMP_DIR, ensureDirs } from "./paths";

const CONCURRENCY = Math.max(1, Number(process.env.JOB_CONCURRENCY) || 1);
const PROGRESS_WRITE_MS = 600;
const KILL_GRACE_MS = 5000;
const WAIT_RECHECK_MS = 5000;
const WAIT_MESSAGE = "Đang chờ phân tích asset (đọc chữ + AI tóm tắt)";

type Running = {
  child: ChildProcess;
  log: fs.WriteStream;
  canceled: boolean;
  done: boolean;
  result: EngineResult | null;
  error: string | null;
  tail: string[];
  lastWrite: number;
  lastStage: string | null;
  pending: { progress: number; stage: string | null; message: string | null } | null;
  flushTimer: NodeJS.Timeout | null;
};

/**
 * Hàng đợi job tạo video. Mỗi job chạy engine Python trong một tiến trình riêng
 * (`python -m videogen job spec.json`), đọc sự kiện tiến độ từ stdout và cập nhật SQLite.
 */
class JobRunner {
  private running = new Map<string, Running>();
  private started = false;
  private waitTimer: NodeJS.Timeout | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;
    ensureDirs();
    // Job đang chạy dở khi server tắt không thể tiếp tục (tiến trình engine của nó đã dừng)
    const stale = db().prepare("SELECT id, pid FROM jobs WHERE status = 'running'").all() as { id: string; pid: number | null }[];
    for (const job of stale) {
      if (job.pid && isAlive(job.pid)) continue;
      updateJob(job.id, {
        status: "failed",
        error: "Server đã dừng khi job đang chạy. Bấm \"Chạy lại\" để thử lại.",
        finished_at: nowIso(),
        pid: null,
      });
    }
    process.once("exit", () => this.killAll("SIGKILL"));
    cleanTmp();
    // Phân tích asset xong có thể mở khóa job đang chờ
    analyzer().onBatchDone(() => this.tick());
    this.tick();
  }

  /** Báo có job mới trong hàng đợi. */
  kick(): void {
    this.start();
    this.tick();
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  cancel(id: string): boolean {
    const r = this.running.get(id);
    if (r) {
      r.canceled = true;
      killTree(r.child, "SIGTERM");
      setTimeout(() => {
        if (!r.done) killTree(r.child, "SIGKILL");
      }, KILL_GRACE_MS).unref();
      return true;
    }
    const res = db()
      .prepare("UPDATE jobs SET status = 'canceled', finished_at = ?, message = 'Đã hủy' WHERE id = ? AND status = 'queued'")
      .run(nowIso(), id);
    return res.changes > 0;
  }

  private tick(): void {
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
    if (this.running.size >= CONCURRENCY) return;
    const queued = db().prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at").all() as JobRow[];
    let waiting = false;
    for (const row of queued) {
      if (this.running.size >= CONCURRENCY) break;
      // AI cần tóm tắt + chữ trong asset để chọn/viết về asset: chờ phân tích xong (có giới hạn thời gian)
      if (waitsForAnalysis(row)) {
        waiting = true;
        if (row.message !== WAIT_MESSAGE) updateJob(row.id, { message: WAIT_MESSAGE });
        continue;
      }
      this.launch(row.id);
    }
    if (waiting) this.waitTimer = setTimeout(() => this.tick(), WAIT_RECHECK_MS).unref();
  }

  private launch(id: string): void {
    // Nhận job một cách nguyên tử để không bao giờ chạy trùng một job
    const claimed = db()
      .prepare(
        `UPDATE jobs SET status = 'running', started_at = ?, progress = 0, stage = 'script',
         message = 'Đang khởi động engine', error = NULL WHERE id = ? AND status = 'queued'`,
      )
      .run(nowIso(), id);
    if (!claimed.changes) return;
    const row = getJobRow(id)!;
    const dir = jobDir(id);
    fs.mkdirSync(dir, { recursive: true });

    let specPath: string;
    try {
      specPath = path.join(dir, "spec.json");
      fs.writeFileSync(specPath, JSON.stringify(buildSpec(row), null, 2));
    } catch (e) {
      updateJob(id, { status: "failed", error: (e as Error).message, finished_at: nowIso() });
      return;
    }

    const log = fs.createWriteStream(path.join(dir, "log.txt"), { flags: "a" });
    log.write(`\n=== ${nowIso()} — ${PYTHON_BIN} ${engineArgs("job", specPath).join(" ")}\n`);
    const child = spawn(PYTHON_BIN, engineArgs("job", specPath), {
      cwd: ENGINE_DIR,
      env: engineEnv(),
      // Tiến trình con làm trưởng nhóm để hủy được cả ffmpeg do nó sinh ra
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const state: Running = {
      child,
      log,
      canceled: false,
      done: false,
      result: null,
      error: null,
      tail: [],
      lastWrite: 0,
      lastStage: null,
      pending: null,
      flushTimer: null,
    };
    this.running.set(id, state);
    if (child.pid) updateJob(id, { pid: child.pid });

    const onLine = (line: string) => {
      if (line.startsWith(EVENT_PREFIX)) {
        this.onEvent(id, state, line.slice(EVENT_PREFIX.length));
        return;
      }
      if (!line.trim()) return;
      log.write(line + "\n");
      state.tail.push(line);
      if (state.tail.length > 30) state.tail.shift();
    };
    readline.createInterface({ input: child.stdout! }).on("line", onLine);
    readline.createInterface({ input: child.stderr! }).on("line", onLine);

    child.on("error", (e) => {
      state.error = `Không chạy được Python (${PYTHON_BIN}): ${e.message}. Kiểm tra PYTHON_BIN trong web/.env.local`;
      void this.finish(id, state, -1);
    });
    child.on("close", (code) => void this.finish(id, state, code ?? -1));
  }

  private onEvent(id: string, state: Running, json: string): void {
    let event: { type: string; stage?: string; progress?: number; message?: string; result?: EngineResult };
    try {
      event = JSON.parse(json);
    } catch {
      return;
    }
    if (event.type === "progress") {
      // Ghi DB tối đa ~2 lần/giây; sự kiện bị gộp vẫn được ghi sau đó để không mất thông điệp cuối
      const write = () => {
        if (state.done || !state.pending) return;
        const p = state.pending;
        state.pending = null;
        state.lastWrite = Date.now();
        state.lastStage = p.stage;
        updateJob(id, { progress: p.progress, stage: p.stage, message: p.message });
      };
      state.pending = { progress: event.progress ?? 0, stage: event.stage ?? null, message: event.message ?? null };
      const wait = PROGRESS_WRITE_MS - (Date.now() - state.lastWrite);
      if (event.stage !== state.lastStage || wait <= 0) {
        write();
      } else if (!state.flushTimer) {
        state.flushTimer = setTimeout(() => {
          state.flushTimer = null;
          write();
        }, wait);
      }
    } else if (event.type === "result" && event.result) {
      state.result = event.result;
    } else if (event.type === "error") {
      state.error = event.message ?? "Lỗi không xác định";
      state.log.write(`LỖI: ${state.error}\n`);
    }
  }

  private async finish(id: string, state: Running, code: number): Promise<void> {
    if (state.done) return;
    state.done = true;
    if (state.flushTimer) clearTimeout(state.flushTimer);
    try {
      if (state.canceled) {
        updateJob(id, { status: "canceled", message: "Đã hủy", finished_at: nowIso(), pid: null });
      } else if (code === 0 && state.result) {
        updateJob(id, { stage: "save", message: "Đang lưu vào thư viện", progress: 1 });
        const videoId = await ingestResult(getJobRow(id)!, state.result);
        updateJob(id, { status: "succeeded", video_id: videoId, message: "Hoàn tất", finished_at: nowIso(), pid: null });
      } else {
        const error = state.error || state.tail.slice(-6).join("\n") || `Engine thoát với mã ${code}`;
        updateJob(id, { status: "failed", error, finished_at: nowIso(), pid: null });
      }
    } catch (e) {
      state.log.write(`LỖI lưu kết quả: ${(e as Error).stack}\n`);
      updateJob(id, { status: "failed", error: `Lỗi lưu kết quả: ${(e as Error).message}`, finished_at: nowIso(), pid: null });
    } finally {
      state.log.end();
      this.running.delete(id);
      this.tick();
    }
  }

  private killAll(signal: NodeJS.Signals): void {
    for (const r of this.running.values()) killTree(r.child, signal);
  }
}

/** Xóa file tạm còn sót (upload bị ngắt giữa chừng...) cũ hơn một ngày. */
function cleanTmp(): void {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const name of fs.readdirSync(TMP_DIR)) {
    const p = path.join(TMP_DIR, name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // file đang được dùng hoặc đã bị xóa
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const globalForRunner = globalThis as unknown as { __videogenRunner?: JobRunner };

export function runner(): JobRunner {
  if (!globalForRunner.__videogenRunner) globalForRunner.__videogenRunner = new JobRunner();
  globalForRunner.__videogenRunner.start();
  return globalForRunner.__videogenRunner;
}
