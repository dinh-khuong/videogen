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
from .effects import Layer
from .graphics import Fonts, cta_layer, make_placeholder, render_step_badge, resolve_fonts, title_layers
from .image_search import Credit, ProviderPool, UrlRegistry, fetch_image
from .video_search import VideoProviderPool, fetch_videos
from .llm import LibraryAsset, Script, generate_script, parse_script, short_title
from .probe import VIDEO_EXTS
from .style import Style, language_for, step_label, tagline
from .tts import TtsJob, load_words, synthesize_many
from .video_builder import ASPECTS, Scene, Segment, build_video, split_sizes

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
    voice2: str | None = None  # giọng thứ hai: đọc xen kẽ các bước chẵn (như hai người dẫn)
    rate: str | None = None
    pitch: str | None = None  # cao độ giọng, vd "+5Hz" (trong trẻo hơn) hoặc "-8Hz" (trầm hơn)
    video_type: str = "howto"  # howto | listicle | tips | facts | promo | story
    tone: str = ""  # giọng văn mong muốn (vd "hài hước, dí dỏm")
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
    clips_per_step: int = 3  # số clip mạng ghép nối tiếp trong một bước dùng video
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
    position: int = 0  # thứ tự đoạn hình trong bước (một bước có thể ghép nhiều clip)

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


def _hash(*parts: str) -> str:
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:10]


ORIENTATIONS = {"16:9": "landscape", "9:16": "portrait", "1:1": "square"}


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

    def provider_pool() -> ProviderPool:
        # Tạo khi cần, để render từ ảnh có sẵn/cache không đòi key
        with lock:
            if not providers:
                providers.append(ProviderPool(settings))
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
        key = _hash("video", orientation, *step.image_queries)
        count = max(1, opts.clips_per_step)
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

    def find(i: int) -> list[StepImage]:
        step = script.steps[i]
        n = i + 1
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
                return clips
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
            if not tried_video:
                clips = find_videos(n, step)
                if clips:
                    print(f"      ✓ Bước {n}: không có ảnh phù hợp, dùng clip video thay thế.", flush=True)
                    return clips
            print(f"      ⚠️  Không tìm được ảnh cho bước {n}, dùng ảnh nền thay thế.", flush=True)
        # Lưu tên khác để lần chạy sau vẫn thử tìm ảnh thật
        placeholder = images_dir / f"step_{n:02d}_{_hash(step.heading, step.narration)}_placeholder.jpg"
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


