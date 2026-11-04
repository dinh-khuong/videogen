// Schema của SQLite: nguồn duy nhất cho cấu trúc bảng. Sửa ở đây rồi chạy `npm run db:generate` để sinh file migration
// trong web/drizzle/ (được áp dụng tự động khi server khởi động, xem db.ts).
// File này cũng được drizzle-kit nạp riêng: chỉ import type bằng đường dẫn tương đối, không import "server-only" hay "@/".
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { ActivityType, AnalysisStatus, AssetKind, ContactStatus, JobStatus, TokenCheckStatus } from "../types";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
const createdAt = () => text("created_at").notNull().default(now);
const updatedAt = () => text("updated_at").notNull().default(now);

export const tags = sqliteTable("tags", {
  id: integer("id").primaryKey(),
  name: text("name").notNull().unique(),
});

export const assetFolders = sqliteTable(
  "asset_folders",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    parentId: text("parent_id").references((): AnySQLiteColumn => assetFolders.id, { onDelete: "cascade" }),
    color: text("color"),
    starred: integer("starred").notNull().default(0),
  },
  (t) => [index("asset_folders_parent").on(t.parentId)],
);

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    file: text("file").notNull(),
    thumbnail: text("thumbnail"),
    title: text("title").notNull().default(""),
    description: text("description").notNull().default(""),
    source: text("source").notNull().default("upload"),
    sourceUrl: text("source_url"),
    width: integer("width"),
    height: integer("height"),
    sizeBytes: integer("size_bytes"),
    sha1: text("sha1").unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    kind: text("kind").$type<AssetKind>().notNull().default("image"),
    duration: real("duration"),
    ocrText: text("ocr_text").notNull().default(""),
    aiSummary: text("ai_summary").notNull().default(""),
    aiTags: text("ai_tags").notNull().default("[]"),
    analysisStatus: text("analysis_status").$type<AnalysisStatus>().notNull().default("pending"),
    analysisError: text("analysis_error"),
    analyzedAt: text("analyzed_at"),
    folderId: text("folder_id").references(() => assetFolders.id, { onDelete: "set null" }),
  },
  (t) => [index("assets_analysis").on(t.analysisStatus, t.createdAt), index("assets_folder").on(t.folderId, t.createdAt)],
);

export const contacts = sqliteTable("contacts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  company: text("company").notNull().default(""),
  phone: text("phone").notNull().default(""),
  email: text("email").notNull().default(""),
  status: text("status").$type<ContactStatus>().notNull().default("lead"),
  source: text("source").notNull().default(""),
  notes: text("notes").notNull().default(""),
  followUpAt: text("follow_up_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    topic: text("topic").notNull().default(""),
    input: text("input").notNull(),
    progress: real("progress").notNull().default(0),
    stage: text("stage"),
    message: text("message"),
    error: text("error"),
    videoId: text("video_id"),
    contactId: text("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    pid: integer("pid"),
    createdAt: createdAt(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    durationSeconds: real("duration_seconds"),
    estimatedSeconds: real("estimated_seconds"),
  },
  (t) => [index("jobs_status").on(t.status, t.createdAt)],
);

export const videos = sqliteTable("videos", {
  id: text("id").primaryKey(),
  file: text("file").notNull(),
  thumbnail: text("thumbnail"),
  title: text("title").notNull().default(""),
  description: text("description").notNull().default(""),
  kind: text("kind").$type<"generated">().notNull().default("generated"),
  duration: real("duration"),
  width: integer("width"),
  height: integer("height"),
  sizeBytes: integer("size_bytes"),
  script: text("script"),
  /** prompt đã dùng để tạo video và cài đặt (JSON, kiểu VideoSettings); giữ lại khi job bị xóa */
  prompt: text("prompt"),
  settings: text("settings"),
  jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const videoAssets = sqliteTable(
  "video_assets",
  {
    videoId: text("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    step: integer("step").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.videoId, t.step, t.position] }), index("video_assets_asset").on(t.assetId)],
);

export const assetTags = sqliteTable(
  "asset_tags",
  {
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.assetId, t.tagId] })],
);

export const videoTags = sqliteTable(
  "video_tags",
  {
    videoId: text("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.videoId, t.tagId] })],
);

export const contactTags = sqliteTable(
  "contact_tags",
  {
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.contactId, t.tagId] })],
);

export const contactActivities = sqliteTable(
  "contact_activities",
  {
    id: text("id").primaryKey(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    type: text("type").$type<ActivityType>().notNull().default("note"),
    content: text("content").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("contact_activities_contact").on(t.contactId, t.createdAt)],
);

export const contactVideos = sqliteTable(
  "contact_videos",
  {
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    videoId: text("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.contactId, t.videoId] })],
);

/** Token/API key của các dịch vụ: mỗi dịch vụ lưu nhiều token, một cái đang dùng (active) được truyền cho engine. */
export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    name: text("name").notNull().default(""),
    value: text("value").notNull(),
    active: integer("active").notNull().default(0),
    note: text("note").notNull().default(""),
    lastStatus: text("last_status").$type<TokenCheckStatus>(),
    lastMessage: text("last_message"),
    lastCheckedAt: text("last_checked_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** JSON { khóa: giá trị }: model, địa chỉ API... */
    options: text("options").notNull().default("{}"),
  },
  (t) => [index("api_tokens_provider").on(t.provider, t.active)],
);
