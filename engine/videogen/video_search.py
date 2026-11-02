"""Tìm và tải clip video trên mạng để làm nội dung cho từng bước.

Chỉ lấy video được phép dùng lại, kèm thông tin ghi công (dùng theo thứ tự VIDEO_PROVIDERS):
- pexels: Pexels Videos, được dùng thương mại (PEXELS_API_KEY)
- pixabay: Pixabay Videos, được dùng thương mại (PIXABAY_API_KEY)
- wikimedia: Wikimedia Commons, giấy phép tự do (CC BY, CC BY-SA, public domain...), không cần key
- youtube: chỉ video giấy phép Creative Commons Attribution. Tìm bằng YouTube Data API (YOUTUBE_API_KEY hoặc
  GOOGLE_API_KEY, cần bật API) hoặc bộ lọc Creative Commons của trang tìm kiếm; tải bằng yt-dlp.
  YouTube có thể chặn tải (yêu cầu đăng nhập/xác minh) — khi đó nguồn này tự bỏ qua trong lượt chạy.

Mỗi clip chỉ lấy một đoạn ngắn (WEB_CLIP_SECONDS), tắt tiếng, thu nhỏ về tối đa 1280px.
"""
import re
import subprocess
import tempfile
import threading
from dataclasses import dataclass, field
from html import unescape
from pathlib import Path
from urllib.parse import quote_plus

import requests

from .config import Settings
from .image_search import TARGET_RATIO, Credit, ProviderUnavailable, UrlRegistry, _request
from .probe import ffmpeg_exe, video_info

MIN_SECONDS = 3.0
SHORT_SOURCE = 120.0  # clip gốc ngắn tải nhanh hơn và thường là b-roll đúng chủ đề
MAX_SIDE = 1280
MAX_DOWNLOAD_BYTES = 250e6  # bỏ qua file gốc lớn hơn (tải lâu)
YOUTUBE_CC_FILTER = "EgIwAQ%253D%253D"  # bộ lọc "Creative Commons" của trang kết quả YouTube


@dataclass
class VideoCandidate:
    url: str  # link tải trực tiếp, hoặc trang video (YouTube, tải bằng yt-dlp)
    width: int
    height: int
    duration: float
    credit: Credit
    provider: str
    headers: dict = field(default_factory=dict)


def _rank(candidates: list[VideoCandidate], orientation: str) -> list[VideoCandidate]:
    """Bỏ clip quá ngắn; ưu tiên tỉ lệ gần với khung video (giữ thứ tự liên quan của nguồn khi gần bằng)."""
    target = TARGET_RATIO[orientation]

    def penalty(item: tuple[int, VideoCandidate]) -> float:
        i, c = item
        ratio = abs((c.width / c.height) - target) / target if c.width and c.height else 1.0
        long = 0.5 if c.duration > SHORT_SOURCE else 0.0
        return ratio + long + i * 0.05

    usable = [c for c in candidates if not c.duration or c.duration >= MIN_SECONDS]
    return [c for _, c in sorted(enumerate(usable), key=penalty)]


def _search_pexels(query: str, orientation: str, settings: Settings) -> list[VideoCandidate]:
    resp = _request(
        "GET",
        "https://api.pexels.com/videos/search",
        headers={"Authorization": settings.pexels_api_key},
        params={"query": query, "orientation": orientation, "per_page": 10, "size": "medium"},
    )
    results = []
    for v in resp.json().get("videos", []):
        files = [f for f in v.get("video_files", []) if f.get("file_type") == "video/mp4" and f.get("height")]
        if not files:
            continue
        # File gần 720p nhất (đủ nét, tải nhanh)
        best = min(files, key=lambda f: abs(min(f["width"], f["height"]) - 720))
        results.append(
            VideoCandidate(
                url=best["link"], width=best["width"], height=best["height"], duration=float(v.get("duration") or 0),
                credit=Credit(source="Pexels", url=v.get("url", ""), author=v.get("user", {}).get("name", ""),
                              license="Pexels License"),
                provider="pexels",
            )
        )
    return _rank(results, orientation)


