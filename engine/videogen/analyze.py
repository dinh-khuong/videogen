"""Phân tích asset (ảnh/video) để AI biết nội dung khi chọn asset cho video.

Với mỗi asset:
1. Lấy khung hình: ảnh dùng chính nó, video lấy vài khung ở đầu/giữa/cuối.
2. OCR bằng Tesseract (chạy local, hỗ trợ tiếng Việt) để đọc chữ trong hình.
3. (Tùy chọn) mô hình thị giác mô tả hình ảnh, nếu cấu hình VISION_MODEL.
4. DeepSeek viết tóm tắt + hashtag từ tên, mô tả của người dùng, chữ đọc được và mô tả hình ảnh;
   đồng thời sửa lỗi nhận dạng OCR và bỏ ký tự rác.

Spec cho web app (`python -m videogen analyze --spec spec.json`):
{"language": "tiếng Việt",
 "items": [{"id": "...", "path": "/abs/file", "kind": "image" | "video", "title": "...", "description": "..."}]}
Mỗi asset xong phát một sự kiện {"type": "asset", "id", "status": "done" | "failed", "ocr_text", "summary", "tags", "error"}.
"""
import base64
import io
import json
import os
import re
import subprocess
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path

from PIL import Image, ImageOps

from videogen_core.config import Settings, load_settings

from .events import JsonReporter
from .llm import extract_json, normalize_hashtags
from .probe import AUDIO_EXTS, IMAGE_EXTS, audio_info, ffmpeg_exe, video_info

OCR_MIN_CONF = 60       # độ tin cậy tối thiểu của một từ (0-100)
OCR_MAX_CHARS = 2000    # giới hạn chữ lưu lại cho mỗi asset
VIDEO_FRAMES = (0.15, 0.5, 0.85)
SHORT_SOUND_SECONDS = 10.0  # audio ngắn hơn mức này được Đạo diễn AI dùng làm hiệu ứng (web: SOUND_EFFECT_MAX_SECONDS)

SUMMARY_PROMPT = """Bạn giúp người dựng video phân loại tư liệu (ảnh hoặc video ngắn).
Dữ liệu về một asset (ảnh, video hoặc audio) gồm: loại, tên file/tiêu đề, mô tả của người dùng, chữ đọc được bằng OCR
(có thể lẫn lỗi nhận dạng hoặc ký tự rác) và mô tả hình ảnh của mô hình thị giác (nếu có).
Chỉ trả lời bằng JSON:
{
  "summary": "1-3 câu bằng {language}: asset thể hiện gì, thông tin chính (tên sản phẩm, giá, số liệu, các bước...) và phù hợp để minh họa nội dung nào trong video. Với audio: nếu là nhạc/bài dài thì thể loại, tâm trạng và loại video phù hợp làm nhạc nền; nếu là âm thanh ngắn (hiệu ứng) thì đó là tiếng gì (tiếng động, meme sound, tiếng người, nhạc hiệu...), cảm xúc/tình huống nó diễn tả và “miếng” nào trong video nên chèn nó vào (vd plot twist, câu ngớ ngẩn, khen ngợi).",
  "text": "Chữ trong asset sau khi sửa lỗi OCR rõ ràng, giữ nguyên thứ tự và ý; bỏ dòng rác. Chuỗi rỗng nếu không có chữ có nghĩa.",
  "tags": ["3-6 hashtag viết thường, không dấu, viết liền, không có ký tự #"]
}
Không bịa chi tiết không có trong dữ liệu. Thiếu thông tin thì chỉ nói những gì biết chắc."""

VISION_PROMPT = """Mô tả ngắn gọn bằng {language} nội dung hình ảnh (1-3 câu: chủ thể, bối cảnh, hành động, màu sắc nổi bật)
và chép lại chữ nhìn thấy trong hình (nếu có). {extra}Chỉ trả lời JSON: {"caption": "...", "text": "..."}"""


@dataclass
class AssetInput:
    id: str
    path: str
    kind: str = "image"
    title: str = ""
    description: str = ""


