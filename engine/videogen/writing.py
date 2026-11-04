"""Phong cách viết kịch bản: cách AI viết lời (người dẫn, video essay, hai nhân vật trò chuyện, hài meme).

Khác với loại video (style.VIDEO_TYPES: hướng dẫn, top, mẹo... = nội dung xếp theo khung nào), phong cách viết quyết định
AI NÓI thế nào: một người dẫn hay hai nhân vật, kể/giải thích hay lập luận quan điểm, nhiều hay ít miếng hài.
Dùng cho cả Kịch bản nhanh (llm.generate_script) và Đạo diễn AI (director.Director).
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class WritingStyle:
    label: str           # tên hiện trong log và gửi cho AI
    tone: str            # giọng văn mặc định khi người dùng không chọn
    classic: str         # luật viết cho Kịch bản nhanh (một lần viết JSON)
    director: str        # luật viết cho Đạo diễn AI (thay khối "luật số 1" của prompt)
    dialogue: bool = False       # hai nhân vật: câu thoại xen kẽ giọng chính/giọng phụ
    humor: bool = False          # meme, câu cửa miệng, mỗi cảnh một miếng hài (Đạo diễn AI tự soi khi duyệt)
    max_line_words: int = 20     # câu thoại dài hơn thì Đạo diễn AI được nhắc rút gọn
    max_scene_lines: int = 3     # số câu thoại tối đa của một cảnh
    extra_points: int = 0        # được nói thêm chừng này ý so với mức của độ dài video


COMEDY_DIRECTOR = """ÍT CHỮ, NHIỀU MIẾNG HÀI — đây là luật số 1:
- Cả video chỉ xoay quanh MỘT ý chính (tối đa {max_points} ý/điểm thông tin). Video ngắn không phải bài giảng: người xem nhớ
  được 1 điều buồn cười còn hơn 10 điều khô khan. Thông tin thừa, số liệu phụ, giải thích dài dòng → CẮT THẲNG TAY.
- Mỗi cảnh chỉ nói MỘT điều, rồi để chỗ cho miếng hài/phản ứng/âm thanh "thở". Câu thoại ≤ 15 từ, cảnh 1-3 câu.
- MỖI cảnh phải có ít nhất một miếng hài: cà khịa, nói quá, so sánh bá đạo, tự giễu, plot twist vô lý, câu tỉnh bơ
  sau một câu hào hứng, hay giọng phụ (voice second) chen ngang phản bác/than thở. Cấu trúc kinh điển: đặt vấn đề
  nghiêm túc → câu chốt bất ngờ + tiếng động. Hài kiểu nói chuyện với bạn thân, không kiểu đọc bản tin.
- "voice": "second" = giọng phụ khác giới, dùng cho câu chen ngang/phản ứng/nội tâm ("Ủa gì vậy trời?"),
  như hai người dẫn đối đáp. Dùng có chủ ý, không lạm dụng.
- Thà video ngắn hơn mục tiêu một chút mà vui, còn hơn đủ giờ mà nhồi chữ."""

STYLES: dict[str, WritingStyle] = {
    # Tự động: giữ cách viết vốn có của từng chế độ (Kịch bản nhanh: người dẫn; Đạo diễn AI: hài meme)
    "auto": WritingStyle(
        label="tự động", tone="tự chọn cho hợp chủ đề, ưu tiên duyên dáng, hài hước",
        classic="", director=COMEDY_DIRECTOR, humor=True,
    ),
    "narrator": WritingStyle(
        label="người dẫn", tone="thân thiện, rõ ràng, có duyên",
        classic="""- Một người dẫn nói chuyện trực tiếp với người xem ("bạn"), như YouTuber đang kể cho bạn bè nghe: rõ ràng, có duyên,
  thỉnh thoảng một câu đùa nhẹ hoặc câu hỏi tu từ để giữ nhịp. Không đọc như văn bản, không liệt kê khô khan.""",
        director="""MỘT NGƯỜI DẪN CÓ DUYÊN — đây là luật số 1:
- Một người dẫn nói chuyện trực tiếp với người xem ("bạn"), rõ ràng và cuốn hút như YouTuber kể cho bạn bè nghe.
  Cả video xoay quanh tối đa {max_points} ý chính; mỗi cảnh một ý, nói cho thật dễ hiểu, có ví dụ đời thường.
