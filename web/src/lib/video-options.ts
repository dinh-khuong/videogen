// Các lựa chọn khi tạo video: dùng chung cho form (client) và kiểm tra dữ liệu (server).
// Giá trị phải khớp với engine (engine/videogen/style.py, llm.py).

export type Voice = { value: string; label: string };

/** Giọng "Multilingual" của Microsoft đọc được nhiều ngôn ngữ (kể cả tiếng Việt), thêm vào mọi ngôn ngữ. */
export const MULTILINGUAL_VOICES: Voice[] = [
  { value: "en-US-AvaMultilingualNeural", label: "Ava (nữ, truyền cảm)" },
  { value: "en-US-EmmaMultilingualNeural", label: "Emma (nữ, tươi vui)" },
  { value: "fr-FR-VivienneMultilingualNeural", label: "Vivienne (nữ, nhẹ nhàng)" },
  { value: "de-DE-SeraphinaMultilingualNeural", label: "Seraphina (nữ, điềm tĩnh)" },
  { value: "pt-BR-ThalitaMultilingualNeural", label: "Thalita (nữ, trẻ trung)" },
  { value: "en-US-AndrewMultilingualNeural", label: "Andrew (nam, ấm áp)" },
  { value: "en-US-BrianMultilingualNeural", label: "Brian (nam, thân thiện)" },
  { value: "fr-FR-RemyMultilingualNeural", label: "Rémy (nam, trầm)" },
  { value: "de-DE-FlorianMultilingualNeural", label: "Florian (nam, rõ ràng)" },
  { value: "it-IT-GiuseppeMultilingualNeural", label: "Giuseppe (nam, sôi nổi)" },
  { value: "ko-KR-HyunsuMultilingualNeural", label: "Hyunsu (nam, trẻ)" },
];

/** Mã ngôn ngữ của gTTS ("chị Google") theo ngôn ngữ video. */
const GTTS_LANG: Record<string, string> = {
  "tiếng Việt": "vi",
  English: "en",
  中文: "zh-CN",
  日本語: "ja",
  한국어: "ko",
  Français: "fr",
  Español: "es",
  Deutsch: "de",
  ไทย: "th",
  "Bahasa Indonesia": "id",
};

/** Giọng "chị Google" (gTTS): giọng máy quen thuộc trên các kênh meme/kiến thức, miễn phí. */
export function gttsVoice(language: string): Voice {
  const code = GTTS_LANG[language] ?? "vi";
  return { value: `gtts:${code}`, label: code === "vi" ? "Chị Google (giọng meme quen thuộc)" : "Google Translate — nữ (gTTS)" };
}

/** "Anh Google": Google chỉ có giọng nữ, giọng nam là cùng giọng đó được hạ trầm (engine xử lý). */
export function gttsMaleVoice(language: string): Voice {
  const code = GTTS_LANG[language] ?? "vi";
  return { value: `gtts:${code}-male`, label: code === "vi" ? "Anh Google (giọng Google nam)" : "Google Translate — nam (gTTS)" };
}

/** Giọng FPT.AI: giọng Việt tự nhiên nhiều kênh kiến thức dùng, cần FPT_AI_API_KEY trong engine/.env. */
export const FPT_VOICES: Voice[] = [
  { value: "fpt:banmaiace", label: "Ban Mai (nữ, miền Bắc)" },
  { value: "fpt:thuminh", label: "Thu Minh (nữ, miền Bắc)" },
  { value: "fpt:leminh", label: "Lê Minh (nam, miền Bắc)" },
  { value: "fpt:myan", label: "Mỹ An (nữ, miền Trung)" },
  { value: "fpt:ngoclam", label: "Ngọc Lam (nữ, miền Trung)" },
  { value: "fpt:giahuy", label: "Gia Huy (nam, miền Trung)" },
  { value: "fpt:lannhi", label: "Lan Nhi (nữ, miền Nam)" },
  { value: "fpt:linhsan", label: "Linh San (nữ, miền Nam)" },
  { value: "fpt:minhquang", label: "Minh Quang (nam, miền Nam)" },
];

/**
 * Giọng ZeroTTS (mô hình giọng Việt chạy trên máy, cần `pip install zerotts`). Danh sách đầy đủ lấy từ mô hình
 * qua /api/voices/zerotts; đây là giọng mặc định hiện khi chưa lấy được danh sách.
 */
export const ZEROTTS_VOICES: Voice[] = [{ value: "zerotts:maichi", label: "Mai Chi (ZeroTTS)" }];

