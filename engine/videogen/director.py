"""Đạo diễn AI: LLM tự lên kịch bản qua nhiều lượt gọi công cụ thay vì một lần viết JSON cứng nhắc.

Vòng lặp: AI suy nghĩ → gọi công cụ (tìm asset/meme trong thư viện, tìm ảnh/clip trên mạng, thêm/sửa/xóa/đổi chỗ
cảnh, tự duyệt storyboard) → đọc kết quả → quyết định bước tiếp theo. Số lượt, số cảnh, câu nào dùng meme hay
hiệu ứng gì đều do AI quyết định; vòng lặp chỉ dừng khi AI gọi `finish` (hoặc hết lượt).

Mỗi cảnh gồm nhiều câu thoại, mỗi câu có cảm xúc riêng (hào hứng, kịch tính, cà khịa...), có thể do giọng phụ đọc
(như hai người dẫn / "nội tâm"), kèm âm thanh meme (tổng hợp có sẵn hoặc tiếng của người dùng trong thư viện), zoom giật,
sticker meme, chữ nhấn mạnh. Kết quả là một Script
dạng "director" để pipeline dựng (và có thể sửa/render lại như kịch bản thường).

Nhật ký của AI ghi ra <work_dir>/director.jsonl, storyboard mới nhất ở <work_dir>/storyboard.json.
"""
import copy
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
    CAMERA_MOVES, OVERLAY_POSITIONS, SCENE_MOTIONS, SFX_NAMES, LibraryAsset, Script, _oneline, _tokens,
    ensure_hashtags, normalize_hashtags, parse_script, same_text, short_title, split_hashtags,
)
from .memes import EMOTION_WORDS, catchphrase_doc, emotion_keywords, phrase_keywords, used_phrases
from .video_search import VideoProviderPool, fetch_videos

if TYPE_CHECKING:
    from .pipeline import Options

MAX_TURNS = 40
MAX_VISUALS = 8          # tối đa số hình nối tiếp trong một cảnh
MAX_FINISH_BLOCKS = 2    # số lần finish bị từ chối vì chưa đúng số lượng meme / tần suất hình, sau đó vẫn cho chốt
TARGET_SECONDS = {"short": 35, "medium": 75, "long": 130}
CHARS_PER_SECOND = 14.5  # tốc độ đọc trung bình (tiếng Việt, edge-tts tốc độ gốc)
SCENE_PAD = 0.85         # khoảng lặng đầu + cuối mỗi cảnh
SEARCH_LIMIT = 8
MEME_WORDS = ("meme", "memedataset", "reaction", "funny")

SYSTEM = """Bạn là ĐẠO DIỄN video ngắn viral (TikTok/Reels/Shorts) kiêm biên kịch, có gu hài hước và rất hiểu meme.
Bạn KHÔNG viết kịch bản một lần cho xong: bạn làm việc như một người dựng phim thật, từng bước bằng các công cụ:
tìm tư liệu (asset của người dùng, meme, clip/ảnh trên mạng) → dựng từng cảnh → tự duyệt → sửa → chốt.

Quy trình gợi ý (tự quyết định thứ tự và số bước, không bắt buộc cứng nhắc):
1. Nghĩ ý tưởng: góc nhìn bất ngờ, câu hook 3 giây đầu, MẠCH CẢM XÚC của cả video (tò mò → bất ngờ → cười → thỏa
   mãn) và cảm xúc của từng câu. Cảm xúc quyết định hình ảnh, không phải ngược lại.
2. Tìm tư liệu THEO CẢM XÚC: với mỗi "miếng" (câu sốc, câu cà khịa, câu tỉnh bơ...), search_assets với emotion tương ứng
   (ưu tiên meme, clip reaction), search_web cho clip/ảnh minh họa. Tìm nhiều lần với từ khóa khác nhau nếu chưa hợp.
   Ưu tiên asset của người dùng khi khớp nội dung; ưu tiên MEME (ảnh/clip) cho chỗ có cảm xúc mạnh.
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
- Mỗi lần search_web, luôn điền "title" (tiêu đề tiếng Việt 3-8 từ mô tả CHÍNH ảnh/clip đó; không trùng tiêu đề video,
  không chép lời thoại) và "hashtags" (3-5 hashtag tiếng Việt không dấu về nội dung hình; KHÔNG phải từ khóa tìm kiếm).
  Tiêu đề video (finish) phải do bạn tự đặt, hấp dẫn, KHÔNG chép nguyên văn yêu cầu của người dùng.
- VIDEO LỒNG TRÊN ẢNH: cảnh dùng ảnh làm nền vẫn có thể có video chạy bên trong: "overlay" = id một CLIP (meme,
  reaction, minh họa) hiện trong khung nhỏ suốt cảnh, "overlay_position" chọn góc (br/bl/tr/tl, center = khung lớn
  giữa, ảnh làm nền). Sticker theo câu ("sticker") cũng có thể là CLIP: clip reaction bật ra đúng câu đó rồi biến mất.
  Nhờ vậy video không chỉ toàn ảnh tĩnh. Dùng clip của thư viện (search_assets kind=video) hoặc search_web media=video.
- CHUYỂN ĐỘNG theo cảm xúc, không gò bó một kiểu: "motion" của cảnh (zoom_in đẩy vào = kịch tính/nghiêm túc,
  zoom_out = mở ra/ấm áp, pan_* = lia khi liệt kê/hào hứng, zoom_in_left/right = sốc nhìn kỹ, still = đứng yên cho câu
  tỉnh bơ/cà khịa). Bỏ trống thì hệ thống tự chọn theo cảm xúc câu đầu. Cảnh liền nhau nên khác chuyển động.
- Cảnh đầu là hook: câu đầu ≤ 15 từ, gây tò mò/sốc ngay. Có thể đặt title_card cho cảnh đầu (tiêu đề hiện 3 giây).
- "heading" là nhãn nhỏ góc trên (vd "#1", "Mẹo 2", "Plot twist") — chỉ đặt khi giúp người xem theo dõi.
- Cảnh cuối: chốt hạ gọn, có thể kêu gọi follow/bình luận một cách duyên dáng.
- Giữ đúng mọi thông tin người dùng cung cấp (tên, giá, số liệu). Không bịa số liệu.

CÂU CỬA MIỆNG MEME (khi viết tiếng Việt): ưu tiên chèn đúng chỗ, tự nhiên — trong lời thoại, pop_text hay chữ meme
(meme_top/meme_bottom) — và chọn ảnh/clip meme hợp với câu đó (search_assets với query là chính câu meme, hệ thống tự
thêm từ khóa tương ứng, vd "người Florida" ~ "Florida man"). Viết đúng chính tả. Có thể biến tấu ("điện thoại quốc dân",
"pin vắt cực khô"). Không nhồi: 1-3 câu cho cả video, đặt vào "miếng" đắt nhất. Danh sách gợi ý (dùng thêm các câu
trend khác nếu hợp):
{catchphrases}

{counts_rule}{voice_rule}{sound_rule}Trước mỗi lượt gọi công cụ, viết 1 câu ngắn ({language}) nói bạn định làm gì và vì sao (người dùng đang xem).
Toàn bộ lời thoại viết bằng {language}."""

