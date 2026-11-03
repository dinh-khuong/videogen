"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api, formatBytes, formatDate, useApi } from "@/lib/client";
import type { AssetFolder, AssetItem, FolderColor, Page, Stats } from "@/lib/types";
import {
  Chevron,
  ColorRow,
  ContextMenu,
  DeleteModal,
  FolderIcon,
  FolderTree,
  LibraryIcon,
  MoveModal,
  NameModal,
  NavButton,
  StarIcon,
  StorageMeter,
  endItemsDrag,
  filesFromDirectoryInput,
  readDroppedFiles,
  startItemsDrag,
  useDropTarget,
  useFolderIndex,
  useFolders,
  type DragItems,
  type FolderIndex,
  type LocalFile,
  type MenuItem,
} from "./asset-folders";
import {
  ACCEPT,
  AnalysisBadge,
  AssetEditor,
  AssetThumb,
  KIND_LABEL,
  UploadList,
  isAnalyzing,
  isMedia,
  stripHashtags,
  useUploads,
} from "./assets-library";
import { LibraryFilters } from "./library-filters";
import { Button, EmptyState, ErrorBox, Loading, Modal, PageHeader, Spinner, TagList, cx, inputClass } from "./ui";

const PAGE_SIZE = 60;

/** "" = gốc thư viện, "all" = mọi asset, "starred" = thư mục gắn sao, còn lại là id thư mục */
type Place = string;

const SORTS = { new: "Mới nhất", old: "Cũ nhất", name: "Tên A→Z", size: "Dung lượng" } as const;
type Sort = keyof typeof SORTS;

// ---- Chế độ xem lưới / danh sách, nhớ trong trình duyệt
const VIEW_KEY = "assets:view";
const VIEW_EVENT = "videogen:assets-view";
type ViewMode = "grid" | "list";
const subscribeView = (cb: () => void) => {
  window.addEventListener(VIEW_EVENT, cb);
  return () => window.removeEventListener(VIEW_EVENT, cb);
};
const readView = (): ViewMode => {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
};
function saveView(v: ViewMode) {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    // không lưu được thì thôi
  }
  window.dispatchEvent(new Event(VIEW_EVENT));
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .toLowerCase();

function sortFolders(list: AssetFolder[], sort: Sort): AssetFolder[] {
  const out = [...list];
  if (sort === "new") out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  else if (sort === "old") out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  else if (sort === "size") out.sort((a, b) => b.totalBytes - a.totalBytes);
  return out; // "name": API đã xếp A→Z
}

const fKey = (id: string) => `f:${id}`;
const aKey = (id: string) => `a:${id}`;
const toItems = (keys: string[]): DragItems => ({
  folders: keys.filter((k) => k.startsWith("f:")).map((k) => k.slice(2)),
  assets: keys.filter((k) => k.startsWith("a:")).map((k) => k.slice(2)),
});
const countLabel = (items: DragItems) => {
  const n = items.assets.length + items.folders.length;
  return n === 1 ? (items.folders.length ? "1 thư mục" : "1 asset") : `${n} mục`;
};

// ---------------------------------------------------------------- Biểu tượng nhỏ

