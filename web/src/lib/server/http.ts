import "server-only";
import { connection } from "next/server";
import { HttpError } from "./files";

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function notFound(message = "Không tìm thấy"): Response {
  return json({ error: message }, 404);
}

/**
 * Bọc route handler: luôn chạy lúc request (dữ liệu SQLite không được prerender),
 * lỗi trả về JSON { error } với mã HTTP phù hợp.
 */
export function route<A extends unknown[]>(fn: (...args: A) => Promise<Response> | Response) {
  return async (...args: A): Promise<Response> => {
    await connection();
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      if (e instanceof SyntaxError) return json({ error: "Dữ liệu gửi lên không hợp lệ" }, 400);
      console.error(e);
      return json({ error: `Lỗi máy chủ: ${(e as Error).message}` }, 500);
    }
  };
}

export async function readJson<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

export function searchParams(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

export function intParam(value: string | null, fallback?: number): number | undefined {
  const n = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
