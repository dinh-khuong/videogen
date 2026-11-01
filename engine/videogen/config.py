"""Cấu hình chung: đọc API key và thiết lập từ biến môi trường (.env)."""
import os
from pathlib import Path

from dotenv import load_dotenv

ENGINE_DIR = Path(__file__).resolve().parent.parent

# engine/.env là nơi chính; .env ở thư mục đang chạy (nếu có) bổ sung. Biến môi trường thật luôn được ưu tiên.
load_dotenv(ENGINE_DIR / ".env")
load_dotenv()


class ConfigError(RuntimeError):
    pass


def _get(name: str, default: str | None = None) -> str | None:
    value = os.getenv(name, default)
    if not value or value.startswith("your_"):
        return default
    return value


def require(name: str, value: str | None) -> str:
    if not value:
        raise ConfigError(
            f"Thiếu biến môi trường {name}. Hãy tạo file .env (xem .env.example) và điền giá trị thật."
        )
    return value


class Settings:
    def __init__(self) -> None:
        self.deepseek_api_key = _get("DEEPSEEK_API_KEY")
        self.deepseek_base_url = _get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
        self.deepseek_model = _get("DEEPSEEK_MODEL", "deepseek-chat")

        self.google_api_key = _get("GOOGLE_API_KEY")
        self.google_cse_id = _get("GOOGLE_CSE_ID")
        self.serper_api_key = _get("SERPER_API_KEY")
        self.pexels_api_key = _get("PEXELS_API_KEY")
        self.image_providers = [
            p.strip().lower()
            for p in _get("IMAGE_PROVIDERS", "duckduckgo,google,serper,pexels").split(",")
            if p.strip()
        ]
        self.pixabay_api_key = _get("PIXABAY_API_KEY")
        # YouTube Data API v3 (bật API trong Google Cloud); không có thì dùng GOOGLE_API_KEY
        self.youtube_api_key = _get("YOUTUBE_API_KEY") or self.google_api_key
        # Nguồn clip video trên mạng, chỉ lấy video được phép dùng lại (stock / Creative Commons)
        self.video_providers = [
            p.strip().lower()
            for p in _get("VIDEO_PROVIDERS", "pexels,pixabay,wikimedia,youtube").split(",")
            if p.strip()
        ]
        self.web_clip_seconds = float(_get("WEB_CLIP_SECONDS", "15"))
        # URL hoặc email liên hệ gửi kèm User-Agent khi tải từ Wikimedia (khuyến nghị theo chính sách của Wikimedia)
        self.wikimedia_contact = _get("WIKIMEDIA_CONTACT")
        self.ddg_region = _get("DDG_REGION", "wt-wt")
        self.ddg_license = _get("DDG_LICENSE")

        self.tts_voice = _get("TTS_VOICE", "vi-VN-HoaiMyNeural")
        self.tts_rate = _get("TTS_RATE", "+0%")

        self.font_path = _get("FONT_PATH")

        # Phân tích asset: OCR bằng Tesseract (local) + tóm tắt bằng DeepSeek
        self.tesseract_cmd = _get("TESSERACT_CMD", "tesseract")
        self.ocr_langs = _get("OCR_LANGS", "vie+eng")
        # Mô hình thị giác (tùy chọn, API kiểu OpenAI: Gemini, OpenAI, Ollama...) để mô tả nội dung hình ảnh
        self.vision_api_key = _get("VISION_API_KEY")
        self.vision_base_url = _get("VISION_BASE_URL")
        self.vision_model = _get("VISION_MODEL")

    @property
    def vision_enabled(self) -> bool:
        return bool(self.vision_model and (self.vision_api_key or self.vision_base_url))


def load_settings() -> Settings:
    return Settings()
