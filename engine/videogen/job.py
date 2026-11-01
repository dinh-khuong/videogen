"""Chạy một job từ file spec JSON — giao tiếp giữa web app và engine.

Spec (mọi trường trừ work_dir đều tùy chọn; cần topic hoặc script):
{
  "work_dir": "/abs/thư/mục/job",          # nơi lưu kịch bản, ảnh, audio, video, result.json
  "topic": "cách pha cà phê phin",
  "script": {...},                          # kịch bản có sẵn (bỏ qua LLM), cùng cấu trúc script.json
  "num_steps": 5, "language": "tiếng Việt", "voice": null, "rate": null,
  "aspect": "16:9",                         # 16:9 | 9:16 | 1:1
  "bg_video": "/abs/gameplay.mp4",          # có -> bố cục 9:16 chia đôi
  "music": "/abs/nhac.mp3", "music_volume": 0.12,
  "image_style": "auto",                    # auto | cover | frame
  "web_images": true,
  "library_mode": "off",                    # off | auto | selected
  "library": [{"id": "...", "path": "/abs/anh.jpg", "kind": "image",   # asset ảnh/video của người dùng
               "description": "...", "tags": ["..."],
               "summary": "tóm tắt AI", "ocr_text": "chữ trong asset", "duration": null}]
}

Kết quả: <work_dir>/result.json (xem RunResult.to_dict) và sự kiện {"type": "result"} trên stdout.
"""
import json
import traceback
from pathlib import Path

from .config import ConfigError
from .events import JsonReporter
from .llm import LibraryAsset
from .pipeline import IMAGE_STYLES, LIBRARY_MODES, Options, run
from .video_builder import ASPECTS


def _options(spec: dict, reporter: JsonReporter) -> Options:
    aspect = spec.get("aspect") or "16:9"
    if aspect not in ASPECTS:
        raise ValueError(f"aspect không hợp lệ: {aspect}")
    image_style = spec.get("image_style") or "auto"
    if image_style not in IMAGE_STYLES:
        raise ValueError(f"image_style không hợp lệ: {image_style}")
    library_mode = spec.get("library_mode") or "off"
    if library_mode not in LIBRARY_MODES:
        raise ValueError(f"library_mode không hợp lệ: {library_mode}")

    def optional_path(key: str) -> Path | None:
        value = spec.get(key)
        if not value:
            return None
        path = Path(value)
        if not path.exists():
            raise FileNotFoundError(f"Không tìm thấy {key}: {path}")
        return path

    return Options(
        aspect=aspect,
        num_steps=int(spec["num_steps"]) if spec.get("num_steps") else None,
        language=spec.get("language") or "tiếng Việt",
        voice=spec.get("voice") or None,
        rate=spec.get("rate") or None,
        music=optional_path("music"),
        music_volume=float(spec.get("music_volume") or 0.12),
        bg_video=optional_path("bg_video"),
        image_style=image_style,
        web_images=bool(spec.get("web_images", True)),
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
        library_mode=library_mode,
        work_dir=Path(spec["work_dir"]),
        reporter=reporter,
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
