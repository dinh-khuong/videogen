"""Đạo diễn AI: LLM tự lên kịch bản qua nhiều lượt gọi công cụ thay vì một lần viết JSON cứng nhắc.

Vòng lặp: AI suy nghĩ → gọi công cụ (tìm asset/meme trong thư viện, tìm ảnh/clip trên mạng, thêm/sửa/xóa/đổi chỗ
cảnh, tự duyệt storyboard) → đọc kết quả → quyết định bước tiếp theo. Số lượt, số cảnh, câu nào dùng meme hay
hiệu ứng gì đều do AI quyết định; vòng lặp chỉ dừng khi AI gọi `finish` (hoặc hết lượt).

Mỗi cảnh gồm nhiều câu thoại, mỗi câu có cảm xúc riêng (hào hứng, kịch tính, cà khịa...), có thể do giọng phụ đọc
(như hai người dẫn / "nội tâm"), kèm âm thanh meme, zoom giật, sticker meme, chữ nhấn mạnh. Kết quả là một Script
dạng "director" để pipeline dựng (và có thể sửa/render lại như kịch bản thường).

Nhật ký của AI ghi ra <work_dir>/director.jsonl, storyboard mới nhất ở <work_dir>/storyboard.json.
"""
import hashlib
import json
import re
import time
import traceback
from collections import Counter
from dataclasses import asdict
from pathlib import Path
from typing import TYPE_CHECKING

from openai import OpenAI

from .config import ConfigError, Settings, require
from .delivery import MOODS, TUNE_PITCH_LIMIT, TUNE_RATE_LIMIT, apply_tuning, mood_of, normalize_tuning
from .image_search import ProviderPool, UrlRegistry, fetch_image
from .llm import (
    CAMERA_MOVES, SFX_NAMES, LibraryAsset, Script, _oneline, _tokens, normalize_hashtags, parse_script, short_title,
)
from .video_search import VideoProviderPool, fetch_videos

if TYPE_CHECKING:
    from .pipeline import Options

MAX_TURNS = 40
TARGET_SECONDS = {"short": 35, "medium": 75, "long": 130}
CHARS_PER_SECOND = 14.5  # tốc độ đọc trung bình (tiếng Việt, edge-tts tốc độ gốc)
SCENE_PAD = 0.85         # khoảng lặng đầu + cuối mỗi cảnh
SEARCH_LIMIT = 8
MEME_WORDS = ("meme", "memedataset", "reaction", "funny")

SYSTEM = """Bạn là ĐẠO DIỄN video ngắn viral (TikTok/Reels/Shorts) kiêm biên kịch, có gu hài hước và rất hiểu meme.
Bạn KHÔNG viết kịch bản một lần cho xong: bạn làm việc như một người dựng phim thật, từng bước bằng các công cụ:
tìm tư liệu (asset của người dùng, meme, clip/ảnh trên mạng) → dựng từng cảnh → tự duyệt → sửa → chốt.

Quy trình gợi ý (tự quyết định thứ tự và số bước, không bắt buộc cứng nhắc):
1. Nghĩ ý tưởng: góc nhìn bất ngờ, câu hook 3 giây đầu, mạch cảm xúc (tò mò → bất ngờ → cười → thỏa mãn).
2. Tìm tư liệu: search_assets (thư viện của người dùng, có thể có kho meme), search_web (clip/ảnh minh họa).
   Tìm nhiều lần với từ khóa khác nhau nếu kết quả chưa hợp. Ưu tiên asset của người dùng khi khớp nội dung.
3. Dựng cảnh bằng add_scene. Số cảnh do bạn quyết định theo nội dung (thường 4-12), không cần đều nhau.
4. review_storyboard để tự soi lỗi (dài/ngắn, giọng đều đều, thiếu hình, lạm dụng hiệu ứng...) rồi update_scene/
   remove_scene/move_scene cho tới khi thật sự hay. Sau đó gọi finish.

Nghệ thuật dựng:
- Mỗi cảnh = 1-4 câu thoại ("lines"). Câu ngắn, nhịp nhanh, văn nói tự nhiên như người thật đang kể, có cảm thán,
  câu hỏi tu từ, "..." để ngập ngừng, "!" để nhấn. Không đọc như văn bản, không liệt kê khô khan.
- GIỌNG ĐIỆU PHẢI BIẾN HÓA: đổi "mood" theo nội dung từng câu (hook: shocked/hype; giải thích: neutral/warm;
  plot twist: dramatic/mysterious; câu đùa: sarcastic/deadpan; liệt kê nhanh: fast). Tránh 3 câu liền cùng mood.
- "voice": "second" = giọng phụ khác giới, dùng cho câu chen ngang/phản ứng/nội tâm ("Ủa gì vậy trời?"),
  như hai người dẫn đối đáp. Dùng có chủ ý, không lạm dụng.
- MEME: dùng chỗ có "miếng" hài: chữ meme phủ hình (meme_top/meme_bottom, kiểu "KHI BẠN..." / "...VÀ CÁI KẾT"),
  sticker meme/reaction (ảnh) bật ra theo câu, chữ nhấn mạnh to (pop_text, ≤ 4 từ, vd "SAI BÉT!", "x10 LẦN").
- Âm thanh meme theo câu ("sfx"): boom (bùm khi plot twist/sốc), ding (ý hay), scratch (dừng lại khoan đã),
  drumroll (trước khi công bố), tada (kết quả), bonk (ai đó ngớ ngẩn), whoosh, pop.
  Camera theo câu ("camera"): punch (zoom giật vào khi nhấn mạnh/sốc), shake (rung khi hỗn loạn), zoom_slow (kịch tính).
  Hiệu ứng là gia vị: khoảng 1 hiệu ứng mỗi 1-2 câu là vừa, đặt đúng "miếng", không rải đều mọi câu.
- Hình: mỗi cảnh 1-3 hình (asset/clip) nối tiếp. Clip video sinh động hơn ảnh. Nếu chưa có hình phù hợp,
  đặt fallback_query (tiếng Anh) để hệ thống tự tìm. Không dùng lặp một hình cho nhiều cảnh.
- Cảnh đầu là hook: câu đầu ≤ 15 từ, gây tò mò/sốc ngay. Có thể đặt title_card cho cảnh đầu (tiêu đề hiện 3 giây).
- "heading" là nhãn nhỏ góc trên (vd "#1", "Mẹo 2", "Plot twist") — chỉ đặt khi giúp người xem theo dõi.
- Cảnh cuối: chốt hạ gọn, có thể kêu gọi follow/bình luận một cách duyên dáng.
- Giữ đúng mọi thông tin người dùng cung cấp (tên, giá, số liệu). Không bịa số liệu.

{voice_rule}Trước mỗi lượt gọi công cụ, viết 1 câu ngắn ({language}) nói bạn định làm gì và vì sao (người dùng đang xem).
Toàn bộ lời thoại viết bằng {language}."""

