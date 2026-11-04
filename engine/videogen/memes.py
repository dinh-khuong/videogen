"""Kho "câu cửa miệng" meme tiếng Việt và từ khóa cảm xúc để Đạo diễn AI chọn ảnh/clip meme theo cảm xúc.

- CATCHPHRASES: câu meme quen thuộc ở Việt Nam, khi nào dùng, và từ khóa (Việt + Anh) để tìm ảnh/clip meme hợp
  với câu đó trong thư viện hoặc trên mạng (vd "người Florida" ~ "Florida man").
- EMOTION_WORDS: từ khóa theo cảm xúc, để search_assets tìm meme/reaction đúng cảm xúc của câu thoại
  thay vì chỉ khớp chữ với nội dung.
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class Catchphrase:
    text: str        # câu meme (viết đúng chính tả, dùng nguyên văn hoặc biến tấu)
    when: str        # dùng khi nào
    keywords: tuple[str, ...]  # từ khóa tìm ảnh/clip meme hợp với câu này (Việt + Anh)
    mood: str = "sarcastic"    # cảm xúc đọc gợi ý (delivery.MOODS)
    match: tuple[str, ...] = ()  # cụm chữ (viết thường) nhận ra câu này kể cả khi biến tấu; trống: dùng chính câu

    def cores(self) -> tuple[str, ...]:
        return self.match or (self.text.lower().replace("[x] ", "").rstrip("?!. "),)


CATCHPHRASES: tuple[Catchphrase, ...] = (
    Catchphrase("Vắt cực khô", "tận dụng tối đa, bóc lột tới giọt cuối (pin, tiền, sức nhân viên, combo khuyến mãi)",
                ("vắt kiệt", "squeeze", "exhausted", "tired", "mệt", "kiệt sức", "dry"), "deadpan"),
    Catchphrase("Lỗi như thế này là đúng rồi", "thứ hỏng/sai một cách hiển nhiên nhưng vẫn tỉnh bơ chấp nhận",
                ("this is fine", "fire", "dog", "bình thường", "ok", "works on my machine", "error"), "deadpan",
                ("như thế này là đúng rồi", "như này là đúng rồi")),
    Catchphrase("Đây không phải bug, đây là tính năng", "biện minh cho lỗi, công nghệ/phần mềm chạy sai mà vẫn chối",
                ("not a bug", "feature", "bug", "programmer", "lập trình", "code", "developer", "computer"), "sarcastic",
                ("không phải bug", "không phải là bug", "là tính năng")),
    Catchphrase("Người ở hành tinh Nga", "hành động liều, kỳ quặc, siêu thực, không giống người Trái Đất",
                ("meanwhile in russia", "russia", "nga", "crazy", "bear", "gấu", "extreme", "winter"), "deadpan",
                ("hành tinh nga",)),
    Catchphrase("Người Florida", "chuyện điên rồ khó tin, kiểu tin giật gân 'Florida man'",
                ("florida man", "florida", "crazy", "alligator", "cá sấu", "weird", "news"), "shocked", ("florida",)),
    Catchphrase("Hảo hán", "ai đó liều lĩnh, chơi lớn, làm điều không ai dám (khen kiểu cà khịa)",
                ("hảo hán", "hero", "respect", "kung fu", "brave", "legend", "salute", "bow"), "hype"),
    Catchphrase("[X] quốc dân", "thứ ai cũng dùng/ai cũng biết: 'món ăn quốc dân', 'người yêu quốc dân', 'app quốc dân'",
                ("quốc dân", "national", "everyone", "popular", "famous", "crowd", "nổi tiếng"), "excited"),
    Catchphrase("Đứa nào tạo ra cái này?", "phát minh/thiết kế vô lý hoặc quá thiên tài",
                ("who did this", "who made this", "angry", "confused", "facepalm", "why", "tại sao"), "shocked",
                ("đứa nào tạo ra", "ai tạo ra cái này", "đứa nào nghĩ ra")),
    Catchphrase("Toang rồi", "mọi thứ đổ bể, kế hoạch thất bại", ("toang", "disaster", "fail", "explosion", "panic"), "dramatic"),
    Catchphrase("Còn cái nịt", "mất sạch, chẳng còn gì", ("lost everything", "broke", "empty", "poor", "nghèo", "sad"), "deadpan"),
    Catchphrase("Chúa hề", "ai đó tự làm mình thành trò cười", ("clown", "hề", "joker", "fool", "laugh"), "sarcastic"),
    Catchphrase("Báo thủ", "người chuyên phá, gây hại cho chính phe mình", ("troll", "fail", "oops", "mistake", "chaos"), "sarcastic"),
    Catchphrase("Ủa alo?", "phản ứng bối rối trước điều vô lý", ("confused", "what", "huh", "phone", "ngơ ngác"), "shocked"),
    Catchphrase("Tới công chuyện luôn", "sắp có biến lớn, vào việc ngay", ("let's go", "fight", "serious", "action", "go"), "hype"),
    Catchphrase("Đỉnh nóc kịch trần", "khen thứ quá xuất sắc", ("amazing", "wow", "best", "top", "fly"), "hype"),
    Catchphrase("Ối dồi ôi", "ngạc nhiên kiểu trêu chọc", ("surprised", "wow", "omg", "shock"), "shocked"),
    Catchphrase("Gét gô", "hào hứng bắt đầu", ("let's go", "excited", "run", "start", "hype"), "hype"),
    Catchphrase("Khum", "từ chối dễ thương", ("no", "nope", "refuse", "cute", "shake head"), "sarcastic"),
    Catchphrase("U là trời", "than thở, hết nói nổi", ("omg", "facepalm", "speechless", "oh no"), "shocked"),
    Catchphrase("Hết nước chấm", "hay/tệ tới mức không còn gì để nói", ("speechless", "perfect", "unbelievable"), "excited"),
    Catchphrase("Kiếp nạn thứ 82", "xui xẻo chồng chất", ("unlucky", "bad luck", "monkey", "journey", "suffering"), "dramatic"),
    Catchphrase("Rồi xong", "biết chắc sắp hỏng", ("it's over", "game over", "doomed", "end"), "deadpan"),
    Catchphrase("Căng đét", "tình huống cực kỳ căng thẳng", ("tense", "nervous", "sweat", "pressure"), "dramatic"),
)

# Cảm xúc của câu thoại (delivery.MOODS) -> từ khóa để tìm meme/reaction đúng cảm xúc (Việt + Anh)
EMOTION_WORDS: dict[str, tuple[str, ...]] = {
    "shocked": ("shock", "shocked", "surprised", "surprise", "omg", "wow", "sốc", "bất ngờ", "ngạc nhiên", "what"),
    "hype": ("hype", "excited", "celebrate", "party", "dance", "yeah", "lets go", "phấn khích", "ăn mừng", "nhảy"),
    "excited": ("happy", "excited", "smile", "yay", "vui", "hào hứng", "cười"),
    "dramatic": ("dramatic", "intense", "serious", "slow motion", "kịch tính", "căng thẳng", "dramatic chipmunk"),
    "mysterious": ("mysterious", "suspicious", "dark", "secret", "bí ẩn", "nghi ngờ", "hmm", "thinking"),
    "sarcastic": ("sarcastic", "smirk", "side eye", "eye roll", "mỉa mai", "cà khịa", "liếc", "troll"),
    "deadpan": ("deadpan", "blank stare", "poker face", "unimpressed", "tỉnh bơ", "mặt lạnh", "bored", "this is fine"),
    "sad": ("sad", "cry", "crying", "tears", "buồn", "khóc", "lonely", "disappointed"),
    "serious": ("serious", "focus", "nghiêm túc", "business", "nod"),
    "fast": ("fast", "run", "speed", "rush", "nhanh", "chạy"),
    "warm": ("love", "heart", "hug", "cute", "ấm áp", "dễ thương", "thương"),
    "curious": ("curious", "question", "huh", "wondering", "tò mò", "thắc mắc", "hmm"),
    "thoughtful": ("thinking", "thoughtful", "ponder", "hmm", "suy nghĩ", "trầm ngâm", "chin"),
    "emphatic": ("point", "serious", "this", "listen", "nhấn mạnh", "chú ý", "important"),
    "angry": ("angry", "mad", "rage", "tức", "giận", "furious"),
    "confused": ("confused", "huh", "what", "ngơ", "bối rối", "math lady", "thinking"),
    "laugh": ("laugh", "lol", "funny", "haha", "cười", "hài"),
    "fail": ("fail", "oops", "fall", "mistake", "toang", "ngã", "lỗi"),
}


def emotion_keywords(emotion: str) -> str:
    """Từ khóa cho một cảm xúc (tên trong EMOTION_WORDS hoặc chữ tự do)."""
    key = (emotion or "").strip().lower()
    return " ".join(EMOTION_WORDS.get(key, (key,)))


def phrase_keywords(text: str) -> str:
    """Câu meme khớp trong text -> từ khóa tìm ảnh/clip meme cho câu đó (rỗng nếu không khớp câu nào)."""
    low = (text or "").lower()
    out = []
    for c in CATCHPHRASES:
        if any(core in low for core in c.cores()):
            out.extend(c.keywords)
    return " ".join(out)


def used_phrases(texts: list[str]) -> list[str]:
    """Các câu meme đã xuất hiện trong lời thoại/chữ meme."""
    low = " ".join(texts).lower()
    return [c.text for c in CATCHPHRASES if any(core in low for core in c.cores())]


def catchphrase_doc() -> str:
    """Danh sách câu meme cho system prompt của Đạo diễn AI."""
    return "\n".join(f"  • \"{c.text}\" — {c.when}" for c in CATCHPHRASES)
