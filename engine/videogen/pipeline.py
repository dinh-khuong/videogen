"""Điều phối: prompt -> kịch bản (DeepSeek) -> ảnh (thư viện / tìm kiếm) -> giọng đọc (edge-tts) -> video."""
import json
import random
import re
import threading
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from itertools import zip_longest
from pathlib import Path

from videogen_core.audio.cast import VoiceCast, cast_note, voice_rule
from videogen_core.audio.delivery import apply_tuning, load_line_times
from videogen_core.audio.tts import load_words
from videogen_core.audio.voices import (
    contrast_voice, library_sounds, line_sound, plan_voices, prepare_audio, short_hash, transition_sounds,
)
from videogen_core.config import Settings, load_settings

from .events import Reporter
from .effects import Layer
from .graphics import (
    STICKER_SLOTS, Fonts, cta_layer, make_placeholder, meme_caption_layers, pop_text_layer, render_step_badge,
    resolve_fonts, sticker_layer, title_layers,
)
from .image_search import Credit, ProviderPool, UrlRegistry, fetch_image
from .video_search import VideoProviderPool, fetch_videos
from .llm import LibraryAsset, Script, Step, generate_script, parse_script, pick_assets, short_title
from .probe import VIDEO_EXTS
from .style import Language, Style, language_for, step_label, tagline
from .video_builder import ASPECTS, ClipOverlay, Scene, Segment, build_video, split_sizes

OUTPUT_ROOT = Path("output")
IMAGE_STYLES = ("auto", "cover", "frame")
WEB_MEDIA = ("image", "video", "auto")
LIBRARY_MODES = ("off", "auto", "selected")


@dataclass
class Options:
    aspect: str = "16:9"
    num_steps: int | None = None
    language: str = "tiếng Việt"
    voice: str | None = None
    voice2: str | None = None  # giọng thứ hai: đọc xen kẽ các bước chẵn (như hai người dẫn); bỏ qua khi có voice_cast
    # Dàn giọng: số người nói, chuyển giọng theo cảnh/nhân vật, giọng riêng từng người (None = tự động, cách cũ)
    voice_cast: VoiceCast | None = None
    voice_steady: bool = False  # giữ giọng đều: mọi câu đọc đúng tốc độ/cao độ của người nói, không đổi theo cảm xúc
    rate: str | None = None
    pitch: str | None = None  # cao độ giọng, vd "+5Hz" (trong trẻo hơn) hoặc "-8Hz" (trầm hơn)
    voice_effect: str = "none"  # hiệu ứng giọng: cute | chipmunk | deep | robot | radio | echo (xem tts.VOICE_EFFECTS)
    # AI được quyền tinh chỉnh cao độ/tốc độ chung của video quanh mức người dùng chọn (Script.voice_tuning)
    ai_voice: bool = False
    video_type: str = "howto"  # howto | listicle | tips | facts | promo | story
    tone: str = ""  # giọng văn mong muốn (vd "hài hước, dí dỏm")
    # Phong cách viết: auto | narrator | essay | dialogue (hai nhân vật, giọng chính + giọng phụ) | comedy (xem writing.STYLES)
    writing_style: str = "auto"
    length: str = "medium"  # short | medium | long
    style: Style = field(default_factory=Style)  # nhịp dựng, chuyển cảnh, phụ đề, màu, logo, lời kêu gọi...
    music: Path | None = None
    music_volume: float = 0.12
    script_only: bool = False
    bg_video: Path | None = None  # file hoặc thư mục video nền -> bố cục chia đôi 9:16
    # auto: ảnh thư viện/ảnh tự chọn hiển thị trọn vẹn (frame), ảnh tìm trên mạng phủ kín khung (cover)
    image_style: str = "auto"
    web_images: bool = True  # cho phép tìm ảnh/clip trên mạng khi bước không có asset thư viện
    # Loại nội dung tìm trên mạng: image | video (clip, thiếu thì dùng ảnh) | auto (LLM chọn cho từng bước)
    web_media: str = "image"
    # Công cụ tìm ảnh ưu tiên: auto (thứ tự IMAGE_PROVIDERS) | duckduckgo | google | brave | serper | pexels | pixabay
    search_engine: str = "auto"
    clips_per_step: int = 3  # số clip mạng ghép nối tiếp trong một bước dùng video
    # Tần suất đổi hình: cứ chừng này giây đổi sang ảnh/clip mới (0 = tự động, theo clips_per_step / AI quyết định).
    # Không thể nhanh hơn thời lượng tối thiểu của một đoạn hình theo nhịp dựng (style.PACING[...].min_segment).
    visual_interval: float = 0.0
    # Số ảnh meme / clip meme trong video (Đạo diễn AI): None = AI quyết định, 0 = không dùng, N = đúng N
    meme_images: int | None = None
    meme_videos: int | None = None
    library: list[LibraryAsset] = field(default_factory=list)  # asset ảnh/video của người dùng
    # Âm thanh ngắn (kind "audio") trong thư viện để Đạo diễn AI gắn vào câu thoại như hiệu ứng (khác nhạc nền `music`)
    sounds: list[LibraryAsset] = field(default_factory=list)
    # Âm thanh ngắn để chọn làm tiếng chuyển cảnh khi style.transition_sound là "auto"
    transition_sounds: list[LibraryAsset] = field(default_factory=list)
    library_mode: str = "off"  # off | auto (LLM tự chọn nếu phù hợp) | selected (asset là nội dung chính)
    work_dir: Path | None = None  # mặc định output/<tiêu-đề>/
    reporter: Reporter = field(default_factory=Reporter)
    # Đạo diễn AI: AI tự lên kịch bản qua nhiều lượt gọi công cụ (tìm asset/meme/clip, thêm/sửa cảnh, tự duyệt)
    director: bool = False
    feedback: str = ""  # góp ý của người dùng để AI sửa lại bản dựng trước (base_script)
    base_script: dict | None = None


