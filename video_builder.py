"""Dựng video từ các scene: nền ảnh (Ken Burns) + lớp đồ họa + phụ đề + giọng đọc."""
import os
import random
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from moviepy.audio.fx.all import audio_fadein, audio_fadeout, audio_loop
from moviepy.editor import (
    AudioFileClip,
    CompositeAudioClip,
    CompositeVideoClip,
    VideoClip,
    VideoFileClip,
    concatenate_videoclips,
    vfx,
)
from PIL import Image

from graphics import prepare_background, render_subtitle, split_subtitles

ZOOM = 1.12        # biên độ zoom Ken Burns
HEAD = 0.25        # khoảng lặng trước lời bình mỗi scene (giây)
TAIL = 0.6         # khoảng lặng sau lời bình (phải >= TRANSITION để giọng không chồng nhau)
TRANSITION = 0.5   # thời lượng crossfade giữa các scene
SILENT_SCENE = 3.0 # thời lượng scene không có giọng đọc

ASPECTS = {"16:9": (1280, 720), "9:16": (720, 1280), "1:1": (1080, 1080)}
SPLIT_RATIO = 0.5  # tỉ lệ chiều cao phần nội dung (nửa trên) khi có video nền


@dataclass
class Scene:
    image_path: Path
    audio_path: Path | None
    narration: str = ""
    overlays: list[Image.Image] = field(default_factory=list)


def _layer_region(layer: Image.Image) -> tuple[Image.Image, tuple[int, int]] | None:
    """Cắt lớp RGBA về vùng có nội dung để paste nhanh hơn mỗi frame."""
    bbox = layer.getbbox()
    if not bbox:
        return None
    return layer.crop(bbox), (bbox[0], bbox[1])


def _make_scene_clip(
    scene: Scene, index: int, size: tuple[int, int], font_override: str | None
) -> VideoClip:
    w, h = size
    big_size = (round(w * ZOOM), round(h * ZOOM))
    background = prepare_background(scene.image_path, big_size)

    audio = AudioFileClip(str(scene.audio_path)) if scene.audio_path else None
    speech = audio.duration if audio else 0.0
    duration = HEAD + speech + TAIL if audio else SILENT_SCENE

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

    zoom_in = index % 2 == 0
    pan_x = 0.5 + (0.08 if index % 3 == 1 else -0.08 if index % 3 == 2 else 0.0)

    def make_frame(t: float) -> np.ndarray:
        progress = min(max(t / duration, 0.0), 1.0)
        progress = progress * progress * (3 - 2 * progress)  # ease in-out
        k = ZOOM - (ZOOM - 1) * progress if zoom_in else 1 + (ZOOM - 1) * progress
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
        frame = background.resize(size, Image.BILINEAR, box=box)

        for layer, pos in static_layers:
            frame.paste(layer, pos, layer)
        current = None
        for start, region in subtitle_timeline:
            if t >= start or current is None:
                current = region
        if current:
            frame.paste(current[0], current[1], current[0])
        return np.asarray(frame)

    clip = VideoClip(make_frame, duration=duration)
    if audio:
        clip = clip.set_audio(CompositeAudioClip([audio.set_start(HEAD)]).set_duration(duration))
    return clip


def split_sizes() -> tuple[tuple[int, int], tuple[int, int]]:
    """Kích thước (nửa trên nội dung, nửa dưới video nền) cho bố cục chia đôi 9:16."""
    w, h = ASPECTS["9:16"]
    top_h = round(h * SPLIT_RATIO / 2) * 2
    return (w, top_h), (w, h - top_h)


def _background_clip(path: Path, size: tuple[int, int], duration: float) -> VideoClip:
    """Video nền (gameplay): tắt tiếng, phủ kín khung, bắt đầu ở vị trí ngẫu nhiên, tự lặp nếu ngắn."""
    w, h = size
    clip = VideoFileClip(str(path), audio=False)
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
) -> Path:
    if bg_video:
        size, bg_size = split_sizes()
    else:
        size = ASPECTS[aspect]
    clips = [_make_scene_clip(s, i, size, font_override) for i, s in enumerate(scenes)]

    transition = min([TRANSITION] + [c.duration / 3 for c in clips])
    clips = [clips[0]] + [c.crossfadein(transition) for c in clips[1:]]
    final = concatenate_videoclips(clips, method="compose", padding=-transition)

    if bg_video:
        background = _background_clip(bg_video, bg_size, final.duration)
        final = CompositeVideoClip(
            [background.set_position((0, size[1])), final.set_position((0, 0))],
            size=ASPECTS["9:16"],
        ).set_duration(final.duration).set_audio(final.audio)

    final = final.fadein(0.4).fadeout(0.6)

    if music_path:
        music = AudioFileClip(str(music_path))
        music = audio_loop(music, duration=final.duration).volumex(music_volume)
        music = audio_fadeout(audio_fadein(music, 1.0), 2.0)
        tracks = [final.audio, music] if final.audio else [music]
        final = final.set_audio(CompositeAudioClip(tracks).set_duration(final.duration))
    elif final.audio:
        final = final.set_audio(audio_fadeout(final.audio, 0.6))

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
        logger="bar",
    )
    final.close()
    for clip in clips:
        clip.close()
    return out_path
