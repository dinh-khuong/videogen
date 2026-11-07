import "server-only";
import fs from "node:fs";
import path from "node:path";

// web/ chạy từ thư mục web, gốc dự án là thư mục cha. Dữ liệu nằm ngoài web/ nên bỏ qua khi Turbopack
// truy vết file cho bản build (không đưa thư mục data/ vào output).
const PROJECT_ROOT = path.resolve(/* turbopackIgnore: true */ process.cwd(), "..");

export const DATA_DIR = path.resolve(/* turbopackIgnore: true */ process.env.DATA_DIR || path.join(PROJECT_ROOT, "data"));
export const MEDIA_DIR = path.join(DATA_DIR, "media");
export const JOBS_DIR = path.join(DATA_DIR, "jobs");
export const TMP_DIR = path.join(DATA_DIR, "tmp");
/** File tạo lại được (vd mẫu nghe thử giọng đọc), xóa thoải mái. */
export const CACHE_DIR = path.join(DATA_DIR, "cache");
export const DB_PATH = path.join(DATA_DIR, "app.db");
/** File migration SQL do drizzle-kit sinh (web/drizzle), áp dụng khi mở database. */
export const MIGRATIONS_DIR = path.resolve(/* turbopackIgnore: true */ process.cwd(), "drizzle");

export const ENGINE_DIR = path.resolve(/* turbopackIgnore: true */ process.env.ENGINE_DIR || path.join(PROJECT_ROOT, "engine"));
/** Engine dựng hình bằng ManimGL; dùng chung Python (PYTHON_BIN) và code của ENGINE_DIR (videogen_core, videogen). */
export const MANIM_ENGINE_DIR = path.resolve(
  /* turbopackIgnore: true */ process.env.MANIM_ENGINE_DIR || path.join(PROJECT_ROOT, "engine-manim"),
);

function defaultPython(): string {
  for (const venv of [".venv", "venv"]) {
    const bin = path.join(ENGINE_DIR, venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    if (fs.existsSync(bin)) return bin;
  }
  return process.platform === "win32" ? "python" : "python3";
}

export const PYTHON_BIN = process.env.PYTHON_BIN || defaultPython();

export const MEDIA_SUBDIRS = ["assets", "images", "videos", "thumbs"] as const;
export type MediaSubdir = (typeof MEDIA_SUBDIRS)[number];

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, JOBS_DIR, TMP_DIR, CACHE_DIR, ...MEDIA_SUBDIRS.map((d) => path.join(MEDIA_DIR, d))]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Đường dẫn tuyệt đối của file media từ đường dẫn tương đối lưu trong DB (vd "images/abc.jpg"). */
export function mediaPath(rel: string): string {
  const abs = path.resolve(MEDIA_DIR, rel);
  if (!abs.startsWith(MEDIA_DIR + path.sep)) throw new Error("Đường dẫn media không hợp lệ");
  return abs;
}

export function mediaUrl(rel: string | null | undefined): string | null {
  return rel ? `/api/files/${rel}` : null;
}
