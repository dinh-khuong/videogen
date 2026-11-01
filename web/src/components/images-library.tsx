"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { api, formatBytes, formatDate, uploadFile, useApi } from "@/lib/client";
import type { ImageItem, Page } from "@/lib/types";
import { LibraryFilters } from "./library-filters";
import {
  Button,
  ConfirmButton,
  DescriptionInput,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageHeader,
  ProgressBar,
  TagList,
  inputClass,
} from "./ui";

type UploadState = { name: string; progress: number; error?: string; done?: boolean };

export function useUploads(endpoint: string, onUploaded: () => void) {
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const start = useCallback(
    async (files: File[], params: Record<string, string> = {}) => {
      const offset = uploads.length;
      setUploads((u) => [...u, ...files.map((f) => ({ name: f.name, progress: 0 }))]);
      // Tải tuần tự: nhẹ cho máy và báo lỗi rõ từng file
      for (const [i, file] of files.entries()) {
        const patch = (p: Partial<UploadState>) =>
          setUploads((u) => u.map((x, k) => (k === offset + i ? { ...x, ...p } : x)));
        try {
          await uploadFile(endpoint, file, params, (progress) => patch({ progress }));
          patch({ progress: 1, done: true });
          onUploaded();
        } catch (e) {
          patch({ error: (e as Error).message });
        }
      }
    },
    [endpoint, onUploaded, uploads.length],
  );
  const clear = () => setUploads((u) => u.filter((x) => !x.done && !x.error && x.progress < 1));
  return { uploads, start, clear };
}

export function UploadList({ uploads, onClear }: { uploads: UploadState[]; onClear: () => void }) {
  if (!uploads.length) return null;
  const finished = uploads.every((u) => u.done || u.error);
  return (
    <div className="mb-4 space-y-2 rounded-xl bg-white p-3 ring-1 ring-zinc-200">
      {uploads.map((u, i) => (
        <div key={i} className="text-sm">
          <div className="flex justify-between gap-3">
            <span className="truncate text-zinc-700">{u.name}</span>
            <span className={u.error ? "text-red-600" : u.done ? "text-emerald-600" : "text-zinc-500"}>
              {u.error ? "Lỗi" : u.done ? "Xong" : `${Math.round(u.progress * 100)}%`}
            </span>
          </div>
          {u.error ? <p className="text-xs text-red-600">{u.error}</p> : !u.done && <ProgressBar value={u.progress} className="mt-1 h-1.5" />}
        </div>
      ))}
      {finished && (
        <button type="button" onClick={onClear} className="text-xs font-medium text-brand-600 hover:underline">
          Ẩn danh sách
        </button>
      )}
    </div>
  );
}

