"""Chuyển văn bản thành giọng nói.

Chính: edge-tts (giọng Microsoft Neural, miễn phí, không cần API key). Ngoài giọng bản địa còn có các giọng
"Multilingual" (vd en-US-AvaMultilingualNeural) đọc được nhiều ngôn ngữ, kể cả tiếng Việt.
edge-tts trả về thời điểm của từng từ: lưu cạnh file mp3 (<tên>.words.json) để phụ đề khớp chính xác với giọng đọc.
Dự phòng: gTTS (Google Translate TTS, miễn phí) khi edge-tts lỗi liên tục —
máy chủ edge-tts đôi khi từ chối ngẫu nhiên (NoAudioReceived).
"""
import asyncio
import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import edge_tts
from gtts import gTTS

MAX_CONCURRENCY = 2
EDGE_RETRIES = 8
TICKS_PER_SECOND = 10_000_000  # edge-tts tính offset theo đơn vị 100 ns

RATE_RE = re.compile(r"^[+-]\d{1,3}%$")
PITCH_RE = re.compile(r"^[+-]\d{1,3}Hz$")


@dataclass
class TtsJob:
    text: str
    path: Path
    voice: str


def words_path(audio_path: Path) -> Path:
    """File JSON thời điểm từng từ cạnh file mp3: [{"start": giây, "end": giây, "text": "..."}]."""
    return audio_path.with_suffix(".words.json")


def load_words(audio_path: Path) -> list[dict] | None:
    try:
        data = json.loads(words_path(audio_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, list) or not data:
        return None
    return [w for w in data if isinstance(w, dict) and "start" in w and "text" in w] or None


def _communicate(text: str, voice: str, rate: str, pitch: str) -> edge_tts.Communicate:
    try:
        return edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, boundary="WordBoundary")
    except TypeError:  # edge-tts cũ chưa có tham số boundary (mặc định đã là WordBoundary)
        return edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)


async def _edge_synthesize(text: str, voice: str, rate: str, pitch: str, out_path: Path) -> bool:
    tmp_path = out_path.with_suffix(".part.mp3")
    for attempt in range(EDGE_RETRIES):
        words: list[dict] = []
        try:
            with open(tmp_path, "wb") as audio:
                async for chunk in _communicate(text, voice, rate, pitch).stream():
                    if chunk["type"] == "audio":
                        audio.write(chunk["data"])
                    elif chunk["type"] == "WordBoundary":
                        start = chunk["offset"] / TICKS_PER_SECOND
                        end = start + chunk["duration"] / TICKS_PER_SECOND
                        words.append({"start": round(start, 3), "end": round(end, 3), "text": chunk["text"]})
            if not tmp_path.stat().st_size:
                raise RuntimeError("không nhận được audio")
            # Ghi thời điểm từng từ trước: file mp3 xuất hiện nghĩa là bộ cache đã đủ
            if words:
                words_path(out_path).write_text(json.dumps(words, ensure_ascii=False), encoding="utf-8")
            else:
                words_path(out_path).unlink(missing_ok=True)
            tmp_path.replace(out_path)
            return True
        except Exception:
            await asyncio.sleep(0.7 * (attempt + 1))
    tmp_path.unlink(missing_ok=True)
    return False


def _gtts_synthesize(text: str, lang: str, out_path: Path) -> None:
    tmp_path = out_path.with_suffix(".part.mp3")
    gTTS(text=text, lang=lang).save(str(tmp_path))
    words_path(out_path).unlink(missing_ok=True)  # gTTS không có thời điểm từng từ: phụ đề chia theo độ dài
    tmp_path.replace(out_path)


async def _synthesize_all(
    jobs: list[TtsJob], rate: str, pitch: str, fallback_lang: str | None, on_done: Callable[[], None]
) -> None:
    semaphore = asyncio.Semaphore(MAX_CONCURRENCY)

    async def run(job: TtsJob) -> None:
        async with semaphore:
            if await _edge_synthesize(job.text, job.voice, rate, pitch, job.path):
                on_done()
                return
        print(f"      ⚠️  edge-tts lỗi cho '{job.path.stem}', chuyển sang gTTS.", flush=True)
        lang = fallback_lang or job.voice.split("-")[0] or "vi"
        await asyncio.to_thread(_gtts_synthesize, job.text, lang, job.path)
        on_done()

    await asyncio.gather(*(run(job) for job in jobs))


def synthesize_many(
    jobs: list[TtsJob],
    rate: str = "+0%",
    pitch: str = "+0Hz",
    on_progress: Callable[[int, int], None] | None = None,
    fallback_lang: str | None = None,
) -> None:
    """Tạo song song nhiều file mp3 (mỗi file có thể dùng giọng khác nhau). Bỏ qua file đã tồn tại (cache).

    on_progress(done, total) được gọi mỗi khi xong một file. fallback_lang: mã ngôn ngữ cho gTTS (vd "vi")
    khi edge-tts lỗi — cần khi dùng giọng đa ngôn ngữ (en-US-...Multilingual đọc tiếng Việt).
    """
    if not RATE_RE.match(rate):
        raise ValueError(f"Tốc độ đọc không hợp lệ: {rate} (dạng +10% hoặc -5%)")
    if not PITCH_RE.match(pitch):
        raise ValueError(f"Cao độ giọng không hợp lệ: {pitch} (dạng +5Hz hoặc -10Hz)")
    pending = [job for job in jobs if not job.path.exists()]
    total, done = len(jobs), len(jobs) - len(pending)

    def on_done() -> None:
        nonlocal done
        done += 1
        if on_progress:
            on_progress(done, total)

    if pending:
        asyncio.run(_synthesize_all(pending, rate, pitch, fallback_lang, on_done))


def voice_sample(text: str, voice: str, out_path: Path, rate: str = "+0%", pitch: str = "+0Hz",
                 fallback_lang: str | None = None) -> Path:
    """Tạo một file nghe thử giọng đọc (dùng cho nút "Nghe thử" của web app)."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.unlink(missing_ok=True)
    synthesize_many([TtsJob(text, out_path, voice)], rate, pitch, fallback_lang=fallback_lang)
    return out_path
