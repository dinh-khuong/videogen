"""Chuyển văn bản thành giọng nói.

Chính: edge-tts (giọng Microsoft Neural, miễn phí, không cần API key).
Thêm: "gtts:vi" (giọng "chị Google" quen thuộc trên các kênh meme/kiến thức), "gtts:vi-male" ("anh Google": cùng
giọng đó hạ trầm thành giọng nam), "fpt:<giọng>" (FPT.AI, giọng Việt
tự nhiên, cần FPT_AI_API_KEY), "zerotts:<giọng>" (ZeroTTS: mô hình giọng Việt chạy ngay trên máy bằng CPU,
không cần Internet sau lần tải mô hình đầu tiên ~900 MB; cần `pip install zerotts`) và hiệu ứng giọng (dễ thương, sóc chuột, trầm, robot, radio, vang) bằng ffmpeg. Ngoài giọng bản địa còn có các giọng
"Multilingual" (vd en-US-AvaMultilingualNeural) đọc được nhiều ngôn ngữ, kể cả tiếng Việt.
edge-tts trả về thời điểm của từng từ: lưu cạnh file mp3 (<tên>.words.json) để phụ đề khớp chính xác với giọng đọc.
Dự phòng: gTTS (Google Translate TTS, miễn phí) khi edge-tts lỗi liên tục —
máy chủ edge-tts đôi khi từ chối ngẫu nhiên (NoAudioReceived).
"""
import asyncio
import json
import os
import re
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import edge_tts
import requests
from gtts import gTTS

from .config import ConfigError, load_settings

MAX_CONCURRENCY = 8
EDGE_RETRIES = 8
TICKS_PER_SECOND = 10_000_000  # edge-tts tính offset theo đơn vị 100 ns

RATE_RE = re.compile(r"^[+-]\d{1,3}%$")
PITCH_RE = re.compile(r"^[+-]\d{1,3}Hz$")

# Hiệu ứng giọng (hậu xử lý bằng ffmpeg, giữ nguyên tốc độ đọc nên phụ đề vẫn khớp)
VOICE_EFFECTS = ("none", "cute", "chipmunk", "deep", "robot", "radio", "echo")
EFFECT_RATE = 44100
EFFECT_PITCH = {"cute": 1.17, "chipmunk": 1.42, "deep": 0.8}
EFFECT_FILTERS = {
    "deep": ["aecho=1.0:0.9:45:0.22"],
    # Giữ biên độ, bỏ pha trong miền tần số -> giọng máy (nhỏ tiếng hơn nên bù âm lượng)
    "robot": ["afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75", "volume=2.4"],
    "radio": ["highpass=f=320", "lowpass=f=3300", "acompressor=threshold=0.1:ratio=4", "volume=2.0"],
    "echo": ["aecho=0.8:0.85:80|160:0.32|0.18"],
}


@dataclass
class TtsJob:
    text: str
    path: Path
    voice: str
    rate: str | None = None   # riêng cho câu này (vd theo cảm xúc); None = tốc độ chung
    pitch: str | None = None


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
    """gTTS ("chị Google"): không có thời điểm từng từ, phụ đề chia theo độ dài câu."""
    tmp_path = out_path.with_suffix(".part.mp3")
    gTTS(text=text, lang=lang).save(str(tmp_path))
    words_path(out_path).unlink(missing_ok=True)
    tmp_path.replace(out_path)


FPT_URL = "https://api.fpt.ai/hmi/tts/v5"


def _fpt_synthesize(text: str, voice: str, rate: str, out_path: Path, api_key: str | None) -> None:
    """FPT.AI Text to Speech (giọng Việt tự nhiên, cần FPT_AI_API_KEY). API trả về link mp3 tạo xong sau vài giây."""
    if not api_key:
        raise ConfigError("Giọng FPT.AI cần FPT_AI_API_KEY trong engine/.env (đăng ký tại https://console.fpt.ai)")
    speed = max(-3, min(3, round(int(rate.rstrip("%")) / 10)))  # FPT nhận tốc độ -3..3
    resp = requests.post(
        FPT_URL, data=text.encode("utf-8"), timeout=30,
        headers={"api-key": api_key, "voice": voice, "speed": str(speed), "format": "mp3"},
    )
    resp.raise_for_status()
    data = resp.json()
    if data.get("error") not in (0, None) or not data.get("async"):
        raise RuntimeError(f"FPT.AI lỗi: {data.get('message') or data}")
    tmp_path = out_path.with_suffix(".part.mp3")
    for _ in range(40):  # file mp3 có sau vài giây
        audio = requests.get(data["async"], timeout=30)
        if audio.status_code == 200 and len(audio.content) > 1000:
            tmp_path.write_bytes(audio.content)
            words_path(out_path).unlink(missing_ok=True)
            tmp_path.replace(out_path)
            return
        time.sleep(1.5)
    raise RuntimeError("FPT.AI chưa trả về file audio sau 60 giây")


