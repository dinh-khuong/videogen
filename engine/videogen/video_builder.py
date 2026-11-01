"""Dựng video từ các scene: nền ảnh (Ken Burns) hoặc clip video + lớp đồ họa + phụ đề + giọng đọc."""
import hashlib
import os
import random
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from moviepy.audio.AudioClip import AudioArrayClip
from moviepy.editor import CompositeVideoClip, VideoClip, VideoFileClip, concatenate_videoclips, vfx
from PIL import Image

from .graphics import framed_backdrop, prepare_background, render_subtitle, split_subtitles
from .probe import ffmpeg_exe, video_info

ZOOM = 1.12        # biên độ zoom Ken Burns
FRAME_ZOOM = 1.04  # zoom nhẹ hơn khi ảnh là nội dung chính (giữ trọn ảnh, chữ trong ảnh dễ đọc)
HEAD = 0.25        # khoảng lặng trước lời bình mỗi scene (giây)
TAIL = 0.6         # khoảng lặng sau lời bình (phải >= TRANSITION để giọng không chồng nhau)
TRANSITION = 0.5   # thời lượng crossfade giữa các scene
SILENT_SCENE = 3.0 # thời lượng scene không có giọng đọc

ASPECTS = {"16:9": (1280, 720), "9:16": (720, 1280), "1:1": (1080, 1080)}
SPLIT_RATIO = 0.5  # tỉ lệ chiều cao phần nội dung (nửa trên) khi có video nền
CLIP_MAX_SIDE = 1280  # clip lớn hơn được thu nhỏ trước khi dựng (giải mã 4K mỗi khung hình rất chậm)

AUDIO_RATE = 44100
EDGE_FADE = 0.008  # làm mềm đầu/cuối mỗi đoạn âm thanh để không có tiếng "bụp"
FADE_IN, FADE_OUT = 0.4, 0.6  # mờ dần đầu/cuối video (hình và tiếng)
MUSIC_FADE_IN, MUSIC_FADE_OUT = 1.0, 2.0


MIN_SEGMENT = 2.2   # thời lượng tối thiểu của một đoạn hình trong scene (giây)
SEGMENT_BLEND = 0.3 # chuyển mềm giữa các đoạn hình trong cùng scene


@dataclass
class Segment:
    """Một đoạn hình trong scene: ảnh (Ken Burns) hoặc clip video."""
    path: Path
    media: str = "image"  # image | video
    style: str = "cover"  # cover: phủ kín khung (làm nền) | frame: hiện trọn vẹn làm nội dung chính


@dataclass
class Scene:
    segments: list[Segment]  # nối tiếp nhau, chia đều thời lượng scene (vd nhiều clip cho một bước)
    audio_path: Path | None
    narration: str = ""
    overlays: list[Image.Image] = field(default_factory=list)


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


def _layer_region(layer: Image.Image) -> tuple[Image.Image, tuple[int, int]] | None:
    """Cắt lớp RGBA về vùng có nội dung để paste nhanh hơn mỗi frame."""
    bbox = layer.getbbox()
    if not bbox:
        return None
    return layer.crop(bbox), (bbox[0], bbox[1])


def _image_frames(seg: Segment, index: int, size: tuple[int, int], duration: float):
    """Ảnh tĩnh với hiệu ứng Ken Burns: trả về hàm t -> khung hình PIL."""
    w, h = size
    zoom = FRAME_ZOOM if seg.style == "frame" else ZOOM
    big_size = (round(w * zoom), round(h * zoom))
    background = prepare_background(seg.path, big_size, seg.style).convert("RGB")
    zoom_in = index % 2 == 0
    pan = 0.0 if seg.style == "frame" else 0.08
    pan_x = 0.5 + (pan if index % 3 == 1 else -pan if index % 3 == 2 else 0.0)

    def frame_at(t: float) -> Image.Image:
        progress = min(max(t / duration, 0.0), 1.0)
        progress = progress * progress * (3 - 2 * progress)  # ease in-out
        k = zoom - (zoom - 1) * progress if zoom_in else 1 + (zoom - 1) * progress
        crop_w = min(w * k, big_size[0])
        crop_h = min(h * k, big_size[1])
        cx = big_size[0] * (0.5 + (pan_x - 0.5) * progress)
        cx = min(max(cx, crop_w / 2), big_size[0] - crop_w / 2)
        cy = big_size[1] / 2
        box = (
            max(0.0, cx - crop_w / 2),
            max(0.0, cy - crop_h / 2),
            min(big_size[0], cx + crop_w / 2),
            min(big_size[1], cy + crop_h / 2),
        )
        return background.resize(size, Image.BILINEAR, box=box)

    return frame_at


