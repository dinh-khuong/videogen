"""Báo tiến độ chạy pipeline.

- Reporter: dùng cho CLI, không phát sự kiện, render hiện thanh tiến độ của moviepy.
- JsonReporter: dùng khi chạy làm tiến trình con của web app. Mỗi sự kiện là một dòng
  `@@videogen {json}` trên stdout; các dòng khác là log thường.
"""
import json
import sys
import threading
import time

from proglog import ProgressBarLogger

EVENT_PREFIX = "@@videogen "

# Khoảng tiến độ tổng (0-1) của từng giai đoạn
STAGES = {
    "script": (0.0, 0.1),
    "images": (0.1, 0.35),
    "audio": (0.35, 0.5),
    "render": (0.5, 1.0),
}
# Đạo diễn AI: lên kịch bản (gồm cả tìm/tải tư liệu) chiếm phần lớn thời gian trước khi dựng
DIRECTOR_STAGES = {
    "director": (0.0, 0.4),
    "script": (0.4, 0.4),
    "images": (0.4, 0.48),
    "audio": (0.48, 0.6),
    "render": (0.6, 1.0),
}


class Reporter:
    def stage(self, stage: str, message: str, fraction: float = 0.0) -> None:
        pass

    def agent(self, kind: str, text: str) -> None:
        """Một bước suy nghĩ/hành động của Đạo diễn AI (CLI đã tự in ra log)."""

    def render_logger(self):
        return "bar"


class JsonReporter(Reporter):
    def __init__(self, stages: dict | None = None) -> None:
        self._lock = threading.Lock()
        self.stages = stages or STAGES

    def emit(self, type_: str, **data) -> None:
        line = EVENT_PREFIX + json.dumps({"type": type_, **data}, ensure_ascii=False)
        with self._lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def stage(self, stage: str, message: str, fraction: float = 0.0) -> None:
        lo, hi = self.stages.get(stage, STAGES.get(stage, (0.0, 1.0)))
        fraction = min(max(fraction, 0.0), 1.0)
        self.emit("progress", stage=stage, progress=round(lo + (hi - lo) * fraction, 4), message=message)

    def agent(self, kind: str, text: str) -> None:
        self.emit("agent", kind=kind, text=text)

    def render_logger(self):
        return _RenderLogger(self)


class _RenderLogger(ProgressBarLogger):
    """Chuyển tiến độ ghi frame của moviepy thành sự kiện 'render' (tối đa ~1 sự kiện/giây)."""

    def __init__(self, reporter: JsonReporter) -> None:
        super().__init__()
        self.reporter = reporter
        self._last_emit = 0.0

    def bars_callback(self, bar, attr, value, old_value=None):
        if bar != "t" or attr != "index":  # 't' = frame video, 'chunk' = audio
            return
        total = self.bars[bar].get("total") or 0
        now = time.monotonic()
        if not total or (now - self._last_emit < 1.0 and value < total - 1):
            return
        self._last_emit = now
        fraction = (value + 1) / total
        self.reporter.stage("render", f"Đang render {fraction:.0%}", fraction)
