"""Vẽ các lớp đồ họa bằng Pillow: phụ đề (nhiều kiểu), nhãn bước, title card, lời kêu gọi, logo, ảnh dự phòng."""
import shutil
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

from .effects import Layer
from .style import DEFAULT_ACCENT, NON_LATIN, text_color_on

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

_CJK = {
    "bold": [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/google-noto-sans-cjk-fonts/NotoSansCJK-Bold.ttc",
    ],
    "regular": [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/google-noto-sans-cjk-fonts/NotoSansCJK-Regular.ttc",
    ],
}
# Font cho chữ không phải Latin (chữ Hán, Kana, Hangul, chữ Thái)
NON_LATIN_FONTS = {
    "zh": {"bold": _CJK["bold"] + ["/System/Library/Fonts/PingFang.ttc", "C:/Windows/Fonts/msyhbd.ttc"],
           "regular": _CJK["regular"] + ["/System/Library/Fonts/PingFang.ttc", "C:/Windows/Fonts/msyh.ttc"]},
    "ja": {"bold": _CJK["bold"] + ["/System/Library/Fonts/Hiragino Sans GB.ttc", "C:/Windows/Fonts/meiryob.ttc"],
           "regular": _CJK["regular"] + ["/System/Library/Fonts/Hiragino Sans GB.ttc", "C:/Windows/Fonts/meiryo.ttc"]},
    "ko": {"bold": _CJK["bold"] + ["/System/Library/Fonts/AppleSDGothicNeo.ttc", "C:/Windows/Fonts/malgunbd.ttf"],
           "regular": _CJK["regular"] + ["/System/Library/Fonts/AppleSDGothicNeo.ttc", "C:/Windows/Fonts/malgun.ttf"]},
    "th": {"bold": ["/usr/share/fonts/truetype/noto/NotoSansThai-Bold.ttf", "/usr/share/fonts/google-noto/NotoSansThai-Bold.ttf",
                    "/usr/share/fonts/noto/NotoSansThai-Bold.ttf", "C:/Windows/Fonts/tahomabd.ttf"],
           "regular": ["/usr/share/fonts/truetype/noto/NotoSansThai-Regular.ttf", "/usr/share/fonts/google-noto/NotoSansThai-Regular.ttf",
                       "/usr/share/fonts/noto/NotoSansThai-Regular.ttf", "C:/Windows/Fonts/tahoma.ttf"]},
}


@dataclass(frozen=True)
class Fonts:
    regular: str | None
    bold: str | None

    def get(self, weight: str, size: int) -> ImageFont.FreeTypeFont:
        return load_font(self.bold if weight == "bold" else self.regular, size)


def _first_existing(paths: list[str]) -> str | None:
    return next((p for p in paths if Path(p).exists()), None)


@lru_cache(maxsize=None)
def find_font(weight: str, override: str | None = None) -> str | None:
    if override and Path(override).exists():
        return override
    path = _first_existing(FONT_CANDIDATES[weight])
    if path:
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


def _fc_font_for(lang: str, weight: str) -> str | None:
    """Font cài trên máy có hỗ trợ ngôn ngữ `lang` (fontconfig)."""
    if not shutil.which("fc-list"):
        return None
    out = subprocess.run(["fc-list", f":lang={lang}", "file", "style"], capture_output=True, text=True, check=False).stdout
    fonts = []
    for line in out.splitlines():
        path, _, style = line.partition(":")
        if Path(path.strip()).exists():
            fonts.append((path.strip(), style.lower()))
    if not fonts:
        return None
    if weight == "bold":
        bold = [p for p, s in fonts if "bold" in s]
        if bold:
            return sorted(bold)[0]
    regular = [p for p, s in fonts if "regular" in s or "book" in s or "medium" in s]
    return sorted(regular or [p for p, _ in fonts])[0]