def _video_frames(seg: Segment, size: tuple[int, int], cache_dir: Path | None):
    """Clip video làm nội dung: tắt tiếng, tự lặp nếu ngắn hơn đoạn. Trả về (hàm t -> khung hình PIL, clip nguồn)."""
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
    x0, y0 = (source.w - w / scale) / 2, (source.h - h / scale) / 2
    box = (x0, y0, source.w - x0, source.h - y0)

    def cover(t: float) -> Image.Image:
        return source_frame(t).resize(size, Image.BILINEAR, box=box)

    return cover, source


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
    if i >= len(track) or not len(samples):
        return
    part = samples[: len(track) - i]
    track[i : i + len(part)] += part


def _build_audio(
    speeches: list[np.ndarray | None], starts: list[float], duration: float, music_path: Path | None, music_volume: float
) -> AudioArrayClip:
    """Ghép giọng đọc của các scene (và nhạc nền) thành một track duy nhất, chính xác tới từng mẫu."""
    track = np.zeros((int(np.ceil(duration * AUDIO_RATE)), 2), dtype=np.float32)
    for speech, start in zip(speeches, starts):
        if speech is not None:
            _mix_at(track, _fade(speech.copy(), EDGE_FADE, EDGE_FADE), start + HEAD)
    if music_path:
        music = decode_audio(music_path)
        if len(music):
            reps = int(np.ceil(len(track) / len(music)))
            music = np.tile(music, (reps, 1))[: len(track)] * music_volume
            track += _fade(music, MUSIC_FADE_IN, MUSIC_FADE_OUT)
    _fade(track, 0.0, FADE_OUT)
    np.clip(track, -1.0, 1.0, out=track)
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


