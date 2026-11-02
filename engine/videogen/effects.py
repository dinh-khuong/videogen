"""Hiệu ứng hình: hàm easing, chuyển cảnh giữa các scene, bộ lọc màu, chuyển động Ken Burns và hoạt ảnh lớp chữ.

Mọi hàm làm việc trên ảnh PIL RGB cùng kích thước để ghép từng khung hình (không phụ thuộc moviepy).
"""
import math
import random
from collections.abc import Callable
from dataclasses import dataclass
from functools import lru_cache

from PIL import Image, ImageDraw, ImageEnhance

# ===== Easing =====


def clamp01(p: float) -> float:
    return 0.0 if p < 0 else 1.0 if p > 1 else p


def smooth(p: float) -> float:
    p = clamp01(p)
    return p * p * (3 - 2 * p)


def in_out_cubic(p: float) -> float:
    p = clamp01(p)
    return 4 * p * p * p if p < 0.5 else 1 - (-2 * p + 2) ** 3 / 2


def in_out_quint(p: float) -> float:
    p = clamp01(p)
    return 16 * p**5 if p < 0.5 else 1 - (-2 * p + 2) ** 5 / 2


def out_cubic(p: float) -> float:
    return 1 - (1 - clamp01(p)) ** 3


def out_back(p: float, overshoot: float = 1.6) -> float:
    """Vượt quá đích một chút rồi trở về: chuyển động "bật" sinh động."""
    p = clamp01(p) - 1
    return 1 + (overshoot + 1) * p**3 + overshoot * p**2


# ===== Chuyển cảnh: (ảnh scene trước, ảnh scene sau, tiến độ 0-1) -> khung hình =====

Transition = Callable[[Image.Image, Image.Image, float], Image.Image]


def _fade(a: Image.Image, b: Image.Image, p: float) -> Image.Image:
    return Image.blend(a, b, smooth(p))


def _push(dx: int, dy: int) -> Transition:
    """Scene mới đẩy scene cũ ra khỏi khung theo hướng (dx, dy)."""

    def push(a: Image.Image, b: Image.Image, p: float) -> Image.Image:
        w, h = a.size
        e = in_out_cubic(p)
        ox, oy = round(-dx * w * e), round(-dy * h * e)
        out = Image.new("RGB", a.size)
        out.paste(a, (ox, oy))
        out.paste(b, (ox + dx * w, oy + dy * h))
        return out

    return push


def zoom_crop(img: Image.Image, scale: float, cx: float = 0.5, cy: float = 0.5) -> Image.Image:
    """Phóng to quanh điểm (cx, cy) (tỉ lệ 0-1) và giữ nguyên kích thước khung."""
    if scale <= 1.0005:
        return img
    w, h = img.size
    cw, ch = w / scale, h / scale
    x0 = min(max(cx * w - cw / 2, 0), w - cw)
    y0 = min(max(cy * h - ch / 2, 0), h - ch)
    return img.resize((w, h), Image.BILINEAR, box=(x0, y0, x0 + cw, y0 + ch))


def _zoom(a: Image.Image, b: Image.Image, p: float) -> Image.Image:
    """Lao vào scene cũ, scene mới thu về từ cận cảnh."""
    e = smooth(p)
    za = zoom_crop(a, 1 + 0.55 * e)
    zb = zoom_crop(b, 1.35 - 0.35 * e)
    return Image.blend(za, zb, smooth((p - 0.3) / 0.4))


def _whip(direction: int) -> Transition:
    """Lia máy nhanh: đẩy ngang rất nhanh ở giữa kèm nhòe chuyển động."""
    push = _push(direction, 0)

    def whip(a: Image.Image, b: Image.Image, p: float) -> Image.Image:
        frame = push(a, b, in_out_quint(p))
        speed = math.sin(math.pi * clamp01(p))  # nhanh nhất ở giữa
        k = 1 + speed * 14
        if k < 1.5:
            return frame
        w, h = frame.size
        # Thu nhỏ theo chiều ngang rồi phóng lại: nhòe ngang rẻ hơn nhiều so với lọc Gaussian
        return frame.resize((max(8, round(w / k)), h), Image.BOX).resize((w, h), Image.BILINEAR)

    return whip


