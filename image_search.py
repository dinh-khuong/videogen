"""Tìm, tải và kiểm tra ảnh minh họa.

Nguồn ảnh (dùng nguồn đầu tiên có key, theo thứ tự IMAGE_PROVIDERS):
- google: Google Custom Search JSON API (GOOGLE_API_KEY + GOOGLE_CSE_ID)
- serper: Google Images qua Serper.dev (SERPER_API_KEY)
- pexels: kho ảnh Pexels, được dùng thương mại (PEXELS_API_KEY)
"""
import io
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import requests
from PIL import Image, ImageOps

from config import ConfigError, Settings

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    )
}
MIN_WIDTH, MIN_HEIGHT = 480, 320
MAX_SIDE = 2400
TARGET_RATIO = {"landscape": 16 / 9, "portrait": 9 / 16, "square": 1.0}


@dataclass
class Credit:
    source: str
    url: str


@dataclass
class Candidate:
    image_url: str
    width: int
    height: int
    credit: Credit


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


def _request(method: str, url: str, retries: int = 3, **kwargs) -> requests.Response:
    for attempt in range(retries):
        try:
            resp = requests.request(method, url, timeout=20, **kwargs)
        except (requests.ConnectionError, requests.Timeout):
            if attempt == retries - 1:
                raise
            time.sleep(2**attempt)
            continue
        if resp.status_code in (429, 500, 502, 503) and attempt < retries - 1:
            time.sleep(2**attempt)
            continue
        resp.raise_for_status()
        return resp
    raise RuntimeError("unreachable")


def _rank(candidates: list[Candidate], orientation: str) -> list[Candidate]:
    """Ưu tiên ảnh lớn và có tỉ lệ gần với khung video."""
    target = TARGET_RATIO[orientation]

    def score(c: Candidate) -> float:
        if not c.width or not c.height:
            return 0.0
        ratio_penalty = abs((c.width / c.height) - target) / target
        return c.width * c.height / (1 + 2 * ratio_penalty)

    return sorted(candidates, key=score, reverse=True)


def _search_google(query: str, orientation: str, settings: Settings) -> list[Candidate]:
    params = {
        "key": settings.google_api_key,
        "cx": settings.google_cse_id,
        "q": query,
        "searchType": "image",
        "num": 10,
        "safe": "active",
        "imgSize": "large",
        "imgType": "photo",
    }
    items = _request("GET", "https://www.googleapis.com/customsearch/v1", params=params).json().get("items", [])
    return _rank(
        [
            Candidate(
                image_url=it["link"],
                width=it.get("image", {}).get("width", 0),
                height=it.get("image", {}).get("height", 0),
                credit=Credit(source=it.get("displayLink", ""), url=it.get("image", {}).get("contextLink", it["link"])),
            )
            for it in items
            if it.get("link")
        ],
        orientation,
    )


def _search_serper(query: str, orientation: str, settings: Settings) -> list[Candidate]:
    resp = _request(
        "POST",
        "https://google.serper.dev/images",
        headers={"X-API-KEY": settings.serper_api_key, "Content-Type": "application/json"},
        json={"q": query, "num": 20},
    )
    return _rank(
        [
            Candidate(
                image_url=it["imageUrl"],
                width=it.get("imageWidth", 0),
                height=it.get("imageHeight", 0),
                credit=Credit(source=it.get("domain") or it.get("source", ""), url=it.get("link", it["imageUrl"])),
            )
            for it in resp.json().get("images", [])
            if it.get("imageUrl")
        ],
        orientation,
    )


def _search_pexels(query: str, orientation: str, settings: Settings) -> list[Candidate]:
    resp = _request(
        "GET",
        "https://api.pexels.com/v1/search",
        headers={"Authorization": settings.pexels_api_key},
        params={"query": query, "orientation": orientation, "per_page": 15},
    )
    return [
        Candidate(
            image_url=p["src"].get("large2x") or p["src"]["original"],
            width=p.get("width", 0),
            height=p.get("height", 0),
            credit=Credit(source=f"Pexels / {p.get('photographer', '')}", url=p.get("url", "")),
        )
        for p in resp.json().get("photos", [])
        if p.get("src")
    ]


PROVIDERS = {
    "google": (_search_google, lambda s: bool(s.google_api_key and s.google_cse_id)),
    "serper": (_search_serper, lambda s: bool(s.serper_api_key)),
    "pexels": (_search_pexels, lambda s: bool(s.pexels_api_key)),
}


def active_providers(settings: Settings) -> list[str]:
    names = [n for n in settings.image_providers if n in PROVIDERS and PROVIDERS[n][1](settings)]
    if not names:
        raise ConfigError(
            "Chưa có key nguồn ảnh nào. Điền GOOGLE_API_KEY + GOOGLE_CSE_ID, "
            "hoặc SERPER_API_KEY, hoặc PEXELS_API_KEY trong .env."
        )
    return names


class ProviderPool:
    """Gọi các nguồn ảnh theo thứ tự; nguồn nào bị từ chối quyền (401/403) thì bỏ qua cho các lần sau."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.names = active_providers(settings)
        self._disabled: set[str] = set()
        self._lock = threading.Lock()

    def search(self, query: str, orientation: str) -> list[Candidate]:
        for name in self.names:
            if name in self._disabled:
                continue
            try:
                results = PROVIDERS[name][0](query, orientation, self.settings)
            except requests.HTTPError as e:
                status = e.response.status_code if e.response is not None else None
                if status in (400, 401, 403):
                    with self._lock:
                        if name not in self._disabled:
                            self._disabled.add(name)
                            print(f"      ⚠️  Nguồn ảnh '{name}' bị từ chối ({status}), chuyển nguồn khác. "
                                  f"Chi tiết: {e.response.text[:200] if e.response is not None else e}")
                else:
                    print(f"      ⚠️  Nguồn ảnh '{name}' lỗi cho '{query}': {e}")
                continue
            if results:
                return results
        return []


def download_valid_image(url: str, dest_path: Path) -> bool:
    """Tải ảnh, kiểm tra đúng là ảnh hợp lệ & đủ lớn, chuẩn hóa về JPEG RGB."""
    try:
        resp = requests.get(url, headers=HEADERS, timeout=30)
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
    queries: list[str], dest_path: Path, orientation: str, pool: ProviderPool, registry: UrlRegistry
) -> Credit | None:
    """Thử lần lượt các query, tải ảnh hợp lệ đầu tiên vào dest_path và trả về nguồn ảnh."""
    for query in queries:
        for cand in pool.search(query, orientation):
            if not registry.claim(cand.image_url):
                continue
            if download_valid_image(cand.image_url, dest_path):
                return cand.credit
    return None