def _search_pixabay(query: str, orientation: str, settings: Settings) -> list[VideoCandidate]:
    resp = _request(
        "GET",
        "https://pixabay.com/api/videos/",
        params={"key": settings.pixabay_api_key, "q": query[:100], "per_page": 10, "safesearch": "true"},
    )
    results = []
    for v in resp.json().get("hits", []):
        variants = [x for x in (v.get("videos") or {}).values() if x.get("url")]
        if not variants:
            continue
        best = min(variants, key=lambda x: abs(min(x.get("width") or 0, x.get("height") or 0) - 720))
        results.append(
            VideoCandidate(
                url=best["url"], width=best.get("width") or 0, height=best.get("height") or 0,
                duration=float(v.get("duration") or 0),
                credit=Credit(source="Pixabay", url=v.get("pageURL", ""), author=v.get("user", ""),
                              license="Pixabay Content License"),
                provider="pixabay",
            )
        )
    return _rank(results, orientation)


def _strip_html(text: str) -> str:
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", "", text or ""))).strip()


def _wikimedia_ua(settings: Settings) -> str:
    """Wikimedia yêu cầu User-Agent có thông tin liên hệ (URL/email), thiếu sẽ bị giới hạn (429)."""
    contact = settings.wikimedia_contact or "self-hosted how-to video generator; https://www.mediawiki.org/wiki/API:Etiquette"
    return f"VideoGenStudio/1.0 ({contact}) python-requests/{requests.__version__}"


def _search_wikimedia(query: str, orientation: str, settings: Settings) -> list[VideoCandidate]:
    ua = _wikimedia_ua(settings)
    resp = _request(
        "GET",
        "https://commons.wikimedia.org/w/api.php",
        headers={"User-Agent": ua},
        params={
            "action": "query", "format": "json", "generator": "search", "gsrsearch": f"{query} filetype:video",
            "gsrnamespace": 6, "gsrlimit": 10, "prop": "videoinfo",
            "viprop": "url|size|mime|extmetadata|derivatives",
        },
    )
    pages = sorted(resp.json().get("query", {}).get("pages", {}).values(), key=lambda p: p.get("index", 0))
    results = []
    for page in pages:
        info = (page.get("videoinfo") or [{}])[0]
        # Bản chuyển mã có sẵn của Commons: chọn bản cao nhất không quá 720p
        derivs = [d for d in info.get("derivatives", []) if d.get("src") and d.get("height") and d["height"] <= 720]
        if not derivs:
            continue
        best = max(derivs, key=lambda d: d["height"])
        meta = info.get("extmetadata", {})
        license_name = _strip_html(meta.get("LicenseShortName", {}).get("value", ""))
        results.append(
            VideoCandidate(
                url=best["src"], width=best.get("width") or info.get("width") or 0, height=best["height"],
                duration=float(info.get("duration") or 0),
                credit=Credit(source="Wikimedia Commons", url=info.get("descriptionurl", ""),
                              author=_strip_html(meta.get("Artist", {}).get("value", "")).strip(" ;,")[:120], license=license_name),
                provider="wikimedia",
                headers={"User-Agent": ua},
            )
        )
    return _rank(results, orientation)


def _youtube_api_search(query: str, settings: Settings) -> list[dict]:
    resp = requests.get(
        "https://www.googleapis.com/youtube/v3/search",
        params={"part": "snippet", "type": "video", "videoLicense": "creativeCommon", "videoDuration": "medium",
                "q": query, "maxResults": 8, "safeSearch": "strict", "key": settings.youtube_api_key},
        timeout=20,
    )
    resp.raise_for_status()
    ids = [it["id"]["videoId"] for it in resp.json().get("items", [])]
    if not ids:
        return []
    # Kiểm tra lại giấy phép + lấy thời lượng
    details = _request(
        "GET", "https://www.googleapis.com/youtube/v3/videos",
        params={"part": "contentDetails,status,snippet", "id": ",".join(ids), "key": settings.youtube_api_key},
    ).json().get("items", [])
    out = []
    for d in details:
        if d.get("status", {}).get("license") != "creativeCommon":
            continue
        m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", d.get("contentDetails", {}).get("duration", ""))
        seconds = sum(int(x or 0) * k for x, k in zip(m.groups(), (3600, 60, 1))) if m else 0
        out.append({"id": d["id"], "title": d["snippet"].get("title", ""), "channel": d["snippet"].get("channelTitle", ""),
                    "duration": seconds})
    return out


