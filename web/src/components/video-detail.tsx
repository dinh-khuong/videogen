"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, formatBytes, formatDate, formatDuration, useApi, useDocumentTitle } from "@/lib/client";
import type { Contact, JobInput, Page, VideoDetail } from "@/lib/types";
import { AssetThumb } from "./assets-library";
import { ScriptEditor } from "./script-editor";
import { Button, Card, ConfirmButton, DescriptionInput, ErrorBox, Field, Loading, TagList, inputClass } from "./ui";

function aspectOf(v: VideoDetail): JobInput["aspect"] {
  if (!v.width || !v.height) return "16:9";
  const r = v.width / v.height;
  return r > 1.2 ? "16:9" : r < 0.8 ? "9:16" : "1:1";
}

function MetaEditor({ video, onSaved }: { video: VideoDetail; onSaved: () => void }) {
  const [title, setTitle] = useState(video.title);
  const [description, setDescription] = useState(video.description);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = title !== video.title || description !== video.description;

  return (
    <Card className="space-y-4 p-4">
      <Field label="Tiêu đề">
        <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Mô tả & hashtag (dùng khi đăng video)">
        <DescriptionInput value={description} onChange={setDescription} rows={5} />
      </Field>
      <ErrorBox message={error} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="ghost"
          onClick={async () => {
            await navigator.clipboard.writeText(`${title}\n\n${description}`);
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
          }}
        >
          {saved ? "Đã sao chép" : "Sao chép tiêu đề + mô tả"}
        </Button>
        <Button
          variant="primary"
          busy={saving}
          disabled={!dirty}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await api(`/api/videos/${video.id}`, { method: "PATCH", json: { title, description } });
              onSaved();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setSaving(false);
            }
          }}
        >
          Lưu thay đổi
        </Button>
      </div>
    </Card>
  );
}

function ContactLinks({ video, onChanged }: { video: VideoDetail; onChanged: () => void }) {
  const contacts = useApi<Page<Contact>>("/api/contacts?limit=500");
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string | null>(null);
  const linked = new Set(video.contacts.map((c) => c.id));

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-zinc-900">Khách hàng liên quan</h3>
      {video.contacts.length ? (
        <ul className="mb-3 space-y-1.5">
          {video.contacts.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
              <Link href={`/crm/${c.id}`} className="truncate text-brand-700 hover:underline">
                {c.name}
                {c.company && <span className="text-zinc-500"> · {c.company}</span>}
              </Link>
              <button
                type="button"
                className="text-xs text-zinc-500 hover:text-red-600"
                onClick={async () => {
                  await api(`/api/contacts/${c.id}/videos?videoId=${video.id}`, { method: "DELETE" }).catch((e) => setError(e.message));
                  onChanged();
                }}
              >
                Bỏ gắn
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-3 text-sm text-zinc-500">Chưa gắn với khách hàng nào.</p>
      )}
      <div className="flex gap-2">
        <select className={inputClass} value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">Chọn khách hàng...</option>
          {contacts.data?.items
            .filter((c) => !linked.has(c.id))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.company ? ` — ${c.company}` : ""}
              </option>
            ))}
        </select>
        <Button
          disabled={!selected}
          onClick={async () => {
            setError(null);
            try {
              await api(`/api/contacts/${selected}/videos`, { method: "POST", json: { videoId: video.id } });
              setSelected("");
              onChanged();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Gắn
        </Button>
      </div>
      <ErrorBox message={error} />
    </Card>
  );
}

export function VideoDetailView({ id }: { id: string }) {
  const router = useRouter();
  const { data: video, error, loading, reload } = useApi<VideoDetail>(`/api/videos/${id}`);
  const [editingScript, setEditingScript] = useState(false);
  useDocumentTitle(video?.title);

  if (loading && !video) return <Loading />;
  if (!video) return <ErrorBox message={error ?? "Không tìm thấy video"} />;
  const vertical = (video.height ?? 0) > (video.width ?? 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/videos" className="text-sm text-zinc-500 hover:text-zinc-800">
            ← Thư viện video
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900">{video.title || "(Chưa đặt tên)"}</h1>
          <div className="mt-2">
            <TagList tags={video.tags} hrefBase="/videos?tag=" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={`${video.url}?download=${encodeURIComponent(`${video.title || "video"}.mp4`)}`} className="inline-flex items-center rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-zinc-800 ring-1 ring-zinc-300 hover:bg-zinc-50">
            Tải về
          </a>
          <ConfirmButton
            variant="danger"
            confirmLabel="Xóa vĩnh viễn?"
            onConfirm={async () => {
              await api(`/api/videos/${video.id}`, { method: "DELETE" });
              router.push("/videos");
            }}
          >
            Xóa
          </ConfirmButton>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <div className="overflow-hidden rounded-xl bg-black">
            <video
              key={video.url}
              src={video.url}
              poster={video.thumbUrl ?? undefined}
              controls
              preload="metadata"
              className={vertical ? "mx-auto max-h-[75vh] w-auto" : "w-full"}
            />
          </div>
          <p className="text-xs text-zinc-500">
            {formatDuration(video.duration)} · {video.width}×{video.height} · {formatBytes(video.sizeBytes)} · {formatDate(video.createdAt)}
            {video.jobId && (
              <>
                {" · "}
                <Link href={`/jobs/${video.jobId}`} className="text-brand-600 hover:underline">
                  Xem job
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="space-y-4">
          <MetaEditor key={video.description + video.title} video={video} onSaved={() => void reload()} />
          <ContactLinks video={video} onChanged={() => void reload()} />
        </div>
      </div>

      {video.assets.length > 0 && (
        <section>
          <h2 className="mb-3 font-semibold text-zinc-900">Ảnh & video dùng trong video</h2>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {video.assets.map((asset) => (
              <a key={asset.step} href={asset.url} target="_blank" rel="noreferrer" className="group relative overflow-hidden rounded-lg bg-zinc-100 ring-1 ring-zinc-200">
                <AssetThumb asset={asset} className="aspect-[4/3] w-full" />
                <span className="absolute left-1 top-1 rounded bg-brand-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">Bước {asset.step}</span>
                <p className="truncate px-2 py-1 text-xs text-zinc-600">{asset.title}</p>
              </a>
            ))}
          </div>
        </section>
      )}

      {video.script && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold text-zinc-900">Kịch bản</h2>
            {!editingScript && <Button onClick={() => setEditingScript(true)}>Sửa kịch bản & tạo lại</Button>}
          </div>
          <Card className="p-4">
            {editingScript ? (
              <ScriptEditor
                initial={video.script}
                defaults={{ aspect: aspectOf(video), contactId: video.contacts[0]?.id ?? null, sourceVideoId: video.id }}
                onCancel={() => setEditingScript(false)}
              />
            ) : (
              <div className="space-y-3 text-sm text-zinc-700">
                <p className="italic text-zinc-600">{video.script.intro}</p>
                <ol className="space-y-2">
                  {video.script.steps.map((s, i) => (
                    <li key={i}>
                      <span className="font-semibold text-zinc-900">
                        Bước {i + 1}: {s.heading}
                      </span>
                      <p className="text-zinc-600">{s.narration}</p>
                    </li>
                  ))}
                </ol>
                <p className="italic text-zinc-600">{video.script.outro}</p>
              </div>
            )}
          </Card>
        </section>
      )}
    </div>
  );
}
