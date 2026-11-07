"""Giọng đọc cho cả kịch bản: chọn giọng từng người nói, tạo file giọng (cache theo nội dung), tiếng theo câu thoại và tiếng
chuyển vào từng cảnh. Dùng chung cho mọi engine dựng hình nên cùng một kịch bản cho ra cùng file âm thanh."""
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .cast import VoiceCast, is_transition_sound, resolve_transition, speaker_of
from .delivery import acted, apply_tuning, assemble, prosody
from .tts import TtsJob, provider_of, synthesize_many

Voice = tuple[str, str, str]  # (giọng, tốc độ, cao độ)


class Progress(Protocol):
    def stage(self, stage: str, message: str, fraction: float = 0.0) -> None: ...


class SoundAsset(Protocol):
    """Âm thanh trong thư viện (llm.LibraryAsset kind "audio")."""
    id: str
    path: str

    def search_text(self) -> str: ...


def short_hash(*parts: str) -> str:
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:10]


def contrast_voice(voice: str, lang_code: str) -> str:
    """Giọng phụ tương phản với giọng chính (nam <-> nữ) cho câu thoại "second" khi người dùng chưa chọn."""
    if provider_of(voice) == "gtts":
        return "gtts:vi" if voice.endswith("-male") else "gtts:vi-male"
    if lang_code == "vi":
        return "vi-VN-HoaiMyNeural" if "NamMinh" in voice else "vi-VN-NamMinhNeural"
    return "en-US-AvaMultilingualNeural" if "Andrew" in voice or "Brian" in voice else "en-US-AndrewMultilingualNeural"


def script_parts(script) -> list[tuple[str, str, list[dict]]]:
    """(khóa, lời, câu thoại diễn xuất) của mở đầu, lời kết và từng bước — khóa cũng là tiền tố tên file giọng đọc."""
    parts = [("intro", script.intro, acted(script.intro_lines, script.intro)),
             ("outro", script.outro, acted(script.outro_lines, script.outro))]
    parts += [(f"step_{i + 1:02d}", s.narration, s.acted_lines()) for i, s in enumerate(script.steps)]
    return parts


def prepare_audio(
    script, work_dir: Path, voices: list[Voice], reporter: Progress, fallback_lang: str, effect: str = "none",
    by_scene: bool = False, steady: bool = False,
) -> dict[str, Path]:
    """Giọng đọc cho mở đầu, từng bước và lời kết.

    voices: (giọng, tốc độ, cao độ) của từng người nói, người đầu là giọng chính.
    by_scene: mỗi bước một người đọc, xoay vòng theo thứ tự (mở đầu/lời kết là giọng chính); không thì câu thoại đọc bằng
    giọng của nhân vật được gán ("voice": "second"...). Phần có câu thoại diễn xuất (lines): mỗi câu đọc riêng với cảm xúc
    (tốc độ/cao độ lệch quanh mức của người nói, trừ khi steady) và giọng của nó, rồi ghép thành một file cho phần đó.
    """
    audio_dir = work_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)

    def job_for(key: str, text: str, voice: str, r: str, p: str) -> TtsJob:
        # Giữ khóa cache cũ khi không đổi cao độ (render lại không phải tạo lại giọng)
        parts = (text, voice, r) if p == "+0Hz" else (text, voice, r, p)
        if effect != "none":
            parts += (effect,)
        return TtsJob(text, audio_dir / f"{key}_{short_hash(*parts)}.mp3", voice, rate=r, pitch=p)

    texts: dict[str, tuple[str, Voice]] = {}
    performed: dict[str, list[tuple[TtsJob, dict]]] = {}
    for k, (key, text, lines) in enumerate(script_parts(script)):
        own = (k - 2) % len(voices) if by_scene and k >= 2 else 0
        if lines:
            performed[key] = []
            for j, line in enumerate(lines):
                voice, base_rate, base_pitch = voices[own if by_scene else speaker_of(line, len(voices))]
                r, p = (base_rate, base_pitch) if steady else prosody(base_rate, base_pitch, line["mood"])
                performed[key].append((job_for(f"{key}_l{j + 1:02d}", line["text"], voice, r, p), line))
        else:
            texts[key] = (text, voices[own])
    jobs: dict[str, TtsJob] = {key: job_for(key, text, *speaker) for key, (text, speaker) in texts.items() if text}
    all_jobs = list(jobs.values()) + [job for lines in performed.values() for job, _ in lines]
    synthesize_many(
        all_jobs,
        voices[0][1],
        voices[0][2],
        on_progress=lambda d, t: reporter.stage("audio", f"Giọng đọc {d}/{t}", d / t),
        fallback_lang=fallback_lang,
        effect=effect,
    )
    paths = {key: job.path for key, job in jobs.items()}
    for key, lines in performed.items():
        out = audio_dir / f"{key}_{short_hash(*(str(job.path.name) for job, _ in lines))}.acted.wav"
        if not out.exists():
            assemble([(job.path, line["text"], line["mood"]) for job, line in lines], out)
        paths[key] = out
    return paths