@dataclass
class AssetAnalysis:
    id: str
    status: str = "done"
    ocr_text: str = ""
    summary: str = ""
    tags: list[str] = field(default_factory=list)
    caption: str = ""
    error: str | None = None


def kind_of(path: Path) -> str:
    ext = path.suffix.lower()
    return "image" if ext in IMAGE_EXTS else "audio" if ext in AUDIO_EXTS else "video"


def _video_frames(path: Path, out_dir: Path) -> list[Path]:
    duration = video_info(path).get("duration") or 0.0
    points = VIDEO_FRAMES if duration >= 3 else (0.5,)
    frames = []
    for i, p in enumerate(points):
        out = out_dir / f"frame_{i}.jpg"
        subprocess.run(
            [ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{duration * p:.2f}", "-i", str(path),
             "-frames:v", "1", "-q:v", "3", str(out)],
            capture_output=True, timeout=60,
        )
        if out.exists() and out.stat().st_size:
            frames.append(out)
    if not frames:
        raise ValueError("Không lấy được khung hình nào từ video")
    return frames


def _ocr_input(src: Path, out: Path) -> Path:
    """Ảnh xám, tăng tương phản, phóng to ảnh nhỏ (Tesseract đọc tốt nhất khi chữ cao ~30px)."""
    with Image.open(src) as img:
        img = ImageOps.exif_transpose(img).convert("L")
        longest = max(img.size)
        scale = 1600 / longest if longest < 1600 else (3000 / longest if longest > 3000 else 1.0)
        if scale != 1.0:
            img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
        ImageOps.autocontrast(img, cutoff=1).save(out)
    return out


def _clean_line(words: list[tuple[str, float]]) -> str | None:
    text = " ".join(w for w, _ in words).strip()
    if not text:
        return None
    meaningful = sum(ch.isalnum() for ch in text)
    avg_conf = sum(c for _, c in words) / len(words)
    # Ảnh chụp không có chữ thường sinh ra vài ký tự rời rạc với độ tin cậy thấp
    if meaningful < 2 or meaningful / len(text.replace(" ", "")) < 0.6:
        return None
    if avg_conf < 70 and not (len(words) >= 2 and avg_conf >= OCR_MIN_CONF):
        return None
    return text


