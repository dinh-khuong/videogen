"""Sinh kịch bản video hướng dẫn bằng DeepSeek LLM."""
import json
import re
import unicodedata
from dataclasses import asdict, dataclass, field
from pathlib import Path

from openai import OpenAI

from .config import Settings, require

SYSTEM_PROMPT = """Bạn là biên tập viên viết kịch bản {role} ngắn, cuốn hút, chính xác.
Người dùng đưa ra chủ đề hoặc một yêu cầu chi tiết (có thể dài: nội dung cần nói, đối tượng người xem, giọng văn,
thông tin sản phẩm/dịch vụ...). Hãy viết kịch bản gồm lời mở đầu, {parts}, và lời kết.
Làm đúng mọi yêu cầu của người dùng; giữ nguyên thông tin cụ thể họ cung cấp (tên, giá, số liệu, địa chỉ).
Chỉ trả lời bằng một đối tượng JSON hợp lệ theo đúng cấu trúc ("steps" là danh sách {parts}):
{
  "title": "Tiêu đề video ngắn gọn, gây tò mò (tối đa 60 ký tự), do bạn tự đặt: KHÔNG chép lại nguyên văn yêu cầu/chủ đề",
  "description": "Mô tả video 1-3 câu để đăng kèm khi chia sẻ lên mạng xã hội (không chèn hashtag vào đây).",
  "hashtags": ["hashtag1", "hashtag2", "hashtag3", "hashtag4", "hashtag5", "hashtag6"],
  "intro_lines": [{"text": "Câu thoại mở đầu", "mood": "curious"{voice_example}}],
  "steps": [
    {
      "heading": "{heading}",
      "lines": [
        {"text": "Câu thoại thứ nhất của phần này", "mood": "neutral"{voice_example}},
        {"text": "Câu thoại tiếp theo", "mood": "emphatic"}
      ],
      "image_queries": ["specific english query", "alternative english query", "general english query"],
      "hashtags": ["hashtag1", "hashtag2"]{media_field}{library_field}
    }
  ],
  "outro_lines": [{"text": "Câu thoại kết", "mood": "warm"}]{voice_field}
}
Yêu cầu:
- Viết bằng {language}, giọng văn tự nhiên như người thật đang nói, không đánh số trong câu.{tone}
- "intro_lines": lời mở đầu ({intro}). "lines" của mỗi phần: lời bình được đọc thành giọng nói ({narration}), chia thành
  từng câu thoại theo thứ tự đọc. "outro_lines": 1-2 câu kết thúc, tóm tắt hoặc lời khuyên cuối.
- "mood" của mỗi câu thoại là cảm xúc khi đọc câu đó (giọng đọc đổi tốc độ, cao độ, khoảng ngừng theo mood), chọn một trong:
  {moods}.{voice_line}
- Câu mở đầu phải "móc" được người xem ngay trong 3 giây đầu (câu hỏi, con số bất ngờ, lợi ích rõ ràng).
- "image_queries": 3 cụm từ khóa TIẾNG ANH để tìm ảnh/clip (kho ảnh, video stock):
  query 1 cụ thể (3-5 từ, vd "whisking eggs in bowl"), query 2 cách diễn đạt khác, query 3 chung hơn (1-3 từ, vd "baking kitchen").
  Mô tả cảnh/đồ vật quay chụp được, ưu tiên cảnh có chuyển động; tránh từ trừu tượng và tên riêng địa phương.
- "hashtags": hashtag để đăng mạng xã hội, KHÔNG phải từ khóa tìm ảnh (từ khóa tìm ảnh chỉ đặt ở "image_queries").
  Viết thường, không dấu, viết liền, không có ký tự #. Video: 6-10 hashtag gồm chủ đề, nội dung chính, đối tượng xem và 1-2 hashtag
  thịnh hành của ngành; mỗi phần: 3-4 hashtag mô tả nội dung ảnh minh họa của phần đó.
{rule}
{writing_rule}
{expressive_rule}
"""

VOICE_LINE = """
- "voice" của câu thoại: "main" (nhân vật 1) hoặc "second" (nhân vật 2). {cast}"""

