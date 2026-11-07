"""Nạp manimlib. manimlib đọc sys.argv ngay khi import (CLI của manimgl) nên tạm che tham số của engine; máy không có màn
hình (server) thì tạo ngữ cảnh OpenGL bằng EGL."""
import sys

_argv, sys.argv = sys.argv, sys.argv[:1]
try:
    import moderngl
    from manimlib.camera.camera import Camera
finally:
    sys.argv = _argv


def _init_context(self) -> None:
    if self.window is None:
        try:
            self.ctx = moderngl.create_standalone_context()
        except Exception:  # noqa: BLE001 — không có X11/GLX: thử EGL
            self.ctx = moderngl.create_standalone_context(backend="egl")
    else:
        self.ctx = self.window.ctx
    self.ctx.enable(moderngl.PROGRAM_POINT_SIZE)
    self.ctx.enable(moderngl.BLEND)


Camera.init_context = _init_context
