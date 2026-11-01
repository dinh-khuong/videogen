"""Tìm, tải và kiểm tra ảnh minh họa qua Google Custom Search JSON API."""
import io
import threading
import time
from pathlib import Path

import requests
from PIL import Image, ImageOps

from config import Settings, require

SEARCH_URL = "https://www.googleapis.com/customsearch/v1"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    )
}
MIN_WIDTH, MIN_HEIGHT = 480, 320
MAX_SIDE = 2400


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


def _get_with_retry(url: str, retries: int = 3, **kwargs) -> requests.Response:
    for attempt in range(retries):
        try:
            resp = requests.get(url, timeout=20, **kwargs)
            if resp.status_code in (429, 500, 502, 503) and attempt < retries - 1:
                time.sleep(2**attempt)
                continue
            resp.raise_for_status()
            return resp
        except (requests.ConnectionError, requests.Timeout):
            if attempt == retries - 1:
                raise
            time.sleep(2**attempt)
    raise RuntimeError("unreachable")


def search_images(query: str, settings: Settings) -> list[dict]:
    params = {
        "key": require("GOOGLE_API_KEY", settings.google_api_key),
        "cx": require("GOOGLE_CSE_ID", settings.google_cse_id),
        "q": query,
        "searchType": "image",
        "num": 10,
        "safe": "active",
        "imgSize": "large",
        "imgType": "photo",
    }
    resp = _get_with_retry(SEARCH_URL, params=params)
    items = resp.json().get("items", [])
    # Ưu tiên ảnh ngang, độ phân giải lớn
    def score(item: dict) -> float:
        img = item.get("image", {})
        w, h = img.get("width", 0), img.get("height", 0)
        landscape_bonus = 1.2 if w >= h else 1.0
        return w * h * landscape_bonus

    return sorted(items, key=score, reverse=True)


def download_valid_image(url: str, dest_path: Path) -> bool:
    """Tải ảnh, kiểm tra đúng là ảnh hợp lệ & đủ lớn, chuẩn hóa về JPEG RGB."""
    try:
        resp = requests.get(url, headers=HEADERS, timeout=20)
        resp.raise_for_status()
        img = Image.open(io.BytesIO(resp.content))
        img.load()
    except Exception:
        return False

    img = ImageOps.exif_transpose(img)
    if img.width < MIN_WIDTH or img.height < MIN_HEIGHT:
        return False
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        background = Image.new("RGB", img.size, (255, 255, 255))
        background.paste(img, mask=img.split()[-1])
        img = background
    img = img.convert("RGB")
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    img.save(dest_path, "JPEG", quality=92)
    return True


def fetch_image(
    queries: list[str], dest_path: Path, settings: Settings, registry: UrlRegistry
) -> bool:
    """Thử lần lượt các query, trả về True nếu tải được ảnh hợp lệ vào dest_path."""
    for query in queries:
        try:
            items = search_images(query, settings)
        except requests.HTTPError as e:
            print(f"      ⚠️  Google Search lỗi cho '{query}': {e}")
            continue
        for item in items:
            link = item.get("link")
            if not link or not registry.claim(link):
                continue
            if download_valid_image(link, dest_path):
                return True
    return False
