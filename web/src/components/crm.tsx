"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { api, formatDate, timeAgo, useApi, useDocumentTitle } from "@/lib/client";
import {
  ACTIVITY_TYPES,
  CONTACT_STATUSES,
  type ActivityType,
  type Contact,
  type ContactDetail,
  type ContactStatus,
  type Page,
} from "@/lib/types";
import { VideoCard } from "./cards";
import { LibraryFilters } from "./library-filters";
import {
  Button,
  Card,
  ConfirmButton,
  DescriptionInput,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageHeader,
  TagList,
  buttonClass,
  cx,
  inputClass,
} from "./ui";

const STATUS_STYLE: Record<ContactStatus, string> = {
  lead: "bg-sky-50 text-sky-700",
  contacted: "bg-violet-50 text-violet-700",
  negotiating: "bg-amber-50 text-amber-700",
  customer: "bg-emerald-50 text-emerald-700",
  lost: "bg-zinc-100 text-zinc-500",
};

export function StatusBadge({ status }: { status: ContactStatus }) {
  return <span className={cx("inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", STATUS_STYLE[status])}>{CONTACT_STATUSES[status]}</span>;
}

function isDue(date: string | null): boolean {
  return !!date && date <= new Date().toISOString().slice(0, 10);
}

type FormState = {
  name: string;
  company: string;
  phone: string;
  email: string;
  status: ContactStatus;
  source: string;
  notes: string;
  followUpAt: string;
};

function ContactForm({ initial, onSaved, onCancel }: { initial?: Contact; onSaved: (c: Contact) => void; onCancel: () => void }) {
  const [form, setForm] = useState<FormState>({
    name: initial?.name ?? "",
    company: initial?.company ?? "",
    phone: initial?.phone ?? "",
    email: initial?.email ?? "",
    status: initial?.status ?? "lead",
    source: initial?.source ?? "",
    notes: initial?.notes ?? "",
    followUpAt: initial?.followUpAt ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const saved = await api<Contact>(initial ? `/api/contacts/${initial.id}` : "/api/contacts", {
            method: initial ? "PATCH" : "POST",
            json: { ...form, followUpAt: form.followUpAt || null },
          });
          onSaved(saved);
        } catch (err) {
          setError((err as Error).message);
          setBusy(false);
        }
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Tên khách hàng *">
          <input className={inputClass} required value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Công ty / cửa hàng">
          <input className={inputClass} value={form.company} onChange={(e) => set({ company: e.target.value })} />
        </Field>
        <Field label="Số điện thoại">
          <input className={inputClass} type="tel" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
        </Field>
        <Field label="Email">
          <input className={inputClass} type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} />
        </Field>
        <Field label="Trạng thái">
          <select className={inputClass} value={form.status} onChange={(e) => set({ status: e.target.value as ContactStatus })}>
            {Object.entries(CONTACT_STATUSES).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Nguồn khách">
          <input className={inputClass} value={form.source} placeholder="Facebook, giới thiệu, TikTok..." onChange={(e) => set({ source: e.target.value })} />
        </Field>
        <Field label="Ngày hẹn chăm sóc tiếp">
          <input className={inputClass} type="date" value={form.followUpAt} onChange={(e) => set({ followUpAt: e.target.value })} />
        </Field>
      </div>
      <Field label="Ghi chú & hashtag">
        <DescriptionInput value={form.notes} onChange={(notes) => set({ notes })} rows={3} placeholder="Nhu cầu, ngân sách... thêm hashtag như #spa #vip" />
      </Field>
      <ErrorBox message={error} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Hủy
        </Button>
        <Button type="submit" variant="primary" busy={busy}>
          {initial ? "Lưu" : "Thêm khách hàng"}
        </Button>
      </div>
    </form>
  );
}