VIDEO_TYPES = {
    "howto": dict(
        role="video hướng dẫn (how-to)", parts="các bước thực hiện theo thứ tự",
        intro="1-2 câu mở đầu giới thiệu video sẽ hướng dẫn gì.", heading="Tên bước rất ngắn (2-6 từ)",
        rule="- Mỗi bước là một hành động rõ ràng, cụ thể (định lượng, thời gian, mẹo), không lặp ý.",
    ),
    "listicle": dict(
        role="video top danh sách (vd \"Top 5 ...\")", parts="các mục trong danh sách",
        intro="1-2 câu mở đầu gây tò mò, nói video điểm qua bao nhiêu mục.", heading="Tên mục ngắn (2-6 từ)",
        rule="- Mỗi mục là một lựa chọn riêng biệt (địa điểm, sản phẩm, món...), nêu lý do nổi bật; xếp mục ấn tượng nhất ở cuối.",
    ),
    "tips": dict(
        role="video mẹo hay", parts="các mẹo",
        intro="1 câu hook nêu lợi ích người xem nhận được.", heading="Tên mẹo ngắn (2-6 từ)",
        rule="- Mỗi mẹo thực tế, làm được ngay, có ví dụ cụ thể; không lặp ý.",
    ),
    "facts": dict(
        role="video sự thật thú vị / kiến thức", parts="các sự thật thú vị",
        intro="1 câu hook gây tò mò mạnh.", heading="Tóm tắt sự thật (2-6 từ)",
        rule="- Mỗi sự thật phải chính xác và đáng ngạc nhiên; không bịa số liệu, không chắc chắn thì không nêu.",
    ),
    "promo": dict(
        role="video giới thiệu / quảng cáo sản phẩm, dịch vụ", parts="các điểm nổi bật (lợi ích, tính năng, ưu đãi)",
        intro="1-2 câu hook nêu vấn đề của khách hàng hoặc lợi ích nổi bật nhất.", heading="Điểm nổi bật ngắn (2-5 từ)",
        rule="- Tập trung vào lợi ích cho khách hàng, giữ đúng tên, giá, ưu đãi người dùng đưa ra;"
             " lời kết kêu gọi hành động rõ ràng (mua, gọi, ghé thăm, nhắn tin).",
    ),
    "story": dict(
        role="video kể chuyện", parts="các đoạn của câu chuyện theo diễn biến",
        intro="1-2 câu dẫn dắt vào câu chuyện.", heading="Tên đoạn ngắn (2-5 từ)",
        rule="- Câu chuyện có mở đầu, cao trào và kết thúc; lời bình giàu hình ảnh, cảm xúc.",
    ),
}

# Độ dài video: (số phần mặc định, độ dài lời bình mỗi phần)
LENGTHS = {
    "short": ("3 đến 4", "1-2 câu ngắn, súc tích; cả video dưới 45 giây"),
    "medium": ("từ 5 đến 8", "1-3 câu, cụ thể"),
    "long": ("từ 8 đến 12", "2-4 câu, giàu thông tin"),
}

MEDIA_FIELD = ',\n      "media": "video" hoặc "image"'
MEDIA_RULE = """- "media": đặt "video" cho gần như mọi phần (clip quay thật làm video sinh động hơn nhiều so với ảnh tĩnh);
  chỉ đặt "image" khi nội dung CHỈ minh họa được bằng ảnh tĩnh (chân dung người cụ thể, sơ đồ, bảng giá, tài liệu lịch sử).
  "image_queries" dùng để tìm cả ảnh lẫn clip: mô tả cảnh có chuyển động quay được (vd "pouring milk into coffee").
"""

LIBRARY_FIELD = ',\n      "library_image": "id asset (ảnh/video) trong thư viện dùng cho bước này, hoặc null"'

LIBRARY_AUTO = """
Thư viện asset (ảnh/video) của người dùng. Mỗi dòng: id [loại]: mô tả | tóm tắt của AI | chữ đọc được trong asset.
{catalog}
- Bạn tự do chọn asset cho từng bước: nếu một asset minh họa ĐÚNG nội dung của bước, đặt "library_image" là id của nó;
  nếu không, đặt null (hệ thống sẽ tự tìm ảnh trên mạng).
- Ưu tiên asset có chữ/thông tin khớp với bước (tên món, giá, thông số...). Có thể dùng thông tin đó trong lời bình, không bịa thêm.
- Ưu tiên asset video khi khớp nội dung (video sinh động hơn ảnh). Mỗi asset dùng tối đa một lần.
  Không đoán: chỉ chọn khi thông tin asset khớp rõ ràng.
"""