def _youtube_page_search(query: str) -> list[dict]:
    import yt_dlp

    url = f"https://www.youtube.com/results?search_query={quote_plus(query)}&sp={YOUTUBE_CC_FILTER}"
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "extract_flat": True, "playlistend": 8,
                           "logger": _QuietLogger()}) as ydl:
        info = ydl.extract_info(url, download=False)
    return [
        {"id": e["id"], "title": e.get("title", ""), "channel": e.get("channel") or e.get("uploader") or "",
         "duration": e.get("duration") or 0}
        for e in info.get("entries") or []
        if e.get("id")
    ]


def _search_youtube(query: str, orientation: str, settings: Settings) -> list[VideoCandidate]:
    items: list[dict] | None = None
    if settings.youtube_api_key:
        try:
            items = _youtube_api_search(query, settings)
        except requests.HTTPError as e:
            # API chưa bật cho key này: dùng bộ lọc Creative Commons của trang tìm kiếm
            if e.response is None or e.response.status_code not in (400, 403):
                raise
    if items is None:
        items = _youtube_page_search(query)
    return [
        VideoCandidate(
            url=f"https://www.youtube.com/watch?v={it['id']}", width=1280, height=720, duration=float(it["duration"]),
            credit=Credit(source="YouTube", url=f"https://www.youtube.com/watch?v={it['id']}", author=it["channel"],
                          license="Creative Commons Attribution (CC BY)"),
            provider="youtube",
        )
        for it in items
        if not it["duration"] or 10 <= it["duration"] <= 1800
    ]


def _youtube_available(settings: Settings) -> bool:
    try:
        import yt_dlp  # noqa: F401
    except ImportError:
        return False
    return True


PROVIDERS = {
    "pexels": (_search_pexels, lambda s: bool(s.pexels_api_key)),
    "pixabay": (_search_pixabay, lambda s: bool(s.pixabay_api_key)),
    "wikimedia": (_search_wikimedia, lambda s: True),
    "youtube": (_search_youtube, _youtube_available),
}


def active_video_providers(settings: Settings) -> list[str]:
    return [n for n in settings.video_providers if n in PROVIDERS and PROVIDERS[n][1](settings)]


def _start_offset(duration: float, seconds: float) -> float:
    """Video dài thường có phần mở đầu (logo, giới thiệu): bỏ qua một đoạn."""
    if duration <= seconds * 1.5:
        return 0.0
    return min(duration * 0.15, 30.0, duration - seconds)


def _download_file(url: str, dest: Path, headers: dict | None = None) -> None:
    """Tải file về đĩa (không đọc URL trực tiếp bằng ffmpeg: bản ffmpeg tĩnh của imageio có thể crash với HTTPS)."""
    with requests.get(url, headers=headers or {}, stream=True, timeout=30) as resp:
        resp.raise_for_status()
        if int(resp.headers.get("Content-Length") or 0) > MAX_DOWNLOAD_BYTES:
            raise RuntimeError("file quá lớn")
        size = 0
        with open(dest, "wb") as f:
            for chunk in resp.iter_content(1 << 20):
                size += len(chunk)
                if size > MAX_DOWNLOAD_BYTES:
                    raise RuntimeError("file quá lớn")
                f.write(chunk)