/** Tên giọng hợp lệ: edge-tts (vi-VN-HoaiMyNeural), gTTS (gtts:vi), FPT.AI (fpt:banmaiace) hoặc ZeroTTS (zerotts:maichi). */
export const VOICE_RE = /^(?:(?:gtts|fpt):[a-zA-Z-]{2,20}|zerotts:[\w-]{1,40}|[a-z]{2,3}-[A-Z]{2,3}-\w+)$/;

export const VOICE_EFFECTS = {
  none: "Không",
  cute: "Dễ thương, ngọng nhẹ",
  chipmunk: "Sóc chuột (cao vút, lầy lội)",
  deep: "Trầm ma mị (kể chuyện ma)",
  robot: "Robot",
  radio: "Radio / điện thoại",
  echo: "Vang (như trong hang)",
} as const;
export type VoiceEffect = keyof typeof VOICE_EFFECTS;

export type Language = { value: string; label: string; voices: Voice[] };

/** value = tên ngôn ngữ gửi cho AI viết kịch bản và engine (nhãn "Bước", font chữ...). */
export const LANGUAGES: Language[] = [
  {
    value: "tiếng Việt",
    label: "Tiếng Việt",
    voices: [
      { value: "vi-VN-HoaiMyNeural", label: "Hoài My (nữ, miền Bắc)" },
      { value: "vi-VN-NamMinhNeural", label: "Nam Minh (nam, miền Bắc)" },
    ],
  },
  {
    value: "English",
    label: "Tiếng Anh (English)",
    voices: [
      { value: "en-US-JennyNeural", label: "Jenny (female, US)" },
      { value: "en-US-AriaNeural", label: "Aria (female, US)" },
      { value: "en-US-MichelleNeural", label: "Michelle (female, US)" },
      { value: "en-US-AnaNeural", label: "Ana (girl, US)" },
      { value: "en-US-GuyNeural", label: "Guy (male, US)" },
      { value: "en-US-ChristopherNeural", label: "Christopher (male, US)" },
      { value: "en-US-EricNeural", label: "Eric (male, US)" },
      { value: "en-US-RogerNeural", label: "Roger (male, US)" },
      { value: "en-US-SteffanNeural", label: "Steffan (male, US)" },
      { value: "en-GB-SoniaNeural", label: "Sonia (female, UK)" },
      { value: "en-GB-LibbyNeural", label: "Libby (female, UK)" },
      { value: "en-GB-RyanNeural", label: "Ryan (male, UK)" },
      { value: "en-GB-ThomasNeural", label: "Thomas (male, UK)" },
      { value: "en-AU-NatashaNeural", label: "Natasha (female, AU)" },
      { value: "en-AU-WilliamNeural", label: "William (male, AU)" },
      { value: "en-IN-NeerjaNeural", label: "Neerja (female, IN)" },
      { value: "en-IN-PrabhatNeural", label: "Prabhat (male, IN)" },
    ],
  },
  {
    value: "中文",
    label: "Tiếng Trung (中文)",
    voices: [
      { value: "zh-CN-XiaoxiaoNeural", label: "晓晓 Xiaoxiao (nữ)" },
      { value: "zh-CN-XiaoyiNeural", label: "晓伊 Xiaoyi (nữ)" },
      { value: "zh-CN-YunxiNeural", label: "云希 Yunxi (nam)" },
      { value: "zh-CN-YunjianNeural", label: "云健 Yunjian (nam)" },
      { value: "zh-CN-YunyangNeural", label: "云扬 Yunyang (nam, tin tức)" },
      { value: "zh-CN-YunxiaNeural", label: "云夏 Yunxia (bé trai)" },
      { value: "zh-TW-HsiaoChenNeural", label: "曉臻 HsiaoChen (nữ, Đài Loan)" },
    ],
  },
  {
    value: "日本語",
    label: "Tiếng Nhật (日本語)",
    voices: [
      { value: "ja-JP-NanamiNeural", label: "七海 Nanami (nữ)" },
      { value: "ja-JP-KeitaNeural", label: "圭太 Keita (nam)" },
    ],
  },
  {
    value: "한국어",
    label: "Tiếng Hàn (한국어)",
    voices: [
      { value: "ko-KR-SunHiNeural", label: "선히 SunHi (nữ)" },
      { value: "ko-KR-InJoonNeural", label: "인준 InJoon (nam)" },
    ],
  },
  {
    value: "Français",
    label: "Tiếng Pháp (Français)",
    voices: [
      { value: "fr-FR-DeniseNeural", label: "Denise (femme)" },
      { value: "fr-FR-EloiseNeural", label: "Eloise (fille)" },
      { value: "fr-FR-HenriNeural", label: "Henri (homme)" },
    ],
  },
  {
    value: "Español",
    label: "Tiếng Tây Ban Nha (Español)",
    voices: [
      { value: "es-ES-ElviraNeural", label: "Elvira (mujer, España)" },
      { value: "es-ES-AlvaroNeural", label: "Álvaro (hombre, España)" },
      { value: "es-MX-DaliaNeural", label: "Dalia (mujer, México)" },
      { value: "es-MX-JorgeNeural", label: "Jorge (hombre, México)" },
    ],
  },
  {
    value: "Deutsch",
    label: "Tiếng Đức (Deutsch)",
    voices: [
      { value: "de-DE-KatjaNeural", label: "Katja (Frau)" },
      { value: "de-DE-AmalaNeural", label: "Amala (Frau)" },
      { value: "de-DE-ConradNeural", label: "Conrad (Mann)" },
      { value: "de-DE-KillianNeural", label: "Killian (Mann)" },
    ],
  },
  {
    value: "ไทย",
    label: "Tiếng Thái (ไทย)",
    voices: [
      { value: "th-TH-PremwadeeNeural", label: "Premwadee (nữ)" },
      { value: "th-TH-NiwatNeural", label: "Niwat (nam)" },
    ],
  },
  {
    value: "Bahasa Indonesia",
    label: "Tiếng Indonesia",
    voices: [
      { value: "id-ID-GadisNeural", label: "Gadis (nữ)" },
      { value: "id-ID-ArdiNeural", label: "Ardi (nam)" },
    ],
  },
];

