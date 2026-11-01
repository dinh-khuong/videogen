"""Đọc thông tin file media (kích thước, thời lượng) và tạo ảnh thumbnail. Dùng khi web app nhận file tải lên."""
import json
import re
import subprocess
from pathlib import Path

from PIL import Image, ImageOps

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"}
AUDIO_EXTS = {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".flac", ".opus"}


def ffmpeg_exe() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def video_info(path: Path) -> dict:
    # ffmpeg -i in thông tin ra stderr và thoát mã 1 vì không có output — đó là bình thường
    out = subprocess.run([ffmpeg_exe(), "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
    info: dict = {"kind": "video"}
    m = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", out)
    if m:
        info["duration"] = round(int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3]), 2)
    m = re.search(r"Stream #.*Video: .*?(\d{2,5})x(\d{2,5})", out)
    if m:
        info["width"], info["height"] = int(m[1]), int(m[2])
    rotate = re.search(r"rotate\s*:\s*(-?\d+)|rotation of (-?[\d.]+)", out)
    if rotate:
        info["rotation"] = round(float(rotate[1] or rotate[2])) % 360
    if info.get("rotation") and info.get("width") and info["rotation"] % 180 == 90:
        info["width"], info["height"] = info["height"], info["width"]
    if "duration" not in info:
        raise ValueError("Không đọc được video (định dạng không hỗ trợ hoặc file hỏng).")
    return info


def audio_info(path: Path) -> dict:
    out = subprocess.run([ffmpeg_exe(), "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
    m = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", out)
    if not m or not re.search(r"Stream #.*Audio:", out):
        raise ValueError("Không đọc được audio (định dạng không hỗ trợ hoặc file hỏng).")
    return {"kind": "audio", "duration": round(int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3]), 2)}


def _audio_thumbnail(path: Path, out: Path) -> None:
    """Ảnh dạng sóng âm làm thumbnail cho audio."""
    wave = out.with_suffix(".wave.png")
    subprocess.run(
        [ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y", "-i", str(path), "-filter_complex",
         "aformat=channel_layouts=mono,showwavespic=s=640x200:colors=0xF97316:scale=sqrt", "-frames:v", "1", str(wave)],
        check=True, capture_output=True,
    )
    with Image.open(wave) as w:
        canvas = Image.new("RGB", (640, 480), (24, 24, 27))
        canvas.paste(w.convert("RGBA"), (0, 140), w.convert("RGBA"))
        canvas.save(out, "JPEG", quality=85)
    wave.unlink(missing_ok=True)


def _video_thumbnail(path: Path, duration: float, out: Path) -> None:
    t = min(1.0, duration / 3)
    subprocess.run(
        [ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{t:.2f}", "-i", str(path),
         "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", str(out)],
        check=True, capture_output=True,
    )


def probe(path: Path, thumbnail: Path | None = None) -> dict:
    if path.suffix.lower() in IMAGE_EXTS:
        with Image.open(path) as img:
            img = ImageOps.exif_transpose(img)
            info = {"kind": "image", "width": img.width, "height": img.height}
            if thumbnail:
                thumb = img.convert("RGB")
                thumb.thumbnail((640, 640))
                thumb.save(thumbnail, "JPEG", quality=85)
                info["thumbnail"] = str(thumbnail)
        return info
    if path.suffix.lower() in AUDIO_EXTS:
        info = audio_info(path)
        if thumbnail:
            try:
                _audio_thumbnail(path, thumbnail)
                info["thumbnail"] = str(thumbnail)
            except (subprocess.CalledProcessError, OSError):
                pass  # thumbnail chỉ để xem, không bắt buộc
        return info
    info = video_info(path)
    if thumbnail:
        _video_thumbnail(path, info["duration"], thumbnail)
        info["thumbnail"] = str(thumbnail)
    return info


def probe_json(paths: list[Path], thumbnail_dir: Path | None) -> int:
    """In một mảng JSON, mỗi phần tử ứng với một file (có khóa "error" nếu file đó lỗi).

    Thumbnail lưu tại <thumbnail_dir>/<tên file không đuôi>.jpg.
    """
    if thumbnail_dir:
        thumbnail_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for path in paths:
        try:
            thumb = thumbnail_dir / f"{path.stem}.jpg" if thumbnail_dir else None
            results.append({"file": str(path), **probe(path, thumb)})
        except Exception as e:
            results.append({"file": str(path), "error": f"{type(e).__name__}: {e}"})
    print(json.dumps(results, ensure_ascii=False))
    return 0 if all("error" not in r for r in results) else 1