const Icon = {
  plus: <path d="M10 4v12M4 10h12" />,
  folderPlus: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3l1.5 1.5h6.5A1.5 1.5 0 0 1 17 8v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5v-8ZM10 9v4M8 11h4" />,
  upload: <path d="M10 13V4m0 0L6.5 7.5M10 4l3.5 3.5M4 13v1.5A1.5 1.5 0 0 0 5.5 16h9a1.5 1.5 0 0 0 1.5-1.5V13" />,
  folderUp: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3l1.5 1.5h6.5A1.5 1.5 0 0 1 17 8v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5v-8ZM10 14v-4m0 0-2 2m2-2 2 2" />,
  open: <path d="M4 10h12m0 0-4-4m4 4-4 4" />,
  pencil: <path d="M12.5 4.5 15.5 7.5M4 16l1-4 8.5-8.5 3 3L8 15l-4 1Z" />,
  move: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3l1.5 1.5h6.5A1.5 1.5 0 0 1 17 8v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5v-8ZM8 11.5h4.5m0 0L11 10m1.5 1.5L11 13" />,
  trash: <path d="M5 6h10M8 6V4.5h4V6m-6 0 .7 9.5h6.6L14 6" />,
  download: <path d="M10 4v9m0 0-3.5-3.5M10 13l3.5-3.5M4 16h12" />,
  sparkle: <path d="M10 3v3m0 8v3M3 10h3m8 0h3M5.5 5.5l2 2m5 5 2 2m0-9-2 2m-5 5-2 2" />,
  info: <path d="M10 9v5m0-8v.01M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z" />,
  grid: <path d="M4 4h5v5H4zM11 4h5v5h-5zM4 11h5v5H4zM11 11h5v5h-5z" />,
  list: <path d="M4 5h12M4 10h12M4 15h12" />,
  all: <path d="M4 4h5v5H4zM11 4h5v5h-5zM4 11h5v5H4zM11 11h5v5h-5z" />,
};
function Svg({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={cx("shrink-0", className ?? "size-4")} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

// ---------------------------------------------------------------- Ô chọn (checkbox) trên thẻ

function Check({ checked, onClick, className }: { checked: boolean; onClick: (e: React.MouseEvent) => void; className?: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={checked ? "Bỏ chọn" : "Chọn"}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      className={cx(
        "grid size-5 place-items-center rounded-full ring-2 transition-opacity",
        checked ? "bg-brand-500 text-white ring-brand-500" : "bg-white/90 text-transparent ring-zinc-300 hover:text-zinc-400",
        className,
      )}
    >
      <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" d="m5 10.5 3 3 7-7" />
      </svg>
    </button>
  );
}

// ---------------------------------------------------------------- Thẻ thư mục / asset

type ItemHandlers = {
  onClick: (e: React.MouseEvent) => void;
  onCheck: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
};

type DropHandlers = {
  index: FolderIndex;
  onItems: (items: DragItems, target: string | null) => void;
  onFiles: (data: DataTransfer, target: string | null) => void;
};

function FolderTile({
  folder,
  selected,
  selecting,
  onOpen,
  drop: dropOpts,
  ...h
}: ItemHandlers & { folder: AssetFolder; selected: boolean; selecting: boolean; onOpen: () => void; drop: DropHandlers }) {
  const drop = useDropTarget(folder.id, dropOpts);
  return (
    <div
      {...drop.props}
      draggable
      onDragStart={h.onDragStart}
      onDragEnd={endItemsDrag}
      onContextMenu={h.onContextMenu}
      onClick={h.onClick}
      onDoubleClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      tabIndex={0}
      role="button"
      title={folder.name}
      className={cx(
        "group relative flex cursor-pointer select-none items-center gap-3 rounded-xl px-3 py-3 ring-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
        drop.over ? "bg-brand-100 ring-2 ring-brand-500" : selected ? "bg-brand-50 ring-2 ring-brand-500" : "bg-surface ring-zinc-200/80 hover:bg-zinc-50",
      )}
    >
      <FolderIcon className="size-7" color={folder.color} open={drop.over} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 truncate text-sm font-medium text-zinc-800">
          <span className="truncate">{folder.name}</span>
          {folder.starred && <StarIcon filled className="size-3.5 text-amber-400" />}
        </p>
        <p className="text-xs text-zinc-500">
          {folder.totalAssets} asset{folder.totalBytes ? ` · ${formatBytes(folder.totalBytes)}` : ""}
        </p>
      </div>
      <Check checked={selected} onClick={h.onCheck} className={cx(!selected && !selecting && "opacity-0 group-hover:opacity-100 focus:opacity-100")} />
    </div>
  );
}

function AssetTile({
  asset,
  selected,
  selecting,
  folderLabel,
  onFolderClick,
  onTag,
  ...h
}: ItemHandlers & {
  asset: AssetItem;
  selected: boolean;
  selecting: boolean;
  folderLabel?: string | null;
  onFolderClick?: () => void;
  onTag: (tag: string) => void;
}) {
  const text = stripHashtags(asset.description) || asset.aiSummary;
  return (
    <div
      draggable
      onDragStart={h.onDragStart}
      onDragEnd={endItemsDrag}
      onContextMenu={h.onContextMenu}
      className={cx(
        "group relative select-none overflow-hidden rounded-xl bg-surface ring-1 transition-shadow",
        selected ? "ring-2 ring-brand-500" : "ring-zinc-200/80 hover:shadow-md",
      )}
    >
      <button type="button" onClick={h.onClick} className="relative block w-full">
        <AssetThumb asset={asset} className={cx("aspect-[4/3] w-full transition-transform", selected && "scale-[0.94] rounded-lg")} />
        {asset.source !== "upload" && (
          <span className="absolute right-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">{asset.source}</span>
        )}
      </button>
      <Check
        checked={selected}
        onClick={h.onCheck}
        className={cx("absolute left-2 top-2", !selected && !selecting && "opacity-0 group-hover:opacity-100 focus:opacity-100")}
      />
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
          {folderLabel !== undefined && (
            <button
              type="button"
              onClick={onFolderClick}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-600 hover:bg-zinc-200"
              title="Mở thư mục chứa"
            >
              {folderLabel ? <FolderIcon className="size-3" /> : <LibraryIcon className="size-3" />}
              <span className="truncate">{folderLabel ?? "Thư viện"}</span>
            </button>
          )}
        </div>
        <TagList tags={asset.tags.slice(0, 4)} onClick={onTag} />
      </div>
    </div>
  );
}

function FolderRow({
  folder,
  selected,
  selecting,
  onOpen,
  drop: dropOpts,
  showLocation,
  ...h
}: ItemHandlers & { folder: AssetFolder; selected: boolean; selecting: boolean; onOpen: () => void; drop: DropHandlers; showLocation: boolean }) {
  const drop = useDropTarget(folder.id, dropOpts);
  return (
    <tr
      {...drop.props}
      draggable
      onDragStart={h.onDragStart}
      onDragEnd={endItemsDrag}
      onContextMenu={h.onContextMenu}
      onClick={h.onClick}
      onDoubleClick={onOpen}
      className={cx(
        "group cursor-pointer select-none border-b border-zinc-100 last:border-0",
        drop.over ? "bg-brand-100 outline-2 -outline-offset-2 outline-brand-500" : selected ? "bg-brand-50" : "hover:bg-zinc-50",
      )}
    >
      <td className="w-10 py-2 pl-3">
        <Check checked={selected} onClick={h.onCheck} className={cx(!selected && !selecting && "opacity-0 group-hover:opacity-100")} />
      </td>
      <td className="py-2 pr-3">
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center">
            <FolderIcon className="size-6" color={folder.color} />
          </span>
          <span className="truncate font-medium text-zinc-800">{folder.name}</span>
          {folder.starred && <StarIcon filled className="size-3.5 text-amber-400" />}
        </span>
      </td>
      <td className="hidden py-2 pr-3 text-zinc-500 sm:table-cell">Thư mục · {folder.totalAssets}</td>
      {showLocation && <td className="hidden py-2 pr-3 md:table-cell" />}
      <td className="hidden py-2 pr-3 text-right tabular-nums text-zinc-500 sm:table-cell">{folder.totalBytes ? formatBytes(folder.totalBytes) : "—"}</td>
      <td className="hidden py-2 pr-3 text-zinc-500 md:table-cell">{formatDate(folder.createdAt)}</td>
    </tr>
  );
}

function AssetRow({
  asset,
  selected,
  selecting,
  folderLabel,
  onFolderClick,
  ...h
}: ItemHandlers & { asset: AssetItem; selected: boolean; selecting: boolean; folderLabel?: string | null; onFolderClick?: () => void }) {
  return (
    <tr
      draggable
      onDragStart={h.onDragStart}
      onDragEnd={endItemsDrag}
      onContextMenu={h.onContextMenu}
      onClick={h.onClick}
      className={cx("group cursor-pointer select-none border-b border-zinc-100 last:border-0", selected ? "bg-brand-50" : "hover:bg-zinc-50")}
    >
      <td className="w-10 py-2 pl-3">
        <Check checked={selected} onClick={h.onCheck} className={cx(!selected && !selecting && "opacity-0 group-hover:opacity-100")} />
      </td>
      <td className="py-2 pr-3">
        <span className="flex min-w-0 items-center gap-2.5">
          <AssetThumb asset={asset} className="size-9 shrink-0 rounded-md [&_span]:hidden" />
          <span className="min-w-0">
            <span className="block truncate font-medium text-zinc-800">{asset.title || "(Không tiêu đề)"}</span>
            {asset.analysisStatus !== "done" && <AnalysisBadge status={asset.analysisStatus} />}
          </span>
        </span>
      </td>
      <td className="hidden py-2 pr-3 text-zinc-500 capitalize sm:table-cell">{KIND_LABEL[asset.kind]}</td>
      {folderLabel !== undefined && (
        <td className="hidden max-w-40 py-2 pr-3 md:table-cell">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onFolderClick?.();
            }}
            className="inline-flex max-w-full items-center gap-1 truncate text-zinc-500 hover:text-brand-600 hover:underline"
          >
            {folderLabel ? <FolderIcon className="size-3.5" /> : <LibraryIcon className="size-3.5" />}
            <span className="truncate">{folderLabel ?? "Thư viện"}</span>
          </button>
        </td>
      )}
      <td className="hidden py-2 pr-3 text-right tabular-nums text-zinc-500 sm:table-cell">{formatBytes(asset.sizeBytes)}</td>
      <td className="hidden py-2 pr-3 text-zinc-500 md:table-cell">{formatDate(asset.createdAt)}</td>
    </tr>
  );
}

