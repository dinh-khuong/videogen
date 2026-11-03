"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { api, formatBytes, formatDate, formatDuration, uploadFile, useApi } from "@/lib/client";
import type { AnalysisStatus, AssetFolder, AssetItem, Page, Stats } from "@/lib/types";
import { ASSET_DRAG_TYPE, FolderBar, FolderSelect, useFolders } from "./asset-folders";
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
  Spinner,
  TagList,
  cx,
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
    <div className="mb-4 space-y-2 rounded-xl bg-surface p-3 ring-1 ring-zinc-200">
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

const ANALYSIS: Record<AnalysisStatus, { label: string; className: string }> = {
  pending: { label: "Chờ phân tích", className: "bg-zinc-100 text-zinc-600" },
  running: { label: "Đang phân tích", className: "bg-sky-50 text-sky-700" },
  done: { label: "Đã phân tích", className: "bg-emerald-50 text-emerald-700" },
  failed: { label: "Phân tích lỗi", className: "bg-red-50 text-red-700" },
};

export function AnalysisBadge({ status }: { status: AnalysisStatus }) {
  const s = ANALYSIS[status];
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", s.className)}>
      {(status === "running" || status === "pending") && <Spinner className="size-3" />}
      {s.label}
    </span>
  );
}

const isAnalyzing = (a: AssetItem) => a.analysisStatus === "pending" || a.analysisStatus === "running";
const stripHashtags = (text: string) => text.replace(/#[\p{L}\p{N}_]+/gu, "").trim();

const KIND_LABEL = { image: "ảnh", video: "video", audio: "audio" } as const;

/** Ảnh thu nhỏ của asset; video/audio có biểu tượng và thời lượng. */
export function AssetThumb({ asset, className }: { asset: AssetItem; className?: string }) {
  return (
    <span className={cx("relative block overflow-hidden bg-zinc-100", className)}>
      {asset.thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={asset.thumbUrl} alt={asset.title} loading="lazy" className="size-full object-cover" />
      ) : (
        <span className="grid size-full place-items-center text-xs text-zinc-400">Không có ảnh xem trước</span>
      )}
      {asset.kind !== "image" && (
        <span className="absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 rounded bg-black/75 px-1.5 py-0.5 text-[11px] font-medium text-white">
          <svg viewBox="0 0 24 24" className="size-3" fill="currentColor" aria-hidden>
            <path d={asset.kind === "audio" ? "M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm12-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" : "M8 5v14l11-7z"} />
          </svg>
          {formatDuration(asset.duration)}
        </span>
      )}
    </span>
  );
}