LIBRARY_SELECTED = """
Người dùng đã chọn các asset (ảnh/video) sau làm NỘI DUNG CHÍNH của video.
Mỗi dòng: id [loại]: mô tả | tóm tắt của AI | chữ đọc được trong asset.
{catalog}
- Xây dựng các bước xoay quanh những asset này: lời bình của bước phải nói về đúng nội dung asset được gán,
  tận dụng chữ/thông tin đọc được trong asset (tên, giá, số liệu...) và không bịa thêm chi tiết.
- Mỗi asset phải được dùng đúng một lần qua trường "library_image", theo đúng thứ tự được liệt kê.
- Nếu số bước nhiều hơn số asset, các bước còn lại đặt "library_image": null.
"""

AUTO_LIBRARY_LIMIT = 80  # số asset tối đa đưa vào prompt ở chế độ AI tự chọn

VOICE_FIELD = ',\n  "voice_tuning": {"pitch": 0, "rate": 0, "reason": "vì sao chỉnh (1 câu)"}'
VOICE_RULE = """- "voice_tuning": bạn được quyền tinh chỉnh giọng đọc cho hợp với video. Giọng người dùng đang chọn: {voice}.
  "pitch" (số nguyên Hz, -{pitch_limit}..{pitch_limit}) và "rate" (số nguyên %, -{rate_limit}..{rate_limit}) được CỘNG THÊM vào mức đó:
  kể chuyện ma/bí ẩn/buồn: trầm và chậm hơn (pitch âm, rate âm); quảng cáo, top viral, Gen Z: sáng và nhanh hơn;
  hướng dẫn/kiến thức: rõ ràng, chỉ chỉnh nhẹ. Giọng đã hợp thì để 0 và 0. Chỉnh vừa phải, giọng phải còn tự nhiên.
"""


@dataclass
class Step:
    heading: str
    narration: str
    image_queries: list[str] = field(default_factory=list)
    image: str | None = None  # đường dẫn ảnh local tự chọn (ưu tiên hơn tìm kiếm)
    hashtags: list[str] = field(default_factory=list)
    library_image: str | None = None  # id asset thư viện (ảnh/video) do LLM chọn
    media: str | None = None  # "video" | "image": loại nội dung nên tìm trên mạng cho bước này
    extra_assets: list[str] = field(default_factory=list)  # id asset thư viện ghép nối tiếp sau library_image
    # Câu thoại có diễn xuất (Đạo diễn AI): [{"text", "mood", "voice": "main"|"second", "sfx", "sound", "camera",
    # "sticker": {"asset": id} | {"path": ...}, "pop_text"}]. Chỉ dùng khi ghép lại đúng bằng narration.
    lines: list[dict] = field(default_factory=list)
    # Hình theo thứ tự: [{"asset": id}] hoặc [{"path", "media", "credit", "query"}] (ảnh/clip AI đã tải về)
    visuals: list[dict] = field(default_factory=list)
    meme: dict | None = None  # chữ meme phủ trên hình suốt cảnh: {"top": "...", "bottom": "..."}
    title_card: bool = False  # hiện tiêu đề video lớn ở cảnh này (thường là cảnh mở đầu)
    # Clip video (hoặc ảnh) lồng trên hình nền suốt cảnh: {"ref": {"asset": id} | {"path", "media"}, "position": góc}
    overlay: dict | None = None
    # Chuyển động ảnh của cảnh (xem effects.ALL_MOTIONS) hoặc None: tự chọn theo cảm xúc câu thoại
    motion: str | None = None

    def acted_lines(self) -> list[dict]:
        return acted(self.lines, self.narration)


def acted(lines: list[dict], text: str) -> list[dict]:
    """Câu thoại còn khớp lời bình (người dùng sửa lời bình thì quay về đọc một mạch như thường)."""
    if not lines or " ".join(l["text"] for l in lines) != text:
        return []
    return lines