@dataclass
class StepImage:
    step: int
    path: Path
    kind: str  # custom | library | web | placeholder
    library_id: str | None = None
    credit: Credit | None = None
    query: str | None = None
    media: str = "image"  # image | video
    position: int = 0  # thứ tự đoạn hình trong bước (một bước có thể ghép nhiều clip)
    # visual: đoạn hình chính của bước | overlay: clip/ảnh lồng trên hình suốt cảnh | sticker: meme bật ra theo câu
    role: str = "visual"
    ref: str | None = None  # vị trí trong kịch bản để web thay đường dẫn bằng id asset: "overlay" | "line:<số thứ tự câu>"
    # Do Đạo diễn AI đặt khi tải về (search_web): tiêu đề riêng của ảnh/clip, hashtag mô tả nội dung hình, có phải meme không
    title: str = ""
    hashtags: list[str] = field(default_factory=list)
    meme: bool = False

    def to_dict(self) -> dict:
        data = asdict(self)
        data["path"] = str(self.path.resolve())
        return data


@dataclass
class RunResult:
    script: Script
    script_file: Path
    work_dir: Path
    video: Path | None = None
    thumbnail: Path | None = None
    duration: float = 0.0
    size: tuple[int, int] = (0, 0)
    images: list[StepImage] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "script": self.script.to_dict(),
            # Ghi công cho nội dung có giấy phép yêu cầu (Creative Commons, kho stock)
            "credits": [img.credit.attribution() for img in self.images if img.credit and img.credit.license],
            "script_file": str(self.script_file.resolve()),
            "work_dir": str(self.work_dir.resolve()),
            "video": {
                "path": str(self.video.resolve()),
                "thumbnail": str(self.thumbnail.resolve()) if self.thumbnail else None,
                "duration": round(self.duration, 2),
                "width": self.size[0],
                "height": self.size[1],
                "title": self.script.title,
                "description": self.script.description or self.script.intro,
                "hashtags": self.script.hashtags,
            }
            if self.video
            else None,
            "images": [img.to_dict() for img in self.images],
        }


def pick_background(path: Path) -> Path:
    if path.is_dir():
        videos = [p for p in path.iterdir() if p.suffix.lower() in VIDEO_EXTS]
        if not videos:
            raise FileNotFoundError(f"Thư mục {path} không có video nào ({', '.join(sorted(VIDEO_EXTS))}).")
        return random.choice(videos)
    return path


def slugify(text: str) -> str:
    text = text.replace("đ", "d").replace("Đ", "D")
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-zA-Z0-9]+", "_", text).strip("_").lower()[:60] or "video"


CHARS_PER_SECOND = 14.5  # tốc độ đọc trung bình (tiếng Việt, tốc độ gốc), để ước lượng thời lượng lời bình trước khi có giọng
MAX_SEGMENTS = 8         # tối đa số ảnh/clip nối tiếp trong một bước


def speech_seconds(text: str, rate: str | None) -> float:
    """Ước lượng thời lượng đọc một đoạn lời bình theo tốc độ giọng ("+10%")."""
    try:
        speed = 1 + int((rate or "+0%").rstrip("%")) / 100
    except ValueError:
        speed = 1.0
    return len(text) / (CHARS_PER_SECOND * max(speed, 0.3))


def effective_interval(opts: "Options") -> float:
    """Tần suất đổi hình thật sự dùng: không nhanh hơn đoạn hình ngắn nhất mà nhịp dựng cho phép. Người dùng để tự động
    thì theo nhịp dựng (nhịp nhanh đổi hình ~2 giây một lần; 0 = theo số hình có sẵn)."""
    interval = opts.visual_interval if opts.visual_interval > 0 else opts.style.timing.auto_interval
    if interval <= 0:
        return 0.0
    return max(interval, opts.style.timing.min_segment)


def _fill_from_library(script: Script, library: list[LibraryAsset], interval: float, rate: str | None) -> int:
    """Không tìm trên mạng: bước nào thiếu hình (AI không chọn được, hoặc ít hơn số hình tần suất đổi hình đòi hỏi) thì
    lấy thêm asset khớp nhất trong thư viện thay vì để nền chữ, dùng lại asset khi thư viện không đủ.
    Cảnh Đạo diễn AI đã tự xếp hình (visuals) thì giữ nguyên. Trả về số bước được bổ sung."""
    known = {a.id for a in library}
    used: dict[str, int] = {}
    for step in script.steps:
        for ref in (step.library_image, *step.extra_assets, *(v.get("asset") for v in step.visuals)):
            if ref in known:
                used[ref] = used.get(ref, 0) + 1
    changed = 0
    for step in script.steps:
        if step.image or step.visuals:
            continue
        have = [x for x in (step.library_image, *step.extra_assets) if x in known]
        want = min(max(round(speech_seconds(step.narration, rate) / interval), 1), MAX_SEGMENTS) if interval else 1
        if len(have) >= want:
            continue
        text = " ".join([step.heading, step.narration, *step.image_queries])
        more = pick_assets(text, library, used, want - len(have), exclude=have)
        if more:
            ids = have + [a.id for a in more]
            step.library_image, step.extra_assets = ids[0], ids[1:]
            changed += 1
    return changed


ORIENTATIONS = {"16:9": "landscape", "9:16": "portrait", "1:1": "square"}
TITLE_CARD_SECONDS = 2.4  # thời gian tiêu đề lớn hiện ở cảnh Đạo diễn AI chọn (thường là hook)
OVERLAY_POSITION = 100  # thứ tự (trong bước) ghi cho clip lồng / sticker, tách khỏi các đoạn hình chính
STICKER_POSITION = 200

