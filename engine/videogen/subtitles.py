"""Phụ đề: chia lời bình thành các đoạn ngắn và tính thời điểm hiện từng đoạn / từng từ.

Có thời điểm từng từ của edge-tts (<audio>.words.json) thì phụ đề khớp chính xác với giọng đọc (kể cả chỗ ngắt
câu); không có (gTTS, cache cũ) thì chia thời gian theo số ký tự như trước.
Các kiểu: box (chữ trong khung tối), outline (chữ đậm viền đen), karaoke (như outline + từ đang đọc được tô màu).
"""
import math
import re
import unicodedata
from bisect import bisect_right
from collections import OrderedDict
from dataclasses import dataclass

from PIL import Image

from .effects import Layer, draw_layer
from .graphics import Fonts, Word, render_caption, render_subtitle_box
from .style import DEFAULT_ACCENT

SENTENCE_END = set(".!?…。！？")
SOFT_BREAK = set(",;:，、；：")
UNSPACED_PIECE = 8  # độ dài (theo độ rộng hiển thị) của một "từ" khi cắt chữ Hán/Thái không có dấu cách


def _wide(ch: str) -> bool:
    return unicodedata.east_asian_width(ch) in "WF"


def display_len(text: str) -> int:
    """Độ dài theo độ rộng hiển thị: chữ Hán/Kana/Hangul rộng gấp đôi chữ Latin."""
    return sum(2 if _wide(ch) else 1 for ch in text)


def _unspaced_script(text: str) -> bool:
    return any(_wide(ch) or "฀" <= ch <= "๿" for ch in text)


@dataclass
class Piece:
    text: str
    start: int  # vị trí ký tự trong lời bình
    end: int
    spaced: bool


def pieces_of(text: str, max_len: int) -> list[Piece]:
    """Tách lời bình thành các "từ" (theo dấu cách; chữ không có dấu cách thì cắt thành đoạn ngắn)."""
    out: list[Piece] = []
    for m in re.finditer(r"\S+", text):
        token, s = m.group(), m.start()
        limit = UNSPACED_PIECE if _unspaced_script(token) else max_len
        if display_len(token) <= limit:
            out.append(Piece(token, s, m.end(), True))
            continue
        cur_start, cur = s, ""
        for k, ch in enumerate(token):
            cur += ch
            if display_len(cur) >= limit or (ch in SENTENCE_END | SOFT_BREAK and display_len(cur) >= limit / 2):
                out.append(Piece(cur, cur_start, s + k + 1, cur_start == s))
                cur_start, cur = s + k + 1, ""
        if cur:
            out.append(Piece(cur, cur_start, m.end(), cur_start == s))
    return out


def _joined_len(pieces: list[Piece]) -> int:
    return sum(display_len(p.text) + (1 if p.spaced and i else 0) for i, p in enumerate(pieces))


def chunk_pieces(pieces: list[Piece], max_len: int) -> list[list[Piece]]:
    """Gom từ thành các đoạn phụ đề có độ dài cân bằng, ưu tiên ngắt sau dấu câu."""
    sentences: list[list[Piece]] = []
    current: list[Piece] = []
    for p in pieces:
        current.append(p)
        if p.text[-1] in SENTENCE_END:
            sentences.append(current)
            current = []
    if current:
        sentences.append(current)

    chunks: list[list[Piece]] = []
    for sentence in sentences:
        length = _joined_len(sentence)
        if length <= max_len:
            chunks.append(sentence)
            continue
        n = math.ceil(length / max_len)
        target = length / n
        parts: list[list[Piece]] = []
        cur: list[Piece] = []
        for p in sentence:
            cur.append(p)
            cur_len = _joined_len(cur)
            if len(parts) < n - 1 and (cur_len >= target or (p.text[-1] in SOFT_BREAK and cur_len >= target * 0.65)):
                parts.append(cur)
                cur = []
        if cur:
            parts.append(cur)
        chunks.extend(parts)
    return [c for c in chunks if c]


def _norm(text: str) -> tuple[str, list[int]]:
    """Chữ cái/số viết thường (bỏ dấu câu, dấu cách) + vị trí gốc của từng ký tự."""
    chars, index = [], []
    for i, ch in enumerate(unicodedata.normalize("NFC", text)):
        if ch.isalnum():
            chars.append(ch.lower())
            index.append(i)
    return "".join(chars), index


