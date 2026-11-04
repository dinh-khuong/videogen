"""Chạy một job từ file spec JSON — giao tiếp giữa web app và engine.

Spec (mọi trường trừ work_dir đều tùy chọn; cần topic hoặc script):
{
  "work_dir": "/abs/thư/mục/job",          # nơi lưu kịch bản, ảnh, audio, video, result.json
  "topic": "cách pha cà phê phin",
  "script": {...},                          # kịch bản có sẵn (bỏ qua LLM), cùng cấu trúc script.json
  "num_steps": 5, "language": "tiếng Việt", "voice": null, "rate": null,
  "voice2": null,                           # giọng thứ hai đọc xen kẽ các bước chẵn
  "pitch": "+0Hz",                          # cao độ giọng, vd "+5Hz" / "-8Hz"
  "voice_effect": "none",                   # none | cute | chipmunk | deep | robot | radio | echo
  "ai_voice": false,                        # cho AI tinh chỉnh cao độ/tốc độ giọng cho hợp video (quanh rate/pitch)
                                            # voice có thể là "gtts:vi" (chị Google) hoặc "fpt:banmaiace" (FPT.AI), "zerotts:maichi" (ZeroTTS)
  "video_type": "howto",                    # howto | listicle | tips | facts | promo | story
  "tone": "hài hước",                       # giọng văn (tùy ý)
  "writing_style": "auto",                  # auto | narrator | essay | dialogue (hai nhân vật) | comedy
  "length": "medium",                       # short | medium | long
  "style": {"pacing": "normal",             # slow | normal | fast
            "transition": "mix",            # mix | fade | slide | zoom | whip | wipe | circle | flash
            "subtitle_style": "auto",       # auto | box | karaoke | outline | none
            "color_filter": "none",         # none | vivid | warm | cool | cinematic | vintage | bw
            "accent": "#e95420", "progress_bar": false, "sfx": false,
            "logo": "/abs/logo.png", "cta": "Gọi ngay 0909 123 456"},
  "aspect": "16:9",                         # 16:9 | 9:16 | 1:1
  "bg_video": "/abs/gameplay.mp4",          # có -> bố cục 9:16 chia đôi
  "music": "/abs/nhac.mp3", "music_volume": 0.12,
  "image_style": "auto",                    # auto | cover | frame
  "web_images": true,                      # tìm nội dung trên mạng cho bước chưa có asset
  "web_media": "image",                     # image | video (clip CC/stock) | auto (LLM chọn từng bước)
  "search_engine": "auto",                  # công cụ tìm ảnh ưu tiên: auto | duckduckgo | google | brave | serper
                                            #   | pexels | pixabay (nguồn khác làm dự phòng)
  "clips_per_step": 3,                      # số clip ghép nối tiếp trong một bước dùng video
  "visual_interval": 0,                     # tần suất đổi hình: cứ N giây đổi ảnh/clip mới (0 = tự động); không nhanh
                                            #   hơn đoạn hình ngắn nhất của nhịp dựng (style.pacing)
  "meme_images": null, "meme_videos": null, # Đạo diễn AI: số ảnh meme / clip meme trong video (null = AI quyết định, 0 = không dùng)
  "library_mode": "off",                    # off | auto | selected
  "director": false,                        # Đạo diễn AI: tự lên kịch bản qua nhiều lượt gọi công cụ, meme, giọng biến hóa
  "feedback": "",                           # góp ý của người dùng để Đạo diễn AI sửa bản trước
  "base_script": {...},                     # kịch bản của bản trước (đi kèm feedback)
  "library": [{"id": "...", "path": "/abs/anh.jpg", "kind": "image",   # asset ảnh/video của người dùng
               "description": "...", "tags": ["..."],
               "summary": "tóm tắt AI", "ocr_text": "chữ trong asset", "duration": null}],
  "sounds": [{"id": "...", "path": "/abs/tieng.mp3", "description": "...", "tags": [],   # âm thanh ngắn Đạo diễn AI gắn vào
              "summary": "...", "duration": 1.5}]                                        #   câu thoại (khác nhạc nền "music")
}

Kết quả: <work_dir>/result.json (xem RunResult.to_dict) và sự kiện {"type": "result"} trên stdout.
"""
import json
import traceback
from pathlib import Path

from .config import ConfigError
from .events import DIRECTOR_STAGES, JsonReporter
from .image_search import SEARCH_ENGINES
from .llm import LibraryAsset
from .pipeline import IMAGE_STYLES, LIBRARY_MODES, WEB_MEDIA, Options, run
from .style import VIDEO_TYPES, Style
from .tts import VOICE_EFFECTS
from .video_builder import ASPECTS
from .writing import WRITING_STYLES


def _count(value, limit: int = 20) -> int | None:
    """Số lượng người dùng đặt (None = để AI quyết định), giới hạn 0..limit."""
    if value is None or value == "":
        return None
    return min(max(int(value), 0), limit)


