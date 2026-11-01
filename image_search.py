"""Tìm, tải và kiểm tra ảnh minh họa qua Pexels API (ảnh miễn phí, được dùng thương mại)."""
import io
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import requests
from PIL import Image, ImageOps

from config import Settings, require

SEARCH_URL = "https://api.pexels.com/v1/search"
MIN_WIDTH, MIN_HEIGHT = 480, 320
MAX_SIDE = 2400


@dataclass
class Credit:
    photographer: str
    photographer_url: str
    photo_url: str


class UrlRegistry:
    """Tránh dùng trùng một ảnh cho nhiều bước (an toàn khi chạy đa luồng)."""

    def __init__(self) -> None:
        self._urls: set[str] = set()
        self._lock = threading.Lock()

    def claim(self, url: str) -> bool:
        with self._lock:
            if url in self._urls:
                return False
            self._urls.add(url)
            return True


def search_photos(query: str, orientation: str, settings: Settings) -> list[dict]:
    headers = {"Authorization": require("PEXELS_API_KEY", settings.pexels_api_key)}
    params = {"query": query, "orientation": orientation, "per_page": 15}
    for attempt in range(3):
        try:
            resp = requests.get(SEARCH_URL, headers=headers, params=params, timeout=20)
        except (requests.ConnectionError, requests.Timeout):
            if attempt == 2:
                raise
            time.sleep(2**attempt)
            continue
        if resp.status_code in (429, 500, 502, 503) and attempt < 2:
            time.sleep(2**attempt)
            continue
        resp.raise_for_status()
        return resp.json().get("photos", [])
    return []


def download_valid_image(url: str, dest_path: Path) -> bool:
    """Tải ảnh, kiểm tra đúng là ảnh hợp lệ & đủ lớn, chuẩn hóa về JPEG RGB."""
    try:
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        img = Image.open(io.BytesIO(resp.content))
        img.load()
    except Exception:
        return False

    img = ImageOps.exif_transpose(img)
    if img.width < MIN_WIDTH or img.height < MIN_HEIGHT:
        return False
    img = img.convert("RGB")
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    img.save(dest_path, "JPEG", quality=92)
    return True


def fetch_image(
    queries: list[str], dest_path: Path, orientation: str, settings: Settings, registry: UrlRegistry
) -> Credit | None:
    """Thử lần lượt các query, tải ảnh hợp lệ đầu tiên vào dest_path và trả về thông tin tác giả."""
    for query in queries:
        try:
            photos = search_photos(query, orientation, settings)
        except requests.HTTPError as e:
            print(f"      ⚠️  Pexels lỗi cho '{query}': {e}")
            continue
        for photo in photos:
            src = photo.get("src", {})
            link = src.get("large2x") or src.get("original")
            if not link or not registry.claim(link):
                continue
            if download_valid_image(link, dest_path):
                return Credit(
                    photographer=photo.get("photographer", ""),
                    photographer_url=photo.get("photographer_url", ""),
                    photo_url=photo.get("url", ""),
                )
    return None
