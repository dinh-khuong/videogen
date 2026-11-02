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