@lru_cache(maxsize=8)
def _wipe_strip(soft: int, h: int) -> Image.Image:
    strip = Image.linear_gradient("L").rotate(-90, expand=True).resize((soft, h))  # trắng bên trái -> đen bên phải
    return strip


def _wipe(a: Image.Image, b: Image.Image, p: float) -> Image.Image:
    """Quét mềm từ trái sang phải."""
    w, h = a.size
    soft = max(4, w // 8)
    x = round(-soft + (w + soft) * in_out_cubic(p))
    mask = Image.new("L", a.size, 0)
    if x > 0:
        mask.paste(255, (0, 0, min(x, w), h))
    mask.paste(_wipe_strip(soft, h), (x, 0))
    return Image.composite(b, a, mask)


def _circle(a: Image.Image, b: Image.Image, p: float) -> Image.Image:
    """Scene mới mở ra từ vòng tròn ở giữa khung."""
    w, h = a.size
    r = in_out_cubic(p) * math.hypot(w, h) / 4 * 1.03  # vẽ ở nửa độ phân giải
    small = Image.new("L", (w // 2, h // 2), 0)
    cx, cy = w / 4, h / 4
    ImageDraw.Draw(small).ellipse((cx - r, cy - r, cx + r, cy + r), fill=255)
    return Image.composite(b, a, small.resize(a.size, Image.BILINEAR))  # phóng lại -> viền mềm


def _flash(a: Image.Image, b: Image.Image, p: float) -> Image.Image:
    """Lóe sáng trắng."""
    white = Image.new("RGB", a.size, (255, 255, 255))
    if p < 0.5:
        return Image.blend(a, white, smooth(p * 2))
    return Image.blend(white, b, smooth((p - 0.5) * 2))


TRANSITION_FNS: dict[str, Transition] = {
    "fade": _fade,
    "slide_left": _push(1, 0),
    "slide_right": _push(-1, 0),
    "slide_up": _push(0, 1),
    "slide_down": _push(0, -1),
    "zoom": _zoom,
    "whip_left": _whip(1),
    "whip_right": _whip(-1),
    "wipe": _wipe,
    "circle": _circle,
    "flash": _flash,
}

# Lựa chọn của người dùng -> các kiểu chuyển cảnh được dùng (luân phiên)
TRANSITION_GROUPS = {
    "mix": ["slide_left", "zoom", "whip_left", "wipe", "slide_up", "circle", "whip_right", "fade", "slide_right"],
    "fade": ["fade"],
    "slide": ["slide_left", "slide_up", "slide_right", "slide_down"],
    "zoom": ["zoom"],
    "whip": ["whip_left", "whip_right"],
    "wipe": ["wipe"],
    "circle": ["circle"],
    "flash": ["flash"],
}

# Chuyển cảnh có tiếng "vút" (chuyển động nhanh)
WHOOSH_TRANSITIONS = {"slide_left", "slide_right", "slide_up", "slide_down", "whip_left", "whip_right", "zoom", "wipe"}


def pick_transitions(choice: str, count: int, rng: random.Random) -> list[str]:
    """Danh sách kiểu chuyển cảnh cho `count` điểm nối; kiểu 'mix' xáo trộn và không lặp liền nhau."""
    group = TRANSITION_GROUPS.get(choice, ["fade"])
    if len(group) == 1:
        return group * count
    if choice != "mix":
        return [group[i % len(group)] for i in range(count)]
    out: list[str] = []
    pool: list[str] = []
    while len(out) < count:
        if not pool:
            pool = group[:]
            rng.shuffle(pool)
        name = pool.pop()
        if out and name == out[-1] and pool:
            pool.insert(0, name)
            name = pool.pop()
        out.append(name)
    return out


# ===== Bộ lọc màu =====


def _lut(fn: Callable[[int], float]) -> list[int]:
    return [min(255, max(0, round(fn(v)))) for v in range(256)]


def _curve(shadows: float, highlights: float) -> Callable[[int], float]:
    """Cộng thêm `shadows` ở vùng tối và `highlights` ở vùng sáng (đổi tông màu từng kênh)."""
    return lambda v: v + shadows * (1 - v / 255) ** 2 + highlights * (v / 255) ** 2


def _filter(luts: tuple[list[int], list[int], list[int]] | None, saturation: float = 1.0, contrast: float = 1.0):
    table = luts[0] + luts[1] + luts[2] if luts else None

    def apply(img: Image.Image) -> Image.Image:
        if table:
            img = img.point(table)
        if saturation != 1.0:
            img = ImageEnhance.Color(img).enhance(saturation)
        if contrast != 1.0:
            img = ImageEnhance.Contrast(img).enhance(contrast)
        return img

    return apply


def _bw(img: Image.Image) -> Image.Image:
    return ImageEnhance.Contrast(img.convert("L")).enhance(1.12).convert("RGB")


COLOR_FILTER_FNS: dict[str, Callable[[Image.Image], Image.Image]] = {
    "vivid": _filter(None, saturation=1.25, contrast=1.06),
    "warm": _filter((_lut(lambda v: v * 1.05 + 8), _lut(lambda v: v * 1.01 + 2), _lut(lambda v: v * 0.9)), 1.08),
    "cool": _filter((_lut(lambda v: v * 0.93), _lut(lambda v: v * 1.0 + 2), _lut(lambda v: v * 1.05 + 10)), 1.04),
    # Teal & orange: vùng tối ngả xanh ngọc, vùng sáng ngả cam
    "cinematic": _filter((_lut(_curve(-10, 18)), _lut(_curve(6, 4)), _lut(_curve(22, -20))), 0.95, 1.1),
    "vintage": _filter((_lut(lambda v: 22 + v * 0.86), _lut(lambda v: 18 + v * 0.84), _lut(lambda v: 14 + v * 0.74)), 0.82),
    "bw": _bw,
}


def color_filter(name: str) -> Callable[[Image.Image], Image.Image] | None:
    return COLOR_FILTER_FNS.get(name)


# ===== Chuyển động Ken Burns =====

MOTIONS = ("zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down", "zoom_in_left", "zoom_in_right")
# Chỉ dùng khi được chọn chủ động (Đạo diễn AI / cảm xúc câu thoại), không nằm trong vòng luân phiên ngẫu nhiên
STILL = "still"
ALL_MOTIONS = (*MOTIONS, STILL)


@dataclass(frozen=True)
class Motion:
    """Khung cắt di chuyển từ (cx0, cy0, s0) tới (cx1, cy1, s1) trên ảnh lớn gấp `zoom` lần khung hình.

    cx, cy: tâm khung cắt (tỉ lệ 0-1); s: kích thước khung cắt so với khung hình (1 = cận nhất, zoom = toàn ảnh).
    """
    cx0: float
    cy0: float
    s0: float
    cx1: float
    cy1: float
    s1: float


def make_motion(kind: str, zoom: float) -> Motion:
    tight = 1 + (zoom - 1) * 0.15  # khung cắt khi lia (chừa chỗ để lia)
    return {
        "zoom_in": Motion(0.5, 0.5, zoom, 0.5, 0.5, 1.0),
        "zoom_out": Motion(0.5, 0.5, 1.0, 0.5, 0.5, zoom),
        "pan_left": Motion(1.0, 0.5, tight, 0.0, 0.5, tight),
        "pan_right": Motion(0.0, 0.5, tight, 1.0, 0.5, tight),
        "pan_up": Motion(0.5, 1.0, tight, 0.5, 0.0, tight),
        "pan_down": Motion(0.5, 0.0, tight, 0.5, 1.0, tight),
        "zoom_in_left": Motion(0.5, 0.5, zoom, 0.25, 0.45, 1.0),
        "zoom_in_right": Motion(0.5, 0.5, zoom, 0.75, 0.45, 1.0),
        STILL: Motion(0.5, 0.5, zoom, 0.5, 0.5, zoom),  # đứng yên, thấy trọn ảnh (vd câu tỉnh bơ)
    }[kind]


def motion_box(m: Motion, progress: float, size: tuple[int, int], zoom: float) -> tuple[float, float, float, float]:
    """Vùng cắt trên ảnh lớn (kích thước size*zoom) tại tiến độ 0-1."""
    w, h = size
    big_w, big_h = w * zoom, h * zoom
    e = smooth(progress)
    s = m.s0 + (m.s1 - m.s0) * e
    crop_w, crop_h = min(w * s, big_w), min(h * s, big_h)
    cx = (m.cx0 + (m.cx1 - m.cx0) * e) * big_w
    cy = (m.cy0 + (m.cy1 - m.cy0) * e) * big_h
    cx = min(max(cx, crop_w / 2), big_w - crop_w / 2)
    cy = min(max(cy, crop_h / 2), big_h - crop_h / 2)
    return cx - crop_w / 2, cy - crop_h / 2, cx + crop_w / 2, cy + crop_h / 2


# ===== Lớp chữ/đồ họa có hoạt ảnh =====


@dataclass
class Layer:
    """Lớp RGBA (đã cắt sát nội dung) đặt tại `pos`, hiện từ `start` tới `end` (giây, tính trong scene)."""
    image: Image.Image
    pos: tuple[int, int]
    start: float = 0.0
    end: float | None = None
    enter: str = "none"   # none | fade | slide_left | rise | drop | pop
    enter_dur: float = 0.35
    pulse: bool = False   # nhịp nhẹ liên tục (vd nút kêu gọi hành động)
    # Lớp động (vd clip video lồng trên ảnh): t (giây, tính từ start) -> ảnh RGBA cùng kích thước với `image`
    frames: Callable[[float], Image.Image] | None = None

    @classmethod
    def from_canvas(cls, canvas: Image.Image, **kwargs) -> "Layer | None":
        bbox = canvas.getbbox()
        if not bbox:
            return None
        return cls(canvas.crop(bbox), (bbox[0], bbox[1]), **kwargs)


@lru_cache(maxsize=64)
def _alpha_lut(alpha: float) -> tuple[int, ...]:
    return tuple(round(v * alpha) for v in range(256))


def with_alpha(img: Image.Image, alpha: float) -> Image.Image:
    if alpha >= 0.999:
        return img
    out = img.copy()
    out.putalpha(img.getchannel("A").point(list(_alpha_lut(round(alpha, 2)))))
    return out


def draw_layer(frame: Image.Image, layer: Layer, t: float) -> None:
    """Vẽ lớp lên khung hình tại thời điểm t của scene, kèm hoạt ảnh xuất hiện."""
    if t < layer.start or (layer.end is not None and t >= layer.end):
        return
    local = t - layer.start
    img, (x, y) = (layer.frames(local) if layer.frames else layer.image), layer.pos
    p = 1.0 if layer.enter == "none" or layer.enter_dur <= 0 else clamp01(local / layer.enter_dur)
    alpha, scale = 1.0, 1.0
    if p < 1:
        alpha = smooth(p * 1.6)
        if layer.enter == "slide_left":
            x -= round((img.width + x) * (1 - out_back(p, 1.2)))
        elif layer.enter == "rise":
            y += round(img.height * 0.6 * (1 - out_cubic(p)))
        elif layer.enter == "drop":
            y -= round(img.height * 0.6 * (1 - out_cubic(p)))
        elif layer.enter == "pop":
            scale = 0.6 + 0.4 * out_back(p, 2.0)
    if layer.pulse and p >= 1:
        scale *= 1 + 0.035 * math.sin(2 * math.pi * (local - layer.enter_dur) / 1.3)
    if abs(scale - 1) > 0.004:
        sw, sh = max(1, round(img.width * scale)), max(1, round(img.height * scale))
        x += (img.width - sw) // 2
        y += (img.height - sh) // 2
        img = img.resize((sw, sh), Image.BILINEAR)
    img = with_alpha(img, alpha)
    frame.paste(img, (x, y), img)
