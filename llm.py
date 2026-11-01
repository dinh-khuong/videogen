"""Sinh kịch bản video hướng dẫn bằng DeepSeek LLM."""
import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from openai import OpenAI

from config import Settings, require

SYSTEM_PROMPT = """Bạn là biên tập viên viết kịch bản video hướng dẫn (how-to) ngắn, cuốn hút, chính xác.
Với chủ đề người dùng đưa ra, hãy viết kịch bản gồm lời mở đầu, các bước thực hiện theo thứ tự, và lời kết.
Chỉ trả lời bằng một đối tượng JSON hợp lệ theo đúng cấu trúc:
{
  "title": "Tiêu đề video ngắn gọn (tối đa 60 ký tự)",
  "intro": "1-2 câu mở đầu giới thiệu video sẽ hướng dẫn gì.",
  "steps": [
    {
      "heading": "Tên bước rất ngắn (2-6 từ)",
      "narration": "Lời bình được đọc thành giọng nói cho bước này (1-3 câu, cụ thể: định lượng, thời gian, mẹo).",
      "image_queries": ["english search query 1", "alternative english query 2"]
    }
  ],
  "outro": "1-2 câu kết thúc, tóm tắt hoặc lời khuyên cuối."
}
Yêu cầu:
- Viết bằng {language}, giọng văn tự nhiên như người dẫn video, không đánh số trong câu.
- "image_queries": 2 cụm từ khóa TIẾNG ANH để tìm trong kho ảnh stock (Pexels):
  query 1 cụ thể (3-5 từ, vd "whisking eggs in bowl"), query 2 chung hơn (1-3 từ, vd "baking kitchen").
  Mô tả cảnh/đồ vật chụp được, tránh từ trừu tượng và tên riêng địa phương.
- Mỗi bước là một hành động rõ ràng, không lặp ý.
"""


@dataclass
class Step:
    heading: str
    narration: str
    image_queries: list[str] = field(default_factory=list)
    image: str | None = None  # đường dẫn ảnh local tự chọn (ưu tiên hơn tìm kiếm)


@dataclass
class Script:
    title: str
    intro: str
    steps: list[Step]
    outro: str

    def save(self, path: Path) -> None:
        path.write_text(json.dumps(asdict(self), ensure_ascii=False, indent=2), encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> "Script":
        return _parse_script(json.loads(path.read_text(encoding="utf-8")), default_title=path.stem)


def _parse_script(data: dict, default_title: str) -> "Script":
    steps = []
    for s in data["steps"]:
        queries = s.get("image_queries") or [s.get("image_query", "")]
        steps.append(
            Step(
                heading=s.get("heading", "").strip(),
                narration=s["narration"].strip(),
                image_queries=[q.strip() for q in queries if q and q.strip()],
                image=s.get("image") or None,
            )
        )
    if not steps:
        raise ValueError("Kịch bản không có bước nào.")
    return Script(
        title=(data.get("title") or default_title).strip(),
        intro=(data.get("intro") or "").strip(),
        steps=steps,
        outro=(data.get("outro") or "").strip(),
    )


def _extract_json(text: str) -> dict:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError(f"Không tìm thấy JSON trong phản hồi của LLM: {text[:200]!r}")
    return json.loads(match.group(0))


def generate_script(
    topic: str, settings: Settings, num_steps: int | None = None, language: str = "tiếng Việt"
) -> Script:
    client = OpenAI(
        api_key=require("DEEPSEEK_API_KEY", settings.deepseek_api_key),
        base_url=settings.deepseek_base_url,
        max_retries=3,
        timeout=120,
    )
    steps_hint = f"đúng {num_steps} bước" if num_steps else "từ 5 đến 8 bước"
    user_msg = f"Chủ đề: {topic}\nSố bước: {steps_hint}."

    last_error: Exception | None = None
    for _ in range(3):
        response = client.chat.completions.create(
            model=settings.deepseek_model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT.replace("{language}", language)},
                {"role": "user", "content": user_msg},
            ],
            response_format={"type": "json_object"},
            temperature=0.7,
        )
        content = response.choices[0].message.content or ""
        try:
            return _parse_script(_extract_json(content), default_title=topic)
        except (ValueError, KeyError, TypeError) as e:
            last_error = e
    raise RuntimeError(f"DeepSeek trả về kịch bản không hợp lệ sau 3 lần thử: {last_error}")
