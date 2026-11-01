"""Cấu hình chung: đọc API key và thiết lập từ biến môi trường (.env)."""
import os

from dotenv import load_dotenv

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
        self.ddg_region = _get("DDG_REGION", "wt-wt")
        self.ddg_license = _get("DDG_LICENSE")

        self.tts_voice = _get("TTS_VOICE", "vi-VN-HoaiMyNeural")
        self.tts_rate = _get("TTS_RATE", "+0%")

        self.font_path = _get("FONT_PATH")


def load_settings() -> Settings:
    return Settings()