export function ContactsList() {
  const router = useRouter();
  const params = useSearchParams();
  const [filter, setFilter] = useState({ q: "", tag: params.get("tag") ?? "" });
  const [status, setStatus] = useState("");
  const [due, setDue] = useState(params.get("due") === "1");
  const [adding, setAdding] = useState(false);

  const query = new URLSearchParams({ limit: "500" });
  if (filter.q) query.set("q", filter.q);
  if (filter.tag) query.set("tag", filter.tag);
  if (status) query.set("status", status);
  if (due) query.set("due", "1");
  const { data, error, loading, reload } = useApi<Page<Contact>>(`/api/contacts?${query}`);
  const onFilter = useCallback((next: { q: string; tag: string }) => setFilter(next), []);

  return (
    <>
      <PageHeader
        title="Khách hàng"
        subtitle={`${data?.total ?? 0} khách hàng · Theo dõi trạng thái, lịch hẹn và video đã làm cho từng khách.`}
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            + Thêm khách hàng
          </Button>
        }
      />
      <div className="mb-3 flex flex-wrap gap-1.5">
        {[["", "Tất cả"], ...Object.entries(CONTACT_STATUSES)].map(([v, l]) => (
          <button
            key={v}
            type="button"
            onClick={() => setStatus(v)}
            className={cx(
              "rounded-full px-3 py-1 text-sm font-medium",
              status === v ? "bg-zinc-900 text-zinc-50" : "bg-surface text-zinc-600 ring-1 ring-zinc-200 hover:bg-zinc-50",
            )}
          >
            {l}
          </button>
        ))}
      </div>
      <LibraryFilters kind="contacts" q={filter.q} tag={filter.tag} onChange={onFilter}>
        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input type="checkbox" className="size-4 accent-brand-500" checked={due} onChange={(e) => setDue(e.target.checked)} />
          Đến hạn chăm sóc
        </label>
      </LibraryFilters>
      <ErrorBox message={error} onRetry={() => void reload()} />
      {loading && !data ? (
        <Loading />
      ) : data?.items.length ? (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3 font-medium">Khách hàng</th>
                <th className="px-4 py-3 font-medium">Liên hệ</th>
                <th className="px-4 py-3 font-medium">Trạng thái</th>
                <th className="px-4 py-3 font-medium">Hẹn chăm sóc</th>
                <th className="px-4 py-3 font-medium">Video</th>
                <th className="px-4 py-3 font-medium">Hoạt động</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {data.items.map((c) => (
                <tr key={c.id} onClick={() => router.push(`/crm/${c.id}`)} className="cursor-pointer hover:bg-zinc-50">
                  <td className="px-4 py-3">
                    <Link href={`/crm/${c.id}`} className="font-medium text-zinc-900 hover:text-brand-700" onClick={(e) => e.stopPropagation()}>
                      {c.name}
                    </Link>
                    {c.company && <p className="text-xs text-zinc-500">{c.company}</p>}
                    <div className="mt-1">
                      <TagList tags={c.tags.slice(0, 3)} />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    <p>{c.phone}</p>
                    <p className="text-xs text-zinc-500">{c.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className={cx("px-4 py-3", isDue(c.followUpAt) ? "font-medium text-red-600" : "text-zinc-600")}>
                    {formatDate(c.followUpAt, false) || "—"}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-zinc-600">{c.videoCount}</td>
                  <td className="px-4 py-3 text-xs text-zinc-500">{timeAgo(c.lastActivityAt ?? c.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <EmptyState title={filter.q || filter.tag || status || due ? "Không có khách hàng phù hợp" : "Chưa có khách hàng"}>
          Thêm khách hàng để theo dõi nhu cầu và các video đã làm cho họ.
        </EmptyState>
      )}
      <Modal open={adding} onClose={() => setAdding(false)} title="Thêm khách hàng" wide>
        {adding && <ContactForm onCancel={() => setAdding(false)} onSaved={(c) => router.push(`/crm/${c.id}`)} />}
      </Modal>
    </>
  );
}

function ActivityForm({ contactId, onAdded }: { contactId: string; onAdded: () => void }) {
  const [type, setType] = useState<ActivityType>("note");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api(`/api/contacts/${contactId}/activities`, { method: "POST", json: { type, content } });
          setContent("");
          onAdded();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="flex gap-2">
        <select className={`${inputClass} w-36!`} value={type} onChange={(e) => setType(e.target.value as ActivityType)}>
          {Object.entries(ACTIVITY_TYPES).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <input className={inputClass} value={content} onChange={(e) => setContent(e.target.value)} placeholder="Nội dung trao đổi, kết quả..." />
        <Button type="submit" variant="primary" busy={busy} disabled={!content.trim()}>
          Ghi
        </Button>
      </div>
      <ErrorBox message={error} />
    </form>
  );
}

export function ContactDetailView({ id }: { id: string }) {
  const router = useRouter();
  const { data: contact, error, loading, reload } = useApi<ContactDetail>(`/api/contacts/${id}`);
  const [editing, setEditing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  useDocumentTitle(contact?.name);

  if (loading && !contact) return <Loading />;
  if (!contact) return <ErrorBox message={error ?? "Không tìm thấy khách hàng"} />;

  const quickStatus = async (status: string) => {
    setActionError(null);
    try {
      await api(`/api/contacts/${id}`, { method: "PATCH", json: { status } });
      void reload();
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <Link href="/crm" className="text-sm text-zinc-500 hover:text-zinc-800">
          ← Khách hàng
        </Link>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{contact.name}</h1>
            {contact.company && <p className="text-sm text-zinc-500">{contact.company}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select className={`${inputClass} w-auto!`} value={contact.status} onChange={(e) => void quickStatus(e.target.value)} aria-label="Trạng thái">
              {Object.entries(CONTACT_STATUSES).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <Button onClick={() => setEditing(true)}>Sửa</Button>
            <ConfirmButton
              variant="danger"
              confirmLabel="Xóa khách hàng?"
              onConfirm={async () => {
                await api(`/api/contacts/${id}`, { method: "DELETE" });
                router.push("/crm");
              }}
            >
              Xóa
            </ConfirmButton>
          </div>
        </div>
      </div>
      <ErrorBox message={actionError} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <Card className="space-y-3 p-5 text-sm">
          <div className="flex items-center justify-between">
            <StatusBadge status={contact.status} />
            {contact.followUpAt && (
              <span className={cx("text-xs", isDue(contact.followUpAt) ? "font-semibold text-red-600" : "text-zinc-500")}>
                Hẹn chăm sóc: {formatDate(contact.followUpAt, false)}
              </span>
            )}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-zinc-500">Điện thoại</dt>
            <dd>{contact.phone ? <a href={`tel:${contact.phone}`} className="text-brand-700 hover:underline">{contact.phone}</a> : "—"}</dd>
            <dt className="text-zinc-500">Email</dt>
            <dd className="truncate">{contact.email ? <a href={`mailto:${contact.email}`} className="text-brand-700 hover:underline">{contact.email}</a> : "—"}</dd>
            <dt className="text-zinc-500">Nguồn</dt>
            <dd>{contact.source || "—"}</dd>
            <dt className="text-zinc-500">Tạo lúc</dt>
            <dd>{formatDate(contact.createdAt)}</dd>
          </dl>
          {contact.notes && <p className="whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 text-zinc-700">{contact.notes}</p>}
          <TagList tags={contact.tags} hrefBase="/crm?tag=" />
        </Card>

        <section className="space-y-3">
          <h2 className="font-semibold text-zinc-900">Nhật ký chăm sóc</h2>
          <ActivityForm contactId={id} onAdded={() => void reload()} />
          {contact.activities.length ? (
            <ol className="space-y-2">
              {contact.activities.map((a) => (
                <li key={a.id} className="group flex gap-3 rounded-lg bg-surface p-3 ring-1 ring-zinc-200/80">
                  <span className="mt-0.5 shrink-0 rounded-md bg-zinc-100 px-1.5 py-0.5 text-xs font-medium text-zinc-600">{ACTIVITY_TYPES[a.type]}</span>
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap text-sm text-zinc-800">{a.content}</p>
                    <p className="mt-0.5 text-xs text-zinc-400">{formatDate(a.createdAt)}</p>
                  </div>
                  <button
                    type="button"
                    className="self-start text-xs text-zinc-400 opacity-0 hover:text-red-600 group-hover:opacity-100 focus:opacity-100"
                    onClick={async () => {
                      await api(`/api/activities/${a.id}`, { method: "DELETE" }).catch((e) => setActionError(e.message));
                      void reload();
                    }}
                  >
                    Xóa
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-zinc-500">Chưa có hoạt động nào.</p>
          )}
        </section>
      </div>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold text-zinc-900">Video cho khách hàng này</h2>
          <Link href={`/create?contact=${id}`} className={buttonClass("primary", "sm")}>
            + Tạo video cho khách
          </Link>
        </div>
        {contact.videos.length ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {contact.videos.map((v) => (
              <VideoCard
                key={v.id}
                video={v}
                action={
                  <button
                    type="button"
                    className="shrink-0 text-xs text-zinc-400 hover:text-red-600"
                    onClick={async () => {
                      await api(`/api/contacts/${id}/videos?videoId=${v.id}`, { method: "DELETE" }).catch((e) => setActionError(e.message));
                      void reload();
                    }}
                  >
                    Bỏ gắn
                  </button>
                }
              />
            ))}
          </div>
        ) : (
          <EmptyState title="Chưa có video">Tạo video mới cho khách, hoặc gắn video có sẵn từ trang chi tiết video.</EmptyState>
        )}
      </section>

      <Modal open={editing} onClose={() => setEditing(false)} title="Sửa thông tin khách hàng" wide>
        {editing && (
          <ContactForm
            initial={contact}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              void reload();
            }}
          />
        )}
      </Modal>
    </div>
  );
}
