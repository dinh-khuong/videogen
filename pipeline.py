"""Điều phối: prompt -> kịch bản (DeepSeek) -> ảnh (Google/Serper/Pexels) -> giọng đọc (edge-tts) -> video."""
import hashlib
import json
import random
import re
import threading
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path

from config import Settings, load_settings
from graphics import make_placeholder, render_step_badge, render_title_card
from image_search import Credit, ProviderPool, UrlRegistry, fetch_image
from llm import Script, generate_script
from tts import synthesize_many
from video_builder import ASPECTS, Scene, build_video, split_sizes

OUTPUT_ROOT = Path("output")


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


VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"}


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


def _write_credits(credits: list[tuple[int, Credit]], work_dir: Path) -> None:
    if not credits:
        return
    lines = ["Nguồn ảnh:"]
    for step_no, c in sorted(credits, key=lambda x: x[0]):
        lines.append(f"- Bước {step_no}: {c.source} — {c.url}")
    (work_dir / "credits.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _load_credit(path: Path) -> Credit | None:
    try:
        return Credit(**json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError, TypeError):
        return None


def _prepare_images(
    script: Script, work_dir: Path, settings: Settings, size: tuple[int, int], orientation: str
) -> list[Path]:
    images_dir = work_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    registry = UrlRegistry()
    credits: list[tuple[int, Credit]] = []
    providers: list[ProviderPool] = []
    providers_lock = threading.Lock()

    def provider_pool() -> ProviderPool:
        # Tạo khi cần, để render từ ảnh có sẵn/cache không đòi key
        with providers_lock:
            if not providers:
                providers.append(ProviderPool(settings))
                print(f"      Nguồn ảnh: {' → '.join(providers[0].names)}")
            return providers[0]

    def job(i: int) -> Path:
        step = script.steps[i]
        if step.image:
            custom = Path(step.image).expanduser()
            if not custom.is_absolute():
                custom = work_dir / custom
            if custom.exists():
                return custom
            print(f"      ⚠️  Không thấy ảnh tự chọn {custom}, chuyển sang tìm kiếm.")

        path = images_dir / f"step_{i + 1:02d}_{_hash(orientation, *step.image_queries)}.jpg"
        credit_path = path.with_suffix(".json")
        if path.exists():
            credit = _load_credit(credit_path)
            if credit:
                credits.append((i + 1, credit))
            return path
        credit = (
            fetch_image(step.image_queries, path, orientation, provider_pool(), registry)
            if step.image_queries
            else None
        )
        if credit:
            credit_path.write_text(json.dumps(asdict(credit), ensure_ascii=False), encoding="utf-8")
            credits.append((i + 1, credit))
            print(f"      ✓ Ảnh bước {i + 1}: {step.image_queries[0]} ({credit.source})")
            return path
        print(f"      ⚠️  Không tìm được ảnh cho bước {i + 1}, dùng ảnh nền thay thế.")
        # Lưu tên khác để lần chạy sau vẫn thử tìm ảnh thật
        placeholder = path.with_name(f"{path.stem}_placeholder.jpg")
        return make_placeholder(step.heading or step.narration[:60], placeholder, size, settings.font_path)

    with ThreadPoolExecutor(max_workers=4) as pool:
        images = list(pool.map(job, range(len(script.steps))))
    _write_credits(credits, work_dir)
    return images


def _prepare_audio(script: Script, work_dir: Path, voice: str, rate: str) -> dict[str, Path]:
    audio_dir = work_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    texts = {"intro": script.intro, "outro": script.outro}
    texts.update({f"step_{i + 1:02d}": s.narration for i, s in enumerate(script.steps)})
    paths = {
        key: audio_dir / f"{key}_{_hash(text, voice, rate)}.mp3"
        for key, text in texts.items()
        if text
    }
    synthesize_many([(texts[k], p) for k, p in paths.items()], voice, rate)
    return paths


def run(topic: str | None, out_path: str | None, script_path: str | None, opts: Options) -> Path:
    settings = load_settings()
    voice = opts.voice or settings.tts_voice
    rate = opts.rate or settings.tts_rate
    bg_video = pick_background(opts.bg_video) if opts.bg_video else None
    if bg_video:
        # Nửa trên gần vuông -> tìm ảnh vuông cho vừa khung
        size, orientation, layout = split_sizes()[0], "square", "9:16 chia đôi"
    else:
        size, orientation, layout = ASPECTS[opts.aspect], ORIENTATIONS[opts.aspect], opts.aspect

    if script_path:
        script_file = Path(script_path)
        script = Script.load(script_file)
        work_dir = script_file.parent
        print(f"[1/4] Dùng kịch bản có sẵn: {script_file}")
    else:
        print(f"[1/4] DeepSeek đang viết kịch bản cho: {topic!r} ...")
        script = generate_script(topic, settings, opts.num_steps, opts.language)
        work_dir = OUTPUT_ROOT / slugify(script.title)
        work_dir.mkdir(parents=True, exist_ok=True)
        script_file = work_dir / "script.json"
        script.save(script_file)
    print(f"      Tiêu đề: {script.title} — {len(script.steps)} bước")
    print(f"      Kịch bản: {script_file}")

    if opts.script_only:
        print("✅ Đã lưu kịch bản. Sửa file rồi chạy lại với --script để render video.")
        return script_file

    print("[2/4] Tìm & tải ảnh minh họa (song song) ...")
    images = _prepare_images(script, work_dir, settings, size, orientation)

    print(f"[3/4] Tạo giọng đọc ({voice}, tốc độ {rate}) ...")
    audio = _prepare_audio(script, work_dir, voice, rate)

    font = settings.font_path
    scenes = [
        Scene(
            image_path=images[0],
            audio_path=audio.get("intro"),
            narration=script.intro,
            overlays=[render_title_card(script.title, "Hướng dẫn từng bước", size, font)],
        )
    ]
    for i, step in enumerate(script.steps):
        scenes.append(
            Scene(
                image_path=images[i],
                audio_path=audio[f"step_{i + 1:02d}"],
                narration=step.narration,
                overlays=[render_step_badge(f"Bước {i + 1}", step.heading, size, font)],
            )
        )
    if script.outro:
        scenes.append(
            Scene(
                image_path=images[-1],
                audio_path=audio["outro"],
                narration=script.outro,
                overlays=[render_step_badge("Hoàn thành", "", size, font)],
            )
        )

    print(f"[4/4] Dựng video {layout} ({len(scenes)} cảnh) ...")
    if bg_video:
        print(f"      Video nền: {bg_video}")
    final_out = Path(out_path) if out_path else work_dir / f"{slugify(script.title)}.mp4"
    final_out.parent.mkdir(parents=True, exist_ok=True)
    build_video(
        scenes,
        final_out,
        aspect=opts.aspect,
        music_path=opts.music,
        music_volume=opts.music_volume,
        font_override=font,
        work_dir=work_dir,
        bg_video=bg_video,
    )
    print(f"✅ Hoàn tất! Video: {final_out.resolve()}")
    return final_out
