"""CLI của engine tạo video.

Ví dụ (chạy trong thư mục engine/):
    python -m videogen "cách làm bánh flan"
    python -m videogen "cách pha cà phê phin" --aspect 9:16 --music nhac.mp3
    python -m videogen "cách trồng rau mầm" --script-only        # chỉ viết kịch bản để sửa
    python -m videogen --script output/cach_trong_rau_mam/script.json   # render lại từ kịch bản đã sửa
    python -m videogen "mẹo học tiếng Anh" --steps 4 --bg-video gameplay/   # Shorts chia đôi với gameplay
    python -m videogen "giới thiệu menu quán" --library-dir anh_mon/       # ảnh/video của bạn làm nội dung chính
    python -m videogen analyze menu.jpg demo.mp4  # đọc chữ (OCR) + AI tóm tắt nội dung asset
    python -m videogen "5 sự thật về mèo" --director --aspect 9:16   # Đạo diễn AI: meme, giọng biến hóa, tự quyết số cảnh

Lệnh dành cho web app:
    python -m videogen job spec.json      # chạy job, phát sự kiện JSON trên stdout
    python -m videogen probe file... [--thumbnail-dir dir]
    python -m videogen analyze --spec spec.json   # phân tích asset, phát sự kiện JSON trên stdout
    python -m videogen voice-sample --voice vi-VN-NamMinhNeural --out mau.mp3   # nghe thử giọng
    python -m videogen zerotts-voices     # danh sách giọng của mô hình ZeroTTS, in JSON
    python -m videogen import-dataset not-lain/meme-dataset   # nhập ảnh dataset Hugging Face vào Assets
    python -m videogen doctor             # kiểm tra cấu hình, in JSON
"""
import argparse
import json
import sys
from pathlib import Path

SUBCOMMANDS = {"make", "job", "probe", "analyze", "doctor", "voice-sample", "zerotts-voices", "import-dataset"}


ANALYSIS_CACHE = ".videogen-analysis.json"


