// Các dịch vụ cần token/API key (dùng chung giữa client và server). `env` là tên biến môi trường engine đọc
// (xem engine/videogen/config.py): token đang dùng của dịch vụ được truyền cho engine qua biến đó.

export const TOKEN_GROUPS = {
  ai: "AI viết kịch bản",
  voice: "Giọng đọc",
  media: "Tìm ảnh & clip",
  other: "Khác",
} as const;
export type TokenGroup = keyof typeof TOKEN_GROUPS;

/** Thiết lập đi kèm token (chọn model, địa chỉ API...): lưu cùng token và truyền cho engine qua biến `env` khi token đang dùng. */
export type TokenOptionMeta = {
  key: string;
  label: string;
  env: string;
  /** model: tên model (có thể tải danh sách từ dịch vụ); url: địa chỉ API kiểu OpenAI */
  kind: "model" | "url";
  placeholder?: string;
  hint?: string;
  /** gợi ý chọn nhanh */
  suggestions?: readonly string[];
};

export type TokenProviderMeta = {
  label: string;
  env: string;
  group: TokenGroup;
  hint: string;
  /** trang lấy token */
  link: string;
  /** dịch vụ bắt buộc phải có để tạo video */
  required?: boolean;
  /** false = giá trị không phải bí mật (vd ID công cụ tìm kiếm): hiện đầy đủ thay vì che */
  secret?: boolean;
  /** có kiểm tra token được bằng một lời gọi thử */
  testable?: boolean;
  /** thiết lập đi kèm (model...); chỉ dịch vụ AI có */
  options?: readonly TokenOptionMeta[];
};

export const TOKEN_PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    env: "DEEPSEEK_API_KEY",
    group: "ai",
    hint: "Viết kịch bản, Đạo diễn AI, tóm tắt asset. Bắt buộc để tạo video.",
    link: "https://platform.deepseek.com/api_keys",
    required: true,
    testable: true,
    options: [
      {
        key: "model",
        label: "Model viết kịch bản",
        env: "DEEPSEEK_MODEL",
        kind: "model",
        placeholder: "deepseek-chat",
        hint: "Viết kịch bản, tiêu đề, hashtag và tóm tắt asset. Bỏ trống: dùng deepseek-chat (hoặc DEEPSEEK_MODEL trong engine/.env).",
        suggestions: ["deepseek-chat", "deepseek-reasoner"],
      },
      {
        key: "director_model",
        label: "Model Đạo diễn AI",
        env: "DIRECTOR_MODEL",
        kind: "model",
        placeholder: "Giống model viết kịch bản",
        hint: "Đạo diễn AI gọi công cụ liên tục nên model phải hỗ trợ function calling (deepseek-reasoner thường không). Bỏ trống: dùng model ở trên.",
        suggestions: ["deepseek-chat"],
      },
      {
        key: "base_url",
        label: "Địa chỉ API (tùy chọn)",
        env: "DEEPSEEK_BASE_URL",
        kind: "url",
        placeholder: "https://api.deepseek.com",
        hint: "Chỉ đổi khi dùng dịch vụ khác tương thích OpenAI. Bỏ trống: dùng DeepSeek.",
        suggestions: ["https://api.deepseek.com"],
      },
    ],
  },
  vision: {
    label: "Mô hình thị giác",
    env: "VISION_API_KEY",
    group: "ai",
    hint: "Gemini, OpenAI, Ollama... để mô tả ảnh không có chữ. Cần chọn model và địa chỉ API bên dưới thì mới được bật.",
    link: "https://aistudio.google.com/apikey",
    testable: true,
    options: [
      {
        key: "model",
        label: "Model thị giác",
        env: "VISION_MODEL",
        kind: "model",
        placeholder: "gemini-2.5-flash",
        hint: "Model nhìn được ảnh. Bấm \"Tải danh sách model\" để lấy các model có trên dịch vụ.",
        suggestions: ["gemini-2.5-flash", "gpt-4o-mini", "qwen2.5vl"],
      },
      {
        key: "base_url",
        label: "Địa chỉ API",
        env: "VISION_BASE_URL",
        kind: "url",
        placeholder: "https://generativelanguage.googleapis.com/v1beta/openai/",
        hint: "Địa chỉ API kiểu OpenAI của dịch vụ: Gemini, OpenAI hoặc Ollama trên máy.",
        suggestions: [
          "https://generativelanguage.googleapis.com/v1beta/openai/",
          "https://api.openai.com/v1",
          "http://localhost:11434/v1",
        ],
      },
    ],
  },
  fpt: {
    label: "FPT.AI",
    env: "FPT_AI_API_KEY",
    group: "voice",
    hint: "Giọng đọc tiếng Việt tự nhiên (giọng fpt:...). Kiểm tra token sẽ đọc thử vài ký tự.",
    link: "https://console.fpt.ai",
    testable: true,
  },
  pexels: {
    label: "Pexels",
    env: "PEXELS_API_KEY",
    group: "media",
    hint: "Ảnh và clip stock dùng được cho quảng cáo. Miễn phí.",
    link: "https://www.pexels.com/api/",
    testable: true,
  },
  pixabay: {
    label: "Pixabay",
    env: "PIXABAY_API_KEY",
    group: "media",
    hint: "Ảnh và clip stock dùng được cho quảng cáo. Miễn phí.",
    link: "https://pixabay.com/api/docs/",
    testable: true,
  },
  brave: {
    label: "Brave Search",
    env: "BRAVE_API_KEY",
    group: "media",
    hint: "Tìm ảnh bằng Brave Search (có gói miễn phí).",
    link: "https://api-dashboard.search.brave.com",
    testable: true,
  },
  serper: {
    label: "Serper.dev",
    env: "SERPER_API_KEY",
    group: "media",
    hint: "Kết quả Google Images qua API.",
    link: "https://serper.dev",
    testable: true,
  },
  google: {
    label: "Google API key",
    env: "GOOGLE_API_KEY",
    group: "media",
    hint: "Google Custom Search (cần thêm CSE ID bên dưới); cũng dùng cho YouTube khi chưa có key YouTube riêng.",
    link: "https://console.cloud.google.com/apis/credentials",
    testable: true,
  },
  google_cse: {
    label: "Google CSE ID",
    env: "GOOGLE_CSE_ID",
    group: "media",
    hint: "ID công cụ tìm kiếm tùy chỉnh đi kèm Google API key.",
    link: "https://programmablesearchengine.google.com",
    secret: false,
  },
  youtube: {
    label: "YouTube Data API",
    env: "YOUTUBE_API_KEY",
    group: "media",
    hint: "Tìm clip YouTube Creative Commons. Cần bật YouTube Data API v3 cho key.",
    link: "https://console.cloud.google.com/apis/library/youtube.googleapis.com",
    testable: true,
  },
} as const satisfies Record<string, TokenProviderMeta>;

export type TokenProvider = keyof typeof TOKEN_PROVIDERS;

export function isTokenProvider(value: unknown): value is TokenProvider {
  return typeof value === "string" && Object.hasOwn(TOKEN_PROVIDERS, value);
}

/** Thông tin dịch vụ với các trường tùy chọn đã có giá trị mặc định (dạng dùng chung, không bị thu hẹp theo từng khóa). */
export function providerMeta(provider: TokenProvider): TokenProviderMeta {
  return TOKEN_PROVIDERS[provider];
}

/** Giá trị che bớt để hiển thị: giữ vài ký tự đầu/cuối để nhận ra token nào, không đủ để dùng lại. */
export function maskToken(value: string, secret = true): string {
  if (!secret) return value;
  return value.length <= 8 ? "••••••" : `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
