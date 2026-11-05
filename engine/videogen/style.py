"""Phong cách dựng video (nhịp, chuyển cảnh, phụ đề, màu...) và nhãn hiển thị theo ngôn ngữ."""
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

PACINGS = ("slow", "normal", "fast")
TRANSITIONS = ("mix", "fade", "slide", "zoom", "whip", "wipe", "circle", "flash")
SUBTITLE_STYLES = ("auto", "box", "karaoke", "outline", "none")
COLOR_FILTERS = ("none", "vivid", "warm", "cool", "cinematic", "vintage", "bw")
VIDEO_TYPES = ("howto", "listicle", "tips", "facts", "promo", "story")
DEFAULT_ACCENT = (233, 84, 32)


@dataclass(frozen=True)
class Pacing:
    head: float          # khoảng lặng trước lời bình mỗi scene (giây)
    tail: float          # khoảng lặng sau lời bình (phải >= transition để giọng không chồng nhau)
    transition: float    # thời lượng chuyển cảnh giữa các scene
    min_segment: float   # thời lượng tối thiểu của một đoạn hình (ảnh/clip) trong scene
    segment_blend: float # chuyển mềm giữa các đoạn hình trong cùng scene
    zoom: float          # biên độ Ken Burns của ảnh phủ kín khung
    clip_push: float     # zoom chậm vào clip video (1 = đứng yên)
    auto_interval: float = 0.0  # tần suất đổi hình khi người dùng để "tự động" (0 = theo số hình có sẵn)


PACING = {
    "slow": Pacing(head=0.35, tail=0.85, transition=0.7, min_segment=3.4, segment_blend=0.45, zoom=1.08, clip_push=1.03),
    "normal": Pacing(head=0.25, tail=0.6, transition=0.5, min_segment=2.2, segment_blend=0.3, zoom=1.14, clip_push=1.06),
    "fast": Pacing(head=0.15, tail=0.45, transition=0.35, min_segment=1.4, segment_blend=0.16, zoom=1.2, clip_push=1.1,
                   auto_interval=2.0),
}


def parse_color(value: str | tuple | None) -> tuple[int, int, int]:
    if isinstance(value, tuple) and len(value) == 3:
        return tuple(int(c) for c in value)  # type: ignore[return-value]
    if isinstance(value, str) and re.fullmatch(r"#?[0-9a-fA-F]{6}", value.strip()):
        v = value.strip().lstrip("#")
        return int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)
    return DEFAULT_ACCENT


def text_color_on(rgb: tuple[int, int, int]) -> tuple[int, int, int]:
    """Chữ trắng hay đen dễ đọc hơn trên nền màu rgb (theo độ sáng cảm nhận)."""
    r, g, b = rgb
    return (20, 20, 22) if 0.299 * r + 0.587 * g + 0.114 * b > 170 else (255, 255, 255)


@dataclass
class Style:
    pacing: str = "normal"
    transition: str = "mix"         # mix: luân phiên nhiều kiểu chuyển cảnh
    subtitle_style: str = "auto"    # auto: karaoke cho video dọc/vuông, khung chữ cho video ngang
    color_filter: str = "none"
    accent: tuple[int, int, int] = DEFAULT_ACCENT  # màu nhãn bước, thanh tiến độ, chữ đang đọc
    progress_bar: bool = False
    sfx: bool = False               # tiếng "vút" khi chuyển cảnh, tiếng "tách" khi hiện nhãn
    logo: Path | None = None        # ảnh logo ở góc trên phải
    cta: str = ""                   # lời kêu gọi hiện nổi bật ở cuối video

    def __post_init__(self) -> None:
        for name, allowed in (
            ("pacing", PACINGS), ("transition", TRANSITIONS),
            ("subtitle_style", SUBTITLE_STYLES), ("color_filter", COLOR_FILTERS),
        ):
            if getattr(self, name) not in allowed:
                raise ValueError(f"{name} không hợp lệ: {getattr(self, name)} (chọn: {', '.join(allowed)})")
        self.accent = parse_color(self.accent)
        self.cta = " ".join((self.cta or "").split())[:120]

    @property
    def timing(self) -> Pacing:
        return PACING[self.pacing]

    def subtitles_for(self, size: tuple[int, int]) -> str:
        if self.subtitle_style != "auto":
            return self.subtitle_style
        w, h = size
        return "box" if w > h * 1.2 else "karaoke"


# ===== Ngôn ngữ: mã cho font/gTTS + nhãn hiện trong video =====