export function languageOf(value: string | undefined): Language {
  return LANGUAGES.find((l) => l.value === value) ?? LANGUAGES[0];
}

export function voiceLabel(value: string | null | undefined): string {
  if (!value) return "";
  const all = [...LANGUAGES.flatMap((l) => [...l.voices, gttsVoice(l.value), gttsMaleVoice(l.value)]), ...MULTILINGUAL_VOICES, ...FPT_VOICES, ...ZEROTTS_VOICES];
  for (const v of all) if (v.value === value) return v.label;
  if (value.startsWith("zerotts:")) return `${value.slice(8)} (ZeroTTS)`;
  return value;
}

export const RATES = [
  { value: "-20%", label: "Rất chậm (-20%)" },
  { value: "-10%", label: "Chậm (-10%)" },
  { value: "+0%", label: "Bình thường" },
  { value: "+5%", label: "Hơi nhanh (+5%)" },
  { value: "+10%", label: "Nhanh (+10%)" },
  { value: "+15%", label: "Nhanh hơn (+15%)" },
  { value: "+20%", label: "Rất nhanh (+20%)" },
  { value: "+30%", label: "Siêu nhanh (+30%)" },
];

export const PITCHES = [
  { value: "-12Hz", label: "Rất trầm" },
  { value: "-6Hz", label: "Trầm ấm" },
  { value: "+0Hz", label: "Tự nhiên" },
  { value: "+6Hz", label: "Trong trẻo" },
  { value: "+12Hz", label: "Cao, vui tươi" },
];

/** Khoảng của thanh trượt cao độ (Hz, cộng vào giọng gốc). */
/** Audio trong Assets dài tối đa chừng này (giây) mới được Đạo diễn AI dùng làm hiệu ứng âm thanh; dài hơn coi là nhạc nền. */
export const SOUND_EFFECT_MAX_SECONDS = 10;

export const PITCH_MIN = -30;
export const PITCH_MAX = 30;

/** Giới hạn AI được tinh chỉnh quanh mức người dùng chọn (khớp engine/videogen/delivery.py). */
export const AI_TUNE_PITCH_LIMIT = 15;
export const AI_TUNE_RATE_LIMIT = 20;

