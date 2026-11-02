"""Diễn xuất giọng đọc: mỗi câu thoại (line) có cảm xúc riêng, đổi tốc độ/cao độ/khoảng ngừng theo cảm xúc.

Một cảnh có nhiều câu thoại được đọc thành từng file riêng (mỗi câu một cảm xúc, có thể khác giọng) rồi ghép lại
thành một file WAV duy nhất cho cảnh, kèm mốc thời gian từng từ (phụ đề khớp tiếng) và từng câu (để đặt hiệu ứng
meme đúng lúc câu đó được đọc).
"""
import json
import re
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .tts import load_words, words_path


@dataclass(frozen=True)
class Mood:
    label: str     # mô tả cho AI
    rate: int      # cộng vào tốc độ gốc (%)
    pitch: int     # cộng vào cao độ gốc (Hz)
    before: float  # khoảng ngừng trước câu (giây)
    after: float   # khoảng ngừng sau câu


MOODS: dict[str, Mood] = {
    "neutral": Mood("bình thường, kể chuyện tự nhiên", 0, 0, 0.0, 0.12),
    "excited": Mood("hào hứng, vui vẻ", 10, 6, 0.0, 0.1),
    "hype": Mood("cực kỳ phấn khích, hô to kiểu MC", 20, 12, 0.0, 0.08),
    "shocked": Mood("sốc, bất ngờ (\"Cái gì cơ?!\")", 6, 16, 0.25, 0.18),
    "dramatic": Mood("kịch tính, chậm rãi, nhấn từng chữ", -16, -8, 0.4, 0.45),
    "mysterious": Mood("thì thầm, bí ẩn", -12, -5, 0.2, 0.3),
    "sarcastic": Mood("cà khịa, mỉa mai nhẹ", -6, 4, 0.15, 0.2),
    "deadpan": Mood("tỉnh bơ, mặt lạnh (để gây cười)", -8, -6, 0.3, 0.3),
    "sad": Mood("buồn, tiếc nuối", -14, -8, 0.2, 0.35),
    "serious": Mood("nghiêm túc, chắc nịch", -4, -4, 0.1, 0.2),
    "fast": Mood("liến thoắng, đọc nhanh như rap", 32, 2, 0.0, 0.06),
    "warm": Mood("ấm áp, tâm tình", -6, -2, 0.1, 0.2),
}

RATE_RANGE = (-50, 100)
PITCH_RANGE = (-40, 40)
PART_RATE = 44100

# AI được tinh chỉnh giọng chung của cả video quanh mức người dùng chọn, trong giới hạn này
TUNE_PITCH_LIMIT = 15  # Hz
TUNE_RATE_LIMIT = 20   # %


def mood_of(name: str | None) -> str:
    return name if name in MOODS else "neutral"


def _shift(base_rate: str, base_pitch: str, rate_delta: int, pitch_delta: int) -> tuple[str, str]:
    rate = min(max(int(base_rate.rstrip("%")) + rate_delta, RATE_RANGE[0]), RATE_RANGE[1])
    pitch = min(max(int(base_pitch.rstrip("Hz")) + pitch_delta, PITCH_RANGE[0]), PITCH_RANGE[1])
    return f"{rate:+d}%", f"{pitch:+d}Hz"


def prosody(base_rate: str, base_pitch: str, mood: str) -> tuple[str, str]:
    """Tốc độ/cao độ của một câu: giá trị gốc (vd "+10%", "-2Hz") cộng độ lệch theo cảm xúc."""
    m = MOODS[mood_of(mood)]
    return _shift(base_rate, base_pitch, m.rate, m.pitch)


def _clamp_int(value, limit: int) -> int:
    try:
        number = round(float(str(value).strip().removesuffix("Hz").removesuffix("%")))
    except (TypeError, ValueError):
        return 0
    return min(max(number, -limit), limit)


def normalize_tuning(value) -> dict | None:
    """Tinh chỉnh giọng của AI: {"pitch": Hz, "rate": %, "reason": "..."} (độ lệch so với cài đặt người dùng).

    Trả về None khi không có gì để chỉnh. Các trường khác (base_*, final_* do pipeline ghi lại) bị bỏ.
    """
    if not isinstance(value, dict):
        return None
    tuning = {
        "pitch": _clamp_int(value.get("pitch"), TUNE_PITCH_LIMIT),
        "rate": _clamp_int(value.get("rate"), TUNE_RATE_LIMIT),
        "reason": " ".join(str(value.get("reason") or "").split())[:200],
    }
    return tuning if tuning["pitch"] or tuning["rate"] else None


def apply_tuning(base_rate: str, base_pitch: str, tuning: dict | None) -> tuple[str, str]:
    """Tốc độ/cao độ chung của video sau khi cộng phần AI tinh chỉnh (cảm xúc từng câu cộng tiếp sau đó)."""
    if not tuning:
        return base_rate, base_pitch
    return _shift(base_rate, base_pitch, int(tuning.get("rate") or 0), int(tuning.get("pitch") or 0))


def _even_words(text: str, duration: float) -> list[dict]:
    """Giọng không có mốc từng từ (gTTS, FPT.AI): chia đều thời lượng theo độ dài từ."""
    words = re.findall(r"\S+", text)
    total = sum(len(w) for w in words) or 1
    out, t = [], 0.0
    for w in words:
        d = duration * len(w) / total
        out.append({"start": round(t, 3), "end": round(t + d, 3), "text": w.strip(".,!?…;:\"'")})
        t += d
    return [w for w in out if w["text"]]


def lines_path(audio_path: Path) -> Path:
    """Mốc thời gian từng câu thoại trong file ghép: [{"start": giây, "end": giây}]."""
    return audio_path.with_suffix(".lines.json")


def load_line_times(audio_path: Path) -> list[dict] | None:
    try:
        data = json.loads(lines_path(audio_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, list) else None


def assemble(parts: list[tuple[Path, str, str]], out_path: Path) -> Path:
    """Ghép các câu (file mp3, chữ, cảm xúc) thành một file WAV + mốc từng từ + mốc từng câu."""
    from .video_builder import decode_audio

    chunks: list[np.ndarray] = []
    words: list[dict] = []
    times: list[dict] = []
    t = 0.0

    def silence(seconds: float) -> None:
        nonlocal t
        n = int(round(seconds * PART_RATE))
        if n > 0:
            chunks.append(np.zeros((n, 2), dtype=np.float32))
            t += n / PART_RATE

    for k, (path, text, mood) in enumerate(parts):
        m = MOODS[mood_of(mood)]
        if k:
            silence(m.before)
        samples = decode_audio(path)
        duration = len(samples) / PART_RATE
        part_words = load_words(path) or _even_words(text, duration)
        words += [{**w, "start": round(w["start"] + t, 3), "end": round(w.get("end", w["start"]) + t, 3)} for w in part_words]
        times.append({"start": round(t, 3), "end": round(t + duration, 3)})
        chunks.append(samples)
        t += duration
        if k < len(parts) - 1:
            silence(m.after)

    audio = np.concatenate(chunks) if chunks else np.zeros((1, 2), dtype=np.float32)
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
    tmp = out_path.with_suffix(".part.wav")
    with wave.open(str(tmp), "wb") as f:
        f.setnchannels(2)
        f.setsampwidth(2)
        f.setframerate(PART_RATE)
        f.writeframes(pcm.tobytes())
    words_path(out_path).write_text(json.dumps(words, ensure_ascii=False), encoding="utf-8")
    lines_path(out_path).write_text(json.dumps(times), encoding="utf-8")
    tmp.replace(out_path)
    return out_path
