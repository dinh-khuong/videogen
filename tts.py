"""Chuyển văn bản thành giọng nói.

Chính: edge-tts (giọng Microsoft Neural, miễn phí, không cần API key).
Dự phòng: gTTS (Google Translate TTS, miễn phí) khi edge-tts lỗi liên tục —
máy chủ edge-tts đôi khi từ chối ngẫu nhiên (NoAudioReceived).
"""
import asyncio
from pathlib import Path

import edge_tts
from gtts import gTTS

MAX_CONCURRENCY = 2
EDGE_RETRIES = 8


async def _edge_synthesize(text: str, voice: str, rate: str, out_path: Path) -> bool:
    tmp_path = out_path.with_suffix(".part.mp3")
    for attempt in range(EDGE_RETRIES):
        try:
            await edge_tts.Communicate(text, voice, rate=rate).save(str(tmp_path))
            tmp_path.replace(out_path)
            return True
        except Exception:
            await asyncio.sleep(0.7 * (attempt + 1))
    tmp_path.unlink(missing_ok=True)
    return False


def _gtts_synthesize(text: str, voice: str, out_path: Path) -> None:
    lang = voice.split("-")[0] if voice else "vi"
    tmp_path = out_path.with_suffix(".part.mp3")
    gTTS(text=text, lang=lang).save(str(tmp_path))
    tmp_path.replace(out_path)


async def _synthesize_all(jobs: list[tuple[str, Path]], voice: str, rate: str) -> None:
    semaphore = asyncio.Semaphore(MAX_CONCURRENCY)

    async def run(text: str, path: Path) -> None:
        async with semaphore:
            if await _edge_synthesize(text, voice, rate, path):
                return
        print(f"      ⚠️  edge-tts lỗi cho '{path.stem}', chuyển sang gTTS.")
        await asyncio.to_thread(_gtts_synthesize, text, voice, path)

    await asyncio.gather(*(run(text, path) for text, path in jobs))


def synthesize_many(jobs: list[tuple[str, Path]], voice: str, rate: str = "+0%") -> None:
    """Tạo song song nhiều file mp3. Bỏ qua file đã tồn tại (cache)."""
    pending = [(text, path) for text, path in jobs if not path.exists()]
    if pending:
        asyncio.run(_synthesize_all(pending, voice, rate))
