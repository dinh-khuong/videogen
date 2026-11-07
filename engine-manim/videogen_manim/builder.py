"""Renderer ManimGL: dựng video từ đúng danh sách `Scene` mà videogen.pipeline tạo, thay cho videogen.video_builder.

Timeline (thời lượng cảnh, đoạn hình, chuyển động, kiểu chuyển cảnh) và track âm thanh lấy từ video_builder.plan_timeline /
audio_track, nên tiếng giống renderer classic từng mẫu. Ở đây chỉ có phần hình: khung hình thứ n là thời điểm n/fps của
timeline; mỗi khung đặt trạng thái các mobject của cảnh đang hiện (ảnh Ken Burns, clip video, lớp chữ/sticker có hoạt ảnh,
phụ đề chữ vector), áp phép chuyển cảnh, để Manim vẽ bằng OpenGL rồi đẩy điểm ảnh thẳng vào ffmpeg cùng track âm thanh.
"""
import subprocess
import wave
from bisect import bisect_right
from io import BytesIO
from pathlib import Path

import numpy as np
import proglog
from PIL import Image

from videogen.effects import STILL, color_filter, in_out_cubic, in_out_quint, make_motion, motion_box, out_cubic, smooth
from videogen.graphics import Fonts, clip_window, framed_backdrop, logo_layer, prepare_background, resolve_fonts
from videogen.probe import ffmpeg_exe, video_info
from videogen.style import Style
from videogen.subtitles import build_cues
from videogen.video_builder import (
    ASPECTS, AUDIO_RATE, FADE_IN, FADE_OUT, FRAME_ZOOM, ClipOverlay, Scene, Segment, Timeline, _camera_fn, audio_track,
    plan_timeline, split_sizes,
)

from . import _manim  # noqa: F401  (nạp manimlib trước khi import các lớp của nó)
from manimlib.camera import camera as camera_module
from manimlib.mobject.mobject import Group, Mobject
from manimlib.scene.scene import Scene as ManimScene

from .mobjects import (
    BLACK, WHITE, Canvas, Element, Subtitles, Typography, VideoMobject, accent_circle, full_frame_rect, hex_color,
    image_mobject, layer_element, place,
)


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