function AssetEditor({
  initial,
  folders,
  onClose,
  onChanged,
}: {
  initial: AssetItem;
  folders: AssetFolder[];
  onClose: () => void;
  onChanged: () => void;
}) {
  // Tải lại định kỳ khi asset đang được phân tích để hiện kết quả ngay khi xong
  const live = useApi<AssetItem>(`/api/assets/${initial.id}`, { refreshMs: 2000, shouldRefresh: isAnalyzing });
  const asset = live.data ?? initial;
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [folderId, setFolderId] = useState(initial.folderId ?? "");
  const [summary, setSummary] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const analyzing = isAnalyzing(asset);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/assets/${asset.id}`, {
        method: "PATCH",
        json: { title, description, folderId: folderId || null, ...(summary !== null && !analyzing ? { aiSummary: summary } : {}) },
      });
      onChanged();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const reanalyze = async () => {
    setError(null);
    try {
      await api(`/api/assets/${asset.id}/analyze`, { method: "POST" });
      setSummary(null);
      await live.reload();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div>
        <div className="overflow-hidden rounded-lg bg-neutral-900">
          {asset.kind === "video" ? (
            <video src={asset.url} poster={asset.thumbUrl ?? undefined} controls preload="metadata" className="max-h-[60vh] w-full" />
          ) : asset.kind === "audio" ? (
            <div className="space-y-3 p-4">
              {asset.thumbUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={asset.thumbUrl} alt="" className="w-full rounded" />
              )}
              <audio src={asset.url} controls preload="metadata" className="w-full" />
            </div>
          ) : (
            <a href={asset.url} target="_blank" rel="noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={asset.url} alt={asset.title} className="max-h-[60vh] w-full bg-zinc-100 object-contain" />
            </a>
          )}
        </div>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-zinc-500">
          <dt>Loại</dt>
          <dd>
            {asset.kind === "image" ? `Ảnh · ${asset.width}×${asset.height}` : `${asset.kind === "video" ? `Video · ${asset.width}×${asset.height}` : "Audio"} · ${formatDuration(asset.duration)}`}{" "}
            · {formatBytes(asset.sizeBytes)}
          </dd>
          <dt>Nguồn</dt>
          <dd className="truncate">
            {asset.sourceUrl ? (
              <a href={asset.sourceUrl} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">
                {asset.source}
              </a>
            ) : (
              asset.source
            )}
          </dd>
          <dt>Dùng trong</dt>
          <dd>{asset.usedIn} video</dd>
          <dt>Thêm lúc</dt>
          <dd>{formatDate(asset.createdAt)}</dd>
        </dl>
      </div>
      <div className="space-y-4">
        <Field label="Tiêu đề">
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Thư mục">
          <FolderSelect folders={folders} value={folderId} onChange={setFolderId} />
        </Field>
        <Field label="Mô tả & hashtag" hint="Mô tả của bạn được ưu tiên hơn tóm tắt AI khi AI chọn asset cho từng bước.">
          <DescriptionInput value={description} onChange={setDescription} rows={3} />
        </Field>

        <section className="space-y-3 rounded-xl bg-zinc-50 p-3 ring-1 ring-zinc-200">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-zinc-800">Phân tích AI</h3>
              <AnalysisBadge status={asset.analysisStatus} />
            </div>
            <Button size="sm" variant="ghost" onClick={reanalyze} disabled={asset.analysisStatus === "running"}>
              Phân tích lại
            </Button>
          </div>
          {asset.analysisStatus === "failed" && asset.analysisError && (
            <p className="whitespace-pre-wrap break-words text-xs text-red-600">{asset.analysisError}</p>
          )}
          <Field
            label="Tóm tắt nội dung"
            hint={asset.kind === "audio" ? "Viết mô tả (thể loại, tâm trạng) để AI tóm tắt chính xác hơn." : "AI đọc tóm tắt này để tự chọn asset khi viết kịch bản. Bạn có thể sửa lại."}
          >
            <textarea
              className={inputClass}
              rows={3}
              disabled={analyzing}
              value={summary ?? asset.aiSummary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder={analyzing ? "Đang phân tích..." : "Chưa có tóm tắt (thêm mô tả hoặc bấm Phân tích lại)"}
            />
          </Field>
          {asset.kind === "audio" ? null : asset.ocrText ? (
            <div>
              <p className="mb-1 text-sm font-medium text-zinc-700">Chữ đọc được trong {KIND_LABEL[asset.kind]}</p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-2 font-sans text-xs text-zinc-700 ring-1 ring-zinc-200">
                {asset.ocrText}
              </pre>
            </div>
          ) : (
            !analyzing && <p className="text-xs text-zinc-500">Không đọc được chữ nào trong {KIND_LABEL[asset.kind]}.</p>
          )}
          <TagList tags={asset.aiTags} />
        </section>

        <ErrorBox message={error} />
        <div className="flex flex-wrap justify-between gap-2">
          <ConfirmButton
            variant="danger"
            confirmLabel="Xóa vĩnh viễn?"
            onConfirm={async () => {
              try {
                await api(`/api/assets/${asset.id}`, { method: "DELETE" });
                onChanged();
                onClose();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Xóa asset
          </ConfirmButton>
          <div className="flex gap-2">
            <a
              href={`${asset.url}?download=${encodeURIComponent(asset.title || "asset")}`}
              className="inline-flex items-center rounded-lg px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-100"
            >
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

export function AssetGrid({
  assets,
  onOpen,
  selected,
  onTag,
  dragIds,
}: {
  assets: AssetItem[];
  onOpen: (asset: AssetItem) => void;
  selected?: string[];
  onTag?: (tag: string) => void;
  /** Cho phép kéo asset (vd thả vào thư mục): trả về các id được kéo theo khi bắt đầu kéo asset này */
  dragIds?: (asset: AssetItem) => string[];
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {assets.map((asset) => {
        const order = selected ? selected.indexOf(asset.id) : -1;
        const text = stripHashtags(asset.description) || asset.aiSummary;
        return (
          <div
            key={asset.id}
            draggable={!!dragIds}
            onDragStart={
              dragIds &&
              ((e) => {
                const ids = dragIds(asset);
                e.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify(ids));
                e.dataTransfer.effectAllowed = "move";
              })
            }
            className={cx("overflow-hidden rounded-xl bg-surface ring-1", order >= 0 ? "ring-2 ring-brand-500" : "ring-zinc-200/80")}
          >
            <button type="button" onClick={() => onOpen(asset)} className="relative block w-full">
              <AssetThumb asset={asset} className="aspect-[4/3] w-full" />
              {order >= 0 && (
                <span className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-brand-500 text-xs font-semibold text-white">
                  {order + 1}
                </span>
              )}
              {asset.source !== "upload" && (
                <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">{asset.source}</span>
              )}
            </button>
            <div className="space-y-1 p-2.5">
              <p className="truncate text-sm font-medium text-zinc-800" title={asset.title}>
                {asset.title || "(Không tiêu đề)"}
              </p>
              {text ? (
                <p className="line-clamp-2 text-xs text-zinc-500" title={asset.aiSummary || undefined}>
                  {text}
                </p>
              ) : asset.analysisStatus === "done" || asset.analysisStatus === "failed" ? (
                <p className="text-xs italic text-amber-600">Chưa có mô tả</p>
              ) : null}
              <div className="flex flex-wrap items-center gap-1">
                {asset.analysisStatus !== "done" && <AnalysisBadge status={asset.analysisStatus} />}
                {asset.ocrText && asset.analysisStatus === "done" && (
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700" title={asset.ocrText}>
                    Có chữ
                  </span>
                )}
              </div>
              <TagList tags={asset.tags.slice(0, 4)} onClick={onTag} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

const PAGE_SIZE = 60;
const ACCEPT = "image/*,video/*,audio/*,.mov,.mkv,.m4a,.flac,.opus";
const isMedia = (f: File) =>
  /^(image|video|audio)\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|mp4|mov|m4v|webm|mkv|avi|mp3|m4a|aac|wav|ogg|oga|flac|opus)$/i.test(f.name);

function KindSelect({ value, onChange }: { value: string; onChange: (kind: string) => void }) {
  return (
    <select className={`${inputClass} w-auto!`} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Tất cả loại</option>
      <option value="image">Chỉ ảnh</option>
      <option value="video">Chỉ video</option>
      <option value="audio">Chỉ audio</option>
    </select>
  );
}

export function AssetsLibrary() {
  const params = useSearchParams();
  const [filter, setFilter] = useState({ q: "", tag: params.get("tag") ?? "" });
  const [kind, setKind] = useState(params.get("kind") ?? "");
  const [folder, setFolder] = useState(params.get("folder") ?? "");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [editing, setEditing] = useState<AssetItem | null>(null);
  const [dragging, setDragging] = useState(false);
  // Chế độ chọn nhiều để chuyển hàng loạt vào thư mục
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [moveTo, setMoveTo] = useState("");
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const query = new URLSearchParams({ limit: String(limit) });
  if (filter.q) query.set("q", filter.q);
  if (filter.tag) query.set("tag", filter.tag);
  if (kind) query.set("kind", kind);
  if (folder) query.set("folder", folder);
  const { data, error, loading, reload } = useApi<Page<AssetItem>>(`/api/assets?${query}`, {
    refreshMs: 3000,
    shouldRefresh: (page) => page.items.some(isAnalyzing),
  });
  const failed = useApi<Page<AssetItem>>("/api/assets?status=failed&limit=1");
  const stats = useApi<Stats>("/api/stats", { refreshMs: 3000, shouldRefresh: (s) => s.assetsAnalyzing > 0 });
  const folders = useFolders();
  const { reload: reloadFailed } = failed;
  const { reload: reloadStats } = stats;
  const { reload: reloadFolders } = folders;
  const refresh = useCallback(() => {
    void reload();
    void reloadFailed();
    void reloadStats();
    void reloadFolders();
  }, [reload, reloadFailed, reloadStats, reloadFolders]);
  const { uploads, start, clear } = useUploads("/api/assets", refresh);
  const folderList = folders.data?.items ?? [];
  const currentFolder = folderList.find((f) => f.id === folder) ?? null;
  const chooseFolder = (next: string) => {
    setFolder(next);
    setLimit(PAGE_SIZE);
    // Giữ thư mục trên đường dẫn để tải lại trang vẫn ở đúng thư mục
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("folder", next);
    else url.searchParams.delete("folder");
    window.history.replaceState(null, "", url);
  };

  const move = async (ids: string[], folderId: string | null) => {
    if (!ids.length) return;
    setMoving(true);
    setMoveError(null);
    try {
      await api("/api/assets/move", { method: "POST", json: { ids, folderId } });
      setSelected([]);
      refresh();
    } catch (e) {
      setMoveError((e as Error).message);
    } finally {
      setMoving(false);
    }
  };
  const stopSelecting = () => {
    setSelecting(false);
    setSelected([]);
  };
  const onFilter = useCallback((next: { q: string; tag: string }) => {
    setFilter(next);
    setLimit(PAGE_SIZE);
  }, []);

  const addFiles = (files: FileList | null) => {
    const list = [...(files ?? [])].filter(isMedia);
    // Tải lên khi đang mở một thư mục thì asset vào luôn thư mục đó
    if (list.length) void start(list, currentFolder ? { folderId: currentFolder.id } : {});
  };
  const retryFailed = async () => {
    await api("/api/assets/analyze", { method: "POST", json: { failed: true } });
    refresh();
  };

  return (
    <div
      onDragOver={(e) => {
        // Chỉ hiện vùng thả khi kéo file từ máy, không phải khi kéo asset vào thư mục
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      <PageHeader
        title="Assets"
        subtitle={`${data?.total ?? 0} asset · Ảnh, video và audio để ghép vào video. AI đọc chữ trong asset và tóm tắt nội dung để tự chọn asset phù hợp cho từng bước; audio dùng làm nhạc nền.`}
        actions={
          <>
            <input ref={fileInput} type="file" accept={ACCEPT} multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ""))} />
            <Button variant={selecting ? "primary" : "secondary"} onClick={() => (selecting ? stopSelecting() : setSelecting(true))}>
              {selecting ? "Xong" : "Chọn nhiều"}
            </Button>
            <Button variant="primary" onClick={() => fileInput.current?.click()}>
              {currentFolder ? `Tải lên vào “${currentFolder.name}”` : "Tải ảnh/video/audio lên"}
            </Button>
          </>
        }
      />
      {dragging && (
        <div className="mb-4 rounded-xl border-2 border-dashed border-brand-500 bg-brand-50 py-8 text-center text-sm font-medium text-brand-700">
          Thả ảnh, video hoặc audio vào đây để tải lên{currentFolder ? ` thư mục “${currentFolder.name}”` : ""}
        </div>
      )}
      <UploadList uploads={uploads} onClear={clear} />
      {(stats.data?.assetsAnalyzing ?? 0) > 0 && (
        <div className="mb-4 flex items-center gap-2 rounded-xl bg-sky-50 px-3 py-2 text-sm text-sky-800 ring-1 ring-sky-100">
          <Spinner className="size-4" />
          Đang phân tích {stats.data!.assetsAnalyzing} asset (đọc chữ + AI tóm tắt)...
        </div>
      )}
      {(failed.data?.total ?? 0) > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-100">
          <span>{failed.data!.total} asset phân tích lỗi.</span>
          <Button size="sm" onClick={retryFailed}>
            Phân tích lại
          </Button>
        </div>
      )}
      <FolderBar
        folders={folders.data}
        total={folders.data ? folders.data.unfiled + folderList.reduce((n, f) => n + f.assetCount, 0) : null}
        value={folder}
        onChange={chooseFolder}
        onChanged={refresh}
        onDropAssets={(ids, folderId) => void move(ids, folderId)}
      />
      {selecting && (
        <div className="sticky top-2 z-20 mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-surface px-3 py-2 text-sm shadow-md ring-1 ring-brand-200">
          <span className="font-medium text-zinc-800">Đã chọn {selected.length} asset</span>
          {data && data.items.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setSelected(selected.length === data.items.length ? [] : data.items.map((a) => a.id))}>
              {selected.length === data.items.length ? "Bỏ chọn tất cả" : "Chọn tất cả đang hiện"}
            </Button>
          )}
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <span className="text-zinc-500">Chuyển vào</span>
            <FolderSelect folders={folderList} value={moveTo} onChange={setMoveTo} noneLabel="Chưa phân loại (bỏ khỏi thư mục)" className="w-auto!" />
            <Button size="sm" variant="primary" busy={moving} disabled={!selected.length} onClick={() => void move(selected, moveTo || null)}>
              Chuyển
            </Button>
          </span>
          <ErrorBox message={moveError} />
        </div>
      )}
      {!selecting && moveError && <ErrorBox message={moveError} />}
      <LibraryFilters kind="assets" q={filter.q} tag={filter.tag} onChange={onFilter} placeholder="Tìm theo tên, mô tả, chữ trong ảnh...">
        <KindSelect
          value={kind}
          onChange={(k) => {
            setKind(k);
            setLimit(PAGE_SIZE);
          }}
        />
      </LibraryFilters>
      <ErrorBox message={error} onRetry={() => void reload()} />
      {loading && !data ? (
        <Loading />
      ) : data?.items.length ? (
        <>
          <AssetGrid
            assets={data.items}
            selected={selecting ? selected : undefined}
            onOpen={
              selecting
                ? (a) => setSelected((s) => (s.includes(a.id) ? s.filter((id) => id !== a.id) : [...s, a.id]))
                : setEditing
            }
            onTag={(tag) => onFilter({ q: filter.q, tag })}
            // Kéo một asset đang được chọn thì kéo theo cả nhóm đã chọn
            dragIds={(a) => (selecting && selected.includes(a.id) ? selected : [a.id])}
          />
          {data.total > data.items.length && (
            <div className="mt-6 text-center">
              <Button onClick={() => setLimit((l) => l + PAGE_SIZE)}>Xem thêm ({data.total - data.items.length})</Button>
            </div>
          )}
        </>
      ) : (
        <EmptyState
          title={filter.q || filter.tag || kind ? "Không có asset phù hợp" : currentFolder ? "Thư mục trống" : folder === "none" ? "Không có asset chưa phân loại" : "Chưa có asset nào"}
        >
          {currentFolder
            ? "Kéo thả file vào trang để tải lên thư mục này, hoặc kéo asset có sẵn (ở “Tất cả”) thả vào tên thư mục."
            : "Kéo thả ảnh/video/audio vào trang hoặc bấm “Tải ảnh/video/audio lên”. AI sẽ tự đọc chữ và tóm tắt nội dung từng asset."}
        </EmptyState>
      )}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={`Chi tiết ${editing ? KIND_LABEL[editing.kind] : ""}`} wide>
        {editing && <AssetEditor key={editing.id} initial={editing} folders={folderList} onClose={() => setEditing(null)} onChanged={refresh} />}
      </Modal>
    </div>
  );
}

/** Chọn ảnh/video từ thư viện để làm hình cho các bước (nhiều asset có thứ tự, hoặc một asset). */
export function AssetPicker({
  selected,
  onChange,
  single,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  single?: boolean;
}) {
  const [filter, setFilter] = useState({ q: "", tag: "" });
  const [kind, setKind] = useState("image,video");
  const [folder, setFolder] = useState("");
  const folders = useFolders();
  const query = new URLSearchParams({ limit: "120" });
  if (filter.q) query.set("q", filter.q);
  if (filter.tag) query.set("tag", filter.tag);
  if (kind) query.set("kind", kind);
  if (folder) query.set("folder", folder);
  const { data, loading, error } = useApi<Page<AssetItem>>(`/api/assets?${query}`);
  const onFilter = useCallback((next: { q: string; tag: string }) => setFilter(next), []);

  const toggle = (asset: AssetItem) => {
    if (single) return onChange([asset.id]);
    onChange(selected.includes(asset.id) ? selected.filter((id) => id !== asset.id) : [...selected, asset.id]);
  };

  return (
    <div>
      <LibraryFilters kind="assets" q={filter.q} tag={filter.tag} onChange={onFilter} placeholder="Tìm theo tên, mô tả, chữ trong ảnh...">
        <select className={`${inputClass} w-auto!`} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="image,video">Ảnh & video</option>
          <option value="image">Chỉ ảnh</option>
          <option value="video">Chỉ video</option>
        </select>
        {!!folders.data?.items.length && (
          <FolderSelect folders={folders.data.items} value={folder} onChange={setFolder} allLabel="Mọi thư mục" className="w-auto!" />
        )}
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
        <AssetGrid assets={data.items} selected={selected} onOpen={toggle} />
      ) : (
        <EmptyState title="Không có asset">Tải ảnh/video lên ở trang Assets.</EmptyState>
      )}
    </div>
  );
}

/** Chọn nhạc nền (asset audio) + âm lượng, nghe thử ngay. */
export function MusicPicker({
  musicId,
  volume,
  onChange,
}: {
  musicId: string;
  volume: number;
  onChange: (next: { musicId: string; volume: number }) => void;
}) {
  const { data } = useApi<Page<AssetItem>>("/api/assets?kind=audio&limit=200");
  const current = data?.items.find((a) => a.id === musicId);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <select className={`${inputClass} max-w-md`} value={musicId} onChange={(e) => onChange({ musicId: e.target.value, volume })}>
          <option value="">Không có nhạc nền</option>
          {musicId && data && !current && <option value={musicId}>(Nhạc đã bị xóa — chọn lại)</option>}
          {data?.items.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title} ({formatDuration(a.duration)})
            </option>
          ))}
        </select>
        {musicId && (
          <label className="flex items-center gap-2 text-sm text-zinc-600">
            Âm lượng
            <input
              type="range"
              min={0.02}
              max={0.5}
              step={0.01}
              value={volume}
              onChange={(e) => onChange({ musicId, volume: Number(e.target.value) })}
              className="accent-brand-500"
            />
            <span className="w-9 tabular-nums">{Math.round(volume * 100)}%</span>
          </label>
        )}
      </div>
      {current && (
        <>
          {current.aiSummary && <p className="text-xs text-zinc-500">{current.aiSummary}</p>}
          <audio key={current.id} src={current.url} controls preload="none" className="h-9 w-full max-w-md" />
        </>
      )}
      {data && !data.items.length && <p className="text-xs text-zinc-500">Chưa có audio nào. Tải nhạc lên ở trang Assets.</p>}
    </div>
  );
}
