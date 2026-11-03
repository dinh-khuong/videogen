"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Gọi API JSON; lỗi trả về dạng { error } được ném ra thành Error với thông điệp tiếng Việt. */
export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: json !== undefined ? { "Content-Type": "application/json", ...rest.headers } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // phản hồi không phải JSON
  }
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error || `Lỗi ${res.status}`;
    throw new Error(message);
  }
  return data as T;
}

/**
 * Tải dữ liệu từ API, tự tải lại theo chu kỳ (refreshMs) nếu cần. url = null để tạm dừng.
 * shouldRefresh(data) = false thì ngừng tải lại theo chu kỳ (vd job đã xong).
 */
export function useApi<T>(url: string | null, options: { refreshMs?: number; shouldRefresh?: (data: T) => boolean } = {}) {
  // Giữ dữ liệu của url trước trong lúc tải url mới để giao diện không nhấp nháy khi lọc
  const [state, setState] = useState<{ url: string | null; data: T | null; error: string | null }>({
    url: null,
    data: null,
    error: null,
  });
  const urlRef = useRef(url);
  const dataRef = useRef<T | null>(null);
  const shouldRefreshRef = useRef(options.shouldRefresh);
  useEffect(() => {
    urlRef.current = url;
    dataRef.current = state.data;
    shouldRefreshRef.current = options.shouldRefresh;
  });

  const load = useCallback(async (target: string) => {
    try {
      const data = await api<T>(target);
      if (urlRef.current === target) setState({ url: target, data, error: null });
    } catch (e) {
      if (urlRef.current === target) setState((s) => ({ url: target, data: s.data, error: (e as Error).message }));
    }
  }, []);

  useEffect(() => {
    if (!url) return;
    void load(url);
    if (!options.refreshMs) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const data = dataRef.current;
      if (data !== null && shouldRefreshRef.current && !shouldRefreshRef.current(data)) return;
      void load(url);
    }, options.refreshMs);
    return () => clearInterval(timer);
  }, [url, options.refreshMs, load]);

  const reload = useCallback(async () => {
    if (urlRef.current) await load(urlRef.current);
  }, [load]);

  return { data: state.data, error: state.error, loading: !!url && state.url !== url, reload };
}

/** Đặt tiêu đề tab cho trang chi tiết (dữ liệu tải ở client nên không dùng metadata được). */
export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    if (!title) return;
    // Chủ đề có thể là prompt dài: chỉ lấy dòng đầu, cắt gọn
    const line = title.trim().split("\n")[0];
    document.title = `${line.length > 60 ? `${line.slice(0, 59)}…` : line} · VideoGen Studio`;
  }, [title]);
}

/** Tải file lên bằng XHR để có tiến độ. Body là nội dung file, tham số khác đi trong query string. */
export function uploadFile<T>(
  endpoint: string,
  file: File,
  params: Record<string, string> = {},
  onProgress?: (fraction: number) => void,
): Promise<T> {
  const query = new URLSearchParams({ filename: file.name, ...params });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${endpoint}?${query}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data: { error?: string } | null = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // bỏ qua
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new Error(data?.error || `Lỗi ${xhr.status} khi tải ${file.name}`));
    };
    xhr.onerror = () => reject(new Error(`Mất kết nối khi tải ${file.name}`));
    xhr.send(file);
  });
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "";
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Giây đã trôi qua kể từ một mốc thời gian ISO đến hiện tại. */
export function secondsSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 1000;
}

/** "4 phút 12 giây" / "1 giờ 5 phút" — thời gian chạy job, dễ đọc hơn mm:ss khi kéo dài nhiều phút/giờ. */
export function formatRunTime(seconds: number | null | undefined): string {
  if (seconds == null) return "";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} giờ ${m} phút`;
  if (m > 0) return `${m} phút${sec ? ` ${sec} giây` : ""}`;
  return `${sec} giây`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "";
  if (bytes < 1e6) return `${Math.round(bytes / 1e3)} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

export function formatDate(iso: string | null | undefined, withTime = true): string {
  if (!iso) return "";
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return date.toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "vừa xong";
  if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} ngày trước`;
  return formatDate(iso, false);
}