def _write_wav(track: np.ndarray, path: Path) -> Path:
    pcm = (np.clip(track, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as f:
        f.setnchannels(2)
        f.setsampwidth(2)
        f.setframerate(AUDIO_RATE)
        f.writeframes(pcm.tobytes())
    return path


class _Background:
    """Một đoạn hình nền của cảnh: ảnh chuyển động Ken Burns, hoặc clip video (phủ kín, hay hiện trọn trên nền mờ)."""

    def __init__(self, ctx: "VideoScene", seg: Segment, motion: str | None, length: float) -> None:
        self.ctx, self.length = ctx, length
        canvas, size, pacing, grade = ctx.canvas, ctx.size, ctx.style.timing, ctx.grade
        w, h = size
        self.videos: list[VideoMobject] = []
        self.push = 1.0
        self.motion = None
        if seg.media == "video":
            vw, vh = _video_size(seg.path)
            ratio, frame_ratio = vw / vh, w / h
            if seg.style == "frame" or abs(ratio - frame_ratio) / frame_ratio > 0.45:
                # Clip lệch tỉ lệ nhiều / là nội dung chính: hiện trọn trên nền mờ (như renderer classic)
                backdrop, (x, y, fw, fh), _ = framed_backdrop(_middle_frame(seg.path), size, (vw, vh))
                back = image_mobject(grade(backdrop) if grade else backdrop, ctx.cache_dir, "backdrop", canvas.length(w))
                video = VideoMobject(seg.path, (fw, fh), ctx.fps, ctx.cache_dir, ctx.ffmpeg, cover=False, grade=grade)
                self.mobs: list[Mobject] = [back, video]
                self.rects = [(0, 0, w, h), (x, y, fw, fh)]
            else:
                video = VideoMobject(seg.path, (w, h), ctx.fps, ctx.cache_dir, ctx.ffmpeg, cover=True, grade=grade)
                self.push = pacing.clip_push  # zoom chậm vào giữa cho sinh động
                self.mobs = [video]
                self.rects = [(0, 0, w, h)]
            self.videos = [video]
            return
        zoom = pacing.zoom
        kind = motion or STILL
        if seg.style == "frame" and kind != STILL:
            # Ảnh là nội dung chính: chỉ zoom rất nhẹ để chữ trong ảnh luôn đọc được
            zoom = FRAME_ZOOM
            kind = "zoom_out" if kind in ("zoom_out", "pan_left", "pan_up") else "zoom_in"
        self.zoom, self.big = zoom, (round(w * zoom), round(h * zoom))
        img = prepare_background(seg.path, self.big, seg.style).convert("RGB")
        self.mobs = [image_mobject(grade(img) if grade else img, ctx.cache_dir, "bg", canvas.length(self.big[0]))]
        self.motion = make_motion(kind, zoom)

    def update(self, u: float, alpha: float, cam: tuple[float, float, float] | None) -> None:
        """u: giây từ đầu đoạn; alpha: độ hiện (hòa sang đoạn sau); cam: (phóng, tâm x, tâm y) của zoom giật/rung."""
        canvas = self.ctx.canvas
        w, h = self.ctx.size
        if self.motion:
            # Khung cắt trên ảnh lớn (như renderer classic) -> phóng/dời ảnh sao cho khung cắt vừa khít khung hình
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

    def __init__(self, ctx: "VideoScene", scene: Scene, index: int) -> None:
        tl, pacing = ctx.timeline, ctx.style.timing
        self.ctx, self.duration = ctx, tl.durations[index]
        segments = tl.segments[index]
        self.seg_len = self.duration / len(segments)
        self.blend = min(pacing.segment_blend, self.seg_len / 3)
        self.backgrounds = [_Background(ctx, seg, motion, self.seg_len + self.blend)
                            for seg, motion in zip(segments, tl.motions[index])]
        self.camera = _camera_fn([(pacing.head + t, kind) for t, kind in scene.camera], index)
        self.videos: list[VideoMobject] = []
        # Clip lồng vẽ dưới lớp chữ/sticker, phụ đề trên cùng (như renderer classic)
        clips = [self._clip(clip) for clip in scene.clips]
        layers = [layer_element(layer, ctx.canvas, ctx.cache_dir) for layer in scene.overlays]
        self.elements = [e for e in clips + layers if e]
        self.subtitles = None
        kind = ctx.style.subtitles_for(ctx.size)
        if scene.narration and kind != "none":
            speech = tl.speeches[index]
            cues = build_cues(scene.narration, scene.words, len(speech) / AUDIO_RATE if speech is not None else 0.0,
                              kind, ctx.size)
            self.subtitles = Subtitles(cues, kind, ctx.canvas, ctx.type, ctx.style.accent, offset=pacing.head)

    def _clip(self, clip: ClipOverlay) -> Element | None:
        """Clip video lồng trên hình (picture-in-picture) trong khung viền trắng, bật ra ở một góc."""
        ctx, canvas = self.ctx, self.ctx.canvas
        try:
            win, (ix, iy, fw, fh), _, (x, y) = clip_window(ctx.size, clip.slot, _video_size(clip.path), clip.big)
            window = image_mobject(win, ctx.cache_dir, "clipwin", canvas.length(win.width))
            place(window, canvas, x, y, "top_left")
            video = VideoMobject(clip.path, (fw, fh), ctx.fps, ctx.cache_dir, ctx.ffmpeg, cover=False)
            video.set_width(canvas.length(fw), stretch=True).set_height(canvas.length(fh), stretch=True)
            place(video, canvas, x + ix, y + iy, "top_left")
        except Exception as e:  # clip hỏng không được làm hỏng cả video
            print(f"      ⚠️  Không lồng được clip {clip.path.name}: {e}", flush=True)
            return None
        self.videos.append(video)
        end = self.duration if clip.end is None else min(clip.end, self.duration)
        return Element(Group(window, video), clip.start, end, enter="pop", enter_dur=0.3, frames=video.seek)

    def update(self, local: float, frame_left: float) -> list[Mobject]:
        """Đặt trạng thái của cảnh tại `local` giây; trả về các mobject đang hiện theo thứ tự vẽ (dưới -> trên)."""
        local = min(local, self.duration)
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


class VideoScene(ManimScene):
    """Cả video là một Scene của Manim; construct() tự chạy từng khung hình (không dùng play/wait để không lệch tiếng)."""

    def __init__(self, scenes: list[Scene], timeline: Timeline, style: Style, fonts: Fonts, size: tuple[int, int],
                 frame_size: tuple[int, int], out_path: Path, audio_path: Path, cache_dir: Path, fps: int,
                 bg_video: Path | None, thumbnail: Path | None, logger) -> None:
        self.scenes, self.timeline, self.style, self.fonts, self.fps = scenes, timeline, style, fonts, fps
        self.size, self.frame_size, self.bg_path = size, frame_size, bg_video
        self.out_path, self.audio_path, self.thumbnail, self.logger = out_path, audio_path, thumbnail, logger
        self.cache_dir, self.ffmpeg, self.grade = cache_dir, ffmpeg_exe(), color_filter(style.color_filter)
        self.canvas = Canvas(size, frame_size)
        # Shader của manimgl chuẩn hóa tọa độ theo FRAME_WIDTH (tính một lần từ cấu hình 16:9): đặt theo khung của video
        # này, không thì video dọc/vuông bị bóp ngang
        camera_module.FRAME_WIDTH = self.canvas.frame_shape[0]
        super().__init__(
            camera_config=dict(resolution=frame_size, fps=fps, background_color=BLACK,
                               frame_config=dict(frame_shape=self.canvas.frame_shape)),
            file_writer_config=dict(write_to_movie=False, quiet=True),
        )

    def construct(self) -> None:
        canvas, tl, style = self.canvas, self.timeline, self.style
        fw, fh = self.frame_size
        self.type = Typography(self.fonts, canvas)
        self.runtimes: dict[int, _SceneRuntime] = {}
        self.global_mobs: list[Mobject] = []
        self.bg_video = self._background_video() if self.bg_path else None
        logo = logo_layer(style.logo, self.frame_size) if style.logo else None
        if logo:
            self.global_mobs.append(layer_element(logo, canvas, self.cache_dir).mob)
        self.bar_h = max(4, round(fh * 0.006))
        if style.progress_bar:
            track = place(full_frame_rect(canvas, BLACK, 0.35, (fw, self.bar_h)), canvas, fw / 2, self.bar_h / 2)
            self.bar = full_frame_rect(canvas, hex_color(style.accent), 1.0, (fw, self.bar_h))
            self.global_mobs += [track, self.bar]
        self.fade = place(full_frame_rect(canvas, BLACK, 0.0, self.frame_size), canvas, fw / 2, fh / 2)
        self.panel = full_frame_rect(canvas, BLACK, 0.0)
        self.iris = accent_circle(hex_color(style.accent))
        self.order: list[Mobject] = []

        frames = int(np.ceil(tl.total * self.fps - 1e-6))
        thumb_at = round(min(1.6, tl.total / 2) * self.fps)
        writer = self._open_writer()
        try:
            # Báo tiến độ qua proglog như moviepy (thanh "t"): web nhận sự kiện "Đang render N%"
            for n in self.logger.iter_bar(t=range(frames)):
                undo = self._compose(n / self.fps)
                self.update_frame(1 / self.fps)
                writer.stdin.write(self.camera.get_raw_fbo_data())
                if n == thumb_at and self.thumbnail:
                    self._save_thumbnail()
                for fn in reversed(undo):
                    fn()
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
        fw, fh = self.frame_size
        h = self.size[1]
        size = (fw, fh - h)
        video = VideoMobject(self.bg_path, size, self.fps, self.cache_dir, self.ffmpeg, cover=True)
        video.set_width(self.canvas.length(size[0]), stretch=True).set_height(self.canvas.length(size[1]), stretch=True)
        place(video, self.canvas, 0, h, "top_left")
        self.global_mobs.append(video)
        return video

    def _open_writer(self) -> subprocess.Popen:
        fw, fh = self.frame_size
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
            self.runtimes[i] = _SceneRuntime(self, self.scenes[i], i)
        return self.runtimes[i]

    def _compose(self, t: float) -> list:
        """Đặt trạng thái khung hình tại t; trả về các hàm hoàn tác phép chuyển cảnh (gọi sau khi vẽ)."""
        tl, canvas = self.timeline, self.canvas
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
        if self.style.progress_bar:
            width = max(1.0, self.frame_size[0] * min(t / tl.total, 1.0))
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
        """(mobject hiện theo thứ tự vẽ, lớp phủ) của đoạn chuyển cảnh ở tiến độ p (0-1), cùng tên kiểu với
        videogen.effects.TRANSITION_GROUPS."""
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
            flash = kind == "flash"
            self.panel.set_fill(WHITE if flash else BLACK, opacity=smooth(min(1.0, q * (1.4 if flash else 1.0))))
            return shown, [self.panel]
        if kind == "wipe":
            # Tấm màu chủ đạo quét ngang qua khung: che cảnh cũ rồi để lộ cảnh mới
            self.panel.set_fill(hex_color(self.style.accent), opacity=1.0)
            self.panel.move_to(center + np.array([fw * 1.05 * (in_out_cubic(p) * 2 - 1), 0, 0]))
            undo.append(lambda: self.panel.move_to(center))
            return shown, [self.panel]
        # circle: vòng tròn màu chủ đạo nở ra che kín khung rồi thu lại để lộ cảnh mới
        radius = max(1e-3, np.hypot(fw, fh) / 2 * in_out_cubic(q))
        self.iris.set_width(radius * 2).move_to(center)
        return shown, [self.iris]


def build_video(
    scenes: list[Scene],
    out_path: Path,
    aspect: str = "16:9",
    fps: int = 30,
    music_path: Path | None = None,
    music_volume: float = 0.12,
    fonts: Fonts | None = None,
    work_dir: Path | None = None,
    bg_video: Path | None = None,
    logger="bar",
    thumbnail_path: Path | None = None,
    style: Style | None = None,
) -> float:
    """Như videogen.video_builder.build_video (cùng tham số, cùng track âm thanh) nhưng dựng hình bằng ManimGL."""
    style = style or Style()
    fonts = fonts or resolve_fonts()
    if bg_video:
        size, _ = split_sizes()
        frame_size = ASPECTS["9:16"]
    else:
        size = frame_size = ASPECTS[aspect]
    work = work_dir or out_path.parent
    timeline = plan_timeline(scenes, style)
    audio = _write_wav(audio_track(scenes, timeline, style, music_path, music_volume),
                       work / f"{out_path.stem}.temp-audio.wav")
    try:
        VideoScene(
            scenes, timeline, style, fonts, size, frame_size, out_path, audio, work / "manim", fps, bg_video,
            thumbnail_path, proglog.default_bar_logger(logger),
        ).run()
    finally:
        audio.unlink(missing_ok=True)
    return timeline.total