/** "+6Hz" -> 6 (giá trị lạ -> 0). */
export function pitchHz(value: string | null | undefined): number {
  const n = Number.parseInt(String(value ?? "").replace(/Hz$/, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

/** 6 -> "+6Hz", 0 -> "+0Hz", -6 -> "-6Hz" (dạng engine nhận). */
export function hzValue(n: number): string {
  const v = Math.round(n);
  return `${v < 0 ? "-" : "+"}${Math.abs(v)}Hz`;
}

/** Mô tả ngắn của một mức cao độ, vd "Trầm ấm". */
export function pitchLabel(n: number): string {
  if (n <= -18) return "Rất trầm, ồm";
  if (n <= -9) return "Rất trầm";
  if (n <= -3) return "Trầm ấm";
  if (n < 3) return "Tự nhiên";
  if (n < 9) return "Trong trẻo";
  if (n < 18) return "Cao, vui tươi";
  return "Rất cao, lảnh lót";
}

/** Sắc thái giọng: đặt nhanh tốc độ + cao độ. */
export const VOICE_MOODS = [
  { label: "Tự nhiên", rate: "+0%", pitch: "+0Hz" },
  { label: "Trầm ấm, chậm rãi", rate: "-10%", pitch: "-6Hz" },
  { label: "Kể chuyện", rate: "-10%", pitch: "+0Hz" },
  { label: "Trẻ trung, năng động", rate: "+10%", pitch: "+6Hz" },
  { label: "Quảng cáo sôi nổi", rate: "+20%", pitch: "+6Hz" },
  { label: "Tin tức", rate: "+10%", pitch: "-6Hz" },
];

export const VIDEO_TYPES = {
  howto: { label: "Hướng dẫn", hint: "Các bước thực hiện theo thứ tự" },
  listicle: { label: "Top danh sách", hint: "Top 5 địa điểm, món ăn, sản phẩm..." },
  tips: { label: "Mẹo hay", hint: "Mẹo nhanh, làm được ngay" },
  facts: { label: "Sự thật thú vị", hint: "Kiến thức gây tò mò" },
  promo: { label: "Quảng cáo", hint: "Giới thiệu sản phẩm, dịch vụ, ưu đãi" },
  story: { label: "Kể chuyện", hint: "Câu chuyện có mở đầu, cao trào, kết" },
} as const;
export type VideoType = keyof typeof VIDEO_TYPES;

/** Phong cách viết: AI nói thế nào (khớp engine/videogen/writing.py STYLES). Khác loại video (nội dung xếp theo khung nào). */
export const WRITING_STYLES = {
  auto: { label: "Tự động", hint: "Đạo diễn AI: hài meme; kịch bản nhanh: một người dẫn" },
  narrator: { label: "Người dẫn", hint: "Một người dẫn rõ ràng, có duyên, hài nhẹ" },
  essay: { label: "Video essay", hint: "Bình luận có chính kiến: luận điểm, dẫn chứng, phản biện" },
  dialogue: { label: "Hai nhân vật", hint: "Hai người trò chuyện, đối đáp bằng hai giọng" },
  comedy: { label: "Hài / meme", hint: "Mỗi cảnh một miếng hài, cà khịa, meme" },
} as const;
export type WritingStyle = keyof typeof WRITING_STYLES;

export const TONES = [
  { value: "", label: "Tự nhiên (mặc định)" },
  { value: "thân thiện, gần gũi như nói chuyện với bạn bè", label: "Thân thiện, gần gũi" },
  { value: "hài hước, dí dỏm", label: "Hài hước, dí dỏm" },
  { value: "chuyên nghiệp, đáng tin cậy", label: "Chuyên nghiệp" },
  { value: "truyền cảm hứng, tích cực", label: "Truyền cảm hứng" },
  { value: "thuyết phục, kêu gọi mua hàng", label: "Thuyết phục, bán hàng" },
  { value: "kể chuyện lôi cuốn, giàu cảm xúc", label: "Lôi cuốn, cảm xúc" },
  { value: "trẻ trung, bắt trend, ngôn ngữ Gen Z", label: "Trẻ trung (Gen Z)" },
  { value: "ngắn gọn, đi thẳng vào vấn đề", label: "Ngắn gọn, súc tích" },
];

export const LENGTHS = {
  short: { label: "Ngắn", hint: "< 45 giây, 3-4 phần" },
  medium: { label: "Vừa", hint: "~1 phút, 5-8 phần" },
  long: { label: "Dài", hint: "2-3 phút, 8-12 phần" },
} as const;
export type VideoLength = keyof typeof LENGTHS;

/** Công cụ tìm ảnh trên mạng (khớp engine/videogen/image_search.py PROVIDERS). */
export const SEARCH_ENGINES = {
  auto: { label: "Tự động", hint: "theo thứ tự IMAGE_PROVIDERS trong engine/.env", env: "" },
  duckduckgo: { label: "DuckDuckGo", hint: "không cần key", env: "" },
  google: { label: "Google", hint: "Google Custom Search", env: "GOOGLE_API_KEY + GOOGLE_CSE_ID" },
  brave: { label: "Brave", hint: "Brave Search API", env: "BRAVE_API_KEY" },
  serper: { label: "Google qua Serper", hint: "kết quả Google Images qua Serper.dev", env: "SERPER_API_KEY" },
  pexels: { label: "Pexels", hint: "ảnh stock dùng thương mại", env: "PEXELS_API_KEY" },
  pixabay: { label: "Pixabay", hint: "ảnh stock dùng thương mại", env: "PIXABAY_API_KEY" },
} as const;
export type SearchEngine = keyof typeof SEARCH_ENGINES;

export const PACINGS = {
  slow: { label: "Chậm rãi", hint: "Cảnh dài, chuyển mềm" },
  normal: { label: "Vừa", hint: "Cân bằng" },
  fast: { label: "Nhanh, dồn dập", hint: "Cắt cảnh nhanh, ~2 giây đổi một hình, nhiều ảnh" },
} as const;
export type Pacing = keyof typeof PACINGS;

export const TRANSITIONS = {
  mix: "Đa dạng (tự luân phiên nhiều kiểu)",
  slide: "Trượt đẩy",
  whip: "Lia máy nhanh",
  zoom: "Zoom xuyên cảnh",
  wipe: "Quét ngang",
  circle: "Mở vòng tròn",
  flash: "Lóe sáng",
  fade: "Mờ chồng (cổ điển)",
} as const;
export type TransitionKind = keyof typeof TRANSITIONS;

export const SUBTITLE_STYLES = {
  auto: "Tự động (karaoke cho video dọc, khung chữ cho video ngang)",
  karaoke: "Karaoke: tô màu từ đang đọc",
  outline: "Chữ to viền đen",
  box: "Chữ trong khung tối",
  none: "Không phụ đề",
} as const;
export type SubtitleStyle = keyof typeof SUBTITLE_STYLES;

export const COLOR_FILTERS = {
  none: "Màu gốc",
  vivid: "Rực rỡ",
  warm: "Ấm áp",
  cool: "Mát lạnh",
  cinematic: "Điện ảnh",
  vintage: "Hoài cổ",
  bw: "Đen trắng",
} as const;
export type ColorFilter = keyof typeof COLOR_FILTERS;

export const ACCENTS = [
  { value: "#e95420", label: "Cam" },
  { value: "#f5b700", label: "Vàng" },
  { value: "#e53935", label: "Đỏ" },
  { value: "#ec407a", label: "Hồng" },
  { value: "#8e24aa", label: "Tím" },
  { value: "#1e88e5", label: "Xanh dương" },
  { value: "#00acc1", label: "Xanh ngọc" },
  { value: "#43a047", label: "Xanh lá" },
];

/** Phong cách dựng video (engine: Style). */
export type VideoStyle = {
  pacing: Pacing;
  transition: TransitionKind;
  subtitleStyle: SubtitleStyle;
  colorFilter: ColorFilter;
  /** màu chủ đạo dạng #rrggbb */
  accent: string;
  progressBar: boolean;
  sfx: boolean;
  /** tiếng khi chuyển cảnh; "default" = như cũ (tiếng “vút” theo sfx ở kiểu chuyển trượt/quét) */
  transitionSound: TransitionSound;
  /** id asset audio phát ở mọi lần chuyển cảnh (transitionSound "asset") */
  transitionSoundId: string | null;
  /** id asset ảnh làm logo (góc trên phải) */
  logoId: string | null;
  /** lời kêu gọi hiện ở cuối video */
  cta: string;
};

export const DEFAULT_STYLE: VideoStyle = {
  pacing: "normal",
  transition: "mix",
  subtitleStyle: "auto",
  colorFilter: "vivid",
  accent: ACCENTS[0].value,
  progressBar: true,
  sfx: true,
  transitionSound: "default",
  transitionSoundId: null,
  logoId: null,
  cta: "",
};

/** Tiếng khi chuyển cảnh (khớp engine/videogen/cast.py TRANSITION_SOUNDS). */
export const TRANSITION_SOUNDS = {
  default: { label: "Mặc định", hint: "Tiếng “vút” ở kiểu chuyển trượt/quét khi bật “Hiệu ứng âm thanh”" },
  off: { label: "Không có", hint: "Chuyển cảnh im lặng" },
  whoosh: { label: "Vút", hint: "Tiếng gió lướt qua ở mọi lần chuyển cảnh" },
  pop: { label: "Tách", hint: "Tiếng “pop” ngắn, gọn" },
  ding: { label: "Ting", hint: "Chuông nhẹ, hợp video mẹo/kiến thức" },
  boom: { label: "Bùm", hint: "Trầm, mạnh — hợp video kịch tính, meme" },
  scratch: { label: "Rít đĩa", hint: "Kiểu “khoan đã”, hài hước" },
  bonk: { label: "Cốp", hint: "Tiếng gõ vui nhộn" },
  asset: { label: "Âm thanh trong Assets", hint: "Một file âm thanh ngắn bạn chọn, phát ở mọi lần chuyển" },
  auto: { label: "AI / thư viện chọn", hint: "Đạo diễn AI chọn tiếng cho từng cảnh; kịch bản nhanh dùng tiếng chuyển cảnh trong Assets (whoosh, swoosh...)" },
} as const;
export type TransitionSound = keyof typeof TRANSITION_SOUNDS;

/** Số người nói tối đa trong một video (khớp engine/videogen/cast.py). */
export const MAX_SPEAKERS = 4;

/** Cách chuyển giọng khi video có nhiều người nói. */
export const VOICE_SWITCHES = {
  scene: { label: "Đổi giọng theo cảnh", hint: "Mỗi cảnh một người đọc, lần lượt xoay vòng các giọng (như nhiều người dẫn thay phiên)." },
  character: { label: "Theo nhân vật / lời thoại", hint: "AI gán từng câu thoại cho một nhân vật, các giọng đối đáp như hội thoại, podcast." },
} as const;
export type VoiceSwitch = keyof typeof VOICE_SWITCHES;

/** Giọng thứ 2..4 trong video nhiều giọng: giọng, tốc độ, cao độ riêng và tên nhân vật (tùy chọn). */
export type CastVoice = { voice: string; rate: string; pitch: string; name: string };

/** Dàn giọng của video do người dùng đặt. Không có (null) = tự động như trước: giọng thứ hai đọc xen kẽ, AI thêm giọng phụ khi cần. */
export type VoiceCast = {
  /** số người nói 1-4 */
  count: number;
  switchBy: VoiceSwitch;
  /** tên nhân vật của giọng chính (tùy chọn) */
  mainName: string;
  /** giọng 2..count */
  extra: CastVoice[];
};

export const MAX_CAST_NAME_CHARS = 30;
const RATE_RE = /^[+-]\d{1,3}%$/;
const PITCH_RE = /^[+-]\d{1,3}Hz$/;

/** Chuẩn hóa dàn giọng gửi lên / lưu trong trình duyệt (giá trị lạ bị bỏ; thiếu giọng thì giảm số người nói). */
export function normalizeCast(raw: unknown): VoiceCast | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<VoiceCast>;
  const name = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, MAX_CAST_NAME_CHARS) : "");
  const wanted = Math.min(Math.max(Math.round(Number(c.count) || 1), 1), MAX_SPEAKERS);
  const extra = (Array.isArray(c.extra) ? c.extra : [])
    .filter((v): v is CastVoice => !!v && typeof v === "object" && typeof v.voice === "string" && VOICE_RE.test(v.voice))
    .slice(0, wanted - 1)
    .map((v) => ({
      voice: v.voice,
      rate: typeof v.rate === "string" && RATE_RE.test(v.rate) ? v.rate : "+0%",
      pitch: typeof v.pitch === "string" && PITCH_RE.test(v.pitch) ? v.pitch : "+0Hz",
      name: name(v.name),
    }));
  return {
    count: extra.length + 1,
    switchBy: c.switchBy === "scene" ? "scene" : "character",
    mainName: name(c.mainName),
    extra,
  };
}