VOICE_RULE = """Giọng đọc: bạn ĐƯỢC QUYỀN tinh chỉnh giọng chung của cả video bằng tune_voice (cao độ, tốc độ quanh mức người dùng
chọn) cho hợp không khí video: chuyện ma/bí ẩn/buồn → trầm, chậm hơn; hài, Gen Z, quảng cáo, top viral → sáng, nhanh hơn;
hướng dẫn/kiến thức → rõ ràng, chỉnh nhẹ. Chỉnh vừa phải, giọng phải còn tự nhiên; giọng đã hợp thì không cần chỉnh.
Cảm xúc từng câu ("mood") vẫn cộng thêm sau mức chung này. Người dùng góp ý về giọng (cao/trầm/nhanh/chậm) thì sửa bằng tune_voice.

"""

MOOD_DOC = "; ".join(f"{k}: {m.label}" for k, m in MOODS.items())

LINE_SCHEMA = {
    "type": "object",
    "properties": {
        "text": {"type": "string", "description": "Câu thoại được đọc thành giọng nói (văn nói, ngắn)."},
        "mood": {"type": "string", "enum": list(MOODS), "description": f"Cảm xúc khi đọc. {MOOD_DOC}"},
        "voice": {"type": "string", "enum": ["main", "second"], "description": "main: người dẫn chính; second: giọng phụ"},
        "sfx": {"type": "string", "enum": list(SFX_NAMES), "description": "Âm thanh meme phát khi bắt đầu câu."},
        "camera": {"type": "string", "enum": list(CAMERA_MOVES), "description": "Chuyển động máy khi bắt đầu câu."},
        "sticker": {"type": "string", "description": "id ẢNH (meme/reaction) bật ra ở góc khung trong lúc đọc câu."},
        "pop_text": {"type": "string", "description": "Chữ nhấn mạnh rất ngắn hiện to giữa khung khi đọc câu."},
    },
    "required": ["text", "mood"],
}

SCENE_PROPS = {
    "heading": {"type": "string", "description": "Nhãn nhỏ góc trên (tùy chọn)."},
    "lines": {"type": "array", "items": LINE_SCHEMA, "description": "1-4 câu thoại của cảnh."},
    "visuals": {"type": "array", "items": {"type": "string"}, "description": "id asset/ảnh/clip hiển thị nối tiếp."},
    "fallback_query": {"type": "string", "description": "Từ khóa tiếng Anh để hệ thống tự tìm hình nếu visuals trống."},
    "meme_top": {"type": "string", "description": "Chữ meme phía trên hình (tùy chọn)."},
    "meme_bottom": {"type": "string", "description": "Chữ meme phía dưới hình (tùy chọn)."},
    "title_card": {"type": "boolean", "description": "Hiện tiêu đề video lớn trong 3 giây đầu cảnh."},
}


def _tool(name: str, description: str, properties: dict, required: list[str] | None = None) -> dict:
    return {"type": "function", "function": {
        "name": name, "description": description,
        "parameters": {"type": "object", "properties": properties, "required": required or []},
    }}