@dataclass
class Script:
    title: str
    intro: str
    steps: list[Step]
    outro: str
    description: str = ""
    hashtags: list[str] = field(default_factory=list)
    # classic: mở đầu (title card) + các bước có nhãn + lời kết
    # director: mỗi bước là một cảnh tự do do Đạo diễn AI dựng (hook, meme, nhiều giọng...), không có cảnh phụ
    format: str = "classic"
    # AI tinh chỉnh giọng chung của video: {"pitch": Hz, "rate": %, "reason"} cộng vào cài đặt người dùng
    # (xem delivery.normalize_tuning). Khi dựng, pipeline ghi thêm base_rate/base_pitch/final_rate/final_pitch.
    voice_tuning: dict | None = None
    # Câu thoại có cảm xúc của lời mở đầu / lời kết (Kịch bản nhanh), như Step.lines: chỉ dùng khi ghép lại đúng bằng intro/outro
    intro_lines: list[dict] = field(default_factory=list)
    outro_lines: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

    def save(self, path: Path) -> None:
        path.write_text(json.dumps(self.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> "Script":
        return parse_script(json.loads(path.read_text(encoding="utf-8")), default_title=path.stem)


def _oneline(text: str, limit: int) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


@dataclass
class LibraryAsset:
    """Asset (ảnh, video hoặc âm thanh ngắn) trong thư viện mà LLM có thể chọn làm nội dung cho một bước."""
    id: str
    path: str
    description: str = ""
    tags: list[str] = field(default_factory=list)
    kind: str = "image"  # image | video | audio (hiệu ứng âm thanh, chỉ Đạo diễn AI dùng)
    summary: str = ""    # tóm tắt do AI viết khi phân tích asset
    ocr_text: str = ""   # chữ đọc được trong asset
    duration: float | None = None

    def catalog_line(self, detailed: bool = False) -> str:
        if self.kind == "video":
            kind = f"video {self.duration:.0f}s" if self.duration else "video"
        elif self.kind == "audio":
            kind = f"âm thanh {self.duration:.1f}s" if self.duration else "âm thanh"
        else:
            kind = "ảnh"
        parts = []
        if self.description.strip():
            parts.append(_oneline(self.description, 200))
        if self.summary.strip():
            parts.append("AI: " + _oneline(self.summary, 300))
        if self.ocr_text.strip():
            parts.append(f'Chữ: "{_oneline(self.ocr_text, 600 if detailed else 200)}"')
        text = " | ".join(parts) or "(không có thông tin)"
        tags = " ".join(f"#{t}" for t in self.tags if f"#{t}" not in text)
        return f"- {self.id} [{kind}]: {text} {tags}".rstrip()

    def search_text(self) -> str:
        return " ".join([self.description, self.summary, self.ocr_text, *self.tags])


# Tên cũ, giữ để không làm hỏng code bên ngoài
LibraryImage = LibraryAsset


def _tokens(text: str) -> set[str]:
    text = unicodedata.normalize("NFKD", text.lower().replace("đ", "d"))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return {w for w in re.findall(r"[a-z0-9]{2,}", text)}


def shortlist(topic: str, library: list[LibraryAsset], limit: int = AUTO_LIBRARY_LIMIT) -> list[LibraryAsset]:
    """Thư viện lớn: giữ các asset có nhiều từ trùng với chủ đề nhất (giữ thứ tự gốc khi bằng điểm)."""
    if len(library) <= limit:
        return library
    words = _tokens(topic)
    scored = sorted(enumerate(library), key=lambda p: (-len(words & _tokens(p[1].search_text())), p[0]))
    keep = {i for i, _ in scored[:limit]}
    return [a for i, a in enumerate(library) if i in keep]


def pick_assets(text: str, library: list[LibraryAsset], used: dict[str, int], count: int = 1,
                exclude: tuple[str, ...] | list[str] = ()) -> list[LibraryAsset]:
    """Asset hợp nhất với đoạn chữ khi không được tìm trên mạng. Có từ trùng với `text` thì đứng trước, rồi ít bị
    dùng nhất (để các bước không lặp hình), rồi nhiều từ trùng nhất; bằng điểm thì giữ thứ tự thư viện.
    Ghi nhận lượt dùng vào `used`; không trả về asset trong `exclude` và không trùng nhau."""
    words = _tokens(text) - _HASHTAG_STOP
    ranked = []
    for i, asset in enumerate(library):
        if asset.id in exclude:
            continue
        hits = len(words & _tokens(asset.search_text()))
        ranked.append((hits == 0, used.get(asset.id, 0), -hits, i, asset))
    ranked.sort(key=lambda r: r[:4])
    picked = [r[4] for r in ranked[:max(count, 0)]]
    for asset in picked:
        used[asset.id] = used.get(asset.id, 0) + 1
    return picked


def normalize_hashtags(values) -> list[str]:
    tags: list[str] = []
    for v in values or []:
        # Hashtag viết thường, không dấu (LLM đôi khi vẫn trả về có dấu)
        tag = unicodedata.normalize("NFKD", str(v).lower().lstrip("#").replace("đ", "d"))
        tag = re.sub(r"[^\w]", "", "".join(ch for ch in tag if not unicodedata.combining(ch)))
        if tag and tag not in tags:
            tags.append(tag)
    return tags


HASHTAG_MIN = 5   # video: tối thiểu chừng này hashtag (thiếu thì bổ sung từ tiêu đề và tên các phần)
HASHTAG_MAX = 12
# Từ nối/từ chung (không dấu) không đáng làm hashtag
_HASHTAG_STOP = set(
    "va la cua cho khi nhu the nao gi cach nhung mot nhieu trong co khong duoc voi cac day nay do den tu de ve bi se da "
    "dang rat hay nen ma thi neu vi sao lam tai ra vao len xuong nhat hon cung con cai "
    "the a an of in on at to for with and or is are into from by as it its this that up down out over away near".split()
)
_VIETNAMESE = re.compile(r"[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]", re.I)


def text_hashtags(text: str, limit: int = 8) -> list[str]:
    """Hashtag rút ra từ một đoạn chữ (tiêu đề, tên phần): dùng khi AI không đưa đủ hashtag.

    Chữ tiếng Việt thì ghép cặp âm tiết liền kề ("cà phê" -> caphe, "Việt Nam" -> vietnam) vì một từ thường có 2 âm tiết;
    chữ khác lấy từng từ có nghĩa. Bỏ từ nối và từ quá ngắn.
    """
    vietnamese = bool(_VIETNAMESE.search(text))
    out: list[str] = []
    singles: list[str] = []

    def add(tag: str, into: list[str]) -> None:
        if tag and tag not in out and tag not in into:
            into.append(tag)

    for clause in re.split(r"[.,;:!?…()\n\-–—]+", text):  # cặp âm tiết không được nối qua dấu câu
        keys = [(normalize_hashtags([w]) or [""])[0] for w in re.findall(r"[^\W_]+", clause)]
        ok = [bool(k) and k not in _HASHTAG_STOP and not k.isdigit() and len(k) >= (2 if vietnamese else 3) for k in keys]
        if vietnamese:
            for i in range(len(keys) - 1):
                if ok[i] and ok[i + 1]:
                    add(keys[i] + keys[i + 1], out)
        for k, good in zip(keys, ok):
            if good and len(k) >= 4:
                add(k, singles)
    return [*out, *(t for t in singles if t not in out)][:limit]


def ensure_hashtags(tags, extra=(), texts=(), minimum: int = HASHTAG_MIN, maximum: int = HASHTAG_MAX) -> list[str]:
    """Hashtag của AI, bổ sung tới `minimum` bằng `extra` (hashtag có sẵn khác) rồi hashtag rút từ `texts`."""
    out = normalize_hashtags(tags)
    if len(out) < minimum:
        for tag in normalize_hashtags(extra):
            if tag not in out:
                out.append(tag)
    if len(out) < minimum:
        for text in texts:
            for tag in text_hashtags(text):
                if tag not in out:
                    out.append(tag)
    return out[:maximum]


def split_hashtags(text: str) -> tuple[str, list[str]]:
    """Mô tả có hashtag viết lẫn trong chữ -> (mô tả sạch, hashtag). AI đôi khi nhét hashtag vào mô tả."""
    tags = normalize_hashtags(re.findall(r"#([^\W_]+)", text or ""))
    clean = re.sub(r"[ \t]*#[^\W_]+", "", text or "")
    clean = "\n".join(" ".join(line.split()) for line in clean.splitlines())
    return re.sub(r"\n{3,}", "\n\n", clean).strip(), tags


def same_text(a: str, b: str) -> bool:
    """Hai đoạn chữ giống nhau khi bỏ dấu, hoa thường, dấu câu và khoảng trắng thừa."""
    def key(s: str) -> str:
        s = unicodedata.normalize("NFKD", (s or "").lower().replace("đ", "d"))
        return " ".join(re.findall(r"[a-z0-9]+", "".join(ch for ch in s if not unicodedata.combining(ch))))
    ka, kb = key(a), key(b)
    return bool(ka) and ka == kb


def short_title(text: str, limit: int = 60) -> str:
    """Dòng đầu của chủ đề/prompt, cắt gọn để làm tiêu đề dự phòng hoặc in log."""
    line = next((l.strip() for l in text.splitlines() if l.strip()), "video")
    return line if len(line) <= limit else line[: limit - 1].rstrip() + "…"


SFX_NAMES = ("boom", "ding", "whoosh", "pop", "scratch", "drumroll", "tada", "bonk")
CAMERA_MOVES = ("punch", "shake", "zoom_slow")
OVERLAY_POSITIONS = ("br", "bl", "tr", "tl", "center")
SCENE_MOTIONS = ("zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down", "zoom_in_left", "zoom_in_right", "still")


def normalize_overlay(value) -> dict | None:
    """{"ref": media_ref, "position": góc} — clip/ảnh lồng trên hình nền suốt cảnh."""
    if not isinstance(value, dict):
        return None
    ref = _media_ref(value.get("ref"))
    if not ref:
        return None
    position = value.get("position") if value.get("position") in OVERLAY_POSITIONS else "br"
    return {"ref": ref, "position": position}


def _media_ref(value) -> dict | None:
    if not isinstance(value, dict):
        return None
    if value.get("asset"):
        return {"asset": str(value["asset"])}
    if value.get("path"):
        ref = {"path": str(value["path"]), "media": "video" if value.get("media") == "video" else "image"}
        for key in ("credit", "query", "title"):
            if value.get(key):
                ref[key] = value[key]
        tags = normalize_hashtags(value.get("hashtags"))
        if tags:
            ref["hashtags"] = tags
        if value.get("meme"):
            ref["meme"] = True
        return ref
    return None


def normalize_line(value) -> dict | None:
    """Chuẩn hóa một câu thoại (bỏ trường lạ/không hợp lệ)."""
    from .delivery import mood_of

    if isinstance(value, str):
        value = {"text": value}
    if not isinstance(value, dict):
        return None
    text = " ".join(str(value.get("text") or "").split())
    if not text:
        return None
    line: dict = {"text": text, "mood": mood_of(value.get("mood"))}
    if value.get("voice") == "second":
        line["voice"] = "second"
    if value.get("sfx") in SFX_NAMES:
        line["sfx"] = value["sfx"]
    sound = str(value.get("sound") or "").strip()
    if sound:  # id asset âm thanh trong thư viện, phát khi bắt đầu câu
        line["sound"] = sound
    if value.get("camera") in CAMERA_MOVES:
        line["camera"] = value["camera"]
    sticker = _media_ref(value.get("sticker"))
    if sticker:
        line["sticker"] = sticker
    pop = " ".join(str(value.get("pop_text") or "").split())[:40]
    if pop:
        line["pop_text"] = pop
    return line


def parse_script(data: dict, default_title: str) -> Script:
    from .delivery import normalize_tuning

    steps = []
    for s in data["steps"]:
        queries = s.get("image_queries") or [s.get("image_query", "")]
        lines = [l for l in (normalize_line(x) for x in s.get("lines") or []) if l]
        narration = (s.get("narration") or "").strip() or " ".join(l["text"] for l in lines)
        meme = s.get("meme") if isinstance(s.get("meme"), dict) else None
        meme = {k: " ".join(str(meme.get(k) or "").split())[:80] for k in ("top", "bottom")} if meme else None
        steps.append(
            Step(
                heading=(s.get("heading") or "").strip(),
                narration=narration,
                image_queries=[q.strip() for q in queries if q and q.strip()],
                image=s.get("image") or None,
                hashtags=normalize_hashtags(s.get("hashtags")),
                media=s.get("media") if s.get("media") in ("video", "image") else None,
                extra_assets=[str(x) for x in s.get("extra_assets") or [] if x],
                library_image=(str(s["library_image"]).strip() or None) if s.get("library_image") else None,
                lines=lines,
                visuals=[r for r in (_media_ref(v) for v in s.get("visuals") or []) if r],
                meme=meme if meme and (meme["top"] or meme["bottom"]) else None,
                title_card=bool(s.get("title_card")),
                overlay=normalize_overlay(s.get("overlay")),
                motion=s.get("motion") if s.get("motion") in SCENE_MOTIONS else None,
            )
        )
    if not steps or any(not st.narration for st in steps):
        raise ValueError("Kịch bản không có bước nào." if not steps else "Có bước không có lời bình.")
    intro_lines = [l for l in (normalize_line(x) for x in data.get("intro_lines") or []) if l]
    outro_lines = [l for l in (normalize_line(x) for x in data.get("outro_lines") or []) if l]
    title = (data.get("title") or default_title).strip()
    # Hashtag viết lẫn trong mô tả được tách ra; còn thiếu thì bổ sung (tag của các phần, rồi chữ trong tiêu đề/tên phần)
    description, inline_tags = split_hashtags(data.get("description") or "")
    hashtags = ensure_hashtags(
        [*normalize_hashtags(data.get("hashtags")), *inline_tags],
        extra=[t for st in steps for t in st.hashtags],
        texts=[title, *[st.heading for st in steps]],
    )
    return Script(
        title=title,
        intro=(data.get("intro") or "").strip() or " ".join(l["text"] for l in intro_lines),
        steps=steps,
        outro=(data.get("outro") or "").strip() or " ".join(l["text"] for l in outro_lines),
        description=description,
        hashtags=hashtags,
        format="director" if data.get("format") == "director" else "classic",
        voice_tuning=normalize_tuning(data.get("voice_tuning")),
        intro_lines=intro_lines,
        outro_lines=outro_lines,
    )


def extract_json(text: str) -> dict:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError(f"Không tìm thấy JSON trong phản hồi của LLM: {text[:200]!r}")
    return json.loads(match.group(0))


def _assign_library(script: Script, library: list[LibraryAsset], mode: str) -> None:
    """Bỏ id asset không tồn tại / dùng lặp; ở chế độ 'selected' gán nốt asset chưa dùng."""
    known = {img.id for img in library}
    used: set[str] = set()
    for step in script.steps:
        if step.library_image not in known or step.library_image in used:
            step.library_image = None
        if step.library_image:
            used.add(step.library_image)
    if mode == "selected":
        leftovers = [img.id for img in library if img.id not in used]
        for step in script.steps:
            if not leftovers:
                break
            if not step.library_image:
                step.library_image = leftovers.pop(0)


def _fresh_title(client: OpenAI, settings: Settings, topic: str, script: Script, language: str) -> str | None:
    """Tiêu đề do AI đặt lại khi nó chép nguyên văn chủ đề: một lượt gọi ngắn, lỗi thì giữ tiêu đề cũ."""
    outline = "; ".join(s.heading or s.narration[:40] for s in script.steps[:12])
    try:
        response = client.chat.completions.create(
            model=settings.deepseek_model,
            messages=[{"role": "user", "content": (
                f"Chủ đề người dùng đưa: {short_title(topic, 200)}\nNội dung video: {script.intro} {outline}\n"
                f"Viết MỘT tiêu đề video bằng {language}, gây tò mò, tối đa 60 ký tự, khác hẳn cách diễn đạt của chủ đề "
                "(không chép lại chủ đề). Chỉ trả về tiêu đề, không dấu ngoặc kép."
            )}],
            temperature=0.9,
            max_tokens=80,
        )
        title = " ".join((response.choices[0].message.content or "").split()).strip("\"'“”")
    except Exception:  # tiêu đề cũ vẫn dùng được
        return None
    return title[:80] if title and not same_text(title, topic) else None


def _act_plain_text(script: Script, split) -> None:
    """AI quên chia câu thoại (chỉ viết lời bình liền một mạch): tự chia theo câu, cảm xúc theo dấu câu,
    để giọng đọc vẫn lên xuống thay vì đọc đều đều cả đoạn."""
    for step in script.steps:
        if not step.acted_lines():
            step.lines = split(step.narration)
            step.narration = " ".join(l["text"] for l in step.lines) or step.narration
    for key in ("intro", "outro"):
        if getattr(script, key) and not acted(getattr(script, f"{key}_lines"), getattr(script, key)):
            lines = split(getattr(script, key))
            setattr(script, f"{key}_lines", lines)
            setattr(script, key, " ".join(l["text"] for l in lines) or getattr(script, key))


def generate_script(
    topic: str,
    settings: Settings,
    num_steps: int | None = None,
    language: str = "tiếng Việt",
    library: list[LibraryAsset] | None = None,
    library_mode: str = "off",
    web_media: str = "image",
    video_type: str = "howto",
    tone: str = "",
    length: str = "medium",
    voice: str | None = None,
    writing: str = "auto",
    cast: str = "",
) -> Script:
    """voice: mô tả giọng người dùng đã chọn (vd "vi-VN-HoaiMyNeural, cao độ +4Hz, tốc độ +0%"). Có giá trị nghĩa là
    AI được quyền tinh chỉnh giọng (trường "voice_tuning" của kịch bản); None = giữ nguyên giọng người dùng chọn.
    writing: phong cách viết (writing.STYLES). cast: câu mô tả hai giọng đọc khi viết kiểu hai nhân vật."""
    from .delivery import MOODS, TUNE_PITCH_LIMIT, TUNE_RATE_LIMIT, sentence_lines
    from .writing import EXPRESSIVE_RULE, writing_style

    client = OpenAI(
        api_key=require("DEEPSEEK_API_KEY", settings.deepseek_api_key),
        base_url=settings.deepseek_base_url,
        max_retries=3,
        timeout=120,
    )
    library = library if library_mode in ("auto", "selected") else []
    kind = VIDEO_TYPES.get(video_type, VIDEO_TYPES["howto"])
    parts_default, narration_hint = LENGTHS.get(length, LENGTHS["medium"])
    system = SYSTEM_PROMPT.replace("{language}", language)
    for key in ("role", "parts", "intro", "heading", "rule"):
        system = system.replace("{" + key + "}", kind[key].rstrip(".") if key == "intro" else kind[key])
    system = system.replace("{narration}", narration_hint)
    style = writing_style(writing)
    tone = " ".join((tone or "").split())[:200] or (style.tone if writing != "auto" else "")
    system = system.replace("{tone}", f"\n- Giọng văn: {tone}." if tone else "")
    system = system.replace("{moods}", "; ".join(f"{k} ({m.label})" for k, m in MOODS.items()))
    system = system.replace("{voice_example}", ', "voice": "main"' if style.dialogue else "")
    system = system.replace("{voice_line}", VOICE_LINE.replace("{cast}", cast).rstrip() if style.dialogue else "")
    system = system.replace("{writing_rule}", style.classic).replace("{expressive_rule}", EXPRESSIVE_RULE)
    system = system.replace("{library_field}", LIBRARY_FIELD if library else "")
    # Chế độ tự động: LLM quyết định bước nào dùng clip video, bước nào dùng ảnh
    system = system.replace("{media_field}", MEDIA_FIELD if web_media == "auto" else "")
    system = system.replace("{voice_field}", VOICE_FIELD if voice else "")
    if web_media == "auto":
        system += MEDIA_RULE
    if voice:
        system += (VOICE_RULE.replace("{voice}", voice).replace("{pitch_limit}", str(TUNE_PITCH_LIMIT))
                   .replace("{rate_limit}", str(TUNE_RATE_LIMIT)))
    if library:
        template = LIBRARY_SELECTED if library_mode == "selected" else LIBRARY_AUTO
        if library_mode == "auto":
            library = shortlist(topic, library)
        detailed = library_mode == "selected"
        system += template.replace("{catalog}", "\n".join(a.catalog_line(detailed) for a in library))

    if num_steps:
        steps_hint = f"đúng {num_steps}"
    elif library_mode == "selected" and library:
        steps_hint = f"{max(3, len(library))}"
    else:
        steps_hint = f"{parts_default} phần"
    user_msg = f"Yêu cầu của người dùng:\n{topic}\n\nSố phần trong \"steps\": {steps_hint}."

    last_error: Exception | None = None
    for _ in range(3):
        response = client.chat.completions.create(
            model=settings.deepseek_model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_msg},
            ],
            response_format={"type": "json_object"},
            temperature=0.7,
        )
        content = response.choices[0].message.content or ""
        try:
            script = parse_script(extract_json(content), default_title=short_title(topic))
        except (ValueError, KeyError, TypeError) as e:
            last_error = e
            continue
        if library:
            _assign_library(script, library, library_mode)
        _act_plain_text(script, sentence_lines)
        if not voice:
            script.voice_tuning = None  # người dùng không cho AI chỉnh giọng
        if same_text(script.title, short_title(topic, 200)) or same_text(script.title, topic):
            script.title = _fresh_title(client, settings, topic, script, language) or script.title
        return script
    raise RuntimeError(f"DeepSeek trả về kịch bản không hợp lệ sau 3 lần thử: {last_error}")
