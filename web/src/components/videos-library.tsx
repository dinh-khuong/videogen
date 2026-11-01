"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { useApi } from "@/lib/client";
import type { Page, VideoItem } from "@/lib/types";
import { VideoCard } from "./cards";
import { UploadList, useUploads } from "./images-library";
import { LibraryFilters } from "./library-filters";
import { Button, EmptyState, ErrorBox, Loading, PageHeader, inputClass } from "./ui";

const PAGE_SIZE = 48;

export function VideosLibrary() {
  const params = useSearchParams();
  const [filter, setFilter] = useState({ q: "", tag: params.get("tag") ?? "" });
  const [kind, setKind] = useState(params.get("kind") ?? "");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const fileInput = useRef<HTMLInputElement>(null);

  const query = new URLSearchParams({ limit: String(limit) });
  if (filter.q) query.set("q", filter.q);
  if (filter.tag) query.set("tag", filter.tag);
  if (kind) query.set("kind", kind);
  const { data, error, loading, reload } = useApi<Page<VideoItem>>(`/api/videos?${query}`);
  const onUploaded = useCallback(() => void reload(), [reload]);
  const { uploads, start, clear } = useUploads("/api/videos", onUploaded);
  const onFilter = useCallback((next: { q: string; tag: string }) => {
    setFilter(next);
    setLimit(PAGE_SIZE);
  }, []);

  return (
    <>
      <PageHeader
        title="Thư viện video"
        subtitle={`${data?.total ?? 0} video · Video tải lên (vd gameplay) dùng làm nền cho bố cục Shorts chia đôi.`}
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              accept="video/*,.mov,.mkv"
              multiple
              hidden
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                if (files.length) void start(files, { description: "#gameplay" });
              }}
            />
            <Button onClick={() => fileInput.current?.click()}>Tải video nền lên</Button>
          </>
        }
      />
      <UploadList uploads={uploads} onClear={clear} />
      <LibraryFilters kind="videos" q={filter.q} tag={filter.tag} onChange={onFilter}>
        <select className={`${inputClass} w-auto!`} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Mọi loại</option>
          <option value="generated">Video AI tạo</option>
          <option value="upload">Video tải lên</option>
        </select>
      </LibraryFilters>
      <ErrorBox message={error} onRetry={() => void reload()} />
      {loading && !data ? (
        <Loading />
      ) : data?.items.length ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.items.map((v) => (
              <VideoCard key={v.id} video={v} />
            ))}
          </div>
          {data.total > data.items.length && (
            <div className="mt-6 text-center">
              <Button onClick={() => setLimit((l) => l + PAGE_SIZE)}>Xem thêm ({data.total - data.items.length})</Button>
            </div>
          )}
        </>
      ) : (
        <EmptyState title={filter.q || filter.tag || kind ? "Không có video phù hợp" : "Chưa có video nào"}>
          Vào “Tạo video” để AI tạo video đầu tiên.
        </EmptyState>
      )}
    </>
  );
}