/** Giọng gợi ý cho người nói thứ index+1: giọng của ngôn ngữ (rồi giọng đa ngôn ngữ) chưa ai dùng, xen kẽ nam/nữ. */
export function suggestCastVoice(language: string, taken: string[], index: number): CastVoice {
  const pool = [...languageOf(language).voices, ...MULTILINGUAL_VOICES].map((v) => v.value);
  const voice = pool.find((v) => !taken.includes(v)) ?? pool[index % pool.length];
  // Giọng phải dùng lại (hết giọng khác): đổi cao độ cho dễ phân biệt
  return { voice, rate: "+0%", pitch: taken.includes(voice) ? (index % 2 ? "+6Hz" : "-6Hz") : "+0Hz", name: "" };
}

/** Giọng đọc của video. */
export type VoiceSettings = {
  language: string;
  voice: string;
  /** giọng thứ hai đọc xen kẽ các bước chẵn ("" = không dùng) */
  voice2: string;
  rate: string;
  pitch: string;
  effect: VoiceEffect;
  /** AI được tinh chỉnh cao độ/tốc độ quanh mức đã chọn cho hợp không khí video */
  aiTune: boolean;
  /** số người nói, chuyển giọng theo cảnh/nhân vật, giọng riêng từng người; null = tự động (như trước) */
  cast: VoiceCast | null;
  /** giữ giọng đều suốt video: không đổi tốc độ/cao độ theo cảm xúc từng câu */
  steady: boolean;
};