def _make_scene_clip(
    scene: Scene, index: int, size: tuple[int, int], font_override: str | None, cache_dir: Path | None = None
) -> tuple[VideoClip, list, np.ndarray | None]:
    """Trả về (clip hình của scene, các clip nguồn cần đóng sau khi render, giọng đọc đã giải mã)."""
    w, h = size
    speech_samples = decode_audio(scene.audio_path) if scene.audio_path else None
    speech = len(speech_samples) / AUDIO_RATE if speech_samples is not None else 0.0
    duration = HEAD + speech + TAIL if speech_samples is not None else SILENT_SCENE

    # Chia scene thành các đoạn hình đều nhau (bỏ bớt đoạn nếu scene quá ngắn)
    segments = scene.segments[: max(1, int(duration // MIN_SEGMENT))]
    seg_len = duration / len(segments)
    sources = []
    bases = []
    for k, seg in enumerate(segments):
        if seg.media == "video":
            fn, source = _video_frames(seg, size, cache_dir)
            sources.append(source)
        else:
            fn = _image_frames(seg, index + k, size, seg_len + SEGMENT_BLEND)
        bases.append(fn)

    def base(t: float) -> Image.Image:
        k = min(int(t // seg_len), len(bases) - 1)
        local = t - k * seg_len
        frame = bases[k](local).convert("RGB")
        if k > 0 and local < SEGMENT_BLEND:
            # Đoạn trước tiếp tục chạy thêm một chút, hòa dần sang đoạn mới
            prev = bases[k - 1](seg_len + local).convert("RGB")
            frame = Image.blend(prev, frame, local / SEGMENT_BLEND)
        return frame

    static_layers = [r for r in (_layer_region(o) for o in scene.overlays) if r]

    # Phụ đề: chia lời bình thành đoạn, thời gian mỗi đoạn tỉ lệ với số ký tự
    max_chars = 70 if w >= h else 45
    chunks = split_subtitles(scene.narration, max_chars) if scene.narration else []
    total_chars = sum(len(c) for c in chunks) or 1
    subtitle_timeline: list[tuple[float, tuple[Image.Image, tuple[int, int]] | None]] = []
    t = HEAD
    for chunk in chunks:
        region = _layer_region(render_subtitle(chunk, size, font_override))
        subtitle_timeline.append((t, region))
        t += speech * len(chunk) / total_chars

    def make_frame(t: float) -> np.ndarray:
        frame = base(t)
        for layer, pos in static_layers:
            frame.paste(layer, pos, layer)
        current = None
        for start, region in subtitle_timeline:
            if t >= start or current is None:
                current = region
        if current:
            frame.paste(current[0], current[1], current[0])
        return np.asarray(frame)

    return VideoClip(make_frame, duration=duration), sources, speech_samples


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


def build_video(
    scenes: list[Scene],
    out_path: Path,
    aspect: str = "16:9",
    fps: int = 30,
    music_path: Path | None = None,
    music_volume: float = 0.12,
    font_override: str | None = None,
    work_dir: Path | None = None,
    bg_video: Path | None = None,
    logger="bar",
    thumbnail_path: Path | None = None,
) -> float:
    """Render video ra out_path, trả về thời lượng (giây). `logger`: "bar", None hoặc proglog logger."""
    if bg_video:
        size, bg_size = split_sizes()
    else:
        size = ASPECTS[aspect]
    cache_dir = (work_dir or out_path.parent) / "clips"
    built = [_make_scene_clip(s, i, size, font_override, cache_dir) for i, s in enumerate(scenes)]
    clips = [clip for clip, _, _ in built]
    sources = [src for _, srcs, _ in built for src in srcs]

    transition = min([TRANSITION] + [c.duration / 3 for c in clips])
    # Scene sau bắt đầu chồng lên `transition` giây cuối của scene trước (crossfade hình)
    starts = [0.0]
    for c in clips[:-1]:
        starts.append(starts[-1] + c.duration - transition)
    clips = [clips[0]] + [c.crossfadein(transition) for c in clips[1:]]
    # moviepy 1.x trừ padding cả sau scene cuối -> video hụt `transition` giây, cắt mất đuôi lời kết
    final = concatenate_videoclips(clips, method="compose", padding=-transition).set_duration(starts[-1] + clips[-1].duration)

    if bg_video:
        background = _background_clip(bg_video, bg_size, final.duration, cache_dir)
        final = CompositeVideoClip(
            [background.set_position((0, size[1])), final.set_position((0, 0))],
            size=ASPECTS["9:16"],
        ).set_duration(final.duration)

    final = final.fadein(FADE_IN).fadeout(FADE_OUT)
    # Âm thanh dựng riêng thành một track liền mạch: chuyển cảnh chỉ làm mờ hình, không đụng tới tiếng
    final = final.set_audio(_build_audio([speech for _, _, speech in built], starts, final.duration, music_path, music_volume))

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
    duration = final.duration
    if thumbnail_path:
        # Khung hình title card (đã hết fade-in) làm ảnh đại diện; lỗi ở đây không làm hỏng video
        try:
            frame = final.get_frame(min(1.2, duration / 2))
            Image.fromarray(np.asarray(frame)[..., :3].astype("uint8")).save(thumbnail_path, "JPEG", quality=88)
        except Exception as e:
            print(f"      ⚠️  Không tạo được thumbnail: {e}", flush=True)
    final.close()
    for clip in clips + sources:
        clip.close()
    return duration
