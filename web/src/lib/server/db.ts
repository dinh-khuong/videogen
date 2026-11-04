import "server-only";
import Database from "better-sqlite3";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { LEGACY_MIGRATIONS } from "./legacy-migrations";
import { DB_PATH, MIGRATIONS_DIR, ensureDirs } from "./paths";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

function open(): Database.Database {
  ensureDirs();
  const client = new Database(DB_PATH);
  client.pragma("journal_mode = WAL");
  client.pragma("foreign_keys = ON");
  client.pragma("busy_timeout = 5000");
  return client;
}

/**
 * Database tạo từ hệ migration cũ (PRAGMA user_version) chưa có bảng theo dõi của Drizzle: nâng lên schema cuối của hệ cũ
 * rồi ghi nhận migration nền (0000) là đã áp dụng, vì schema đó chính là thứ nó tạo. Database mới (user_version = 0)
 * không cần làm gì: migration nền tạo toàn bộ bảng.
 */
function adoptLegacy(client: Database.Database): void {
  const version = client.pragma("user_version", { simple: true }) as number;
  const tracked = client.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get();
  if (version === 0 || tracked) return;
  for (let v = version; v < LEGACY_MIGRATIONS.length; v++) {
    client.transaction(() => {
      client.exec(LEGACY_MIGRATIONS[v]);
      client.pragma(`user_version = ${v + 1}`);
    })();
  }
  const [baseline] = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
  client.transaction(() => {
    // Giống hệt bảng Drizzle tự tạo, để migrate() dùng tiếp
    client.exec(`CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`);
    client.prepare(`INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)`).run(baseline.hash, baseline.folderMillis);
  })();
}

const globalForDb = globalThis as unknown as { __videogenDb?: Database.Database };
// Mỗi lần module được nạp lại (hot-reload khi dev) chạy migrate một lần nữa để nhận migration mới; migrate() bỏ qua bước đã áp dụng
let ready: Db | null = null;

/** Kết nối SQLite dùng chung cho cả server (giữ qua hot-reload khi dev), đã áp dụng mọi migration. */
export function db(): Db {
  if (!ready) {
    const client = (globalForDb.__videogenDb ??= open());
    adoptLegacy(client);
    const orm = drizzle(client, { schema });
    migrate(orm, { migrationsFolder: MIGRATIONS_DIR });
    ready = orm;
  }
  return ready;
}

/**
 * `column IN (...)` cho danh sách dài tùy ý: truyền cả danh sách thành một tham số JSON thay vì mỗi giá trị một tham số,
 * để không chạm giới hạn số tham số của SQLite. Danh sách rỗng cho kết quả rỗng.
 */
export function inList(column: SQLWrapper, values: readonly (string | number)[]): SQL {
  return sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
