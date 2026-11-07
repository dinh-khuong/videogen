"""Dòng lệnh của engine ManimGL.

  python -m videogen_manim job spec.json   # chạy job từ web app (cùng spec với `python -m videogen job`)
  python -m videogen_manim doctor          # kiểm tra manimgl + OpenGL, in JSON
"""
import argparse
import json
import sys
from pathlib import Path


def doctor() -> dict:
    problems: list[str] = []
    info: dict = {}
    try:
        from importlib.metadata import version

        from . import _manim  # noqa: F401
        from manimlib.camera.camera import Camera

        info["manimgl"] = version("manimgl")
        camera = Camera(resolution=(64, 36))
        info["opengl"] = camera.ctx.info.get("GL_RENDERER")
        camera.ctx.release()
    except Exception as e:  # noqa: BLE001
        problems.append(f"ManimGL/OpenGL không dùng được: {type(e).__name__}: {e}")
    return {"ok": not problems, "problems": problems, **info}


def main() -> None:
    parser = argparse.ArgumentParser(prog="videogen_manim", description="Dựng video bằng ManimGL")
    sub = parser.add_subparsers(dest="command", required=True)
    job = sub.add_parser("job", help="chạy job từ file spec JSON (xem engine/videogen/job.py)")
    job.add_argument("spec", type=Path)
    sub.add_parser("doctor", help="kiểm tra manimgl và OpenGL")
    args = parser.parse_args()
    if args.command == "doctor":
        result = doctor()
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0 if result["ok"] else 1)
    from videogen.job import run_job

    from .pipeline import run

    sys.exit(run_job(args.spec, run))