def char_timeline(text: str, words: list[dict] | None, speech_len: float):
    """Hàm vị trí ký tự -> thời điểm (giây tính từ đầu giọng đọc), nội suy giữa các mốc từ của edge-tts."""
    text = unicodedata.normalize("NFC", text)
    anchors: list[tuple[int, float]] = [(0, 0.0)]
    if words:
        stream, index = _norm(text)
        pos = 0
        for w in words:
            needle, _ = _norm(str(w.get("text", "")))
            if not needle:
                continue
            k = stream.find(needle, pos, pos + len(needle) + 80)
            if k < 0:
                continue
            a, b = index[k], index[k + len(needle) - 1] + 1
            start = float(w["start"])
            end = max(start, float(w.get("end", start)))
            if a >= anchors[-1][0] and start >= anchors[-1][1]:
                anchors.append((a, start))
                if b > a:
                    anchors.append((b, end))
            pos = k + len(needle)
    if len(text) > anchors[-1][0]:
        anchors.append((len(text), max(speech_len, anchors[-1][1])))
    xs = [x for x, _ in anchors]
    ts = [t for _, t in anchors]

    def at(i: int) -> float:
        j = max(0, bisect_right(xs, i) - 1)
        if j >= len(xs) - 1:
            return ts[-1]
        x0, x1 = xs[j], xs[j + 1]
        if x1 == x0:
            return ts[j + 1]
        return ts[j] + (ts[j + 1] - ts[j]) * (i - x0) / (x1 - x0)

    return at


@dataclass
class Cue:
    start: float             # giây, tính từ đầu giọng đọc
    words: list[Word]
    word_starts: list[float]

    @property
    def text(self) -> str:
        return "".join((" " if w.spaced and i else "") + w.text for i, w in enumerate(self.words))


def max_chars(kind: str, size: tuple[int, int]) -> int:
    w, h = size
    if kind == "box":
        return 70 if w >= h else 45
    return 40 if w > h * 1.2 else 30 if w >= h * 0.9 else 26


def build_cues(text: str, words: list[dict] | None, speech_len: float, kind: str, size: tuple[int, int]) -> list[Cue]:
    text = unicodedata.normalize("NFC", text or "").strip()
    if not text:
        return []
    limit = max_chars(kind, size)
    at = char_timeline(text, words, speech_len)
    cues = []
    for chunk in chunk_pieces(pieces_of(text, limit), limit):
        starts = [at(p.start) for p in chunk]
        cues.append(Cue(starts[0], [Word(p.text, p.spaced) for p in chunk], starts))
    return cues


class SubtitleTrack:
    """Vẽ phụ đề của một scene. `offset` = thời điểm giọng đọc bắt đầu trong scene."""

    def __init__(self, cues: list[Cue], kind: str, size: tuple[int, int], fonts: Fonts,
                 accent: tuple[int, int, int] = DEFAULT_ACCENT, offset: float = 0.0) -> None:
        self.cues, self.kind, self.size, self.fonts, self.accent, self.offset = cues, kind, size, fonts, accent, offset
        self.starts = [offset + c.start for c in cues]
        self._cache: OrderedDict[tuple[int, int | None], Layer | None] = OrderedDict()

    def _layer(self, i: int, active: int | None) -> Layer | None:
        key = (i, active)
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]
        cue = self.cues[i]
        if self.kind == "box":
            canvas, enter, dur = render_subtitle_box(cue.text, self.size, self.fonts), "fade", 0.12
        else:
            canvas, enter, dur = render_caption(cue.words, active, self.size, self.fonts, self.accent), "pop", 0.18
        layer = Layer.from_canvas(canvas, start=self.starts[i], enter=enter, enter_dur=dur)
        self._cache[key] = layer
        if len(self._cache) > 4:
            self._cache.popitem(last=False)
        return layer

    def draw(self, frame: Image.Image, t: float) -> None:
        if self.kind == "none" or not self.cues:
            return
        i = bisect_right(self.starts, t) - 1
        if i < 0:
            return
        active = None
        if self.kind == "karaoke":
            local = t - self.offset
            active = max(0, bisect_right(self.cues[i].word_starts, local) - 1)
        layer = self._layer(i, active)
        if layer:
            draw_layer(frame, layer, t)
