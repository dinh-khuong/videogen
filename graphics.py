"""Vẽ các lớp đồ họa bằng Pillow: phụ đề, nhãn bước, title card, ảnh dự phòng."""
import math
import re
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT_CANDIDATES = {
    "bold": [
        "/usr/share/fonts/google-noto/NotoSans-Bold.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
        "/usr/share/fonts/noto/NotoSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
    ],
    "regular": [
        "/usr/share/fonts/google-noto/NotoSans-Medium.ttf",
        "/usr/share/fonts/google-noto/NotoSans-Regular.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
        "/usr/share/fonts/noto/NotoSans-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ],
}


@lru_cache(maxsize=None)
def find_font(weight: str, override: str | None = None) -> str | None:
    if override and Path(override).exists():
        return override
    for path in FONT_CANDIDATES[weight]:
        if Path(path).exists():
            return path
    if shutil.which("fc-match"):
        style = "bold" if weight == "bold" else "regular"
        result = subprocess.run(
            ["fc-match", f"sans:{style}:lang=vi", "-f", "%{file}"],
            capture_output=True, text=True, check=False,
        )
        if result.stdout and Path(result.stdout).exists():
            return result.stdout
    return None


@lru_cache(maxsize=None)
def load_font(weight: str, size: int, override: str | None = None) -> ImageFont.FreeTypeFont:
    path = find_font(weight, override)
    if path:
        return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def wrap_text(text: str, font: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    lines: list[str] = []
    current = ""
    for word in text.split():
        candidate = f"{current} {word}".strip()
        if font.getlength(candidate) <= max_width or not current:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def wrap_balanced(text: str, font: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    """Như wrap_text nhưng chia các dòng dài gần bằng nhau (tránh chữ mồ côi)."""
    lines = wrap_text(text, font, max_width)
    if len(lines) < 2:
        return lines
    width = font.getlength(text) / len(lines)
    while width < max_width:
        candidate = wrap_text(text, font, int(width))
        if len(candidate) == len(lines):
            return candidate
        width *= 1.04
    return lines


def split_subtitles(text: str, max_chars: int) -> list[str]:
    """Tách lời bình thành các đoạn phụ đề có độ dài cân bằng, ưu tiên ngắt sau dấu câu."""
    sentences = re.split(r"(?<=[.!?…])\s+", text.strip())
    chunks: list[str] = []
    for sentence in sentences:
        if len(sentence) <= max_chars:
            chunks.append(sentence)
            continue
        n = math.ceil(len(sentence) / max_chars)
        target = len(sentence) / n
        parts: list[str] = []
        current = ""
        for word in sentence.split():
            current = f"{current} {word}".strip()
            if len(parts) < n - 1 and (
                len(current) >= target or (current[-1] in ",;:" and len(current) >= target * 0.65)
            ):
                parts.append(current)
                current = ""
        if current:
            parts.append(current)
        chunks.extend(parts)
    return [c for c in chunks if c]


def cover_fit(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Resize + crop ảnh để phủ kín khung `size` (giữ tỉ lệ)."""
    target_w, target_h = size
    scale = max(target_w / img.width, target_h / img.height)
    new_size = (round(img.width * scale), round(img.height * scale))
    img = img.resize(new_size, Image.LANCZOS)
    left = (img.width - target_w) // 2
    top = (img.height - target_h) // 2
    return img.crop((left, top, left + target_w, top + target_h))


def blurred_backdrop(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Nền mờ phủ khung + ảnh gốc đặt giữa (dùng cho ảnh có tỉ lệ khác khung, vd khung dọc)."""
    backdrop = cover_fit(img, size).filter(ImageFilter.GaussianBlur(radius=size[0] // 30))
    backdrop = Image.blend(backdrop, Image.new("RGB", size, (0, 0, 0)), 0.35)
    fg = img.copy()
    fg.thumbnail(size, Image.LANCZOS)
    backdrop.paste(fg, ((size[0] - fg.width) // 2, (size[1] - fg.height) // 2))
    return backdrop


def prepare_background(image_path: Path, size: tuple[int, int]) -> Image.Image:
    img = Image.open(image_path).convert("RGB")
    frame_ratio = size[0] / size[1]
    img_ratio = img.width / img.height
    # Nếu tỉ lệ ảnh lệch nhiều so với khung (vd ảnh ngang trong video dọc) thì dùng nền mờ
    if abs(img_ratio - frame_ratio) / frame_ratio > 0.45:
        return blurred_backdrop(img, size)
    return cover_fit(img, size)


def make_placeholder(text: str, dest_path: Path, size: tuple[int, int], font_override: str | None) -> Path:
    """Ảnh nền gradient + chữ, dùng khi không tìm được ảnh phù hợp."""
    w, h = size
    img = Image.new("RGB", size)
    draw = ImageDraw.Draw(img)
    top, bottom = (36, 59, 85), (20, 30, 48)
    for y in range(h):
        ratio = y / h
        color = tuple(round(top[i] * (1 - ratio) + bottom[i] * ratio) for i in range(3))
        draw.line([(0, y), (w, y)], fill=color)
    font = load_font("bold", max(28, min(w, h) // 11), font_override)
    lines = wrap_balanced(text, font, int(w * 0.8))
    line_h = font.size * 1.3
    y = (h - line_h * len(lines)) / 2
    for line in lines:
        draw.text((w / 2, y), line, font=font, fill=(240, 240, 240), anchor="ma")
        y += line_h
    img.save(dest_path, "JPEG", quality=92)
    return dest_path


def _rounded_box(draw: ImageDraw.ImageDraw, box, radius: int, fill) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def render_subtitle(text: str, size: tuple[int, int], font_override: str | None) -> Image.Image:
    """Lớp RGBA trong suốt chứa phụ đề ở phía dưới khung hình."""
    w, h = size
    base = min(w, h)
    font = load_font("regular", max(20, round(base * 0.052)), font_override)
    lines = wrap_balanced(text, font, int(w * 0.84))
    line_h = round(font.size * 1.32)
    pad_x, pad_y = round(font.size * 0.7), round(font.size * 0.45)
    text_w = max(font.getlength(line) for line in lines)
    box_w = text_w + pad_x * 2
    box_h = line_h * len(lines) + pad_y * 2
    bottom_margin = round(h * (0.14 if h > w else 0.07))

    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    x0 = (w - box_w) / 2
    y0 = h - bottom_margin - box_h
    _rounded_box(draw, (x0, y0, x0 + box_w, y0 + box_h), round(font.size * 0.4), (0, 0, 0, 170))
    y = y0 + pad_y
    for line in lines:
        draw.text((w / 2, y), line, font=font, fill=(255, 255, 255, 255), anchor="ma")
        y += line_h
    return layer


def render_step_badge(
    label: str, heading: str, size: tuple[int, int], font_override: str | None
) -> Image.Image:
    """Nhãn góc trên trái: 'Bước N' + tên bước."""
    w, h = size
    base = min(w, h)
    label_font = load_font("bold", max(18, round(base * 0.042)), font_override)
    head_font = load_font("bold", max(18, round(base * 0.042)), font_override)
    margin = round(base * 0.045)
    pad_x, pad_y = round(label_font.size * 0.6), round(label_font.size * 0.35)

    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    label_w = label_font.getlength(label) + pad_x * 2
    box_h = label_font.size + pad_y * 2
    x0, y0 = margin, margin
    _rounded_box(draw, (x0, y0, x0 + label_w, y0 + box_h), round(box_h * 0.3), (233, 84, 32, 235))
    draw.text((x0 + pad_x, y0 + box_h / 2), label, font=label_font, fill="white", anchor="lm")

    if heading:
        max_head_w = w - (x0 + label_w) - margin * 2
        heading_lines = wrap_text(heading, head_font, int(max_head_w))[:1]
        head_text = heading_lines[0] if heading_lines else heading
        hx0 = x0 + label_w + round(pad_x * 0.5)
        head_w = head_font.getlength(head_text) + pad_x * 2
        _rounded_box(draw, (hx0, y0, hx0 + head_w, y0 + box_h), round(box_h * 0.3), (0, 0, 0, 160))
        draw.text((hx0 + pad_x, y0 + box_h / 2), head_text, font=head_font, fill="white", anchor="lm")
    return layer


def render_title_card(
    title: str, subtitle: str, size: tuple[int, int], font_override: str | None
) -> Image.Image:
    """Lớp RGBA: phủ tối toàn khung + tiêu đề lớn ở giữa."""
    w, h = size
    base = min(w, h)
    layer = Image.new("RGBA", size, (0, 0, 0, 150))
    draw = ImageDraw.Draw(layer)

    title_font = load_font("bold", max(32, round(base * 0.09)), font_override)
    sub_font = load_font("regular", max(18, round(base * 0.045)), font_override)
    lines = wrap_balanced(title, title_font, int(w * 0.85))
    line_h = round(title_font.size * 1.2)
    total_h = line_h * len(lines) + (sub_font.size * 2 if subtitle else 0)
    y = (h - total_h) / 2
    for line in lines:
        draw.text((w / 2, y), line, font=title_font, fill="white", anchor="ma")
        y += line_h

    if subtitle:
        bar_w = round(base * 0.12)
        y += round(sub_font.size * 0.4)
        draw.rectangle((w / 2 - bar_w / 2, y, w / 2 + bar_w / 2, y + max(3, base // 200)), fill=(233, 84, 32))
        y += round(sub_font.size * 0.7)
        draw.text((w / 2, y), subtitle, font=sub_font, fill=(230, 230, 230), anchor="ma")
    return layer
