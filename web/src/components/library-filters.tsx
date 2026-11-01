"use client";

import { useEffect, useState } from "react";
import { useApi } from "@/lib/client";
import type { TagCount } from "@/lib/types";
import { inputClass } from "./ui";

/** Ô tìm kiếm (trễ 300ms) + chọn tag. kind quyết định tag nào được liệt kê. */
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

  const options = (tags.data ?? []).filter((t) => t[kind] > 0);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <input
        type="search"
        className={`${inputClass} max-w-xs`}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <select className={`${inputClass} w-auto!`} value={tag} onChange={(e) => onChange({ q: text, tag: e.target.value })}>
        <option value="">Tất cả tag</option>
        {tag && !options.some((o) => o.name === tag) && <option value={tag}>#{tag}</option>}
        {options.map((t) => (
          <option key={t.name} value={t.name}>
            #{t.name} ({t[kind]})
          </option>
        ))}
      </select>
      {children}
    </div>
  );
}
