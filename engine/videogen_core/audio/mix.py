"""Trộn track âm thanh cuối của video: giọng đọc từng cảnh, hiệu ứng (tiếng chuyển cảnh, "tách", tiếng theo câu thoại,
âm thanh thư viện) và nhạc nền, chính xác tới từng mẫu theo timeline các cảnh.

Engine nào cũng dựng cùng một timeline: cảnh sau bắt đầu chồng lên `transition` giây cuối của cảnh trước, giọng đọc
bắt đầu sau `head` giây của cảnh. Engine chỉ cần đưa thời điểm bắt đầu các cảnh và kiểu chuyển cảnh, track âm thanh
giống hệt nhau dù hình được dựng bằng moviepy/Pillow hay ManimGL.
"""
import subprocess
import wave
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import numpy as np

from ..ffmpeg import ffmpeg_exe
from . import sfx

AUDIO_RATE = 44100
EDGE_FADE = 0.008  # làm mềm đầu/cuối mỗi đoạn âm thanh để không có tiếng "bụp"
FADE_OUT = 0.6  # mờ dần cuối video (hình và tiếng)
MUSIC_FADE_IN, MUSIC_FADE_OUT = 1.0, 2.0
# Âm thanh của người dùng gắn vào câu thoại: dài tối đa chừng này, đỉnh chuẩn hóa về SOUND_PEAK rồi nhân ASSET_SOUND_GAIN
MAX_SOUND_SECONDS, SOUND_PEAK, ASSET_SOUND_GAIN, SOUND_FADE_OUT = 10.0, 0.9, 0.35, 0.25
WHOOSH_GAIN, POP_GAIN = 0.16, 0.11  # âm lượng hiệu ứng âm thanh so với giọng đọc
TRANSITION_ASSET_GAIN = 0.6  # tiếng chuyển cảnh lấy từ thư viện lặp lại ở mọi cảnh: nhỏ hơn tiếng gắn vào câu thoại


@dataclass
class SceneAudio:
    """Âm thanh của một cảnh trên timeline. Thời điểm tính theo giây trong cảnh (đã cộng khoảng lặng đầu cảnh)."""
    speech: np.ndarray | None = None  # giọng đọc đã giải mã (decode_audio), None: cảnh không có lời
    pops: list[float] = field(default_factory=list)  # tiếng "tách" khi nhãn xuất hiện (chỉ khi bật hiệu ứng âm thanh)
    # (giây, tên âm thanh trong sfx.named | file âm thanh của người dùng): tiếng theo câu thoại, luôn phát
    sounds: list[tuple[float, str | Path]] = field(default_factory=list)
    # Tiếng phát khi chuyển vào cảnh này (tên trong sfx.named | file âm thanh); None: theo style (tiếng "vút" mặc định)
    enter_sound: str | Path | None = None


