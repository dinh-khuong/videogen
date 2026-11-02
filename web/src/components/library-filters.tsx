"use client";

import { useEffect, useRef, useState } from "react";
import { useApi } from "@/lib/client";
import { normalizeTag, splitTags } from "@/lib/hashtags";
import type { TagCount } from "@/lib/types";
import { cx, inputClass } from "./ui";

const MAX_LISTED = 200;

/**
 * Chọn nhiều tag: nút mở danh sách có ô tìm + checkbox; tag đã chọn hiện thành chip bấm × để bỏ.
 * Kết quả lọc là các mục có ít nhất một tag đã chọn.
 */
export function TagPicker({
  options,
  value,
  onChange,
  placeholder = "Tất cả tag",
}: {
  options: { name: string; count: number }[];
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected = new Set(value);
  const needle = normalizeTag(query);
  // Tag đã chọn nhưng không còn trong danh sách (vd từ đường dẫn ?tag=) vẫn hiện để bỏ chọn được
  const all = [...value.filter((t) => !options.some((o) => o.name === t)).map((name) => ({ name, count: 0 })), ...options];
  const listed = all.filter((o) => !needle || o.name.includes(needle)).slice(0, MAX_LISTED);
  const toggle = (name: string) => onChange(selected.has(name) ? value.filter((t) => t !== name) : [...value, name]);

  return (
    <div ref={ref} className="relative flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cx(inputClass, "w-auto! flex items-center gap-2 text-left", value.length > 0 && "ring-brand-500")}
      >
        <span className={value.length ? "text-zinc-900" : "text-zinc-500"}>
          {value.length ? `${value.length} tag đã chọn` : placeholder}
        </span>
        <span aria-hidden className="text-xs text-zinc-400">
          ▾
        </span>
      </button>
      {value.map((tag) => (
        <button
          key={tag}
          type="button"
          onClick={() => toggle(tag)}
          className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 ring-1 ring-brand-100 hover:bg-brand-100"
          title="Bỏ tag này"
        >
          #{tag} ×
        </button>
      ))}
      {open && (
        <div className="absolute top-full left-0 z-30 mt-1 w-72 rounded-xl bg-surface p-2 shadow-lg ring-1 ring-zinc-200">
          <input
            type="search"
            autoFocus
            className={inputClass}
            placeholder="Tìm tag..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className="scroll-thin mt-2 max-h-64 overflow-auto">
            {listed.map((o) => (
              <li key={o.name}>
                <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-800 hover:bg-zinc-50">
                  <input type="checkbox" className="accent-brand-500" checked={selected.has(o.name)} onChange={() => toggle(o.name)} />
                  <span className="min-w-0 flex-1 truncate">#{o.name}</span>
                  {o.count > 0 && <span className="text-xs tabular-nums text-zinc-400">{o.count}</span>}
                </label>
              </li>
            ))}
            {!listed.length && <li className="px-2 py-1.5 text-sm text-zinc-500">Không có tag phù hợp</li>}
          </ul>
          <div className="mt-2 flex items-center justify-between border-t border-zinc-100 px-1 pt-2 text-xs text-zinc-500">
            <span>Hiện mục có ít nhất một tag đã chọn</span>
            {value.length > 0 && (
              <button type="button" onClick={() => onChange([])} className="font-medium text-brand-600 hover:underline">
                Bỏ chọn
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Ô tìm kiếm (trễ 300ms) + chọn nhiều tag. `tag` là các tag cách nhau bằng dấu phẩy (đúng dạng tham số của API). */
export function LibraryFilters({
  kind,
  q,
  tag,
  onChange,
  placeholder = "Tìm theo tên, mô tả...",
  children,
}: {
  kind: "assets" | "videos" | "contacts";
  q: string;
  tag: string;
  onChange: (next: { q: string; tag: string }) => void;
  placeholder?: string;
  children?: React.ReactNode;
}) {
  const tags = useApi<TagCount[]>("/api/tags");
  const [text, setText] = useState(q);
  useEffect(() => {
    if (text === q) return;
    const t = setTimeout(() => onChange({ q: text, tag }), 300);
    return () => clearTimeout(t);
  }, [text, q, tag, onChange]);

  const options = (tags.data ?? []).filter((t) => t[kind] > 0).map((t) => ({ name: t.name, count: t[kind] }));
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <input
        type="search"
        className={`${inputClass} max-w-xs`}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {children}
      <TagPicker options={options} value={splitTags(tag)} onChange={(next) => onChange({ q: text, tag: next.join(",") })} />
    </div>
  );
}
