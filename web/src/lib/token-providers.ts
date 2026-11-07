// Các dịch vụ cần token/API key (dùng chung giữa client và server). `env` là tên biến môi trường engine đọc
// (xem engine/videogen_core/config.py): token đang dùng của dịch vụ được truyền cho engine qua biến đó.

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
  /** phải có thì mới lưu được token (vd model của dịch vụ không có model mặc định) */
  required?: boolean;
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
  /** các dịch vụ cùng `slot` dùng chung một vị trí trong engine (vd mọi AI viết kịch bản đều đi qua DEEPSEEK_*): cả nhóm chỉ có một token đang dùng */
  slot?: string;
  /** địa chỉ API mặc định của dịch vụ (kiểu OpenAI) */
  baseUrl?: string;
  /** true: mọi thiết lập của dịch vụ đều được đặt cho engine (rỗng nếu chưa chọn), để giá trị cũ của DeepSeek trong engine/.env không lẫn sang dịch vụ này */
  isolated?: boolean;
};

/** Thiết lập của một AI viết kịch bản kiểu OpenAI: model, model Đạo diễn AI, địa chỉ API (engine đọc qua DEEPSEEK_MODEL, DIRECTOR_MODEL, DEEPSEEK_BASE_URL). */
function llmOptions(o: { models: readonly string[]; baseUrl?: string }): readonly TokenOptionMeta[] {
  return [
    {
      key: "model",
      label: "Model viết kịch bản",
      env: "DEEPSEEK_MODEL",
      kind: "model",
      required: true,
      placeholder: o.models[0] ?? "Tên model trên dịch vụ",
      hint: "Viết kịch bản, tiêu đề, hashtag và tóm tắt asset. Bấm \"Tải danh sách model\" để xem các model có trên dịch vụ.",
      suggestions: o.models,
    },
    {
      key: "director_model",
      label: "Model Đạo diễn AI",
      env: "DIRECTOR_MODEL",
      kind: "model",
      placeholder: "Giống model viết kịch bản",
      hint: "Đạo diễn AI gọi công cụ liên tục nên model phải hỗ trợ function calling. Bỏ trống: dùng model ở trên.",
    },
    {
      key: "base_url",
      label: o.baseUrl ? "Địa chỉ API (tùy chọn)" : "Địa chỉ API",
      env: "DEEPSEEK_BASE_URL",
      kind: "url",
      required: !o.baseUrl,
      placeholder: o.baseUrl ?? "http://localhost:11434/v1",
      hint: o.baseUrl ? "Bỏ trống: dùng địa chỉ mặc định của dịch vụ." : "Địa chỉ API kiểu OpenAI của dịch vụ, vd Ollama hoặc LM Studio chạy trên máy.",
      suggestions: o.baseUrl ? [o.baseUrl] : ["http://localhost:11434/v1", "http://localhost:1234/v1"],
    },
  ];
}

export const TOKEN_PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    env: "DEEPSEEK_API_KEY",
    group: "ai",
    hint: "Viết kịch bản, Đạo diễn AI, tóm tắt asset. Bắt buộc để tạo video.",
    link: "https://platform.deepseek.com/api_keys",
    required: true,
    testable: true,
    slot: "llm",
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
  openai: {
    label: "OpenAI",
    env: "DEEPSEEK_API_KEY",
    group: "ai",
    hint: "Viết kịch bản, Đạo diễn AI, tóm tắt asset bằng model của OpenAI. Chỉ một AI viết kịch bản được dùng cùng lúc.",
    link: "https://platform.openai.com/api-keys",
    testable: true,
    slot: "llm",
    isolated: true,
    baseUrl: "https://api.openai.com/v1",
    options: llmOptions({ models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"], baseUrl: "https://api.openai.com/v1" }),
  },
  gemini: {
    label: "Google Gemini",
    env: "DEEPSEEK_API_KEY",
    group: "ai",
    hint: "Viết kịch bản, Đạo diễn AI, tóm tắt asset bằng Gemini (API kiểu OpenAI của Google). Chỉ một AI viết kịch bản được dùng cùng lúc.",
    link: "https://aistudio.google.com/apikey",
    testable: true,
    slot: "llm",
    isolated: true,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    options: llmOptions({
      models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"],
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    }),
  },
  openrouter: {
    label: "OpenRouter",
    env: "DEEPSEEK_API_KEY",
    group: "ai",
    hint: "Một key dùng được nhiều model của nhiều hãng (tên dạng hãng/model). Chỉ một AI viết kịch bản được dùng cùng lúc.",
    link: "https://openrouter.ai/keys",
    testable: true,
    slot: "llm",
    isolated: true,
    baseUrl: "https://openrouter.ai/api/v1",
    options: llmOptions({
      models: ["deepseek/deepseek-chat", "openai/gpt-4o-mini", "google/gemini-2.5-flash"],
      baseUrl: "https://openrouter.ai/api/v1",
    }),
  },
  groq: {
    label: "Groq",
    env: "DEEPSEEK_API_KEY",
    group: "ai",
    hint: "Model mở chạy rất nhanh (Llama...). Chỉ một AI viết kịch bản được dùng cùng lúc.",
    link: "https://console.groq.com/keys",
    testable: true,
    slot: "llm",
    isolated: true,
    baseUrl: "https://api.groq.com/openai/v1",
    options: llmOptions({ models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"], baseUrl: "https://api.groq.com/openai/v1" }),
  },
  custom_ai: {
    label: "AI khác (kiểu OpenAI)",
    env: "DEEPSEEK_API_KEY",
    group: "ai",
    hint: "Dịch vụ bất kỳ có API kiểu OpenAI: Ollama, LM Studio, vLLM, Together, Mistral... Cần địa chỉ API và model. Dịch vụ không đòi key (vd Ollama) thì nhập đại một chuỗi. Chỉ một AI viết kịch bản được dùng cùng lúc.",
    link: "https://github.com/ollama/ollama/blob/main/docs/openai.md",
    testable: true,
    slot: "llm",
    isolated: true,
    options: llmOptions({ models: [] }),
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
