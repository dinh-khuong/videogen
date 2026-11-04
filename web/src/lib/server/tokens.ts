import "server-only";
import crypto from "node:crypto";
import { isTokenProvider, maskToken, providerMeta, type TokenProvider } from "@/lib/token-providers";
import type { TokenCheckStatus, TokenItem } from "@/lib/types";
import { db, nowIso } from "./db";
import { HttpError } from "./files";

type TokenRow = {
  id: string;
  provider: string;
  name: string;
  value: string;
  active: number;
  note: string;
  options: string;
  last_status: TokenCheckStatus | null;
  last_message: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

const MAX_VALUE_CHARS = 600;
const MAX_NAME_CHARS = 60;
const MAX_NOTE_CHARS = 200;
const MAX_OPTION_CHARS = 200;
const CHECK_TIMEOUT_MS = 20_000;

function toItem(r: TokenRow): TokenItem {
  const provider = r.provider as TokenProvider;
  return {
    id: r.id,
    provider,
    name: r.name,
    masked: maskToken(r.value, providerMeta(provider).secret !== false),
    active: r.active === 1,
    note: r.note,
    options: parseOptions(r.options),
    lastStatus: r.last_status,
    lastMessage: r.last_message,
    lastCheckedAt: r.last_checked_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Thiết lập đã lưu (JSON { khóa: giá trị }); dữ liệu hỏng coi như chưa đặt. */
function parseOptions(raw: string): Record<string, string> {
  try {
    const data = JSON.parse(raw) as unknown;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === "string" && v));
    }
  } catch {
    // JSON hỏng: bỏ qua
  }
  return {};
}

/** Thiết lập hợp lệ của dịch vụ: chỉ giữ khóa dịch vụ khai báo, bỏ giá trị trống, kiểm tra model và địa chỉ API. */
function cleanOptions(provider: TokenProvider, raw: unknown): Record<string, string> {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const meta of providerMeta(provider).options ?? []) {
    const value = String(input[meta.key] ?? "").trim();
    if (!value) continue;
    if (value.length > MAX_OPTION_CHARS) throw new HttpError(400, `${meta.label} quá dài (tối đa ${MAX_OPTION_CHARS} ký tự)`);
    if (/\s/.test(value)) throw new HttpError(400, `${meta.label} không được chứa khoảng trắng`);
    if (meta.kind === "url") {
      let protocol = "";
      try {
        protocol = new URL(value).protocol;
      } catch {
        // không phải địa chỉ
      }
      if (protocol !== "http:" && protocol !== "https:") throw new HttpError(400, `${meta.label} phải là địa chỉ dạng https://...`);
    }
    out[meta.key] = value;
  }
  return out;
}

function getRow(id: string): TokenRow | undefined {
  return db().prepare("SELECT * FROM api_tokens WHERE id = ?").get(id) as TokenRow | undefined;
}

export function listTokens(): TokenItem[] {
  const rows = db().prepare("SELECT * FROM api_tokens ORDER BY provider, created_at").all() as TokenRow[];
  return rows.filter((r) => isTokenProvider(r.provider)).map(toItem);
}

export function getToken(id: string): TokenItem | null {
  const row = getRow(id);
  return row && isTokenProvider(row.provider) ? toItem(row) : null;
}

function cleanValue(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!value) throw new HttpError(400, "Hãy nhập token");
  if (/\s/.test(value)) throw new HttpError(400, "Token không được chứa khoảng trắng hoặc xuống dòng");
  if (value.length > MAX_VALUE_CHARS) throw new HttpError(400, `Token quá dài (tối đa ${MAX_VALUE_CHARS} ký tự)`);
  return value;
}

const cleanText = (raw: unknown, max: number): string => String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Chọn một token làm token đang dùng của dịch vụ (các token khác của dịch vụ đó thôi dùng). */
function activate(id: string, provider: string): void {
  db().prepare("UPDATE api_tokens SET active = (id = ?) WHERE provider = ?").run(id, provider);
}

