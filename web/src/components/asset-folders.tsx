"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatBytes, useApi } from "@/lib/client";
import { FOLDER_COLORS, type AssetFolder, type FolderColor, type FolderList } from "@/lib/types";
import { Button, ErrorBox, Field, Modal, cx, inputClass } from "./ui";

export type { FolderList };

export function useFolders() {
  return useApi<FolderList>("/api/folders");
}

// ---------------------------------------------------------------- Cây thư mục

export type FolderIndex = {
  byId: Map<string, AssetFolder>;
  /** Thư mục con (A→Z) của một thư mục; null = gốc thư viện */
  children: (parentId: string | null) => AssetFolder[];
  /** Đường dẫn từ gốc tới thư mục (gồm chính nó) */
  path: (id: string | null) => AssetFolder[];
  /** id nằm trong (hoặc chính là) ancestorId */
  isInside: (id: string | null, ancestorId: string) => boolean;
  /** Danh sách phẳng theo thứ tự cây, kèm độ sâu (để làm ô chọn thụt lề) */
  flat: { folder: AssetFolder; depth: number }[];
};

export function buildFolderIndex(items: AssetFolder[]): FolderIndex {
  const byId = new Map(items.map((f) => [f.id, f]));
  const kids = new Map<string | null, AssetFolder[]>();
  for (const f of items) {
    // Thư mục cha không còn (không nên xảy ra): coi như ở gốc
    const parent = f.parentId && byId.has(f.parentId) ? f.parentId : null;
    kids.set(parent, [...(kids.get(parent) ?? []), f]);
  }
  const children = (parentId: string | null) => kids.get(parentId) ?? [];
  const path = (id: string | null) => {
    const out: AssetFolder[] = [];
    for (let cur = id ? byId.get(id) : undefined; cur && out.length < 50; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
      out.unshift(cur);
    }
    return out;
  };
  const isInside = (id: string | null, ancestorId: string) => path(id).some((f) => f.id === ancestorId);
  const flat: FolderIndex["flat"] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const f of children(parent)) {
      flat.push({ folder: f, depth });
      if (depth < 30) walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return { byId, children, path, isInside, flat };
}

export function useFolderIndex(list: FolderList | null): FolderIndex {
  return useMemo(() => buildFolderIndex(list?.items ?? []), [list]);
}

// ---------------------------------------------------------------- Biểu tượng

export function FolderIcon({ className, color, open }: { className?: string; color?: FolderColor | null; open?: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className={cx("shrink-0", className ?? "size-4", !color && "text-amber-500")}
      style={color ? { color: FOLDER_COLORS[color] } : undefined}
      fill="currentColor"
      aria-hidden
    >
      {open ? (
        <path d="M2 5.5A2.5 2.5 0 0 1 4.5 3h3.38a2 2 0 0 1 1.42.59L10.7 5h4.8A2.5 2.5 0 0 1 18 7.5V8H6.3a2 2 0 0 0-1.9 1.37L2.3 15.6A2.5 2.5 0 0 1 2 14.5v-9Zm2.46 4.3A1 1 0 0 1 5.4 9.1h12.1a1 1 0 0 1 .95 1.3l-1.6 5.07a2 2 0 0 1-1.9 1.4H4.5a1 1 0 0 1-.95-1.31l.91-5.76Z" />
      ) : (
        <path d="M2 5.5A2.5 2.5 0 0 1 4.5 3h3.38a2 2 0 0 1 1.42.59L10.7 5h4.8A2.5 2.5 0 0 1 18 7.5v7a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 2 14.5v-9Z" />
      )}
    </svg>
  );
}

export function StarIcon({ className, filled }: { className?: string; filled?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" className={cx("shrink-0", className ?? "size-4")} fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path
        strokeLinejoin="round"
        d="M10 2.5l2.32 4.7 5.18.75-3.75 3.66.89 5.16L10 14.33l-4.64 2.44.89-5.16L2.5 7.95l5.18-.75L10 2.5Z"
      />
    </svg>
  );
}

// ---------------------------------------------------------------- Ô chọn thư mục

