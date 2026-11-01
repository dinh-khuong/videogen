/** Khởi động hàng đợi job và hàng đợi phân tích asset ngay khi server chạy, không cần mở trang. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { runner } = await import("./lib/server/runner");
  const { analyzer } = await import("./lib/server/analyzer");
  runner();
  analyzer();
}
