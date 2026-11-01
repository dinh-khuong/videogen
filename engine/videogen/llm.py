"""Sinh kịch bản video hướng dẫn bằng DeepSeek LLM."""
import json
import re
import unicodedata
from dataclasses import asdict, dataclass, field
from pathlib import Path

from openai import OpenAI

from .config import Settings, require

SYSTEM_PROMPT = """Bạn là biên tập viên viết kịch bản video hướng dẫn (how-to) ngắn, cuốn hút, chính xác.
Người dùng đưa ra chủ đề hoặc một yêu cầu chi tiết (có thể dài: nội dung cần nói, đối tượng người xem, giọng văn,
thông tin sản phẩm/dịch vụ...). Hãy viết kịch bản gồm lời mở đầu, các bước thực hiện theo thứ tự, và lời kết.
Làm đúng mọi yêu cầu của người dùng; giữ nguyên thông tin cụ thể họ cung cấp (tên, giá, số liệu, địa chỉ).
Chỉ trả lời bằng một đối tượng JSON hợp lệ theo đúng cấu trúc:
{
  "title": "Tiêu đề video ngắn gọn (tối đa 60 ký tự)",
  "description": "Mô tả video 1-3 câu để đăng kèm khi chia sẻ lên mạng xã hội.",
  "hashtags": ["hashtag1", "hashtag2"],
  "intro": "1-2 câu mở đầu giới thiệu video sẽ hướng dẫn gì.",
  "steps": [
    {
      "heading": "Tên bước rất ngắn (2-6 từ)",
      "narration": "Lời bình được đọc thành giọng nói cho bước này (1-3 câu, cụ thể: định lượng, thời gian, mẹo).",
      "image_queries": ["english search query 1", "alternative english query 2"],
      "hashtags": ["hashtag1", "hashtag2"]{media_field}{library_field}
    }
  ],
  "outro": "1-2 câu kết thúc, tóm tắt hoặc lời khuyên cuối."
}
Yêu cầu:
- Viết bằng {language}, giọng văn tự nhiên như người dẫn video, không đánh số trong câu.
- "image_queries": 2 cụm từ khóa TIẾNG ANH để tìm ảnh (Google Images / kho ảnh stock):
  query 1 cụ thể (3-5 từ, vd "whisking eggs in bowl"), query 2 chung hơn (1-3 từ, vd "baking kitchen").
  Mô tả cảnh/đồ vật chụp được, tránh từ trừu tượng và tên riêng địa phương.
- "hashtags": viết thường, không dấu, viết liền, không có ký tự #. Video: 4-8 hashtag; mỗi bước: 2-4 hashtag mô tả nội dung ảnh minh họa.
- Mỗi bước là một hành động rõ ràng, không lặp ý.
"""

MEDIA_FIELD = ',\n      "media": "video" hoặc "image"'
MEDIA_RULE = """- "media": mặc định "video" (clip làm video sinh động hơn) cho phần lớn các bước;
  chỉ đặt "image" khi nội dung chỉ minh họa được bằng ảnh tĩnh (chân dung người cụ thể, sơ đồ, bảng giá, tài liệu lịch sử).
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


@dataclass
class Script:
    title: str
    intro: str
    steps: list[Step]
    outro: str
    description: str = ""
    hashtags: list[str] = field(default_factory=list)

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
    """Asset (ảnh hoặc video) trong thư viện mà LLM có thể chọn làm nội dung cho một bước."""
    id: str
    path: str
    description: str = ""
    tags: list[str] = field(default_factory=list)
    kind: str = "image"  # image | video
    summary: str = ""    # tóm tắt do AI viết khi phân tích asset
    ocr_text: str = ""   # chữ đọc được trong asset
    duration: float | None = None

    def catalog_line(self, detailed: bool = False) -> str:
        if self.kind == "video":
            kind = f"video {self.duration:.0f}s" if self.duration else "video"
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


def normalize_hashtags(values) -> list[str]:
    tags: list[str] = []
    for v in values or []:
        # Hashtag viết thường, không dấu (LLM đôi khi vẫn trả về có dấu)
        tag = unicodedata.normalize("NFKD", str(v).lower().lstrip("#").replace("đ", "d"))
        tag = re.sub(r"[^\w]", "", "".join(ch for ch in tag if not unicodedata.combining(ch)))
        if tag and tag not in tags:
            tags.append(tag)
    return tags


def short_title(text: str, limit: int = 60) -> str:
    """Dòng đầu của chủ đề/prompt, cắt gọn để làm tiêu đề dự phòng hoặc in log."""
    line = next((l.strip() for l in text.splitlines() if l.strip()), "video")
    return line if len(line) <= limit else line[: limit - 1].rstrip() + "…"


def parse_script(data: dict, default_title: str) -> Script:
    steps = []
    for s in data["steps"]:
        queries = s.get("image_queries") or [s.get("image_query", "")]
        steps.append(
            Step(
                heading=(s.get("heading") or "").strip(),
                narration=s["narration"].strip(),
                image_queries=[q.strip() for q in queries if q and q.strip()],
                image=s.get("image") or None,
                hashtags=normalize_hashtags(s.get("hashtags")),
                media=s.get("media") if s.get("media") in ("video", "image") else None,
                extra_assets=[str(x) for x in s.get("extra_assets") or [] if x],
                library_image=(str(s["library_image"]).strip() or None) if s.get("library_image") else None,
            )
        )
    if not steps:
        raise ValueError("Kịch bản không có bước nào.")
    return Script(
        title=(data.get("title") or default_title).strip(),
        intro=(data.get("intro") or "").strip(),
        steps=steps,
        outro=(data.get("outro") or "").strip(),
        description=(data.get("description") or "").strip(),
        hashtags=normalize_hashtags(data.get("hashtags")),
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


def generate_script(
    topic: str,
    settings: Settings,
    num_steps: int | None = None,
    language: str = "tiếng Việt",
    library: list[LibraryAsset] | None = None,
    library_mode: str = "off",
    web_media: str = "image",
) -> Script:
    client = OpenAI(
        api_key=require("DEEPSEEK_API_KEY", settings.deepseek_api_key),
        base_url=settings.deepseek_base_url,
        max_retries=3,
        timeout=120,
    )
    library = library if library_mode in ("auto", "selected") else []
    system = SYSTEM_PROMPT.replace("{language}", language)
    system = system.replace("{library_field}", LIBRARY_FIELD if library else "")
    # Chế độ tự động: LLM quyết định bước nào dùng clip video, bước nào dùng ảnh
    system = system.replace("{media_field}", MEDIA_FIELD if web_media == "auto" else "")
    if web_media == "auto":
        system += MEDIA_RULE
    if library:
        template = LIBRARY_SELECTED if library_mode == "selected" else LIBRARY_AUTO
        if library_mode == "auto":
            library = shortlist(topic, library)
        detailed = library_mode == "selected"
        system += template.replace("{catalog}", "\n".join(a.catalog_line(detailed) for a in library))

    if num_steps:
        steps_hint = f"đúng {num_steps} bước"
    elif library_mode == "selected" and library:
        steps_hint = f"{max(3, len(library))} bước"
    else:
        steps_hint = "từ 5 đến 8 bước"
    user_msg = f"Yêu cầu của người dùng:\n{topic}\n\nSố bước: {steps_hint}."

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
        return script
    raise RuntimeError(f"DeepSeek trả về kịch bản không hợp lệ sau 3 lần thử: {last_error}")