export function createToken(input: {
  provider: unknown;
  value: unknown;
  name?: unknown;
  note?: unknown;
  options?: unknown;
  active?: unknown;
}): TokenItem {
  if (!isTokenProvider(input.provider)) throw new HttpError(400, "Dịch vụ không hợp lệ");
  const provider = input.provider;
  const value = cleanValue(input.value);
  const options = cleanOptions(provider, input.options);
  const existing = (db().prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE provider = ?").get(provider) as { n: number }).n;
  const name = cleanText(input.name, MAX_NAME_CHARS) || `${providerMeta(provider).label} ${existing + 1}`;
  const id = crypto.randomUUID();
  db().transaction(() => {
    db().prepare("INSERT INTO api_tokens (id, provider, name, value, note, options) VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      provider,
      name,
      value,
      cleanText(input.note, MAX_NOTE_CHARS),
      JSON.stringify(options),
    );
    // Token đầu tiên của dịch vụ được dùng luôn; các token sau chỉ khi người dùng chọn
    if (existing === 0 || input.active === true) activate(id, provider);
  })();
  return toItem(getRow(id)!);
}

export function updateToken(
  id: string,
  patch: { name?: unknown; value?: unknown; note?: unknown; options?: unknown; active?: unknown },
): TokenItem | null {
  const current = getRow(id);
  if (!current) return null;
  const value = patch.value === undefined || patch.value === "" ? current.value : cleanValue(patch.value);
  const name = patch.name === undefined ? current.name : cleanText(patch.name, MAX_NAME_CHARS) || current.name;
  const note = patch.note === undefined ? current.note : cleanText(patch.note, MAX_NOTE_CHARS);
  const options = patch.options === undefined ? parseOptions(current.options) : cleanOptions(current.provider as TokenProvider, patch.options);
  db().transaction(() => {
    // Đổi giá trị hoặc model thì kết quả kiểm tra cũ không còn đúng
    const changed = value !== current.value || JSON.stringify(options) !== JSON.stringify(parseOptions(current.options));
    db()
      .prepare(
        `UPDATE api_tokens SET name = ?, value = ?, note = ?, options = ?, updated_at = ?,
         last_status = CASE WHEN ? THEN NULL ELSE last_status END,
         last_message = CASE WHEN ? THEN NULL ELSE last_message END,
         last_checked_at = CASE WHEN ? THEN NULL ELSE last_checked_at END
         WHERE id = ?`,
      )
      .run(name, value, note, JSON.stringify(options), nowIso(), +changed, +changed, +changed, id);
    if (patch.active === true) activate(id, current.provider);
    else if (patch.active === false) db().prepare("UPDATE api_tokens SET active = 0 WHERE id = ?").run(id);
  })();
  return getToken(id);
}

/** Xóa token. Đang xóa token đang dùng thì token cũ nhất còn lại của dịch vụ đó được dùng thay để job không bị mất key. */
export function deleteToken(id: string): boolean {
  const current = getRow(id);
  if (!current) return false;
  db().transaction(() => {
    db().prepare("DELETE FROM api_tokens WHERE id = ?").run(id);
    if (current.active === 1) {
      const next = db().prepare("SELECT id FROM api_tokens WHERE provider = ? ORDER BY created_at LIMIT 1").get(current.provider) as
        | { id: string }
        | undefined;
      if (next) activate(next.id, current.provider);
    }
  })();
  return true;
}

/** Giá trị token đang dùng của một dịch vụ (undefined nếu chưa có). */
export function activeTokenValue(provider: TokenProvider): string | undefined {
  const row = db().prepare("SELECT value FROM api_tokens WHERE provider = ? AND active = 1").get(provider) as { value: string } | undefined;
  return row?.value;
}

/** Biến môi trường của các token đang dùng (vd DEEPSEEK_API_KEY, DEEPSEEK_MODEL) — truyền cho tiến trình engine, ưu tiên hơn engine/.env. */
export function tokenEnv(): Record<string, string> {
  const rows = db().prepare("SELECT provider, value, options FROM api_tokens WHERE active = 1").all() as {
    provider: string;
    value: string;
    options: string;
  }[];
  const env: Record<string, string> = {};
  for (const r of rows) {
    if (!isTokenProvider(r.provider)) continue;
    const meta = providerMeta(r.provider);
    env[meta.env] = r.value;
    const options = parseOptions(r.options);
    for (const o of meta.options ?? []) if (options[o.key]) env[o.env] = options[o.key];
  }
  return env;
}

// ---- Kiểm tra token bằng một lời gọi thử tới dịch vụ ----

type Check = { status: TokenCheckStatus; message: string };

async function http(url: string, init: RequestInit = {}): Promise<{ res: Response; text: string }> {
  const res = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  return { res, text: await res.text() };
}

/** Câu lỗi ngắn từ phản hồi của dịch vụ (JSON { error | message | detail } hoặc đầu nội dung), dạng ": ...". */
function detailOf(text: string): string {
  let detail = text.trim();
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const pick = (v: unknown): string | undefined =>
      typeof v === "string" ? v : v && typeof v === "object" ? pick((v as Record<string, unknown>).message ?? (v as Record<string, unknown>).detail) : undefined;
    detail = pick(data.error) ?? pick(data.message) ?? pick(data.detail) ?? detail;
  } catch {
    // không phải JSON: dùng nguyên văn
  }
  detail = detail.replace(/\s+/g, " ").slice(0, 140);
  return detail ? `: ${detail}` : "";
}