VOICE_RULE = """Giọng đọc: bạn ĐƯỢC QUYỀN tinh chỉnh giọng chung của cả video bằng tune_voice (cao độ, tốc độ quanh mức người dùng
chọn) cho hợp không khí video: chuyện ma/bí ẩn/buồn → trầm, chậm hơn; hài, Gen Z, quảng cáo, top viral → sáng, nhanh hơn;
hướng dẫn/kiến thức → rõ ràng, chỉnh nhẹ. Chỉnh vừa phải, giọng phải còn tự nhiên; giọng đã hợp thì không cần chỉnh.
Cảm xúc từng câu ("mood") vẫn cộng thêm sau mức chung này. Người dùng góp ý về giọng (cao/trầm/nhanh/chậm) thì sửa bằng tune_voice.

"""

SOUND_RULE = """Âm thanh trong thư viện của người dùng: họ có {count} âm thanh ngắn (tiếng động, meme sound, hiệu ứng). Dùng search_sounds
để tìm đúng tiếng hợp "miếng" (vd "bruh", "còi xe", "vỗ tay", "ồ", "cười"), rồi gắn id vào câu thoại bằng "sound": tiếng phát
ngay khi bắt đầu câu, như sfx nhưng là tiếng thật của người dùng. ƯU TIÊN âm thanh của người dùng hơn sfx có sẵn khi có tiếng
khớp (mỗi câu chỉ dùng một trong hai). Đặt đúng chỗ, không rải đều, không lặp một tiếng quá 2-3 lần. Nhạc nền do người dùng
chọn riêng, không cần bạn lo.

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
        "sticker": {"type": "string", "description": "id ảnh HOẶC clip (meme/reaction) bật ra ở góc khung trong lúc đọc câu."},
        "pop_text": {"type": "string", "description": "Chữ nhấn mạnh rất ngắn hiện to giữa khung khi đọc câu."},
    },
    "required": ["text", "mood"],
}

# Chỉ đưa cho AI khi người dùng có âm thanh trong thư viện (Director._tools)
SOUND_PROP = {"type": "string", "description": "id âm thanh thư viện (từ search_sounds) phát khi bắt đầu câu."}
SEARCH_SOUNDS_TOOL = {"type": "function", "function": {
    "name": "search_sounds",
    "description": "Tìm âm thanh ngắn (tiếng động, meme sound, hiệu ứng) trong thư viện của người dùng theo nội dung và/hoặc CẢM XÚC. "
                   "Dùng id tìm được trong \"sound\" của câu thoại.",
    "parameters": {"type": "object", "properties": {
        "query": {"type": "string", "description": "Từ khóa (tiếng Việt/Anh, vd 'bruh', 'vỗ tay', 'còi xe', 'phát hiện')."},
        "emotion": {"type": "string", "description": "Cảm xúc/tình huống cần (vd " + ", ".join(EMOTION_WORDS) + ")."},
    }, "required": []},
}}

SCENE_PROPS = {
    "heading": {"type": "string", "description": "Nhãn nhỏ góc trên (tùy chọn)."},
    "lines": {"type": "array", "items": LINE_SCHEMA, "description": "1-4 câu thoại của cảnh."},
    "visuals": {"type": "array", "items": {"type": "string"}, "description": "id asset/ảnh/clip hiển thị nối tiếp."},
    "fallback_query": {"type": "string", "description": "Từ khóa tiếng Anh để hệ thống tự tìm hình nếu visuals trống."},
    "meme_top": {"type": "string", "description": "Chữ meme phía trên hình (tùy chọn)."},
    "meme_bottom": {"type": "string", "description": "Chữ meme phía dưới hình (tùy chọn)."},
    "title_card": {"type": "boolean", "description": "Hiện tiêu đề video lớn trong 3 giây đầu cảnh."},
    "overlay": {"type": "string", "description": "id CLIP (hoặc ảnh) lồng trong khung nhỏ trên hình nền suốt cảnh "
                                                 "(vd clip reaction trên ảnh minh họa). Chuỗi rỗng để bỏ."},
    "overlay_position": {"type": "string", "enum": list(OVERLAY_POSITIONS),
                         "description": "Góc đặt overlay: br/bl/tr/tl, center = khung lớn giữa (mặc định br)."},
    "motion": {"type": "string", "enum": ["auto", *SCENE_MOTIONS],
               "description": "Chuyển động ảnh của cảnh theo cảm xúc. auto: tự chọn theo mood câu đầu."},
}


def _tool(name: str, description: str, properties: dict, required: list[str] | None = None) -> dict:
    return {"type": "function", "function": {
        "name": name, "description": description,
        "parameters": {"type": "object", "properties": properties, "required": required or []},
    }}


TOOLS = [
    _tool("search_assets", "Tìm trong thư viện asset của người dùng (ảnh/video, kể cả kho meme) theo nội dung và/hoặc "
                           "CẢM XÚC. Meme và clip được xếp trước khi tìm theo cảm xúc.", {
        "query": {"type": "string", "description": "Từ khóa hoặc câu meme (tiếng Việt/Anh, vd 'mèo ngạc nhiên', 'drake', "
                                                   "'người Florida'). Có thể để trống nếu chỉ tìm theo emotion."},
        "emotion": {"type": "string", "description": "Cảm xúc cần (vd " + ", ".join(EMOTION_WORDS) + ")."},
        "kind": {"type": "string", "enum": ["any", "image", "video"]},
        "memes_only": {"type": "boolean", "description": "Chỉ tìm trong kho meme."},
    }),
    _tool("inspect_asset", "Xem chi tiết một asset thư viện: mô tả đầy đủ, chữ trong ảnh, thời lượng, đã dùng ở đâu. "
                           "Ảnh/clip tải từ mạng chỉ có thông tin từ khóa tìm kiếm.", {
        "id": {"type": "string"},
    }, ["id"]),
    _tool("search_web", "Tìm và tải clip video (stock/Creative Commons) hoặc ảnh trên mạng. Trả về id để dùng trong cảnh.", {
        "query": {"type": "string", "description": "Mô tả cảnh quay bằng TIẾNG ANH, cụ thể (vd 'cat jumping off table')."},
        "media": {"type": "string", "enum": ["video", "image"]},
        "count": {"type": "integer", "description": "Số clip cần (1-3, chỉ với video)."},
        "title": {"type": "string", "description": "Tiêu đề TIẾNG VIỆT 3-8 từ mô tả chính ảnh/clip này (tên asset khi lưu vào "
                                                    "thư viện). Khác tiêu đề video và lời thoại."},
        "hashtags": {"type": "array", "items": {"type": "string"},
                     "description": "3-5 hashtag tiếng Việt không dấu về NỘI DUNG hình (không phải từ khóa tìm kiếm)."},
        "meme": {"type": "boolean", "description": "true nếu cần ảnh/clip MEME hoặc reaction (tính vào số meme người dùng yêu cầu)."},
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
        "title": {"type": "string", "description": "Tiêu đề video gây tò mò (≤ 60 ký tự), tự đặt, KHÔNG chép nguyên văn "
                                                    "yêu cầu của người dùng."},
        "description": {"type": "string", "description": "Mô tả 1-3 câu để đăng mạng xã hội (không chèn hashtag vào đây)."},
        "hashtags": {"type": "array", "items": {"type": "string"},
                     "description": "6-10 hashtag đăng mạng xã hội (chủ đề, nội dung, đối tượng xem, trend), viết thường không dấu. "
                                    "KHÔNG phải từ khóa tìm ảnh."},
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
        self.sounds = {a.id: a for a in opts.sounds}
        self.memes = [a for a in opts.library if _is_meme(a)]
        self.meme_ids = {a.id for a in self.memes}
        self.web: dict[str, dict] = {}  # id -> {"path", "media", "credit", "query"}
        self.scenes: list[dict] = []
        self.next_scene = 1
        self.meta: dict | None = None
        self.reviewed_since_change = False
        self.reviews = 0
        self.turn = 0
        self.title_retried = False  # đã từ chối một lần vì tiêu đề chép nguyên văn yêu cầu
        self.finish_blocks = 0      # số lần finish bị từ chối vì chưa đúng số meme / tần suất hình
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
            if media_id in sc["visuals"] or sc.get("overlay") == media_id or any(l.get("sticker") == media_id for l in sc["lines"]):
                used.append(sc["id"])
        return used

    def search_assets(self, query: str = "", kind: str = "any", memes_only: bool = False, emotion: str = "") -> str:
        pool = self.memes if memes_only else list(self.library.values())
        if kind in ("image", "video"):
            pool = [a for a in pool if a.kind == kind]
        if not pool:
            return ("Thư viện không có meme nào." if memes_only else "Thư viện trống hoặc không có loại này.") + \
                " Hãy dùng search_web hoặc meme_top/meme_bottom, pop_text, sfx để tạo chất meme."
        query = str(query or "")
        # Câu meme quen thuộc -> thêm từ khóa tương ứng (vd "người Florida" ~ "florida man")
        words = _tokens(query) | _tokens(phrase_keywords(query))
        feel = _tokens(emotion_keywords(emotion)) if emotion else set()
        if not words and not feel:
            return "Cần query hoặc emotion."

        def score(a: LibraryAsset) -> float:
            text = _tokens(a.search_text())
            hit_words, hit_feel = len(words & text), len(feel & text)
            if not hit_words and not hit_feel:
                return 0.0
            # Tìm theo cảm xúc: meme và clip (sống động hơn ảnh) được ưu tiên
            bonus = (0.6 if a.id in self.meme_ids else 0) + (0.4 if a.kind == "video" else 0) if feel else 0
            return hit_words * 2 + hit_feel + bonus

        scored = sorted(((score(a), i, a) for i, a in enumerate(pool)), key=lambda x: (-x[0], x[1]))
        hits = [a for sc, _, a in scored if sc > 0][:SEARCH_LIMIT]
        if not hits:
            what = " / ".join(x for x in (query and f"'{query}'", emotion and f"cảm xúc {emotion}") if x)
            return f"Không có asset khớp {what}. Thử từ khóa khác (đồng nghĩa, tiếng Anh) hoặc search_web."
        lines = [self._describe(a.id) + (f" (đang dùng ở {', '.join(u)})" if (u := self._usage(a.id)) else "") for a in hits]
        return f"{len(hits)} kết quả:\n" + "\n".join(lines)

    def _sound_usage(self, sound_id: str) -> list[str]:
        return [sc["id"] for sc in self.scenes if any(l.get("sound") == sound_id for l in sc["lines"])]

    def search_sounds(self, query: str = "", emotion: str = "") -> str:
        if not self.sounds:
            return "Thư viện không có âm thanh nào. Dùng sfx có sẵn (boom, ding, whoosh...)."
        words = _tokens(query) | _tokens(phrase_keywords(query))
        feel = _tokens(emotion_keywords(emotion)) if emotion else set()
        if not words and not feel:
            return "Cần query hoặc emotion."

        def score(a: LibraryAsset) -> float:
            text = _tokens(a.search_text())
            return len(words & text) * 2 + len(feel & text)

        scored = sorted(((score(a), i, a) for i, a in enumerate(self.sounds.values())), key=lambda x: (-x[0], x[1]))
        hits = [a for sc, _, a in scored if sc > 0][:SEARCH_LIMIT]
        if not hits:
            what = " / ".join(x for x in (query and f"'{query}'", emotion and f"cảm xúc {emotion}") if x)
            return f"Không có âm thanh khớp {what}. Thử từ khóa khác (đồng nghĩa, tiếng Anh) hoặc dùng sfx có sẵn."
        lines = [a.catalog_line() + (f" (đang dùng ở {', '.join(u)})" if (u := self._sound_usage(a.id)) else "") for a in hits]
        return f"{len(hits)} kết quả (gắn id vào \"sound\" của câu thoại):\n" + "\n".join(lines)

    def inspect_asset(self, id: str) -> str:
        if id in self.sounds:
            used = self._sound_usage(id)
            return self.sounds[id].catalog_line(detailed=True) + (f"\nĐang dùng ở: {', '.join(used)}" if used else "\nChưa dùng.")
        if self._kind_of(id) is None:
            return f"Không có asset/ảnh/clip id '{id}'."
        used = self._usage(id)
        return self._describe(id, detailed=True) + (f"\nĐang dùng ở: {', '.join(used)}" if used else "\nChưa dùng.")

    def search_web(self, query: str, media: str = "video", count: int = 1, title: str = "", hashtags=None,
                   meme: bool = False) -> str:
        if not self.opts.web_images:
            return "Người dùng đã tắt tìm trên mạng. Chỉ dùng asset trong thư viện (search_assets)."
        query = " ".join(query.split())[:120]
        if not query:
            return "Thiếu từ khóa."
        title = " ".join(str(title or "").split())[:80]
        tags = normalize_hashtags(hashtags)[:6]
        images_dir = self.work_dir / "images"
        images_dir.mkdir(parents=True, exist_ok=True)
        key = hashlib.sha1(f"{media}|{self.orientation}|{query}|{bool(meme)}".encode()).hexdigest()[:10]
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
            # Ảnh meme: thêm chữ "meme" vào truy vấn (kho clip stock không có meme nên clip giữ nguyên truy vấn)
            image_query = f"{query} meme" if meme and "meme" not in query.lower() else query
            credit = fetch_image([image_query], dest, self.orientation, self._image_pool, self.registry)
            found = [(dest, credit)] if credit else []
        if not found:
            return f"Không tìm được gì cho '{query}'. Thử mô tả cảnh khác, cụ thể hơn hoặc chung hơn."
        ids = []
        for path, credit in found:
            media_id = f"web{len(self.web) + 1}"
            self.web[media_id] = {"path": str(path.resolve()), "media": media, "credit": asdict(credit), "query": query,
                                  "title": title, "hashtags": tags, "meme": bool(meme)}
            ids.append(media_id)
        label = ("clip" if media == "video" else "ảnh") + (" meme" if meme else "")
        missing = "" if title and tags else " Lần sau điền đủ title và hashtags để ảnh/clip có tên và hashtag riêng khi lưu vào thư viện."
        return f"Đã tải {len(ids)} {label}: {', '.join(ids)} — '{query}'.{note}{missing} Dùng các id này trong visuals."

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
            sound = str(item.get("sound") or "").strip()
            if sound:
                if sound in self.sounds:
                    line["sound"] = sound
                else:
                    warnings.append(f"sound '{sound}' không có trong thư viện âm thanh (tìm bằng search_sounds)")
            if item.get("camera") in CAMERA_MOVES:
                line["camera"] = item["camera"]
            sticker = str(item.get("sticker") or "").strip()
            if sticker:
                if self._kind_of(sticker) in ("image", "video"):
                    line["sticker"] = sticker
                else:
                    warnings.append(f"sticker '{sticker}' không tồn tại")
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
            scene["visuals"] = visuals[:MAX_VISUALS]
        for key in ("fallback_query", "meme_top", "meme_bottom"):
            if key in args:
                scene[key] = " ".join(str(args.get(key) or "").split())[:100]
        if "title_card" in args:
            scene["title_card"] = bool(args.get("title_card"))
        if "overlay" in args:
            overlay = str(args.get("overlay") or "").strip()
            if not overlay:
                scene.pop("overlay", None)
            elif self._kind_of(overlay) is None:
                warnings.append(f"overlay '{overlay}' không tồn tại (bỏ qua)")
            elif overlay in scene["visuals"]:
                warnings.append(f"overlay '{overlay}' đang là hình chính của cảnh, chọn clip khác")
            else:
                scene["overlay"] = overlay
                if self._kind_of(overlay) != "video":
                    warnings.append("overlay là ảnh: được, nhưng clip video sẽ sinh động hơn")
        if "overlay_position" in args:
            pos = args.get("overlay_position")
            scene["overlay_position"] = pos if pos in OVERLAY_POSITIONS else "br"
        if "motion" in args:
            motion = args.get("motion")
            if motion in SCENE_MOTIONS:
                scene["motion"] = motion
            else:
                scene.pop("motion", None)

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

    # ===== Số meme và tần suất đổi hình (người dùng đặt) =====

    def _is_meme_media(self, media_id: str) -> bool:
        if media_id in self.library:
            return media_id in self.meme_ids
        return bool(self.web.get(media_id, {}).get("meme"))

    def meme_counts(self) -> tuple[int, int]:
        """(số ảnh meme, số clip meme) đang dùng trong storyboard: tính mỗi hình một lần dù dùng ở hình chính, lồng hay sticker."""
        used: set[str] = set()
        for sc in self.scenes:
            used.update(sc["visuals"])
            if sc.get("overlay"):
                used.add(sc["overlay"])
            used.update(l["sticker"] for l in sc["lines"] if l.get("sticker"))
        memes = [m for m in used if self._is_meme_media(m)]
        videos = sum(1 for m in memes if self._kind_of(m) == "video")
        return len(memes) - videos, videos

    def meme_targets(self) -> tuple[int | None, int | None]:
        return self.opts.meme_images, self.opts.meme_videos

    def interval(self) -> float:
        from .pipeline import effective_interval

        return effective_interval(self.opts)

    def visuals_needed(self, scene: dict) -> int:
        """Số hình cần cho một cảnh để đúng tần suất đổi hình (0 = người dùng không đặt tần suất)."""
        interval = self.interval()
        return min(max(round(self._scene_seconds(scene) / interval), 1), MAX_VISUALS) if interval else 0

    def counts_rule(self) -> str:
        """Đoạn prompt về số meme / tần suất hình mà người dùng đã đặt (rỗng nếu không đặt gì)."""
        images, videos = self.meme_targets()
        lines = []
        for label, target in (("ảnh meme", images), ("clip meme", videos)):
            if target is None:
                continue
            lines.append(f"- Số {label}: " + ("KHÔNG dùng cái nào." if target == 0 else f"ĐÚNG {target}."))
        if lines:
            lines.append("  Meme tính cả hình chính, hình lồng (overlay) và sticker; lấy từ kho meme của người dùng (search_assets "
                         "memes_only) hoặc search_web với meme=true. Mỗi hình chỉ tính một lần. Số meme còn lại (loại không nêu "
                         "ở trên) do bạn quyết định.")
        interval = self.interval()
        if interval:
            lines.append(f"- Tần suất hình: cứ ~{interval:g} giây đổi sang một ảnh/clip khác trong cùng cảnh, tức số hình mỗi cảnh "
                         f"≈ thời lượng cảnh / {interval:g} (cảnh ~9s cần ~{max(1, round(9 / interval))} hình). Review sẽ báo cảnh nào lệch.")
        if not lines:
            return ""
        return "YÊU CẦU CỤ THỂ CỦA NGƯỜI DÙNG (bắt buộc, hệ thống kiểm tra trước khi cho chốt):\n" + "\n".join(lines) + "\n\n"

    def unmet(self) -> list[str]:
        """Những yêu cầu số lượng/tần suất của người dùng mà storyboard hiện tại chưa đạt (kèm cách sửa)."""
        notes: list[str] = []
        can_find = bool(self.memes) or self.opts.web_images  # không có nguồn meme nào thì không đòi
        have_images, have_videos = self.meme_counts()
        for label, kind, have, target in (("ảnh meme", "ảnh", have_images, self.opts.meme_images),
                                          ("clip meme", "clip", have_videos, self.opts.meme_videos)):
            if target is None or have == target or (not can_find and have < target):
                continue
            if have < target:
                notes.append(f"Mới có {have}/{target} {label}: thêm {target - have} {kind} meme (search_assets memes_only=true "
                             f"kind={'image' if kind == 'ảnh' else 'video'}, hoặc search_web meme=true) làm hình/overlay/sticker.")
            else:
                notes.append(f"Đang có {have} {label}, người dùng muốn "
                             + ("KHÔNG dùng." if target == 0 else f"đúng {target}.") + f" Bớt {have - target} {kind} meme.")
        if self.interval():
            for s in self.scenes:
                need, have = self.visuals_needed(s), len(s["visuals"])
                if have and (have < need or have > need + 1):  # sai lệch 1 hình thì vẫn coi là đúng nhịp
                    notes.append(f"{s['id']} ~{self._scene_seconds(s):.0f}s có {have} hình, cần ~{need} hình để đổi hình mỗi "
                                 f"~{self.interval():g}s ({'thêm' if have < need else 'bớt'} visuals).")
        return notes

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
        effects = sum(1 for l in lines if l.get("sfx") or l.get("sound") or l.get("camera") or l.get("sticker") or l.get("pop_text"))
        memes = sum(1 for s in self.scenes if s.get("meme_top") or s.get("meme_bottom")) + sum(1 for l in lines if l.get("sticker"))
        if effects == 0:
            notes.append("Chưa có hiệu ứng meme nào (sfx/sound/camera/sticker/pop_text): video sẽ phẳng.")
        elif effects > len(lines) * 0.8:
            notes.append(f"{effects}/{len(lines)} câu có hiệu ứng: hơi lạm dụng, giữ lại những chỗ đắt nhất.")
        if memes == 0 and self.memes:
            notes.append(f"Thư viện có {len(self.memes)} meme nhưng chưa dùng cái nào (search_assets memes_only).")
        sfx = [l.get("sfx") for l in lines if l.get("sfx")]
        if sfx and Counter(sfx).most_common(1)[0][1] >= 4:
            notes.append(f"Âm '{Counter(sfx).most_common(1)[0][0]}' lặp quá nhiều lần.")
        if self.sounds:
            used_sounds = Counter(l["sound"] for l in lines if l.get("sound"))
            if not used_sounds:
                notes.append(f"Thư viện có {len(self.sounds)} âm thanh nhưng chưa dùng cái nào (search_sounds rồi gắn \"sound\" vào câu).")
            elif used_sounds.most_common(1)[0][1] >= 3:
                notes.append(f"Tiếng '{used_sounds.most_common(1)[0][0]}' lặp {used_sounds.most_common(1)[0][1]} lần: dùng tiếng khác cho đỡ nhàm.")
            if any(l.get("sound") and l.get("sfx") for l in lines):
                notes.append("Có câu vừa có sound vừa có sfx: chỉ giữ một.")
        if not any(l.get("voice") == "second" for l in lines) and len(lines) >= 6:
            notes.append("Có thể thêm vài câu giọng phụ (voice second) để đối đáp, đỡ độc thoại.")
        clips = [a for a in self.library.values() if a.kind == "video"] + [m for m in self.web.values() if m["media"] == "video"]
        moving = sum(1 for s in self.scenes if s.get("overlay") or any(self._kind_of(v) == "video" for v in s["visuals"])
                     or any(self._kind_of(l.get("sticker", "")) == "video" for l in s["lines"]))
        if len(self.scenes) >= 3 and moving < max(1, len(self.scenes) // 3):
            hint = "lồng clip (overlay) lên cảnh ảnh, hoặc dùng clip reaction làm sticker" if clips \
                else "tìm clip (search_assets kind=video / search_web media=video) để lồng lên cảnh ảnh"
            notes.append(f"Chỉ {moving}/{len(self.scenes)} cảnh có video chuyển động, còn lại toàn ảnh tĩnh: {hint}.")
        if self.opts.language.lower().startswith("tiếng việt") and len(self.scenes) >= 3:
            texts = [l.get("text", "") + " " + l.get("pop_text", "") for l in lines]
            texts += [s.get("meme_top", "") + " " + s.get("meme_bottom", "") for s in self.scenes]
            if not used_phrases(texts):
                notes.append("Chưa có câu cửa miệng meme nào (vắt cực khô, không phải bug mà là tính năng, người Florida...): "
                             "chèn 1-2 câu vào chỗ đắt nhất nếu hợp chủ đề.")
        motions = [s.get("motion") for s in self.scenes if s.get("motion")]
        if len(motions) >= 3 and len(set(motions)) == 1:
            notes.append(f"Mọi cảnh cùng chuyển động '{motions[0]}': đổi theo cảm xúc từng cảnh (hoặc để auto).")
        if self.opts.ai_voice and self.voice_tuning is None and not self.voice_checked:
            notes.append("Giọng chung chưa tinh chỉnh: nếu cao độ/tốc độ chưa hợp không khí video, dùng tune_voice.")
        notes += [f"Yêu cầu của người dùng: {n}" for n in self.unmet()]
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
                                 (s.get("meme_top") or s.get("meme_bottom")) and f"meme '{s.get('meme_top', '')} / {s.get('meme_bottom', '')}'",
                                 s.get("overlay") and f"lồng {s['overlay']} ({s.get('overlay_position', 'br')})",
                                 s.get("motion") and f"chuyển động {s['motion']}")
                     if x]
            visuals = ", ".join(s["visuals"]) or (f"(tự tìm: {s['fallback_query']})" if s.get("fallback_query") else "(KHÔNG CÓ HÌNH)")
            out.append(f"{k}. {s['id']} ~{self._scene_seconds(s):.0f}s | hình: {visuals}" + (f" | {'; '.join(extra)}" if extra else ""))
            for l in s["lines"]:
                fx = [f"{k2}={l[k2]}" for k2 in ("voice", "sfx", "sound", "camera", "sticker", "pop_text") if l.get(k2)]
                out.append(f"   [{l['mood']}] {l['text']}" + (f"  ({', '.join(fx)})" if fx else ""))
        notes = self.critique()
        out.append("Nhận xét tự động:\n" + ("\n".join(f"- {n}" for n in notes) if notes else "- Không thấy vấn đề lớn."))
        return "\n".join(out)

    def finish(self, title: str = "", description: str = "", hashtags=None) -> str:
        if not self.scenes:
            return "Chưa có cảnh nào, không thể chốt."
        if not self.reviewed_since_change and self.reviews == 0:
            return "Hãy review_storyboard ít nhất một lần trước khi chốt.\n\n" + self.review_storyboard()
        title = " ".join(str(title or "").split())
        if (not title or same_text(title, short_title(self.topic, 200)) or same_text(title, self.topic)) and not self.title_retried:
            self.title_retried = True
            return ("Tiêu đề đang trống hoặc chép nguyên văn yêu cầu của người dùng. Hãy tự đặt tiêu đề khác, gây tò mò, "
                    "≤ 60 ký tự (đừng lặp lại cách diễn đạt của yêu cầu) rồi gọi finish lại.")
        unmet = self.unmet()
        if unmet and self.finish_blocks < MAX_FINISH_BLOCKS:
            self.finish_blocks += 1
            return ("Chưa đúng yêu cầu của người dùng, sửa rồi gọi finish lại:\n" + "\n".join(f"- {n}" for n in unmet))
        if unmet:
            self.event("warn", "Chốt dù chưa đúng hết yêu cầu: " + "; ".join(unmet))
        # Hashtag AI viết lẫn trong mô tả được tách ra; còn thiếu thì bổ sung từ tiêu đề và nhãn cảnh (không dùng từ khóa tìm ảnh)
        clean, inline = split_hashtags(description or "")
        headings = [s.get("heading", "") for s in self.scenes]
        self.meta = {
            "title": short_title(title or self.topic, 70),
            "description": " ".join(clean.split()),
            "hashtags": ensure_hashtags([*normalize_hashtags(hashtags), *inline], texts=[title, *headings]),
        }
        self.save_storyboard()
        return "Đã chốt. Bắt đầu dựng video."

    # ===== Vòng lặp agent =====

    def _intro_message(self) -> str:
        opts = self.opts
        tags = Counter(t for a in opts.library for t in a.tags).most_common(25)
        lib = (f"{len(self.library)} asset ({sum(a.kind == 'video' for a in opts.library)} video), {len(self.memes)} meme "
               f"({sum(a.kind == 'video' for a in self.memes)} clip meme)")
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
        if self.sounds:
            parts.append(f"Âm thanh trong thư viện: {len(self.sounds)} tiếng ngắn (search_sounds, gắn vào câu bằng \"sound\").")
        if opts.library_mode == "selected" and opts.library:
            parts.append("Người dùng ĐÃ CHỌN các asset sau làm nội dung chính, hãy dùng hết theo thứ tự:\n"
                         + "\n".join(a.catalog_line(True) for a in opts.library))
        if opts.num_steps:
            parts.append(f"Người dùng muốn khoảng {opts.num_steps} cảnh nội dung.")
        rule = self.counts_rule()
        if rule:
            parts.append(rule.strip())
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
            "tune_voice": self.tune_voice, "search_sounds": self.search_sounds,
        }
        fn = handlers.get(name)
        if not fn:
            return f"Không có công cụ '{name}'."
        allowed = {"search_assets": {"query", "kind", "memes_only", "emotion"}, "inspect_asset": {"id"},
                   "search_web": {"query", "media", "count", "title", "hashtags", "meme"}, "remove_scene": {"scene"},
                   "move_scene": {"scene", "position"},
                   "review_storyboard": set(), "finish": {"title", "description", "hashtags"},
                   "tune_voice": {"pitch", "rate", "reason"}, "search_sounds": {"query", "emotion"}}
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
            "search_assets": lambda: f"Tìm {'meme' if args.get('memes_only') else 'asset'} trong thư viện: “{args.get('query', '')}”"
                                     + (f" (cảm xúc: {args['emotion']})" if args.get("emotion") else ""),
            "search_sounds": lambda: f"Tìm âm thanh trong thư viện: “{args.get('query', '')}”"
                                     + (f" (cảm xúc: {args['emotion']})" if args.get("emotion") else ""),
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

    def _tools(self) -> list[dict]:
        """Công cụ cho AI: tune_voice chỉ khi người dùng cho chỉnh giọng, search_sounds + "sound" chỉ khi thư viện có âm thanh."""
        tools = [t for t in TOOLS if t["function"]["name"] != "tune_voice" or self.opts.ai_voice]
        if not self.sounds:
            return tools
        tools = copy.deepcopy(tools)
        for tool in tools:
            lines = tool["function"]["parameters"]["properties"].get("lines")
            if lines:
                lines["items"]["properties"]["sound"] = SOUND_PROP
        return [*tools, SEARCH_SOUNDS_TOOL]

    def run(self) -> Script:
        client = OpenAI(
            api_key=require("DEEPSEEK_API_KEY", self.settings.deepseek_api_key),
            base_url=self.settings.deepseek_base_url, max_retries=3, timeout=180,
        )
        model = self.settings.director_model or self.settings.deepseek_model
        sound_rule = SOUND_RULE.replace("{count}", str(len(self.sounds))) if self.sounds else ""
        system = (SYSTEM.replace("{counts_rule}", self.counts_rule()).replace("{voice_rule}", VOICE_RULE if self.opts.ai_voice else "")
                  .replace("{sound_rule}", sound_rule).replace("{catchphrases}", catchphrase_doc()))
        tools = self._tools()
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
        return {"path": item["path"], "media": item["media"], "credit": item.get("credit"), "query": item.get("query"),
                "title": item.get("title", ""), "hashtags": item.get("hashtags", []), "meme": item.get("meme", False)}

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
            if sc.get("overlay") and self._kind_of(sc["overlay"]):
                step["overlay"] = {"ref": self._ref(sc["overlay"]), "position": sc.get("overlay_position", "br")}
            if sc.get("motion"):
                step["motion"] = sc["motion"]
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
            overlay = step.get("overlay") or {}
            overlay_id = (overlay.get("ref") or {}).get("asset") if isinstance(overlay, dict) else None
            scene = {
                "id": f"s{self.next_scene}", "heading": step.get("heading") or "",
                "lines": [], "visuals": [], "title_card": bool(step.get("title_card")),
                "meme_top": meme.get("top", ""), "meme_bottom": meme.get("bottom", ""),
            }
            base = {"lines": lines, "visuals": [i for i in dict.fromkeys(ids) if i and i in self.library]}
            if overlay_id in self.library:
                base.update(overlay=overlay_id, overlay_position=overlay.get("position", "br"))
            if step.get("motion"):
                base["motion"] = step["motion"]
            self._apply(scene, base, [])
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
