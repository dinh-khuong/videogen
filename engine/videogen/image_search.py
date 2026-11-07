"""Tìm, tải và kiểm tra ảnh minh họa.

Nguồn ảnh (dùng theo thứ tự IMAGE_PROVIDERS, bỏ qua nguồn chưa có key):
- duckduckgo: DuckDuckGo Images, không cần key (endpoint không chính thức)
- google: Google Custom Search JSON API (GOOGLE_API_KEY + GOOGLE_CSE_ID)
- serper: Google Images qua Serper.dev (SERPER_API_KEY)
- brave: Brave Search Images API (BRAVE_API_KEY)
- pexels: kho ảnh Pexels, được dùng thương mại (PEXELS_API_KEY)
- pixabay: kho ảnh Pixabay, được dùng thương mại (PIXABAY_API_KEY)

Mỗi job có thể chọn một công cụ ưu tiên (Options.search_engine): công cụ đó được gọi trước,
các nguồn còn lại làm dự phòng khi nó lỗi hoặc không có kết quả.
"""
import io
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

import requests
from PIL import Image, ImageOps

from videogen_core.config import ConfigError, Settings

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    )
}
MIN_WIDTH, MIN_HEIGHT = 480, 320
MAX_SIDE = 2400
TARGET_RATIO = {"landscape": 16 / 9, "portrait": 9 / 16, "square": 1.0}
DDG_LAYOUT = {"landscape": "Wide", "portrait": "Tall", "square": "Square"}

# Kho ảnh trả phí: ảnh xem trước thường có watermark
WATERMARK_DOMAINS = (
    "istockphoto.com", "gettyimages.", "shutterstock.com", "dreamstime.com", "alamy.com",
    "depositphotos.com", "123rf.com", "freepik.com", "ftcdn.net", "stock.adobe.com",
    "vectorstock.com", "canstockphoto.", "bigstockphoto.com", "pond5.com", "agefotostock.com",
    "vecteezy.com", "colourbox.com", "stocksy.com",
)


def _is_watermarked(url: str) -> bool:
    host = urlparse(url).netloc.lower()
    return any(d in host for d in WATERMARK_DOMAINS)


class ProviderUnavailable(RuntimeError):
    """Nguồn ảnh không dùng được trong lượt chạy này (bị chặn/giới hạn)."""


@dataclass
class Credit:
    source: str
    url: str
    author: str = ""
    license: str = ""  # giấy phép (vd "CC BY 4.0") khi nguồn yêu cầu ghi công

    def attribution(self) -> str:
        parts = [self.source, self.author, self.license]
        return f"{' — '.join(p for p in parts if p)}: {self.url}"


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


DDG_MIN_INTERVAL = 2.0  # giây giữa các lần tìm, tránh bị DuckDuckGo giới hạn tốc độ
DDG_RETRIES = 3
_ddg_lock = threading.Lock()
_ddg_last_call = 0.0


def _ddg_throttle() -> None:
    """Tuần tự hóa và giãn cách các lần gọi DuckDuckGo giữa các luồng."""
    global _ddg_last_call
    with _ddg_lock:
        wait = _ddg_last_call + DDG_MIN_INTERVAL - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _ddg_last_call = time.monotonic()


def _search_duckduckgo(query: str, orientation: str, settings: Settings) -> list[Candidate]:
    session = requests.Session()
    session.headers.update({**HEADERS, "Accept-Language": "en-US,en;q=0.5"})
    # Thứ tự bộ lọc: thời gian, kích thước, màu, loại ảnh, bố cục, giấy phép
    filters = ["", "size:Large", "", "type:photo", f"layout:{DDG_LAYOUT[orientation]}", ""]
    if settings.ddg_license:
        filters[5] = f"license:{settings.ddg_license}"

    for attempt in range(DDG_RETRIES):
        _ddg_throttle()
        # DuckDuckGo cần token vqd lấy từ trang kết quả trước khi gọi i.js
        page = session.get(
            "https://duckduckgo.com/", params={"q": query, "iax": "images", "ia": "images"}, timeout=20
        )
        match = re.search(r"vqd=[\"']?([\d-]+)", page.text)
        if page.ok and match:
            resp = session.get(
                "https://duckduckgo.com/i.js",
                params={
                    "o": "json", "q": query, "l": settings.ddg_region, "vqd": match.group(1),
                    "p": "1", "f": ",".join(filters),
                },
                headers={"Referer": "https://duckduckgo.com/"},
                timeout=20,
            )
            # 202/403/429 = bị giới hạn tốc độ (202 trả về kết quả rỗng)
            if resp.status_code not in (202, 403, 429):
                resp.raise_for_status()
                items = resp.json().get("results", [])
                return _rank(
                    [
                        Candidate(
                            image_url=it["image"],
                            width=it.get("width", 0),
                            height=it.get("height", 0),
                            credit=Credit(source=urlparse(it.get("url", "")).netloc, url=it.get("url", it["image"])),
                        )
                        for it in items
                        if it.get("image")
                    ],
                    orientation,
                )
        if attempt < DDG_RETRIES - 1:
            time.sleep(5 * 2**attempt)
    raise ProviderUnavailable("DuckDuckGo đang giới hạn tốc độ, thử lại sau ít phút")


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