def _library_from_dir(folder: Path, analyze: bool = False):
    """Ảnh/video trong thư mục làm thư viện; mô tả lấy từ file <tên>.txt cạnh file (nếu có) hoặc tên file.

    analyze=True: đọc chữ + AI tóm tắt từng file, kết quả cache trong <thư mục>/.videogen-analysis.json.
    """
    from .llm import LibraryAsset
    from .probe import IMAGE_EXTS, VIDEO_EXTS, video_info

    paths = sorted(p for p in folder.iterdir() if p.suffix.lower() in IMAGE_EXTS | VIDEO_EXTS)
    analysis: dict = {}
    if analyze and paths:
        from .analyze import analyze_files

        cache_file = folder / ANALYSIS_CACHE
        try:
            cache = json.loads(cache_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            cache = {}
        key = lambda p: f"{p.name}|{p.stat().st_size}|{p.stat().st_mtime_ns}"  # noqa: E731
        todo = [p for p in paths if key(p) not in cache]
        if todo:
            print(f"      Phân tích {len(todo)} file trong thư viện (đọc chữ + AI tóm tắt) ...", flush=True)
            for path, result in zip(todo, analyze_files(todo)):
                if result.status == "done":
                    cache[key(path)] = {"summary": result.summary, "ocr_text": result.ocr_text, "tags": result.tags}
            cache_file.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
        analysis = {p.name: cache.get(key(p), {}) for p in paths}

    items = []
    for i, path in enumerate(paths):
        note = path.with_suffix(".txt")
        description = note.read_text(encoding="utf-8").strip() if note.exists() else path.stem.replace("_", " ")
        kind = "image" if path.suffix.lower() in IMAGE_EXTS else "video"
        info = analysis.get(path.name, {})
        items.append(
            LibraryAsset(
                id=f"a{i + 1}",
                path=str(path.resolve()),
                description=description,
                tags=info.get("tags", []),
                kind=kind,
                summary=info.get("summary", ""),
                ocr_text=info.get("ocr_text", ""),
                duration=video_info(path).get("duration") if kind == "video" else None,
            )
        )
    return items


def cmd_make(argv: list[str]) -> int:
    from .config import ConfigError
    from .image_search import SEARCH_ENGINES
    from .pipeline import IMAGE_STYLES, RENDERERS, Options, run
    from .style import COLOR_FILTERS, PACINGS, SUBTITLE_STYLES, TRANSITIONS, VIDEO_TYPES, Style
    from .tts import VOICE_EFFECTS
    from .video_builder import ASPECTS
    from .writing import WRITING_STYLES

    parser = argparse.ArgumentParser(prog="videogen", description="Tạo video hướng dẫn (how-to) từ một chủ đề.")
    parser.add_argument("topic", nargs="?", help="Chủ đề, ví dụ: 'cách làm bánh flan'")
    parser.add_argument("-o", "--output", help="File video đầu ra (.mp4). Mặc định: output/<tiêu-đề>/")
    parser.add_argument("--script", help="Render từ file script.json có sẵn (bỏ qua bước gọi LLM)")
    parser.add_argument("--script-only", action="store_true", help="Chỉ sinh kịch bản, không render video")
    parser.add_argument("--steps", type=int, help="Số bước mong muốn (mặc định 5-8)")
    parser.add_argument("--aspect", choices=list(ASPECTS), default="16:9",
                        help="Tỉ lệ khung hình: 16:9 (YouTube), 9:16 (TikTok/Shorts), 1:1")
    parser.add_argument("--renderer", choices=RENDERERS, default="classic",
                        help="Cách dựng hình: classic (moviepy + Pillow) | manim (ManimGL, cần engine-manim/requirements.txt)")
    parser.add_argument("--language", default="tiếng Việt", help="Ngôn ngữ lời bình (mặc định: tiếng Việt)")
    parser.add_argument("--voice", help="Giọng đọc: edge-tts (vd vi-VN-NamMinhNeural), gtts:vi (chị Google) "
                                        "fpt:banmaiace (FPT.AI, cần FPT_AI_API_KEY) hoặc zerotts:maichi (ZeroTTS, chạy trên máy). Ghi đè TTS_VOICE")
    parser.add_argument("--rate", help="Tốc độ đọc, vd --rate=+10%% hoặc --rate=-5%% (ghi đè TTS_RATE)")
    parser.add_argument("--pitch", help="Cao độ giọng, vd --pitch=+5Hz (trong hơn) hoặc --pitch=-8Hz (trầm hơn)")
    parser.add_argument("--voice2", help="Giọng thứ hai đọc xen kẽ các bước chẵn, vd vi-VN-NamMinhNeural")
    parser.add_argument("--voice-effect", choices=VOICE_EFFECTS, default="none",
                        help="Hiệu ứng giọng: cute (dễ thương), chipmunk (sóc chuột), deep (trầm), robot, radio, echo (vang)")
    parser.add_argument("--ai-voice", action="store_true",
                        help="Cho AI tinh chỉnh cao độ/tốc độ giọng (quanh --pitch/--rate) cho hợp không khí video")
    parser.add_argument("--type", dest="video_type", choices=VIDEO_TYPES, default="howto",
                        help="Loại video: howto (hướng dẫn), listicle (top danh sách), tips (mẹo), facts (sự thật thú vị), "
                             "promo (giới thiệu/quảng cáo), story (kể chuyện)")
    parser.add_argument("--tone", default="", help="Giọng văn, vd 'hài hước, dí dỏm' hoặc 'chuyên nghiệp'")
    parser.add_argument("--writing", dest="writing_style", choices=WRITING_STYLES, default="auto",
                        help="Phong cách viết: auto, narrator (người dẫn), essay (video essay, có chính kiến), "
                             "dialogue (hai nhân vật trò chuyện, dùng --voice2 cho nhân vật 2), comedy (hài/meme)")
    parser.add_argument("--length", choices=("short", "medium", "long"), default="medium",
                        help="Độ dài: short (<45 giây), medium, long")
    parser.add_argument("--pacing", choices=PACINGS, default="normal", help="Nhịp dựng: slow | normal | fast")
    parser.add_argument("--transition", choices=TRANSITIONS, default="mix",
                        help="Chuyển cảnh: mix (luân phiên nhiều kiểu) hoặc một kiểu cố định")
    parser.add_argument("--subtitles", choices=SUBTITLE_STYLES, default="auto",
                        help="Phụ đề: auto | box (khung tối) | karaoke (tô từ đang đọc) | outline (viền đen) | none")
    parser.add_argument("--filter", dest="color_filter", choices=COLOR_FILTERS, default="none", help="Bộ lọc màu")
    parser.add_argument("--accent", default="#e95420", help="Màu chủ đạo (hex) của nhãn, thanh tiến độ, chữ karaoke")
    parser.add_argument("--progress-bar", action="store_true", help="Thanh tiến độ ở mép trên video")
    parser.add_argument("--sfx", action="store_true", help="Hiệu ứng âm thanh khi chuyển cảnh và hiện nhãn")
    parser.add_argument("--logo", type=Path, help="Ảnh logo đặt ở góc trên phải")
    parser.add_argument("--cta", default="", help="Lời kêu gọi hiện nổi bật ở cuối video, vd 'Gọi ngay 0909 123 456'")
    parser.add_argument("--music", type=Path, help="File nhạc nền (mp3/wav), tự lặp và giảm âm lượng")
    parser.add_argument("--music-volume", type=float, default=0.12, help="Âm lượng nhạc nền 0-1 (mặc định 0.12)")
    parser.add_argument("--bg-video", type=Path,
                        help="File hoặc thư mục video nền (vd gameplay). Tạo video dọc 9:16 chia đôi: "
                             "nội dung ở trên, video nền (tắt tiếng) ở dưới")
    parser.add_argument("--image-style", choices=IMAGE_STYLES, default="auto",
                        help="cover: ảnh phủ kín khung; frame: ảnh hiển thị trọn vẹn làm nội dung chính; "
                             "auto: ảnh của bạn dùng frame, ảnh tìm trên mạng dùng cover")
    parser.add_argument("--library-dir", type=Path,
                        help="Thư mục ảnh/video của bạn (mô tả trong file .txt cùng tên). AI dùng chúng làm nội dung chính")
    parser.add_argument("--library-mode", choices=("auto", "selected"), default="selected",
                        help="selected: dùng hết file trong thư mục; auto: AI tự chọn file phù hợp")
    parser.add_argument("--analyze-library", action="store_true",
                        help="Đọc chữ (OCR) + AI tóm tắt nội dung từng file trong --library-dir trước khi viết kịch bản")
    parser.add_argument("--no-web-images", action="store_true", help="Không tìm ảnh/clip trên mạng")
    parser.add_argument("--web-media", choices=("image", "video", "auto"), default="image",
                        help="Tìm trên mạng: image (ảnh), video (clip Creative Commons/stock, thiếu thì dùng ảnh), "
                             "auto (AI chọn ảnh hay clip cho từng bước)")
    parser.add_argument("--search-engine", choices=SEARCH_ENGINES, default="auto",
                        help="Công cụ tìm ảnh ưu tiên (vd brave, google); nguồn khác làm dự phòng. "
                             "auto = theo thứ tự IMAGE_PROVIDERS trong .env")
    parser.add_argument("--clips-per-step", type=int, default=3, choices=range(1, 7), metavar="1-6",
                        help="Số clip mạng ghép nối tiếp trong một bước dùng video (mặc định 3)")
    parser.add_argument("--visual-interval", type=float, default=0.0, metavar="GIÂY",
                        help="Tần suất đổi hình: cứ GIÂY giây đổi sang ảnh/clip mới (0 = tự động; không nhanh hơn "
                             "đoạn hình ngắn nhất của --pacing)")
    parser.add_argument("--meme-images", type=int, default=None, metavar="N",
                        help="Đạo diễn AI: số ảnh meme trong video (0 = không dùng; bỏ trống = AI quyết định)")
    parser.add_argument("--meme-videos", type=int, default=None, metavar="N",
                        help="Đạo diễn AI: số clip meme trong video (0 = không dùng; bỏ trống = AI quyết định)")
    parser.add_argument("--director", action="store_true",
                        help="Đạo diễn AI: AI tự lên kịch bản qua nhiều lượt (tìm asset/meme/clip, dựng và tự duyệt cảnh), "
                             "giọng đọc đổi cảm xúc theo từng câu, hiệu ứng meme. Số cảnh do AI quyết định")
    parser.add_argument("--feedback", default="", help="Góp ý để Đạo diễn AI sửa lại kịch bản trong --base-script")
    parser.add_argument("--base-script", type=Path, help="script.json của bản trước (đi kèm --feedback)")
    args = parser.parse_args(argv)

    if not args.topic and not args.script:
        parser.error("Cần nhập chủ đề hoặc --script <file>.")
    if args.music and not args.music.exists():
        parser.error(f"Không tìm thấy file nhạc: {args.music}")
    if args.bg_video and not args.bg_video.exists():
        parser.error(f"Không tìm thấy video nền: {args.bg_video}")
    if args.logo and not args.logo.exists():
        parser.error(f"Không tìm thấy logo: {args.logo}")
    if args.library_dir and not args.library_dir.is_dir():
        parser.error(f"Không tìm thấy thư mục ảnh: {args.library_dir}")

    library = _library_from_dir(args.library_dir, args.analyze_library) if args.library_dir else []
    opts = Options(
        aspect=args.aspect,
        renderer=args.renderer,
        num_steps=args.steps,
        language=args.language,
        voice=args.voice,
        voice2=args.voice2,
        rate=args.rate,
        pitch=args.pitch,
        voice_effect=args.voice_effect,
        ai_voice=args.ai_voice,
        video_type=args.video_type,
        tone=args.tone,
        writing_style=args.writing_style,
        length=args.length,
        style=Style(
            pacing=args.pacing, transition=args.transition, subtitle_style=args.subtitles,
            color_filter=args.color_filter, accent=args.accent, progress_bar=args.progress_bar,
            sfx=args.sfx, logo=args.logo, cta=args.cta,
        ),
        music=args.music,
        music_volume=args.music_volume,
        script_only=args.script_only,
        bg_video=args.bg_video,
        image_style=args.image_style,
        web_images=not args.no_web_images,
        web_media=args.web_media,
        search_engine=args.search_engine,
        clips_per_step=args.clips_per_step,
        visual_interval=max(args.visual_interval, 0.0),
        meme_images=None if args.meme_images is None else max(args.meme_images, 0),
        meme_videos=None if args.meme_videos is None else max(args.meme_videos, 0),
        library=library,
        library_mode=args.library_mode if library else "off",
        director=args.director or bool(args.base_script),
        feedback=args.feedback,
        base_script=json.loads(args.base_script.read_text(encoding="utf-8")) if args.base_script else None,
    )
    try:
        run(args.topic, args.output, args.script, opts)
    except ConfigError as e:
        print(f"❌ Lỗi cấu hình: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nĐã hủy.", file=sys.stderr)
        return 130
    except Exception as e:
        print(f"❌ Lỗi: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    return 0


def cmd_job(argv: list[str]) -> int:
    from .job import run_job

    parser = argparse.ArgumentParser(prog="videogen job", description="Chạy job từ file spec JSON (dùng cho web app).")
    parser.add_argument("spec", type=Path)
    args = parser.parse_args(argv)
    return run_job(args.spec)


def cmd_probe(argv: list[str]) -> int:
    from .probe import probe_json

    parser = argparse.ArgumentParser(prog="videogen probe", description="In thông tin ảnh/video dạng mảng JSON.")
    parser.add_argument("files", type=Path, nargs="+")
    parser.add_argument("--thumbnail-dir", type=Path, help="Lưu ảnh thu nhỏ <tên file>.jpg vào thư mục này")
    args = parser.parse_args(argv)
    return probe_json(args.files, args.thumbnail_dir)


def cmd_analyze(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="videogen analyze", description="Đọc chữ trong ảnh/video (OCR) và nhờ AI tóm tắt nội dung."
    )
    parser.add_argument("files", type=Path, nargs="*", help="Ảnh/video cần phân tích (mô tả trong file .txt cùng tên)")
    parser.add_argument("--spec", type=Path, help="File spec JSON (dùng cho web app, xem videogen/analyze.py)")
    parser.add_argument("--language", default="tiếng Việt")
    args = parser.parse_args(argv)
    if args.spec:
        from .analyze import run_spec

        return run_spec(args.spec)
    if not args.files:
        parser.error("Cần ít nhất một file hoặc --spec")
    missing = [str(f) for f in args.files if not f.exists()]
    if missing:
        parser.error(f"Không tìm thấy: {', '.join(missing)}")

    from dataclasses import asdict

    from .analyze import analyze_files

    results = analyze_files(args.files, args.language)
    print(json.dumps([asdict(r) for r in results], ensure_ascii=False, indent=2))
    return 0 if all(r.status == "done" for r in results) else 1


def cmd_voice_sample(argv: list[str]) -> int:
    """Tạo file nghe thử giọng đọc (web app dùng cho nút "Nghe thử")."""
    from .style import language_for
    from .tts import VOICE_EFFECTS, voice_sample

    parser = argparse.ArgumentParser(prog="videogen voice-sample", description="Tạo file mp3 nghe thử một giọng đọc.")
    parser.add_argument("--voice", required=True)
    parser.add_argument("--rate", default="+0%")
    parser.add_argument("--pitch", default="+0Hz")
    parser.add_argument("--language", default="tiếng Việt", help="Ngôn ngữ của câu mẫu (dùng cho gTTS dự phòng)")
    parser.add_argument("--effect", choices=VOICE_EFFECTS, default="none", help="Hiệu ứng giọng")
    parser.add_argument("--text", help="Câu đọc thử (mặc định: câu mẫu theo ngôn ngữ)")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    lang = language_for(args.language)
    text = args.text or SAMPLE_TEXT.get(lang.code, SAMPLE_TEXT["en"])
    try:
        voice_sample(text, args.voice, args.out, args.rate, args.pitch, fallback_lang=lang.code, effect=args.effect)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        return 1
    print(json.dumps({"ok": True, "path": str(args.out)}, ensure_ascii=False))
    return 0


def cmd_zerotts_voices(argv: list[str]) -> int:
    """Danh sách giọng của mô hình ZeroTTS (lần đầu sẽ tải mô hình). In JSON {"ok", "voices": [...]}."""
    from .tts import zerotts_voices

    try:
        voices = zerotts_voices()
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        return 1
    print(json.dumps({"ok": True, "voices": voices}, ensure_ascii=False))
    return 0


def cmd_import_dataset(argv: list[str]) -> int:
    from .dataset_import import main as import_main

    return import_main(argv)


SAMPLE_TEXT = {
    "vi": "Xin chào! Đây là giọng đọc cho video của bạn. Hôm nay mình sẽ hướng dẫn bạn từng bước thật dễ hiểu.",
    "en": "Hi there! This is the voice for your video. Today I'll walk you through it step by step.",
    "zh": "大家好！这是你视频的配音。今天我来一步一步教你。",
    "ja": "こんにちは！これはあなたの動画のナレーションです。今日は一歩ずつ説明します。",
    "ko": "안녕하세요! 영상의 내레이션 목소리입니다. 오늘은 차근차근 알려드릴게요.",
    "fr": "Bonjour ! Voici la voix de votre vidéo. Aujourd'hui, je vous explique tout étape par étape.",
    "es": "¡Hola! Esta es la voz de tu video. Hoy te explico todo paso a paso.",
    "de": "Hallo! Das ist die Stimme für dein Video. Heute zeige ich dir alles Schritt für Schritt.",
    "th": "สวัสดีครับ นี่คือเสียงพากย์สำหรับวิดีโอของคุณ วันนี้จะสอนทีละขั้นตอน",
    "id": "Halo! Ini suara untuk videomu. Hari ini aku akan memandumu langkah demi langkah.",
}


def cmd_doctor(argv: list[str]) -> int:
    """Kiểm tra môi trường: thư viện, API key, nguồn ảnh, font, ffmpeg."""
    report: dict = {"python": sys.version.split()[0], "problems": [], "warnings": []}
    try:
        from .config import load_settings
        from .graphics import find_font
        from .image_search import PROVIDERS, engine_status

        settings = load_settings()
        report["deepseek"] = bool(settings.deepseek_api_key)
        report["model"] = settings.deepseek_model
        report["director_model"] = settings.director_model or settings.deepseek_model
        if not settings.deepseek_api_key:
            report["problems"].append("Chưa có DEEPSEEK_API_KEY: thêm token ở trang \"Token API\" hoặc trong engine/.env")
        report["image_providers"] = [
            name for name in settings.image_providers if name in PROVIDERS and PROVIDERS[name][1](settings)
        ]
        if not report["image_providers"]:
            report["problems"].append("Không có nguồn ảnh nào dùng được (IMAGE_PROVIDERS)")
        # mọi công cụ tìm ảnh và đã có key chưa (web hiện lựa chọn công cụ tìm kiếm)
        report["search_engines"] = engine_status(settings)
        from .video_search import active_video_providers

        report["video_providers"] = active_video_providers(settings)
        report["voice"] = settings.tts_voice
        report["fpt_tts"] = bool(settings.fpt_api_key)
        from .tts import zerotts_available

        report["zerotts"] = zerotts_available()
        from .analyze import ocr_available

        report["ocr"] = ocr_available(settings)
        if not report["ocr"]:
            report["warnings"].append(
                f"Chưa dùng được Tesseract với ngôn ngữ {settings.ocr_langs}: asset sẽ không được đọc chữ. "
                "Cài: sudo dnf install tesseract tesseract-langpack-vie (Fedora) / "
                "sudo apt install tesseract-ocr tesseract-ocr-vie (Ubuntu)"
            )
        report["vision"] = settings.vision_model if settings.vision_enabled else None
        report["font"] = find_font("regular", settings.font_path)
        if not report["font"]:
            report["problems"].append("Không tìm thấy font hỗ trợ tiếng Việt (đặt FONT_PATH)")
        import edge_tts  # noqa: F401
        import imageio_ffmpeg
        import moviepy

        report["moviepy"] = moviepy.__version__
        report["ffmpeg"] = imageio_ffmpeg.get_ffmpeg_exe()
        # Renderer ManimGL (engine-manim/): chỉ xem đã cài manimgl chưa, không mở OpenGL cho nhanh
        from importlib.metadata import PackageNotFoundError, version

        try:
            report["manimgl"] = version("manimgl")
        except PackageNotFoundError:
            report["manimgl"] = None
    except Exception as e:
        report["problems"].append(f"{type(e).__name__}: {e} (chạy: pip install -r requirements.txt)")
    report["ok"] = not report["problems"]
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["ok"] else 1


def main(argv: list[str] | None = None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    command = argv[0] if argv and argv[0] in SUBCOMMANDS else "make"
    if argv and argv[0] == command:
        argv = argv[1:]
    handler = {
        "make": cmd_make, "job": cmd_job, "probe": cmd_probe, "analyze": cmd_analyze, "doctor": cmd_doctor,
        "voice-sample": cmd_voice_sample,
        "zerotts-voices": cmd_zerotts_voices,
        "import-dataset": cmd_import_dataset,
    }[command]
    sys.exit(handler(argv))