def _options(spec: dict, reporter: JsonReporter) -> Options:
    aspect = spec.get("aspect") or "16:9"
    if aspect not in ASPECTS:
        raise ValueError(f"aspect không hợp lệ: {aspect}")
    image_style = spec.get("image_style") or "auto"
    if image_style not in IMAGE_STYLES:
        raise ValueError(f"image_style không hợp lệ: {image_style}")
    web_media = spec.get("web_media") or "image"
    if web_media not in WEB_MEDIA:
        raise ValueError(f"web_media không hợp lệ: {web_media}")
    search_engine = spec.get("search_engine") or "auto"
    if search_engine not in SEARCH_ENGINES:
        raise ValueError(f"search_engine không hợp lệ: {search_engine}")
    library_mode = spec.get("library_mode") or "off"
    if library_mode not in LIBRARY_MODES:
        raise ValueError(f"library_mode không hợp lệ: {library_mode}")

    def optional_path(key: str, source: dict | None = None) -> Path | None:
        value = (spec if source is None else source).get(key)
        if not value:
            return None
        path = Path(value)
        if not path.exists():
            raise FileNotFoundError(f"Không tìm thấy {key}: {path}")
        return path

    video_type = spec.get("video_type") or "howto"
    if video_type not in VIDEO_TYPES:
        raise ValueError(f"video_type không hợp lệ: {video_type}")
    writing = spec.get("writing_style") or "auto"
    if writing not in WRITING_STYLES:
        raise ValueError(f"writing_style không hợp lệ: {writing}")
    voice_effect = spec.get("voice_effect") or "none"
    if voice_effect not in VOICE_EFFECTS:
        raise ValueError(f"voice_effect không hợp lệ: {voice_effect}")
    style_spec = spec.get("style") or {}
    style = Style(
        pacing=style_spec.get("pacing") or "normal",
        transition=style_spec.get("transition") or "mix",
        subtitle_style=style_spec.get("subtitle_style") or "auto",
        color_filter=style_spec.get("color_filter") or "none",
        accent=style_spec.get("accent"),
        progress_bar=bool(style_spec.get("progress_bar")),
        sfx=bool(style_spec.get("sfx")),
        logo=optional_path("logo", style_spec),
        cta=style_spec.get("cta") or "",
    )

    return Options(
        aspect=aspect,
        num_steps=int(spec["num_steps"]) if spec.get("num_steps") else None,
        language=spec.get("language") or "tiếng Việt",
        voice=spec.get("voice") or None,
        voice2=spec.get("voice2") or None,
        rate=spec.get("rate") or None,
        pitch=spec.get("pitch") or None,
        voice_effect=voice_effect,
        ai_voice=bool(spec.get("ai_voice")),
        video_type=video_type,
        tone=spec.get("tone") or "",
        writing_style=writing,
        length=spec.get("length") if spec.get("length") in ("short", "medium", "long") else "medium",
        style=style,
        music=optional_path("music"),
        music_volume=float(spec.get("music_volume") or 0.12),
        bg_video=optional_path("bg_video"),
        image_style=image_style,
        web_images=bool(spec.get("web_images", True)),
        web_media=web_media,
        search_engine=search_engine,
        clips_per_step=min(max(int(spec.get("clips_per_step") or 3), 1), 6),
        visual_interval=min(max(float(spec.get("visual_interval") or 0), 0.0), 30.0),
        meme_images=_count(spec.get("meme_images")),
        meme_videos=_count(spec.get("meme_videos")),
        library=[
            LibraryAsset(
                id=str(item["id"]),
                path=str(item["path"]),
                description=item.get("description") or "",
                tags=list(item.get("tags") or []),
                kind="video" if item.get("kind") == "video" else "image",
                summary=item.get("summary") or "",
                ocr_text=item.get("ocr_text") or "",
                duration=float(item["duration"]) if item.get("duration") else None,
            )
            for item in spec.get("library") or []
        ],
        sounds=[
            LibraryAsset(
                id=str(item["id"]),
                path=str(item["path"]),
                description=item.get("description") or "",
                tags=list(item.get("tags") or []),
                kind="audio",
                summary=item.get("summary") or "",
                duration=float(item["duration"]) if item.get("duration") else None,
            )
            for item in spec.get("sounds") or []
        ],
        library_mode=library_mode,
        work_dir=Path(spec["work_dir"]),
        reporter=reporter,
        director=bool(spec.get("director")) and not spec.get("script"),
        feedback=" ".join(str(spec.get("feedback") or "").split())[:2000],
        base_script=spec.get("base_script") if isinstance(spec.get("base_script"), dict) else None,
    )


def run_job(spec_path: Path) -> int:
    reporter = JsonReporter()
    try:
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
        if not spec.get("work_dir"):
            raise ValueError("Spec thiếu work_dir")
        if not spec.get("topic") and not spec.get("script"):
            raise ValueError("Spec cần topic hoặc script")
        opts = _options(spec, reporter)
        if opts.director:
            reporter.stages = DIRECTOR_STAGES
        work_dir = opts.work_dir
        result = run(
            spec.get("topic"),
            str(work_dir / "video.mp4"),
            None,
            opts,
            script_data=spec.get("script"),
        )
        data = result.to_dict()
        (work_dir / "result.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        reporter.emit("result", result=data)
        return 0
    except ConfigError as e:
        reporter.emit("error", message=f"Lỗi cấu hình: {e}")
        return 2
    except KeyboardInterrupt:
        reporter.emit("error", message="Đã hủy")
        return 130
    except Exception as e:  # báo lỗi gọn cho web, chi tiết vào log
        traceback.print_exc()
        reporter.emit("error", message=f"{type(e).__name__}: {e}")
        return 1