ZEROTTS_GAP_SEC = 0.12  # khoảng lặng giữa các đoạn khi chia câu dài
_zerotts_lock = threading.Lock()  # mô hình nặng CPU: tạo lần lượt từng câu, nạp mô hình một lần
_zerotts_model = None


def zerotts_available() -> bool:
    try:
        import zerotts  # noqa: F401
    except ImportError:
        return False
    return True


def _zerotts_model_dir(model: str) -> str:
    """Thư mục mô hình chứa file thật. Cache Hugging Face lưu file dạng symlink tới các thư mục blobs khác nhau,
    onnxruntime mới từ chối file .data nằm ngoài thư mục của .onnx ("External data path escapes model directory"),
    nên tải mô hình vào một thư mục riêng (local_dir) thay vì dùng thẳng cache."""
    if Path(model).expanduser().is_dir():
        return model
    from huggingface_hub import snapshot_download
    from zerotts.hub import _ALLOW_PATTERNS

    local_dir = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")) / "zerotts" / model.replace("/", "--")
    return snapshot_download(repo_id=model, local_dir=str(local_dir), allow_patterns=_ALLOW_PATTERNS)


def _zerotts():
    """Nạp mô hình ZeroTTS một lần (lần đầu tải trọng số từ Hugging Face, sau đó dùng cache)."""
    global _zerotts_model
    if _zerotts_model is None:
        try:
            from zerotts import ZeroTTS
        except ImportError as e:
            raise ConfigError("Giọng ZeroTTS cần cài thư viện: pip install zerotts (trong môi trường Python của engine)") from e
        settings = load_settings()
        print(f"      🔊 Đang nạp mô hình ZeroTTS ({settings.zerotts_model}), lần đầu sẽ tải ~900 MB...", flush=True)
        _zerotts_model = ZeroTTS.from_pretrained(_zerotts_model_dir(settings.zerotts_model), intra_op_num_threads=settings.zerotts_threads)
    return _zerotts_model


def zerotts_voices() -> list[dict]:
    """Các giọng có sẵn trong mô hình ZeroTTS: [{"name", "label", "gender"}]."""
    with _zerotts_lock:
        tts = _zerotts()
        voices = []
        for name in tts.list_voices():
            try:
                v = tts.load_voice(name)
                voices.append({"name": name, "label": v.display_name, "gender": v.gender, "description": v.description})
            except Exception:
                voices.append({"name": name, "label": name, "gender": "", "description": ""})
        return voices


def _zerotts_synthesize(text: str, voice: str, out_path: Path) -> None:
    """ZeroTTS: đọc số/ngày/viết tắt thành chữ, chia câu dài thành đoạn ngắn (mô hình học trên từng câu), ghép lại.
    Không có thời điểm từng từ: phụ đề chia theo độ dài câu."""
    from zerotts import normalize_vi_text
    from zerotts.audio import concat_with_silence
    from zerotts.chunking import chunk_text, clean_segment_punctuation, normalize_punctuation

    from .probe import ffmpeg_exe

    text = normalize_vi_text(text)
    segments = [s for s in (clean_segment_punctuation(c) for c in chunk_text(normalize_punctuation(text), max_chunk_sec=15)) if s]
    with _zerotts_lock:
        tts = _zerotts()
        if voice not in tts.list_voices():
            raise ConfigError(f"Mô hình ZeroTTS không có giọng '{voice}' (có: {', '.join(tts.list_voices())})")
        audio = concat_with_silence([tts.synthesize(s, voice=voice) for s in segments or [text]], ZEROTTS_GAP_SEC, tts.sample_rate)
        if not audio.size:
            raise RuntimeError("ZeroTTS không tạo được audio")
        wav = out_path.with_suffix(".zerotts.wav")
        tts.save_audio(audio, str(wav))
    tmp_path = out_path.with_suffix(".part.mp3")
    try:
        subprocess.run([ffmpeg_exe(), "-v", "error", "-y", "-i", str(wav), "-c:a", "libmp3lame", "-q:a", "3", str(tmp_path)],
                       check=True, capture_output=True)
    finally:
        wav.unlink(missing_ok=True)
    words_path(out_path).unlink(missing_ok=True)
    tmp_path.replace(out_path)