- Hài nhẹ là gia vị, không phải món chính: vài câu đùa, so sánh vui, câu hỏi tu từ ở đúng chỗ. Meme và tiếng động chỉ
  đặt vào vài điểm nhấn đắt nhất, không cần cảnh nào cũng có.
- Chỉ dùng giọng phụ ("voice": "second") khi thật sự cần một câu chen ngang/nội tâm; mặc định chỉ có người dẫn.""",
    ),
    "essay": WritingStyle(
        label="video essay", tone="sâu sắc, có chính kiến, mạch lạc, thỉnh thoảng hóm hỉnh",
        classic="""- Đây là VIDEO ESSAY: bài bình luận/phân tích có CHÍNH KIẾN, không phải liệt kê thông tin.
  Lời mở đầu nêu một câu hỏi hoặc nhận định gây tranh luận, rồi nói thẳng quan điểm của video (luận điểm chính).
  Mỗi phần là một lập luận: nêu ý → dẫn chứng/ví dụ cụ thể (sự kiện, so sánh, tình huống quen thuộc) → "vậy thì sao?".
  Có một phần nhìn từ phía ngược lại (phản biện) rồi trả lời nó. Lời kết quay lại câu hỏi ban đầu, chốt một suy ngẫm
  đọng lại hoặc câu hỏi để người xem bình luận.
- Giọng một người kể có suy nghĩ riêng ("mình nghĩ", "nhưng khoan đã", "và đây mới là điều thú vị"); dùng câu hỏi tu từ,
  nhịp chậm-nhanh đan xen. Nêu ý kiến là ý kiến, sự thật là sự thật: không bịa số liệu, không chắc thì nói "có vẻ", "nhiều người cho rằng".""",
        director="""VIDEO ESSAY CÓ CHÍNH KIẾN — đây là luật số 1:
- Video là một bài bình luận/phân tích có QUAN ĐIỂM: mở bằng một câu hỏi hoặc nhận định gây tranh luận, nói rõ luận điểm
  của video, rồi đi qua {max_points} lập luận (mỗi lập luận: ý → dẫn chứng/ví dụ cụ thể → "vậy thì sao?"), có một cảnh
  phản biện (nhìn từ phía ngược lại) rồi trả lời nó, kết bằng một suy ngẫm đọng lại hoặc câu hỏi cho người xem.
- Mạch cảm xúc của essay: tò mò → suy nghĩ → "à, ra vậy" → đọng lại. Nhịp chậm hơn video meme: câu có thể dài hơn
  (≤ 25 từ), cảnh 2-4 câu, nhưng mỗi cảnh vẫn chỉ MỘT ý. Ưu tiên clip/ảnh minh họa giàu ý nghĩa hơn meme.
- Hài là sự hóm hỉnh, mỉa mai thông minh, không phải miếng hài mỗi cảnh. Meme/tiếng động chỉ dùng ở 1-3 chỗ thật đắt.
- Giọng chính là người viết essay. Giọng phụ ("voice": "second") chỉ khi muốn đọc ý kiến phản biện hay "tiếng nói
  trong đầu" ("Nhưng chẳng phải... sao?"), không dùng như người dẫn thứ hai.
- Nêu ý kiến là ý kiến, sự thật là sự thật: không bịa số liệu, không chắc thì nói "có vẻ", "nhiều người cho rằng".""",
        max_line_words=28, max_scene_lines=4, extra_points=1,
    ),
    "dialogue": WritingStyle(
        label="hai nhân vật trò chuyện", tone="tự nhiên, đời thường, hai người đối đáp duyên dáng",
        classic="""- Viết thành CUỘC TRÒ CHUYỆN giữa HAI NHÂN VẬT, như podcast/tiểu phẩm ngắn: nhân vật 1 ("voice": "main") và
  nhân vật 2 ("voice": "second", giọng khác). Tự đặt cho hai người tên và tính cách tương phản (vd một người tò mò hỏi
  ngây ngô, một người hiểu biết nhưng hay cà khịa; hoặc hai người tranh luận hai quan điểm). Gọi tên nhau đôi lần.
- Mỗi phần (kể cả lời mở đầu và lời kết) là một đoạn đối đáp 2-6 câu, hai giọng xen kẽ: hỏi → đáp → phản ứng
  ("Hả? Thật á?", "Khoan, vậy là...") → chốt. Thông tin đi ra qua câu hỏi và câu trả lời, không ai độc thoại dài.
