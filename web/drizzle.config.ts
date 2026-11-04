import path from "node:path";
import { defineConfig } from "drizzle-kit";

// Dùng cho `npm run db:generate` (sinh migration từ src/lib/server/schema.ts) và `npm run db:studio` (xem/sửa dữ liệu).
// DATA_DIR giống paths.ts: mặc định <gốc dự án>/data.
const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "..", "data"));

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/lib/server/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: path.join(dataDir, "app.db") },
});
