"""Dựng video từ các scene: ảnh (Ken Burns đa dạng) hoặc clip video + lớp đồ họa động + phụ đề + giọng đọc.

Mỗi khung hình được ghép trực tiếp bằng Pillow theo một timeline: scene sau chồng lên `transition` giây cuối của
scene trước, đoạn chồng nhau dùng một kiểu chuyển cảnh (đẩy, lia nhanh, zoom, quét, vòng tròn...). Sau đó thêm
video nền (bố cục chia đôi), logo, thanh tiến độ và mờ dần đầu/cuối. Âm thanh dựng riêng thành một track liền mạch.
"""
import hashlib
import os
import random
import subprocess
from bisect import bisect_right
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import numpy as np
from moviepy.audio.AudioClip import AudioArrayClip
from moviepy.editor import VideoClip, VideoFileClip, vfx
from PIL import Image, ImageDraw

from . import sfx
from .effects import (
    ALL_MOTIONS, MOTIONS, STILL, TRANSITION_FNS, WHOOSH_TRANSITIONS, Layer, color_filter, draw_layer, in_out_cubic, make_motion, motion_box,
    out_cubic, pick_transitions, zoom_crop,
)
from .graphics import Fonts, clip_window, framed_backdrop, logo_layer, prepare_background, resolve_fonts
from .probe import ffmpeg_exe, video_info
from .style import Style
from .subtitles import SubtitleTrack, build_cues

FRAME_ZOOM = 1.04  # zoom nhẹ khi ảnh là nội dung chính (giữ trọn ảnh, chữ trong ảnh dễ đọc)
SILENT_SCENE = 3.0 # thời lượng scene không có giọng đọc

ASPECTS = {"16:9": (1280, 720), "9:16": (720, 1280), "1:1": (1080, 1080)}
SPLIT_RATIO = 0.5  # tỉ lệ chiều cao phần nội dung (nửa trên) khi có video nền
CLIP_MAX_SIDE = 1280  # clip lớn hơn được thu nhỏ trước khi dựng (giải mã 4K mỗi khung hình rất chậm)

AUDIO_RATE = 44100
EDGE_FADE = 0.008  # làm mềm đầu/cuối mỗi đoạn âm thanh để không có tiếng "bụp"
FADE_IN, FADE_OUT = 0.4, 0.6  # mờ dần đầu/cuối video (hình và tiếng)
MUSIC_FADE_IN, MUSIC_FADE_OUT = 1.0, 2.0
# Âm thanh của người dùng gắn vào câu thoại: dài tối đa chừng này, đỉnh chuẩn hóa về SOUND_PEAK rồi nhân ASSET_SOUND_GAIN
MAX_SOUND_SECONDS, SOUND_PEAK, ASSET_SOUND_GAIN, SOUND_FADE_OUT = 10.0, 0.9, 0.35, 0.25
WHOOSH_GAIN, POP_GAIN = 0.16, 0.11  # âm lượng hiệu ứng âm thanh so với giọng đọc
TRANSITION_ASSET_GAIN = 0.6  # tiếng chuyển cảnh lấy từ thư viện lặp lại ở mọi cảnh: nhỏ hơn tiếng gắn vào câu thoại


@dataclass
class Segment:
    """Một đoạn hình trong scene: ảnh (Ken Burns) hoặc clip video."""
    path: Path
    media: str = "image"  # image | video
    style: str = "cover"  # cover: phủ kín khung (làm nền) | frame: hiện trọn vẹn làm nội dung chính


@dataclass
class ClipOverlay:
    """Clip video lồng lên trên hình của scene (picture-in-picture): tắt tiếng, tự lặp, bật ra ở một góc khung.

    Dùng cho clip meme/reaction chen vào theo câu thoại, hoặc clip lồng suốt cảnh trên ảnh nền.
    """
    path: Path
    slot: str = "br"  # br | bl | tr | tl | center
    start: float = 0.0  # giây trong scene (đã cộng khoảng lặng đầu cảnh)
    end: float | None = None  # None: tới hết scene
    big: bool = False  # lồng suốt cảnh: khung to hơn


