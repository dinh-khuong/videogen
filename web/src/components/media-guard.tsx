"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/** Sự kiện yêu cầu mọi nguồn phát (kể cả giọng nghe thử không nằm trong DOM) dừng lại. */
export const PAUSE_MEDIA_EVENT = "videogen:pause-media";

/** Báo các trình phát khác dừng lại khi một nguồn mới bắt đầu phát (mỗi lúc chỉ một tiếng). */
export function pauseOtherMedia(except?: HTMLMediaElement | null) {
  window.dispatchEvent(new CustomEvent(PAUSE_MEDIA_EVENT, { detail: except ?? null }));
}

const VISIBLE_RATIO = 0.25; // video còn hiện ít hơn 25% thì coi như đã thu nhỏ/cuộn khỏi màn hình

function inPictureInPicture(el: HTMLMediaElement) {
  return typeof document !== "undefined" && document.pictureInPictureElement === el;
}

function inFullscreen(el: HTMLMediaElement) {
  const fs = document.fullscreenElement;
  return !!fs && (fs === el || fs.contains(el));
}

/**
 * Không để video/audio tiếp tục kêu khi người dùng không còn xem:
 * - thu nhỏ cửa sổ / chuyển tab (trang bị ẩn),
 * - cuộn hoặc thu nhỏ khiến video gần như khuất khỏi màn hình, khung chứa bị ẩn (display: none),
 * - chuyển trang, đóng hộp thoại (phần tử bị gỡ khỏi trang),
 * - một nguồn khác bắt đầu phát (mỗi lúc chỉ một tiếng).
 * Video đang ở chế độ hình-trong-hình (PiP) hoặc toàn màn hình là người dùng chủ động xem nên được giữ nguyên.
 */
export function MediaGuard() {
  const pathname = usePathname();

  useEffect(() => {
    const all = () => Array.from(document.querySelectorAll<HTMLMediaElement>("video, audio"));
    const pause = (el: HTMLMediaElement) => {
      if (!el.paused && !inPictureInPicture(el) && !inFullscreen(el)) el.pause();
    };

    const onPauseRequest = (e: Event) => {
      const except = (e as CustomEvent<HTMLMediaElement | null>).detail;
      all().forEach((el) => el !== except && pause(el));
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") pauseOtherMedia();
    };

    // "play" không nổi bọt nhưng bắt được ở pha capture
    const onPlay = (e: Event) => {
      const el = e.target;
      if (el instanceof HTMLMediaElement) pauseOtherMedia(el);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLMediaElement;
          if (!entry.isIntersecting || entry.intersectionRatio < VISIBLE_RATIO) pause(el);
        }
      },
      { threshold: [0, VISIBLE_RATIO] },
    );
    const watched = new Set<HTMLMediaElement>();
    const sync = () => {
      for (const el of all()) {
        if (!watched.has(el)) {
          watched.add(el);
          observer.observe(el);
        }
      }
      for (const el of watched) {
        if (!el.isConnected) {
          // Phần tử bị gỡ (đóng hộp thoại, chuyển trang) mà vẫn còn phát: dừng hẳn
          if (!el.paused) el.pause();
          observer.unobserve(el);
          watched.delete(el);
        }
      }
    };
    const mutations = new MutationObserver(sync);
    mutations.observe(document.body, { childList: true, subtree: true });
    sync();

    window.addEventListener(PAUSE_MEDIA_EVENT, onPauseRequest);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("play", onPlay, true);
    window.addEventListener("pagehide", onVisibility);
    return () => {
      window.removeEventListener(PAUSE_MEDIA_EVENT, onPauseRequest);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("play", onPlay, true);
      window.removeEventListener("pagehide", onVisibility);
      mutations.disconnect();
      observer.disconnect();
    };
  }, []);

  // Chuyển trang: dừng mọi thứ đang phát của trang cũ
  useEffect(() => {
    pauseOtherMedia();
  }, [pathname]);

  return null;
}
