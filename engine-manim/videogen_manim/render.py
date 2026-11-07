"""Render video bằng ManimGL theo timeline các cảnh.

Thời gian do engine điều khiển: khung hình thứ n là thời điểm n/fps của timeline (cảnh sau chồng lên `transition` giây
cuối của cảnh trước, như engine cũ), nên hình khớp từng mẫu với track âm thanh dựng bằng videogen_core.audio.mix.
Mỗi khung: đặt trạng thái mọi mobject của các cảnh đang hiện (ảnh Ken Burns, clip, chữ có hoạt ảnh, phụ đề), áp phép
chuyển cảnh, để Manim vẽ bằng OpenGL rồi đẩy điểm ảnh thẳng vào ffmpeg (ghép luôn track âm thanh).
"""
import subprocess
import time
from bisect import bisect_right
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image

from videogen.effects import STILL, in_out_cubic, in_out_quint, make_motion, motion_box, out_cubic, smooth
from videogen.graphics import Fonts, clip_window, framed_backdrop, logo_layer, prepare_background, sticker_layer
from videogen.pipeline import LineVisual
from videogen.probe import video_info
from videogen.subtitles import build_cues
from videogen.video_builder import FADE_IN, FRAME_ZOOM, Segment, _camera_fn
from videogen_core.audio.mix import FADE_OUT
from videogen_core.ffmpeg import ffmpeg_exe

from . import _manim  # noqa: F401
from manimlib.camera import camera as camera_module
from manimlib.mobject.mobject import Group, Mobject
from manimlib.scene.scene import Scene

from .mobjects import (
    BLACK, WHITE, Canvas, Element, Subtitles, Typography, VideoMobject, accent_circle, badge_element, cta_element,
    full_frame_rect, hex_color, image_mobject, meme_elements, picture_element, place, pop_text_element, title_elements,
)


@dataclass
class ScenePlan:
    """Mọi thứ cần để dựng một cảnh. Thời điểm tính theo giây trong cảnh (đã cộng khoảng lặng đầu cảnh)."""
    segments: list[Segment]
    motions: list[str | None]  # chuyển động Ken Burns của từng đoạn ảnh (None với clip)
    duration: float
    head: float  # giọng đọc bắt đầu sau chừng này giây
    speech: float  # thời lượng giọng đọc
    narration: str = ""
    words: list[dict] | None = None
    title: tuple[str, str] | None = None  # (tiêu đề, dòng phụ)
    title_end: float | None = None
    badge: tuple[str, str] | None = None  # (nhãn "Bước N", tên bước)
    meme: tuple[str, str, float] | None = None  # (dòng trên, dòng dưới, hiện từ)
    cta_start: float | None = None
    visuals: list[LineVisual] = field(default_factory=list)  # sticker meme, chữ nhấn mạnh theo câu thoại
    overlay: tuple[Path, str, str, float] | None = None  # clip/ảnh lồng suốt cảnh: (file, image|video, góc, hiện từ)
    camera: list[tuple[float, str]] = field(default_factory=list)  # (giây, punch | shake | zoom_slow)


@dataclass
class Timeline:
    starts: list[float]
    durations: list[float]
    transition: float
    kinds: list[str]  # kiểu chuyển cảnh giữa cảnh i và i+1 (tên như videogen.effects.TRANSITION_GROUPS)
    total: float


@dataclass
class Look:
    """Phong cách dựng: lấy từ videogen.style.Style và kích thước khung."""
    size: tuple[int, int]  # khung nội dung (nửa trên khi chia đôi với video nền)
    frame_size: tuple[int, int]
    fonts: Fonts
    accent: tuple[int, int, int]
    subtitles: str  # box | karaoke | none
    zoom: float
    clip_push: float
    segment_blend: float
    grade: object = None  # bộ lọc màu Pillow (videogen.effects.color_filter) hoặc None
    logo: Path | None = None
    progress_bar: bool = False
    bg_video: Path | None = None
    cta: str = ""