@dataclass(frozen=True)
class Language:
    code: str            # mã ISO (gTTS, chọn font)
    step: str            # nhãn bước, {n} = số thứ tự
    item: str            # nhãn mục trong danh sách/mẹo/sự thật
    done: str            # nhãn cảnh cuối
    taglines: dict       # dòng phụ dưới tiêu đề theo loại video ({count} = số mục)
    names: tuple = ()    # các tên gọi (người dùng có thể gõ tên ngôn ngữ bất kỳ)


LANGUAGES = [
    Language("vi", "Bước {n}", "#{n}", "Hoàn thành",
             {"howto": "Hướng dẫn từng bước", "listicle": "Top {count}", "tips": "{count} mẹo hay",
              "facts": "Có thể bạn chưa biết", "promo": "", "story": ""},
             ("tiếng việt", "tieng viet", "vietnamese", "vi")),
    Language("en", "Step {n}", "#{n}", "Done!",
             {"howto": "Step-by-step guide", "listicle": "Top {count}", "tips": "{count} quick tips",
              "facts": "Did you know?", "promo": "", "story": ""},
             ("english", "tiếng anh", "en")),
    Language("zh", "第{n}步", "#{n}", "完成",
             {"howto": "分步教程", "listicle": "Top {count}", "tips": "{count}个小技巧",
              "facts": "你知道吗？", "promo": "", "story": ""},
             ("中文", "chinese", "tiếng trung", "zh")),
    Language("ja", "ステップ{n}", "#{n}", "完成！",
             {"howto": "ステップ解説", "listicle": "トップ{count}", "tips": "{count}つのコツ",
              "facts": "知ってた？", "promo": "", "story": ""},
             ("日本語", "japanese", "tiếng nhật", "ja")),
    Language("ko", "{n}단계", "#{n}", "완료!",
             {"howto": "단계별 가이드", "listicle": "TOP {count}", "tips": "꿀팁 {count}가지",
              "facts": "알고 계셨나요?", "promo": "", "story": ""},
             ("한국어", "korean", "tiếng hàn", "ko")),
    Language("fr", "Étape {n}", "#{n}", "Terminé !",
             {"howto": "Guide étape par étape", "listicle": "Top {count}", "tips": "{count} astuces",
              "facts": "Le saviez-vous ?", "promo": "", "story": ""},
             ("français", "francais", "french", "tiếng pháp", "fr")),
    Language("es", "Paso {n}", "#{n}", "¡Listo!",
             {"howto": "Guía paso a paso", "listicle": "Top {count}", "tips": "{count} trucos",
              "facts": "¿Sabías que…?", "promo": "", "story": ""},
             ("español", "espanol", "spanish", "tiếng tây ban nha", "es")),
    Language("de", "Schritt {n}", "#{n}", "Fertig!",
             {"howto": "Schritt-für-Schritt-Anleitung", "listicle": "Top {count}", "tips": "{count} Tipps",
              "facts": "Wusstest du?", "promo": "", "story": ""},
             ("deutsch", "german", "tiếng đức", "de")),
    Language("th", "ขั้นตอนที่ {n}", "#{n}", "เสร็จแล้ว!",
             {"howto": "สอนทีละขั้นตอน", "listicle": "Top {count}", "tips": "{count} เคล็ดลับ",
              "facts": "รู้หรือไม่?", "promo": "", "story": ""},
             ("ไทย", "thai", "tiếng thái", "th")),
    Language("id", "Langkah {n}", "#{n}", "Selesai!",
             {"howto": "Panduan langkah demi langkah", "listicle": "Top {count}", "tips": "{count} tips jitu",
              "facts": "Tahukah kamu?", "promo": "", "story": ""},
             ("bahasa indonesia", "indonesian", "tiếng indonesia", "id")),
]

# Ngôn ngữ cần font riêng (chữ không phải Latin)
NON_LATIN = {"zh", "ja", "ko", "th"}


def _plain(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).strip().lower()
    return re.sub(r"\s+", " ", text)


def language_for(name: str | None) -> Language:
    """Tìm ngôn ngữ theo tên người dùng nhập; không biết thì dùng nhãn tiếng Anh (trừ khi trống: tiếng Việt)."""
    plain = _plain(name or "")
    if not plain:
        return LANGUAGES[0]
    for lang in LANGUAGES:
        if plain in lang.names or any(n in plain for n in lang.names if len(n) > 3):
            return lang
    return LANGUAGES[1]


def step_label(lang: Language, video_type: str, n: int) -> str:
    template = lang.step if video_type == "howto" else lang.item if video_type in ("listicle", "tips", "facts") else ""
    return template.format(n=n)


def tagline(lang: Language, video_type: str, count: int) -> str:
    return lang.taglines.get(video_type, "").format(count=count)
