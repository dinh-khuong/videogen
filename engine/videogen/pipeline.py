"""Điều phối: prompt -> kịch bản (DeepSeek) -> ảnh (thư viện / tìm kiếm) -> giọng đọc (edge-tts) -> video."""
import hashlib
import json
import random
import re
import threading
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .config import Settings, load_settings
from .events import Reporter
from .graphics import make_placeholder, render_step_badge, render_title_card
from .image_search import Credit, ProviderPool, UrlRegistry, fetch_image
from .llm import LibraryAsset, Script, generate_script, parse_script, short_title
from .probe import VIDEO_EXTS
from .tts import synthesize_many
from .video_builder import ASPECTS, Scene, build_video, split_sizes

OUTPUT_ROOT = Path("output")
IMAGE_STYLES = ("auto", "cover", "frame")
LIBRARY_MODES = ("off", "auto", "selected")


@dataclass
class Options:
    aspect: str = "16:9"
    num_steps: int | None = None
    language: str = "tiếng Việt"
    voice: str | None = None
    rate: str | None = None
    music: Path | None = None
    music_volume: float = 0.12
    script_only: bool = False
    bg_video: Path | None = None  # file hoặc thư mục video nền -> bố cục chia đôi 9:16
    # auto: ảnh thư viện/ảnh tự chọn hiển thị trọn vẹn (frame), ảnh tìm trên mạng phủ kín khung (cover)
    image_style: str = "auto"
    web_images: bool = True  # cho phép tìm ảnh trên mạng khi bước không có ảnh thư viện
    library: list[LibraryAsset] = field(default_factory=list)  # asset ảnh/video của người dùng
    library_mode: str = "off"  # off | auto (LLM tự chọn nếu phù hợp) | selected (asset là nội dung chính)
    work_dir: Path | None = None  # mặc định output/<tiêu-đề>/
    reporter: Reporter = field(default_factory=Reporter)


@dataclass
class StepImage:
    step: int
    path: Path
    kind: str  # custom | library | web | placeholder
    library_id: str | None = None
    credit: Credit | None = None
    query: str | None = None
    media: str = "image"  # image | video

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


def _hash(*parts: str) -> str:
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:10]


ORIENTATIONS = {"16:9": "landscape", "9:16": "portrait", "1:1": "square"}