export const DEFAULT_VOICE: VoiceSettings = {
  language: LANGUAGES[0].value,
  voice: LANGUAGES[0].voices[0].value,
  voice2: "",
  rate: "+0%",
  pitch: "+0Hz",
  effect: "none",
  aiTune: true,
  cast: null,
  steady: false,
};

/** Giọng kiểu các kênh quen thuộc (tiếng Việt): đặt cùng lúc giọng, tốc độ, cao độ, hiệu ứng. */
export const VOICE_PERSONAS: { label: string; hint: string; voice: Omit<VoiceSettings, "language" | "voice2" | "aiTune" | "cast" | "steady"> }[] = [
  { label: "Kênh kiến thức", hint: "Nam trầm, đọc nhanh vừa", voice: { voice: "vi-VN-NamMinhNeural", rate: "+10%", pitch: "-6Hz", effect: "none" } },
  { label: "Chị Google", hint: "Giọng meme kinh điển", voice: { voice: "gtts:vi", rate: "+15%", pitch: "+0Hz", effect: "none" } },
  { label: "Anh Google", hint: "Giọng Google nam, trầm", voice: { voice: "gtts:vi-male", rate: "+15%", pitch: "+0Hz", effect: "none" } },
  { label: "Ngọng Tây dễ thương", hint: "Giọng Tây đọc tiếng Việt", voice: { voice: "en-US-AvaMultilingualNeural", rate: "+5%", pitch: "+6Hz", effect: "cute" } },
  { label: "Bé ngọng", hint: "Cao, trong, hơi ngọng", voice: { voice: "vi-VN-HoaiMyNeural", rate: "+5%", pitch: "+6Hz", effect: "cute" } },
  { label: "Sóc chuột lầy lội", hint: "Cao vút, nhanh", voice: { voice: "vi-VN-HoaiMyNeural", rate: "+15%", pitch: "+0Hz", effect: "chipmunk" } },
  { label: "Kể chuyện ma", hint: "Trầm, chậm, có vang", voice: { voice: "vi-VN-NamMinhNeural", rate: "-10%", pitch: "-6Hz", effect: "deep" } },
  { label: "Robot", hint: "Giọng máy", voice: { voice: "vi-VN-NamMinhNeural", rate: "+0%", pitch: "+0Hz", effect: "robot" } },
  { label: "Tổng đài / radio", hint: "Như qua điện thoại", voice: { voice: "vi-VN-HoaiMyNeural", rate: "+5%", pitch: "+0Hz", effect: "radio" } },
];