def _atempo(factor: float) -> list[str]:
    """atempo chỉ nhận 0.5-2: tách thành nhiều bước."""
    steps = []
    while factor > 2.0:
        steps.append("atempo=2.0")
        factor /= 2.0
    while factor < 0.5:
        steps.append("atempo=0.5")
        factor /= 0.5
    if abs(factor - 1) > 0.005:
        steps.append(f"atempo={factor:.4f}")
    return steps


def audio_filters(effect: str, tempo: float = 1.0, pitch: float = 1.0) -> list[str]:
    """Chuỗi bộ lọc ffmpeg: đổi cao độ (giữ nguyên tốc độ), đổi tốc độ, rồi hiệu ứng giọng."""
    pitch *= EFFECT_PITCH.get(effect, 1.0)
    filters = []
    if abs(pitch - 1) > 0.005:
        # Phát nhanh hơn (cao giọng hơn) rồi kéo dài lại đúng tốc độ: giữ nguyên thời lượng câu
        filters += [f"aresample={EFFECT_RATE}", f"asetrate={round(EFFECT_RATE * pitch)}", f"aresample={EFFECT_RATE}"]
    filters += _atempo(tempo / pitch)
    filters += EFFECT_FILTERS.get(effect, [])
    return filters


def _post_process(src: Path, dest: Path, filters: list[str]) -> None:
    from .probe import ffmpeg_exe

    tmp = dest.with_suffix(".fx.mp3")
    subprocess.run(
        [ffmpeg_exe(), "-v", "error", "-y", "-i", str(src), "-af", ",".join(filters), "-c:a", "libmp3lame", "-q:a", "3", str(tmp)],
        check=True, capture_output=True,
    )
    tmp.replace(dest)


# gTTS chỉ có giọng nữ: "anh Google" (gtts:vi-male) = cùng giọng hạ trầm, giữ nguyên tốc độ
MALE_PITCH = 0.78


def is_male(voice: str) -> bool:
    return provider_of(voice) == "gtts" and voice.endswith("-male")


def gtts_lang(name: str) -> str:
    return name.removesuffix("-male") or "vi"


def provider_of(voice: str) -> str:
    """edge (mặc định) | gtts ("gtts:vi") | fpt ("fpt:banmaiace") | zerotts ("zerotts:maichi")."""
    prefix, _, rest = voice.partition(":")
    return prefix if rest and prefix in ("gtts", "fpt", "zerotts") else "edge"