/** Ô chọn thư mục dạng cây thụt lề (dùng trong form sửa asset, trình chọn asset). */
export function FolderSelect({
  folders,
  value,
  onChange,
  allLabel,
  noneLabel = "Thư viện (gốc)",
  className,
}: {
  folders: AssetFolder[];
  value: string;
  onChange: (value: string) => void;
  /** Có thì thêm lựa chọn "tất cả" (value "") và gốc có value "none" */
  allLabel?: string;
  noneLabel?: string;
  className?: string;
}) {
  const index = useMemo(() => buildFolderIndex(folders), [folders]);
  return (
    <select className={cx(inputClass, className)} value={value} onChange={(e) => onChange(e.target.value)}>
      {allLabel !== undefined && <option value="">{allLabel}</option>}
      <option value={allLabel !== undefined ? "none" : ""}>{noneLabel}</option>
      {index.flat.map(({ folder: f, depth }) => (
        <option key={f.id} value={f.id}>
          {"   ".repeat(depth + 1)}
          {f.name} ({f.totalAssets})
        </option>
      ))}
    </select>
  );
}

/** Chọn nhiều thư mục (checkbox dạng cây), dùng để giới hạn thư viện cho AI. */
export function FolderMultiPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const folders = useFolders();
  const index = useFolderIndex(folders.data);
  const [open, setOpen] = useState(false);
  if (!folders.data) return null;
  if (!index.flat.length) return <p className="text-xs text-zinc-500">Chưa có thư mục nào. Tạo thư mục ở trang Assets.</p>;
  const selected = new Set(value);
  const names = value.map((id) => index.byId.get(id)?.name).filter(Boolean);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={cx(inputClass, "w-auto! flex items-center gap-2 text-left", value.length > 0 && "ring-brand-500")}>
          <span className={value.length ? "text-zinc-900" : "text-zinc-500"}>{value.length ? `${value.length} thư mục đã chọn` : "Mọi thư mục"}</span>
          <span aria-hidden className="text-xs text-zinc-400">
            ▾
          </span>
        </button>
        {names.map((name, i) => (
          <button
            key={value[i]}
            type="button"
            onClick={() => onChange(value.filter((id) => id !== value[i]))}
            className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-100"
            title="Bỏ thư mục này"
          >
            <FolderIcon className="size-3.5" /> {name} ×
          </button>
        ))}
      </div>
      {open && (
        <div className="scroll-thin max-h-64 overflow-y-auto rounded-xl bg-surface p-2 ring-1 ring-zinc-200">
          {index.flat.map(({ folder: f, depth }) => (
            <label key={f.id} className="flex cursor-pointer items-center gap-2 rounded-md py-1 pr-2 text-sm hover:bg-zinc-50" style={{ paddingLeft: 8 + depth * 18 }}>
              <input
                type="checkbox"
                className="accent-brand-500"
                checked={selected.has(f.id)}
                onChange={() => onChange(selected.has(f.id) ? value.filter((id) => id !== f.id) : [...value, f.id])}
              />
              <FolderIcon className="size-4" color={f.color} />
              <span className="truncate text-zinc-800">{f.name}</span>
              <span className="ml-auto text-xs tabular-nums text-zinc-400">{f.totalAssets}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Kéo thả

/** Kiểu dữ liệu kéo thả khi kéo asset/thư mục trong thư viện (khác với kéo file từ máy để tải lên). */
export const ITEMS_DRAG_TYPE = "application/x-videogen-items";
export type DragItems = { assets: string[]; folders: string[] };

// dataTransfer.getData() không đọc được trong lúc dragover: giữ món đang kéo để kiểm tra chỗ thả hợp lệ
let currentDrag: DragItems | null = null;

export function startItemsDrag(e: React.DragEvent, items: DragItems) {
  currentDrag = items;
  e.dataTransfer.setData(ITEMS_DRAG_TYPE, JSON.stringify(items));
  e.dataTransfer.setData("text/plain", `${items.assets.length + items.folders.length} mục`);
  e.dataTransfer.effectAllowed = "move";
  // Ảnh kéo gọn gàng: "3 mục" (giống Drive)
  const n = items.assets.length + items.folders.length;
  const ghost = document.createElement("div");
  ghost.textContent = n === 1 ? (items.folders.length ? "1 thư mục" : "1 asset") : `${n} mục`;
  ghost.style.cssText =
    "position:fixed;top:-1000px;left:-1000px;padding:6px 12px;border-radius:9px;background:#e95420;color:#fff;font:600 13px system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.25)";
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, -10, -10);
  setTimeout(() => ghost.remove(), 0);
}

export function endItemsDrag() {
  currentDrag = null;
}

const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");
const hasItems = (e: React.DragEvent) => e.dataTransfer.types.includes(ITEMS_DRAG_TYPE);

/**
 * Biến một phần tử thành chỗ thả: nhận asset/thư mục kéo trong thư viện (chuyển vào `target`)
 * và file/thư mục kéo từ máy (tải lên vào `target`). target null = gốc thư viện.
 */
export function useDropTarget(
  target: string | null,
  opts: {
    index: FolderIndex;
    onItems: (items: DragItems, target: string | null) => void;
    onFiles?: (data: DataTransfer, target: string | null) => void;
    /** gọi khi giữ món kéo trên chỗ thả một lúc (vd mở rộng nhánh cây) */
    onHold?: () => void;
    disabled?: boolean;
  },
) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHold = () => {
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
  };
  useEffect(() => clearHold, []);

  const accepts = (e: React.DragEvent) => {
    if (opts.disabled) return false;
    if (hasFiles(e)) return !!opts.onFiles;
    if (!hasItems(e)) return false;
    // Không thả thư mục vào chính nó hay thư mục con của nó
    if (target && currentDrag?.folders.some((id) => opts.index.isInside(target, id))) return false;
    return true;
  };

  const props = {
    // dragenter/dragleave vẫn lan lên trang (để trang biết đang kéo file); chỉ dragover/drop bị chặn
    onDragEnter: (e: React.DragEvent) => {
      if (!accepts(e)) return;
      e.preventDefault();
      depth.current++;
      setOver(true);
      if (opts.onHold && !hold.current) hold.current = setTimeout(() => opts.onHold?.(), 700);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = hasFiles(e) ? "copy" : "move";
    },
    onDragLeave: () => {
      if (!over && depth.current === 0) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) {
        setOver(false);
        clearHold();
      }
    },
    onDrop: (e: React.DragEvent) => {
      depth.current = 0;
      setOver(false);
      clearHold();
      if (!accepts(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (hasFiles(e)) {
        opts.onFiles?.(e.dataTransfer, target);
        return;
      }
      const raw = e.dataTransfer.getData(ITEMS_DRAG_TYPE);
      endItemsDrag();
      if (!raw) return;
      const items = JSON.parse(raw) as DragItems;
      // Thả vào đúng chỗ đang nằm: bỏ qua
      const assets = items.assets;
      const folders = items.folders.filter((id) => id !== target && (opts.index.byId.get(id)?.parentId ?? null) !== target);
      if (assets.length || folders.length) opts.onItems({ assets, folders }, target);
    },
  };
  return { over, props };
}

// ---------------------------------------------------------------- Đọc file/thư mục kéo từ máy

export type LocalFile = { file: File; /** thư mục con tính từ chỗ thả, vd ["Ảnh", "2024"] */ dirs: string[] };

type FsEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void, fail: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (entries: FsEntry[]) => void, fail: (e: unknown) => void) => void };
};

async function walkEntry(entry: FsEntry, dirs: string[], out: LocalFile[]): Promise<void> {
  if (out.length > 5000) return;
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((ok, fail) => entry.file!(ok, fail));
    out.push({ file, dirs });
  } else if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    // readEntries trả về từng đợt (tối đa ~100 mục): đọc tới khi hết
    for (;;) {
      const batch = await new Promise<FsEntry[]>((ok, fail) => reader.readEntries(ok, fail));
      if (!batch.length) break;
      for (const child of batch) await walkEntry(child, [...dirs, entry.name], out);
    }
  }
}

