"""Engine dựng video thứ hai, bằng ManimGL (3b1b/manim): cùng spec job, cùng kịch bản, cùng giọng đọc và cùng track âm
thanh với engine cũ (`videogen`), chỉ khác phần dựng hình — chữ vector, hoạt ảnh của Manim, render bằng OpenGL.

Dùng lại từ engine/: `videogen_core` (giọng đọc, hiệu ứng và trộn âm thanh, cấu hình) và các bước chuẩn bị của `videogen`
(kịch bản từ LLM/Đạo diễn AI, tìm ảnh/clip, phụ đề khớp từ).
"""
import sys
from pathlib import Path

try:
    import videogen_core  # noqa: F401
except ImportError:
    # Chạy thẳng trong engine-manim/ mà chưa đặt PYTHONPATH: dùng engine/ cùng repo
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "engine"))