export const MAX_CTA_CHARS = 120;
export const MAX_TONE_CHARS = 200;

/** Tần suất đổi hình (giây giữa hai lần đổi ảnh/clip). Engine còn nâng lên tối thiểu theo nhịp dựng (chậm 3,4s / vừa 2,2s / nhanh 1,4s). */
export const MIN_VISUAL_INTERVAL = 1.5;
export const MAX_VISUAL_INTERVAL = 30;
/** Thời lượng tối thiểu của một đoạn hình theo nhịp dựng (giây), cùng giá trị với engine/videogen/style.py PACING. */
export const MIN_SEGMENT_SECONDS: Record<Pacing, number> = { slow: 3.4, normal: 2.2, fast: 1.4 };
/** Số ảnh meme / clip meme tối đa người dùng đặt cho một video. */
export const MAX_MEMES = 20;

/** Phong cách của video tạo trước khi có tùy chọn này (chạy lại job cũ cho kết quả như cũ). */
export const LEGACY_STYLE: VideoStyle = {
  pacing: "normal",
  transition: "fade",
  subtitleStyle: "box",
  colorFilter: "none",
  accent: ACCENTS[0].value,
  progressBar: false,
  sfx: false,
  transitionSound: "default",
  transitionSoundId: null,
  logoId: null,
  cta: "",
};