def _write_credits(images: list[StepImage], work_dir: Path) -> None:
    credited = [img for img in images if img.credit]
    if not credited:
        return
    lines = ["Nguồn ảnh:"]
    for img in credited:
        lines.append(f"- Bước {img.step}: {img.credit.source} — {img.credit.url}")
    (work_dir / "credits.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _load_credit(path: Path) -> Credit | None:
    try:
        return Credit(**json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError, TypeError):
        return None


def _prepare_images(
    script: Script, work_dir: Path, settings: Settings, size: tuple[int, int], orientation: str, opts: Options
) -> list[StepImage]:
    images_dir = work_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    registry = UrlRegistry()
    library = {img.id: img for img in opts.library}
    providers: list[ProviderPool] = []
    lock = threading.Lock()
    total, done = len(script.steps), 0

    def provider_pool() -> ProviderPool:
        # Tạo khi cần, để render từ ảnh có sẵn/cache không đòi key
        with lock:
            if not providers:
                providers.append(ProviderPool(settings))
                print(f"      Nguồn ảnh: {' → '.join(providers[0].names)}", flush=True)
            return providers[0]

    def find(i: int) -> StepImage:
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
        if opts.web_images and step.image_queries:
            path = images_dir / f"step_{n:02d}_{_hash(orientation, *step.image_queries)}.jpg"
            credit_path = path.with_suffix(".json")
            if path.exists():
                return StepImage(n, path, "web", credit=_load_credit(credit_path), query=query)
            credit = fetch_image(step.image_queries, path, orientation, provider_pool(), registry)
            if credit:
                credit_path.write_text(json.dumps(asdict(credit), ensure_ascii=False), encoding="utf-8")
                print(f"      ✓ Ảnh bước {n}: {query} ({credit.source})", flush=True)
                return StepImage(n, path, "web", credit=credit, query=query)
            print(f"      ⚠️  Không tìm được ảnh cho bước {n}, dùng ảnh nền thay thế.", flush=True)
        # Lưu tên khác để lần chạy sau vẫn thử tìm ảnh thật
        placeholder = images_dir / f"step_{n:02d}_{_hash(step.heading, step.narration)}_placeholder.jpg"
        make_placeholder(step.heading or step.narration[:60], placeholder, size, settings.font_path)
        return StepImage(n, placeholder, "placeholder", query=query)

    def job(i: int) -> StepImage:
        nonlocal done
        result = find(i)
        with lock:
            done += 1
            opts.reporter.stage("images", f"Đã có ảnh {done}/{total}", done / total)
        return result

    with ThreadPoolExecutor(max_workers=4) as pool:
        images = list(pool.map(job, range(total)))
    _write_credits(images, work_dir)
    return images


def _prepare_audio(script: Script, work_dir: Path, voice: str, rate: str, reporter: Reporter) -> dict[str, Path]:
    audio_dir = work_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    texts = {"intro": script.intro, "outro": script.outro}
    texts.update({f"step_{i + 1:02d}": s.narration for i, s in enumerate(script.steps)})
    paths = {
        key: audio_dir / f"{key}_{_hash(text, voice, rate)}.mp3"
        for key, text in texts.items()
        if text
    }
    synthesize_many(
        [(texts[k], p) for k, p in paths.items()],
        voice,
        rate,
        on_progress=lambda d, t: reporter.stage("audio", f"Giọng đọc {d}/{t}", d / t),
    )
    return paths


def _style_for(image: StepImage, opts: Options) -> str:
    if opts.image_style in ("cover", "frame"):
        return opts.image_style
    return "frame" if image.kind in ("custom", "library") else "cover"


def run(
    topic: str | None,
    out_path: str | None,
    script_path: str | None,
    opts: Options,
    script_data: dict | None = None,
) -> RunResult:
    """Chạy toàn bộ pipeline. Kịch bản lấy từ (theo thứ tự ưu tiên): script_data, script_path, hoặc LLM."""
    settings = load_settings()
    reporter = opts.reporter
    voice = opts.voice or settings.tts_voice
    rate = opts.rate or settings.tts_rate
    bg_video = pick_background(opts.bg_video) if opts.bg_video else None
    if bg_video:
        # Nửa trên gần vuông -> tìm ảnh vuông cho vừa khung
        size, orientation, layout = split_sizes()[0], "square", "9:16 chia đôi"
        frame_size = ASPECTS["9:16"]
    else:
        size, orientation, layout = ASPECTS[opts.aspect], ORIENTATIONS[opts.aspect], opts.aspect
        frame_size = size

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
            script = generate_script(topic, settings, opts.num_steps, opts.language, library, opts.library_mode)
        work_dir = opts.work_dir or OUTPUT_ROOT / slugify(script.title)
        work_dir.mkdir(parents=True, exist_ok=True)
        script_file = work_dir / "script.json"
        script.save(script_file)
    print(f"      Tiêu đề: {script.title} — {len(script.steps)} bước", flush=True)
    print(f"      Kịch bản: {script_file}", flush=True)
    reporter.stage("script", f"Kịch bản: {script.title}", 1.0)

    result = RunResult(script=script, script_file=script_file, work_dir=work_dir)
    if opts.script_only:
        print("✅ Đã lưu kịch bản. Sửa file rồi chạy lại với --script để render video.", flush=True)
        return result

    print("[2/4] Lấy ảnh minh họa (song song) ...", flush=True)
    reporter.stage("images", "Đang lấy ảnh minh họa")
    images = _prepare_images(script, work_dir, settings, size, orientation, opts)
    result.images = images

    print(f"[3/4] Tạo giọng đọc ({voice}, tốc độ {rate}) ...", flush=True)
    reporter.stage("audio", "Đang tạo giọng đọc")
    audio = _prepare_audio(script, work_dir, voice, rate, reporter)

    font = settings.font_path
    scenes = [
        Scene(
            image_path=images[0].path,
            audio_path=audio.get("intro"),
            narration=script.intro,
            overlays=[render_title_card(script.title, "Hướng dẫn từng bước", size, font)],
            media=images[0].media,
        )
    ]
    for i, step in enumerate(script.steps):
        scenes.append(
            Scene(
                image_path=images[i].path,
                audio_path=audio[f"step_{i + 1:02d}"],
                narration=step.narration,
                overlays=[render_step_badge(f"Bước {i + 1}", step.heading, size, font)],
                image_style=_style_for(images[i], opts),
                media=images[i].media,
            )
        )
    if script.outro:
        scenes.append(
            Scene(
                image_path=images[-1].path,
                audio_path=audio["outro"],
                narration=script.outro,
                overlays=[render_step_badge("Hoàn thành", "", size, font)],
                image_style=_style_for(images[-1], opts),
                media=images[-1].media,
            )
        )

    print(f"[4/4] Dựng video {layout} ({len(scenes)} cảnh) ...", flush=True)
    reporter.stage("render", f"Đang dựng video {layout}")
    if bg_video:
        print(f"      Video nền: {bg_video}", flush=True)
    final_out = Path(out_path) if out_path else work_dir / f"{slugify(script.title)}.mp4"
    final_out.parent.mkdir(parents=True, exist_ok=True)
    thumbnail = final_out.with_suffix(".jpg")
    result.duration = build_video(
        scenes,
        final_out,
        aspect=opts.aspect,
        music_path=opts.music,
        music_volume=opts.music_volume,
        font_override=font,
        work_dir=work_dir,
        bg_video=bg_video,
        logger=reporter.render_logger(),
        thumbnail_path=thumbnail,
    )
    result.video, result.thumbnail, result.size = final_out, thumbnail, frame_size
    reporter.stage("render", "Hoàn tất", 1.0)
    print(f"✅ Hoàn tất! Video: {final_out.resolve()}", flush=True)
    return result