def _prepare_audio(
    script: Script, work_dir: Path, voices: tuple[str, str | None], rate: str, pitch: str, reporter: Reporter,
    fallback_lang: str,
) -> dict[str, Path]:
    """Giọng đọc cho mở đầu, từng bước và lời kết. Có giọng thứ hai thì các bước chẵn dùng giọng đó (đọc xen kẽ)."""
    audio_dir = work_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    main, second = voices
    texts: dict[str, tuple[str, str]] = {"intro": (script.intro, main), "outro": (script.outro, main)}
    for i, s in enumerate(script.steps):
        texts[f"step_{i + 1:02d}"] = (s.narration, second if second and i % 2 == 1 else main)
    jobs: dict[str, TtsJob] = {}
    for key, (text, voice) in texts.items():
        if not text:
            continue
        # Giữ khóa cache cũ khi không đổi cao độ (render lại không phải tạo lại giọng)
        parts = (text, voice, rate) if pitch == "+0Hz" else (text, voice, rate, pitch)
        jobs[key] = TtsJob(text, audio_dir / f"{key}_{_hash(*parts)}.mp3", voice)
    synthesize_many(
        list(jobs.values()),
        rate,
        pitch,
        on_progress=lambda d, t: reporter.stage("audio", f"Giọng đọc {d}/{t}", d / t),
        fallback_lang=fallback_lang,
    )
    return {key: job.path for key, job in jobs.items()}


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
    voice2 = opts.voice2 if opts.voice2 and opts.voice2 != voice else None
    rate = opts.rate or settings.tts_rate
    pitch = opts.pitch or "+0Hz"
    lang = language_for(opts.language)
    style = opts.style
    fonts = resolve_fonts(settings.font_path, lang.code)
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
            script = generate_script(
                topic, settings, opts.num_steps, opts.language, library, opts.library_mode, opts.web_media,
                video_type=opts.video_type, tone=opts.tone, length=opts.length,
            )
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

    print("[2/4] Lấy ảnh/clip minh họa (song song) ...", flush=True)
    reporter.stage("images", "Đang lấy ảnh/clip minh họa")
    steps = _prepare_images(script, work_dir, settings, size, orientation, opts, fonts)
    result.images = [img for seg in steps for img in seg]

    voice_label = f"{voice} + {voice2} xen kẽ" if voice2 else voice
    print(f"[3/4] Tạo giọng đọc ({voice_label}, tốc độ {rate}, cao độ {pitch}) ...", flush=True)
    reporter.stage("audio", "Đang tạo giọng đọc")
    audio = _prepare_audio(script, work_dir, (voice, voice2), rate, pitch, reporter, lang.code)

    def segments(images: list[StepImage]) -> list[Segment]:
        return [Segment(img.path, img.media, _style_for(img, opts)) for img in images]

    # Có clip video: mở đầu/kết thúc là montage cắt nhanh từ clip của các bước thay vì một ảnh tĩnh
    has_clips = any(img.media == "video" for img in result.images)
    intro_imgs = [seg[0] for seg in steps[:4]] if has_clips else steps[0][:1]
    outro_imgs = [seg[-1] for seg in steps[-3:]] if has_clips else steps[-1][-1:]
    if all(img.kind == "placeholder" for img in intro_imgs):
        # Ảnh nền chữ của bước 1 sẽ chồng lên tiêu đề: mở đầu bằng nền gradient trơn
        blank = work_dir / "images" / "intro_placeholder.jpg"
        make_placeholder("", blank, size, fonts)
        intro_imgs = [StepImage(0, blank, "placeholder")]

    def badge(label: str, heading: str) -> Layer | None:
        # Nhãn trượt vào từ trái (kèm tiếng "tách" nếu bật hiệu ứng âm thanh)
        reserve = round(min(size) * 0.2) if style.logo else 0  # logo nằm ở góc trên phải
        canvas = render_step_badge(label, heading, size, fonts, style.accent, reserve_right=reserve)
        return Layer.from_canvas(canvas, start=0.2, enter="slide_left", enter_dur=0.45)

    def scene(images: list[StepImage], key: str, narration: str, overlays: list[Layer | None], pop: bool) -> Scene:
        path = audio.get(key)
        layers = [o for o in overlays if o]
        return Scene(
            segments=segments(images), audio_path=path, narration=narration, overlays=layers,
            words=load_words(path) if path else None, pops=[0.2] if pop and layers else [],
        )

    subtitle = tagline(lang, opts.video_type, len(script.steps))
    scenes = [scene(intro_imgs, "intro", script.intro, title_layers(script.title, subtitle, size, fonts, style.accent), False)]
    for i, step in enumerate(script.steps):
        label = step_label(lang, opts.video_type, i + 1)
        scenes.append(scene(steps[i], f"step_{i + 1:02d}", step.narration, [badge(label, step.heading)], True))
    if script.outro or style.cta:
        outro = [badge(lang.done, "")]
        if style.cta:
            outro.append(cta_layer(style.cta, size, fonts, style.accent))
        scenes.append(scene(outro_imgs, "outro", script.outro, outro, True))
    clip_count = sum(1 for img in result.images if img.media == "video")
    if clip_count:
        print(f"      Ghép {clip_count} clip video từ {sum(1 for s in steps if any(i.media == 'video' for i in s))} bước", flush=True)

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
        fonts=fonts,
        work_dir=work_dir,
        bg_video=bg_video,
        logger=reporter.render_logger(),
        thumbnail_path=thumbnail,
        style=style,
    )
    result.video, result.thumbnail, result.size = final_out, thumbnail, frame_size
    reporter.stage("render", "Hoàn tất", 1.0)
    print(f"✅ Hoàn tất! Video: {final_out.resolve()}", flush=True)
    return result