- Xưng hô trung tính (mình/bạn/cậu/tớ) trừ khi người dùng muốn khác, vì giọng đọc có thể là nam hoặc nữ.""",
        director="""HAI NHÂN VẬT TRÒ CHUYỆN — đây là luật số 1:
- Cả video là CUỘC TRÒ CHUYỆN giữa HAI NHÂN VẬT như podcast/tiểu phẩm ngắn: nhân vật 1 ("voice": "main") và nhân vật 2
  ("voice": "second", giọng khác giới). Ngay từ đầu, tự đặt cho hai người tên và tính cách tương phản (vd một người tò mò,
  ngây ngô; một người hiểu biết nhưng hay cà khịa; hoặc hai người tranh luận hai quan điểm) và giữ đúng tính cách đó.
- Mỗi cảnh là một đoạn đối đáp 2-4 câu, hai giọng xen kẽ (gần một nửa số câu là "second"): hỏi → đáp → phản ứng
  ("Hả? Thật á?", "Khoan, vậy là...") → câu chốt. Thông tin đi ra qua hỏi-đáp, không ai độc thoại dài. Tối đa {max_points}
  ý chính cho cả video; câu thoại ≤ 18 từ.
- Gọi tên nhau đôi lần cho tự nhiên. Xưng hô trung tính (mình/bạn/cậu/tớ) trừ khi người dùng muốn khác.
- Miếng hài đến từ chính cuộc đối đáp (hiểu lầm, cà khịa nhau, phản ứng quá lố); meme/tiếng động đặt vào câu phản ứng.""",
        dialogue=True, humor=True, max_line_words=18, max_scene_lines=4,
    ),
    "comedy": WritingStyle(
        label="hài / meme", tone="hài hước, cà khịa, bắt trend",
        classic="""- Viết thật HÀI: mỗi phần có ít nhất một miếng hài (cà khịa, nói quá, so sánh bá đạo, tự giễu, câu tỉnh bơ sau câu hào hứng).
  Cấu trúc: đặt vấn đề nghiêm túc → câu chốt bất ngờ. Ít chữ, ít số liệu: người xem nhớ một điều buồn cười hơn mười điều khô khan.
- Có thể cho giọng phụ ("voice": "second") chen ngang 1 câu phản ứng/than thở ở vài chỗ ("Ủa gì vậy trời?").""",
        director=COMEDY_DIRECTOR, humor=True,
    ),
}

WRITING_STYLES = tuple(STYLES)


def writing_style(name: str | None) -> WritingStyle:
    return STYLES.get(name or "auto", STYLES["auto"])


# Cách viết để giọng đọc (TTS) không đều đều: dùng chung cho mọi phong cách và cả hai chế độ.
# edge-tts không nhận SSML nên nhấn nhá phải nằm ngay trong chữ (dấu câu, nhịp câu) và trong cảm xúc ("mood") của từng câu.
EXPRESSIVE_RULE = """NHẤN NHÁ CHO GIỌNG ĐỌC (giọng AI đọc đúng từng chữ bạn viết; viết phẳng thì đọc đều đều như robot):
- Viết như người thật đang NÓI: câu ngắn xen câu dài, từ cảm thán ("Trời ơi", "Ồ", "Thật luôn?"), câu hỏi tu từ, lặp từ để
  nhấn ("Rất, rất quan trọng."). Dấu câu chính là nhịp: "!" để nhấn và lên giọng, "?" để hỏi lên giọng, "..." để ngập ngừng
  hoặc tạo hồi hộp trước một ý bất ngờ, dấu phẩy để ngắt hơi. Mỗi câu thoại ít nhất một dấu như vậy ở chỗ cần.
- Ý đắt nhất (con số gây sốc, plot twist, câu chốt) tách thành MỘT CÂU THOẠI RIÊNG thật ngắn với "mood" mạnh hơn câu trước
  (vd câu dẫn "neutral" → câu chốt "shocked"/"emphatic"), có thể ngập ngừng ngay trước nó ("Và kết quả là... không ai ngờ.").
- Đổi "mood" theo nội dung từng câu, tránh 3 câu liền cùng mood; đừng gán mood mạnh cho mọi câu (sẽ mệt tai).
- Không viết IN HOA, emoji, ký hiệu hay chữ trong ngoặc trong câu đọc (giọng đọc sẽ đánh vần hoặc bỏ qua)."""
