import "server-only";
import crypto from "node:crypto";
import { parseHashtags } from "@/lib/hashtags";
import {
  ACTIVITY_TYPES,
  CONTACT_STATUSES,
  type Activity,
  type ActivityType,
  type Contact,
  type ContactDetail,
  type ContactStatus,
  type Page,
} from "@/lib/types";
import { db, nowIso } from "./db";
import { HttpError } from "./files";
import { setTags, tagFilterParam, tagFilterSql, tagsFor } from "./tags";
import { toVideoItems } from "./videos";

type ContactRow = {
  id: string;
  name: string;
  company: string;
  phone: string;
  email: string;
  status: ContactStatus;
  source: string;
  notes: string;
  follow_up_at: string | null;
  created_at: string;
  updated_at: string;
  video_count: number;
  last_activity_at: string | null;
};

const SELECT = `SELECT c.*,
  (SELECT COUNT(*) FROM contact_videos cv WHERE cv.contact_id = c.id) AS video_count,
  (SELECT MAX(a.created_at) FROM contact_activities a WHERE a.contact_id = c.id) AS last_activity_at
  FROM contacts c`;

function toContacts(rows: ContactRow[]): Contact[] {
  const tags = tagsFor("contact", rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    company: r.company,
    phone: r.phone,
    email: r.email,
    status: r.status,
    source: r.source,
    notes: r.notes,
    tags: tags.get(r.id) ?? [],
    followUpAt: r.follow_up_at,
    videoCount: r.video_count,
    lastActivityAt: r.last_activity_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export type ContactQuery = { q?: string; status?: string; tag?: string; due?: boolean; limit?: number; offset?: number };

export function listContacts(query: ContactQuery = {}): Page<Contact> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.q) {
    clauses.push("(c.name LIKE ? OR c.company LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.notes LIKE ?)");
    params.push(...Array(5).fill(`%${query.q}%`));
  }
  if (query.status && query.status in CONTACT_STATUSES) {
    clauses.push("c.status = ?");
    params.push(query.status);
  }
  if (query.tag) {
    clauses.push(tagFilterSql("contact", "c"));
    params.push(tagFilterParam(query.tag));
  }
  if (query.due) {
    clauses.push("c.follow_up_at IS NOT NULL AND c.follow_up_at <= ?");
    params.push(new Date().toISOString().slice(0, 10));
  }
  const sql = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const rows = db()
    .prepare(`${SELECT}${sql} ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, query.offset ?? 0) as ContactRow[];
  const { total } = db().prepare(`SELECT COUNT(*) AS total FROM contacts c${sql}`).get(...params) as { total: number };
  return { items: toContacts(rows), total };
}

export function getContact(id: string): Contact | null {
  const row = db().prepare(`${SELECT} WHERE c.id = ?`).get(id) as ContactRow | undefined;
  return row ? toContacts([row])[0] : null;
}

export function getContactDetail(id: string): ContactDetail | null {
  const contact = getContact(id);
  if (!contact) return null;
  const activities = (
    db()
      .prepare("SELECT id, type, content, created_at FROM contact_activities WHERE contact_id = ? ORDER BY created_at DESC")
      .all(id) as { id: string; type: ActivityType; content: string; created_at: string }[]
  ).map((a): Activity => ({ id: a.id, type: a.type, content: a.content, createdAt: a.created_at }));
  const videos = toVideoItems(
    db()
      .prepare(
        `SELECT v.* FROM contact_videos cv JOIN videos v ON v.id = cv.video_id
         WHERE cv.contact_id = ? ORDER BY cv.created_at DESC`,
      )
      .all(id) as Parameters<typeof toVideoItems>[0],
  );
  return { ...contact, activities, videos };
}

export type ContactInput = Partial<{
  name: string;
  company: string;
  phone: string;
  email: string;
  status: string;
  source: string;
  notes: string;
  followUpAt: string | null;
}>;

function clean(input: ContactInput, current?: Contact) {
  const name = (input.name ?? current?.name ?? "").trim();
  if (!name) throw new HttpError(400, "Tên khách hàng không được để trống");
  const status = input.status ?? current?.status ?? "lead";
  if (!(status in CONTACT_STATUSES)) throw new HttpError(400, "Trạng thái không hợp lệ");
  const followUpAt = input.followUpAt === undefined ? (current?.followUpAt ?? null) : input.followUpAt || null;
  if (followUpAt && !/^\d{4}-\d{2}-\d{2}$/.test(followUpAt)) throw new HttpError(400, "Ngày hẹn không hợp lệ");
  return {
    name,
    company: (input.company ?? current?.company ?? "").trim(),
    phone: (input.phone ?? current?.phone ?? "").trim(),
    email: (input.email ?? current?.email ?? "").trim(),
    status,
    source: (input.source ?? current?.source ?? "").trim(),
    notes: (input.notes ?? current?.notes ?? "").trim(),
    followUpAt,
  };
}

export function createContact(input: ContactInput): Contact {
  const c = clean(input);
  const id = crypto.randomUUID();
  db().transaction(() => {
    db()
      .prepare(
        `INSERT INTO contacts (id, name, company, phone, email, status, source, notes, follow_up_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, c.name, c.company, c.phone, c.email, c.status, c.source, c.notes, c.followUpAt);
    setTags("contact", id, parseHashtags(c.notes));
  })();
  return getContact(id)!;
}

