"""Mobject dùng để dựng video bằng Manim: lớp có hoạt ảnh (Element), ảnh, clip video làm texture, phụ đề chữ vector.

Bố cục tính theo pixel của khung hình (gốc ở góc trên trái, như videogen) rồi đổi sang tọa độ Manim (gốc ở giữa, trục y
hướng lên) bằng Canvas. Chữ phụ đề được đo bằng đúng file font đó qua Pillow để ngắt dòng giống renderer classic.
"""
import math
import subprocess
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image

from videogen.effects import Layer, clamp01, out_back, out_cubic, smooth
from videogen.graphics import Fonts, _layout_words, wrap_balanced
from videogen.style import text_color_on
from videogen.subtitles import Cue

from . import _manim  # noqa: F401  (nạp manimlib trước khi import các lớp của nó)
from manimlib.mobject.geometry import Circle, Rectangle, RoundedRectangle
from manimlib.mobject.mobject import Mobject
from manimlib.mobject.svg.text_mobject import Text
from manimlib.mobject.types.image_mobject import ImageMobject
from manimlib.mobject.types.vectorized_mobject import VGroup, VMobject

FRAME_HEIGHT = 8.0  # chiều cao khung theo đơn vị Manim (chiều rộng theo tỉ lệ khung hình)
WHITE, BLACK = "#FFFFFF", "#000000"


def hex_color(rgb: tuple[int, int, int]) -> str:
    return "#{:02X}{:02X}{:02X}".format(*rgb)


class Canvas:
    """Đổi tọa độ pixel (gốc trên trái) sang tọa độ Manim. Nội dung w x h nằm ở góc trên trái của khung hình
    (bằng khung, hoặc nửa trên khi chia đôi với video nền)."""

    def __init__(self, size: tuple[int, int], frame_size: tuple[int, int] | None = None) -> None:
        self.w, self.h = size
        self.fw, self.fh = frame_size or size
        self.unit = FRAME_HEIGHT / self.fh  # đơn vị Manim cho mỗi pixel
        self.frame_shape = (self.fw * self.unit, FRAME_HEIGHT)
        self.content_shape = (self.w * self.unit, self.h * self.unit)

    def point(self, x: float, y: float) -> np.ndarray:
        return np.array([(x - self.fw / 2) * self.unit, (self.fh / 2 - y) * self.unit, 0.0])

    @property
    def center(self) -> np.ndarray:
        return self.point(self.w / 2, self.h / 2)

    def length(self, px: float) -> float:
        return px * self.unit

    @property
    def base(self) -> int:
        return min(self.w, self.h)


def _font_face(path: str | None) -> tuple[str, str]:
    """(họ font, độ đậm Pango) của một file font, để Pango chọn đúng font mà Pillow dùng đo chữ."""
    if not path:
        return "Sans", "NORMAL"
    try:
        import manimpango

        manimpango.register_font(path)
    except Exception:  # noqa: BLE001 — font hệ thống vẫn dùng được qua fontconfig
        pass
    out = subprocess.run(["fc-scan", "--format", "%{family[0]}|%{weight}", path], capture_output=True, text=True).stdout
    family, _, weight = out.partition("|")
    try:
        w = int(weight)
    except ValueError:
        w = 80
    return family or "Sans", "BOLD" if w >= 200 else "SEMIBOLD" if w >= 180 else "MEDIUM" if w >= 100 else "NORMAL"