def _video_size(path: Path) -> tuple[int, int]:
    info = video_info(path)
    w, h = info.get("width") or 16, info.get("height") or 9
    if abs(int(float(info.get("rotation") or 0))) % 180 == 90:  # ffmpeg tự xoay khi giải mã
        w, h = h, w
    return w, h


def _middle_frame(path: Path) -> Image.Image:
    at = max(0.0, float(video_info(path).get("duration") or 0) / 2)
    raw = subprocess.run([ffmpeg_exe(), "-v", "error", "-ss", f"{at:.2f}", "-i", str(path), "-frames:v", "1",
                          "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True).stdout
    try:
        return Image.open(BytesIO(raw)).convert("RGB")
    except Exception:  # noqa: BLE001
        return Image.new("RGB", _video_size(path), (20, 20, 24))


class _Background:
    """Một đoạn hình nền của cảnh: ảnh chuyển động Ken Burns, hoặc clip video (phủ kín, hay hiện trọn trên nền mờ)."""

    def __init__(self, ctx: "VideoScene", seg: Segment, motion: str | None, length: float) -> None:
        self.ctx, self.length = ctx, length
        canvas, look = ctx.canvas, ctx.look
        w, h = look.size
        self.videos: list[VideoMobject] = []
        self.push = 1.0
        self.motion = None
        if seg.media == "video":
            vw, vh = _video_size(seg.path)
            ratio, frame_ratio = vw / vh, w / h
            if seg.style == "frame" or abs(ratio - frame_ratio) / frame_ratio > 0.45:
                # Clip lệch tỉ lệ nhiều / là nội dung chính: hiện trọn trên nền mờ (như engine cũ)
                backdrop, (x, y, fw, fh), _ = framed_backdrop(_middle_frame(seg.path), look.size, (vw, vh))
                if look.grade:
                    backdrop = look.grade(backdrop)
                back = image_mobject(backdrop, ctx.cache_dir, "backdrop", canvas.length(w))
                video = VideoMobject(seg.path, (fw, fh), ctx.fps, ctx.cache_dir, ctx.ffmpeg, cover=False, grade=look.grade)
                self.mobs: list[Mobject] = [back, video]
                self.rects = [(0, 0, w, h), (x, y, fw, fh)]
            else:
                video = VideoMobject(seg.path, (w, h), ctx.fps, ctx.cache_dir, ctx.ffmpeg, cover=True, grade=look.grade)
                self.push = look.clip_push  # zoom chậm vào giữa cho sinh động
                self.mobs = [video]
                self.rects = [(0, 0, w, h)]
            self.videos = [video]
            return
        zoom = look.zoom
        kind = motion or STILL
        if seg.style == "frame" and kind != STILL:
            # Ảnh là nội dung chính: chỉ zoom rất nhẹ để chữ trong ảnh luôn đọc được
            zoom = FRAME_ZOOM
            kind = "zoom_out" if kind in ("zoom_out", "pan_left", "pan_up") else "zoom_in"
        self.zoom, self.big = zoom, (round(w * zoom), round(h * zoom))
        img = prepare_background(seg.path, self.big, seg.style).convert("RGB")
        if look.grade:
            img = look.grade(img)
        self.mobs = [image_mobject(img, ctx.cache_dir, "bg", canvas.length(self.big[0]))]
        self.motion = make_motion(kind, zoom)

    def update(self, u: float, alpha: float, cam: tuple[float, float, float] | None) -> None:
        """u: giây từ đầu đoạn; alpha: độ hiện (hòa sang đoạn sau); cam: (phóng, tâm x, tâm y) của zoom giật/rung."""
        canvas = self.ctx.canvas
        w, h = self.ctx.look.size
        if self.motion:
            # Khung cắt trên ảnh lớn (như engine cũ) -> phóng/dời ảnh sao cho khung cắt vừa khít khung hình
            x0, y0, x1, y1 = motion_box(self.motion, u / self.length, (w, h), self.zoom)
            sx, sy = w / max(x1 - x0, 1e-6), h / max(y1 - y0, 1e-6)
            rects = [(-x0 * sx, -y0 * sy, self.big[0] * sx, self.big[1] * sy)]
        else:
            s = 1 + (self.push - 1) * min(max(u / self.length, 0.0), 1.0)
            rects = [(w / 2 + (x - w / 2) * s, h / 2 + (y - h / 2) * s, rw * s, rh * s) for x, y, rw, rh in self.rects]
            for video in self.videos:
                video.seek(u)
        if cam and cam[0] > 1.0005:
            scale, cx, cy = cam
            cw, ch = w / scale, h / scale
            ox = min(max(cx * w - cw / 2, 0), w - cw)
            oy = min(max(cy * h - ch / 2, 0), h - ch)
            rects = [((x - ox) * scale, (y - oy) * scale, rw * scale, rh * scale) for x, y, rw, rh in rects]
        for mob, (x, y, rw, rh) in zip(self.mobs, rects):
            mob.set_width(canvas.length(rw), stretch=True).set_height(canvas.length(rh), stretch=True)
            place(mob, canvas, x, y, "top_left")
            mob.set_opacity(alpha)

    def close(self) -> None:
        for video in self.videos:
            video.close()


class _SceneRuntime:
    """Mobject của một cảnh, dựng khi cảnh sắp hiện và giải phóng khi đã qua."""

    def __init__(self, ctx: "VideoScene", plan: ScenePlan, index: int) -> None:
        self.ctx, self.plan = ctx, plan
        look, canvas, type_ = ctx.look, ctx.canvas, ctx.type
        self.seg_len = plan.duration / len(plan.segments)
        self.blend = min(look.segment_blend, self.seg_len / 3)
        self.backgrounds = [_Background(ctx, seg, motion, self.seg_len + self.blend)
                            for seg, motion in zip(plan.segments, plan.motions)]
        self.camera = _camera_fn(plan.camera, index)
        self.videos: list[VideoMobject] = []
        cache = ctx.cache_dir
        clips: list[Element | None] = []
        overlays: list[Element | None] = []
        if plan.title:
            overlays += title_elements(plan.title[0], plan.title[1], canvas, type_, look.accent, plan.title_end)
        if plan.badge:
            reserve = round(canvas.base * 0.2) if look.logo else 0  # logo nằm ở góc trên phải
            overlays.append(badge_element(plan.badge[0], plan.badge[1], canvas, type_, look.accent, reserve))
        if plan.meme:
            overlays += meme_elements(plan.meme[0], plan.meme[1], canvas, type_, plan.meme[2])
        if plan.cta_start is not None:
            overlays.append(cta_element(look.cta, canvas, type_, look.accent, plan.cta_start))
        if plan.overlay:
            path, media, slot, start = plan.overlay
            if media == "video":
                # Clip lồng trên ảnh nền suốt cảnh: hình không chỉ là ảnh tĩnh mà có video chạy bên trong
                clips.append(self._clip(path, slot, start, None, big=True))
            else:
                layer = sticker_layer(path, look.size, slot, start, None)
                overlays.append(picture_element(layer, canvas, cache, "overlay") if layer else None)
        for v in plan.visuals:
            if v.text:
                overlays.append(pop_text_element(v.text, canvas, type_, look.accent, v.start, v.end))
            elif v.sticker.media == "video":
                clips.append(self._clip(v.sticker.path, v.slot, v.start, v.end))
            else:
                layer = sticker_layer(v.sticker.path, look.size, v.slot, v.start, v.end)
                overlays.append(picture_element(layer, canvas, cache, "sticker") if layer else None)
        # Clip lồng vẽ dưới chữ/sticker, phụ đề trên cùng (như engine cũ)
        self.elements = [e for e in clips + overlays if e]
        self.subtitles = None
        if plan.narration and look.subtitles != "none":
            cues = build_cues(plan.narration, plan.words, plan.speech, look.subtitles, look.size)
            self.subtitles = Subtitles(cues, look.subtitles, canvas, type_, look.accent, offset=plan.head)

    def _clip(self, path: Path, slot: str, start: float, end: float | None, big: bool = False) -> Element | None:
        """Clip video lồng trên hình (picture-in-picture) trong khung viền trắng, bật ra ở một góc."""
        ctx, canvas = self.ctx, self.ctx.canvas
        try:
            win, (ix, iy, fw, fh), _, (x, y) = clip_window(ctx.look.size, slot, _video_size(path), big)
            window = image_mobject(win, ctx.cache_dir, "clipwin", canvas.length(win.width))
            place(window, canvas, x, y, "top_left")
            video = VideoMobject(path, (fw, fh), ctx.fps, ctx.cache_dir, ctx.ffmpeg, cover=False)
            video.set_width(canvas.length(fw), stretch=True).set_height(canvas.length(fh), stretch=True)
            place(video, canvas, x + ix, y + iy, "top_left")
        except Exception as e:  # clip hỏng không được làm hỏng cả video
            print(f"      ⚠️  Không lồng được clip {path.name}: {e}", flush=True)
            return None
        self.videos.append(video)
        return Element(Group(window, video), start, end if end is not None else self.plan.duration, enter="pop",
                       enter_dur=0.3, frames=video.seek)

    def update(self, local: float, frame_left: float) -> list[Mobject]:
        """Đặt trạng thái của cảnh tại `local` giây; trả về các mobject đang hiện theo thứ tự vẽ (dưới -> trên)."""
        local = min(local, self.plan.duration)
        k = min(int(local // self.seg_len), len(self.backgrounds) - 1)
        u = local - k * self.seg_len
        cam = self.camera(local) if self.camera else None
        visible: list[Mobject] = []
        if k > 0 and u < self.blend:
            # Đoạn trước tiếp tục chạy thêm một chút, hòa dần sang đoạn mới
            prev = self.backgrounds[k - 1]
            prev.update(self.seg_len + u, 1.0, cam)
            visible += prev.mobs
            self.backgrounds[k].update(u, u / self.blend, cam)
        else:
            self.backgrounds[k].update(u, 1.0, cam)
        visible += self.backgrounds[k].mobs
        for element in self.elements:
            if element.visible(local):
                element.apply(local, frame_left)
                visible.append(element.mob)
        if self.subtitles:
            element = self.subtitles.element_at(local)
            if element:
                element.apply(local, frame_left)
                visible.append(element.mob)
        return visible

    def close(self) -> None:
        for item in [*self.backgrounds, *self.videos]:
            item.close()


class VideoScene(Scene):
    """Cả video là một Scene của Manim; construct() tự chạy từng khung hình (không dùng play/wait để không lệch tiếng)."""

    def __init__(self, plans: list[ScenePlan], timeline: Timeline, look: Look, out_path: Path, audio_path: Path,
                 work_dir: Path, fps: int = 30, thumbnail: Path | None = None, progress=None) -> None:
        self.plans, self.timeline, self.look, self.fps = plans, timeline, look, fps
        self.out_path, self.audio_path, self.thumbnail, self.progress = out_path, audio_path, thumbnail, progress
        self.cache_dir = work_dir / "manim"
        self.ffmpeg = ffmpeg_exe()
        self.canvas = Canvas(look.size, look.frame_size)
        # Shader của manimgl chuẩn hóa tọa độ theo FRAME_WIDTH (tính một lần từ cấu hình 16:9): đặt theo khung của video
        # này, không thì video dọc/vuông bị bóp ngang
        camera_module.FRAME_WIDTH = self.canvas.frame_shape[0]
        super().__init__(
            camera_config=dict(resolution=look.frame_size, fps=fps, background_color=BLACK,
                               frame_config=dict(frame_shape=self.canvas.frame_shape)),
            file_writer_config=dict(write_to_movie=False, quiet=True),
        )

    def construct(self) -> None:
        look, canvas, tl = self.look, self.canvas, self.timeline
        fw, fh = look.frame_size
        self.type = Typography(look.fonts, canvas)
        self.runtimes: dict[int, _SceneRuntime] = {}
        self.global_mobs: list[Mobject] = []
        self.bg_video = self._background_video() if look.bg_video else None
        logo = logo_layer(look.logo, look.frame_size) if look.logo else None
        if logo:
            self.global_mobs.append(picture_element(logo, canvas, self.cache_dir, "logo", enter="none").mob)
        self.bar_h = max(4, round(fh * 0.006))
        if look.progress_bar:
            track = place(full_frame_rect(canvas, BLACK, 0.35, (fw, self.bar_h)), canvas, fw / 2, self.bar_h / 2)
            self.bar = full_frame_rect(canvas, hex_color(look.accent), 1.0, (fw, self.bar_h))
            self.global_mobs += [track, self.bar]
        self.fade = place(full_frame_rect(canvas, BLACK, 0.0, look.frame_size), canvas, fw / 2, fh / 2)
        self.panel = full_frame_rect(canvas, BLACK, 0.0)
        self.iris = accent_circle(hex_color(look.accent))
        self.order: list[Mobject] = []

        frames = int(np.ceil(tl.total * self.fps - 1e-6))
        thumb_at = round(min(1.6, tl.total / 2) * self.fps)
        writer = self._open_writer()
        last_report = 0.0
        try:
            for n in range(frames):
                undo = self._compose(n / self.fps)
                self.update_frame(1 / self.fps)
                writer.stdin.write(self.camera.get_raw_fbo_data())
                if n == thumb_at and self.thumbnail:
                    self._save_thumbnail()
                for fn in reversed(undo):
                    fn()
                now = time.monotonic()
                if self.progress and (now - last_report >= 1.0 or n == frames - 1):
                    last_report = now
                    self.progress((n + 1) / frames)
        finally:
            writer.stdin.close()
            code = writer.wait()
            for runtime in self.runtimes.values():
                runtime.close()
            if self.bg_video:
                self.bg_video.close()
        if code:
            raise RuntimeError(f"ffmpeg ghi video lỗi (mã {code})")

    def _background_video(self) -> VideoMobject:
        """Video nền (gameplay) ở nửa dưới bố cục chia đôi: tắt tiếng, phủ kín, tự lặp."""
        fw, fh = self.look.frame_size
        h = self.look.size[1]
        size = (fw, fh - h)
        video = VideoMobject(self.look.bg_video, size, self.fps, self.cache_dir, self.ffmpeg, cover=True)
        video.set_width(self.canvas.length(size[0]), stretch=True).set_height(self.canvas.length(size[1]), stretch=True)
        place(video, self.canvas, 0, h, "top_left")
        self.global_mobs.append(video)
        return video

    def _open_writer(self) -> subprocess.Popen:
        fw, fh = self.look.frame_size
        self.out_path.parent.mkdir(parents=True, exist_ok=True)
        cmd = [
            self.ffmpeg, "-v", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{fw}x{fh}", "-r", str(self.fps), "-i", "-",
            "-i", str(self.audio_path),
            "-map", "0:v", "-map", "1:a", "-vf", "vflip",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(self.out_path),
        ]
        return subprocess.Popen(cmd, stdin=subprocess.PIPE)

    def _save_thumbnail(self) -> None:
        # Khung hình title card (đã hiện đủ tiêu đề) làm ảnh đại diện; lỗi ở đây không làm hỏng video
        try:
            self.camera.get_image().convert("RGB").save(self.thumbnail, "JPEG", quality=88)
        except Exception as e:  # noqa: BLE001
            print(f"      ⚠️  Không tạo được thumbnail: {e}", flush=True)

    def _runtime(self, i: int) -> _SceneRuntime:
        if i not in self.runtimes:
            self.runtimes[i] = _SceneRuntime(self, self.plans[i], i)
        return self.runtimes[i]

    def _compose(self, t: float) -> list:
        """Đặt trạng thái khung hình tại t; trả về các hàm hoàn tác phép chuyển cảnh (gọi sau khi vẽ)."""
        tl, canvas, look = self.timeline, self.canvas, self.look
        i = max(0, bisect_right(tl.starts, t) - 1)
        local = t - tl.starts[i]
        transition = i > 0 and local < tl.transition
        active = [i - 1, i] if transition else [i]
        for k in [k for k in self.runtimes if k < active[0]]:
            self.runtimes.pop(k).close()
        frame_left = canvas.point(0, 0)[0]
        drawn = {k: self._runtime(k).update(t - tl.starts[k], frame_left) for k in active}
        undo: list = []
        extra: list[Mobject] = []
        if transition:
            shown, extra = self._transition(tl.kinds[i - 1], local / tl.transition, drawn[i - 1], drawn[i], undo)
        else:
            shown = drawn[i]
        if self.bg_video:
            self.bg_video.seek(t)
        if look.progress_bar:
            width = max(1.0, look.frame_size[0] * min(t / tl.total, 1.0))
            self.bar.set_width(canvas.length(width), stretch=True)
            place(self.bar, canvas, 0, self.bar_h / 2, "left")
        k = min(1.0, t / FADE_IN, (tl.total - t) / FADE_OUT)  # mờ dần đầu/cuối video
        self.fade.set_fill(opacity=1 - max(0.0, k))
        order = [*shown, *extra, *self.global_mobs, *([self.fade] if k < 1 else [])]
        if order != self.order:
            self.order = order
            self.mobjects = [self.camera.frame, *order]
            self.assemble_render_groups()
        return undo

    def _transition(self, kind: str, p: float, old: list[Mobject], new: list[Mobject], undo: list):
        """(mobject hiện theo thứ tự vẽ, lớp phủ) của đoạn chuyển cảnh ở tiến độ p (0-1)."""
        canvas = self.canvas
        fw, fh = canvas.content_shape
        center = canvas.center

        def move(mobs: list[Mobject], dx: float = 0.0, dy: float = 0.0, scale: float = 1.0) -> None:
            for mob in mobs:
                if scale != 1.0:
                    mob.scale(scale, about_point=center)
                mob.shift([dx, dy, 0])

            def back() -> None:
                for mob in mobs:
                    mob.shift([-dx, -dy, 0])
                    if scale != 1.0:
                        mob.scale(1 / scale, about_point=center)

            undo.append(back)

        if kind.startswith(("slide_", "whip_")):
            # Đẩy: cảnh cũ trượt ra, cảnh mới trượt vào (lia nhanh: tăng tốc gắt hơn)
            e = (in_out_quint if kind.startswith("whip_") else in_out_cubic)(p)
            vx, vy = {"left": (-fw, 0), "right": (fw, 0), "up": (0, fh), "down": (0, -fh)}[kind.split("_", 1)[1]]
            move(old, vx * e, vy * e)
            move(new, -vx * (1 - e), -vy * (1 - e))
            return [*old, *new], []
        half = p < 0.5
        q = p * 2 if half else (1 - p) * 2  # 0 -> 1 (giữa đoạn chuyển) -> 0
        shown = old if half else new
        if kind == "zoom":
            # Cảnh cũ lao tới rồi tối dần, cảnh mới từ gần lùi về vị trí
            move(shown, scale=1 + 0.35 * out_cubic(q))
            self.panel.set_fill(BLACK, opacity=0.85 * smooth(q))
            return shown, [self.panel]
        if kind in ("fade", "flash"):
            self.panel.set_fill(WHITE if kind == "flash" else BLACK, opacity=smooth(min(1.0, q * (1.4 if kind == "flash" else 1.0))))
            return shown, [self.panel]
        if kind == "wipe":
            # Tấm màu chủ đạo quét ngang qua khung: che cảnh cũ rồi để lộ cảnh mới
            self.panel.set_fill(hex_color(self.look.accent), opacity=1.0)
            self.panel.move_to(center + np.array([fw * 1.05 * (in_out_cubic(p) * 2 - 1), 0, 0]))
            undo.append(lambda: self.panel.move_to(center))
            return shown, [self.panel]
        # circle: vòng tròn màu chủ đạo nở ra che kín khung rồi thu lại để lộ cảnh mới
        radius = max(1e-3, np.hypot(fw, fh) / 2 * in_out_cubic(q))
        self.iris.set_width(radius * 2).move_to(center)
        return shown, [self.iris]
