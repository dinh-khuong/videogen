"""Dàn giọng của video: số người nói, chuyển giọng theo cảnh hay theo nhân vật, giọng đều hay biến hóa, tiếng chuyển cảnh.

Không có dàn giọng (job cũ, hoặc người dùng để "Tự động"): giữ cách cũ — giọng chính, giọng thứ hai (nếu chọn) đọc xen kẽ
các bước, câu thoại "voice": "second" đọc bằng giọng phụ (tự chọn giọng khác giới khi chưa có).
"""
from dataclasses import dataclass, field
from pathlib import Path

# Tên giọng trong câu thoại ("voice") theo thứ tự người nói: main = giọng chính / nhân vật 1
SPEAKERS = ("main", "second", "third", "fourth")
MAX_SPEAKERS = len(SPEAKERS)
# scene: mỗi cảnh một người đọc, xoay vòng | character: mỗi câu thoại do nhân vật được gán đọc
SWITCHES = ("scene", "character")

# Tiếng khi chuyển cảnh: default = như cũ (theo style.sfx: tiếng "vút" ở các kiểu chuyển trượt/quét) | off | tên tiếng
# tổng hợp (sfx.named) | asset (một file trong Assets cho mọi lần chuyển) | auto (AI/thư viện chọn cho từng cảnh)
TRANSITION_NAMES = ("whoosh", "pop", "ding", "boom", "scratch", "bonk")
TRANSITION_SOUNDS = ("default", "off", *TRANSITION_NAMES, "asset", "auto")
# Từ khóa nhận ra âm thanh trong thư viện dùng được làm tiếng chuyển cảnh (chế độ auto)
TRANSITION_KEYWORDS = ("whoosh", "swoosh", "swish", "swipe", "woosh", "transition", "chuyển cảnh", "vút", "vụt", "lướt", "riser")


@dataclass
class CastVoice:
    voice: str
    rate: str | None = None   # None = theo tốc độ chung
    pitch: str | None = None  # None = theo cao độ chung
    name: str = ""            # tên nhân vật/vai (tùy chọn) để AI xưng hô


@dataclass
class VoiceCast:
    count: int = 1
    switch: str = "character"
    main_name: str = ""
    extra: list[CastVoice] = field(default_factory=list)  # giọng 2..count

    @property
    def speakers(self) -> tuple[str, ...]:
        return SPEAKERS[: self.count]

    @property
    def by_character(self) -> bool:
        return self.count > 1 and self.switch == "character"

    @property
    def names(self) -> list[str]:
        return [self.main_name, *(v.name for v in self.extra)]


def _clean_name(value) -> str:
    return " ".join(str(value or "").split())[:30]


def parse_cast(value, check_voice=None) -> VoiceCast | None:
    """Dàn giọng trong spec job: {"count", "switch", "main_name", "voices": [{"voice", "rate", "pitch", "name"}]}.
    None = tự động (cách cũ). check_voice(rate, pitch) báo lỗi khi tốc độ/cao độ sai định dạng."""
    if not isinstance(value, dict):
        return None
    count = min(max(int(value.get("count") or 1), 1), MAX_SPEAKERS)
    switch = value.get("switch") or "character"
    if switch not in SWITCHES:
        raise ValueError(f"voice_cast.switch không hợp lệ: {switch}")
    extra = []
    for item in (value.get("voices") or [])[: count - 1]:
        if not isinstance(item, dict) or not item.get("voice"):
            raise ValueError("voice_cast.voices: mỗi giọng cần 'voice'")
        voice = CastVoice(str(item["voice"]), item.get("rate") or None, item.get("pitch") or None, _clean_name(item.get("name")))
        if check_voice:
            check_voice(voice.rate, voice.pitch)
        extra.append(voice)
    if len(extra) != count - 1:
        raise ValueError(f"voice_cast: cần {count - 1} giọng thêm cho {count} người nói")
    return VoiceCast(count=count, switch=switch, main_name=_clean_name(value.get("main_name")), extra=extra)


def speaker_of(line: dict, count: int = MAX_SPEAKERS) -> int:
    """Người nói của một câu thoại (0 = giọng chính); giọng ngoài dàn giọng thì về giọng chính."""
    voice = line.get("voice")
    index = SPEAKERS.index(voice) if voice in SPEAKERS else 0
    return index if index < count else 0


def cast_note(voices: list[str], names: list[str] | None = None, tags: bool = True) -> str:
    """Câu cho AI biết mỗi nhân vật do giọng nào đọc (để đặt tên, xưng hô hợp giọng). tags: kèm giá trị "voice" của từng
    nhân vật (không kèm khi hệ thống tự gán giọng theo cảnh)."""
    names = names or []
    parts = []
    for i, voice in enumerate(voices):
        name = names[i] if i < len(names) and names[i] else ""
        tag = f" (\"voice\": \"{SPEAKERS[i]}\")" if tags else ""
        parts.append(f"{'nhân vật' if tags else 'người'} {i + 1}" + (f" tên {name}" if name else "") + f"{tag} do giọng {voice} đọc")
    return ("Dàn giọng: " + "; ".join(parts) + ". Đoán giới tính theo tên giọng; không chắc thì xưng hô trung tính"
            + ("; dùng đúng tên nhân vật người dùng đặt." if any(names) else "."))


def voice_rule(cast: VoiceCast, voices: list[str]) -> str:
    """Luật về giọng cho AI viết kịch bản (cả Kịch bản nhanh và Đạo diễn AI)."""
    if cast.count == 1:
        return ("CHỈ MỘT GIỌNG ĐỌC cả video: không có nhân vật 2 hay giọng phụ chen ngang, không dùng \"voice\". "
                "Đối đáp/phản ứng (nếu cần) viết thành lời của chính người dẫn.")
    if cast.switch == "scene":
        return (f"{cast.count} NGƯỜI DẪN THAY PHIÊN THEO CẢNH: cảnh 1 do người 1 đọc, cảnh 2 người 2... xoay vòng; hệ thống tự gán giọng "
                "nên KHÔNG dùng \"voice\". Mỗi cảnh viết như lời của một người dẫn tiếp nối người trước (có thể gọi tên, "
                "\"tiếp lời\" tự nhiên). " + cast_note(voices, cast.names, tags=False))
    return (f"{cast.count} NHÂN VẬT, CHUYỂN GIỌNG THEO LỜI THOẠI: mỗi câu thoại gán \"voice\" là nhân vật nói câu đó "
            f"({', '.join(cast.speakers)}). Cả {cast.count} nhân vật đều phải nói, đối đáp tự nhiên (hỏi → đáp → phản ứng), "
            "mỗi nhân vật giữ đúng một tính cách suốt video. " + cast_note(voices, cast.names))


def is_transition_sound(text: str) -> bool:
    text = text.lower()
    return any(k in text for k in TRANSITION_KEYWORDS)


def resolve_transition(ref: str | None, files: dict[str, Path]) -> str | Path | None:
    """Tiếng chuyển cảnh trong kịch bản (tên tiếng tổng hợp hoặc id âm thanh thư viện) -> thứ video_builder phát được."""
    if not ref:
        return None
    if ref in TRANSITION_NAMES:
        return ref
    return files.get(ref)