def _transcode(src: str, dest: Path, start: float, seconds: float) -> None:
    """Cắt đoạn [start, start+seconds], tắt tiếng, thu nhỏ, mã hóa H.264."""
    scale = f"scale='if(gt(iw,ih),min({MAX_SIDE},iw),-2)':'if(gt(iw,ih),-2,min({MAX_SIDE},ih))'"
    cmd = [ffmpeg_exe(), "-v", "error", "-y"]
    cmd += ["-ss", f"{start:.2f}", "-i", src, "-t", f"{seconds:.2f}", "-an", "-vf", scale,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    tmp = dest.with_suffix(".part.mp4")
    subprocess.run(cmd + [str(tmp)], check=True, capture_output=True, timeout=300)
    tmp.replace(dest)


class _QuietLogger:
    """yt-dlp in lỗi ra stderr dù quiet; lỗi đã được xử lý ở nơi gọi nên bỏ qua."""

    def debug(self, msg: str) -> None:
        pass

    info = warning = error = debug


YT_FORMAT = "bv*/b"  # video (không cần tiếng); độ phân giải chọn bằng YT_SORT
# "res" là cạnh nhỏ nhất nên đúng cả với video dọc (Shorts 1080x1920). Không dùng [height<=720]:
# với video dọc mọi định dạng đều cao hơn 720 nên bộ lọc đó làm hỏng việc chọn định dạng.
YT_SORT = ["res:720", "vcodec:h264", "ext:mp4"]
YT_ERROR_PATTERN = r"Sign in|not a bot|429|Too Many Requests"


def _yt_dlp_module(url: str, tmp: Path, ranges: tuple[float, float] | None) -> str | None:
    """Tải bằng thư viện yt_dlp; trả về thông báo lỗi (None nếu tải được)."""
    import yt_dlp

    opts = {
        "quiet": True, "no_warnings": True, "noprogress": True, "noplaylist": True, "logger": _QuietLogger(),
        "format": YT_FORMAT, "format_sort": YT_SORT,
        "ffmpeg_location": ffmpeg_exe(),
        "outtmpl": str(tmp / "clip.%(ext)s"),
        "max_filesize": int(MAX_DOWNLOAD_BYTES),
        "retries": 3, "fragment_retries": 3,
    }
    if ranges:
        from yt_dlp.utils import download_range_func

        opts["download_ranges"] = download_range_func(None, [ranges])
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])
    except Exception as e:  # DownloadError, hoặc lỗi bên trong yt-dlp/ffmpeg
        return f"{type(e).__name__}: {e}"
    return None


def _yt_dlp_cli(url: str, tmp: Path) -> str | None:
    """Tải bằng lệnh yt-dlp trên máy (có thể mới hơn thư viện trong môi trường Python)."""
    import shutil

    exe = shutil.which("yt-dlp")
    if not exe:
        return "không có lệnh yt-dlp"
    cmd = [exe, "--no-playlist", "--no-progress", "-q", "--no-warnings",
           "-f", YT_FORMAT, "-S", ",".join(YT_SORT), "--max-filesize", str(int(MAX_DOWNLOAD_BYTES)),
           "--ffmpeg-location", ffmpeg_exe(), "-o", str(tmp / "clip.%(ext)s"), url]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except (OSError, subprocess.TimeoutExpired) as e:
        return f"{type(e).__name__}: {e}"
    if r.returncode != 0:
        return (r.stderr or r.stdout or f"mã thoát {r.returncode}").strip().splitlines()[-1]
    return None


def _download_youtube(cand: VideoCandidate, dest: Path, seconds: float) -> None:
    """Tải đoạn clip YouTube, thử lần lượt nhiều cách.

    1. Thư viện yt_dlp, chỉ tải đoạn cần (download_ranges). Cách này để ffmpeg đọc thẳng URL HTTPS/m3u8 —
       bản ffmpeg tĩnh của imageio có thể crash hoặc YouTube từ chối, nên không chắc chạy được.
    2. Thư viện yt_dlp tải cả video (tối đa MAX_DOWNLOAD_BYTES) rồi tự cắt bằng ffmpeg trên file cục bộ.
    3. Lệnh yt-dlp trên máy (thường được cập nhật riêng, có thể chạy khi thư viện Python đã cũ).
    """
    start = _start_offset(cand.duration, seconds)
    errors: list[str] = []
    attempts = [
        ("yt_dlp (đoạn)", lambda t: _yt_dlp_module(cand.url, t, (start, start + seconds)), 0.0),
        ("yt_dlp (cả video)", lambda t: _yt_dlp_module(cand.url, t, None), start),
        ("lệnh yt-dlp", lambda t: _yt_dlp_cli(cand.url, t), start),
    ]
    for label, run, offset in attempts:
        with tempfile.TemporaryDirectory(prefix="videogen_yt_") as tmp_name:
            tmp = Path(tmp_name)
            err = run(tmp)
            files = [f for f in tmp.glob("clip.*") if not f.name.endswith((".part", ".ytdl"))]
            if err is None and not files:
                err = "không tạo ra file (có thể vượt giới hạn dung lượng)"
            if err is None:
                try:
                    _transcode(str(files[0]), dest, offset, seconds)
                    return
                except subprocess.SubprocessError as e:
                    err = f"ffmpeg lỗi: {type(e).__name__}"
        errors.append(f"{label}: {err}")
    if any(re.search(YT_ERROR_PATTERN, e) for e in errors):
        raise ProviderUnavailable("YouTube yêu cầu đăng nhập/xác minh, không tải được từ máy này")
    raise RuntimeError("; ".join(errors))