class Typography:
    """Tạo chữ Manim cỡ đúng `px` pixel (theo cỡ font Pillow của engine cũ) và đo/ngắt dòng bằng Pillow."""

    PROBE = "Ấg"

    def __init__(self, fonts: Fonts, canvas: Canvas) -> None:
        self.fonts, self.canvas = fonts, canvas
        self.faces = {"bold": _font_face(fonts.bold), "regular": _font_face(fonts.regular)}
        self._ratio: dict[str, float] = {}

    def _units_per_px(self, weight: str) -> float:
        """Chiều cao (đơn vị Manim) của chữ mẫu ở font_size 48 chia cho chiều cao (px) của nó ở cỡ Pillow 48."""
        if weight not in self._ratio:
            family, pango_weight = self.faces[weight]
            manim_h = Text(self.PROBE, font=family, weight=pango_weight, font_size=48).get_height()
            box = self.fonts.get(weight, 48).getbbox(self.PROBE)
            self._ratio[weight] = manim_h / max(1, box[3] - box[1])
        return self._ratio[weight]

    def text(self, value: str, px: int, weight: str = "bold", color: str = WHITE) -> Text:
        family, pango_weight = self.faces[weight]
        mob = Text(value, font=family, weight=pango_weight, font_size=px * self.canvas.unit / self._units_per_px(weight))
        mob.set_fill(color, opacity=1.0)
        return mob

    def wrap(self, value: str, px: int, max_width: float, weight: str = "bold") -> list[str]:
        return wrap_balanced(value, self.fonts.get(weight, px), int(max_width))

    def width(self, value: str, px: int, weight: str = "bold") -> float:
        return self.fonts.get(weight, px).getlength(value)


def stroke_width(px: float, canvas: Canvas) -> float:
    """Độ dày nét Manim cho nét dày `px` pixel (Manim tính nét theo khung cao 1080)."""
    return px * 2 * 1080 / canvas.fh


def outline(mob: VMobject, px: float, canvas: Canvas, color: str = BLACK) -> VMobject:
    """Viền chữ (vẽ phía sau phần tô) dày khoảng `px` pixel."""
    mob.set_stroke(color, width=stroke_width(px, canvas), opacity=1.0, behind=True)
    return mob


# ===== Phần tử có hoạt ảnh trong một cảnh =====


@dataclass
class Element:
    """Một mobject hiện từ `start` tới `end` (giây trong cảnh), với hoạt ảnh xuất hiện như engine cũ.

    enter: none | fade | slide_left | rise | drop | pop (như videogen.effects.draw_layer).
    `frames(t)`: cập nhật thêm theo thời gian (vd clip video), t tính từ start.
    """
    mob: Mobject
    start: float = 0.0
    end: float | None = None
    enter: str = "none"
    enter_dur: float = 0.35
    pulse: bool = False
    frames: object = None
    _base_alpha: list = field(default_factory=list, repr=False)
    _applied: tuple[float, float, float] = (0.0, 0.0, 1.0)  # (dx, dy, scale) đang áp vào mob
    _alpha: float = 1.0

    def __post_init__(self) -> None:
        for sm in self.mob.family_members_with_points():
            names = sm.data.dtype.names or ()
            self._base_alpha.append({k: sm.data[k][..., -1].copy() for k in ("fill_rgba", "stroke_rgba", "opacity")
                                     if k in names})
        self.left = self.mob.get_left()[0]
        self.width, self.height = self.mob.get_width(), self.mob.get_height()
        self.anchor = self.mob.get_center()  # tâm phóng to/thu nhỏ cố định (nội dung bên trong có thể đổi, vd phụ đề)

    def visible(self, t: float) -> bool:
        return t >= self.start and (self.end is None or t < self.end)

    def _set_alpha(self, alpha: float) -> None:
        if alpha == self._alpha:
            return
        self._alpha = alpha
        for sm, base in zip(self.mob.family_members_with_points(), self._base_alpha):
            for key, values in base.items():
                sm.data[key][..., -1] = values * alpha
            sm.note_changed_data()

    def _place(self, dx: float, dy: float, scale: float) -> None:
        odx, ody, oscale = self._applied
        if (odx, ody, oscale) == (dx, dy, scale):
            return
        self.mob.shift([-odx, -ody, 0])
        if oscale != scale:
            self.mob.scale(scale / oscale, about_point=self.anchor)
        self.mob.shift([dx, dy, 0])
        self._applied = (dx, dy, scale)

    def apply(self, t: float, frame_left: float) -> None:
        local = t - self.start
        if self.frames:
            self.frames(local)
        p = 1.0 if self.enter == "none" or self.enter_dur <= 0 else clamp01(local / self.enter_dur)
        alpha, scale, dx, dy = 1.0, 1.0, 0.0, 0.0
        if p < 1:
            alpha = smooth(p * 1.6)
            if self.enter == "slide_left":
                dx = -(self.left + self.width - frame_left) * (1 - out_back(p, 1.2))
            elif self.enter == "rise":
                dy = -self.height * 0.6 * (1 - out_cubic(p))
            elif self.enter == "drop":
                dy = self.height * 0.6 * (1 - out_cubic(p))
            elif self.enter == "pop":
                scale = 0.6 + 0.4 * out_back(p, 2.0)
        if self.pulse and p >= 1:
            scale *= 1 + 0.035 * math.sin(2 * math.pi * (local - self.enter_dur) / 1.3)
        self._place(dx, dy, max(scale, 0.01))
        self._set_alpha(alpha)