function byStatus(res: Response, text: string, okMessage: string): Check {
  if (res.ok) return { status: "ok", message: okMessage };
  // 429: dịch vụ nhận ra token nhưng đang giới hạn tốc độ
  if (res.status === 429) return { status: "ok", message: "Token hợp lệ nhưng đang bị giới hạn tốc độ (HTTP 429), thử lại sau." };
  const invalid = [400, 401, 402, 403, 422].includes(res.status);
  return { status: invalid ? "invalid" : "error", message: `${invalid ? "Không dùng được" : "Dịch vụ lỗi"} (HTTP ${res.status})${detailOf(text)}` };
}

const DEFAULT_DEEPSEEK_BASE = "https://api.deepseek.com";

const trimSlash = (url: string) => url.replace(/\/+$/, "");

/** Danh sách id model trong phản hồi `GET {base}/models` (kiểu OpenAI; Gemini thêm tiền tố "models/"), không trùng, đã sắp xếp. */
function modelIds(text: string): string[] {
  try {
    const data = JSON.parse(text) as { data?: unknown };
    const list = Array.isArray(data.data) ? data.data : [];
    const ids = list.map((m) => (m as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === "string" && !!id);
    return [...new Set(ids.map((id) => id.replace(/^models\//, "")))].sort();
  } catch {
    return [];
  }
}

async function fetchModels(base: string, key: string): Promise<{ res: Response; text: string; ids: string[] }> {
  const { res, text } = await http(`${trimSlash(base)}/models`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
  return { res, text, ids: res.ok ? modelIds(text) : [] };
}

/** Các model người dùng đã chọn cho token (vd model viết kịch bản, model Đạo diễn AI), không trùng. */
function chosenModels(provider: TokenProvider, options: Record<string, string>): string[] {
  const metas = providerMeta(provider).options ?? [];
  return [...new Set(metas.filter((o) => o.kind === "model").map((o) => options[o.key]).filter(Boolean))];
}

/** Token đã dùng được thì kiểm tra thêm các model đã chọn có trên dịch vụ không (dịch vụ không liệt kê được model thì bỏ qua). */
function checkModels(provider: TokenProvider, options: Record<string, string>, check: Check, ids: string[]): Check {
  const chosen = chosenModels(provider, options);
  if (check.status !== "ok" || !chosen.length || !ids.length) return check;
  const missing = chosen.filter((m) => !ids.includes(m.replace(/^models\//, "")));
  if (missing.length) return { status: "invalid", message: `Token dùng được nhưng dịch vụ không có model ${missing.join(", ")}.` };
  return { status: "ok", message: `${check.message.replace(/\.?$/, ".")} Model ${chosen.join(", ")} có trên dịch vụ.` };
}

async function deepseekAccess(key: string, base: string): Promise<Check> {
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  const balance = await http(`${base}/user/balance`, { headers });
  if (balance.res.ok) {
    try {
      const data = JSON.parse(balance.text) as { is_available?: boolean; balance_infos?: { currency: string; total_balance: string }[] };
      const amount = data.balance_infos?.map((b) => `${b.total_balance} ${b.currency}`).join(", ");
      if (data.is_available === false) return { status: "invalid", message: `Hết số dư${amount ? ` (${amount})` : ""}: cần nạp thêm.` };
      return { status: "ok", message: amount ? `Dùng được. Số dư: ${amount}` : "Dùng được." };
    } catch {
      return { status: "ok", message: "Dùng được." };
    }
  }
  // Máy chủ tương thích OpenAI khác (đổi địa chỉ API) có thể không có /user/balance
  if (balance.res.status === 404) {
    const models = await http(`${base}/models`, { headers });
    return byStatus(models.res, models.text, "Dùng được.");
  }
  return byStatus(balance.res, balance.text, "Dùng được.");
}

const CHECKS: Partial<Record<TokenProvider, (key: string, options: Record<string, string>) => Promise<Check>>> = {
  async deepseek(key, options) {
    const base = trimSlash(options.base_url || process.env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE);
    const check = await deepseekAccess(key, base);
    if (check.status !== "ok" || !chosenModels("deepseek", options).length) return check;
    return checkModels("deepseek", options, check, (await fetchModels(base, key)).ids);
  },

  async vision(key, options) {
    if (!options.base_url) return { status: "error", message: "Chưa có địa chỉ API: điền ở mục \"Địa chỉ API\" rồi kiểm tra lại." };
    const { res, text, ids } = await fetchModels(options.base_url, key);
    const check = byStatus(res, text, "Dùng được.");
    if (check.status === "ok" && !options.model) {
      return { status: "ok", message: "Dùng được, nhưng chưa chọn model nên mô hình thị giác chưa được bật." };
    }
    return checkModels("vision", options, check, ids);
  },

  async fpt(key) {
    const { res, text } = await http("https://api.fpt.ai/hmi/tts/v5", {
      method: "POST",
      headers: { "api-key": key, voice: "banmai", speed: "0", format: "mp3" },
      body: "Xin chào",
    });
    let data: { error?: number; message?: string } = {};
    try {
      data = JSON.parse(text);
    } catch {
      // phản hồi không phải JSON
    }
    if (res.ok && (data.error ?? 0) === 0) return { status: "ok", message: "Dùng được (đã đọc thử 8 ký tự)." };
    if (res.ok || res.status === 401 || res.status === 403) {
      return { status: "invalid", message: `Không dùng được${data.message ? `: ${data.message}` : ` (HTTP ${res.status})`}` };
    }
    return byStatus(res, text, "Dùng được.");
  },

  async pexels(key) {
    const { res, text } = await http("https://api.pexels.com/v1/search?query=nature&per_page=1", { headers: { Authorization: key } });
    return byStatus(res, text, "Dùng được.");
  },

  async pixabay(key) {
    const { res, text } = await http(`https://pixabay.com/api/?key=${encodeURIComponent(key)}&q=cat&per_page=3`);
    return byStatus(res, text, "Dùng được.");
  },

  async brave(key) {
    const { res, text } = await http("https://api.search.brave.com/res/v1/images/search?q=cat&count=1", {
      headers: { "X-Subscription-Token": key, Accept: "application/json" },
    });
    return byStatus(res, text, "Dùng được.");
  },

  async serper(key) {
    const { res, text } = await http("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q: "cat", num: 1 }),
    });
    return byStatus(res, text, "Dùng được.");
  },

  async google(key) {
    const cse = activeTokenValue("google_cse") ?? process.env.GOOGLE_CSE_ID;
    if (!cse) return { status: "error", message: "Chưa có Google CSE ID: thêm ở mục \"Google CSE ID\" rồi kiểm tra lại." };
    const { res, text } = await http(
      `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cse)}&q=cat&num=1`,
    );
    return byStatus(res, text, "Dùng được.");
  },

  async youtube(key) {
    const { res, text } = await http(
      `https://www.googleapis.com/youtube/v3/videos?part=id&chart=mostPopular&maxResults=1&key=${encodeURIComponent(key)}`,
    );
    return byStatus(res, text, "Dùng được.");
  },
};

/** Kiểm tra token bằng một lời gọi thử rồi lưu kết quả. Thông điệp lỗi của dịch vụ không bao giờ chứa token. */
export async function testToken(id: string): Promise<TokenItem | null> {
  const row = getRow(id);
  if (!row || !isTokenProvider(row.provider)) return null;
  const check = CHECKS[row.provider];
  if (!providerMeta(row.provider).testable || !check) throw new HttpError(400, "Dịch vụ này chưa hỗ trợ kiểm tra tự động");
  let result: Check;
  try {
    result = await check(row.value, parseOptions(row.options));
  } catch (e) {
    const timeout = (e as Error).name === "TimeoutError";
    result = { status: "error", message: timeout ? "Dịch vụ không phản hồi kịp (quá 20 giây)." : `Không kết nối được tới dịch vụ: ${(e as Error).message}` };
  }
  const message = result.message.split(row.value).join("***").slice(0, 300);
  db()
    .prepare("UPDATE api_tokens SET last_status = ?, last_message = ?, last_checked_at = ? WHERE id = ?")
    .run(result.status, message, nowIso(), id);
  return getToken(id);
}

/**
 * Danh sách model có trên dịch vụ AI để người dùng chọn (`GET {địa chỉ API}/models`).
 * Dùng token đang nhập (`value`) hoặc token đã lưu (`id`); địa chỉ API lấy từ `baseUrl`, rồi từ token đã lưu.
 */
export async function listModels(input: { provider: unknown; id?: unknown; value?: unknown; baseUrl?: unknown }): Promise<string[]> {
  if (!isTokenProvider(input.provider) || !providerMeta(input.provider).options?.some((o) => o.kind === "model")) {
    throw new HttpError(400, "Dịch vụ này không có lựa chọn model");
  }
  const provider = input.provider;
  const stored = typeof input.id === "string" && input.id ? getRow(input.id) : undefined;
  if (stored && stored.provider !== provider) throw new HttpError(400, "Token không thuộc dịch vụ này");
  const typed = String(input.value ?? "").trim();
  const key = typed ? cleanValue(typed) : stored?.value;
  if (!key) throw new HttpError(400, "Hãy nhập token trước để tải danh sách model");
  const typedUrl = String(input.baseUrl ?? "").trim();
  const base =
    (typedUrl ? cleanOptions(provider, { base_url: typedUrl }).base_url : undefined) ??
    (stored ? parseOptions(stored.options).base_url : undefined) ??
    (provider === "deepseek" ? process.env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE : undefined);
  if (!base) throw new HttpError(400, "Hãy nhập địa chỉ API trước để tải danh sách model");
  let result: { res: Response; text: string; ids: string[] };
  try {
    result = await fetchModels(base, key);
  } catch (e) {
    const timeout = (e as Error).name === "TimeoutError";
    throw new HttpError(502, timeout ? "Dịch vụ không phản hồi kịp (quá 20 giây)." : `Không kết nối được tới dịch vụ: ${(e as Error).message.split(key).join("***")}`);
  }
  if (!result.res.ok) {
    throw new HttpError(502, `Không lấy được danh sách model (HTTP ${result.res.status})${detailOf(result.text).split(key).join("***")}`);
  }
  if (!result.ids.length) throw new HttpError(502, "Dịch vụ không trả về danh sách model nào. Bạn vẫn có thể tự nhập tên model.");
  return result.ids;
}