def ocr(image_path: Path, settings: Settings, work: Path) -> str:
    """Đọc chữ trong ảnh bằng Tesseract. Trả về các dòng chữ đáng tin cậy (rỗng nếu không có chữ)."""
    prepared = _ocr_input(image_path, work / f"{image_path.stem}_ocr.png")
    env = {**os.environ, "OMP_THREAD_LIMIT": "1"}
    proc = subprocess.run(
        [settings.tesseract_cmd, str(prepared), "stdout", "-l", settings.ocr_langs, "--psm", "3", "tsv"],
        capture_output=True, text=True, timeout=120, env=env,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Tesseract lỗi: {proc.stderr.strip()[-300:]}")
    lines: dict[tuple[str, str, str], list[tuple[str, float]]] = {}
    for row in proc.stdout.splitlines()[1:]:
        cols = row.split("\t")
        if len(cols) < 12 or not cols[11].strip():
            continue
        conf = float(cols[10])
        if conf < OCR_MIN_CONF:
            continue
        lines.setdefault((cols[2], cols[3], cols[4]), []).append((cols[11].strip(), conf))
    kept = [line for line in (_clean_line(words) for words in lines.values()) if line]
    return "\n".join(kept)


def ocr_available(settings: Settings) -> str | None:
    """Phiên bản Tesseract nếu dùng được với OCR_LANGS, None nếu không."""
    try:
        version = subprocess.run([settings.tesseract_cmd, "--version"], capture_output=True, text=True, timeout=10)
        langs = subprocess.run([settings.tesseract_cmd, "--list-langs"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    have = set(langs.stdout.split())
    if any(lang not in have for lang in settings.ocr_langs.split("+")):
        return None
    first = (version.stdout or version.stderr).splitlines()
    return first[0].strip() if first else "tesseract"


def _merge_texts(texts: list[str]) -> str:
    seen: list[str] = []
    for text in texts:
        for line in text.splitlines():
            key = re.sub(r"\W+", "", line.lower())
            if key and key not in {re.sub(r"\W+", "", s.lower()) for s in seen}:
                seen.append(line)
    return "\n".join(seen)[:OCR_MAX_CHARS]


def _jpeg_data_url(path: Path, max_side: int = 1024) -> str:
    with Image.open(path) as img:
        img = ImageOps.exif_transpose(img).convert("RGB")
        img.thumbnail((max_side, max_side))
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def describe(frames: list[Path], kind: str, settings: Settings, language: str) -> dict:
    """Mô tả hình ảnh bằng mô hình thị giác (API kiểu OpenAI). Trả về {"caption", "text"}."""
    from openai import OpenAI

    client = OpenAI(api_key=settings.vision_api_key or "none", base_url=settings.vision_base_url, max_retries=2, timeout=120)
    extra = "Các ảnh là những khung hình lấy từ cùng một video theo thứ tự thời gian. " if kind == "video" else ""
    content: list[dict] = [{"type": "text", "text": VISION_PROMPT.replace("{language}", language).replace("{extra}", extra)}]
    content += [{"type": "image_url", "image_url": {"url": _jpeg_data_url(f)}} for f in frames]
    response = client.chat.completions.create(
        model=settings.vision_model, messages=[{"role": "user", "content": content}], temperature=0.2
    )
    data = extract_json(response.choices[0].message.content or "")
    return {"caption": str(data.get("caption") or "").strip(), "text": str(data.get("text") or "").strip()}


def summarize(item: AssetInput, ocr_text: str, caption: str, settings: Settings, language: str, seconds: float | None = None) -> dict:
    """Tóm tắt bằng DeepSeek. Trả về {"summary", "text", "tags"}. seconds: thời lượng (audio)."""
    from openai import OpenAI

    kind = {"video": "video", "audio": "audio (nhạc/âm thanh)"}.get(item.kind, "ảnh")
    facts = [f"Loại: {kind}", f"Tên/tiêu đề: {item.title or Path(item.path).stem}"]
    if seconds:
        facts.append(f"Thời lượng: {seconds:.1f} giây ({'âm thanh ngắn, dùng làm hiệu ứng chèn vào câu thoại' if seconds <= SHORT_SOUND_SECONDS else 'nhạc/bài dài, dùng làm nhạc nền'})")
    if item.description.strip():
        facts.append(f"Mô tả của người dùng: {item.description.strip()}")
    facts.append(f"Chữ đọc được (OCR):\n{ocr_text}" if ocr_text else "Chữ đọc được (OCR): (không có)")
    if caption:
        facts.append(f"Mô tả hình ảnh (mô hình thị giác): {caption}")
    client = OpenAI(api_key=settings.deepseek_api_key, base_url=settings.deepseek_base_url, max_retries=3, timeout=90)
    response = client.chat.completions.create(
        model=settings.deepseek_model,
        messages=[
            {"role": "system", "content": SUMMARY_PROMPT.replace("{language}", language)},
            {"role": "user", "content": "\n".join(facts)},
        ],
        response_format={"type": "json_object"},
        temperature=0.3,
    )
    data = extract_json(response.choices[0].message.content or "")
    return {
        "summary": str(data.get("summary") or "").strip(),
        "text": str(data.get("text") or "").strip(),
        "tags": normalize_hashtags(data.get("tags"))[:8],
    }


def _informative(title: str) -> bool:
    """Tên file do máy ảnh/điện thoại đặt (IMG_1234, DSC0001, Screenshot 2024-...) không nói gì về nội dung."""
    words = re.findall(r"[^\W\d_]{2,}", title.lower())
    generic = {"img", "image", "dsc", "dcim", "photo", "pic", "picture", "screenshot", "screen", "shot", "video",
               "vid", "mov", "pxl", "mvimg", "wp", "ảnh", "chụp", "màn", "hình", "copy", "edited", "untitled"}
    return any(w not in generic for w in words)


def analyze_one(item: AssetInput, settings: Settings, language: str, use_ocr: bool) -> AssetAnalysis:
    result = AssetAnalysis(id=item.id)
    path = Path(item.path)
    if not path.exists():
        raise FileNotFoundError(f"Không tìm thấy file {path}")
    if item.kind == "audio":
        # Audio không có hình để đọc chữ: chỉ tóm tắt từ tên + mô tả (vd thể loại nhạc, tâm trạng)
        if settings.deepseek_api_key and (item.description.strip() or _informative(item.title)):
            try:
                seconds = audio_info(path)["duration"]
            except Exception:  # noqa: BLE001 - không đọc được thời lượng thì vẫn tóm tắt từ tên + mô tả
                seconds = None
            data = summarize(item, "", "", settings, language, seconds)
            result.summary, result.tags = data["summary"], data["tags"]
        return result
    with tempfile.TemporaryDirectory(prefix="videogen_analyze_") as tmp:
        work = Path(tmp)
        frames = _video_frames(path, work) if item.kind == "video" else [path]

        if use_ocr:
            result.ocr_text = _merge_texts([ocr(f, settings, work) for f in frames])
        if settings.vision_enabled:
            try:
                vision = describe(frames, item.kind, settings, language)
                result.caption = vision["caption"]
                if vision["text"] and not result.ocr_text:
                    result.ocr_text = vision["text"][:OCR_MAX_CHARS]
            except Exception as e:  # mô hình thị giác là phần bổ sung, lỗi thì vẫn dùng OCR
                print(f"      ⚠️  Mô hình thị giác lỗi ({item.id}): {type(e).__name__}: {e}", flush=True)

    has_signal = result.ocr_text or result.caption or item.description.strip() or _informative(item.title)
    if settings.deepseek_api_key and has_signal:
        data = summarize(item, result.ocr_text, result.caption, settings, language)
        result.summary, result.tags = data["summary"], data["tags"]
        if result.ocr_text:
            # Dùng bản đã sửa lỗi; LLM trả rỗng nghĩa là chữ OCR toàn rác
            result.ocr_text = data["text"][:OCR_MAX_CHARS]
    else:
        result.summary = result.caption
    return result


def analyze_items(items: list[AssetInput], language: str = "tiếng Việt", on_result=None, workers: int = 3) -> list[AssetAnalysis]:
    settings = load_settings()
    use_ocr = ocr_available(settings) is not None
    if not use_ocr:
        print(f"      ⚠️  Không dùng được Tesseract với ngôn ngữ {settings.ocr_langs}: bỏ qua bước đọc chữ.", flush=True)
    lock = threading.Lock()

    def job(item: AssetInput) -> AssetAnalysis:
        try:
            result = analyze_one(item, settings, language, use_ocr)
        except Exception as e:
            result = AssetAnalysis(id=item.id, status="failed", error=f"{type(e).__name__}: {e}")
        print(f"      {'✓' if result.status == 'done' else '✗'} {item.id}: {result.summary or result.error or '(không có thông tin)'}", flush=True)
        if on_result:
            with lock:
                on_result(result)
        return result

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        return list(pool.map(job, items))


def run_spec(spec_path: Path) -> int:
    reporter = JsonReporter()
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    items = [
        AssetInput(
            id=str(i["id"]),
            path=str(i["path"]),
            kind=i.get("kind") or kind_of(Path(i["path"])),
            title=i.get("title") or "",
            description=i.get("description") or "",
        )
        for i in spec.get("items") or []
    ]

    def emit(result: AssetAnalysis) -> None:
        data = asdict(result)
        data.pop("caption")
        reporter.emit("asset", **data)

    analyze_items(items, spec.get("language") or "tiếng Việt", on_result=emit)
    return 0


def analyze_files(paths: list[Path], language: str = "tiếng Việt") -> list[AssetAnalysis]:
    """Dùng cho CLI: phân tích file trên đĩa; mô tả lấy từ file <tên>.txt cạnh file (nếu có)."""
    items = []
    for path in paths:
        note = path.with_suffix(".txt")
        items.append(
            AssetInput(
                id=path.name,
                path=str(path.resolve()),
                kind=kind_of(path),
                title=path.stem.replace("_", " "),
                description=note.read_text(encoding="utf-8").strip() if note.exists() else "",
            )
        )
    return analyze_items(items, language)
