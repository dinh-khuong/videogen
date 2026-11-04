const HASHTAG = /#([\p{L}\p{N}_]+)/gu;

/** Lấy danh sách hashtag (chữ thường, không trùng) từ đoạn mô tả. */
export function parseHashtags(text: string): string[] {
  const tags = new Set<string>();
  for (const m of text.matchAll(HASHTAG)) tags.add(m[1].toLowerCase());
  return [...tags];
}

/** Chuẩn hóa một tag người dùng gõ (bỏ #, khoảng trắng, ký tự lạ). */
export function normalizeTag(tag: string): string {
  return tag.replace(/^#+/, "").toLowerCase().replace(/[^\p{L}\p{N}_]/gu, "");
}

/** Danh sách tag từ chuỗi cách nhau bằng dấu phẩy ("meme,meo") — dạng tham số `tag` của các API lọc. */
export function splitTags(value: string | null | undefined): string[] {
  return [...new Set((value ?? "").split(",").map(normalizeTag).filter(Boolean))];
}

/** Mô tả + dòng hashtag ở cuối (bỏ các tag đã có trong mô tả). */
export function withHashtags(description: string, tags: string[]): string {
  const existing = new Set(parseHashtags(description));
  const extra = tags.map(normalizeTag).filter((t) => t && !existing.has(t));
  if (!extra.length) return description.trim();
  return `${description.trim()}\n\n${extra.map((t) => `#${t}`).join(" ")}`.trim();
}

/** Số hashtag tối thiểu / tối đa của một asset. */
export const ASSET_HASHTAG_MIN = 5;
export const ASSET_HASHTAG_MAX = 12;

/** Từ nối/từ chung không đáng làm hashtag (tiếng Anh của từ khóa tìm ảnh và vài từ tiếng Việt hay gặp). */
const STOP_WORDS = new Set(
  ("the a an of in on at to for with and or is are into from by as it its this that up down out over away near " +
    "va la cua cho khi nhu the nao gi cach nhung mot nhieu trong co khong duoc voi cac day nay do den tu de ve")
    .split(" "),
);

/** Từ trong chuỗi (từ khóa tìm kiếm, tiêu đề) thành hashtag: bỏ từ nối, từ quá ngắn, số trơn và dấu. */
export function textHashtags(text: string | null | undefined): string[] {
  const tags: string[] = [];
  for (const word of (text ?? "").split(/[^\p{L}\p{N}]+/u)) {
    const tag = normalizeTag(word.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/gi, "d"));
    if (tag.length >= 3 && !/^\d+$/.test(tag) && !STOP_WORDS.has(tag) && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/**
 * Gộp các nguồn hashtag theo thứ tự ưu tiên (đứng trước = quan trọng hơn), bỏ trùng và tag rỗng, cắt ở `max`.
 * Mỗi nguồn là danh sách tag đã có sẵn (có hoặc không có dấu #).
 */
export function mergeHashtags(sources: (string[] | null | undefined)[], max = ASSET_HASHTAG_MAX): string[] {
  const out: string[] = [];
  for (const source of sources) {
    for (const tag of source ?? []) {
      const t = normalizeTag(tag);
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out.slice(0, max);
}

/** Hashtag chính (do AI đặt), thiếu so với `min` thì bổ sung dần từ các nguồn dự phòng theo thứ tự. */
export function ensureHashtags(
  primary: (string[] | null | undefined)[],
  fallbacks: (string[] | null | undefined)[],
  min = ASSET_HASHTAG_MIN,
  max = ASSET_HASHTAG_MAX,
): string[] {
  const out = mergeHashtags(primary, max);
  for (const source of fallbacks) {
    for (const t of mergeHashtags([source], max)) {
      if (out.length >= min) return out;
      if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}
