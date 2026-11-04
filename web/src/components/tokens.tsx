"use client";

import { useState } from "react";
import { api, timeAgo, useApi } from "@/lib/client";
import { TOKEN_GROUPS, TOKEN_PROVIDERS, providerMeta, type TokenGroup, type TokenProvider } from "@/lib/token-providers";
import type { EngineHealth, TokenCheckStatus, TokenItem } from "@/lib/types";
import { Button, Card, ConfirmButton, ErrorBox, Field, Loading, Modal, PageHeader, cx, inputClass } from "./ui";

const PROVIDERS = Object.keys(TOKEN_PROVIDERS) as TokenProvider[];

/** Engine có đọc được key của dịch vụ này không (từ `doctor`: cả token đã lưu lẫn engine/.env). null = chưa biết. */
function engineHas(provider: TokenProvider, health: EngineHealth | null): boolean | null {
  if (!health) return null;
  switch (provider) {
    case "deepseek":
      return !!health.deepseek;
    case "fpt":
      return !!health.fpt_tts;
    case "pexels":
    case "pixabay":
    case "brave":
    case "serper":
      return !!health.search_engines?.[provider];
    case "google":
    case "google_cse":
      return !!health.search_engines?.google;
    case "youtube":
      return !!health.video_providers?.includes("youtube");
    case "vision":
      return !!health.vision;
  }
}

const CHECK_LABEL: Record<TokenCheckStatus | "none", { label: string; className: string }> = {
  ok: { label: "Dùng được", className: "bg-emerald-50 text-emerald-700" },
  invalid: { label: "Không dùng được", className: "bg-red-50 text-red-700" },
  error: { label: "Chưa kiểm tra được", className: "bg-amber-50 text-amber-700" },
  none: { label: "Chưa kiểm tra", className: "bg-zinc-100 text-zinc-600" },
};

