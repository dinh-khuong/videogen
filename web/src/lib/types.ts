// Kiểu dữ liệu dùng chung giữa API (server) và giao diện (client).

export type AssetKind = "image" | "video" | "audio";
export type AnalysisStatus = "pending" | "running" | "done" | "failed";

/** Asset: ảnh, video hoặc audio của người dùng (hoặc ảnh tìm trên mạng) dùng để ghép vào video. */
export type AssetItem = {
  id: string;
  kind: AssetKind;
  url: string;
  thumbUrl: string | null;
  title: string;
  description: string;
  tags: string[];
  source: string;
  sourceUrl: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  sizeBytes: number | null;
  usedIn: number;
  /** Chữ đọc được trong asset (OCR, đã được AI sửa lỗi) */
  ocrText: string;
  /** Tóm tắt nội dung do AI viết, dùng để AI chọn asset khi tạo video */
  aiSummary: string;
  aiTags: string[];
  analysisStatus: AnalysisStatus;
  analysisError: string | null;
  analyzedAt: string | null;
  createdAt: string;
};

export type VideoItem = {
  id: string;
  url: string;
  thumbUrl: string | null;
  title: string;
  description: string;
  tags: string[];
  kind: "generated";
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
  /** id asset (ảnh/video) trong thư viện dùng cho bước này */
  library_image?: string | null;
  /** asset ghép nối tiếp sau library_image (vd thêm clip video) */
  extra_assets?: string[];
  media?: "video" | "image" | null;
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
  assets: (AssetItem & { step: number; position: number })[];
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
  /** id asset video làm nền (bố cục chia đôi) */
  bgVideoId?: string | null;
  imageStyle: "auto" | "cover" | "frame";
  webImages: boolean;
  /** Loại nội dung tìm trên mạng: ảnh, clip video (Creative Commons/stock) hoặc AI chọn cho từng bước */
  webMedia?: "image" | "video" | "auto";
  /** số clip video ghép nối tiếp trong một bước (1-6) */
  clipsPerStep?: number;
  libraryMode: "off" | "auto" | "selected";
  libraryTag?: string | null;
  /** asset chọn làm nội dung chính (chế độ "selected"), theo thứ tự */
  assetIds?: string[];
  /** tên cũ của assetIds (job tạo trước khi đổi sang asset) */
  imageIds?: string[];
  /** id asset audio làm nhạc nền */
  musicId?: string | null;
  /** âm lượng nhạc nền 0-1 */
  musicVolume?: number;
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

export type TagCount = { name: string; assets: number; videos: number; contacts: number };

export type Page<T> = { items: T[]; total: number };

export type EngineHealth = {
  ok: boolean;
  problems: string[];
  warnings?: string[];
  ocr?: string | null;
  vision?: string | null;
  python?: string;
  deepseek?: boolean;
  image_providers?: string[];
  video_providers?: string[];
  voice?: string;
  font?: string | null;
  moviepy?: string;
};

export type Stats = {
  videos: number;
  assets: number;
  assetsAnalyzing: number;
  contacts: number;
  jobsActive: number;
  followUpsDue: number;
};