export function updateContact(id: string, input: ContactInput): Contact | null {
  const current = getContact(id);
  if (!current) return null;
  const c = clean(input, current);
  db().transaction(() => {
    db()
      .prepare(
        `UPDATE contacts SET name = ?, company = ?, phone = ?, email = ?, status = ?, source = ?, notes = ?,
         follow_up_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(c.name, c.company, c.phone, c.email, c.status, c.source, c.notes, c.followUpAt, nowIso(), id);
    setTags("contact", id, parseHashtags(c.notes));
    if (current.status !== c.status) {
      addActivityRow(id, "note", `Đổi trạng thái: ${CONTACT_STATUSES[current.status]} → ${CONTACT_STATUSES[c.status as ContactStatus]}`);
    }
  })();
  return getContact(id);
}

export function deleteContact(id: string): boolean {
  return db().prepare("DELETE FROM contacts WHERE id = ?").run(id).changes > 0;
}

function addActivityRow(contactId: string, type: ActivityType, content: string): string {
  const id = crypto.randomUUID();
  db().prepare("INSERT INTO contact_activities (id, contact_id, type, content) VALUES (?, ?, ?, ?)").run(id, contactId, type, content);
  db().prepare("UPDATE contacts SET updated_at = ? WHERE id = ?").run(nowIso(), contactId);
  return id;
}

export function addActivity(contactId: string, type: string, content: string): void {
  if (!getContact(contactId)) throw new HttpError(404, "Không tìm thấy khách hàng");
  if (!(type in ACTIVITY_TYPES)) throw new HttpError(400, "Loại hoạt động không hợp lệ");
  if (!content.trim()) throw new HttpError(400, "Nội dung không được để trống");
  addActivityRow(contactId, type as ActivityType, content.trim());
}

export function deleteActivity(id: string): boolean {
  return db().prepare("DELETE FROM contact_activities WHERE id = ?").run(id).changes > 0;
}

export function linkVideo(contactId: string, videoId: string): void {
  const exists = db().prepare("SELECT 1 FROM videos WHERE id = ?").get(videoId);
  if (!exists || !getContact(contactId)) throw new HttpError(404, "Không tìm thấy khách hàng hoặc video");
  db().prepare("INSERT OR IGNORE INTO contact_videos (contact_id, video_id) VALUES (?, ?)").run(contactId, videoId);
}

export function unlinkVideo(contactId: string, videoId: string): void {
  db().prepare("DELETE FROM contact_videos WHERE contact_id = ? AND video_id = ?").run(contactId, videoId);
}