// ---------------------------------------------------------------- Breadcrumb

function Crumb({ target, label, icon, current, onGo, drop: dropOpts }: { target: string | null; label: string; icon?: ReactNode; current: boolean; onGo: () => void; drop: DropHandlers }) {
  const drop = useDropTarget(target, { ...dropOpts, disabled: current });
  return (
    <button
      type="button"
      onClick={onGo}
      {...drop.props}
      className={cx(
        "inline-flex max-w-52 items-center gap-1.5 rounded-lg px-2 py-1 text-left transition-colors",
        drop.over ? "bg-brand-100 text-brand-700 ring-2 ring-brand-500" : current ? "font-semibold text-zinc-900" : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------- Thông báo kèm "Hoàn tác"

type Toast = { id: number; text: string; undo?: () => Promise<void> };

function ToastBar({ toast, onClose }: { toast: Toast | null; onClose: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onClose, 7000);
    return () => clearTimeout(t);
  }, [toast, onClose]);
  if (!toast) return null;
  return (
    <div className="fixed inset-x-0 bottom-4 z-[55] flex justify-center px-4">
      <div className="flex max-w-lg items-center gap-3 rounded-xl bg-zinc-900 px-4 py-2.5 text-sm text-white shadow-xl dark:bg-zinc-800">
        <span className="min-w-0 flex-1">{toast.text}</span>
        {toast.undo && (
          <button
            type="button"
            className="shrink-0 font-semibold text-brand-500 hover:underline"
            onClick={() => {
              const undo = toast.undo!;
              onClose();
              void undo();
            }}
          >
            Hoàn tác
          </button>
        )}
        <button type="button" onClick={onClose} aria-label="Đóng" className="shrink-0 text-white/60 hover:text-white">
          ×
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Trang Assets

type ModalState =
  | { type: "create"; parent: string | null }
  | { type: "renameFolder"; folder: AssetFolder }
  | { type: "renameAsset"; asset: AssetItem }
  | { type: "move"; items: DragItems }
  | { type: "delete"; items: DragItems }
  | null;

export function AssetsLibrary() {
  const params = useSearchParams();
  const rawPlace = params.get("folder") ?? "";
  const place: Place = rawPlace === "none" ? "" : rawPlace;
  const folderId = place && place !== "all" && place !== "starred" ? place : null;

  const [filter, setFilter] = useState({ q: "", tag: params.get("tag") ?? "" });
  const [kind, setKind] = useState(params.get("kind") ?? "");
  const [sort, setSort] = useState<Sort>("new");
  const view = useSyncExternalStore(subscribeView, readView, () => "grid" as ViewMode);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [editing, setEditing] = useState<AssetItem | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const closeToast = useCallback(() => setToast(null), [setToast]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [fileDrag, setFileDrag] = useState(false);
  const fileDragDepth = useRef(0);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);

  // React chưa có thuộc tính webkitdirectory: gắn thủ công cho ô chọn thư mục
  useEffect(() => {
    dirInput.current?.setAttribute("webkitdirectory", "");
  }, []);

  const filtering = !!(filter.q || filter.tag || kind);

  // ---- Dữ liệu
  const folders = useFolders();
  const index = useFolderIndex(folders.data);
  const currentFolder = folderId ? (index.byId.get(folderId) ?? null) : null;
  const missingFolder = !!folderId && !!folders.data && !currentFolder;

  const query = new URLSearchParams({ limit: String(limit), sort });
  if (filter.q) query.set("q", filter.q);
  if (filter.tag) query.set("tag", filter.tag);
  if (kind) query.set("kind", kind);
  if (folderId) {
    query.set("folder", folderId);
    // Đang tìm/lọc trong một thư mục: tìm cả trong thư mục con (giống Drive)
    if (filtering) query.set("recursive", "1");
  } else if (place === "" && !filtering) {
    query.set("folder", "none");
  }
  const assetsUrl = place === "starred" || missingFolder ? null : `/api/assets?${query}`;
  const assets = useApi<Page<AssetItem>>(assetsUrl, { refreshMs: 3000, shouldRefresh: (page) => page.items.some(isAnalyzing) });
  const failed = useApi<Page<AssetItem>>("/api/assets?status=failed&limit=1");
  const stats = useApi<Stats>("/api/stats", { refreshMs: 3000, shouldRefresh: (s) => s.assetsAnalyzing > 0 });
  const { reload: reloadAssets } = assets;
  const { reload: reloadFailed } = failed;
  const { reload: reloadStats } = stats;
  const { reload: reloadFolders } = folders;
  const refresh = useCallback(() => {
    void reloadAssets();
    void reloadFailed();
    void reloadStats();
    void reloadFolders();
  }, [reloadAssets, reloadFailed, reloadStats, reloadFolders]);
  const { uploads, start, clear } = useUploads("/api/assets", refresh);

  const assetItems = useMemo(() => (assetsUrl ? (assets.data?.items ?? []) : []), [assetsUrl, assets.data]);
  const assetById = useMemo(() => new Map(assetItems.map((a) => [a.id, a])), [assetItems]);

  // Thư mục hiện trong vùng chính
  const folderItems = useMemo(() => {
    if (!folders.data) return [];
    if (place === "starred") return sortFolders(folders.data.items.filter((f) => f.starred), sort);
    if (place === "all" || missingFolder) return [];
    if (filtering) {
      // Tìm theo tên: thư mục trùng tên trong phạm vi đang mở
      if (!filter.q || filter.tag || kind) return [];
      const needle = fold(filter.q);
      return sortFolders(
        folders.data.items.filter((f) => fold(f.name).includes(needle) && (!folderId || (f.id !== folderId && index.isInside(f.id, folderId)))),
        sort,
      );
    }
    return sortFolders(index.children(folderId), sort);
  }, [folders.data, place, missingFolder, filtering, filter.q, filter.tag, kind, folderId, index, sort]);

  const visibleKeys = useMemo(() => [...folderItems.map((f) => fKey(f.id)), ...assetItems.map((a) => aKey(a.id))], [folderItems, assetItems]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selection = useMemo(() => toItems(selected), [selected]);
  const selecting = selected.length > 0;

  // Asset nằm ở đâu: hiện khi xem "Tất cả" hoặc kết quả tìm kiếm
  const showLocation = place === "all" || filtering;
  const folderLabel = (a: AssetItem) => (a.folderId ? (index.byId.get(a.folderId)?.name ?? null) : null);

  // ---- Điều hướng (giữ trên đường dẫn: tải lại trang và nút Back vẫn đúng chỗ)
  const go = useCallback((next: Place) => {
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("folder", next);
    else url.searchParams.delete("folder");
    window.history.pushState(null, "", url);
    setSelected([]);
    setAnchor(null);
    setLimit(PAGE_SIZE);
  }, [setSelected, setAnchor, setLimit]);

  const ancestors = useMemo(() => new Set(index.path(folderId).map((f) => f.id)), [index, folderId]);
  const treeExpanded = useMemo(
    () => new Set([...expanded, ...[...ancestors].filter((id) => !collapsed.has(id))]),
    [expanded, ancestors, collapsed],
  );
  const toggleTree = useCallback(
    (id: string, open?: boolean) => {
      const isOpen = treeExpanded.has(id);
      const next = open ?? !isOpen;
      if (next === isOpen) return;
      setExpanded((s) => {
        const n = new Set(s);
        if (next) n.add(id);
        else n.delete(id);
        return n;
      });
      setCollapsed((s) => {
        const n = new Set(s);
        if (next) n.delete(id);
        else n.add(id);
        return n;
      });
    },
    [treeExpanded, setExpanded, setCollapsed],
  );

  // ---- Hành động
  const run = useCallback(async (fn: () => Promise<void>) => {
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }, [setActionError]);

  const placeName = useCallback((target: string | null) => (target ? (index.byId.get(target)?.name ?? "thư mục") : "Thư viện"), [index]);

  const moveItems = useCallback(
    (items: DragItems, target: string | null) =>
      run(async () => {
        if (!items.assets.length && !items.folders.length) return;
        // Nhớ chỗ cũ để hoàn tác
        const before = new Map<string | null, DragItems>();
        const remember = (from: string | null, push: (g: DragItems) => void) => {
          const g = before.get(from) ?? { assets: [], folders: [] };
          push(g);
          before.set(from, g);
        };
        for (const id of items.assets) {
          const a = assetById.get(id);
          if (a) remember(a.folderId, (g) => g.assets.push(id));
        }
        for (const id of items.folders) {
          const f = index.byId.get(id);
          if (f) remember(f.parentId, (g) => g.folders.push(id));
        }
        await api("/api/assets/move", { method: "POST", json: { ids: items.assets, folderIds: items.folders, folderId: target } });
        setSelected([]);
        refresh();
        setToast({
          id: Date.now(),
          text: `Đã chuyển ${countLabel(items)} vào “${placeName(target)}”`,
          undo: async () => {
            await run(async () => {
              for (const [from, g] of before) {
                await api("/api/assets/move", { method: "POST", json: { ids: g.assets, folderIds: g.folders, folderId: from } });
              }
              refresh();
            });
          },
        });
      }),
    [run, assetById, index, refresh, placeName, setSelected, setToast],
  );

  /** Tải file (kèm cấu trúc thư mục nếu kéo cả thư mục) vào thư mục `base`. */
  const uploadLocal = useCallback(
    (files: LocalFile[], base: string | null) =>
      run(async () => {
        const media = files.filter((f) => isMedia(f.file) && !f.file.name.startsWith("."));
        if (!media.length) {
          if (files.length) throw new Error("Không có file ảnh, video hoặc audio nào để tải lên.");
          return;
        }
        const ids = new Map<string, string | null>([["", base]]);
        const ensure = async (dirs: string[]): Promise<string | null> => {
          const key = dirs.join("/");
          if (ids.has(key)) return ids.get(key)!;
          const parent = await ensure(dirs.slice(0, -1));
          const folder = await api<AssetFolder>("/api/folders", {
            method: "POST",
            json: { name: dirs[dirs.length - 1].slice(0, 80), parentId: parent, reuse: true },
          });
          ids.set(key, folder.id);
          return folder.id;
        };
        const targets: (string | null)[] = [];
        for (const f of media) targets.push(await ensure(f.dirs));
        if (media.some((f) => f.dirs.length)) void reloadFolders();
        void start(
          media.map((f) => f.file),
          (_file, i): Record<string, string> => (targets[i] ? { folderId: targets[i]! } : {}),
        );
      }),
    [run, start, reloadFolders],
  );

  const onDropFiles = useCallback(
    (data: DataTransfer, target: string | null) => {
      // readDroppedFiles phải được gọi ngay trong sự kiện drop
      const pending = readDroppedFiles(data);
      void pending.then((files) => uploadLocal(files, target));
    },
    [uploadLocal],
  );

  const dropOpts: DropHandlers = useMemo(() => ({ index, onItems: (items, target) => void moveItems(items, target), onFiles: onDropFiles }), [index, moveItems, onDropFiles]);

  const deleteItems = (items: DragItems, withContents: boolean) =>
    (async () => {
      // Đang đứng trong thư mục sắp xóa: lùi về thư mục cha của nó
      const gone = items.folders.find((id) => index.isInside(folderId, id));
      for (const id of items.folders) {
        await api(`/api/folders/${id}${withContents ? "?contents=delete" : ""}`, { method: "DELETE" });
      }
      if (items.assets.length) await api("/api/assets/delete", { method: "POST", json: { ids: items.assets } });
      if (gone) go(index.byId.get(gone)?.parentId ?? "");
      setSelected([]);
      refresh();
      setToast({ id: Date.now(), text: `Đã xóa ${countLabel(items)}` });
    })();

  const patchFolder = (folder: AssetFolder, patch: { starred?: boolean; color?: FolderColor | null }) =>
    run(async () => {
      await api(`/api/folders/${folder.id}`, { method: "PATCH", json: patch });
      void reloadFolders();
    });

  const reanalyze = (ids: string[]) =>
    run(async () => {
      await api("/api/assets/analyze", { method: "POST", json: { ids } });
      refresh();
      setToast({ id: Date.now(), text: `Đã xếp ${ids.length} asset vào hàng đợi phân tích` });
    });

  // ---- Chọn
  const toggleKey = (k: string) => setSelected((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  const clickItem = (e: React.MouseEvent, k: string, open: () => void) => {
    if (e.shiftKey && anchor && visibleKeys.includes(anchor)) {
      e.preventDefault();
      const [i, j] = [visibleKeys.indexOf(anchor), visibleKeys.indexOf(k)].sort((x, y) => x - y);
      const range = visibleKeys.slice(i, j + 1);
      setSelected((s) => (e.ctrlKey || e.metaKey ? [...new Set([...s, ...range])] : range));
      return;
    }
    if (e.ctrlKey || e.metaKey || selecting) {
      toggleKey(k);
      setAnchor(k);
      return;
    }
    open();
  };
  const checkItem = (e: React.MouseEvent, k: string) => {
    if (e.shiftKey && anchor && visibleKeys.includes(anchor)) return clickItem(e, k, () => {});
    toggleKey(k);
    setAnchor(k);
  };
  /** Món kéo/thao tác: cả nhóm đang chọn nếu món này nằm trong nhóm, không thì riêng món này. */
  const itemsFor = (k: string): DragItems => (selectedSet.has(k) ? selection : toItems([k]));

  // ---- Menu chuột phải
  const openMenu = (e: React.MouseEvent | { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) => {
    e.preventDefault?.();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const selectionMenu = (items: DragItems): MenuItem[] => [
    { label: `Chuyển ${countLabel(items)} tới...`, icon: <Svg>{Icon.move}</Svg>, onClick: () => setModal({ type: "move", items }) },
    ...(items.assets.length
      ? [{ label: "Phân tích lại bằng AI", icon: <Svg>{Icon.sparkle}</Svg>, onClick: () => void reanalyze(items.assets) }]
      : []),
    { divider: true },
    { label: `Xóa ${countLabel(items)}`, icon: <Svg>{Icon.trash}</Svg>, danger: true, onClick: () => setModal({ type: "delete", items }) },
  ];

  const folderMenu = (folder: AssetFolder): MenuItem[] => {
    const items = itemsFor(fKey(folder.id));
    if (items.assets.length + items.folders.length > 1) return selectionMenu(items);
    return [
      { label: "Mở", icon: <Svg>{Icon.open}</Svg>, onClick: () => go(folder.id) },
      { label: "Thư mục con mới", icon: <Svg>{Icon.folderPlus}</Svg>, onClick: () => setModal({ type: "create", parent: folder.id }) },
      { label: "Tải file lên đây", icon: <Svg>{Icon.upload}</Svg>, onClick: () => (go(folder.id), setTimeout(() => fileInput.current?.click(), 0)) },
      { divider: true },
      { label: "Đổi tên", icon: <Svg>{Icon.pencil}</Svg>, hint: "F2", onClick: () => setModal({ type: "renameFolder", folder }) },
      {
        label: folder.starred ? "Bỏ gắn sao" : "Gắn sao",
        icon: <StarIcon filled={folder.starred} className="size-4 text-amber-400" />,
        onClick: () => void patchFolder(folder, { starred: !folder.starred }),
      },
      {
        custom: (
          <ColorRow
            value={folder.color}
            onChange={(color) => {
              setMenu(null);
              void patchFolder(folder, { color });
            }}
          />
        ),
      },
      { label: "Chuyển tới...", icon: <Svg>{Icon.move}</Svg>, onClick: () => setModal({ type: "move", items }) },
      { divider: true },
      { label: "Xóa thư mục", icon: <Svg>{Icon.trash}</Svg>, danger: true, onClick: () => setModal({ type: "delete", items }) },
    ];
  };

  const assetMenu = (asset: AssetItem): MenuItem[] => {
    const items = itemsFor(aKey(asset.id));
    if (items.assets.length + items.folders.length > 1) return selectionMenu(items);
    return [
      { label: "Xem chi tiết", icon: <Svg>{Icon.info}</Svg>, onClick: () => setEditing(asset) },
      { label: "Đổi tên", icon: <Svg>{Icon.pencil}</Svg>, hint: "F2", onClick: () => setModal({ type: "renameAsset", asset }) },
      { label: "Chuyển tới...", icon: <Svg>{Icon.move}</Svg>, onClick: () => setModal({ type: "move", items }) },
      ...(showLocation
        ? [{ label: "Mở thư mục chứa", icon: <FolderIcon className="size-4" />, onClick: () => go(asset.folderId ?? "") }]
        : []),
      {
        label: "Tải về",
        icon: <Svg>{Icon.download}</Svg>,
        onClick: () => window.open(`${asset.url}?download=${encodeURIComponent(asset.title || "asset")}`, "_blank"),
      },
      { label: "Phân tích lại bằng AI", icon: <Svg>{Icon.sparkle}</Svg>, onClick: () => void reanalyze([asset.id]) },
      { divider: true },
      { label: "Xóa asset", icon: <Svg>{Icon.trash}</Svg>, danger: true, onClick: () => setModal({ type: "delete", items }) },
    ];
  };

  const newMenu = (): MenuItem[] => [
    { label: "Thư mục mới", icon: <Svg>{Icon.folderPlus}</Svg>, hint: "Shift+N", onClick: () => setModal({ type: "create", parent: folderId }) },
    { divider: true },
    { label: "Tải file lên", icon: <Svg>{Icon.upload}</Svg>, onClick: () => fileInput.current?.click() },
    { label: "Tải thư mục lên", icon: <Svg>{Icon.folderUp}</Svg>, onClick: () => dirInput.current?.click() },
  ];

  const backgroundMenu = (e: React.MouseEvent) => {
    // Chuột phải vào chỗ trống: menu "Mới" (giống Drive)
    if ((e.target as HTMLElement).closest("[draggable=true], button, a, input, select, textarea")) return;
    if (place === "all" || place === "starred") return;
    openMenu(e, newMenu());
  };

  // ---- Phím tắt
  const anyOverlay = !!(modal || editing || menu);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (anyOverlay) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable=true]")) return;
      if (e.key === "Escape" && selected.length) setSelected([]);
      else if ((e.key === "Delete" || e.key === "Backspace") && selected.length) {
        e.preventDefault();
        setModal({ type: "delete", items: toItems(selected) });
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && visibleKeys.length) {
        e.preventDefault();
        setSelected(visibleKeys);
      } else if (e.key === "F2" && selected.length === 1) {
        e.preventDefault();
        const [k] = selected;
        if (k.startsWith("f:")) {
          const folder = index.byId.get(k.slice(2));
          if (folder) setModal({ type: "renameFolder", folder });
        } else {
          const asset = assetById.get(k.slice(2));
          if (asset) setModal({ type: "renameAsset", asset });
        }
      } else if (e.shiftKey && e.key.toLowerCase() === "n" && place !== "all" && place !== "starred") {
        e.preventDefault();
        setModal({ type: "create", parent: folderId });
      } else if (e.altKey && e.key === "ArrowUp" && folderId) {
        e.preventDefault();
        go(currentFolder?.parentId ?? "");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anyOverlay, selected, visibleKeys, index, assetById, place, folderId, currentFolder, go]);

  const onFilter = useCallback((next: { q: string; tag: string }) => {
    setFilter(next);
    setLimit(PAGE_SIZE);
    setSelected([]);
  }, [setFilter, setLimit, setSelected]);

  const retryFailed = () =>
    run(async () => {
      await api("/api/assets/analyze", { method: "POST", json: { failed: true } });
      refresh();
    });

  // ---- Vùng thả file cho cả trang
  const uploadTarget = folderId && currentFolder ? folderId : null;
  const pageDrop = {
    onDragEnter: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      fileDragDepth.current++;
      setFileDrag(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      fileDragDepth.current = Math.max(0, fileDragDepth.current - 1);
      if (!fileDragDepth.current) setFileDrag(false);
    },
    // Bắt ở pha capture: thả vào thư mục con (đã chặn lan truyền) vẫn tắt được thông báo
    onDropCapture: () => {
      fileDragDepth.current = 0;
      setFileDrag(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      onDropFiles(e.dataTransfer, uploadTarget);
    },
  };

  const rootDrop = useDropTarget(null, dropOpts);
  const breadcrumb = index.path(folderId);
  const total = folders.data?.totalAssets ?? null;
  const starredCount = folders.data?.items.filter((f) => f.starred).length ?? 0;

  const title =
    place === "all" ? "Tất cả asset" : place === "starred" ? "Có gắn sao" : currentFolder ? currentFolder.name : missingFolder ? "Không tìm thấy thư mục" : "Thư viện";

  const emptyText = filtering
    ? { title: "Không có kết quả phù hợp", body: folderId ? "Đã tìm trong thư mục này và các thư mục con." : "Thử từ khóa hoặc tag khác." }
    : place === "starred"
      ? { title: "Chưa gắn sao thư mục nào", body: "Chuột phải vào thư mục → Gắn sao để truy cập nhanh ở đây." }
      : currentFolder
        ? { title: "Thư mục trống", body: "Kéo thả file hoặc cả thư mục từ máy vào đây, kéo asset có sẵn vào thư mục, hoặc bấm “Mới”." }
        : { title: "Chưa có asset nào", body: "Kéo thả ảnh/video/audio (hoặc cả thư mục) vào trang, hoặc bấm “Mới”. AI sẽ tự đọc chữ và tóm tắt nội dung từng asset." };

  const loadingMain = (assetsUrl && assets.loading && !assets.data) || (!folders.data && !folders.error);
  const isEmpty = !loadingMain && !folderItems.length && !assetItems.length;

  return (
    <div {...pageDrop} onContextMenu={backgroundMenu}>
      <input
        ref={fileInput}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          void uploadLocal([...(e.target.files ?? [])].map((file) => ({ file, dirs: [] })), uploadTarget);
          e.target.value = "";
        }}
      />
      <input
        ref={dirInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void uploadLocal(filesFromDirectoryInput(e.target.files), uploadTarget);
          e.target.value = "";
        }}
      />
      <PageHeader
        title="Assets"
        subtitle={`${total ?? 0} asset · Ảnh, video và audio để ghép vào video. Sắp xếp bằng thư mục như Drive: kéo thả để chuyển, chuột phải để có thêm tùy chọn.`}
        actions={
          <Button
            variant="primary"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openMenu({ clientX: r.left, clientY: r.bottom + 6 }, newMenu());
            }}
          >
            <Svg>{Icon.plus}</Svg> Mới
          </Button>
        }
      />
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
          <Button size="sm" onClick={() => void retryFailed()}>
            Phân tích lại
          </Button>
        </div>
      )}

      <div className="flex gap-6">
        {/* Thanh bên kiểu Drive */}
        <aside className="hidden w-60 shrink-0 lg:block">
          <div className="scroll-thin sticky top-4 max-h-[calc(100vh-2rem)] space-y-4 overflow-y-auto pb-4">
            <div className="space-y-0.5">
              <NavButton
                active={place === ""}
                icon={<LibraryIcon className="size-4" />}
                label="Thư viện"
                count={folders.data?.unfiled}
                onClick={() => go("")}
                drop={rootDrop}
              />
              <NavButton active={place === "all"} icon={<Svg>{Icon.all}</Svg>} label="Tất cả asset" count={total} onClick={() => go("all")} />
              <NavButton
                active={place === "starred"}
                icon={<StarIcon className="size-4" />}
                label="Có gắn sao"
                count={starredCount || null}
                onClick={() => go("starred")}
              />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between px-2.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Thư mục</p>
                <button
                  type="button"
                  onClick={() => setModal({ type: "create", parent: null })}
                  className="rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                  title="Thư mục mới ở gốc"
                  aria-label="Thư mục mới"
                >
                  <Svg className="size-4">{Icon.plus}</Svg>
                </button>
              </div>
              <FolderTree
                index={index}
                current={folderId}
                expanded={treeExpanded}
                onToggle={toggleTree}
                onOpen={go}
                onItems={dropOpts.onItems}
                onFiles={onDropFiles}
                onContextMenu={(e, f) => openMenu(e, folderMenu(f))}
                onDragFolder={(e, f) => startItemsDrag(e, itemsFor(fKey(f.id)))}
              />
            </div>
            <StorageMeter list={folders.data} />
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          {/* Điều hướng nhanh trên màn hình nhỏ */}
          <div className="mb-3 flex gap-1 overflow-x-auto lg:hidden">
            {(
              [
                ["", "Thư viện"],
                ["all", "Tất cả asset"],
                ["starred", "Gắn sao"],
              ] as const
            ).map(([p, label]) => (
              <button
                key={p}
                type="button"
                onClick={() => go(p)}
                className={cx(
                  "shrink-0 rounded-lg px-3 py-1.5 text-sm ring-1",
                  (p === "" ? place === "" || !!folderId : place === p) ? "bg-brand-50 font-medium text-brand-700 ring-brand-500" : "bg-surface text-zinc-700 ring-zinc-200",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Breadcrumb + thao tác thư mục hiện tại */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <nav aria-label="Đường dẫn thư mục" className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm">
              {place === "all" || place === "starred" ? (
                <span className="px-2 py-1 text-lg font-semibold text-zinc-900">{title}</span>
              ) : (
                <>
                  <Crumb
                    target={null}
                    label="Thư viện"
                    icon={<LibraryIcon className="size-4" />}
                    current={!folderId}
                    onGo={() => go("")}
                    drop={dropOpts}
                  />
                  {breadcrumb.map((f, i) => (
                    <span key={f.id} className="flex min-w-0 items-center gap-0.5">
                      <Chevron className="text-zinc-300" />
                      <Crumb target={f.id} label={f.name} current={i === breadcrumb.length - 1} onGo={() => go(f.id)} drop={dropOpts} />
                    </span>
                  ))}
                  {currentFolder && (
                    <button
                      type="button"
                      aria-label="Tùy chọn thư mục"
                      onClick={(e) => {
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        openMenu({ clientX: r.left, clientY: r.bottom + 4 }, folderMenu(currentFolder));
                      }}
                      className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100"
                    >
                      <Chevron className="rotate-90" />
                    </button>
                  )}
                </>
              )}
              {assets.loading && assets.data && <Spinner className="ml-2 size-3.5 text-zinc-400" />}
            </nav>
            <div className="flex items-center gap-2">
              <select className={`${inputClass} w-auto! py-1.5!`} value={sort} onChange={(e) => (setSort(e.target.value as Sort), setLimit(PAGE_SIZE))} aria-label="Sắp xếp">
                {Object.entries(SORTS).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
              <div className="flex rounded-lg p-0.5 ring-1 ring-zinc-300">
                {(["grid", "list"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => saveView(v)}
                    aria-pressed={view === v}
                    title={v === "grid" ? "Dạng lưới" : "Dạng danh sách"}
                    className={cx("rounded-md p-1.5", view === v ? "bg-brand-50 text-brand-700" : "text-zinc-500 hover:bg-zinc-100")}
                  >
                    <Svg>{v === "grid" ? Icon.grid : Icon.list}</Svg>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <LibraryFilters
            kind="assets"
            q={filter.q}
            tag={filter.tag}
            onChange={onFilter}
            placeholder={currentFolder ? `Tìm trong “${currentFolder.name}”...` : "Tìm theo tên, mô tả, chữ trong ảnh..."}
          >
            <select
              className={`${inputClass} w-auto!`}
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setLimit(PAGE_SIZE);
              }}
            >
              <option value="">Tất cả loại</option>
              <option value="image">Chỉ ảnh</option>
              <option value="video">Chỉ video</option>
              <option value="audio">Chỉ audio</option>
            </select>
          </LibraryFilters>

          {/* Thanh thao tác khi đang chọn */}
          {selecting && (
            <div className="sticky top-2 z-20 mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-surface px-3 py-2 text-sm shadow-md ring-1 ring-brand-200">
              <button type="button" onClick={() => setSelected([])} aria-label="Bỏ chọn" className="rounded-md px-1.5 text-lg leading-none text-zinc-500 hover:bg-zinc-100">
                ×
              </button>
              <span className="font-medium text-zinc-800">Đã chọn {countLabel(selection)}</span>
              {visibleKeys.length > selected.length && (
                <Button size="sm" variant="ghost" onClick={() => setSelected(visibleKeys)}>
                  Chọn tất cả ({visibleKeys.length})
                </Button>
              )}
              <span className="ml-auto flex flex-wrap items-center gap-1.5">
                <Button size="sm" onClick={() => setModal({ type: "move", items: selection })}>
                  <Svg className="size-3.5">{Icon.move}</Svg> Chuyển tới...
                </Button>
                {selection.assets.length > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => void reanalyze(selection.assets)}>
                    <Svg className="size-3.5">{Icon.sparkle}</Svg> Phân tích lại
                  </Button>
                )}
                <Button size="sm" variant="danger" onClick={() => setModal({ type: "delete", items: selection })}>
                  <Svg className="size-3.5">{Icon.trash}</Svg> Xóa
                </Button>
              </span>
            </div>
          )}
          <div className="mb-3 space-y-2">
            <ErrorBox message={actionError} />
            <ErrorBox message={assets.error ?? folders.error} onRetry={refresh} />
          </div>
          {filtering && (
            <p className="mb-3 text-xs text-zinc-500">
              {folderId ? `Kết quả trong “${currentFolder?.name ?? ""}” và các thư mục con` : "Kết quả trong toàn bộ thư viện"}
              {assets.data ? ` · ${assets.data.total} asset` : ""}
            </p>
          )}

          {missingFolder ? (
            <EmptyState title="Thư mục không còn tồn tại">
              <Button className="mt-3" onClick={() => go("")}>
                Về Thư viện
              </Button>
            </EmptyState>
          ) : loadingMain ? (
            <Loading />
          ) : isEmpty ? (
            <EmptyState title={emptyText.title}>{emptyText.body}</EmptyState>
          ) : view === "grid" ? (
            <div className="space-y-6">
              {folderItems.length > 0 && (
                <section>
                  <h2 className="mb-2 text-sm font-medium text-zinc-500">Thư mục</h2>
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                    {folderItems.map((f) => {
                      const k = fKey(f.id);
                      return (
                        <FolderTile
                          key={f.id}
                          folder={f}
                          selected={selectedSet.has(k)}
                          selecting={selecting}
                          drop={dropOpts}
                          onOpen={() => go(f.id)}
                          onClick={(e) => clickItem(e, k, () => go(f.id))}
                          onCheck={(e) => checkItem(e, k)}
                          onDragStart={(e) => startItemsDrag(e, itemsFor(k))}
                          onContextMenu={(e) => openMenu(e, folderMenu(f))}
                        />
                      );
                    })}
                  </div>
                </section>
              )}
              {assetItems.length > 0 && (
                <section>
                  {folderItems.length > 0 && <h2 className="mb-2 text-sm font-medium text-zinc-500">Asset</h2>}
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                    {assetItems.map((a) => {
                      const k = aKey(a.id);
                      return (
                        <AssetTile
                          key={a.id}
                          asset={a}
                          selected={selectedSet.has(k)}
                          selecting={selecting}
                          folderLabel={showLocation ? folderLabel(a) : undefined}
                          onFolderClick={() => go(a.folderId ?? "")}
                          onTag={(tag) => onFilter({ q: filter.q, tag })}
                          onClick={(e) => clickItem(e, k, () => setEditing(a))}
                          onCheck={(e) => checkItem(e, k)}
                          onDragStart={(e) => startItemsDrag(e, itemsFor(k))}
                          onContextMenu={(e) => openMenu(e, assetMenu(a))}
                        />
                      );
                    })}
                  </div>
                </section>
              )}
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl bg-surface ring-1 ring-zinc-200/80">
              <table className="w-full table-fixed text-sm">
                <thead className="border-b border-zinc-200 text-left text-xs font-medium text-zinc-500">
                  <tr>
                    <th className="w-10 py-2 pl-3" />
                    <th className="py-2 pr-3">Tên</th>
                    <th className="hidden w-28 py-2 pr-3 sm:table-cell">Loại</th>
                    {showLocation && <th className="hidden w-40 py-2 pr-3 md:table-cell">Vị trí</th>}
                    <th className="hidden w-24 py-2 pr-3 text-right sm:table-cell">Dung lượng</th>
                    <th className="hidden w-40 py-2 pr-3 md:table-cell">Ngày thêm</th>
                  </tr>
                </thead>
                <tbody>
                  {folderItems.map((f) => {
                    const k = fKey(f.id);
                    return (
                      <FolderRow
                        key={f.id}
                        folder={f}
                        selected={selectedSet.has(k)}
                        selecting={selecting}
                        showLocation={showLocation}
                        drop={dropOpts}
                        onOpen={() => go(f.id)}
                        onClick={(e) => clickItem(e, k, () => go(f.id))}
                        onCheck={(e) => checkItem(e, k)}
                        onDragStart={(e) => startItemsDrag(e, itemsFor(k))}
                        onContextMenu={(e) => openMenu(e, folderMenu(f))}
                      />
                    );
                  })}
                  {assetItems.map((a) => {
                    const k = aKey(a.id);
                    return (
                      <AssetRow
                        key={a.id}
                        asset={a}
                        selected={selectedSet.has(k)}
                        selecting={selecting}
                        folderLabel={showLocation ? folderLabel(a) : undefined}
                        onFolderClick={() => go(a.folderId ?? "")}
                        onClick={(e) => clickItem(e, k, () => setEditing(a))}
                        onCheck={(e) => checkItem(e, k)}
                        onDragStart={(e) => startItemsDrag(e, itemsFor(k))}
                        onContextMenu={(e) => openMenu(e, assetMenu(a))}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {assets.data && assetsUrl && assets.data.total > assetItems.length && (
            <div className="mt-6 text-center">
              <Button onClick={() => setLimit((l) => l + PAGE_SIZE)}>Xem thêm ({assets.data.total - assetItems.length})</Button>
            </div>
          )}
          {!isEmpty && !loadingMain && (
            <p className="mt-6 text-center text-xs text-zinc-400">
              Mẹo: Ctrl/⌘ + bấm hoặc Shift + bấm để chọn nhiều · Ctrl/⌘ + A chọn tất cả · Delete để xóa · F2 đổi tên · Shift + N thư mục mới · Alt + ↑ lên thư mục cha
            </p>
          )}
        </main>
      </div>

      {fileDrag && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[55] flex justify-center px-4">
          <div className="flex items-center gap-2 rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-medium text-white shadow-xl">
            <Svg>{Icon.upload}</Svg>
            Thả để tải lên “{currentFolder?.name ?? "Thư viện"}” — hoặc thả đúng vào một thư mục
          </div>
        </div>
      )}
      {fileDrag && <div className="pointer-events-none fixed inset-0 z-40 border-4 border-dashed border-brand-500/60 bg-brand-50/20" />}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      <ToastBar toast={toast} onClose={closeToast} />

      {modal?.type === "create" && (
        <NameModal
          title={modal.parent ? `Thư mục mới trong “${placeName(modal.parent)}”` : "Thư mục mới"}
          initial=""
          onClose={() => setModal(null)}
          onSubmit={async (name) => {
            await api<AssetFolder>("/api/folders", { method: "POST", json: { name, parentId: modal.parent } });
            if (modal.parent) toggleTree(modal.parent, true);
            void reloadFolders();
          }}
        />
      )}
      {modal?.type === "renameFolder" && (
        <NameModal
          title="Đổi tên thư mục"
          initial={modal.folder.name}
          onClose={() => setModal(null)}
          onSubmit={async (name) => {
            await api(`/api/folders/${modal.folder.id}`, { method: "PATCH", json: { name } });
            void reloadFolders();
          }}
        />
      )}
      {modal?.type === "renameAsset" && (
        <NameModal
          title="Đổi tên asset"
          label="Tiêu đề"
          placeholder="Tiêu đề asset"
          initial={modal.asset.title}
          onClose={() => setModal(null)}
          onSubmit={async (title) => {
            await api(`/api/assets/${modal.asset.id}`, { method: "PATCH", json: { title } });
            void reloadAssets();
          }}
        />
      )}
      {modal?.type === "move" && (
        <MoveModal index={index} items={modal.items} initial={folderId} onClose={() => setModal(null)} onMove={(target) => moveItems(modal.items, target)} />
      )}
      {modal?.type === "delete" && (
        <DeleteModal index={index} items={modal.items} onClose={() => setModal(null)} onDelete={(withContents) => deleteItems(modal.items, withContents)} />
      )}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={`Chi tiết ${editing ? KIND_LABEL[editing.kind] : ""}`} wide>
        {editing && (
          <AssetEditor key={editing.id} initial={editing} folders={folders.data?.items ?? []} onClose={() => setEditing(null)} onChanged={refresh} />
        )}
      </Modal>
    </div>
  );
}