function ImageEditor({ image, onClose, onChanged }: { image: ImageItem; onClose: () => void; onChanged: () => void }) {
  const [title, setTitle] = useState(image.title);
  const [description, setDescription] = useState(image.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/images/${image.id}`, { method: "PATCH", json: { title, description } });
      onChanged();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div>
        <a href={image.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg bg-zinc-100">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image.url} alt={image.title} className="max-h-[60vh] w-full object-contain" />
        </a>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-zinc-500">
          <dt>Kích thước</dt>
          <dd>
            {image.width}×{image.height} · {formatBytes(image.sizeBytes)}
          </dd>
          <dt>Nguồn</dt>
          <dd className="truncate">
            {image.sourceUrl ? (
              <a href={image.sourceUrl} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">
                {image.source}
              </a>
            ) : (
              image.source
            )}
          </dd>
          <dt>Dùng trong</dt>
          <dd>{image.usedIn} video</dd>
          <dt>Thêm lúc</dt>
          <dd>{formatDate(image.createdAt)}</dd>
        </dl>
      </div>
      <div className="space-y-4">
        <Field label="Tiêu đề">
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Mô tả & hashtag" hint="AI đọc mô tả này để quyết định dùng ảnh cho bước nào — mô tả càng cụ thể càng tốt.">
          <DescriptionInput value={description} onChange={setDescription} rows={6} />
        </Field>
        <ErrorBox message={error} />
        <div className="flex flex-wrap justify-between gap-2">
          <ConfirmButton
            variant="danger"
            confirmLabel="Xóa vĩnh viễn?"
            onConfirm={async () => {
              try {
                await api(`/api/images/${image.id}`, { method: "DELETE" });
                onChanged();
                onClose();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Xóa ảnh
          </ConfirmButton>
          <div className="flex gap-2">
            <a href={`${image.url}?download=${encodeURIComponent(image.title || "anh")}`} className="inline-flex items-center rounded-lg px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-100">
              Tải về
            </a>
            <Button variant="primary" busy={saving} onClick={save}>
              Lưu
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ImageGrid({
  images,
  onOpen,
  selected,
  onTag,
}: {
  images: ImageItem[];
  onOpen: (image: ImageItem) => void;
  selected?: string[];
  onTag?: (tag: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {images.map((img) => {
        const order = selected ? selected.indexOf(img.id) : -1;
        return (
          <div
            key={img.id}
            className={`overflow-hidden rounded-xl bg-white ring-1 ${order >= 0 ? "ring-2 ring-brand-500" : "ring-zinc-200/80"}`}
          >
            <button type="button" onClick={() => onOpen(img)} className="relative block aspect-[4/3] w-full bg-zinc-100">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.thumbUrl} alt={img.title} loading="lazy" className="size-full object-cover" />
              {order >= 0 && (
                <span className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-brand-500 text-xs font-semibold text-white">
                  {order + 1}
                </span>
              )}
              {img.source !== "upload" && (
                <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">{img.source}</span>
              )}
            </button>
            <div className="space-y-1 p-2.5">
              <p className="truncate text-sm font-medium text-zinc-800" title={img.title}>
                {img.title || "(Không tiêu đề)"}
              </p>
              {img.description ? (
                <p className="line-clamp-2 text-xs text-zinc-500">{img.description.replace(/#[\p{L}\p{N}_]+/gu, "").trim() || " "}</p>
              ) : (
                <p className="text-xs italic text-amber-600">Chưa có mô tả</p>
              )}
              <TagList tags={img.tags.slice(0, 4)} onClick={onTag} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

const PAGE_SIZE = 60;

export function ImagesLibrary() {
  const params = useSearchParams();
  const [filter, setFilter] = useState({ q: "", tag: params.get("tag") ?? "" });
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [editing, setEditing] = useState<ImageItem | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const query = new URLSearchParams({ limit: String(limit) });
  if (filter.q) query.set("q", filter.q);
  if (filter.tag) query.set("tag", filter.tag);
  const { data, error, loading, reload } = useApi<Page<ImageItem>>(`/api/images?${query}`);
  const onUploaded = useCallback(() => void reload(), [reload]);
  const { uploads, start, clear } = useUploads("/api/images", onUploaded);
  const onFilter = useCallback((next: { q: string; tag: string }) => {
    setFilter(next);
    setLimit(PAGE_SIZE);
  }, []);

  const addFiles = (files: FileList | null) => {
    const list = [...(files ?? [])].filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name));
    if (list.length) void start(list);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      <PageHeader
        title="Thư viện ảnh"
        subtitle={`${data?.total ?? 0} ảnh · Ảnh tìm trên mạng khi tạo video cũng được lưu tại đây, kèm mô tả và hashtag.`}
        actions={
          <>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ""))} />
            <Button variant="primary" onClick={() => fileInput.current?.click()}>
              Tải ảnh lên
            </Button>
          </>
        }
      />
      {dragging && (
        <div className="mb-4 rounded-xl border-2 border-dashed border-brand-500 bg-brand-50 py-8 text-center text-sm font-medium text-brand-700">
          Thả ảnh vào đây để tải lên
        </div>
      )}
      <UploadList uploads={uploads} onClear={clear} />
      <LibraryFilters kind="images" q={filter.q} tag={filter.tag} onChange={onFilter} />
      <ErrorBox message={error} onRetry={() => void reload()} />
      {loading && !data ? (
        <Loading />
      ) : data?.items.length ? (
        <>
          <ImageGrid images={data.items} onOpen={setEditing} onTag={(tag) => onFilter({ q: filter.q, tag })} />
          {data.total > data.items.length && (
            <div className="mt-6 text-center">
              <Button onClick={() => setLimit((l) => l + PAGE_SIZE)}>Xem thêm ({data.total - data.items.length})</Button>
            </div>
          )}
        </>
      ) : (
        <EmptyState title={filter.q || filter.tag ? "Không có ảnh phù hợp" : "Chưa có ảnh nào"}>
          Kéo thả ảnh vào trang hoặc bấm “Tải ảnh lên”. Viết mô tả kèm hashtag để AI biết khi nào dùng ảnh.
        </EmptyState>
      )}
      <Modal open={!!editing} onClose={() => setEditing(null)} title="Chi tiết ảnh" wide>
        {editing && <ImageEditor key={editing.id} image={editing} onClose={() => setEditing(null)} onChanged={() => void reload()} />}
      </Modal>
    </div>
  );
}

/** Chọn ảnh từ thư viện (nhiều ảnh có thứ tự, hoặc một ảnh). */
export function ImagePicker({
  selected,
  onChange,
  single,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  single?: boolean;
}) {
  const [filter, setFilter] = useState({ q: "", tag: "" });
  const query = new URLSearchParams({ limit: "120" });
  if (filter.q) query.set("q", filter.q);
  if (filter.tag) query.set("tag", filter.tag);
  const { data, loading, error } = useApi<Page<ImageItem>>(`/api/images?${query}`);
  const onFilter = useCallback((next: { q: string; tag: string }) => setFilter(next), []);

  const toggle = (img: ImageItem) => {
    if (single) return onChange([img.id]);
    onChange(selected.includes(img.id) ? selected.filter((id) => id !== img.id) : [...selected, img.id]);
  };

  return (
    <div>
      <LibraryFilters kind="images" q={filter.q} tag={filter.tag} onChange={onFilter}>
        {!single && selected.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => onChange([])}>
            Bỏ chọn ({selected.length})
          </Button>
        )}
      </LibraryFilters>
      <ErrorBox message={error} />
      {loading && !data ? (
        <Loading />
      ) : data?.items.length ? (
        <ImageGrid images={data.items} selected={selected} onOpen={toggle} />
      ) : (
        <EmptyState title="Không có ảnh">Tải ảnh lên ở trang Thư viện ảnh.</EmptyState>
      )}
    </div>
  );
}
