"use client";

import { useState } from "react";
import { api, useApi } from "@/lib/client";
import type { AssetFolder } from "@/lib/types";
import { Button, ConfirmButton, ErrorBox, Field, Modal, cx, inputClass } from "./ui";

export type FolderList = { items: AssetFolder[]; unfiled: number };

/** Kiểu dữ liệu kéo thả khi kéo asset vào thư mục (khác với kéo file từ máy để tải lên). */
export const ASSET_DRAG_TYPE = "application/x-videogen-assets";

export function useFolders() {
  return useApi<FolderList>("/api/folders");
}

export function FolderIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={cx("shrink-0", className ?? "size-4")} fill="currentColor" aria-hidden>
      <path d="M2 5.5A2.5 2.5 0 0 1 4.5 3h3.38a2 2 0 0 1 1.42.59L10.7 5h4.8A2.5 2.5 0 0 1 18 7.5v7a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 2 14.5v-9Z" />
    </svg>
  );
}

/** Ô chọn thư mục (dùng trong bộ lọc, trình chọn asset, form sửa asset). */
export function FolderSelect({
  folders,
  value,
  onChange,
  allLabel,
  noneLabel = "Chưa phân loại",
  className,
}: {
  folders: AssetFolder[];
  value: string;
  onChange: (value: string) => void;
  /** Có thì thêm lựa chọn "tất cả" (value "") */
  allLabel?: string;
  noneLabel?: string;
  className?: string;
}) {
  return (
    <select className={cx(inputClass, className)} value={value} onChange={(e) => onChange(e.target.value)}>
      {allLabel !== undefined && <option value="">{allLabel}</option>}
      <option value={allLabel !== undefined ? "none" : ""}>{noneLabel}</option>
      {folders.map((f) => (
        <option key={f.id} value={f.id}>
          {f.name} ({f.assetCount})
        </option>
      ))}
    </select>
  );
}

function FolderNameModal({
  open,
  title,
  initial,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initial: string;
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
      await onSubmit(name);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Tên thư mục">
          <input autoFocus className={inputClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="vd: Gameplay, Logo, Nhạc nền..." />
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

/**
 * Thanh thư mục của trang Assets: chọn thư mục để xem, tạo / đổi tên / xóa thư mục,
 * và thả asset (kéo từ lưới) vào một thư mục để chuyển.
 */
export function FolderBar({
  folders,
  total,
  value,
  onChange,
  onChanged,
  onDropAssets,
}: {
  folders: FolderList | null;
  /** tổng số asset của thư viện */
  total: number | null;
  /** "" = tất cả, "none" = chưa phân loại, còn lại là id thư mục */
  value: string;
  onChange: (value: string) => void;
  onChanged: () => void;
  onDropAssets: (ids: string[], folderId: string | null) => void;
}) {
  const [modal, setModal] = useState<"create" | "rename" | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = folders?.items.find((f) => f.id === value) ?? null;

  const dropProps = (target: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      setDropTarget(target);
    },
    onDragLeave: () => setDropTarget((t) => (t === target ? null : t)),
    onDrop: (e: React.DragEvent) => {
      const data = e.dataTransfer.getData(ASSET_DRAG_TYPE);
      if (!data) return;
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      onDropAssets(JSON.parse(data) as string[], target === "none" ? null : target);
    },
  });

  const chip = (key: string, label: React.ReactNode, count: number | null | undefined, droppable: boolean) => (
    <button
      key={key}
      type="button"
      onClick={() => onChange(key)}
      aria-pressed={value === key}
      {...(droppable ? dropProps(key) : {})}
      className={cx(
        "inline-flex max-w-56 shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm ring-1 transition-colors",
        value === key ? "bg-brand-50 font-medium text-brand-700 ring-brand-500" : "bg-surface text-zinc-700 ring-zinc-200 hover:bg-zinc-50",
        dropTarget === key && "bg-brand-100 ring-2 ring-brand-500",
      )}
    >
      {label}
      {count != null && <span className="text-xs tabular-nums text-zinc-400">{count}</span>}
    </button>
  );

  return (
    <div className="mb-4 space-y-2">
      <div className="scroll-thin flex items-center gap-2 overflow-x-auto pb-1">
        {chip("", "Tất cả", total, false)}
        {chip("none", "Chưa phân loại", folders?.unfiled, true)}
        {folders?.items.map((f) =>
          chip(
            f.id,
            <>
              <FolderIcon className="size-4 text-amber-500" />
              <span className="truncate">{f.name}</span>
            </>,
            f.assetCount,
            true,
          ),
        )}
        <Button size="sm" variant="ghost" onClick={() => setModal("create")} className="shrink-0">
          + Thư mục mới
        </Button>
      </div>
      {current && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-600">
          <FolderIcon className="size-5 text-amber-500" />
          <span className="font-medium text-zinc-800">{current.name}</span>
          <span className="text-zinc-400">· {current.assetCount} asset · tải lên ở đây sẽ vào thư mục này</span>
          <Button size="sm" variant="ghost" onClick={() => setModal("rename")}>
            Đổi tên
          </Button>
          <ConfirmButton
            size="sm"
            variant="ghost"
            className="text-red-600"
            confirmLabel="Xóa thư mục? (asset được giữ lại)"
            onConfirm={async () => {
              setError(null);
              try {
                await api(`/api/folders/${current.id}`, { method: "DELETE" });
                onChange("");
                onChanged();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Xóa thư mục
          </ConfirmButton>
        </div>
      )}
      <ErrorBox message={error} />
      {modal && (
        <FolderNameModal
          open
          title={modal === "create" ? "Thư mục mới" : "Đổi tên thư mục"}
          initial={modal === "rename" ? (current?.name ?? "") : ""}
          onClose={() => setModal(null)}
          onSubmit={async (name) => {
            if (modal === "create") {
              const folder = await api<AssetFolder>("/api/folders", { method: "POST", json: { name } });
              onChange(folder.id);
            } else if (current) {
              await api(`/api/folders/${current.id}`, { method: "PATCH", json: { name } });
            }
            onChanged();
          }}
        />
      )}
    </div>
  );
}
