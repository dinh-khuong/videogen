"""Renderer ManimGL cho videogen (engine/): dựng hình bằng Manim của 3Blue1Brown, render bằng OpenGL.

Không phải engine riêng: kịch bản, ảnh/clip, giọng đọc, hiệu ứng và trộn âm thanh, cấu hình, spec job đều là của
engine/videogen. Chọn bằng spec job "renderer": "manim" (hoặc `python -m videogen --renderer manim`); videogen.pipeline
nạp `build_video` ở đây thay cho videogen.video_builder.build_video.
"""
from .builder import build_video

__all__ = ["build_video"]