def decode_audio(path: Path) -> np.ndarray:
    """Giải mã toàn bộ file âm thanh bằng ffmpeg thành mảng float32 (số mẫu, 2 kênh) ở AUDIO_RATE.

    Không dùng AudioFileClip của moviepy 1.x: nó đọc lố cuối file mp3 và trả về dữ liệu rác trong bộ đệm,
    gây tiếng "bụp"/âm thanh bị cắt ở cuối mỗi đoạn giọng đọc.
    """
    raw = subprocess.run(
        [ffmpeg_exe(), "-v", "error", "-i", str(path), "-vn", "-ac", "2", "-ar", str(AUDIO_RATE), "-f", "f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).copy()


@lru_cache(maxsize=32)
def asset_sound(path: Path) -> tuple[np.ndarray, float] | None:
    """(mẫu âm thanh, âm lượng) của một file trong thư viện, dùng như hiệu ứng: cắt gọn, chuẩn hóa đỉnh để các file to nhỏ
    khác nhau nghe đều tay so với giọng đọc. File hỏng không được làm hỏng cả video."""
    try:
        samples = decode_audio(path)[: int(MAX_SOUND_SECONDS * AUDIO_RATE)]
    except Exception as e:  # noqa: BLE001
        print(f"      Bỏ qua âm thanh {path.name}: {type(e).__name__}", flush=True)
        return None
    peak = float(np.abs(samples).max()) if len(samples) else 0.0
    if peak < 1e-4:
        return None
    return fade(samples / peak * SOUND_PEAK, 0.0, SOUND_FADE_OUT), ASSET_SOUND_GAIN


def transition_effect(ref: str | Path | None, start: float, transition: float, index: int,
                      kind: str) -> tuple[float, np.ndarray, float] | None:
    """(thời điểm, mẫu, âm lượng) của tiếng chuyển cảnh: tiếng "vút" nằm giữa đoạn chuyển và dài theo nó, tiếng khác
    (tổng hợp) phát ngay giữa đoạn chuyển, file thư viện phát từ lúc bắt đầu chuyển."""
    if ref == "whoosh":
        sound = sfx.whoosh(round(max(0.4, transition * 1.4), 2), seed=index % 3, direction=-1 if kind.endswith("right") else 1)
        return start + transition / 2 - len(sound) / AUDIO_RATE / 2, sound, WHOOSH_GAIN
    if isinstance(ref, Path):
        sound = asset_sound(ref)
        return (start, sound[0], sound[1] * TRANSITION_ASSET_GAIN) if sound else None
    named = sfx.named(ref) if ref else None
    return (max(0.0, start + transition / 2 - 0.05), named[0], named[1]) if named else None


def fade(samples: np.ndarray, fade_in: float, fade_out: float) -> np.ndarray:
    n = len(samples)
    for seconds, ramp_up in ((fade_in, True), (fade_out, False)):
        k = min(n, int(seconds * AUDIO_RATE))
        if k > 1:
            ramp = np.linspace(0.0, 1.0, k, dtype=np.float32)[:, None]
            if ramp_up:
                samples[:k] *= ramp
            else:
                samples[n - k:] *= ramp[::-1]
    return samples


def mix_at(track: np.ndarray, samples: np.ndarray, start: float) -> None:
    i = int(round(start * AUDIO_RATE))
    if not len(samples) or i >= len(track):
        return
    if i < 0:
        samples, i = samples[-i:], 0
    part = samples[: len(track) - i]
    track[i : i + len(part)] += part


def mix_track(
    speeches: list[np.ndarray | None], starts: list[float], duration: float, music_path: Path | None,
    music_volume: float, effects: list[tuple[float, np.ndarray, float]] | None = None,
) -> np.ndarray:
    """Ghép giọng đọc của các scene, hiệu ứng âm thanh và nhạc nền thành một track duy nhất, chính xác tới từng mẫu."""
    track = np.zeros((int(np.ceil(duration * AUDIO_RATE)), 2), dtype=np.float32)
    for speech, start in zip(speeches, starts):
        if speech is not None:
            mix_at(track, fade(speech.copy(), EDGE_FADE, EDGE_FADE), start)
    for start, samples, gain in effects or []:
        mix_at(track, samples * gain, start)
    if music_path:
        music = decode_audio(music_path)
        if len(music):
            reps = int(np.ceil(len(track) / len(music)))
            music = np.tile(music, (reps, 1))[: len(track)] * music_volume
            track += fade(music, MUSIC_FADE_IN, MUSIC_FADE_OUT)
    fade(track, 0.0, FADE_OUT)
    np.clip(track, -1.0, 1.0, out=track)
    return track


def timeline_effects(
    scenes: list[SceneAudio], starts: list[float], transition: float, kinds: list[str], whoosh_kinds: set[str],
    sfx_on: bool, transition_sound: str,
) -> list[tuple[float, np.ndarray, float]]:
    """Hiệu ứng âm thanh của cả video: (thời điểm, mẫu, âm lượng).

    kinds: kiểu chuyển cảnh giữa cảnh i và i+1; whoosh_kinds: các kiểu có tiếng "vút" mặc định (trượt, quét, zoom...).
    transition_sound: style.transition_sound — "default" thì tiếng "vút" theo sfx_on, còn lại theo enter_sound từng cảnh.
    """
    effects: list[tuple[float, np.ndarray, float]] = []
    if sfx_on and transition_sound == "default":
        for i, kind in enumerate(kinds):
            if kind not in whoosh_kinds:
                continue
            sound = sfx.whoosh(round(max(0.4, transition * 1.4), 2), seed=i % 3, direction=-1 if kind.endswith("right") else 1)
            effects.append((starts[i + 1] + transition / 2 - len(sound) / AUDIO_RATE / 2, sound, WHOOSH_GAIN))
    if sfx_on:
        for start, scene in zip(starts, scenes):
            effects.extend((start + p, sfx.pop(), POP_GAIN) for p in scene.pops)
    # Tiếng chuyển cảnh người dùng chọn (hoặc AI/thư viện chọn cho từng cảnh)
    for i, kind in enumerate(kinds):
        effect = transition_effect(scenes[i + 1].enter_sound, starts[i + 1], transition, i, kind)
        if effect:
            effects.append(effect)
    # Âm thanh meme do Đạo diễn AI đặt theo câu thoại: luôn phát (AI đã chủ động chọn)
    for start, scene in zip(starts, scenes):
        for t, ref in scene.sounds:
            sound = asset_sound(ref) if isinstance(ref, Path) else sfx.named(ref)
            if sound:
                effects.append((start + t, sound[0], sound[1]))
    return effects


def build_track(
    scenes: list[SceneAudio], starts: list[float], head: float, duration: float, transition: float, kinds: list[str],
    whoosh_kinds: set[str], music_path: Path | None, music_volume: float, sfx_on: bool, transition_sound: str,
) -> np.ndarray:
    """Track âm thanh cuối của video từ timeline các cảnh (starts: giây bắt đầu từng cảnh, head: khoảng lặng đầu cảnh)."""
    effects = timeline_effects(scenes, starts, transition, kinds, whoosh_kinds, sfx_on, transition_sound)
    return mix_track([s.speech for s in scenes], [s + head for s in starts], duration, music_path, music_volume, effects)


def write_wav(track: np.ndarray, path: Path) -> Path:
    """Ghi track float32 (số mẫu, 2 kênh) ra WAV 16-bit ở AUDIO_RATE."""
    pcm = (np.clip(track, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as f:
        f.setnchannels(2)
        f.setsampwidth(2)
        f.setframerate(AUDIO_RATE)
        f.writeframes(pcm.tobytes())
    return path