# ===== Ảnh và clip video =====


_texture_ids = iter(range(10**9))


def image_mobject(img: Image.Image, cache_dir: Path, name: str, width: float) -> ImageMobject:
    """ImageMobject từ ảnh Pillow (lưu PNG/JPG tạm vì Manim nạp texture theo đường dẫn), rộng `width` đơn vị."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    rgba = img.mode == "RGBA"
    path = cache_dir / f"{name}_{next(_texture_ids)}.{'png' if rgba else 'jpg'}"
    if rgba:
        img.save(path)
    else:
        img.convert("RGB").save(path, quality=92)
    mob = ImageMobject(str(path))
    mob.set_width(width, stretch=True)
    mob.set_height(width * img.height / img.width, stretch=True)
    return mob


class VideoMobject(ImageMobject):
    """Clip video phát trong khung Manim: ffmpeg giải mã sẵn đúng kích thước/fps, mỗi khung hình ghi đè texture.

    Tắt tiếng, tự lặp khi clip ngắn hơn thời gian hiện. `grade`: bộ lọc màu (Pillow) áp lên từng khung.
    """

    def __init__(self, path: Path, size: tuple[int, int], fps: int, cache_dir: Path, ffmpeg: str, cover: bool = True,
                 grade=None) -> None:
        self.size, self.fps, self.grade = size, fps, grade
        w, h = size
        fit = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}" if cover else f"scale={w}:{h}"
        self.command = [ffmpeg, "-v", "error", "-stream_loop", "-1", "-i", str(path), "-an",
                        "-vf", f"fps={fps},{fit},format=rgba", "-f", "rawvideo", "-"]
        self.proc: subprocess.Popen | None = None
        self.frame_bytes = w * h * 4
        self.pending: bytes | None = None
        first = self._read() or bytes(self.frame_bytes)
        cache_dir.mkdir(parents=True, exist_ok=True)
        still = cache_dir / f"clip_{next(_texture_ids)}.png"  # tên riêng: Manim gộp mobject cùng texture vào một lượt vẽ
        self._image(first).save(still)
        self.shown = 0  # chỉ số khung đang ở texture
        super().__init__(str(still))

    def _image(self, data: bytes) -> Image.Image:
        img = Image.frombuffer("RGBA", self.size, data, "raw", "RGBA", 0, 1)
        return self.grade(img.convert("RGB")).convert("RGBA") if self.grade else img

    def _read(self) -> bytes | None:
        if self.proc is None:
            self.proc = subprocess.Popen(self.command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        data = self.proc.stdout.read(self.frame_bytes)
        return data if len(data) == self.frame_bytes else None

    def seek(self, local: float) -> None:
        """Tới khung hình của thời điểm `local` (giây từ lúc clip bắt đầu hiện); chỉ chạy tới, không lùi."""
        index = max(0, int(local * self.fps))
        data = None
        while self.shown < index:
            data = self._read()
            if data is None:
                break
            self.shown += 1
        if data is not None:
            self.pending = self._image(data).tobytes() if self.grade else data

    def get_shader_wrapper(self, ctx):
        wrapper = super().get_shader_wrapper(ctx)
        if self.pending is not None and wrapper.textures:
            wrapper.textures[0].write(self.pending)
            self.pending = None
        return wrapper

    def close(self) -> None:
        if self.proc:
            self.proc.kill()
            self.proc.wait()
            self.proc = None


# ===== Chữ và khối đồ họa =====


def rounded_box(canvas: Canvas, w: float, h: float, radius: float, color: str, opacity: float,
                stroke: str | None = None, stroke_px: float = 0.0) -> RoundedRectangle:
    box = RoundedRectangle(width=canvas.length(w), height=canvas.length(h),
                           corner_radius=min(canvas.length(radius), canvas.length(min(w, h)) / 2))
    box.set_fill(color, opacity=opacity)
    if stroke:
        box.set_stroke(stroke, width=stroke_width(stroke_px, canvas), opacity=1.0)
    else:
        box.set_stroke(width=0, opacity=0)
    return box


def place(mob: Mobject, canvas: Canvas, x: float, y: float, anchor: str = "center") -> Mobject:
    """Đặt mob theo pixel: anchor center | top (giữa cạnh trên) | left (giữa cạnh trái) | top_left."""
    p = canvas.point(x, y)
    if anchor == "center":
        mob.move_to(p)
    elif anchor == "top":
        mob.move_to(p - np.array([0, mob.get_height() / 2, 0]))
    elif anchor == "left":
        mob.move_to(p + np.array([mob.get_width() / 2, 0, 0]))
    elif anchor == "top_left":
        mob.move_to(p + np.array([mob.get_width() / 2, -mob.get_height() / 2, 0]))
    return mob


def full_frame_rect(canvas: Canvas, color: str, opacity: float = 0.0, size: tuple[int, int] | None = None) -> Rectangle:
    """Hình chữ nhật phủ khung nội dung (hơi tràn mép), hoặc kích thước `size` pixel."""
    if size:
        rect = Rectangle(width=canvas.length(size[0]), height=canvas.length(size[1]))
    else:
        rect = Rectangle(width=canvas.content_shape[0] * 1.02, height=canvas.content_shape[1] * 1.02)
        rect.move_to(canvas.center)
    rect.set_fill(color, opacity=opacity).set_stroke(width=0, opacity=0)
    return rect


def accent_circle(color: str) -> Circle:
    circle = Circle(radius=1.0)
    circle.set_fill(color, opacity=1.0).set_stroke(width=0, opacity=0)
    return circle


def layer_element(layer: Layer, canvas: Canvas, cache_dir: Path) -> Element:
    """Lớp có hoạt ảnh của videogen (nhãn bước, title card, chữ meme, lời kêu gọi, sticker, logo) thành phần tử Manim
    cùng vị trí, cùng thời điểm và kiểu xuất hiện."""
    img = layer.image
    mob = image_mobject(img, cache_dir, "layer", canvas.length(img.width))
    place(mob, canvas, layer.pos[0], layer.pos[1], "top_left")
    return Element(mob, layer.start, layer.end, enter=layer.enter, enter_dur=layer.enter_dur, pulse=layer.pulse)


# ===== Phụ đề =====


def _subtitle_bottom(canvas: Canvas, big: bool) -> int:
    """Mép dưới của khối phụ đề (video dọc chừa chỗ cho thanh điều khiển của TikTok/Shorts), như engine cũ."""
    w, h = canvas.w, canvas.h
    if h > w:
        return h - round(h * (0.2 if big else 0.14))
    return h - round(h * (0.09 if big else 0.07))


@lru_cache(maxsize=None)
def _glyph_count(text: str) -> int:
    return sum(1 for ch in text if not ch.isspace())


class Subtitles:
    """Phụ đề của một cảnh: mỗi cue một khối chữ vector. box: chữ trắng trong khung tối; karaoke: chữ đậm viền đen,
    từ đang đọc nằm trên nền màu chủ đạo. Thời điểm cue/từ khớp giọng đọc (videogen.subtitles.build_cues)."""

    def __init__(self, cues: list[Cue], kind: str, canvas: Canvas, type_: Typography, accent: tuple[int, int, int],
                 offset: float) -> None:
        self.cues, self.kind, self.canvas, self.type, self.accent, self.offset = cues, kind, canvas, type_, accent, offset
        self.starts = [offset + c.start for c in cues]
        self.current: tuple[int, Element, list] | None = None
        self.active: int | None = None

    def _build(self, i: int) -> tuple[Element, list]:
        canvas, type_, cue = self.canvas, self.type, self.cues[i]
        w = canvas.w
        if self.kind == "box":
            px = max(20, round(canvas.base * 0.052))
            lines = type_.wrap(cue.text, px, w * 0.84, "regular")
            line_h = round(px * 1.32)
            pad_x, pad_y = round(px * 0.7), round(px * 0.45)
            box_w = max(type_.width(line, px, "regular") for line in lines) + pad_x * 2
            box_h = line_h * len(lines) + pad_y * 2
            y0 = _subtitle_bottom(canvas, False) - box_h
            group = VGroup(place(rounded_box(canvas, box_w, box_h, px * 0.4, BLACK, 0.67), canvas, w / 2, y0, "top"))
            for k, line in enumerate(lines):
                group.add(place(type_.text(line, px, "regular"), canvas, w / 2, y0 + pad_y + line_h * (k + 0.5)))
            return Element(group, self.starts[i], enter="fade", enter_dur=0.12), []
        px = max(24, round(canvas.base * 0.068))
        rows = _layout_words(cue.words, type_.fonts.get("bold", px), int(w * 0.86))
        line_h = round(px * 1.28)
        y = _subtitle_bottom(canvas, True) - line_h * len(rows)
        group, words = VGroup(), []
        for row in rows:
            text = "".join((" " if k and cue.words[j].spaced else "") + cue.words[j].text for k, j in enumerate(row))
            mob = outline(type_.text(text, px), max(2, px * 0.12), canvas)
            place(mob, canvas, w / 2, y + line_h / 2)
            glyphs = mob.submobjects
            if len(glyphs) == _glyph_count(text):  # mỗi ký tự (không kể dấu cách) là một glyph: tách được từng từ
                k = 0
                for j in row:
                    n = _glyph_count(cue.words[j].text)
                    words.append((j, VGroup(*glyphs[k:k + n]) if n else None))
                    k += n
            group.add(mob)
            y += line_h
        if not words:  # không khớp được chữ với từ (vd font ghép ký tự): phụ đề không đánh dấu từ đang đọc
            return Element(group, self.starts[i], enter="pop", enter_dur=0.18), []
        highlight = rounded_box(canvas, 10, 10, px * 0.22, hex_color(self.accent), 1.0).move_to(group.get_center())
        highlight.set_width(1e-4, stretch=True).set_height(1e-4, stretch=True)
        group.add_to_back(highlight)
        element = Element(group, self.starts[i], enter="pop", enter_dur=0.18)
        return element, [highlight, sorted(words, key=lambda item: item[0])]

    def element_at(self, t: float) -> Element | None:
        """Phần tử phụ đề hiện ở thời điểm t (giây trong cảnh), đã cập nhật từ đang đọc."""
        if not self.cues:
            return None
        i = int(np.searchsorted(self.starts, t, side="right")) - 1
        if i < 0:
            return None
        if not self.current or self.current[0] != i:
            element, extra = self._build(i)
            self.current, self.active = (i, element, extra), None
        _, element, extra = self.current
        if self.kind == "karaoke" and extra:
            self._highlight(t, *extra)
        return element

    def _highlight(self, t: float, highlight: RoundedRectangle, words: list) -> None:
        cue = self.cues[self.current[0]]
        active = max(0, int(np.searchsorted(cue.word_starts, t - self.offset, side="right")) - 1)
        if self.active == active:
            return
        self.active = active
        fg, accent = hex_color(text_color_on(self.accent)), hex_color(self.accent)
        target = None
        for j, glyphs in words:
            if glyphs is None:
                continue
            on = j == active
            # Đổi màu, không đổi độ trong suốt (Element điều khiển độ trong suốt khi hiện/ẩn): viền của từ đang đọc
            # cùng màu nền đánh dấu nên không thấy
            glyphs.set_fill(fg if on else WHITE)
            glyphs.set_stroke(accent if on else BLACK, behind=True)
            if on:
                target = glyphs
        if target is None:  # từ không có chữ hiện được: thu nhỏ khung đánh dấu tới mức không thấy
            highlight.set_width(1e-4, stretch=True).set_height(1e-4, stretch=True)
            return
        canvas = self.canvas
        px = max(24, round(canvas.base * 0.068))
        box = rounded_box(canvas, target.get_width() / canvas.unit + px * 0.32,
                          target.get_height() / canvas.unit + px * 0.2, px * 0.22, accent, 1.0)
        highlight.become(box.move_to(target.get_center()))