def cast_voices(cast: VoiceCast, voice: str, rate: str, pitch: str, tuning: dict | None) -> list[Voice]:
    """(giọng, tốc độ, cao độ) của từng người nói trong dàn giọng. Giọng thêm có tốc độ/cao độ riêng thì cộng cùng phần AI
    tinh chỉnh như giọng chính; không đặt thì theo mức chung (đã tinh chỉnh)."""
    voices = [(voice, rate, pitch)]
    for extra in cast.extra:
        r, p = apply_tuning(extra.rate or "+0%", extra.pitch or "+0Hz", tuning)
        voices.append((extra.voice, r if extra.rate else rate, p if extra.pitch else pitch))
    return voices


@dataclass
class VoicePlan:
    voices: list[Voice]  # người đầu là giọng chính
    by_scene: bool       # mỗi bước một người đọc (xoay vòng) thay vì theo nhân vật của câu thoại
    label: str           # mô tả cho log


def plan_voices(script, cast: VoiceCast | None, voice: str, voice2: str | None, rate: str, pitch: str,
                lang_code: str) -> VoicePlan:
    """Ai đọc phần nào: theo dàn giọng người dùng đặt, hoặc cách cũ (giọng thứ hai đọc xen kẽ các bước, trừ khi kịch bản
    là hội thoại hay của Đạo diễn AI: câu "second" = nhân vật 2, tự chọn giọng khác giới khi chưa có)."""
    if cast:
        voices = cast_voices(cast, voice, rate, pitch, script.voice_tuning)
        by_scene = cast.count > 1 and cast.switch == "scene"
        label = f"{voice}" if cast.count == 1 else \
            f"{cast.count} giọng {'đổi theo cảnh' if by_scene else 'theo nhân vật'}: " + ", ".join(
                f"{v} {r} {p}" + (f" ({name})" if name else "") for (v, r, p), name in zip(voices, cast.names))
        return VoicePlan(voices, by_scene, label)
    director = script.format == "director"
    all_lines = [line for _, _, lines in script_parts(script) for line in lines]
    dialogue = any(line.get("voice") == "second" for line in all_lines)
    if dialogue and not voice2:
        voice2 = contrast_voice(voice, lang_code)
    voices = [(voice, rate, pitch)] + ([(voice2, rate, pitch)] if voice2 else [])
    by_scene = bool(voice2) and not director and not dialogue
    label = (f"{voice}, giọng phụ {voice2}" if director or dialogue else f"{voice} + {voice2} xen kẽ") if voice2 else voice
    return VoicePlan(voices, by_scene, label)


def library_sounds(sounds: list[SoundAsset]) -> dict[str, Path]:
    """Âm thanh thư viện mà kịch bản gắn được vào câu thoại: id -> file (thiếu file thì bỏ qua, không làm hỏng cả video)."""
    return {a.id: Path(a.path) for a in sounds if Path(a.path).exists()}


def line_sound(line: dict, start: float, sound_files: dict[str, Path]) -> tuple[float, str | Path] | None:
    """Tiếng phát khi bắt đầu một câu thoại (start: giây trong file giọng của cảnh): tiếng thật trong thư viện thay cho
    sfx tổng hợp."""
    if line.get("sound") in sound_files:
        return max(0.0, start - 0.05), sound_files[line["sound"]]
    if line.get("sfx"):
        return max(0.0, start - 0.05), line["sfx"]
    return None


def transition_sounds(scene_steps: list, mode: str, fixed_file: Path | None, sounds: list[SoundAsset],
                      candidates: list[SoundAsset]) -> list[str | Path | None]:
    """Tiếng phát khi chuyển vào từng cảnh (cảnh đầu không có), khi người dùng chọn tiếng chuyển cảnh khác mặc định.

    scene_steps: bước của từng cảnh (None: cảnh mở đầu/lời kết). mode: style.transition_sound.
    auto: tiếng Đạo diễn AI đặt cho cảnh (transition_sound); cảnh không có thì lần lượt dùng các âm thanh trong thư viện trông
    như tiếng chuyển cảnh (whoosh, swoosh, "chuyển cảnh"...) trong `candidates`, thư viện không có thì tiếng "vút" tổng hợp."""
    if mode in ("default", "off"):
        return [None] * len(scene_steps)
    if mode == "asset":
        fixed: str | Path | None = fixed_file
    elif mode != "auto":
        fixed = mode
    else:
        files = {a.id: Path(a.path) for a in [*candidates, *sounds] if Path(a.path).exists()}
        pool = [files[a.id] for a in candidates if a.id in files and is_transition_sound(a.search_text())]
        out: list[str | Path | None] = [None]
        for i, step in enumerate(scene_steps[1:]):
            chosen = resolve_transition(step.transition_sound if step else None, files)
            out.append(chosen or (pool[i % len(pool)] if pool else "whoosh"))
        return out
    return [None, *([fixed] * (len(scene_steps) - 1))]