export function TokenManager() {
  const tokens = useApi<TokenItem[]>("/api/tokens");
  const health = useApi<EngineHealth>("/api/health");
  const [form, setForm] = useState<{ provider: TokenProvider; token: TokenItem | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    await tokens.reload();
    void health.reload(); // máy chủ đã bỏ kết quả kiểm tra cũ nên engine được kiểm tra lại với token mới
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Token API"
        subtitle="Quản lý token/API key của các dịch vụ AI, giọng đọc, tìm ảnh và clip. Mỗi dịch vụ lưu được nhiều token và chọn một cái đang dùng."
      />

      <Card className="space-y-1.5 p-5 text-sm text-zinc-600">
        <p>
          <b className="text-zinc-800">Token đang dùng</b> được gửi cho engine mỗi khi chạy job hoặc phân tích asset, và <b>ưu tiên hơn</b> key trong{" "}
          <code className="rounded bg-zinc-100 px-1 text-xs">engine/.env</code>. Dịch vụ chưa có token ở đây vẫn dùng key trong{" "}
          <code className="rounded bg-zinc-100 px-1 text-xs">engine/.env</code> như trước.
        </p>
        <p>
          Token lưu trong cơ sở dữ liệu trên máy này (<code className="rounded bg-zinc-100 px-1 text-xs">data/app.db</code>), giao diện chỉ hiện bản che bớt.
          Job đang chạy giữ token lúc bắt đầu; đổi token có tác dụng từ job kế tiếp.
        </p>
      </Card>

      <ErrorBox message={error} />
      {tokens.error && <ErrorBox message={tokens.error} onRetry={() => void tokens.reload()} />}
      {!tokens.data && !tokens.error && <Loading />}

      {tokens.data &&
        (Object.keys(TOKEN_GROUPS) as TokenGroup[]).map((group) => {
          const providers = PROVIDERS.filter((p) => providerMeta(p).group === group);
          if (!providers.length) return null;
          return (
            <section key={group} className="space-y-3">
              <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">{TOKEN_GROUPS[group]}</h2>
              <div className="grid gap-4 lg:grid-cols-2">
                {providers.map((provider) => (
                  <ProviderCard
                    key={provider}
                    provider={provider}
                    tokens={tokens.data!.filter((t) => t.provider === provider)}
                    inEngine={engineHas(provider, health.data)}
                    onAdd={() => setForm({ provider, token: null })}
                    onEdit={(token) => setForm({ provider, token })}
                    onChanged={refresh}
                    onError={setError}
                  />
                ))}
              </div>
            </section>
          );
        })}

      {form && (
        <TokenForm
          key={form.token?.id ?? `new-${form.provider}`}
          provider={form.provider}
          token={form.token}
          hasOthers={(tokens.data ?? []).some((t) => t.provider === form.provider && t.id !== form.token?.id)}
          onClose={() => setForm(null)}
          onSaved={async () => {
            setForm(null);
            setError(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  tokens,
  inEngine,
  onAdd,
  onEdit,
  onChanged,
  onError,
}: {
  provider: TokenProvider;
  tokens: TokenItem[];
  inEngine: boolean | null;
  onAdd: () => void;
  onEdit: (token: TokenItem) => void;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const meta = providerMeta(provider);
  const active = tokens.find((t) => t.active);
  const status = active
    ? { text: `Đang dùng: ${active.name}`, className: "bg-emerald-50 text-emerald-700" }
    : inEngine
      ? { text: "Đang dùng key trong engine/.env", className: "bg-blue-50 text-blue-700" }
      : meta.required
        ? { text: "Chưa có — cần để tạo video", className: "bg-red-50 text-red-700" }
        : { text: "Chưa có", className: "bg-zinc-100 text-zinc-600" };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="font-semibold text-zinc-900">{meta.label}</h3>
          {meta.required && <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand-700">Bắt buộc</span>}
          <span className={cx("rounded-full px-2 py-0.5 text-xs font-medium", status.className)}>{status.text}</span>
        </div>
        <p className="text-xs text-zinc-500">
          {meta.hint}{" "}
          <a href={meta.link} target="_blank" rel="noreferrer" className="whitespace-nowrap text-brand-600 underline">
            Lấy token
          </a>
        </p>
      </div>

      {tokens.length > 0 && (
        <ul className="divide-y divide-zinc-100 rounded-lg ring-1 ring-zinc-200">
          {tokens.map((token) => (
            <TokenRowView key={token.id} token={token} testable={!!meta.testable} onEdit={() => onEdit(token)} onChanged={onChanged} onError={onError} />
          ))}
        </ul>
      )}

      <div>
        <Button size="sm" onClick={onAdd}>
          + Thêm token
        </Button>
      </div>
    </Card>
  );
}

function TokenRowView({
  token,
  testable,
  onEdit,
  onChanged,
  onError,
}: {
  token: TokenItem;
  testable: boolean;
  onEdit: () => void;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState<"test" | "active" | null>(null);
  const check = CHECK_LABEL[token.lastStatus ?? "none"];

  const run = async (kind: "test" | "active", request: () => Promise<unknown>) => {
    setBusy(kind);
    onError(null);
    try {
      await request();
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="space-y-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-zinc-800">{token.name}</span>
        <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600">{token.masked}</code>
        {token.active && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">Đang dùng</span>}
        <span className={cx("rounded-full px-2 py-0.5 text-xs font-medium", check.className)}>{check.label}</span>
      </div>
      {(token.lastMessage || token.note) && (
        <div className="space-y-0.5 text-xs text-zinc-500">
          {token.lastMessage && (
            <p>
              {token.lastMessage}
              {token.lastCheckedAt && <span className="text-zinc-400"> · {timeAgo(token.lastCheckedAt)}</span>}
            </p>
          )}
          {token.note && <p>Ghi chú: {token.note}</p>}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {testable && (
          <Button size="sm" busy={busy === "test"} onClick={() => run("test", () => api(`/api/tokens/${token.id}/test`, { method: "POST" }))}>
            Kiểm tra
          </Button>
        )}
        <Button
          size="sm"
          variant={token.active ? "secondary" : "primary"}
          busy={busy === "active"}
          onClick={() => run("active", () => api(`/api/tokens/${token.id}`, { method: "PATCH", json: { active: !token.active } }))}
        >
          {token.active ? "Ngừng dùng" : "Dùng token này"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Sửa
        </Button>
        <ConfirmButton
          size="sm"
          variant="danger"
          confirmLabel="Bấm lần nữa để xóa"
          onConfirm={async () => {
            onError(null);
            try {
              await api(`/api/tokens/${token.id}`, { method: "DELETE" });
              await onChanged();
            } catch (e) {
              onError((e as Error).message);
            }
          }}
        >
          Xóa
        </ConfirmButton>
      </div>
    </li>
  );
}

function TokenForm({
  provider,
  token,
  hasOthers,
  onClose,
  onSaved,
}: {
  provider: TokenProvider;
  token: TokenItem | null;
  hasOthers: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const meta = providerMeta(provider);
  const secret = meta.secret !== false;
  const [name, setName] = useState(token?.name ?? "");
  const [value, setValue] = useState("");
  const [note, setNote] = useState(token?.note ?? "");
  const [useNow, setUseNow] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (token) await api(`/api/tokens/${token.id}`, { method: "PATCH", json: { name, note, ...(value ? { value } : {}) } });
      else await api("/api/tokens", { method: "POST", json: { provider, name, value, note, active: useNow } });
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`${token ? "Sửa" : "Thêm"} token ${meta.label}`}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Tên gợi nhớ" hint="Để phân biệt các token của cùng một dịch vụ (vd tài khoản chính, tài khoản dự phòng).">
          <input className={inputClass} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={`${meta.label} 1`} autoFocus />
        </Field>
        <Field label={`${meta.label === "Google CSE ID" ? "ID" : "Token"}${token ? " mới" : ""}`} hint={token ? `Đang lưu ${token.masked}. Để trống nếu giữ nguyên.` : `Gửi cho engine qua biến ${meta.env}.`}>
          <span className="flex gap-2">
            <input
              className={cx(inputClass, "font-mono")}
              type={secret && !reveal ? "password" : "text"}
              value={value}
              required={!token}
              maxLength={600}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setValue(e.target.value.trim())}
              placeholder={token ? "••••••••" : "Dán token vào đây"}
            />
            {secret && (
              <Button onClick={() => setReveal((r) => !r)} aria-pressed={reveal}>
                {reveal ? "Ẩn" : "Hiện"}
              </Button>
            )}
          </span>
        </Field>
        <Field label="Ghi chú (tùy chọn)">
          <input className={inputClass} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="vd hạn mức, email tài khoản..." />
        </Field>
        {!token && hasOthers && (
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <input type="checkbox" checked={useNow} onChange={(e) => setUseNow(e.target.checked)} />
            Dùng token này ngay (thay token đang dùng)
          </label>
        )}
        {!token && !hasOthers && <p className="text-xs text-zinc-500">Đây là token đầu tiên của dịch vụ nên sẽ được dùng ngay.</p>}
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Hủy</Button>
          <Button type="submit" variant="primary" busy={busy}>
            Lưu
          </Button>
        </div>
      </form>
    </Modal>
  );
}
