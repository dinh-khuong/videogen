"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import { cx } from "./ui";

type ThemePref = "light" | "dark" | "system";

const STORAGE_KEY = "theme";
const CHANGE_EVENT = "videogen:theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Chạy đồng bộ trong <head> trước khi trình duyệt vẽ trang: đặt data-theme theo lựa chọn đã lưu
 * (hoặc theo hệ điều hành) để không bị nháy giao diện sáng khi mở trang ở chế độ tối.
 */
export const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem("${STORAGE_KEY}");var d=p==="dark"||(p!=="light"&&window.matchMedia("${DARK_QUERY}").matches);document.documentElement.setAttribute("data-theme",d?"dark":"light")}catch(e){}})()`;

function readPref(): ThemePref {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function currentTheme(pref: ThemePref): "dark" | "light" {
  return pref === "dark" || (pref === "system" && window.matchMedia(DARK_QUERY).matches) ? "dark" : "light";
}

function applyTheme(pref: ThemePref): void {
  document.documentElement.setAttribute("data-theme", currentTheme(pref));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

function setPref(pref: ThemePref): void {
  try {
    if (pref === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // trình duyệt chặn localStorage: vẫn đổi giao diện cho lần xem này
  }
  applyTheme(pref);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

const OPTIONS: { value: ThemePref; label: string; icon: string }[] = [
  { value: "light", label: "Sáng", icon: "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" },
  { value: "dark", label: "Tối", icon: "M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11Z" },
  { value: "system", label: "Theo hệ thống", icon: "M3 5h18v11H3zM8 20h8M12 16v4" },
];

/** Chọn giao diện Sáng / Tối / Theo hệ thống; lựa chọn lưu trong trình duyệt. */
export function ThemeToggle({ compact }: { compact?: boolean }) {
  const pref = useSyncExternalStore(subscribe, readPref, () => "system" as ThemePref);

  // Áp dụng lại sau khi React dựng lại <html> (dev) và theo dõi hệ điều hành đổi sáng/tối khi chọn "Theo hệ thống"
  useLayoutEffect(() => {
    applyTheme(pref);
    // Phòng khi framework dựng lại <html> và làm mất thuộc tính data-theme
    const observer = new MutationObserver(() => {
      const latest = readPref(); // đọc lại: lựa chọn có thể vừa đổi trước khi React render lại
      if (document.documentElement.getAttribute("data-theme") !== currentTheme(latest)) applyTheme(latest);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => pref === "system" && applyTheme("system");
    media.addEventListener("change", onChange);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", onChange);
    };
  }, [pref]);

  return (
    <div role="radiogroup" aria-label="Giao diện" className={cx("inline-flex rounded-lg bg-zinc-100 p-0.5", !compact && "w-full")}>
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={pref === o.value}
          title={o.label}
          onClick={() => setPref(o.value)}
          className={cx(
            "flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1.5 text-xs font-medium transition-colors",
            pref === o.value ? "bg-surface text-zinc-900 shadow-sm ring-1 ring-zinc-200" : "text-zinc-500 hover:text-zinc-800",
          )}
        >
          <svg viewBox="0 0 24 24" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d={o.icon} />
          </svg>
          {!compact && <span className="truncate">{o.value === "system" ? "Tự động" : o.label}</span>}
        </button>
      ))}
    </div>
  );
}
