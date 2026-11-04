import "server-only";
import crypto from "node:crypto";
import { and, count, desc, eq, getTableColumns, isNotNull, like, lte, or, sql, type SQL } from "drizzle-orm";
import { parseHashtags } from "@/lib/hashtags";
import {
  ACTIVITY_TYPES,
  CONTACT_STATUSES,
  type ActivityType,
  type Contact,
  type ContactDetail,
  type ContactStatus,
  type Page,
} from "@/lib/types";
import { db, nowIso } from "./db";
import { HttpError } from "./files";
import { contactActivities, contactVideos, contacts, videos } from "./schema";
import { hasAnyTag, setTags, tagsFor } from "./tags";
import { toVideoItems } from "./videos";

type ContactRow = typeof contacts.$inferSelect & { videoCount: number; lastActivityAt: string | null };

// Tiểu truy vấn tương quan viết bằng SQL thô: Drizzle bỏ tên bảng khỏi cột trong trường select của truy vấn một bảng,
// nên một cột như ${contacts.id} ở đây sẽ thành "id" trần và mất tương quan với bảng ngoài.
const withStats = {
  ...getTableColumns(contacts),
  videoCount: sql<number>`(SELECT COUNT(*) FROM contact_videos cv WHERE cv.contact_id = contacts.id)`,
  lastActivityAt: sql<string | null>`(SELECT MAX(a.created_at) FROM contact_activities a WHERE a.contact_id = contacts.id)`,
};

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
    followUpAt: r.followUpAt,
    videoCount: r.videoCount,
    lastActivityAt: r.lastActivityAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export type ContactQuery = { q?: string; status?: string; tag?: string; due?: boolean; limit?: number; offset?: number };

export function listContacts(query: ContactQuery = {}): Page<Contact> {
  const conditions: (SQL | undefined)[] = [];
  if (query.q) {
    const pattern = `%${query.q}%`;
    conditions.push(
      or(like(contacts.name, pattern), like(contacts.company, pattern), like(contacts.phone, pattern), like(contacts.email, pattern), like(contacts.notes, pattern)),
    );
  }
  if (query.status && query.status in CONTACT_STATUSES) conditions.push(eq(contacts.status, query.status as ContactStatus));
  if (query.tag) conditions.push(hasAnyTag("contact", contacts.id, query.tag));
  if (query.due) conditions.push(and(isNotNull(contacts.followUpAt), lte(contacts.followUpAt, new Date().toISOString().slice(0, 10))));
  const where = and(...conditions);
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const rows = db().select(withStats).from(contacts).where(where).orderBy(desc(contacts.updatedAt)).limit(limit).offset(query.offset ?? 0).all();
  const { total } = db().select({ total: count() }).from(contacts).where(where).get()!;
  return { items: toContacts(rows), total };
}

export function getContact(id: string): Contact | null {
  const row = db().select(withStats).from(contacts).where(eq(contacts.id, id)).get();
  return row ? toContacts([row])[0] : null;
}

export function getContactDetail(id: string): ContactDetail | null {
  const contact = getContact(id);
  if (!contact) return null;
  const activities = db()
    .select({ id: contactActivities.id, type: contactActivities.type, content: contactActivities.content, createdAt: contactActivities.createdAt })
    .from(contactActivities)
    .where(eq(contactActivities.contactId, id))
    .orderBy(desc(contactActivities.createdAt))
    .all();
  const linked = toVideoItems(
    db()
      .select(getTableColumns(videos))
      .from(contactVideos)
      .innerJoin(videos, eq(videos.id, contactVideos.videoId))
      .where(eq(contactVideos.contactId, id))
      .orderBy(desc(contactVideos.createdAt))
      .all(),
  );
  return { ...contact, activities, videos: linked };
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
  const status = (input.status ?? current?.status ?? "lead") as ContactStatus;
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
  db().transaction((tx) => {
    tx.insert(contacts).values({ id, ...c }).run();
    setTags("contact", id, parseHashtags(c.notes));
  });
  return getContact(id)!;
}

export function updateContact(id: string, input: ContactInput): Contact | null {
  const current = getContact(id);
  if (!current) return null;
  const c = clean(input, current);
  db().transaction((tx) => {
    tx.update(contacts).set({ ...c, updatedAt: nowIso() }).where(eq(contacts.id, id)).run();
    setTags("contact", id, parseHashtags(c.notes));
    if (current.status !== c.status) {
      addActivityRow(id, "note", `Đổi trạng thái: ${CONTACT_STATUSES[current.status]} → ${CONTACT_STATUSES[c.status]}`);
    }
  });
  return getContact(id);
}

export function deleteContact(id: string): boolean {
  return db().delete(contacts).where(eq(contacts.id, id)).run().changes > 0;
}

function addActivityRow(contactId: string, type: ActivityType, content: string): string {
  const id = crypto.randomUUID();
  db().insert(contactActivities).values({ id, contactId, type, content }).run();
  db().update(contacts).set({ updatedAt: nowIso() }).where(eq(contacts.id, contactId)).run();
  return id;
}

export function addActivity(contactId: string, type: string, content: string): void {
  if (!getContact(contactId)) throw new HttpError(404, "Không tìm thấy khách hàng");
  if (!(type in ACTIVITY_TYPES)) throw new HttpError(400, "Loại hoạt động không hợp lệ");
  if (!content.trim()) throw new HttpError(400, "Nội dung không được để trống");
  addActivityRow(contactId, type as ActivityType, content.trim());
}

export function deleteActivity(id: string): boolean {
  return db().delete(contactActivities).where(eq(contactActivities.id, id)).run().changes > 0;
}

export function linkVideo(contactId: string, videoId: string): void {
  const exists = db().select({ one: sql`1` }).from(videos).where(eq(videos.id, videoId)).get();
  if (!exists || !getContact(contactId)) throw new HttpError(404, "Không tìm thấy khách hàng hoặc video");
  db().insert(contactVideos).values({ contactId, videoId }).onConflictDoNothing().run();
}

export function unlinkVideo(contactId: string, videoId: string): void {
  db().delete(contactVideos).where(and(eq(contactVideos.contactId, contactId), eq(contactVideos.videoId, videoId))).run();
}