TOOLS = [
    _tool("search_assets", "Tìm trong thư viện asset của người dùng (ảnh/video, kể cả kho meme) theo nội dung.", {
        "query": {"type": "string", "description": "Từ khóa (tiếng Việt hoặc tiếng Anh, vd 'mèo ngạc nhiên', 'drake')."},
        "kind": {"type": "string", "enum": ["any", "image", "video"]},
        "memes_only": {"type": "boolean", "description": "Chỉ tìm trong kho meme."},
    }, ["query"]),
    _tool("inspect_asset", "Xem chi tiết một asset thư viện: mô tả đầy đủ, chữ trong ảnh, thời lượng, đã dùng ở đâu. "
                           "Ảnh/clip tải từ mạng chỉ có thông tin từ khóa tìm kiếm.", {
        "id": {"type": "string"},
    }, ["id"]),
    _tool("search_web", "Tìm và tải clip video (stock/Creative Commons) hoặc ảnh trên mạng. Trả về id để dùng trong cảnh.", {
        "query": {"type": "string", "description": "Mô tả cảnh quay bằng TIẾNG ANH, cụ thể (vd 'cat jumping off table')."},
        "media": {"type": "string", "enum": ["video", "image"]},
        "count": {"type": "integer", "description": "Số clip cần (1-3, chỉ với video)."},
    }, ["query", "media"]),
    _tool("add_scene", "Thêm một cảnh vào storyboard.", {
        **SCENE_PROPS,
        "position": {"type": "integer", "description": "Vị trí chèn (1 = đầu). Bỏ trống: thêm vào cuối."},
    }, ["lines"]),
    _tool("update_scene", "Sửa một cảnh: chỉ các trường được gửi bị thay thế (lines gửi lại là thay toàn bộ).", {
        "scene": {"type": "string", "description": "id cảnh, vd 's3'"}, **SCENE_PROPS,
    }, ["scene"]),
    _tool("remove_scene", "Xóa một cảnh.", {"scene": {"type": "string"}}, ["scene"]),
    _tool("move_scene", "Đổi vị trí một cảnh.", {
        "scene": {"type": "string"}, "position": {"type": "integer", "description": "Vị trí mới (1 = đầu)."},
    }, ["scene", "position"]),
    _tool("review_storyboard", "Xem toàn bộ storyboard hiện tại kèm nhận xét tự động (thời lượng, giọng, hình, meme...).", {}),
    _tool("tune_voice", "Tinh chỉnh giọng đọc chung của cả video: cao độ và tốc độ CỘNG THÊM vào mức người dùng đã chọn. "
                        "Gọi lại để đổi; pitch=0, rate=0 là giữ nguyên giọng người dùng chọn.", {
        "pitch": {"type": "integer", "description": f"Cao độ cộng thêm (Hz), -{TUNE_PITCH_LIMIT}..{TUNE_PITCH_LIMIT}. Âm = trầm hơn."},
        "rate": {"type": "integer", "description": f"Tốc độ cộng thêm (%), -{TUNE_RATE_LIMIT}..{TUNE_RATE_LIMIT}. Âm = chậm hơn."},
        "reason": {"type": "string", "description": "Vì sao chỉnh như vậy (1 câu, người dùng sẽ đọc)."},
    }, ["pitch", "rate", "reason"]),
    _tool("finish", "Chốt storyboard để dựng video. Chỉ gọi khi đã duyệt và hài lòng.", {
        "title": {"type": "string", "description": "Tiêu đề video gây tò mò (≤ 60 ký tự)."},
        "description": {"type": "string", "description": "Mô tả 1-3 câu để đăng mạng xã hội."},
        "hashtags": {"type": "array", "items": {"type": "string"}, "description": "4-8 hashtag viết thường không dấu."},
    }, ["title", "description", "hashtags"]),
]


def _is_meme(asset: LibraryAsset) -> bool:
    text = " ".join([asset.description, *asset.tags]).lower()
    return any(w in text for w in MEME_WORDS)


def _line_seconds(line: dict, base_rate: int = 0) -> float:
    m = MOODS[mood_of(line.get("mood"))]
    speed = max(1 + (base_rate + m.rate) / 100, 0.3)
    return len(line["text"]) / (CHARS_PER_SECOND * speed) + m.before + m.after