/** Lấy file (kèm thư mục con) từ một lần thả: hỗ trợ kéo cả thư mục từ máy vào. */
export async function readDroppedFiles(data: DataTransfer): Promise<LocalFile[]> {
  // Phải lấy entry ngay trong sự kiện drop, trước mọi await
  const entries = [...data.items]
    .filter((i) => i.kind === "file")
    .map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.() ?? null);
  const plain = [...data.files];
  if (!entries.length || entries.some((e) => !e)) return plain.map((file) => ({ file, dirs: [] }));
  const out: LocalFile[] = [];
  for (const entry of entries) await walkEntry(entry!, [], out);
  return out;
}

/** File chọn bằng ô "Tải thư mục lên" (webkitdirectory): thư mục lấy từ webkitRelativePath. */
export function filesFromDirectoryInput(list: FileList | null): LocalFile[] {
  return [...(list ?? [])].map((file) => ({ file, dirs: file.webkitRelativePath.split("/").slice(0, -1) }));
}

// ---------------------------------------------------------------- Menu chuột phải

export type MenuItem =
  | { label: string; icon?: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean; hint?: string }
  | { divider: true }
  | { custom: ReactNode };

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Giữ menu trong màn hình
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
  }, [x, y]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[60] min-w-52 rounded-xl bg-surface p-1 text-sm shadow-xl ring-1 ring-zinc-200"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        "divider" in item ? (
          <div key={i} className="my-1 h-px bg-zinc-100" />
        ) : "custom" in item ? (
          <div key={i}>{item.custom}</div>
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onClick();
            }}
            className={cx(
              "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left disabled:opacity-40",
              item.danger ? "text-red-600 hover:bg-red-50" : "text-zinc-700 hover:bg-zinc-100",
            )}
          >
            <span className="grid size-4 place-items-center text-zinc-500">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            {item.hint && <span className="text-xs text-zinc-400">{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

/** Hàng chọn màu thư mục (trong menu chuột phải). */
export function ColorRow({ value, onChange }: { value: FolderColor | null; onChange: (color: FolderColor | null) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-1.5">
      <button
        type="button"
        onClick={() => onChange(null)}
        title="Màu mặc định"
        className={cx("grid size-5 place-items-center rounded-full ring-1 ring-zinc-300", !value && "ring-2 ring-brand-500")}
      >
        <FolderIcon className="size-3" />
      </button>
      {(Object.keys(FOLDER_COLORS) as FolderColor[]).map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          title={c}
          className={cx("size-5 rounded-full", value === c && "ring-2 ring-brand-500 ring-offset-1 ring-offset-surface")}
          style={{ background: FOLDER_COLORS[c] }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Hộp thoại

/** Hộp thoại nhập tên (tạo thư mục, đổi tên thư mục hoặc asset). */
export function NameModal({
  title,
  label = "Tên thư mục",
  initial,
  placeholder = "vd: Gameplay, Logo, Nhạc nền...",
  onClose,
  onSubmit,
}: {
  title: string;
  label?: string;
  initial: string;
  placeholder?: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={title}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={label}>
          <input
            autoFocus
            onFocus={(e) => e.target.select()}
            className={inputClass}
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
            placeholder={placeholder}
          />
        </Field>
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Hủy
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>
            Lưu
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Chọn thư mục đích để chuyển asset/thư mục tới (cây thư mục, giống "Di chuyển tới" của Drive). */
export function MoveModal({
  index,
  items,
  initial,
  onClose,
  onMove,
}: {
  index: FolderIndex;
  items: DragItems;
  /** thư mục đang mở (chọn sẵn) */
  initial: string | null;
  onClose: () => void;
  onMove: (target: string | null) => Promise<void>;
}) {
  const [target, setTarget] = useState<string | null>(initial);
  const [open, setOpen] = useState<Set<string>>(() => new Set(index.path(initial).map((f) => f.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = (id: string) => items.folders.some((f) => index.isInside(id, f));
  const n = items.assets.length + items.folders.length;

  const row = (f: AssetFolder, depth: number): ReactNode => {
    const kids = index.children(f.id);
    const expanded = open.has(f.id);
    const disabled = blocked(f.id);
    return (
      <div key={f.id}>
        <div
          className={cx(
            "flex items-center gap-1 rounded-lg pr-2 text-sm",
            target === f.id ? "bg-brand-50 text-brand-700" : "hover:bg-zinc-50",
            disabled && "opacity-40",
          )}
          style={{ paddingLeft: 4 + depth * 18 }}
        >
          <button
            type="button"
            aria-label={expanded ? "Thu gọn" : "Mở rộng"}
            onClick={() => setOpen((s) => (s.has(f.id) ? new Set([...s].filter((x) => x !== f.id)) : new Set([...s, f.id])))}
            className={cx("grid size-6 place-items-center rounded text-zinc-400 hover:bg-zinc-100", !kids.length && "invisible")}
          >
            <Chevron open={expanded} />
          </button>
          <button type="button" disabled={disabled} onClick={() => setTarget(f.id)} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left">
            <FolderIcon className="size-4" color={f.color} />
            <span className="truncate">{f.name}</span>
          </button>
        </div>
        {expanded && kids.map((k) => row(k, depth + 1))}
      </div>
    );
  };

  return (
    <Modal open onClose={onClose} title={`Chuyển ${n} mục tới...`}>
      <div className="space-y-4">
        <div className="scroll-thin max-h-[50vh] overflow-y-auto rounded-xl p-1 ring-1 ring-zinc-200">
          <button
            type="button"
            onClick={() => setTarget(null)}
            className={cx("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium", target === null ? "bg-brand-50 text-brand-700" : "hover:bg-zinc-50")}
          >
            <LibraryIcon className="size-4" /> Thư viện (gốc)
          </button>
          {index.children(null).map((f) => row(f, 0))}
        </div>
        <p className="text-xs text-zinc-500">
          Chuyển tới: <b className="text-zinc-700">{target ? index.path(target).map((f) => f.name).join(" / ") : "Thư viện (gốc)"}</b>
        </p>
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Hủy
          </Button>
          <Button
            variant="primary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onMove(target);
                onClose();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Chuyển tới đây
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Xác nhận xóa asset/thư mục; thư mục có thể giữ lại nội dung (chuyển lên thư mục cha) hoặc xóa luôn. */
export function DeleteModal({
  index,
  items,
  onClose,
  onDelete,
}: {
  index: FolderIndex;
  items: DragItems;
  onClose: () => void;
  onDelete: (withContents: boolean) => Promise<void>;
}) {
  const [withContents, setWithContents] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folders = items.folders.map((id) => index.byId.get(id)).filter((f): f is AssetFolder => !!f);
  const inside = folders.reduce((n, f) => n + f.totalAssets, 0);
  const parts = [items.assets.length && `${items.assets.length} asset`, folders.length && `${folders.length} thư mục`].filter(Boolean);
  return (
    <Modal open onClose={onClose} title={`Xóa ${parts.join(" và ")}?`}>
      <div className="space-y-4 text-sm text-zinc-600">
        {folders.length === 1 && items.assets.length === 0 && (
          <p>
            Thư mục <b className="text-zinc-800">“{folders[0].name}”</b> có {folders[0].totalAssets} asset (tính cả thư mục con).
          </p>
        )}
        {items.assets.length > 0 && <p>Asset bị xóa vĩnh viễn khỏi thư viện (file trên máy chủ cũng bị xóa). Video đã tạo không bị ảnh hưởng.</p>}
        {folders.length > 0 && (
          <div className="space-y-2 rounded-xl bg-zinc-50 p-3 ring-1 ring-zinc-200">
            <label className="flex cursor-pointer items-start gap-2">
              <input type="radio" className="mt-0.5 accent-brand-500" checked={!withContents} onChange={() => setWithContents(false)} />
              <span>
                <b className="text-zinc-800">Chỉ xóa thư mục</b> — asset và thư mục con bên trong được giữ lại, chuyển lên thư mục cha.
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2">
              <input type="radio" className="mt-0.5 accent-red-600" checked={withContents} onChange={() => setWithContents(true)} />
              <span>
                <b className="text-red-600">Xóa cả nội dung</b> — xóa vĩnh viễn {inside} asset và mọi thư mục con bên trong.
              </span>
            </label>
          </div>
        )}
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Hủy
          </Button>
          <Button
            variant="danger"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onDelete(withContents);
                onClose();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Xóa
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Thanh bên: cây thư mục

export function Chevron({ open, className }: { open?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={cx("size-3.5 transition-transform", open && "rotate-90", className)} fill="currentColor" aria-hidden>
      <path d="M7.2 4.7a.75.75 0 0 1 1.06 0l4.77 4.77a.75.75 0 0 1 0 1.06L8.26 15.3a.75.75 0 1 1-1.06-1.06L11.44 10 7.2 5.76a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

export function LibraryIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={cx("shrink-0", className ?? "size-4")} fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden>
      <path strokeLinejoin="round" d="M3 6.5 10 3l7 3.5L10 10 3 6.5Z" />
      <path strokeLinejoin="round" d="m3 10 7 3.5 7-3.5M3 13.5 10 17l7-3.5" />
    </svg>
  );
}

type TreeProps = {
  index: FolderIndex;
  current: string | null;
  expanded: Set<string>;
  onToggle: (id: string, open?: boolean) => void;
  onOpen: (id: string) => void;
  onItems: (items: DragItems, target: string | null) => void;
  onFiles: (data: DataTransfer, target: string | null) => void;
  onContextMenu: (e: React.MouseEvent, folder: AssetFolder) => void;
  onDragFolder: (e: React.DragEvent, folder: AssetFolder) => void;
};

function TreeNode({ folder, depth, ...p }: TreeProps & { folder: AssetFolder; depth: number }) {
  const kids = p.index.children(folder.id);
  const open = p.expanded.has(folder.id);
  const drop = useDropTarget(folder.id, { index: p.index, onItems: p.onItems, onFiles: p.onFiles, onHold: () => p.onToggle(folder.id, true) });
  const active = p.current === folder.id;
  return (
    <div>
      <div
        {...drop.props}
        draggable
        onDragStart={(e) => p.onDragFolder(e, folder)}
        onDragEnd={endItemsDrag}
        onContextMenu={(e) => p.onContextMenu(e, folder)}
        className={cx(
          "group flex items-center gap-0.5 rounded-lg pr-2 text-sm transition-colors",
          drop.over ? "bg-brand-100 ring-2 ring-brand-500" : active ? "bg-brand-50 font-medium text-brand-700" : "text-zinc-700 hover:bg-zinc-100",
        )}
        style={{ paddingLeft: 2 + depth * 14 }}
      >
        <button
          type="button"
          aria-label={open ? "Thu gọn" : "Mở rộng"}
          onClick={() => p.onToggle(folder.id)}
          className={cx("grid size-6 shrink-0 place-items-center rounded text-zinc-400 hover:bg-zinc-200/60", !kids.length && "invisible")}
        >
          <Chevron open={open} />
        </button>
        <button type="button" onClick={() => p.onOpen(folder.id)} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left" title={folder.name}>
          <FolderIcon className="size-4" color={folder.color} open={active} />
          <span className="truncate">{folder.name}</span>
          {folder.starred && <StarIcon filled className="size-3 text-amber-400" />}
        </button>
        <span className="text-[11px] tabular-nums text-zinc-400">{folder.totalAssets || ""}</span>
      </div>
      {open && kids.map((k) => <TreeNode key={k.id} folder={k} depth={depth + 1} {...p} />)}
    </div>
  );
}

/** Nút điều hướng của thanh bên (Thư viện, Tất cả asset, Gắn sao); có thể là chỗ thả. */
export function NavButton({
  active,
  icon,
  label,
  count,
  onClick,
  drop,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  count?: number | null;
  onClick: () => void;
  drop?: ReturnType<typeof useDropTarget>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      {...drop?.props}
      className={cx(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
        drop?.over ? "bg-brand-100 ring-2 ring-brand-500" : active ? "bg-brand-50 font-medium text-brand-700" : "text-zinc-700 hover:bg-zinc-100",
      )}
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {count != null && <span className="text-[11px] tabular-nums text-zinc-400">{count}</span>}
    </button>
  );
}

export function FolderTree(props: Omit<TreeProps, "onDragFolder"> & { onDragFolder: TreeProps["onDragFolder"] }) {
  const roots = props.index.children(null);
  if (!roots.length) return <p className="px-2.5 py-1 text-xs text-zinc-400">Chưa có thư mục</p>;
  return (
    <div>
      {roots.map((f) => (
        <TreeNode key={f.id} folder={f} depth={0} {...props} />
      ))}
    </div>
  );
}

/** Thanh dung lượng thư viện. */
export function StorageMeter({ list }: { list: FolderList | null }) {
  if (!list) return null;
  return (
    <div className="px-2.5 text-xs text-zinc-500">
      <p>
        <b className="text-zinc-700">{formatBytes(list.totalBytes)}</b> · {list.totalAssets} asset · {list.items.length} thư mục
      </p>
    </div>
  );
}
