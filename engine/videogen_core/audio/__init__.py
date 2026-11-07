"""Xử lý âm thanh dùng chung cho mọi engine: cùng file cache giọng đọc, cùng bản trộn.

- tts: tạo giọng đọc (edge-tts, gTTS, FPT.AI, ZeroTTS), hiệu ứng giọng, mốc thời gian từng từ.
- delivery: cảm xúc của câu thoại (tốc độ/cao độ, khoảng lặng), ghép câu thành một file + mốc từng câu.
- cast: dàn giọng (số người nói, chuyển giọng theo cảnh/nhân vật), tiếng chuyển cảnh.
- voices: giọng đọc cho cả kịch bản (mở đầu, từng bước, lời kết), tiếng theo câu thoại, tiếng chuyển vào từng cảnh.
- sfx: hiệu ứng âm thanh tổng hợp bằng numpy.
- mix: giải mã, trộn giọng đọc + hiệu ứng + nhạc nền thành một track theo timeline các cảnh.
"""
