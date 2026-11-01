// Kiểu dữ liệu dùng chung giữa API (server) và giao diện (client).

export type ImageItem = {
  id: string;
  url: string;
  thumbUrl: string;
  title: string;
  description: string;
  tags: string[];
  source: string;
  sourceUrl: string | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  usedIn: number;
  createdAt: string;
};

export type VideoItem = {
  id: string;
  url: string;
  thumbUrl: string | null;
  title: string;
  description: string;
  tags: string[];
  kind: "generated" | "upload";
  duration: number | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  jobId: string | null;
  createdAt: string;
};

export type ScriptStep = {
  heading: string;
  narration: string;
  image_queries: string[];
  image?: string | null;
  hashtags?: string[];
  library_image?: string | null;
};

export type Script = {
  title: string;
  description?: string;
  hashtags?: string[];
  intro: string;
  steps: ScriptStep[];
  outro: string;
};

export type VideoDetail = VideoItem & {
  script: Script | null;
  images: (ImageItem & { step: number })[];
  contacts: { id: string; name: string; company: string }[];
};

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export type JobInput = {
  topic: string;
  numSteps?: number | null;
  language?: string;
  voice?: string;
  rate?: string;
  aspect: "16:9" | "9:16" | "1:1";
  layout: "normal" | "split";
  bgVideoId?: string | null;
  imageStyle: "auto" | "cover" | "frame";
  webImages: boolean;
  libraryMode: "off" | "auto" | "selected";
  libraryTag?: string | null;
  imageIds?: string[];
  contactId?: string | null;
  script?: Script | null;
  /** id video gốc khi render lại từ kịch bản đã sửa */
  sourceVideoId?: string | null;
};

export type JobItem = {
  id: string;
  status: JobStatus;
  topic: string;
  input: JobInput;
  progress: number;
  stage: string | null;
  message: string | null;
  error: string | null;
  videoId: string | null;
  contactId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type JobDetail = JobItem & { log: string; video: VideoItem | null };

export const CONTACT_STATUSES = {
  lead: "Tiềm năng",
  contacted: "Đã liên hệ",
  negotiating: "Đang trao đổi",
  customer: "Khách hàng",
  lost: "Ngừng",
} as const;
export type ContactStatus = keyof typeof CONTACT_STATUSES;

export const ACTIVITY_TYPES = {
  note: "Ghi chú",
  call: "Gọi điện",
  email: "Email",
  meeting: "Gặp mặt",
} as const;
export type ActivityType = keyof typeof ACTIVITY_TYPES;

export type Contact = {
  id: string;
  name: string;
  company: string;
  phone: string;
  email: string;
  status: ContactStatus;
  source: string;
  notes: string;
  tags: string[];
  followUpAt: string | null;
  videoCount: number;
  lastActivityAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Activity = {
  id: string;
  type: ActivityType;
  content: string;
  createdAt: string;
};

export type ContactDetail = Contact & { activities: Activity[]; videos: VideoItem[] };

export type TagCount = { name: string; images: number; videos: number; contacts: number };

export type Page<T> = { items: T[]; total: number };

export type EngineHealth = {
  ok: boolean;
  problems: string[];
  python?: string;
  deepseek?: boolean;
  image_providers?: string[];
  voice?: string;
  font?: string | null;
  moviepy?: string;
};

export type Stats = {
  videos: number;
  images: number;
  contacts: number;
  jobsActive: number;
  followUpsDue: number;
};