class Director:
    def __init__(self, topic: str, settings: Settings, opts: "Options", work_dir: Path, orientation: str) -> None:
        self.topic, self.settings, self.opts, self.work_dir, self.orientation = topic, settings, opts, work_dir, orientation
        self.library = {a.id: a for a in opts.library}
        self.memes = [a for a in opts.library if _is_meme(a)]
        self.web: dict[str, dict] = {}  # id -> {"path", "media", "credit", "query"}
        self.scenes: list[dict] = []
        self.next_scene = 1
        self.meta: dict | None = None
        self.reviewed_since_change = False
        self.reviews = 0
        self.turn = 0
        # Giọng người dùng chọn; AI có quyền tinh chỉnh (tune_voice) khi opts.ai_voice
        self.base_rate = opts.rate or settings.tts_rate or "+0%"
        self.base_pitch = opts.pitch or "+0Hz"
        self.voice_tuning: dict | None = None
        self.voice_checked = False  # AI đã cân nhắc giọng (gọi tune_voice, kể cả giữ nguyên)
        self.log_file = work_dir / "director.jsonl"
        self.log_file.unlink(missing_ok=True)
        self.registry, self.video_registry = UrlRegistry(), UrlRegistry()
        self._image_pool: ProviderPool | None = None
        self._video_pool: VideoProviderPool | None = None
        if opts.base_script:
            self._load_base(opts.base_script)

    # ===== Nhật ký cho người dùng xem =====

    def event(self, kind: str, text: str, **data) -> None:
        entry = {"t": round(time.time(), 2), "turn": self.turn, "kind": kind, "text": text, **data}
        with self.log_file.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        icon = {"thought": "💭", "action": "🛠 ", "result": "   ↳", "warn": "⚠️ "}.get(kind, "•")
        print(f"      {icon} {_oneline(text, 220)}", flush=True)
        self.opts.reporter.agent(kind, text)
        if kind in ("thought", "action"):
            self.opts.reporter.stage("director", _oneline(text, 140), min(0.95, self.turn / MAX_TURNS))

    def save_storyboard(self) -> None:
        data = {"scenes": self.scenes, "media": self.web, "meta": self.meta, "voice_tuning": self.voice_tuning}
        (self.work_dir / "storyboard.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    # ===== Tư liệu =====

    def _kind_of(self, media_id: str) -> str | None:
        if media_id in self.library:
            return self.library[media_id].kind
        if media_id in self.web:
            return self.web[media_id]["media"]
        return None

    def _describe(self, media_id: str, detailed: bool = False) -> str:
        if media_id in self.library:
            line = self.library[media_id].catalog_line(detailed)
            return line + (" [meme]" if detailed and _is_meme(self.library[media_id]) else "")
        item = self.web[media_id]
        credit = item.get("credit") or {}
        return f"- {media_id} [{'clip' if item['media'] == 'video' else 'ảnh'} trên mạng]: {item['query']} ({credit.get('source', 'web')})"

    def _usage(self, media_id: str) -> list[str]:
        used = []
        for sc in self.scenes:
            if media_id in sc["visuals"] or any(l.get("sticker") == media_id for l in sc["lines"]):
                used.append(sc["id"])
        return used

    def search_assets(self, query: str, kind: str = "any", memes_only: bool = False) -> str:
        pool = self.memes if memes_only else list(self.library.values())
        if kind in ("image", "video"):
            pool = [a for a in pool if a.kind == kind]
        if not pool:
            return ("Thư viện không có meme nào." if memes_only else "Thư viện trống hoặc không có loại này.") + \
                " Hãy dùng search_web hoặc meme_top/meme_bottom, pop_text, sfx để tạo chất meme."
        words = _tokens(query)
        scored = sorted(((len(words & _tokens(a.search_text())), i, a) for i, a in enumerate(pool)), key=lambda x: (-x[0], x[1]))
        hits = [a for score, _, a in scored if score > 0][:SEARCH_LIMIT]
        if not hits:
            return f"Không có asset khớp '{query}'. Thử từ khóa khác (đồng nghĩa, tiếng Anh) hoặc search_web."
        lines = [self._describe(a.id) + (f" (đang dùng ở {', '.join(u)})" if (u := self._usage(a.id)) else "") for a in hits]
        return f"{len(hits)} kết quả:\n" + "\n".join(lines)

    def inspect_asset(self, id: str) -> str:
        if self._kind_of(id) is None:
            return f"Không có asset/ảnh/clip id '{id}'."
        used = self._usage(id)
        return self._describe(id, detailed=True) + (f"\nĐang dùng ở: {', '.join(used)}" if used else "\nChưa dùng.")

    def search_web(self, query: str, media: str = "video", count: int = 1) -> str:
        if not self.opts.web_images:
            return "Người dùng đã tắt tìm trên mạng. Chỉ dùng asset trong thư viện (search_assets)."
        query = " ".join(query.split())[:120]
        if not query:
            return "Thiếu từ khóa."
        images_dir = self.work_dir / "images"
        images_dir.mkdir(parents=True, exist_ok=True)
        key = hashlib.sha1(f"{media}|{self.orientation}|{query}".encode()).hexdigest()[:10]
        found: list[tuple[Path, object]] = []
        note = ""
        if media == "video":
            if self._video_pool is None:
                self._video_pool = VideoProviderPool(self.settings)
            if self._video_pool.names:
                count = min(max(int(count or 1), 1), 3)
                dests = [images_dir / f"agent_{key}_{k}.mp4" for k in range(count)]
                found = fetch_videos([query], dests, self.orientation, self._video_pool, self.video_registry)
            if not found:
                # Không có nguồn video/không tìm được: thử ảnh
                media = "image"
                note = (" Không tìm được clip cho từ khóa này, đã thay bằng ảnh." if self._video_pool.enabled()
                        else " Máy này không có nguồn clip video nào dùng được: từ giờ chỉ tìm ảnh (media=image).")
        if media == "image":
            if self._image_pool is None:
                try:
                    self._image_pool = ProviderPool(self.settings, self.opts.search_engine)
                except ConfigError as e:
                    return f"Không tìm ảnh trên mạng được ({e}). Dùng asset thư viện hoặc fallback_query."
            dest = images_dir / f"agent_{key}.jpg"
            credit = fetch_image([query], dest, self.orientation, self._image_pool, self.registry)
            found = [(dest, credit)] if credit else []
        if not found:
            return f"Không tìm được gì cho '{query}'. Thử mô tả cảnh khác, cụ thể hơn hoặc chung hơn."
        ids = []
        for path, credit in found:
            media_id = f"web{len(self.web) + 1}"
            self.web[media_id] = {"path": str(path.resolve()), "media": media, "credit": asdict(credit), "query": query}
            ids.append(media_id)
        label = "clip" if media == "video" else "ảnh"
        return f"Đã tải {len(ids)} {label}: {', '.join(ids)} — '{query}'.{note} Dùng các id này trong visuals."

    # ===== Storyboard =====

    def _clean_lines(self, raw, warnings: list[str]) -> list[dict]:
        lines = []
        for item in raw or []:
            if isinstance(item, str):
                item = {"text": item}
            if not isinstance(item, dict) or not str(item.get("text") or "").strip():
                continue
            line = {"text": " ".join(str(item["text"]).split()), "mood": mood_of(item.get("mood"))}
            if item.get("mood") and item["mood"] not in MOODS:
                warnings.append(f"mood '{item['mood']}' không có, dùng neutral")
            if item.get("voice") == "second":
                line["voice"] = "second"
            if item.get("sfx") in SFX_NAMES:
                line["sfx"] = item["sfx"]
            if item.get("camera") in CAMERA_MOVES:
                line["camera"] = item["camera"]
            sticker = str(item.get("sticker") or "").strip()
            if sticker:
                kind = self._kind_of(sticker)
                if kind == "image":
                    line["sticker"] = sticker
                else:
                    warnings.append(f"sticker '{sticker}' " + ("là video, sticker phải là ảnh" if kind else "không tồn tại"))
            pop = " ".join(str(item.get("pop_text") or "").split())
            if pop:
                line["pop_text"] = pop[:40]
            if len(line["text"]) > 180:
                warnings.append(f"câu \"{line['text'][:40]}…\" quá dài, nên tách nhỏ")
            lines.append(line)
        return lines

    def _apply(self, scene: dict, args: dict, warnings: list[str]) -> None:
        if "heading" in args:
            scene["heading"] = " ".join(str(args.get("heading") or "").split())[:60]
        if "lines" in args:
            lines = self._clean_lines(args.get("lines"), warnings)
            if lines:
                scene["lines"] = lines
            else:
                warnings.append("lines trống, giữ lời thoại cũ")
        if "visuals" in args:
            visuals = []
            for v in args.get("visuals") or []:
                v = str(v).strip()
                if self._kind_of(v) is None:
                    warnings.append(f"visual '{v}' không tồn tại (bỏ qua)")
                elif v not in visuals:
                    visuals.append(v)
            scene["visuals"] = visuals[:4]
        for key in ("fallback_query", "meme_top", "meme_bottom"):
            if key in args:
                scene[key] = " ".join(str(args.get(key) or "").split())[:100]
        if "title_card" in args:
            scene["title_card"] = bool(args.get("title_card"))

    def _find(self, scene_id: str) -> int | None:
        return next((i for i, s in enumerate(self.scenes) if s["id"] == scene_id), None)

    def _scene_seconds(self, scene: dict) -> float:
        rate = int(self.voice_rate().rstrip("%"))
        return SCENE_PAD + sum(_line_seconds(l, rate) for l in scene["lines"])

    # ===== Giọng đọc =====

    def voice_rate(self) -> str:
        return apply_tuning(self.base_rate, self.base_pitch, self.voice_tuning)[0]

    def voice_summary(self) -> str:
        rate, pitch = apply_tuning(self.base_rate, self.base_pitch, self.voice_tuning)
        voice = self.opts.voice or self.settings.tts_voice
        text = f"{voice}, cao độ {pitch}, tốc độ {rate}"
        if self.opts.voice_effect and self.opts.voice_effect != "none":
            text += f", hiệu ứng {self.opts.voice_effect}"
        if self.voice_tuning:
            t = self.voice_tuning
            text += f" (người dùng chọn {self.base_pitch}, {self.base_rate}; AI chỉnh {t['pitch']:+d}Hz, {t['rate']:+d}%)"
        return text

    def tune_voice(self, pitch=0, rate=0, reason: str = "") -> str:
        if not self.opts.ai_voice:
            return "Người dùng không cho AI chỉnh giọng: giữ nguyên giọng đã chọn."
        tuning = normalize_tuning({"pitch": pitch, "rate": rate, "reason": reason})
        self.voice_checked = True
        clipped = tuning and (tuning["pitch"] != _int(pitch) or tuning["rate"] != _int(rate))
        self.voice_tuning = tuning
        self._changed()
        rate_now, pitch_now = apply_tuning(self.base_rate, self.base_pitch, tuning)
        if not tuning:
            msg = f"Giữ nguyên giọng người dùng chọn (cao độ {self.base_pitch}, tốc độ {self.base_rate})."
        else:
            msg = (f"Giọng chung của video: cao độ {self.base_pitch} → {pitch_now}, tốc độ {self.base_rate} → {rate_now}. "
                   f"Tổng ~{self.total_seconds():.0f}s / mục tiêu ~{self.target_seconds()}s.")
        if clipped:
            msg += f" (Đã giới hạn trong ±{TUNE_PITCH_LIMIT}Hz, ±{TUNE_RATE_LIMIT}%.)"
        return msg

    def _changed(self) -> None:
        self.reviewed_since_change = False
        self.save_storyboard()

    def _ack(self, scene: dict, warnings: list[str], verb: str) -> str:
        pos = self._find(scene["id"]) + 1
        msg = f"{verb} cảnh {scene['id']} (vị trí {pos}/{len(self.scenes)}, ~{self._scene_seconds(scene):.0f}s). " \
              f"Tổng ~{self.total_seconds():.0f}s / mục tiêu ~{self.target_seconds()}s."
        if not scene["visuals"] and not scene.get("fallback_query"):
            msg += " Cảnh chưa có hình: thêm visuals hoặc fallback_query."
        return msg + (" Lưu ý: " + "; ".join(warnings) + "." if warnings else "")

    def add_scene(self, position: int | None = None, **args) -> str:
        warnings: list[str] = []
        scene = {"id": f"s{self.next_scene}", "heading": "", "lines": [], "visuals": [], "title_card": False}
        self._apply(scene, args, warnings)
        if not scene["lines"]:
            return "Không thêm được: cảnh cần ít nhất một câu thoại có text."
        self.next_scene += 1
        index = len(self.scenes) if not position else min(max(int(position) - 1, 0), len(self.scenes))
        self.scenes.insert(index, scene)
        self._changed()
        return self._ack(scene, warnings, "Đã thêm")

    def update_scene(self, scene: str, **args) -> str:
        i = self._find(scene)
        if i is None:
            return f"Không có cảnh '{scene}'. Các cảnh: {', '.join(s['id'] for s in self.scenes) or '(trống)'}."
        warnings: list[str] = []
        self._apply(self.scenes[i], args, warnings)
        self._changed()
        return self._ack(self.scenes[i], warnings, "Đã sửa")

    def remove_scene(self, scene: str) -> str:
        i = self._find(scene)
        if i is None:
            return f"Không có cảnh '{scene}'."
        self.scenes.pop(i)
        self._changed()
        return f"Đã xóa {scene}. Còn {len(self.scenes)} cảnh, ~{self.total_seconds():.0f}s."

    def move_scene(self, scene: str, position: int) -> str:
        i = self._find(scene)
        if i is None:
            return f"Không có cảnh '{scene}'."
        item = self.scenes.pop(i)
        self.scenes.insert(min(max(int(position) - 1, 0), len(self.scenes)), item)
        self._changed()
        return "Thứ tự mới: " + " → ".join(s["id"] for s in self.scenes)

    def total_seconds(self) -> float:
        return sum(self._scene_seconds(s) for s in self.scenes)

    def target_seconds(self) -> int:
        return TARGET_SECONDS.get(self.opts.length, TARGET_SECONDS["medium"])

    def critique(self) -> list[str]:
        """Nhận xét tự động để AI tự sửa (không bắt buộc làm theo)."""
        notes: list[str] = []
        if not self.scenes:
            return ["Storyboard trống: hãy add_scene."]
        total, target = self.total_seconds(), self.target_seconds()
        if total > target * 1.35:
            notes.append(f"Dài ~{total:.0f}s, vượt xa mục tiêu ~{target}s: cắt cảnh/câu thừa.")
        elif total < target * 0.6:
            notes.append(f"Ngắn ~{total:.0f}s so với mục tiêu ~{target}s: thêm nội dung giá trị (không độn).")
        first = self.scenes[0]["lines"][0]["text"]
        if len(first.split()) > 18:
            notes.append(f"Câu hook dài {len(first.split())} từ: rút còn ≤ 15 từ cho 3 giây đầu.")
        moods = [l["mood"] for s in self.scenes for l in s["lines"]]
        if len(set(moods)) < 3:
            notes.append(f"Giọng đọc ít biến hóa (chỉ {', '.join(sorted(set(moods)))}): đổi mood theo cảm xúc từng câu.")
        streak = max((len(list(g)) for g in _runs(moods)), default=0)
        if streak >= 4:
            notes.append(f"Có {streak} câu liền cùng một mood: nghe đều đều.")
        for s in self.scenes:
            if not s["visuals"] and not s.get("fallback_query"):
                notes.append(f"{s['id']} không có hình (sẽ chỉ là nền chữ).")
        used = Counter(v for s in self.scenes for v in s["visuals"])
        repeated = [v for v, n in used.items() if n > 1]
        if repeated:
            notes.append(f"Hình dùng lặp ở nhiều cảnh: {', '.join(repeated)}.")
        lines = [l for s in self.scenes for l in s["lines"]]
        effects = sum(1 for l in lines if l.get("sfx") or l.get("camera") or l.get("sticker") or l.get("pop_text"))
        memes = sum(1 for s in self.scenes if s.get("meme_top") or s.get("meme_bottom")) + sum(1 for l in lines if l.get("sticker"))
        if effects == 0:
            notes.append("Chưa có hiệu ứng meme nào (sfx/camera/sticker/pop_text): video sẽ phẳng.")
        elif effects > len(lines) * 0.8:
            notes.append(f"{effects}/{len(lines)} câu có hiệu ứng: hơi lạm dụng, giữ lại những chỗ đắt nhất.")
        if memes == 0 and self.memes:
            notes.append(f"Thư viện có {len(self.memes)} meme nhưng chưa dùng cái nào (search_assets memes_only).")
        sfx = [l.get("sfx") for l in lines if l.get("sfx")]
        if sfx and Counter(sfx).most_common(1)[0][1] >= 4:
            notes.append(f"Âm '{Counter(sfx).most_common(1)[0][0]}' lặp quá nhiều lần.")
        if not any(l.get("voice") == "second" for l in lines) and len(lines) >= 6:
            notes.append("Có thể thêm vài câu giọng phụ (voice second) để đối đáp, đỡ độc thoại.")
        if self.opts.ai_voice and self.voice_tuning is None and not self.voice_checked:
            notes.append("Giọng chung chưa tinh chỉnh: nếu cao độ/tốc độ chưa hợp không khí video, dùng tune_voice.")
        return notes

    def review_storyboard(self) -> str:
        self.reviews += 1
        self.reviewed_since_change = True
        if not self.scenes:
            return "Storyboard trống."
        out = [f"Storyboard {len(self.scenes)} cảnh, ~{self.total_seconds():.0f}s (mục tiêu ~{self.target_seconds()}s):",
               f"Giọng: {self.voice_summary()}"]
        for k, s in enumerate(self.scenes, 1):
            extra = [x for x in (s.get("heading") and f"nhãn '{s['heading']}'", s.get("title_card") and "title card",
                                 (s.get("meme_top") or s.get("meme_bottom")) and f"meme '{s.get('meme_top', '')} / {s.get('meme_bottom', '')}'")
                     if x]
            visuals = ", ".join(s["visuals"]) or (f"(tự tìm: {s['fallback_query']})" if s.get("fallback_query") else "(KHÔNG CÓ HÌNH)")
            out.append(f"{k}. {s['id']} ~{self._scene_seconds(s):.0f}s | hình: {visuals}" + (f" | {'; '.join(extra)}" if extra else ""))
            for l in s["lines"]:
                fx = [f"{k2}={l[k2]}" for k2 in ("voice", "sfx", "camera", "sticker", "pop_text") if l.get(k2)]
                out.append(f"   [{l['mood']}] {l['text']}" + (f"  ({', '.join(fx)})" if fx else ""))
        notes = self.critique()
        out.append("Nhận xét tự động:\n" + ("\n".join(f"- {n}" for n in notes) if notes else "- Không thấy vấn đề lớn."))
        return "\n".join(out)

    def finish(self, title: str = "", description: str = "", hashtags=None) -> str:
        if not self.scenes:
            return "Chưa có cảnh nào, không thể chốt."
        if not self.reviewed_since_change and self.reviews == 0:
            return "Hãy review_storyboard ít nhất một lần trước khi chốt.\n\n" + self.review_storyboard()
        self.meta = {
            "title": short_title(title or self.topic, 70),
            "description": " ".join((description or "").split()),
            "hashtags": normalize_hashtags(hashtags),
        }
        self.save_storyboard()
        return "Đã chốt. Bắt đầu dựng video."

    # ===== Vòng lặp agent =====

    def _intro_message(self) -> str:
        opts = self.opts
        tags = Counter(t for a in opts.library for t in a.tags).most_common(25)
        lib = f"{len(self.library)} asset ({sum(a.kind == 'video' for a in opts.library)} video), {len(self.memes)} meme"
        if tags:
            lib += ". Tag phổ biến: " + " ".join(f"#{t}({n})" for t, n in tags)
        parts = [
            f"Yêu cầu của người dùng:\n{self.topic}",
            f"Loại video: {opts.video_type}. Giọng văn mong muốn: {opts.tone or 'tự chọn cho hợp chủ đề, ưu tiên duyên dáng, hài hước'}.",
            f"Thời lượng mục tiêu: ~{self.target_seconds()} giây. Khung hình: {opts.aspect}.",
            f"Giọng đọc người dùng chọn: {self.voice_summary()}."
            + (" Bạn được quyền tinh chỉnh bằng tune_voice." if opts.ai_voice else " Giữ nguyên, không chỉnh giọng."),
            f"Thư viện của người dùng: {lib}.",
            "Tìm trên mạng: " + ("được phép (search_web)." if opts.web_images else "TẮT, chỉ dùng thư viện."),
        ]
        if opts.library_mode == "selected" and opts.library:
            parts.append("Người dùng ĐÃ CHỌN các asset sau làm nội dung chính, hãy dùng hết theo thứ tự:\n"
                         + "\n".join(a.catalog_line(True) for a in opts.library))
        if opts.num_steps:
            parts.append(f"Người dùng muốn khoảng {opts.num_steps} cảnh nội dung.")
        if self.scenes:
            parts.append("Đây là bản dựng TRƯỚC (đã có trong storyboard):\n" + self.review_storyboard())
            self.reviewed_since_change = False
            self.reviews = 0
        if opts.feedback:
            parts.append(f"GÓP Ý CỦA NGƯỜI DÙNG cho bản trước (ưu tiên số 1, sửa đúng ý này):\n{opts.feedback}")
        parts.append("Bắt đầu nào.")
        return "\n\n".join(parts)

    def _call(self, name: str, args: dict) -> str:
        handlers = {
            "search_assets": self.search_assets, "inspect_asset": self.inspect_asset, "search_web": self.search_web,
            "add_scene": self.add_scene, "update_scene": self.update_scene, "remove_scene": self.remove_scene,
            "move_scene": self.move_scene, "review_storyboard": self.review_storyboard, "finish": self.finish,
            "tune_voice": self.tune_voice,
        }
        fn = handlers.get(name)
        if not fn:
            return f"Không có công cụ '{name}'."
        allowed = {"search_assets": {"query", "kind", "memes_only"}, "inspect_asset": {"id"},
                   "search_web": {"query", "media", "count"}, "remove_scene": {"scene"}, "move_scene": {"scene", "position"},
                   "review_storyboard": set(), "finish": {"title", "description", "hashtags"},
                   "tune_voice": {"pitch", "rate", "reason"}}
        if name in allowed:
            args = {k: v for k, v in args.items() if k in allowed[name]}
        try:
            return fn(**args)
        except TypeError as e:
            return f"Tham số không hợp lệ cho {name}: {e}"
        except ConfigError:
            raise
        except Exception as e:  # lỗi của một công cụ (mạng, nguồn ngoài...) không được làm dừng cả đạo diễn
            traceback.print_exc()
            return f"Công cụ {name} lỗi ({type(e).__name__}: {_oneline(str(e), 160)}). Thử cách khác."

    def _action_text(self, name: str, args: dict) -> str:
        first = lambda: (args.get("lines") or [{}])[0]  # noqa: E731
        first_text = lambda: first().get("text", "") if isinstance(first(), dict) else str(first())  # noqa: E731
        return {
            "search_assets": lambda: f"Tìm {'meme' if args.get('memes_only') else 'asset'} trong thư viện: “{args.get('query', '')}”",
            "inspect_asset": lambda: f"Xem kỹ {args.get('id')}",
            "search_web": lambda: f"Tìm {'clip' if args.get('media') == 'video' else 'ảnh'} trên mạng: “{args.get('query', '')}”",
            "add_scene": lambda: f"Thêm cảnh: “{_oneline(first_text(), 80)}”",
            "update_scene": lambda: f"Sửa cảnh {args.get('scene')}" + (f": “{_oneline(first_text(), 70)}”" if args.get("lines") else ""),
            "remove_scene": lambda: f"Bỏ cảnh {args.get('scene')}",
            "move_scene": lambda: f"Đưa cảnh {args.get('scene')} lên vị trí {args.get('position')}",
            "review_storyboard": lambda: "Tự duyệt lại toàn bộ storyboard",
            "tune_voice": lambda: f"Chỉnh giọng: cao độ {_int(args.get('pitch')):+d}Hz, tốc độ {_int(args.get('rate')):+d}%"
                                  + (f" — {_oneline(str(args.get('reason')), 100)}" if args.get("reason") else ""),
            "finish": lambda: f"Chốt kịch bản: “{args.get('title', '')}”",
        }.get(name, lambda: name)()

    def run(self) -> Script:
        client = OpenAI(
            api_key=require("DEEPSEEK_API_KEY", self.settings.deepseek_api_key),
            base_url=self.settings.deepseek_base_url, max_retries=3, timeout=180,
        )
        model = self.settings.director_model or self.settings.deepseek_model
        system = SYSTEM.replace("{voice_rule}", VOICE_RULE if self.opts.ai_voice else "")
        tools = TOOLS if self.opts.ai_voice else [t for t in TOOLS if t["function"]["name"] != "tune_voice"]
        messages: list[dict] = [
            {"role": "system", "content": system.replace("{language}", self.opts.language)},
            {"role": "user", "content": self._intro_message()},
        ]
        self.event("action", "Đạo diễn AI bắt đầu: đọc yêu cầu, lên ý tưởng")
        idle = 0
        while self.meta is None and self.turn < MAX_TURNS:
            self.turn += 1
            response = client.chat.completions.create(
                model=model, messages=messages, tools=tools, tool_choice="auto", temperature=0.85,
            )
            msg = response.choices[0].message
            calls = msg.tool_calls or []
            if msg.content and msg.content.strip():
                self.event("thought", msg.content.strip())
            entry: dict = {"role": "assistant", "content": msg.content or ""}
            if calls:
                entry["tool_calls"] = [
                    {"id": c.id, "type": "function", "function": {"name": c.function.name, "arguments": c.function.arguments}}
                    for c in calls
                ]
            messages.append(entry)
            if not calls:
                idle += 1
                if idle >= 3:
                    break
                messages.append({"role": "user", "content": "Tiếp tục bằng cách gọi công cụ. Khi đã duyệt xong, gọi finish."})
                continue
            idle = 0
            for call in calls:
                try:
                    args = json.loads(call.function.arguments or "{}")
                    if not isinstance(args, dict):
                        raise ValueError("arguments phải là object")
                except ValueError as e:
                    result = f"JSON tham số lỗi: {e}. Gửi lại."
                    args = {}
                else:
                    self.event("action", self._action_text(call.function.name, args), tool=call.function.name)
                    result = self._call(call.function.name, args)
                if call.function.name != "review_storyboard":
                    self.event("result", result.split("\n")[0])
                else:
                    self.event("result", "; ".join(self.critique()) or "Không thấy vấn đề lớn.")
                messages.append({"role": "tool", "tool_call_id": call.id, "content": result})
            if self.turn == MAX_TURNS - 3 and self.meta is None:
                messages.append({"role": "user", "content": "Sắp hết thời gian: hoàn thiện nhanh và gọi finish."})

        if not self.scenes:
            raise RuntimeError("Đạo diễn AI không dựng được cảnh nào.")
        if self.meta is None:
            self.event("warn", "Hết lượt mà AI chưa chốt: tự chốt storyboard hiện tại")
            self.meta = {"title": short_title(self.topic), "description": "", "hashtags": []}
            self.save_storyboard()
        self.event("done", f"Chốt {len(self.scenes)} cảnh, ~{self.total_seconds():.0f}s sau {self.turn} lượt suy nghĩ",
                   scenes=len(self.scenes))
        return self.to_script()

    # ===== Chuyển đổi =====

    def _ref(self, media_id: str) -> dict:
        if media_id in self.library:
            return {"asset": media_id}
        item = self.web[media_id]
        return {"path": item["path"], "media": item["media"], "credit": item.get("credit"), "query": item.get("query")}

    def to_script(self) -> Script:
        steps = []
        for sc in self.scenes:
            lines = []
            for l in sc["lines"]:
                line = {k: v for k, v in l.items() if k != "sticker"}
                if l.get("sticker"):
                    line["sticker"] = self._ref(l["sticker"])
                lines.append(line)
            step = {
                "heading": sc.get("heading", ""),
                "narration": " ".join(l["text"] for l in lines),
                "lines": lines,
                "visuals": [self._ref(v) for v in sc["visuals"]],
                "image_queries": [sc["fallback_query"]] if sc.get("fallback_query") else [],
                "media": "video" if sc.get("fallback_query") else None,
                "title_card": sc.get("title_card", False),
            }
            if sc.get("meme_top") or sc.get("meme_bottom"):
                step["meme"] = {"top": sc.get("meme_top", ""), "bottom": sc.get("meme_bottom", "")}
            steps.append(step)
        meta = self.meta or {}
        return parse_script({
            "format": "director", "title": meta.get("title") or short_title(self.topic), "intro": "", "outro": "",
            "description": meta.get("description", ""), "hashtags": meta.get("hashtags", []), "steps": steps,
            "voice_tuning": self.voice_tuning,
        }, default_title=short_title(self.topic))

    def _load_base(self, data: dict) -> None:
        """Bản dựng trước (để sửa theo góp ý): mỗi bước thành một cảnh, asset theo id thư viện."""
        if self.opts.ai_voice:
            self.voice_tuning = normalize_tuning(data.get("voice_tuning"))
        for step in data.get("steps") or []:
            lines = [l for l in step.get("lines") or [] if isinstance(l, dict) and l.get("text")]
            if not lines or " ".join(l["text"] for l in lines) != (step.get("narration") or "").strip():
                lines = [{"text": t, "mood": "neutral"} for t in _sentences(step.get("narration") or "")]
            for l in lines:
                sticker = l.get("sticker")
                if isinstance(sticker, dict):
                    l["sticker"] = sticker.get("asset") if sticker.get("asset") in self.library else None
            ids = [step.get("library_image"), *(step.get("extra_assets") or [])]
            ids += [v.get("asset") for v in step.get("visuals") or [] if isinstance(v, dict)]
            meme = step.get("meme") or {}
            scene = {
                "id": f"s{self.next_scene}", "heading": step.get("heading") or "",
                "lines": [], "visuals": [], "title_card": bool(step.get("title_card")),
                "meme_top": meme.get("top", ""), "meme_bottom": meme.get("bottom", ""),
            }
            self._apply(scene, {"lines": lines, "visuals": [i for i in dict.fromkeys(ids) if i and i in self.library]}, [])
            if scene["lines"]:
                self.scenes.append(scene)
                self.next_scene += 1


def _int(value) -> int:
    try:
        return round(float(str(value).strip().removesuffix("Hz").removesuffix("%")))
    except (TypeError, ValueError):
        return 0


def _runs(items: list[str]):
    group: list[str] = []
    for item in items:
        if group and item != group[-1]:
            yield group
            group = []
        group.append(item)
    if group:
        yield group


def _sentences(text: str) -> list[str]:
    parts = [p.strip() for p in re.split(r"(?<=[.!?…])\s+", text) if p.strip()]
    return parts or ([text.strip()] if text.strip() else [])


def direct(topic: str, settings: Settings, opts: "Options", work_dir: Path, orientation: str) -> Script:
    """Chạy Đạo diễn AI và trả về kịch bản dạng director."""
    return Director(topic, settings, opts, work_dir, orientation).run()