async def _synthesize_all(
    jobs: list[TtsJob], rate: str, pitch: str, fallback_lang: str | None, effect: str, on_done: Callable[[], None]
) -> None:
    semaphore = asyncio.Semaphore(MAX_CONCURRENCY)
    fpt_key = load_settings().fpt_api_key

    async def run(job: TtsJob) -> None:
        job_rate, job_pitch = job.rate or rate, job.pitch or pitch
        tempo = 1 + int(job_rate.rstrip("%")) / 100
        # Cao độ theo Hz (edge-tts) đổi thành tỉ lệ cho giọng khác: giọng người ~200 Hz
        pitch_factor = 1 + int(job_pitch.rstrip("Hz")) / 200
        provider = provider_of(job.voice)
        name = job.voice.partition(":")[2]
        raw = job.path.with_suffix(".raw.mp3")
        raw.unlink(missing_ok=True)  # file dở dang của lần chạy bị ngắt
        words_path(raw).unlink(missing_ok=True)
        made_by = "gtts"
        async with semaphore:
            if provider == "edge":
                if await _edge_synthesize(job.text, job.voice, job_rate, job_pitch, raw):
                    made_by = "edge"
                else:
                    print(f"      ⚠️  edge-tts lỗi cho '{job.path.stem}', chuyển sang gTTS.", flush=True)
            elif provider == "fpt":
                try:
                    await asyncio.to_thread(_fpt_synthesize, job.text, name, job_rate, raw, fpt_key)
                    made_by = "fpt"
                except ConfigError:
                    raise
                except Exception as e:
                    print(f"      ⚠️  FPT.AI lỗi cho '{job.path.stem}' ({e}), chuyển sang gTTS.", flush=True)
            elif provider == "zerotts":
                # Lỗi cấu hình (chưa cài, sai tên giọng) báo ngay thay vì âm thầm đổi sang giọng khác
                try:
                    await asyncio.to_thread(_zerotts_synthesize, job.text, name, raw)
                    made_by = "zerotts"
                except ConfigError:
                    raise
                except Exception as e:
                    print(f"      ⚠️  ZeroTTS lỗi cho '{job.path.stem}' ({e}), chuyển sang gTTS.", flush=True)
            if made_by == "gtts":
                lang = gtts_lang(name) if provider == "gtts" else fallback_lang or job.voice.split("-")[0] or "vi"
                await asyncio.to_thread(_gtts_synthesize, job.text, lang, raw)
        # Hậu xử lý: hiệu ứng giọng, cộng tốc độ/cao độ với giọng không tự hỗ trợ
        # (edge-tts tự đổi cả hai, FPT.AI chỉ tự đổi tốc độ, gTTS và ZeroTTS không đổi được gì)
        filters = audio_filters(
            effect,
            tempo=1.0 if made_by in ("edge", "fpt") else tempo,
            pitch=(1.0 if made_by == "edge" else pitch_factor) * (MALE_PITCH if is_male(job.voice) else 1.0),
        )
        if filters:
            await asyncio.to_thread(_post_process, raw, job.path, filters)
            raw.unlink(missing_ok=True)
        else:
            raw.replace(job.path)
        # Thời điểm từng từ không đổi (hiệu ứng giữ nguyên tốc độ; đổi tốc độ chỉ xảy ra với giọng không có mốc từ)
        if words_path(raw).exists():
            words_path(raw).replace(words_path(job.path))
        else:
            words_path(job.path).unlink(missing_ok=True)
        on_done()

    await asyncio.gather(*(run(job) for job in jobs))


def synthesize_many(
    jobs: list[TtsJob],
    rate: str = "+0%",
    pitch: str = "+0Hz",
    on_progress: Callable[[int, int], None] | None = None,
    fallback_lang: str | None = None,
    effect: str = "none",
) -> None:
    """Tạo song song nhiều file mp3 (mỗi file có thể dùng giọng khác nhau). Bỏ qua file đã tồn tại (cache).

    on_progress(done, total) được gọi mỗi khi xong một file. fallback_lang: mã ngôn ngữ cho gTTS (vd "vi")
    khi edge-tts lỗi — cần khi dùng giọng đa ngôn ngữ (en-US-...Multilingual đọc tiếng Việt).
    effect: hiệu ứng giọng (xem VOICE_EFFECTS).
    """
    for job in [None, *jobs]:
        r, p = (rate, pitch) if job is None else (job.rate or rate, job.pitch or pitch)
        if not RATE_RE.match(r):
            raise ValueError(f"Tốc độ đọc không hợp lệ: {r} (dạng +10% hoặc -5%)")
        if not PITCH_RE.match(p):
            raise ValueError(f"Cao độ giọng không hợp lệ: {p} (dạng +5Hz hoặc -10Hz)")
    if effect not in VOICE_EFFECTS:
        raise ValueError(f"Hiệu ứng giọng không hợp lệ: {effect} (chọn: {', '.join(VOICE_EFFECTS)})")
    pending = [job for job in jobs if not job.path.exists()]
    total, done = len(jobs), len(jobs) - len(pending)

    def on_done() -> None:
        nonlocal done
        done += 1
        if on_progress:
            on_progress(done, total)

    if pending:
        asyncio.run(_synthesize_all(pending, rate, pitch, fallback_lang, effect, on_done))


def voice_sample(text: str, voice: str, out_path: Path, rate: str = "+0%", pitch: str = "+0Hz",
                 fallback_lang: str | None = None, effect: str = "none") -> Path:
    """Tạo một file nghe thử giọng đọc (dùng cho nút "Nghe thử" của web app)."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.unlink(missing_ok=True)
    synthesize_many([TtsJob(text, out_path, voice)], rate, pitch, fallback_lang=fallback_lang, effect=effect)
    return out_path