def download_clip(cand: VideoCandidate, dest: Path, seconds: float) -> bool:
    """Tải một đoạn clip về dest (.mp4). Trả về False nếu clip hỏng/quá ngắn."""
    if cand.provider == "youtube":
        _download_youtube(cand, dest, seconds)
    else:
        with tempfile.TemporaryDirectory(prefix="videogen_clip_") as tmp:
            raw = Path(tmp) / "source"
            _download_file(cand.url, raw, cand.headers)
            _transcode(str(raw), dest, _start_offset(cand.duration, seconds), seconds)
    try:
        info = video_info(dest)
    except ValueError:
        return False
    if (info.get("duration") or 0) < MIN_SECONDS or not info.get("width"):
        dest.unlink(missing_ok=True)
        return False
    return True


class VideoProviderPool:
    """Gọi các nguồn video theo thứ tự; nguồn bị từ chối/chặn thì bỏ qua cho các lần sau trong lượt chạy."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.names = active_video_providers(settings)
        self._disabled: set[str] = set()
        self._lock = threading.Lock()

    def disable(self, name: str, reason: str) -> None:
        with self._lock:
            if name not in self._disabled:
                self._disabled.add(name)
                print(f"      ⚠️  Tạm bỏ nguồn video '{name}': {reason}", flush=True)

    def enabled(self) -> list[str]:
        return [n for n in self.names if n not in self._disabled]

    def search(self, name: str, query: str, orientation: str) -> list[VideoCandidate]:
        try:
            return PROVIDERS[name][0](query, orientation, self.settings)
        except requests.HTTPError as e:
            status = e.response.status_code if e.response is not None else None
            if status in (400, 401, 403):
                self.disable(name, f"bị từ chối ({status})")
            else:
                print(f"      ⚠️  Nguồn video '{name}' lỗi cho '{query}': {e}", flush=True)
        except ProviderUnavailable as e:
            self.disable(name, str(e))
        except Exception as e:  # nguồn ngoài lỗi bất thường: thử nguồn khác
            print(f"      ⚠️  Nguồn video '{name}' lỗi cho '{query}': {type(e).__name__}: {e}", flush=True)
        return []


def fetch_videos(
    queries: list[str], dests: list[Path], orientation: str, pool: VideoProviderPool, registry: UrlRegistry,
    seconds: float | None = None,
) -> list[tuple[Path, Credit]]:
    """Tải tối đa len(dests) clip khác nhau (nguồn × query theo thứ tự), mỗi clip vào một dest.

    Trả về danh sách (đường dẫn, ghi công) của các clip tải được.
    """
    seconds = seconds or pool.settings.web_clip_seconds
    found: list[tuple[Path, Credit]] = []
    for name in pool.names:
        for query in queries:
            if name not in pool.enabled():
                break
            for cand in pool.search(name, query, orientation)[:6]:
                if len(found) == len(dests):
                    return found
                if not registry.claim(cand.credit.url or cand.url):
                    continue
                dest = dests[len(found)]
                try:
                    if download_clip(cand, dest, seconds):
                        found.append((dest, cand.credit))
                except ProviderUnavailable as e:
                    pool.disable(name, str(e))
                    break
                except Exception as e:  # nguồn ngoài lỗi bất thường (vd yt-dlp/ffmpeg crash): thử clip khác
                    dest.unlink(missing_ok=True)
                    print(f"      ⚠️  Không tải được clip {cand.credit.url}: {type(e).__name__}: {str(e)[:300]}", flush=True)
    return found


def fetch_video(
    queries: list[str], dest: Path, orientation: str, pool: VideoProviderPool, registry: UrlRegistry,
    seconds: float | None = None,
) -> Credit | None:
    """Tải một clip vào dest; trả về thông tin ghi công."""
    found = fetch_videos(queries, [dest], orientation, pool, registry, seconds)
    return found[0][1] if found else None
