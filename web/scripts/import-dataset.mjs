// Nhập ảnh từ dataset (Hugging Face hoặc thư mục trên máy) vào Assets của web app đang chạy.
//   npm run import-dataset -- not-lain/meme-dataset [--limit 100] [--tag meme] [--split train]
// Dùng cùng Python với server (PYTHON_BIN, hoặc engine/.venv) và địa chỉ http://localhost:$PORT (mặc định 3000).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engineDir = path.resolve(process.env.ENGINE_DIR || path.join(webDir, "..", "engine"));

function python() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  for (const venv of [".venv", "venv"]) {
    const bin = path.join(engineDir, venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    if (fs.existsSync(bin)) return bin;
  }
  return process.platform === "win32" ? "python" : "python3";
}

const args = process.argv.slice(2);
if (!args.length || args.includes("-h") || args.includes("--help")) {
  console.log("Dùng: npm run import-dataset -- <dataset> [--limit N] [--tag tên] [--split train] [--server URL] [--out thư-mục]");
  console.log("Ví dụ: npm run import-dataset -- not-lain/meme-dataset --limit 200 --tag meme");
  if (!args.length) process.exit(1);
}
if (!args.some((a) => a === "--server" || a.startsWith("--server=") || a === "--out" || a.startsWith("--out="))) {
  args.push(`--server=http://localhost:${process.env.PORT || 3000}`);
}
const bin = python();
console.log(`Python: ${bin}`);
const child = spawn(bin, ["-m", "videogen", "import-dataset", ...args], {
  cwd: engineDir,
  stdio: "inherit",
  env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
});
child.on("error", (e) => {
  console.error(`Không chạy được Python (${bin}): ${e.message}. Cài engine trước: pip install -r engine/requirements.txt`);
  process.exit(1);
});
child.on("close", (code) => process.exit(code ?? 1));