def _search_brave(query: str, orientation: str, settings: Settings) -> list[Candidate]:
    params = {"q": query[:400], "count": 50, "safesearch": "strict", "spellcheck": 0}
    if settings.brave_country:
        params["country"] = settings.brave_country
    resp = _request(
        "GET",
        "https://api.search.brave.com/res/v1/images/search",
        headers={"Accept": "application/json", "X-Subscription-Token": settings.brave_api_key},
        params=params,
    )
    results = []
    for it in resp.json().get("results", []):
        props = it.get("properties") or {}
        image_url = props.get("url")
        if not image_url:
            continue
        page_url = it.get("url") or image_url
        results.append(
            Candidate(
                image_url=image_url,
                width=int(props.get("width") or 0),
                height=int(props.get("height") or 0),
                credit=Credit(source=it.get("source") or urlparse(page_url).netloc, url=page_url),
            )
        )
    # Brave thường không trả kích thước: giữ thứ tự liên quan của Brave cho các ảnh đó
    return _rank(results, orientation) if any(c.width for c in results) else results


PIXABAY_ORIENTATION = {"landscape": "horizontal", "portrait": "vertical", "square": "all"}


def _search_pixabay(query: str, orientation: str, settings: Settings) -> list[Candidate]:
    resp = _request(
        "GET",
        "https://pixabay.com/api/",
        params={
            "key": settings.pixabay_api_key, "q": query[:100], "image_type": "photo",
            "orientation": PIXABAY_ORIENTATION[orientation], "per_page": 20, "safesearch": "true",
        },
    )
    return [
        Candidate(
            image_url=h["largeImageURL"],
            width=h.get("imageWidth", 0),
            height=h.get("imageHeight", 0),
            credit=Credit(source="Pixabay", url=h.get("pageURL", ""), author=h.get("user", ""),
                          license="Pixabay Content License"),
        )
        for h in resp.json().get("hits", [])
        if h.get("largeImageURL")
    ]


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
    "duckduckgo": (_search_duckduckgo, lambda s: True),
    "google": (_search_google, lambda s: bool(s.google_api_key and s.google_cse_id)),
    "serper": (_search_serper, lambda s: bool(s.serper_api_key)),
    "brave": (_search_brave, lambda s: bool(s.brave_api_key)),
    "pexels": (_search_pexels, lambda s: bool(s.pexels_api_key)),
    "pixabay": (_search_pixabay, lambda s: bool(s.pixabay_api_key)),
}
# Giá trị hợp lệ của Options.search_engine: "auto" = theo thứ tự IMAGE_PROVIDERS trong .env
SEARCH_ENGINES = ("auto", *PROVIDERS)


def engine_status(settings: Settings) -> dict[str, bool]:
    """Mọi công cụ tìm ảnh đã biết và đã dùng được chưa (có đủ key)."""
    return {name: bool(ready(settings)) for name, (_, ready) in PROVIDERS.items()}


def active_providers(settings: Settings, preferred: str | None = None) -> list[str]:
    """Thứ tự nguồn ảnh dùng được; công cụ ưu tiên (nếu có) đứng đầu, các nguồn khác làm dự phòng."""
    order = list(settings.image_providers)
    if preferred and preferred != "auto":
        if preferred not in PROVIDERS:
            raise ConfigError(f"Công cụ tìm ảnh không hợp lệ: {preferred}")
        if not PROVIDERS[preferred][1](settings):
            print(f"      ⚠️  Công cụ tìm ảnh '{preferred}' chưa có key trong .env, dùng nguồn khác.", flush=True)
        # công cụ đã chọn được dùng kể cả khi không nằm trong IMAGE_PROVIDERS
        order = [preferred, *(n for n in order if n != preferred)]
    names = [n for n in order if n in PROVIDERS and PROVIDERS[n][1](settings)]
    if not names:
        raise ConfigError(
            "Chưa có key nguồn ảnh nào. Điền GOOGLE_API_KEY + GOOGLE_CSE_ID, hoặc BRAVE_API_KEY, "
            "hoặc SERPER_API_KEY, hoặc PEXELS_API_KEY, hoặc PIXABAY_API_KEY trong .env."
        )
    return names


class ProviderPool:
    """Gọi các nguồn ảnh theo thứ tự; nguồn nào bị từ chối quyền (401/403) thì bỏ qua cho các lần sau."""

    def __init__(self, settings: Settings, preferred: str | None = None) -> None:
        self.settings = settings
        self.names = active_providers(settings, preferred)
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
            except ProviderUnavailable as e:
                with self._lock:
                    if name not in self._disabled:
                        self._disabled.add(name)
                        print(f"      ⚠️  Tạm bỏ nguồn ảnh '{name}': {e}")
                continue
            except (requests.RequestException, ValueError) as e:
                print(f"      ⚠️  Nguồn ảnh '{name}' lỗi cho '{query}': {type(e).__name__}: {e}")
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
            if _is_watermarked(cand.image_url) or not registry.claim(cand.image_url):
                continue
            if download_valid_image(cand.image_url, dest_path):
                return cand.credit
    return None