@dataclass
class Scene:
    segments: list[Segment]  # nối tiếp nhau, chia đều thời lượng scene (vd nhiều clip cho một bước)
    audio_path: Path | None
    narration: str = ""
    overlays: list[Layer] = field(default_factory=list)  # nhãn bước, title card, lời kêu gọi... (có hoạt ảnh)
    words: list[dict] | None = None  # thời điểm từng từ của giọng đọc (edge-tts), để phụ đề khớp tiếng
    pops: list[float] = field(default_factory=list)  # thời điểm (giây trong scene) phát tiếng "tách"
    # Hiệu ứng theo câu thoại (Đạo diễn AI), thời điểm tính theo giọng đọc (chưa cộng khoảng lặng đầu cảnh)
    camera: list[tuple[float, str]] = field(default_factory=list)  # (giây, punch | shake | zoom_slow)
    # (giây, tên âm thanh trong sfx.named | file âm thanh của người dùng)
    sounds: list[tuple[float, str | Path]] = field(default_factory=list)
    clips: list[ClipOverlay] = field(default_factory=list)  # clip video lồng trên hình (vẽ dưới chữ/phụ đề)
    # Chuyển động của ảnh đầu tiên trong scene (theo cảm xúc hoặc do Đạo diễn AI chọn); None: luân phiên ngẫu nhiên
    motion: str | None = None
    # Tiếng phát khi chuyển vào scene này (tên trong sfx.named | file âm thanh); None: theo style (tiếng "vút" mặc định)
    enter_sound: str | Path | None = None


@dataclass
class SceneRender:
    frame: Callable[[float], Image.Image]
    duration: float
    sources: list


@dataclass
class Timeline:
    """Thời gian của cả video, chung cho mọi renderer (moviepy ở đây, ManimGL ở engine-manim/): cùng kịch bản cho ra
    cùng thời lượng cảnh, chuyển động, kiểu chuyển cảnh và track âm thanh."""
    speeches: list[np.ndarray | None]  # giọng đọc đã giải mã của từng scene
    durations: list[float]
    segments: list[list[Segment]]  # đoạn hình thật sự dùng của từng scene (bỏ bớt nếu scene quá ngắn)
    motions: list[list[str | None]]  # chuyển động Ken Burns của từng đoạn ảnh (None: clip video)
    starts: list[float]  # scene sau bắt đầu chồng lên `transition` giây cuối của scene trước
    transition: float
    kinds: list[str]  # kiểu chuyển cảnh giữa scene i và i+1
    total: float


PUNCH_ZOOM, PUNCH_HOLD = 1.18, 0.9
SHAKE_LEN = 0.45


def _camera_fn(events: list[tuple[float, str]], seed: int) -> Callable[[float], tuple[float, float, float]] | None:
    """t -> (độ phóng, tâm x, tâm y) cho zoom giật (punch), rung khung (shake) và zoom chậm kịch tính."""
    if not events:
        return None
    rng = np.random.default_rng(seed)
    jitter = rng.uniform(-1, 1, size=(64, 2))

    def at(t: float) -> tuple[float, float, float]:
        scale, cx, cy = 1.0, 0.5, 0.5
        for start, kind in events:
            local = t - start
            if local < 0:
                continue
            if kind == "punch":
                if local < 0.07:
                    k = out_cubic(local / 0.07)
                elif local < PUNCH_HOLD:
                    k = 1.0
                else:
                    k = 1 - in_out_cubic((local - PUNCH_HOLD) / 0.25)
                scale = max(scale, 1 + (PUNCH_ZOOM - 1) * max(0.0, k))
            elif kind == "zoom_slow":
                scale = max(scale, 1 + 0.16 * in_out_cubic(local / 2.6))
            elif kind == "shake" and local < SHAKE_LEN:
                amp = 0.03 * (1 - local / SHAKE_LEN)
                dx, dy = jitter[int(local * 60) % len(jitter)]
                scale = max(scale, 1.08)
                cx, cy = 0.5 + dx * amp, 0.5 + dy * amp
        return scale, cx, cy

    return at