# Chuyển động ảnh theo cảm xúc của câu mở cảnh (khi AI không chọn): kịch tính thì đẩy chậm vào, hào hứng thì lia,
# tỉnh bơ thì đứng yên... Mỗi cảm xúc có vài lựa chọn để các cảnh không cùng một kiểu chuyển động.
MOOD_MOTIONS = {
    "dramatic": ("zoom_in",), "mysterious": ("zoom_in", "pan_up"), "sad": ("zoom_out", "pan_down"),
    "serious": ("zoom_in",), "shocked": ("zoom_in_left", "zoom_in_right"), "hype": ("pan_left", "pan_right"),
    "excited": ("pan_right", "zoom_in_right", "pan_left"), "fast": ("pan_left", "pan_right", "pan_up"),
    "deadpan": ("still",), "sarcastic": ("zoom_in_right", "zoom_in_left", "still"), "warm": ("zoom_out", "pan_right"),
    "curious": ("zoom_in_right", "zoom_in_left"), "thoughtful": ("zoom_out", "pan_up"), "emphatic": ("zoom_in",),
    "neutral": (),
}


def motion_for(step: Step, index: int) -> str | None:
    """Chuyển động ảnh của cảnh: AI chọn thì dùng, không thì theo cảm xúc câu đầu (neutral: luân phiên ngẫu nhiên)."""
    if step.motion:
        return step.motion
    lines = step.acted_lines()
    options = MOOD_MOTIONS.get(lines[0]["mood"], ()) if lines else ()
    return options[index % len(options)] if options else None


