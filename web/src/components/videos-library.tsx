"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useCallback, useState } from "react";
import { useApi } from "@/lib/client";
import type { Page, VideoItem } from "@/lib/types";
import { VideoCard } from "./cards";
import { LibraryFilters } from "./library-filters";
import { Button, EmptyState, ErrorBox, Loading, PageHeader, buttonClass } from "./ui";

const PAGE_SIZE = 48;

export function VideosLibrary() {
  const params = useSearchParams();
  const [filter, setFilter] = useState({ q: "", tag: params.get("tag") ?? "" });
  const [limit, setLimit] = useState(PAGE_SIZE);

  const query = new URLSearchParams({ limit: String(limit) });
  if (filter.q) query.set("q", filter.q);
  if (filter.tag) query.set("tag", filter.tag);
  const { data, error, loading, reload } = useApi<Page<VideoItem>>(`/api/videos?${query}`);
  const onFilter = useCallback((next: { q: string; tag: string }) => {
    setFilter(next);
    setLimit(PAGE_SIZE);
  }, []);

  return (
    <>
      <PageHeader
        title="Thư viện video"
        subtitle={<>{data?.total ?? 0} video do AI tạo. Ảnh và video nguồn (kể cả video nền chia đôi) nằm ở <Link href="/assets" className="text-brand-600 underline">Assets</Link>.</>}
        actions={
          <Link href="/create" className={buttonClass("primary")}>
            + Tạo video
          </Link>
        }
      />
      <LibraryFilters kind="videos" q={filter.q} tag={filter.tag} onChange={onFilter} />
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
        <EmptyState title={filter.q || filter.tag ? "Không có video phù hợp" : "Chưa có video nào"}>
          Vào “Tạo video” để AI tạo video đầu tiên.
        </EmptyState>
      )}
    </>
  );
}
