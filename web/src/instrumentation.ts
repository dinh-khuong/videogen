/** Khởi động hàng đợi job ngay khi server chạy, để job còn trong hàng đợi tiếp tục mà không cần mở trang. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { runner } = await import("./lib/server/runner");
  runner();
}
