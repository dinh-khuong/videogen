"""Đọc thông tin file media (kích thước, thời lượng) và tạo ảnh thumbnail. Dùng khi web app nhận file tải lên."""
import json
import re
import subprocess
from pathlib import Path

from PIL import Image, ImageOps

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}


def _ffmpeg() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def _video_info(path: Path) -> dict:
    # ffmpeg -i in thông tin ra stderr và thoát mã 1 vì không có output — đó là bình thường
    out = subprocess.run([_ffmpeg(), "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
    info: dict = {"kind": "video"}
    m = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", out)
    if m:
        info["duration"] = round(int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3]), 2)
    m = re.search(r"Stream #.*Video: .*?(\d{2,5})x(\d{2,5})", out)
    if m:
        info["width"], info["height"] = int(m[1]), int(m[2])
    rotate = re.search(r"rotate\s*:\s*(-?\d+)|rotation of (-?[\d.]+)", out)
    if rotate and info.get("width") and abs(round(float(rotate[1] or rotate[2]))) % 180 == 90:
        info["width"], info["height"] = info["height"], info["width"]
    if "duration" not in info:
        raise ValueError("Không đọc được video (định dạng không hỗ trợ hoặc file hỏng).")
    return info


def _video_thumbnail(path: Path, duration: float, out: Path) -> None:
    t = min(1.0, duration / 3)
    subprocess.run(
        [_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{t:.2f}", "-i", str(path),
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
    info = _video_info(path)
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
