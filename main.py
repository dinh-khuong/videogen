"""CLI tạo video hướng dẫn từ một chủ đề.

Ví dụ:
    python main.py "cách làm bánh flan"
    python main.py "cách pha cà phê phin" --aspect 9:16 --music nhac.mp3
    python main.py "cách trồng rau mầm" --script-only        # chỉ viết kịch bản để sửa
    python main.py --script output/cach_trong_rau_mam/script.json   # render lại từ kịch bản đã sửa
    python main.py "mẹo học tiếng Anh" --steps 4 --bg-video gameplay/   # Shorts chia đôi với gameplay
"""
import argparse
import sys
from pathlib import Path

from config import ConfigError
from pipeline import Options, run
from video_builder import ASPECTS


def main() -> None:
    parser = argparse.ArgumentParser(description="Tạo video hướng dẫn (how-to) từ một chủ đề.")
    parser.add_argument("topic", nargs="?", help="Chủ đề, ví dụ: 'cách làm bánh flan'")
    parser.add_argument("-o", "--output", help="File video đầu ra (.mp4). Mặc định: output/<tiêu-đề>/")
    parser.add_argument("--script", help="Render từ file script.json có sẵn (bỏ qua bước gọi LLM)")
    parser.add_argument("--script-only", action="store_true", help="Chỉ sinh kịch bản, không render video")
    parser.add_argument("--steps", type=int, help="Số bước mong muốn (mặc định 5-8)")
    parser.add_argument("--aspect", choices=list(ASPECTS), default="16:9",
                        help="Tỉ lệ khung hình: 16:9 (YouTube), 9:16 (TikTok/Shorts), 1:1")
    parser.add_argument("--language", default="tiếng Việt", help="Ngôn ngữ lời bình (mặc định: tiếng Việt)")
    parser.add_argument("--voice", help="Giọng edge-tts, vd vi-VN-NamMinhNeural (ghi đè TTS_VOICE)")
    parser.add_argument("--rate", help="Tốc độ đọc, vd '+10%%' hoặc '-5%%' (ghi đè TTS_RATE)")
    parser.add_argument("--music", type=Path, help="File nhạc nền (mp3/wav), tự lặp và giảm âm lượng")
    parser.add_argument("--music-volume", type=float, default=0.12, help="Âm lượng nhạc nền 0-1 (mặc định 0.12)")
    parser.add_argument("--bg-video", type=Path,
                        help="File hoặc thư mục video nền (vd gameplay). Tạo video dọc 9:16 chia đôi: "
                             "nội dung ở trên, video nền (tắt tiếng) ở dưới")
    args = parser.parse_args()

    if not args.topic and not args.script:
        parser.error("Cần nhập chủ đề hoặc --script <file>.")
    if args.music and not args.music.exists():
        parser.error(f"Không tìm thấy file nhạc: {args.music}")
    if args.bg_video and not args.bg_video.exists():
        parser.error(f"Không tìm thấy video nền: {args.bg_video}")

    opts = Options(
        aspect=args.aspect,
        num_steps=args.steps,
        language=args.language,
        voice=args.voice,
        rate=args.rate,
        music=args.music,
        music_volume=args.music_volume,
        script_only=args.script_only,
        bg_video=args.bg_video,
    )
    try:
        run(args.topic, args.output, args.script, opts)
    except ConfigError as e:
        print(f"❌ Lỗi cấu hình: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nĐã hủy.", file=sys.stderr)
        sys.exit(130)
    except Exception as e:
        print(f"❌ Lỗi: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
