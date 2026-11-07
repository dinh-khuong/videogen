// Chạy trước `npm run dev` / `npm run start`: dừng sớm nếu Node khác bản major trong .nvmrc.
// better-sqlite3 được build cho đúng bản Node đó; chạy bằng bản khác sẽ segfault ngay khi mở DB.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wanted = fs.readFileSync(path.join(webDir, ".nvmrc"), "utf8").trim().replace(/^v/, "").split(".")[0];
const current = process.versions.node.split(".")[0];

if (current !== wanted) {
  console.error(
    `\nĐang chạy Node ${process.versions.node}, nhưng web/ cần Node ${wanted} (.nvmrc).\n` +
      `better-sqlite3 sẽ segfault khi mở DB. Chuyển Node rồi chạy lại:\n\n` +
      `  nvm use            # trong thư mục web/\n` +
      `  nvm alias default ${wanted}   # để shell mới mặc định dùng Node ${wanted}\n`,
  );
  process.exit(1);
}