def prepare_clip(path: Path, cache_dir: Path | None) -> Path:
    """Video có metadata xoay (vd quay dọc bằng điện thoại) hoặc quá lớn: tạo bản đứng thẳng, nhỏ hơn để moviepy đọc đúng.

    moviepy 1.x đọc khung hình theo kích thước gốc nên video xoay 90° bị vỡ hình. Kết quả được cache theo nội dung file.
    """
    info = video_info(path)
    w, h = info.get("width") or 0, info.get("height") or 0
    if not info.get("rotation") and max(w, h) <= CLIP_MAX_SIDE:
        return path
    stat = path.stat()
    key = hashlib.sha1(f"{path.resolve()}|{stat.st_size}|{stat.st_mtime_ns}".encode()).hexdigest()[:12]
    cache_dir = cache_dir or path.parent
    cache_dir.mkdir(parents=True, exist_ok=True)
    out = cache_dir / f"{path.stem}_{key}.mp4"
    if out.exists() and out.stat().st_size:
        return out
    tmp = out.with_suffix(".tmp.mp4")
    scale = f"scale='if(gt(iw,ih),min({CLIP_MAX_SIDE},iw),-2)':'if(gt(iw,ih),-2,min({CLIP_MAX_SIDE},ih))'"
    subprocess.run(
        [ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y", "-i", str(path), "-an", "-vf", scale,
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", str(tmp)],
        check=True, capture_output=True,
    )
    tmp.replace(out)
    return out


def _image_frames(seg: Segment, motion_kind: str, size: tuple[int, int], duration: float, zoom: float):
    """Ảnh tĩnh với chuyển động Ken Burns (zoom vào/ra, lia ngang/dọc...): trả về hàm t -> khung hình PIL."""
    w, h = size
    if seg.style == "frame" and motion_kind != STILL:
        # Ảnh là nội dung chính: chỉ zoom rất nhẹ để chữ trong ảnh luôn đọc được
        zoom = FRAME_ZOOM
        motion_kind = "zoom_out" if motion_kind in ("zoom_out", "pan_left", "pan_up") else "zoom_in"
    big_size = (round(w * zoom), round(h * zoom))
    background = prepare_background(seg.path, big_size, seg.style).convert("RGB")
    motion = make_motion(motion_kind, zoom)

    def frame_at(t: float) -> Image.Image:
        x0, y0, x1, y1 = motion_box(motion, t / duration, size, zoom)
        box = (max(0.0, x0), max(0.0, y0), min(big_size[0], x1), min(big_size[1], y1))
        return background.resize(size, Image.BILINEAR, box=box)

    return frame_at


def _video_frames(seg: Segment, size: tuple[int, int], cache_dir: Path | None, duration: float, push: float):
    """Clip video làm nội dung: tắt tiếng, tự lặp nếu ngắn hơn đoạn, zoom chậm vào giữa cho sinh động.

    Trả về (hàm t -> khung hình PIL, clip nguồn).
    """
    source = VideoFileClip(str(prepare_clip(seg.path, cache_dir)), audio=False)
    last = max(0.0, source.duration - 1.0 / (source.fps or 30))

    def source_frame(t: float) -> Image.Image:
        t = t % source.duration if source.duration > 0 else 0.0
        return Image.fromarray(source.get_frame(min(t, last))[..., :3])

    w, h = size
    clip_ratio, frame_ratio = source.w / source.h, w / h
    # Tỉ lệ lệch nhiều (vd video ngang trong khung dọc) thì hiện trọn vẹn thay vì cắt mất phần lớn hình
    if seg.style == "frame" or abs(clip_ratio - frame_ratio) / frame_ratio > 0.45:
        backdrop, (x, y, fw, fh), mask = framed_backdrop(source_frame(source.duration / 2), size, (source.w, source.h))

        def framed(t: float) -> Image.Image:
            frame = backdrop.copy()
            frame.paste(source_frame(t).resize((fw, fh), Image.BILINEAR), (x, y), mask)
            return frame

        return framed, source

    scale = max(w / source.w, h / source.h)
    base_w, base_h = w / scale, h / scale
    cx, cy = source.w / 2, source.h / 2

    def cover(t: float) -> Image.Image:
        s = 1 + (push - 1) * min(max(t / duration, 0.0), 1.0)
        cw, ch = base_w / s, base_h / s
        return source_frame(t).resize(size, Image.BILINEAR, box=(cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2))

    return cover, source


def _clip_layer(clip: ClipOverlay, size: tuple[int, int], cache_dir: Path | None) -> tuple[Layer, VideoFileClip]:
    """Lớp động cho một clip lồng trên hình: mỗi khung hình lấy frame mới của clip (lặp lại nếu clip ngắn)."""
    source = VideoFileClip(str(prepare_clip(clip.path, cache_dir)), audio=False)
    last = max(0.0, source.duration - 1.0 / (source.fps or 30))
    window, (ix, iy, fw, fh), mask, pos = clip_window(size, clip.slot, (source.w, source.h), clip.big)

    def frames(local: float) -> Image.Image:
        t = local % source.duration if source.duration > 0 else 0.0
        frame = Image.fromarray(source.get_frame(min(t, last))[..., :3]).resize((fw, fh), Image.BILINEAR)
        out = window.copy()
        out.paste(frame, (ix, iy), mask)
        return out

    layer = Layer(window, pos, start=clip.start, end=clip.end, enter="pop", enter_dur=0.3, frames=frames)
    return layer, source


def decode_audio(path: Path) -> np.ndarray:
    """Giải mã toàn bộ file âm thanh bằng ffmpeg thành mảng float32 (số mẫu, 2 kênh) ở AUDIO_RATE.

    Không dùng AudioFileClip của moviepy 1.x: nó đọc lố cuối file mp3 và trả về dữ liệu rác trong bộ đệm,
    gây tiếng "bụp"/âm thanh bị cắt ở cuối mỗi đoạn giọng đọc.
    """
    raw = subprocess.run(
        [ffmpeg_exe(), "-v", "error", "-i", str(path), "-vn", "-ac", "2", "-ar", str(AUDIO_RATE), "-f", "f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).copy()


@lru_cache(maxsize=32)
def _asset_sound(path: Path) -> tuple[np.ndarray, float] | None:
    """(mẫu âm thanh, âm lượng) của một file trong thư viện, dùng như hiệu ứng: cắt gọn, chuẩn hóa đỉnh để các file to nhỏ
    khác nhau nghe đều tay so với giọng đọc. File hỏng không được làm hỏng cả video."""
    try:
        samples = decode_audio(path)[: int(MAX_SOUND_SECONDS * AUDIO_RATE)]
    except Exception as e:  # noqa: BLE001
        print(f"      Bỏ qua âm thanh {path.name}: {type(e).__name__}", flush=True)
        return None
    peak = float(np.abs(samples).max()) if len(samples) else 0.0
    if peak < 1e-4:
        return None
    return _fade(samples / peak * SOUND_PEAK, 0.0, SOUND_FADE_OUT), ASSET_SOUND_GAIN


def _transition_effect(ref: str | Path | None, start: float, transition: float, index: int,
                       kind: str) -> tuple[float, np.ndarray, float] | None:
    """(thời điểm, mẫu, âm lượng) của tiếng chuyển cảnh: tiếng "vút" nằm giữa đoạn chuyển và dài theo nó, tiếng khác
    (tổng hợp) phát ngay giữa đoạn chuyển, file thư viện phát từ lúc bắt đầu chuyển."""
    if ref == "whoosh":
        sound = sfx.whoosh(round(max(0.4, transition * 1.4), 2), seed=index % 3, direction=-1 if kind.endswith("right") else 1)
        return start + transition / 2 - len(sound) / AUDIO_RATE / 2, sound, WHOOSH_GAIN
    if isinstance(ref, Path):
        sound = _asset_sound(ref)
        return (start, sound[0], sound[1] * TRANSITION_ASSET_GAIN) if sound else None
    named = sfx.named(ref) if ref else None
    return (max(0.0, start + transition / 2 - 0.05), named[0], named[1]) if named else None


def _fade(samples: np.ndarray, fade_in: float, fade_out: float) -> np.ndarray:
    n = len(samples)
    for seconds, ramp_up in ((fade_in, True), (fade_out, False)):
        k = min(n, int(seconds * AUDIO_RATE))
        if k > 1:
            ramp = np.linspace(0.0, 1.0, k, dtype=np.float32)[:, None]
            if ramp_up:
                samples[:k] *= ramp
            else:
                samples[n - k:] *= ramp[::-1]
    return samples


def _mix_at(track: np.ndarray, samples: np.ndarray, start: float) -> None:
    i = int(round(start * AUDIO_RATE))
    if not len(samples) or i >= len(track):
        return
    if i < 0:
        samples, i = samples[-i:], 0
    part = samples[: len(track) - i]
    track[i : i + len(part)] += part


def _mix_track(
    speeches: list[np.ndarray | None], starts: list[float], duration: float, music_path: Path | None,
    music_volume: float, effects: list[tuple[float, np.ndarray, float]] | None = None,
) -> np.ndarray:
    """Ghép giọng đọc của các scene, hiệu ứng âm thanh và nhạc nền thành một track duy nhất, chính xác tới từng mẫu."""
    track = np.zeros((int(np.ceil(duration * AUDIO_RATE)), 2), dtype=np.float32)
    for speech, start in zip(speeches, starts):
        if speech is not None:
            _mix_at(track, _fade(speech.copy(), EDGE_FADE, EDGE_FADE), start)
    for start, samples, gain in effects or []:
        _mix_at(track, samples * gain, start)
    if music_path:
        music = decode_audio(music_path)
        if len(music):
            reps = int(np.ceil(len(track) / len(music)))
            music = np.tile(music, (reps, 1))[: len(track)] * music_volume
            track += _fade(music, MUSIC_FADE_IN, MUSIC_FADE_OUT)
    _fade(track, 0.0, FADE_OUT)
    np.clip(track, -1.0, 1.0, out=track)
    return track


def _audio_clip(track: np.ndarray) -> AudioArrayClip:
    clip = AudioArrayClip(track, fps=AUDIO_RATE)

    def make_frame(t):
        # Bản gốc lấy chỉ số bằng int(fps*t) nên đôi khi lệch một mẫu do sai số số thực: làm tròn thay vì cắt
        idx = np.round(np.asarray(t, dtype=np.float64) * AUDIO_RATE).astype(np.int64)
        inside = (idx >= 0) & (idx < len(track))
        out = np.zeros(idx.shape + (2,), dtype=np.float32)
        out[inside] = track[idx[inside]]
        return out

    clip.make_frame = make_frame
    return clip


def _build_scene(
    scene: Scene, index: int, size: tuple[int, int], style: Style, fonts: Fonts, cache_dir: Path | None,
    timeline: Timeline,
) -> SceneRender:
    pacing = style.timing
    speech_samples, duration = timeline.speeches[index], timeline.durations[index]
    speech = len(speech_samples) / AUDIO_RATE if speech_samples is not None else 0.0
    segments = timeline.segments[index]
    seg_len = duration / len(segments)
    blend = min(pacing.segment_blend, seg_len / 3)
    sources, bases = [], []
    for seg, motion in zip(segments, timeline.motions[index]):
        if seg.media == "video":
            fn, source = _video_frames(seg, size, cache_dir, seg_len + blend, pacing.clip_push)
            sources.append(source)
        else:
            fn = _image_frames(seg, motion, size, seg_len + blend, pacing.zoom)
        bases.append(fn)
    clip_layers = []
    for clip in scene.clips:
        try:
            layer, source = _clip_layer(clip, size, cache_dir)
        except Exception as e:  # clip hỏng không được làm hỏng cả video
            print(f"      ⚠️  Không lồng được clip {clip.path.name}: {e}", flush=True)
            continue
        if layer.end is None or layer.end > duration:
            layer.end = duration
        clip_layers.append(layer)
        sources.append(source)

    def base(t: float) -> Image.Image:
        k = min(int(t // seg_len), len(bases) - 1)
        local = t - k * seg_len
        frame = bases[k](local)
        if k > 0 and local < blend:
            # Đoạn trước tiếp tục chạy thêm một chút, hòa dần sang đoạn mới
            frame = Image.blend(bases[k - 1](seg_len + local).convert("RGB"), frame.convert("RGB"), local / blend)
        return frame.convert("RGB") if frame.mode != "RGB" else frame

    kind = style.subtitles_for(size)
    subtitles = None
    if scene.narration and kind != "none":
        cues = build_cues(scene.narration, scene.words, speech, kind, size)
        subtitles = SubtitleTrack(cues, kind, size, fonts, style.accent, offset=pacing.head)
    grade = color_filter(style.color_filter)
    camera = _camera_fn([(pacing.head + t, kind) for t, kind in scene.camera], index)

    def frame(t: float) -> Image.Image:
        img = base(t)
        if grade:
            img = grade(img)
        if camera:
            scale, cx, cy = camera(t)
            img = zoom_crop(img, scale, cx, cy)
        for layer in clip_layers:
            draw_layer(img, layer, t)
        for layer in scene.overlays:
            draw_layer(img, layer, t)
        if subtitles:
            subtitles.draw(img, t)
        return img

    return SceneRender(frame, duration, sources)


def split_sizes() -> tuple[tuple[int, int], tuple[int, int]]:
    """Kích thước (nửa trên nội dung, nửa dưới video nền) cho bố cục chia đôi 9:16."""
    w, h = ASPECTS["9:16"]
    top_h = round(h * SPLIT_RATIO / 2) * 2
    return (w, top_h), (w, h - top_h)


def _background_clip(path: Path, size: tuple[int, int], duration: float, cache_dir: Path | None) -> VideoClip:
    """Video nền (gameplay): tắt tiếng, phủ kín khung, bắt đầu ở vị trí ngẫu nhiên, tự lặp nếu ngắn."""
    w, h = size
    clip = VideoFileClip(str(prepare_clip(path, cache_dir)), audio=False)
    # Cắt vùng giữa của khung gốc rồi thu nhỏ bằng Pillow (resize của moviepy 1.x lỗi với Pillow >= 10)
    scale = max(w / clip.w, h / clip.h)
    crop_w, crop_h = w / scale, h / scale
    x0, y0 = (clip.w - crop_w) / 2, (clip.h - crop_h) / 2
    box = (x0, y0, x0 + crop_w, y0 + crop_h)

    def fit(frame: np.ndarray) -> np.ndarray:
        return np.asarray(Image.fromarray(frame).resize((w, h), Image.BILINEAR, box=box))

    clip = clip.fl_image(fit)
    if clip.duration > duration:
        start = random.uniform(0, clip.duration - duration)
        return clip.subclip(start, start + duration)
    return clip.fx(vfx.loop, duration=duration)


def _seed(scenes: list[Scene]) -> int:
    """Cùng kịch bản -> cùng chuyển cảnh/chuyển động (render lại cho kết quả giống nhau)."""
    text = "|".join(s.narration for s in scenes)
    return int(hashlib.sha1(text.encode("utf-8")).hexdigest()[:8], 16)


def plan_timeline(scenes: list[Scene], style: Style) -> Timeline:
    """Thời lượng từng scene (theo giọng đọc), đoạn hình, chuyển động, chuyển cảnh và thời điểm bắt đầu của từng scene.
    Cùng kịch bản -> cùng lựa chọn ngẫu nhiên (render lại cho kết quả giống nhau)."""
    pacing = style.timing
    rng = random.Random(_seed(scenes))
    speeches, durations, segments, motions = [], [], [], []
    for scene in scenes:
        speech = decode_audio(scene.audio_path) if scene.audio_path else None
        duration = pacing.head + len(speech) / AUDIO_RATE + pacing.tail if speech is not None else SILENT_SCENE
        # Chia scene thành các đoạn hình đều nhau (bỏ bớt đoạn nếu scene quá ngắn)
        segs = scene.segments[: max(1, int(duration // pacing.min_segment))]
        chosen = scene.motion if scene.motion in ALL_MOTIONS else None
        kinds: list[str | None] = []
        last_motion = None
        for seg in segs:
            if seg.media == "video":
                kinds.append(None)
                continue
            # Ảnh đầu dùng chuyển động hợp cảm xúc cảnh (nếu có), các ảnh sau đổi kiểu để không lặp một chuyển động
            if chosen and last_motion is None:
                last_motion = chosen
            else:
                last_motion = rng.choice([m for m in MOTIONS if m != last_motion])
            kinds.append(last_motion)
        speeches.append(speech)
        durations.append(duration)
        segments.append(segs)
        motions.append(kinds)
    transition = min([pacing.transition] + [d / 3 for d in durations])
    starts = [0.0]
    for d in durations[:-1]:
        starts.append(starts[-1] + d - transition)
    kinds = pick_transitions(style.transition, len(scenes) - 1, rng)
    return Timeline(speeches, durations, segments, motions, starts, transition, kinds, starts[-1] + durations[-1])


def audio_track(scenes: list[Scene], timeline: Timeline, style: Style, music_path: Path | None,
                music_volume: float) -> np.ndarray:
    """Track âm thanh cuối của video (float32, 2 kênh, AUDIO_RATE): giọng đọc, tiếng chuyển cảnh, tiếng "tách", âm thanh
    theo câu thoại và nhạc nền, đặt theo timeline. Mọi renderer dùng chung nên âm thanh giống nhau từng mẫu."""
    head, starts, transition, kinds = style.timing.head, timeline.starts, timeline.transition, timeline.kinds
    effects: list[tuple[float, np.ndarray, float]] = []
    if style.sfx and style.transition_sound == "default":
        for i, kind in enumerate(kinds):
            if kind not in WHOOSH_TRANSITIONS:
                continue
            sound = sfx.whoosh(round(max(0.4, transition * 1.4), 2), seed=i % 3, direction=-1 if kind.endswith("right") else 1)
            effects.append((starts[i + 1] + transition / 2 - len(sound) / AUDIO_RATE / 2, sound, WHOOSH_GAIN))
    if style.sfx:
        for start, scene in zip(starts, scenes):
            effects.extend((start + p, sfx.pop(), POP_GAIN) for p in scene.pops)
    # Tiếng chuyển cảnh người dùng chọn (hoặc AI/thư viện chọn cho từng cảnh)
    for i, kind in enumerate(kinds):
        effect = _transition_effect(scenes[i + 1].enter_sound, starts[i + 1], transition, i, kind)
        if effect:
            effects.append(effect)
    # Âm thanh meme do Đạo diễn AI đặt theo câu thoại: luôn phát (AI đã chủ động chọn)
    for start, scene in zip(starts, scenes):
        for t, ref in scene.sounds:
            sound = _asset_sound(ref) if isinstance(ref, Path) else sfx.named(ref)
            if sound:
                effects.append((start + head + t, sound[0], sound[1]))
    return _mix_track(timeline.speeches, [s + head for s in starts], timeline.total, music_path, music_volume, effects)


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
    """Render video ra out_path, trả về thời lượng (giây). `logger`: "bar", None hoặc proglog logger."""
    style = style or Style()
    fonts = fonts or resolve_fonts()
    if bg_video:
        size, bg_size = split_sizes()
        frame_size = ASPECTS["9:16"]
    else:
        size = frame_size = ASPECTS[aspect]
    cache_dir = (work_dir or out_path.parent) / "clips"
    timeline = plan_timeline(scenes, style)
    renders = [_build_scene(s, i, size, style, fonts, cache_dir, timeline) for i, s in enumerate(scenes)]
    starts, transition, total = timeline.starts, timeline.transition, timeline.total
    transitions = [TRANSITION_FNS[k] for k in timeline.kinds]

    background = _background_clip(bg_video, bg_size, total, cache_dir) if bg_video else None
    logo = logo_layer(style.logo, frame_size) if style.logo else None
    bar_h = max(4, round(frame_size[1] * 0.006))
    black = Image.new("RGB", frame_size, (0, 0, 0))

    def content(t: float) -> Image.Image:
        i = max(0, bisect_right(starts, t) - 1)
        local = t - starts[i]
        img = renders[i].frame(min(local, renders[i].duration))
        if i > 0 and local < transition:
            prev = renders[i - 1].frame(t - starts[i - 1])
            img = transitions[i - 1](prev, img, local / transition)
        return img

    def compose(t: float) -> Image.Image:
        img = content(t)
        if background is not None:
            canvas = Image.new("RGB", frame_size)
            canvas.paste(img, (0, 0))
            canvas.paste(Image.fromarray(background.get_frame(min(t, background.duration - 1e-3))[..., :3]), (0, size[1]))
            img = canvas
        if logo:
            draw_layer(img, logo, t)
        if style.progress_bar:
            w = frame_size[0]
            img.paste((0, 0, 0), (0, 0, w, bar_h), Image.new("L", (w, bar_h), 90))
            ImageDraw.Draw(img).rectangle((0, 0, round(w * min(t / total, 1.0)), bar_h - 1), fill=style.accent)
        k = min(1.0, t / FADE_IN, (total - t) / FADE_OUT)
        if k < 1:
            img = Image.blend(black, img, max(0.0, k))
        return img

    audio = _audio_clip(audio_track(scenes, timeline, style, music_path, music_volume))
    final = VideoClip(lambda t: np.asarray(compose(t)), duration=total).set_audio(audio)

    temp_audio = (work_dir or out_path.parent) / f"{out_path.stem}.temp-audio.m4a"
    final.write_videofile(
        str(out_path),
        fps=fps,
        codec="libx264",
        audio_codec="aac",
        audio_bitrate="192k",
        preset="medium",
        threads=os.cpu_count() or 4,
        temp_audiofile=str(temp_audio),
        logger=logger,
    )
    if thumbnail_path:
        # Khung hình title card (đã hiện đủ tiêu đề) làm ảnh đại diện; lỗi ở đây không làm hỏng video
        try:
            compose(min(1.6, total / 2)).save(thumbnail_path, "JPEG", quality=88)
        except Exception as e:
            print(f"      ⚠️  Không tạo được thumbnail: {e}", flush=True)
    final.close()
    for clip in [background] + [src for r in renders for src in r.sources]:
        if clip is not None:
            clip.close()
    return total
