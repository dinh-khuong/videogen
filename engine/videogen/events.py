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


class Reporter:
    def stage(self, stage: str, message: str, fraction: float = 0.0) -> None:
        pass

    def render_logger(self):
        return "bar"


class JsonReporter(Reporter):
    def __init__(self) -> None:
        self._lock = threading.Lock()

    def emit(self, type_: str, **data) -> None:
        line = EVENT_PREFIX + json.dumps({"type": type_, **data}, ensure_ascii=False)
        with self._lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def stage(self, stage: str, message: str, fraction: float = 0.0) -> None:
        lo, hi = STAGES[stage]
        fraction = min(max(fraction, 0.0), 1.0)
        self.emit("progress", stage=stage, progress=round(lo + (hi - lo) * fraction, 4), message=message)

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
