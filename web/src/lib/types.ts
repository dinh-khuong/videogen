import type { SearchEngine, VideoLength, VideoStyle, VideoType, VoiceEffect } from "./video-options";

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
  /** Thư mục chứa asset, null = chưa phân loại */
  folderId: string | null;
  createdAt: string;
};

/** Màu thư mục (giống Drive) */
export const FOLDER_COLORS = {
  gray: "#8c8c96",
  red: "#e5484d",
  orange: "#f76b15",
  amber: "#f5a524",
  green: "#30a46c",
  teal: "#12a594",
  blue: "#3e7bfa",
  violet: "#8e4ec6",
  pink: "#d6409f",
} as const;
export type FolderColor = keyof typeof FOLDER_COLORS;

export type AssetFolder = {
  id: string;
  name: string;
  /** Thư mục cha, null = nằm ở gốc thư viện */
  parentId: string | null;
  color: FolderColor | null;
  starred: boolean;
  /** Số asset nằm trực tiếp trong thư mục */
  assetCount: number;
  /** Số asset tính cả thư mục con */
  totalAssets: number;
  /** Dung lượng asset tính cả thư mục con (byte) */
  totalBytes: number;
  createdAt: string;
  updatedAt: string;
};

export type FolderList = {
  items: AssetFolder[];
  /** Số asset nằm ở gốc (chưa thuộc thư mục nào) */
  unfiled: number;
  /** Tổng số asset và dung lượng của cả thư viện */
  totalAssets: number;
  totalBytes: number;
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
  /** Câu thoại có diễn xuất (Đạo diễn AI): mỗi câu một cảm xúc, giọng, hiệu ứng meme. Chỉ dùng khi ghép lại bằng narration. */
  lines?: ScriptLine[];
  /** Hình do Đạo diễn AI chọn (asset thư viện hoặc file đã tải về), theo thứ tự */
  visuals?: ({ asset: string } | { path: string; media?: "image" | "video" })[];
  /** Chữ meme phủ trên hình suốt cảnh */
  meme?: { top: string; bottom: string } | null;
  title_card?: boolean;
  /** Clip (hoặc ảnh) lồng trên hình nền suốt cảnh, ở một góc khung */
  overlay?: { ref: { asset: string } | { path: string; media?: "image" | "video" }; position: "br" | "bl" | "tr" | "tl" | "center" } | null;
  /** Chuyển động ảnh của cảnh (vd zoom_in, pan_left, still); bỏ trống: theo cảm xúc câu thoại */
  motion?: string | null;
};

export type ScriptLine = {
  text: string;
  mood: string;
  voice?: "second";
  sfx?: string;
  camera?: string;
  sticker?: { asset: string } | { path: string; media?: "image" | "video" };
  pop_text?: string;
};

/** AI tinh chỉnh giọng chung của video (cộng vào cài đặt người dùng). base/final do engine ghi lúc dựng. */
export type VoiceTuning = {
  /** Hz cộng thêm */
  pitch: number;
  /** % cộng thêm */
  rate: number;
  reason: string;
  base_rate?: string;
  base_pitch?: string;
  /** mức thật sự dùng trong video, vd "-2Hz" */
  final_rate?: string;
  final_pitch?: string;
};

export type Script = {
  /** director: các cảnh tự do do Đạo diễn AI dựng (không có cảnh mở đầu/kết riêng) */
  format?: "classic" | "director";
  voice_tuning?: VoiceTuning | null;
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
  /** giọng thứ hai đọc xen kẽ các bước chẵn */
  voice2?: string | null;
  rate?: string;
  /** cao độ giọng, vd "+6Hz" */
  pitch?: string;
  /** hiệu ứng giọng: dễ thương, sóc chuột, trầm, robot, radio, vang */
  voiceEffect?: VoiceEffect;
  /** AI được tinh chỉnh cao độ/tốc độ quanh mức đã chọn cho hợp video (job cũ: không) */
  aiVoice?: boolean;
  /** loại video: hướng dẫn, top danh sách, mẹo, sự thật, quảng cáo, kể chuyện */
  videoType?: VideoType;
  /** giọng văn mong muốn của kịch bản */
  tone?: string;
  length?: VideoLength;
  /** nhịp dựng, chuyển cảnh, phụ đề, màu, logo, lời kêu gọi... (job cũ không có: dựng như trước) */
  style?: VideoStyle;
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
  /** công cụ tìm ảnh ưu tiên (Brave, Google...); nguồn khác làm dự phòng. Job cũ: auto */
  searchEngine?: SearchEngine;
  libraryMode: "off" | "auto" | "selected";
  /** AI chỉ xem asset có ít nhất một trong các tag này (chế độ "auto"); trống = cả thư viện */
  libraryTags?: string[];
  /** tên cũ của libraryTags (job tạo khi mới chọn được một tag) */
  libraryTag?: string | null;
  /** AI chỉ xem asset trong các thư mục này (tính cả thư mục con, chế độ "auto"); trống = cả thư viện */
  libraryFolders?: string[];
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
  /** Đạo diễn AI: AI tự lên kịch bản qua nhiều lượt (tìm asset/meme/clip, dựng cảnh, tự duyệt), giọng đổi cảm xúc từng câu */
  director?: boolean;
  /** góp ý của người dùng để Đạo diễn AI sửa lại video của job baseJobId */
  feedback?: string | null;
  baseJobId?: string | null;
};

/** Một bước suy nghĩ/hành động của Đạo diễn AI (engine ghi vào director.jsonl). */
export type AgentEvent = {
  t: number;
  turn: number;
  kind: "thought" | "action" | "result" | "warn" | "done";
  text: string;
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

export type JobDetail = JobItem & { log: string; video: VideoItem | null; agent: AgentEvent[] };

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
  /** mọi công cụ tìm ảnh và đã có key chưa */
  search_engines?: Partial<Record<SearchEngine, boolean>>;
  video_providers?: string[];
  voice?: string;
  /** có FPT_AI_API_KEY (giọng FPT.AI) */
  fpt_tts?: boolean;
  /** đã cài thư viện zerotts (giọng ZeroTTS chạy trên máy) */
  zerotts?: boolean;
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
