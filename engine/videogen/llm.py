"""Sinh kịch bản video hướng dẫn bằng DeepSeek LLM."""
import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from openai import OpenAI

from .config import Settings, require

SYSTEM_PROMPT = """Bạn là biên tập viên viết kịch bản video hướng dẫn (how-to) ngắn, cuốn hút, chính xác.
Với chủ đề người dùng đưa ra, hãy viết kịch bản gồm lời mở đầu, các bước thực hiện theo thứ tự, và lời kết.
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
      "hashtags": ["hashtag1", "hashtag2"]{library_field}
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

LIBRARY_FIELD = ',\n      "library_image": "id ảnh trong thư viện dùng cho bước này, hoặc null"'

LIBRARY_AUTO = """
Thư viện ảnh có sẵn của người dùng (id: mô tả):
{catalog}
- Nếu một ảnh trong thư viện minh họa ĐÚNG nội dung của bước, đặt "library_image" là id của ảnh đó; nếu không, đặt null (hệ thống sẽ tự tìm ảnh trên mạng).
- Mỗi ảnh thư viện dùng tối đa một lần. Không đoán: chỉ chọn khi mô tả ảnh khớp rõ ràng.
"""

LIBRARY_SELECTED = """
Người dùng đã chọn các ảnh sau làm NỘI DUNG CHÍNH của video (id: mô tả):
{catalog}
- Xây dựng các bước xoay quanh những ảnh này: lời bình của bước phải nói về đúng nội dung ảnh được gán.
- Mỗi ảnh phải được dùng đúng một lần qua trường "library_image", theo thứ tự hợp lý nhất.
- Nếu số bước nhiều hơn số ảnh, các bước còn lại đặt "library_image": null.
"""


@dataclass
class Step:
    heading: str
    narration: str
    image_queries: list[str] = field(default_factory=list)
    image: str | None = None  # đường dẫn ảnh local tự chọn (ưu tiên hơn tìm kiếm)
    hashtags: list[str] = field(default_factory=list)
    library_image: str | None = None  # id ảnh thư viện do LLM chọn


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


@dataclass
class LibraryImage:
    """Ảnh trong thư viện mà LLM có thể chọn làm nội dung cho một bước."""
    id: str
    path: str
    description: str = ""
    tags: list[str] = field(default_factory=list)

    def catalog_line(self) -> str:
        text = re.sub(r"\s+", " ", self.description).strip()[:200] or "(không có mô tả)"
        tags = " ".join(f"#{t}" for t in self.tags if f"#{t}" not in text)
        return f"- {self.id}: {text} {tags}".rstrip()


def normalize_hashtags(values) -> list[str]:
    tags: list[str] = []
    for v in values or []:
        tag = re.sub(r"[^\w]", "", str(v).lower().lstrip("#"))
        if tag and tag not in tags:
            tags.append(tag)
    return tags


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


def _extract_json(text: str) -> dict:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError(f"Không tìm thấy JSON trong phản hồi của LLM: {text[:200]!r}")
    return json.loads(match.group(0))


def _assign_library(script: Script, library: list[LibraryImage], mode: str) -> None:
    """Bỏ id ảnh không tồn tại / dùng lặp; ở chế độ 'selected' gán nốt ảnh chưa dùng."""
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
    library: list[LibraryImage] | None = None,
    library_mode: str = "off",
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
    if library:
        template = LIBRARY_SELECTED if library_mode == "selected" else LIBRARY_AUTO
        system += template.replace("{catalog}", "\n".join(img.catalog_line() for img in library))

    if num_steps:
        steps_hint = f"đúng {num_steps} bước"
    elif library_mode == "selected" and library:
        steps_hint = f"{max(3, len(library))} bước"
    else:
        steps_hint = "từ 5 đến 8 bước"
    user_msg = f"Chủ đề: {topic}\nSố bước: {steps_hint}."

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
            script = parse_script(_extract_json(content), default_title=topic)
        except (ValueError, KeyError, TypeError) as e:
            last_error = e
            continue
        if library:
            _assign_library(script, library, library_mode)
        return script
    raise RuntimeError(f"DeepSeek trả về kịch bản không hợp lệ sau 3 lần thử: {last_error}")