@lru_cache(maxsize=None)
def resolve_fonts(override: str | None = None, lang: str = "vi") -> Fonts:
    """Font chữ thường/đậm cho ngôn ngữ của video (FONT_PATH ghi đè cả hai)."""
    if override and Path(override).exists():
        return Fonts(override, override)
    if lang in NON_LATIN:
        candidates = NON_LATIN_FONTS.get(lang, {})
        regular = _first_existing(candidates.get("regular", [])) or _fc_font_for(lang, "regular")
        bold = _first_existing(candidates.get("bold", [])) or _fc_font_for(lang, "bold")
        if regular or bold:
            return Fonts(regular or bold, bold or regular)
        print(f"      ⚠️  Không tìm thấy font cho ngôn ngữ '{lang}': chữ có thể hiển thị lỗi. Đặt FONT_PATH.", flush=True)
    return Fonts(find_font("regular"), find_font("bold"))


@lru_cache(maxsize=None)
def load_font(path: str | None, size: int) -> ImageFont.FreeTypeFont:
    if path:
        return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


# ===== Xuống dòng =====


def _break_long(word: str, font: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    """Từ dài hơn cả dòng (vd chữ Hán/Thái không có dấu cách) được ngắt theo ký tự."""
    if font.getlength(word) <= max_width:
        return [word]
    parts, current = [], ""
    for ch in word:
        if current and font.getlength(current + ch) > max_width:
            parts.append(current)
            current = ch
        else:
            current += ch
    if current:
        parts.append(current)
    return parts


def wrap_text(text: str, font: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    lines: list[str] = []
    current = ""
    for word in text.split():
        for k, piece in enumerate(_break_long(word, font, max_width)):
            joiner = " " if k == 0 and current else ""
            candidate = f"{current}{joiner}{piece}"
            if font.getlength(candidate) <= max_width or not current:
                current = candidate
            else:
                lines.append(current)
                current = piece
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


# ===== Ảnh nền / khung nội dung =====


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


def frame_layout(content_size: tuple[int, int], size: tuple[int, int]) -> tuple[int, int, int, int, int]:
    """Vị trí (x, y, rộng, cao, bo góc) của nội dung hiển thị trọn vẹn trong khung.

    Chừa khoảng phía trên cho nhãn bước và phía dưới cho phụ đề.
    """
    w, h = size
    # Phụ đề 2 dòng chiếm ~25% chiều cao khung (gần vuông/dọc) -> chừa chỗ để không che nội dung
    top, bottom = round(h * 0.14), round(h * (0.25 if h > w * 0.85 else 0.2))
    side = round(w * 0.06)
    box_w, box_h = w - side * 2, h - top - bottom
    scale = min(box_w / content_size[0], box_h / content_size[1])
    fw, fh = max(2, round(content_size[0] * scale / 2) * 2), max(2, round(content_size[1] * scale / 2) * 2)
    x = (w - fw) // 2
    y = top + (box_h - fh) // 2
    return x, y, fw, fh, max(6, round(min(w, h) * 0.022))


def framed_backdrop(img: Image.Image, size: tuple[int, int], content_size: tuple[int, int] | None = None):
    """Nền mờ tối từ img + bóng đổ của khung nội dung. Trả về (nền, (x, y, rộng, cao), mặt nạ bo góc)."""
    w, h = size
    backdrop = cover_fit(img, size).filter(ImageFilter.GaussianBlur(radius=max(8, w // 25)))
    backdrop = Image.blend(backdrop, Image.new("RGB", size, (12, 14, 20)), 0.55)
    x, y, fw, fh, radius = frame_layout(content_size or img.size, size)

    shadow = Image.new("L", size, 0)
    offset = max(4, min(w, h) // 90)
    ImageDraw.Draw(shadow).rounded_rectangle((x + offset, y + offset * 2, x + fw + offset, y + fh + offset * 2), radius, fill=170)
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=offset * 3))
    backdrop.paste(Image.new("RGB", size, (0, 0, 0)), (0, 0), shadow)

    mask = Image.new("L", (fw, fh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, fw - 1, fh - 1), radius, fill=255)
    return backdrop, (x, y, fw, fh), mask


def framed_content(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Ảnh là nội dung chính: hiển thị trọn vẹn (không cắt) trong khung bo góc có bóng, trên nền mờ."""
    backdrop, (x, y, fw, fh), mask = framed_backdrop(img, size)
    backdrop.paste(img.resize((fw, fh), Image.LANCZOS), (x, y), mask)
    return backdrop


def prepare_background(image_path: Path, size: tuple[int, int], style: str = "cover") -> Image.Image:
    """style='cover': ảnh phủ kín khung (làm nền); style='frame': ảnh hiển thị trọn vẹn làm nội dung chính."""
    img = ImageOps.exif_transpose(Image.open(image_path)).convert("RGB")
    if style == "frame":
        return framed_content(img, size)
    frame_ratio = size[0] / size[1]
    img_ratio = img.width / img.height
    # Nếu tỉ lệ ảnh lệch nhiều so với khung (vd ảnh ngang trong video dọc) thì dùng nền mờ
    if abs(img_ratio - frame_ratio) / frame_ratio > 0.45:
        return blurred_backdrop(img, size)
    return cover_fit(img, size)


def make_placeholder(text: str, dest_path: Path, size: tuple[int, int], fonts: Fonts) -> Path:
    """Ảnh nền gradient + chữ, dùng khi không tìm được ảnh phù hợp."""
    w, h = size
    img = Image.new("RGB", size)
    draw = ImageDraw.Draw(img)
    top, bottom = (36, 59, 85), (20, 30, 48)
    for y in range(h):
        ratio = y / h
        color = tuple(round(top[i] * (1 - ratio) + bottom[i] * ratio) for i in range(3))
        draw.line([(0, y), (w, y)], fill=color)
    font = fonts.get("bold", max(28, min(w, h) // 11))
    lines = wrap_balanced(text, font, int(w * 0.8))
    line_h = font.size * 1.3
    y = (h - line_h * len(lines)) / 2
    for line in lines:
        draw.text((w / 2, y), line, font=font, fill=(240, 240, 240), anchor="ma")
        y += line_h
    img.save(dest_path, "JPEG", quality=92)
    return dest_path


# ===== Phụ đề =====


def _subtitle_bottom(size: tuple[int, int], big: bool) -> int:
    """Mép dưới của khối phụ đề (video dọc chừa chỗ cho thanh điều khiển của TikTok/Shorts)."""
    w, h = size
    if h > w:
        return h - round(h * (0.2 if big else 0.14))
    return h - round(h * (0.09 if big else 0.07))


def render_subtitle_box(text: str, size: tuple[int, int], fonts: Fonts) -> Image.Image:
    """Phụ đề chữ trắng trong khung tối bo góc ở phía dưới."""
    w, h = size
    font = fonts.get("regular", max(20, round(min(w, h) * 0.052)))
    lines = wrap_balanced(text, font, int(w * 0.84))
    line_h = round(font.size * 1.32)
    pad_x, pad_y = round(font.size * 0.7), round(font.size * 0.45)
    text_w = max(font.getlength(line) for line in lines)
    box_w = text_w + pad_x * 2
    box_h = line_h * len(lines) + pad_y * 2

    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    x0 = (w - box_w) / 2
    y0 = _subtitle_bottom(size, False) - box_h
    draw.rounded_rectangle((x0, y0, x0 + box_w, y0 + box_h), radius=round(font.size * 0.4), fill=(0, 0, 0, 170))
    y = y0 + pad_y
    for line in lines:
        draw.text((w / 2, y), line, font=font, fill=(255, 255, 255, 255), anchor="ma")
        y += line_h
    return layer


@dataclass(frozen=True)
class Word:
    text: str
    spaced: bool = True  # có dấu cách trước từ này (chữ Hán/Thái bị ngắt giữa chừng thì không)


def _karaoke_font(size: tuple[int, int], fonts: Fonts) -> ImageFont.FreeTypeFont:
    return fonts.get("bold", max(24, round(min(size) * 0.068)))


def _layout_words(words: list[Word], font: ImageFont.FreeTypeFont, max_width: int) -> list[list[int]]:
    """Chia các từ thành dòng, dòng dài gần bằng nhau. Trả về chỉ số từ của từng dòng."""
    space = font.getlength(" ")

    def greedy(limit: float) -> list[list[int]]:
        lines: list[list[int]] = [[]]
        width = 0.0
        for i, word in enumerate(words):
            wlen = font.getlength(word.text)
            extra = (space if word.spaced and lines[-1] else 0) + wlen
            if lines[-1] and width + extra > limit:
                lines.append([i])
                width = wlen
            else:
                lines[-1].append(i)
                width += extra
        return lines

    lines = greedy(max_width)
    if len(lines) < 2:
        return lines
    total = sum(font.getlength(w.text) for w in words) + space * len(words)
    limit = total / len(lines)
    while limit < max_width:
        candidate = greedy(limit)
        if len(candidate) == len(lines):
            return candidate
        limit *= 1.04
    return lines


def render_caption(
    words: list[Word], active: int | None, size: tuple[int, int], fonts: Fonts,
    accent: tuple[int, int, int] = DEFAULT_ACCENT,
) -> Image.Image:
    """Phụ đề kiểu mạng xã hội: chữ đậm lớn viền đen, không khung.

    active = chỉ số từ đang được đọc (kiểu karaoke): từ đó nằm trên nền màu chủ đạo. None = không đánh dấu.
    """
    w, h = size
    font = _karaoke_font(size, fonts)
    stroke = max(2, round(font.size * 0.12))
    lines = _layout_words(words, font, int(w * 0.86))
    space = font.getlength(" ")
    line_h = round(font.size * 1.28)
    ascent, descent = font.getmetrics()
    bottom = _subtitle_bottom(size, True)
    y = bottom - line_h * len(lines)

    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    text_on_accent = text_color_on(accent)
    for line in lines:
        widths = [font.getlength(words[i].text) for i in line]
        gaps = [space if (k > 0 and words[i].spaced) else 0 for k, i in enumerate(line)]
        x = (w - sum(widths) - sum(gaps)) / 2
        baseline = y + (line_h + ascent - descent) / 2
        for k, i in enumerate(line):
            x += gaps[k]
            if i == active:
                pad_x, pad_y = round(font.size * 0.16), round(font.size * 0.1)
                draw.rounded_rectangle(
                    (x - pad_x, baseline - ascent - pad_y, x + widths[k] + pad_x, baseline + descent * 0.6 + pad_y),
                    radius=round(font.size * 0.22), fill=(*accent, 255),
                )
                draw.text((x, baseline), words[i].text, font=font, fill=(*text_on_accent, 255), anchor="ls")
            else:
                draw.text((x, baseline), words[i].text, font=font, fill=(255, 255, 255, 255), anchor="ls",
                          stroke_width=stroke, stroke_fill=(0, 0, 0, 255))
            x += widths[k]
        y += line_h
    return layer


# ===== Nhãn bước, title card, lời kêu gọi, logo =====


def _ellipsize(text: str, font: ImageFont.FreeTypeFont, max_width: int) -> str:
    while text and font.getlength(text + "…") > max_width:
        text = text[:-1]
    return text.rstrip(" ,;:") + "…"


def render_step_badge(
    label: str, heading: str, size: tuple[int, int], fonts: Fonts, accent: tuple[int, int, int] = DEFAULT_ACCENT,
    reserve_right: int = 0,
) -> Image.Image:
    """Nhãn góc trên trái: 'Bước N' (màu chủ đạo) + tên bước (tối đa 2 dòng).

    Không có label thì tên bước nằm trên nền màu chủ đạo. reserve_right: chừa chỗ bên phải (vd cho logo).
    """
    w, h = size
    base = min(w, h)
    font = fonts.get("bold", max(18, round(base * 0.042)))
    margin = round(base * 0.045)
    pad_x, pad_y = round(font.size * 0.6), round(font.size * 0.35)
    box_h = font.size + pad_y * 2
    line_h = round(font.size * 1.25)
    radius = round(box_h * 0.3)
    fg = text_color_on(accent)

    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    x0, y0 = margin, margin
    if label:
        label_w = font.getlength(label) + pad_x * 2
        draw.rounded_rectangle((x0, y0, x0 + label_w, y0 + box_h), radius=radius, fill=(*accent, 240))
        draw.text((x0 + pad_x, y0 + box_h / 2), label, font=font, fill=fg, anchor="lm")
        x0 += label_w + round(pad_x * 0.5)
    if heading:
        max_text_w = int(w - x0 - margin - reserve_right - pad_x * 2)
        lines = wrap_balanced(heading, font, max_text_w)
        if len(lines) > 2:
            lines = [lines[0], _ellipsize(" ".join(lines[1:]), font, max_text_w)]
        head_w = max(font.getlength(line) for line in lines) + pad_x * 2
        head_h = box_h + line_h * (len(lines) - 1)
        fill, color = ((0, 0, 0, 160), "white") if label else ((*accent, 240), fg)
        draw.rounded_rectangle((x0, y0, x0 + head_w, y0 + head_h), radius=radius, fill=fill)
        for k, line in enumerate(lines):
            draw.text((x0 + pad_x, y0 + box_h / 2 + k * line_h), line, font=font, fill=color, anchor="lm")
    return layer


def title_layers(
    title: str, subtitle: str, size: tuple[int, int], fonts: Fonts, accent: tuple[int, int, int] = DEFAULT_ACCENT
) -> list[Layer]:
    """Title card động: nền tối hiện dần, từng dòng tiêu đề trồi lên lần lượt, gạch màu bật ra, dòng phụ hiện sau."""
    w, h = size
    base = min(w, h)
    layers: list[Layer] = [Layer(Image.new("RGBA", size, (0, 0, 0, 150)), (0, 0), enter="fade", enter_dur=0.45)]

    title_font = fonts.get("bold", max(32, round(base * 0.09)))
    sub_font = fonts.get("regular", max(18, round(base * 0.045)))
    lines = wrap_balanced(title, title_font, int(w * 0.85))
    line_h = round(title_font.size * 1.2)
    total_h = line_h * len(lines) + (sub_font.size * 2 if subtitle else 0)
    y = (h - total_h) / 2
    delay = 0.15
    for line in lines:
        canvas = Image.new("RGBA", size, (0, 0, 0, 0))
        ImageDraw.Draw(canvas).text((w / 2, y), line, font=title_font, fill="white", anchor="ma",
                                    stroke_width=max(1, title_font.size // 28), stroke_fill=(0, 0, 0, 120))
        layer = Layer.from_canvas(canvas, start=delay, enter="rise", enter_dur=0.5)
        if layer:
            layers.append(layer)
        delay += 0.1
        y += line_h

    if subtitle:
        bar_w = round(base * 0.12)
        y += round(sub_font.size * 0.4)
        bar = Image.new("RGBA", size, (0, 0, 0, 0))
        ImageDraw.Draw(bar).rectangle((w / 2 - bar_w / 2, y, w / 2 + bar_w / 2, y + max(3, base // 200)), fill=(*accent, 255))
        layer = Layer.from_canvas(bar, start=delay + 0.1, enter="pop", enter_dur=0.4)
        if layer:
            layers.append(layer)
        y += round(sub_font.size * 0.7)
        text = Image.new("RGBA", size, (0, 0, 0, 0))
        ImageDraw.Draw(text).text((w / 2, y), subtitle, font=sub_font, fill=(235, 235, 235), anchor="ma")
        layer = Layer.from_canvas(text, start=delay + 0.25, enter="fade", enter_dur=0.5)
        if layer:
            layers.append(layer)
    return layers


def cta_layer(text: str, size: tuple[int, int], fonts: Fonts, accent: tuple[int, int, int] = DEFAULT_ACCENT,
              start: float = 0.35) -> Layer | None:
    """Lời kêu gọi hành động (vd 'Đặt hàng ngay: 0909 123 456') trong nút màu chủ đạo ở giữa khung, bật ra rồi nhịp nhẹ."""
    w, h = size
    font = fonts.get("bold", max(22, round(min(w, h) * 0.06)))
    lines = wrap_balanced(text, font, int(w * 0.74))[:3]
    line_h = round(font.size * 1.25)
    pad_x, pad_y = round(font.size * 0.9), round(font.size * 0.55)
    box_w = max(font.getlength(line) for line in lines) + pad_x * 2
    box_h = line_h * len(lines) + pad_y * 2
    x0, y0 = (w - box_w) / 2, h * 0.46 - box_h / 2

    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    shadow = Image.new("RGBA", size, (0, 0, 0, 0))
    offset = max(3, round(font.size * 0.12))
    ImageDraw.Draw(shadow).rounded_rectangle((x0, y0 + offset, x0 + box_w, y0 + box_h + offset), radius=round(box_h * 0.3),
                                             fill=(0, 0, 0, 110))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(offset)))
    draw = ImageDraw.Draw(canvas)
    # Viền trắng để nút nổi bật cả khi nền cùng màu với màu chủ đạo
    draw.rounded_rectangle((x0, y0, x0 + box_w, y0 + box_h), radius=round(min(box_h * 0.3, font.size)), fill=(*accent, 250),
                           outline=(255, 255, 255, 235), width=max(2, round(font.size * 0.08)))
    y = y0 + pad_y
    fg = text_color_on(accent)
    for line in lines:
        draw.text((w / 2, y), line, font=font, fill=fg, anchor="ma")
        y += line_h
    return Layer.from_canvas(canvas, start=start, enter="pop", enter_dur=0.45, pulse=True)


def logo_layer(path: Path, frame_size: tuple[int, int]) -> Layer | None:
    """Logo ở góc trên phải, cạnh dài tối đa ~14% khung, hơi trong suốt."""
    try:
        img = ImageOps.exif_transpose(Image.open(path)).convert("RGBA")
    except OSError as e:
        print(f"      ⚠️  Không đọc được logo {path}: {e}", flush=True)
        return None
    w, h = frame_size
    side = round(min(w, h) * 0.14)
    img.thumbnail((side, side), Image.LANCZOS)
    alpha = img.getchannel("A").point(lambda v: round(v * 0.92))
    img.putalpha(alpha)
    margin = round(min(w, h) * 0.04)
    return Layer(img, (w - img.width - margin, margin))


# ===== Lớp meme (Đạo diễn AI) =====


def meme_caption_layers(top: str, bottom: str, size: tuple[int, int], fonts: Fonts, start: float = 0.0) -> list[Layer]:
    """Chữ meme kinh điển: IN HOA, trắng viền đen dày, dòng trên rơi xuống, dòng dưới trồi lên."""
    w, h = size
    font = fonts.get("bold", max(28, round(min(w, h) * 0.075)))
    stroke = max(2, round(font.size * 0.11))
    line_h = round(font.size * 1.12)
    margin = round(min(w, h) * 0.06)
    layers: list[Layer] = []
    for text, at_top in ((top, True), (bottom, False)):
        if not text:
            continue
        lines = wrap_balanced(text.upper(), font, int(w * 0.9))[:3]
        canvas = Image.new("RGBA", size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(canvas)
        # Dòng trên chừa chỗ cho nhãn ở góc trên; dòng dưới nằm trên vùng phụ đề
        y = margin * 2.2 if at_top else h * 0.68 - line_h * len(lines)
        for line in lines:
            draw.text((w / 2, y), line, font=font, fill="white", anchor="ma", stroke_width=stroke, stroke_fill="black")
            y += line_h
        layer = Layer.from_canvas(canvas, start=start + (0.0 if at_top else 0.25), enter="drop" if at_top else "rise",
                                  enter_dur=0.35)
        if layer:
            layers.append(layer)
    return layers


STICKER_SLOTS = ("br", "bl", "tr", "tl", "center")


def sticker_layer(path: Path, size: tuple[int, int], slot: str, start: float, end: float | None) -> Layer | None:
    """Ảnh meme/reaction bật ra ở góc khung (viền trắng, đổ bóng, hơi nghiêng) trong một đoạn ngắn."""
    try:
        img = ImageOps.exif_transpose(Image.open(path)).convert("RGBA")
    except OSError as e:
        print(f"      ⚠️  Không đọc được sticker {path}: {e}", flush=True)
        return None
    w, h = size
    side = round(min(w, h) * (0.5 if slot == "center" else 0.36))
    img.thumbnail((side, side), Image.LANCZOS)
    border = max(3, side // 40)
    framed = Image.new("RGBA", (img.width + border * 2, img.height + border * 2), (255, 255, 255, 255))
    framed.alpha_composite(img, (border, border))
    shadow = Image.new("RGBA", (framed.width + border * 6, framed.height + border * 6), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rectangle((border * 3, border * 4, border * 3 + framed.width, border * 4 + framed.height),
                                     fill=(0, 0, 0, 120))
    shadow = shadow.filter(ImageFilter.GaussianBlur(border * 1.5))
    shadow.alpha_composite(framed, (border * 3, border * 3))
    tilt = {"br": -6, "bl": 6, "tr": 5, "tl": -5, "center": 0}.get(slot, 0)
    sticker = shadow.rotate(tilt, resample=Image.BICUBIC, expand=True) if tilt else shadow
    margin = round(min(w, h) * 0.04)
    sw, sh = sticker.size
    x = {"bl": margin, "tl": margin, "br": w - sw - margin, "tr": w - sw - margin}.get(slot, (w - sw) // 2)
    # Góc dưới đặt cao hơn vùng phụ đề
    y = {"tl": margin * 3, "tr": margin * 3, "bl": round(h * 0.7) - sh, "br": round(h * 0.7) - sh}.get(slot, (h - sh) // 2)
    return Layer(sticker, (x, max(0, y)), start=start, end=end, enter="pop", enter_dur=0.3)


def pop_text_layer(text: str, size: tuple[int, int], fonts: Fonts, accent: tuple[int, int, int] = DEFAULT_ACCENT,
                   start: float = 0.0, end: float | None = None) -> Layer | None:
    """Chữ nhấn mạnh to giữa khung (vd "SAI BÉT!", "x10 LẦN"): màu chủ đạo, viền đen, nghiêng nhẹ, bật ra."""
    w, h = size
    font = fonts.get("bold", max(34, round(min(w, h) * 0.12)))
    lines = wrap_balanced(text.upper(), font, int(w * 0.8))[:2]
    stroke = max(3, round(font.size * 0.1))
    line_h = round(font.size * 1.1)
    box_w = int(max(font.getlength(line) for line in lines) + stroke * 4)
    box_h = line_h * len(lines) + stroke * 4
    canvas = Image.new("RGBA", (box_w, box_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    fill = accent if sum(accent) > 160 else (255, 214, 0)
    for k, line in enumerate(lines):
        draw.text((box_w / 2, stroke * 2 + k * line_h), line, font=font, fill=(*fill, 255), anchor="ma",
                  stroke_width=stroke, stroke_fill="black")
    canvas = canvas.rotate(-4, resample=Image.BICUBIC, expand=True)
    pos = ((w - canvas.width) // 2, round(h * 0.4 - canvas.height / 2))
    return Layer(canvas, pos, start=start, end=end, enter="pop", enter_dur=0.28)