def _write_credits(images: list[StepImage], work_dir: Path) -> None:
    credited = [img for img in images if img.credit]
    if not credited:
        return
    lines = ["Nguồn ảnh:"]
    for img in credited:
        lines.append(f"- Bước {img.step}: {img.credit.attribution()}")
    (work_dir / "credits.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _load_credit(path: Path) -> Credit | None:
    try:
        return Credit(**json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError, TypeError):
        return None


def _prepare_images(
    script: Script, work_dir: Path, settings: Settings, size: tuple[int, int], orientation: str, opts: Options,
    fonts: Fonts,
) -> list[list[StepImage]]:
    """Đoạn hình cho từng bước: thường một ảnh/asset, hoặc nhiều clip nối tiếp với bước dùng video."""
    images_dir = work_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    registry = UrlRegistry()
    library = {img.id: img for img in opts.library}
    providers: list[ProviderPool] = []
    video_pools: list[VideoProviderPool] = []
    video_registry = UrlRegistry()
    lock = threading.Lock()
    total, done = len(script.steps), 0
    interval = effective_interval(opts)
    rate = opts.rate or settings.tts_rate

    def segment_count(step: Step, default: int) -> int:
        """Số ảnh/clip nối tiếp cho một bước: theo tần suất đổi hình nếu người dùng đặt, không thì `default`."""
        if not interval:
            return default
        return min(max(round(speech_seconds(step.narration, rate) / interval), 1), MAX_SEGMENTS)

    def provider_pool() -> ProviderPool:
        # Tạo khi cần, để render từ ảnh có sẵn/cache không đòi key
        with lock:
            if not providers:
                providers.append(ProviderPool(settings, opts.search_engine))
                print(f"      Nguồn ảnh: {' → '.join(providers[0].names)}", flush=True)
            return providers[0]

    def video_pool() -> VideoProviderPool:
        with lock:
            if not video_pools:
                video_pools.append(VideoProviderPool(settings))
                names = video_pools[0].names
                print(f"      Nguồn video: {' → '.join(names) if names else '(không có — dùng ảnh)'}", flush=True)
            return video_pools[0]

    def wants_video(step) -> bool:
        return opts.web_media == "video" or (opts.web_media == "auto" and step.media == "video")

    def find_videos(n: int, step) -> list[StepImage]:
        query = step.image_queries[0]
        key = short_hash("video", orientation, *step.image_queries)
        count = segment_count(step, max(1, opts.clips_per_step))
        if interval and opts.visual_interval <= 0:
            # Nhịp dồn dập (người dùng không đặt tần suất): tối đa nửa số hình là clip, còn lại ảnh (find_one)
            count = min(max(1, opts.clips_per_step), max(1, count // 2))
        paths = [images_dir / f"step_{n:02d}_{key}_{k}.mp4" for k in range(count)]
        if all(p.exists() for p in paths[:1]):
            cached = [p for p in paths if p.exists()]
            return [StepImage(n, p, "web", credit=_load_credit(p.with_suffix(".json")), query=query, media="video", position=k)
                    for k, p in enumerate(cached)]
        pool = video_pool()
        if not pool.names:
            return []
        found = fetch_videos(step.image_queries, paths, orientation, pool, video_registry)
        if not found:
            print(f"      ⚠️  Không tìm được clip cho bước {n}, chuyển sang tìm ảnh.", flush=True)
            return []
        clips = []
        for k, (path, credit) in enumerate(found):
            path.with_suffix(".json").write_text(json.dumps(asdict(credit), ensure_ascii=False), encoding="utf-8")
            clips.append(StepImage(n, path, "web", credit=credit, query=query, media="video", position=k))
        print(f"      ✓ Bước {n}: {len(clips)} clip — {query} ({', '.join(sorted({c.credit.source for c in clips}))})", flush=True)
        return clips

    def from_visuals(i: int) -> list[StepImage]:
        """Hình do Đạo diễn AI chọn sẵn: asset thư viện hoặc ảnh/clip đã tải về, theo đúng thứ tự."""
        out = []
        for ref in script.steps[i].visuals:
            if ref.get("asset"):
                lib = library.get(ref["asset"])
                if lib and Path(lib.path).exists():
                    out.append(StepImage(i + 1, Path(lib.path), "library", library_id=lib.id, media=lib.kind, position=len(out)))
            elif ref.get("path") and Path(ref["path"]).exists():
                credit = ref.get("credit")
                out.append(StepImage(
                    i + 1, Path(ref["path"]), "web", credit=Credit(**credit) if isinstance(credit, dict) else None,
                    query=ref.get("query"), media=ref.get("media") or "image", position=len(out),
                    title=ref.get("title") or "", hashtags=list(ref.get("hashtags") or []), meme=bool(ref.get("meme")),
                ))
        return out

    def find_images(n: int, step: Step, count: int) -> list[StepImage]:
        """Nhiều ảnh nối tiếp cho một bước (tần suất đổi hình cao): mỗi ảnh thử các query theo thứ tự xoay vòng."""
        key = short_hash(orientation, *step.image_queries)
        queries = step.image_queries
        out: list[StepImage] = []
        for k in range(count):
            path = images_dir / f"step_{n:02d}_{key}{'' if k == 0 else f'_{k}'}.jpg"
            credit_path = path.with_suffix(".json")
            order = queries[k % len(queries):] + queries[:k % len(queries)]
            if path.exists():
                out.append(StepImage(n, path, "web", credit=_load_credit(credit_path), query=order[0], position=len(out)))
                continue
            credit = fetch_image(order, path, orientation, provider_pool(), registry)
            if credit:
                credit_path.write_text(json.dumps(asdict(credit), ensure_ascii=False), encoding="utf-8")
                out.append(StepImage(n, path, "web", credit=credit, query=order[0], position=len(out)))
        if out:
            print(f"      ✓ Bước {n}: {len(out)}/{count} ảnh — {queries[0]}", flush=True)
        return out

    def find(i: int) -> list[StepImage]:
        step = script.steps[i]
        n = i + 1
        if step.visuals:
            chosen = from_visuals(i)
            if chosen:
                return chosen
            print(f"      ⚠️  Hình AI chọn cho bước {n} không còn, chuyển sang nguồn khác.", flush=True)
        lib = library.get(step.library_image or "")
        if lib and step.extra_assets and Path(lib.path).exists():
            # Render lại: bước đã có nhiều asset nối tiếp
            ids = [lib.id] + [x for x in step.extra_assets if x in library and Path(library[x].path).exists()]
            return [StepImage(n, Path(library[x].path), "library", library_id=x, media=library[x].kind, position=k)
                    for k, x in enumerate(ids)]
        found = find_one(i)
        return found if isinstance(found, list) else [found]

    def find_one(i: int) -> StepImage | list[StepImage]:
        step = script.steps[i]
        n = i + 1
        if step.image:
            custom = Path(step.image).expanduser()
            if not custom.is_absolute():
                custom = work_dir / custom
            if custom.exists():
                media = "video" if custom.suffix.lower() in VIDEO_EXTS else "image"
                return StepImage(n, custom, "custom", media=media)
            print(f"      ⚠️  Không thấy ảnh tự chọn {custom}, chuyển sang nguồn khác.", flush=True)

        lib = library.get(step.library_image or "")
        if lib:
            if Path(lib.path).exists():
                label = "video" if lib.kind == "video" else "ảnh"
                print(f"      ✓ Bước {n}: {label} thư viện ({lib.id})", flush=True)
                return StepImage(n, Path(lib.path), "library", library_id=lib.id, media=lib.kind)
            print(f"      ⚠️  Asset thư viện {lib.id} không còn trên đĩa, chuyển sang tìm kiếm.", flush=True)

        query = step.image_queries[0] if step.image_queries else None
        tried_video = False
        if opts.web_images and step.image_queries and wants_video(step):
            tried_video = True
            clips = find_videos(n, step)
            if clips:
                more = segment_count(step, len(clips)) - len(clips)
                images = find_images(n, step, more) if more > 0 and opts.visual_interval <= 0 else []
                if not images:
                    return clips
                # Nhịp dồn dập: ảnh xen giữa các clip để đủ số hình
                mixed = [img for pair in zip_longest(clips, images) for img in pair if img]
                for k, img in enumerate(mixed):
                    img.position = k
                return mixed
        if opts.web_images and step.image_queries:
            wanted = segment_count(step, 1)
            if wanted > 1:
                images = find_images(n, step, wanted)
                if images:
                    return images
            else:
                path = images_dir / f"step_{n:02d}_{short_hash(orientation, *step.image_queries)}.jpg"
                credit_path = path.with_suffix(".json")
                if path.exists():
                    return StepImage(n, path, "web", credit=_load_credit(credit_path), query=query)
                credit = fetch_image(step.image_queries, path, orientation, provider_pool(), registry)
                if credit:
                    credit_path.write_text(json.dumps(asdict(credit), ensure_ascii=False), encoding="utf-8")
                    print(f"      ✓ Ảnh bước {n}: {query} ({credit.source})", flush=True)
                    return StepImage(n, path, "web", credit=credit, query=query)
            if not tried_video:
                clips = find_videos(n, step)
                if clips:
                    print(f"      ✓ Bước {n}: không có ảnh phù hợp, dùng clip video thay thế.", flush=True)
                    return clips
            print(f"      ⚠️  Không tìm được ảnh cho bước {n}, dùng ảnh nền thay thế.", flush=True)
        # Lưu tên khác để lần chạy sau vẫn thử tìm ảnh thật
        placeholder = images_dir / f"step_{n:02d}_{short_hash(step.heading, step.narration)}_placeholder.jpg"
        make_placeholder(step.heading or step.narration[:60], placeholder, size, fonts)
        return StepImage(n, placeholder, "placeholder", query=query)

    def job(i: int) -> list[StepImage]:
        nonlocal done
        result = find(i)
        with lock:
            done += 1
            opts.reporter.stage("images", f"Đã có ảnh {done}/{total}", done / total)
        return result

    with ThreadPoolExecutor(max_workers=4) as pool:
        steps = list(pool.map(job, range(total)))
    _write_credits([img for seg in steps for img in seg], work_dir)
    return steps


def resolve_media(ref: dict | None, library: dict[str, LibraryAsset], step: int, role: str, position: int,
                  key: str) -> StepImage | None:
    """Ảnh/clip mà kịch bản trỏ tới (asset thư viện hoặc file AI đã tải về), nếu file còn trên đĩa."""
    if not isinstance(ref, dict):
        return None
    if ref.get("asset"):
        lib = library.get(ref["asset"])
        if lib and Path(lib.path).exists():
            return StepImage(step, Path(lib.path), "library", library_id=lib.id, media=lib.kind, position=position,
                             role=role, ref=key)
        return None
    path = Path(ref["path"]) if ref.get("path") else None
    if not path or not path.exists():
        return None
    credit = ref.get("credit")
    media = "video" if ref.get("media") == "video" or path.suffix.lower() in VIDEO_EXTS else "image"
    return StepImage(step, path, "web", credit=Credit(**credit) if isinstance(credit, dict) else None,
                     query=ref.get("query"), media=media, position=position, role=role, ref=key,
                     title=ref.get("title") or "", hashtags=list(ref.get("hashtags") or []), meme=bool(ref.get("meme")))


def _prepare_extras(script: Script, library: dict[str, LibraryAsset]) -> tuple[list[StepImage | None], list[dict[int, StepImage]]]:
    """Clip/ảnh lồng suốt cảnh và sticker meme (ảnh hoặc clip) theo câu thoại của từng bước."""
    overlays: list[StepImage | None] = []
    stickers: list[dict[int, StepImage]] = []
    for i, step in enumerate(script.steps):
        overlay = step.overlay or {}
        overlays.append(resolve_media(overlay.get("ref"), library, i + 1, "overlay", OVERLAY_POSITION, "overlay"))
        by_line = {}
        for j, line in enumerate(step.acted_lines()):
            img = resolve_media(line.get("sticker"), library, i + 1, "sticker", STICKER_POSITION + j, f"line:{j}")
            if img:
                by_line[j] = img
        stickers.append(by_line)
    return overlays, stickers


def _style_for(image: StepImage, opts: Options) -> str:
    if opts.image_style in ("cover", "frame"):
        return opts.image_style
    return "frame" if image.kind in ("custom", "library") else "cover"


@dataclass
class LineVisual:
    """Lớp hình bật ra theo một câu thoại: sticker meme (ảnh/clip ở một góc khung) hoặc chữ nhấn mạnh."""
    start: float  # giây trong cảnh (đã cộng khoảng lặng đầu cảnh)
    end: float
    sticker: StepImage | None = None
    slot: str = ""  # góc khung của sticker
    text: str = ""  # chữ nhấn mạnh (pop_text)


@dataclass
class LineEvents:
    """Hiệu ứng theo từng câu thoại của một cảnh. camera/sounds tính theo giây trong giọng đọc (như Scene.camera/sounds)."""
    camera: list[tuple[float, str]] = field(default_factory=list)  # (giây, punch | shake | zoom_slow)
    sounds: list[tuple[float, str | Path]] = field(default_factory=list)  # (giây, tên sfx | file thư viện)
    visuals: list[LineVisual] = field(default_factory=list)  # theo thứ tự câu, lớp sau vẽ đè lớp trước


@dataclass
class Prepared:
    """Kịch bản, hình và giọng đọc đã sẵn sàng (3 bước đầu của pipeline), dùng chung cho mọi engine dựng hình."""
    result: RunResult
    settings: Settings
    lang: Language
    fonts: Fonts
    size: tuple[int, int]  # khung nội dung (nửa trên khi chia đôi với video nền)
    frame_size: tuple[int, int]
    layout: str
    bg_video: Path | None
    steps: list[list[StepImage]] = field(default_factory=list)  # đoạn hình nối tiếp của từng bước
    overlays: list[StepImage | None] = field(default_factory=list)  # clip/ảnh lồng suốt cảnh của từng bước
    stickers: list[dict[int, StepImage]] = field(default_factory=list)  # sticker meme theo câu thoại của từng bước
    sound_files: dict[str, Path] = field(default_factory=dict)  # âm thanh thư viện gắn vào câu thoại: id -> file
    audio: dict[str, Path] = field(default_factory=dict)  # giọng đọc: "intro" | "outro" | "step_01"... -> file

    @property
    def script(self) -> Script:
        return self.result.script

    @property
    def work_dir(self) -> Path:
        return self.result.work_dir

    @property
    def director(self) -> bool:
        return self.script.format == "director"

    def scene_steps(self, opts: Options) -> list[Step | None]:
        """Bước của từng cảnh theo thứ tự dựng: Đạo diễn AI mỗi bước một cảnh; còn lại mở đầu (None), các bước, lời kết
        (None, khi có lời kết hoặc lời kêu gọi)."""
        if self.director:
            return list(self.script.steps)
        return [None, *self.script.steps, *([None] if self.script.outro or opts.style.cta else [])]

    def enter_sounds(self, opts: Options) -> list[str | Path | None]:
        """Tiếng phát khi chuyển vào từng cảnh (xem voices.transition_sounds); in ra log nếu có."""
        entering = transition_sounds(self.scene_steps(opts), opts.style.transition_sound, opts.style.transition_sound_file,
                                     opts.sounds, opts.transition_sounds)
        if any(entering):
            names = [s.name if isinstance(s, Path) else s for s in entering if s]
            print(f"      Tiếng chuyển cảnh: {', '.join(dict.fromkeys(names))} ({len(names)} lần)", flush=True)
        return entering

    def bookend_images(self) -> tuple[list[StepImage], list[StepImage]]:
        """Hình của cảnh mở đầu và lời kết. Có clip video: montage cắt nhanh từ clip của các bước thay vì một ảnh tĩnh."""
        steps = self.steps
        has_clips = any(img.media == "video" for seg in steps for img in seg)
        intro_imgs = [seg[0] for seg in steps[:4]] if has_clips else steps[0][:1]
        outro_imgs = [seg[-1] for seg in steps[-3:]] if has_clips else steps[-1][-1:]
        if all(img.kind == "placeholder" for img in intro_imgs):
            # Ảnh nền chữ của bước 1 sẽ chồng lên tiêu đề: mở đầu bằng nền gradient trơn
            blank = self.work_dir / "images" / "intro_placeholder.jpg"
            make_placeholder("", blank, self.size, self.fonts)
            intro_imgs = [StepImage(0, blank, "placeholder")]
        return intro_imgs, outro_imgs

    def line_events(self, step: Step, index: int, path: Path | None, head: float, not_before: float = 0.0,
                    taken: str | None = None) -> LineEvents:
        """Hiệu ứng theo từng câu thoại: sticker meme (ảnh, hoặc clip video bật ra), chữ nhấn mạnh, zoom giật/rung,
        âm thanh meme.

        not_before: lớp hình (sticker, chữ nhấn mạnh) chờ tới thời điểm này (vd sau khi tiêu đề lớn biến mất).
        taken: góc khung đã có clip lồng suốt cảnh, sticker tránh góc đó.
        """
        events = LineEvents()
        lines = step.acted_lines()
        times = load_line_times(path) if path and lines else None
        if not times or len(times) != len(lines):
            return events
        slots = iter([s for s in STICKER_SLOTS[:4] if s != taken] * 8)
        stickers = self.stickers[index] if index < len(self.stickers) else {}
        for j, (line, span) in enumerate(zip(lines, times)):
            start, end = span["start"], span["end"]
            if line.get("camera"):
                events.camera.append((start, line["camera"]))
            sound = line_sound(line, start, self.sound_files)
            if sound:
                events.sounds.append(sound)
            show = max(head + start, not_before)
            sticker = stickers.get(j)
            if sticker and head + end + 0.5 - show > 0.8:
                # Clip meme/reaction giữ thêm một chút cho "miếng" hài ngấm
                until = head + max(end + 0.6, start + 2.0) if sticker.media == "video" else head + end + 0.5
                events.visuals.append(LineVisual(show, until, sticker=sticker, slot=next(slots)))
            pop_end = head + max(end, start + 1.2)
            if line.get("pop_text"):  # luôn hiện đủ 1,2 giây, kể cả khi phải chờ tiêu đề
                events.visuals.append(LineVisual(show, max(pop_end, show + 1.2), text=line["pop_text"]))
        return events


def prepare(topic: str | None, script_path: str | None, opts: Options, script_data: dict | None = None) -> Prepared:
    """Ba bước đầu: kịch bản (theo thứ tự ưu tiên: script_data, script_path, hoặc LLM), ảnh/clip, giọng đọc.
    opts.script_only: chỉ có kịch bản (hình và giọng để trống)."""
    settings = load_settings()
    reporter = opts.reporter
    voice = opts.voice or settings.tts_voice
    voice2 = opts.voice2 if opts.voice2 and opts.voice2 != voice else None
    rate = opts.rate or settings.tts_rate
    pitch = opts.pitch or "+0Hz"
    lang = language_for(opts.language)
    fonts = resolve_fonts(settings.font_path, lang.code)
    bg_video = pick_background(opts.bg_video) if opts.bg_video else None
    if bg_video:
        # Nửa trên gần vuông -> tìm ảnh vuông cho vừa khung
        size, orientation, layout = split_sizes()[0], "square", "9:16 chia đôi"
        frame_size = ASPECTS["9:16"]
    else:
        size, orientation, layout = ASPECTS[opts.aspect], ORIENTATIONS[opts.aspect], opts.aspect
        frame_size = size

    director_dir = None
    if opts.director and script_data is None and not script_path:
        from .director import direct

        # Thư mục làm việc có trước kịch bản: AI tải ảnh/clip vào đó trong lúc lên kịch bản
        director_dir = opts.work_dir or OUTPUT_ROOT / slugify(short_title(topic or "video"))
        director_dir.mkdir(parents=True, exist_ok=True)
        print(f"[1/4] Đạo diễn AI đang lên kịch bản cho: {short_title(topic, 80)!r} ...", flush=True)
        script_data = direct(topic, settings, opts, director_dir, orientation).to_dict()
    reporter.stage("script", "Đang chuẩn bị kịch bản")
    if script_path and script_data is None:
        # Kịch bản người dùng tự sửa: đọc tại chỗ, không ghi đè
        script_file = Path(script_path)
        script = Script.load(script_file)
        work_dir = opts.work_dir or script_file.parent
        work_dir.mkdir(parents=True, exist_ok=True)
        print(f"[1/4] Dùng kịch bản có sẵn: {script_file}", flush=True)
    else:
        if script_data is not None:
            script = parse_script(script_data, default_title=short_title(topic or "video"))
            print("[1/4] Dùng kịch bản được cung cấp", flush=True)
        else:
            print(f"[1/4] DeepSeek đang viết kịch bản cho: {short_title(topic, 80)!r} ({len(topic)} ký tự) ...", flush=True)
            reporter.stage("script", "DeepSeek đang viết kịch bản")
            library = opts.library if opts.library_mode != "off" else []
            voice_desc = None
            if opts.ai_voice:
                voice_desc = f"{voice}, cao độ {pitch}, tốc độ {rate}"
                if opts.voice_effect != "none":
                    voice_desc += f", hiệu ứng {opts.voice_effect}"
            cast = opts.voice_cast
            if cast:
                cast_voices = [voice, *(v.voice for v in cast.extra)]
                cast_text, speakers, rule = cast_note(cast_voices, cast.names), cast.speakers if cast.by_character else (), \
                    voice_rule(cast, cast_voices)
            else:
                cast_text, speakers, rule = cast_note([voice, voice2 or contrast_voice(voice, lang.code)]), None, ""
            script = generate_script(
                topic, settings, opts.num_steps, opts.language, library, opts.library_mode, opts.web_media,
                video_type=opts.video_type, tone=opts.tone, length=opts.length, voice=voice_desc,
                writing=opts.writing_style, cast=cast_text, speakers=speakers, cast_rule=rule,
            )
        work_dir = opts.work_dir or director_dir or OUTPUT_ROOT / slugify(script.title)
        work_dir.mkdir(parents=True, exist_ok=True)
        script_file = work_dir / "script.json"
        script.save(script_file)
    if script.voice_tuning:
        # Giọng chung của video = giọng người dùng chọn + phần AI tinh chỉnh (ghi lại để web hiện và nghe thử đúng mức)
        base_rate, base_pitch = rate, pitch
        rate, pitch = apply_tuning(base_rate, base_pitch, script.voice_tuning)
        script.voice_tuning.update(base_rate=base_rate, base_pitch=base_pitch, final_rate=rate, final_pitch=pitch)
        reason = f" — {script.voice_tuning['reason']}" if script.voice_tuning.get("reason") else ""
        print(f"      AI tinh chỉnh giọng: cao độ {base_pitch} → {pitch}, tốc độ {base_rate} → {rate}{reason}", flush=True)
        if script_data is not None or not script_path:
            script.save(script_file)
    if not opts.web_images and opts.library:
        pool = opts.library
        if script.format == "director":
            # Meme là điểm nhấn Đạo diễn AI tự đặt (và đếm theo số lượng người dùng yêu cầu), không dùng làm hình lấp chỗ trống
            from .director import _is_meme
            pool = [a for a in pool if not _is_meme(a)] or pool
        filled = _fill_from_library(script, pool, effective_interval(opts), opts.rate or settings.tts_rate)
        if filled:
            print(f"      Không tìm trên mạng: bổ sung hình từ thư viện cho {filled} bước chưa có hình", flush=True)
            if script_data is not None or not script_path:  # kịch bản người dùng tự sửa thì không ghi đè
                script.save(script_file)
    print(f"      Tiêu đề: {script.title} — {len(script.steps)} bước", flush=True)
    print(f"      Kịch bản: {script_file}", flush=True)
    reporter.stage("script", f"Kịch bản: {script.title}", 1.0)

    result = RunResult(script=script, script_file=script_file, work_dir=work_dir)
    prepared = Prepared(result, settings, lang, fonts, size, frame_size, layout, bg_video)
    if opts.script_only:
        print("✅ Đã lưu kịch bản. Sửa file rồi chạy lại với --script để render video.", flush=True)
        return prepared

    print("[2/4] Lấy ảnh/clip minh họa (song song) ...", flush=True)
    reporter.stage("images", "Đang lấy ảnh/clip minh họa")
    steps = _prepare_images(script, work_dir, settings, size, orientation, opts, fonts)
    library = {a.id: a for a in opts.library}
    sound_files = library_sounds(opts.sounds)
    used_sounds = [l["sound"] for st in script.steps for l in st.acted_lines() if l.get("sound") in sound_files]
    if used_sounds:
        print(f"      Âm thanh từ thư viện: {len(used_sounds)} lần ({len(set(used_sounds))} tiếng khác nhau)", flush=True)
    step_overlays, step_stickers = _prepare_extras(script, library)
    result.images = [img for seg in steps for img in seg]
    result.images += [img for img in step_overlays if img] + [img for by_line in step_stickers for img in by_line.values()]

    plan = plan_voices(script, opts.voice_cast, voice, voice2, rate, pitch, lang.code)
    effect_label = f", hiệu ứng {opts.voice_effect}" if opts.voice_effect != "none" else ""
    steady_label = ", giữ giọng đều" if opts.voice_steady else ""
    print(f"[3/4] Tạo giọng đọc ({plan.label}, tốc độ {rate}, cao độ {pitch}{effect_label}{steady_label}) ...", flush=True)
    reporter.stage("audio", "Đang tạo giọng đọc")
    audio = prepare_audio(
        script, work_dir, plan.voices, reporter, lang.code, opts.voice_effect, by_scene=plan.by_scene,
        steady=opts.voice_steady,
    )
    prepared.steps, prepared.overlays, prepared.stickers = steps, step_overlays, step_stickers
    prepared.sound_files, prepared.audio = sound_files, audio
    return prepared


def run(
    topic: str | None,
    out_path: str | None,
    script_path: str | None,
    opts: Options,
    script_data: dict | None = None,
) -> RunResult:
    """Chạy toàn bộ pipeline. Kịch bản lấy từ (theo thứ tự ưu tiên): script_data, script_path, hoặc LLM."""
    prepared = prepare(topic, script_path, opts, script_data)
    result = prepared.result
    if opts.script_only:
        return result
    reporter = opts.reporter
    script, work_dir, audio, steps = prepared.script, prepared.work_dir, prepared.audio, prepared.steps
    size, fonts, lang, director = prepared.size, prepared.fonts, prepared.lang, prepared.director
    step_overlays = prepared.overlays
    style = opts.style

    def segments(images: list[StepImage]) -> list[Segment]:
        return [Segment(img.path, img.media, _style_for(img, opts)) for img in images]

    intro_imgs, outro_imgs = prepared.bookend_images()

    def badge(label: str, heading: str) -> Layer | None:
        # Nhãn trượt vào từ trái (kèm tiếng "tách" nếu bật hiệu ứng âm thanh)
        reserve = round(min(size) * 0.2) if style.logo else 0  # logo nằm ở góc trên phải
        canvas = render_step_badge(label, heading, size, fonts, style.accent, reserve_right=reserve)
        return Layer.from_canvas(canvas, start=0.2, enter="slide_left", enter_dur=0.45)

    head = style.timing.head

    def acting(step: Step, index: int, path: Path | None, not_before: float = 0.0,
               taken: str | None = None) -> tuple[list[Layer | None], list[ClipOverlay], list, list]:
        """Lớp hình, clip lồng, chuyển động camera và âm thanh theo câu thoại (xem Prepared.line_events)."""
        events = prepared.line_events(step, index, path, head, not_before, taken)
        overlays: list[Layer | None] = []
        clips: list[ClipOverlay] = []
        for v in events.visuals:
            if v.text:
                overlays.append(pop_text_layer(v.text, size, fonts, style.accent, v.start, v.end))
            elif v.sticker.media == "video":
                clips.append(ClipOverlay(v.sticker.path, v.slot, v.start, v.end))
            else:
                overlays.append(sticker_layer(v.sticker.path, size, v.slot, v.start, v.end))
        return overlays, clips, events.camera, events.sounds

    def scene(images: list[StepImage], key: str, narration: str, overlays: list[Layer | None], pop: bool,
              step: Step | None = None, not_before: float = 0.0, index: int = -1) -> Scene:
        path = audio.get(key)
        layers = [o for o in overlays if o]
        clips: list[ClipOverlay] = []
        taken = None
        lay = step_overlays[index] if step and 0 <= index < len(step_overlays) else None
        if lay and step and step.overlay:
            taken = step.overlay["position"]
            if lay.media == "video":
                # Clip lồng trên ảnh nền suốt cảnh: hình không chỉ là ảnh tĩnh mà có video chạy bên trong
                clips.append(ClipOverlay(lay.path, taken, max(0.25, not_before), None, big=True))
            else:
                layers.append(sticker_layer(lay.path, size, taken, max(0.25, not_before), None))
        extra, line_clips, camera, sounds = acting(step, index, path, not_before, taken) if step else ([], [], [], [])
        return Scene(
            segments=segments(images), audio_path=path, narration=narration, overlays=layers + [o for o in extra if o],
            words=load_words(path) if path else None, pops=[0.2] if pop and layers else [], camera=camera, sounds=sounds,
            clips=clips + line_clips, motion=motion_for(step, index) if step else None,
        )

    if director:
        # Mỗi bước là một cảnh tự do: tiêu đề lớn chỉ hiện vài giây ở cảnh AI chọn, nhãn chỉ khi AI đặt tên cảnh
        scenes = []
        for i, step in enumerate(script.steps):
            overlays: list[Layer | None] = []
            # Tiêu đề lớn chiếm giữa khung vài giây đầu: chữ meme, sticker, chữ nhấn mạnh hiện sau đó để không chồng nhau
            clear_at = TITLE_CARD_SECONDS if step.title_card else 0.0
            if step.title_card:
                for layer in title_layers(script.title, "", size, fonts, style.accent):
                    layer.end = TITLE_CARD_SECONDS
                    overlays.append(layer)
            elif step.heading:
                overlays.append(badge("", step.heading))
            if step.meme:
                overlays += meme_caption_layers(step.meme.get("top", ""), step.meme.get("bottom", ""), size, fonts,
                                                max(0.1, clear_at))
            if i == len(script.steps) - 1 and style.cta:
                overlays.append(cta_layer(style.cta, size, fonts, style.accent, start=1.0))
            scenes.append(scene(steps[i], f"step_{i + 1:02d}", step.narration, overlays, bool(step.heading), step, clear_at, i))
    else:
        subtitle = tagline(lang, opts.video_type, len(script.steps))
        scenes = [scene(intro_imgs, "intro", script.intro, title_layers(script.title, subtitle, size, fonts, style.accent), False)]
        for i, step in enumerate(script.steps):
            label = step_label(lang, opts.video_type, i + 1)
            scenes.append(scene(steps[i], f"step_{i + 1:02d}", step.narration, [badge(label, step.heading)], True, step, index=i))
        if script.outro or style.cta:
            outro = [badge(lang.done, "")]
            if style.cta:
                outro.append(cta_layer(style.cta, size, fonts, style.accent))
            scenes.append(scene(outro_imgs, "outro", script.outro, outro, True))
    for sc, sound in zip(scenes, prepared.enter_sounds(opts)):
        sc.enter_sound = sound
    clip_count = sum(1 for seg in steps for img in seg if img.media == "video")
    if clip_count:
        print(f"      Ghép {clip_count} clip video từ {sum(1 for s in steps if any(i.media == 'video' for i in s))} bước", flush=True)

    print(f"[4/4] Dựng video {prepared.layout} ({len(scenes)} cảnh) ...", flush=True)
    reporter.stage("render", f"Đang dựng video {prepared.layout}")
    if prepared.bg_video:
        print(f"      Video nền: {prepared.bg_video}", flush=True)
    final_out = Path(out_path) if out_path else work_dir / f"{slugify(script.title)}.mp4"
    final_out.parent.mkdir(parents=True, exist_ok=True)
    thumbnail = final_out.with_suffix(".jpg")
    result.duration = build_video(
        scenes,
        final_out,
        aspect=opts.aspect,
        music_path=opts.music,
        music_volume=opts.music_volume,
        fonts=fonts,
        work_dir=work_dir,
        bg_video=prepared.bg_video,
        logger=reporter.render_logger(),
        thumbnail_path=thumbnail,
        style=style,
    )
    result.video, result.thumbnail, result.size = final_out, thumbnail, prepared.frame_size
    reporter.stage("render", "Hoàn tất", 1.0)
    print(f"✅ Hoàn tất! Video: {final_out.resolve()}", flush=True)
    return result