/** Chuẩn hóa phong cách gửi lên (giá trị lạ thì dùng mặc định). */
export function normalizeStyle(raw: Partial<VideoStyle> | null | undefined): VideoStyle {
  const s = raw ?? {};
  const pick = <T extends string>(value: unknown, allowed: Record<T, unknown>, fallback: T): T =>
    typeof value === "string" && Object.hasOwn(allowed, value) ? (value as T) : fallback;
  return {
    pacing: pick(s.pacing, PACINGS, DEFAULT_STYLE.pacing),
    transition: pick(s.transition, TRANSITIONS, DEFAULT_STYLE.transition),
    subtitleStyle: pick(s.subtitleStyle, SUBTITLE_STYLES, DEFAULT_STYLE.subtitleStyle),
    colorFilter: pick(s.colorFilter, COLOR_FILTERS, DEFAULT_STYLE.colorFilter),
    accent: typeof s.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(s.accent) ? s.accent.toLowerCase() : DEFAULT_STYLE.accent,
    progressBar: s.progressBar ?? DEFAULT_STYLE.progressBar,
    sfx: s.sfx ?? DEFAULT_STYLE.sfx,
    transitionSound: pick(s.transitionSound, TRANSITION_SOUNDS, DEFAULT_STYLE.transitionSound),
    transitionSoundId: s.transitionSound === "asset" && typeof s.transitionSoundId === "string" && s.transitionSoundId ? s.transitionSoundId : null,
    logoId: typeof s.logoId === "string" && s.logoId ? s.logoId : null,
    cta: typeof s.cta === "string" ? s.cta.replace(/\s+/g, " ").trim().slice(0, MAX_CTA_CHARS) : "",
  };
}

/** Mẫu nhanh: đặt nhiều lựa chọn cùng lúc. */
export type Preset = {
  id: string;
  label: string;
  hint: string;
  layoutIndex: number;
  videoType: VideoType;
  length: VideoLength;
  tone: string;
  webMedia: "image" | "video" | "auto";
  clipsPerStep: number;
  voice: Pick<VoiceSettings, "rate" | "pitch">;
  style: Omit<VideoStyle, "logoId" | "cta" | "accent" | "transitionSound" | "transitionSoundId">;
};

export const PRESETS: Preset[] = [
  {
    id: "tiktok",
    label: "TikTok / Reels viral",
    hint: "9:16, nhịp nhanh, karaoke, nhiều clip",
    layoutIndex: 1,
    videoType: "tips",
    length: "short",
    tone: "trẻ trung, bắt trend, ngôn ngữ Gen Z",
    webMedia: "video",
    clipsPerStep: 4,
    voice: { rate: "+10%", pitch: "+6Hz" },
    style: { pacing: "fast", transition: "mix", subtitleStyle: "karaoke", colorFilter: "vivid", progressBar: true, sfx: true },
  },
  {
    id: "youtube",
    label: "YouTube hướng dẫn",
    hint: "16:9, rõ ràng, phụ đề khung",
    layoutIndex: 0,
    videoType: "howto",
    length: "medium",
    tone: "thân thiện, gần gũi như nói chuyện với bạn bè",
    webMedia: "video",
    clipsPerStep: 3,
    voice: { rate: "+0%", pitch: "+0Hz" },
    style: { pacing: "normal", transition: "slide", subtitleStyle: "box", colorFilter: "none", progressBar: false, sfx: false },
  },
  {
    id: "promo",
    label: "Quảng cáo sản phẩm",
    hint: "Sôi nổi, lời kêu gọi cuối video",
    layoutIndex: 1,
    videoType: "promo",
    length: "short",
    tone: "thuyết phục, kêu gọi mua hàng",
    webMedia: "video",
    clipsPerStep: 3,
    voice: { rate: "+20%", pitch: "+6Hz" },
    style: { pacing: "fast", transition: "whip", subtitleStyle: "karaoke", colorFilter: "vivid", progressBar: true, sfx: true },
  },
  {
    id: "story",
    label: "Kể chuyện thư giãn",
    hint: "Chậm rãi, màu điện ảnh",
    layoutIndex: 0,
    videoType: "story",
    length: "medium",
    tone: "kể chuyện lôi cuốn, giàu cảm xúc",
    webMedia: "video",
    clipsPerStep: 2,
    voice: { rate: "-10%", pitch: "-6Hz" },
    style: { pacing: "slow", transition: "fade", subtitleStyle: "outline", colorFilter: "cinematic", progressBar: false, sfx: false },
  },
  {
    id: "facts",
    label: "Kiến thức / sự thật",
    hint: "Vuông 1:1, zoom xuyên cảnh",
    layoutIndex: 2,
    videoType: "facts",
    length: "short",
    tone: "",
    webMedia: "auto",
    clipsPerStep: 3,
    voice: { rate: "+10%", pitch: "-6Hz" },
    style: { pacing: "normal", transition: "zoom", subtitleStyle: "outline", colorFilter: "cool", progressBar: true, sfx: true },
  },
];
