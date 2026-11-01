# videogen — Tạo video hướng dẫn tự động

Pipeline: **chủ đề** → DeepSeek viết kịch bản (mở đầu, các bước, kết) → Google Search (hoặc Serper / Pexels) tìm ảnh minh họa cho từng bước → edge-tts đọc lời bình → dựng video có phụ đề, title card, nhãn "Bước N", hiệu ứng Ken Burns, chuyển cảnh và nhạc nền.

## Tính năng

- **Kịch bản thông minh**: DeepSeek (JSON mode) sinh tiêu đề, lời mở đầu, các bước (tên bước + lời bình + 2 từ khóa ảnh), lời kết.
- **Nhiều nguồn ảnh, tự chuyển nguồn**: Google Custom Search → Serper (Google Images) → Pexels, dùng nguồn nào có key; nguồn bị từ chối quyền thì tự chuyển nguồn sau. Ưu tiên ảnh lớn, đúng tỉ lệ khung hình; kiểm tra ảnh hợp lệ, thử từ khóa dự phòng; nếu vẫn không có thì tạo ảnh nền thay thế. Nguồn từng ảnh ghi vào `credits.txt`.
- **Giọng đọc**: edge-tts (Microsoft Neural, miễn phí) có retry; tự chuyển sang gTTS nếu edge-tts lỗi.
- **Video đẹp**: phụ đề tiếng Việt chia đoạn theo thời gian đọc, title card, nhãn bước, zoom/pan Ken Burns, crossfade giữa các cảnh, fade in/out, nhạc nền tự lặp.
- **Nhiều khung hình**: `16:9` (YouTube), `9:16` (TikTok/Shorts/Reels), `1:1`. Ảnh lệch tỉ lệ tự đặt trên nền mờ.
- **Nhanh & tiết kiệm**: tải ảnh và tạo giọng đọc song song; cache ảnh/audio, chạy lại không tốn thêm lượt gọi API.
- **Sửa rồi render lại**: kịch bản lưu ở `output/<tên>/script.json`, sửa lời/ảnh rồi render lại không cần gọi LLM.

## Cài đặt

Cần Python 3.10+.

```bash
pip install -r requirements.txt
cp .env.example .env
```

Mở `.env` và điền API key (xem bên dưới).

## Cách dùng

```bash
# Cơ bản (video 16:9, lưu ở output/<tiêu-đề>/)
python main.py "cách làm bánh flan"

# Video dọc cho TikTok/Shorts, 6 bước, có nhạc nền, đọc nhanh hơn 10%
python main.py "cách pha cà phê phin" --aspect 9:16 --steps 6 --music nhac.mp3 --rate +10%

# Giọng nam
python main.py "cách trồng rau mầm" --voice vi-VN-NamMinhNeural

# Quy trình 2 bước: viết kịch bản -> tự sửa -> render
python main.py "cách thay lốp xe đạp" --script-only
python main.py --script output/cach_thay_lop_xe_dap/script.json
```

Xem tất cả tùy chọn: `python main.py -h`

### Sửa kịch bản

`script.json` có dạng:

```json
{
  "title": "...",
  "intro": "...",
  "steps": [
    {"heading": "Tên bước", "narration": "Lời bình", "image_queries": ["query 1", "query 2"], "image": null}
  ],
  "outro": "..."
}
```

- Sửa `narration` → giọng đọc và phụ đề được tạo lại cho bước đó.
- Sửa `image_queries` → tìm lại ảnh cho bước đó.
- Đặt `"image": "anh_cua_toi.jpg"` (đường dẫn tuyệt đối hoặc tương đối với thư mục chứa script.json) để dùng ảnh của bạn.

## API key cần thiết

### 1. DeepSeek (viết kịch bản) — **bắt buộc** (trừ khi dùng `--script`)
- Lấy tại: https://platform.deepseek.com/api_keys
- `.env`: `DEEPSEEK_API_KEY=sk-...`

### 2. Nguồn ảnh — **cần ít nhất một**
Thứ tự ưu tiên đặt bằng `IMAGE_PROVIDERS` (mặc định `google,serper,pexels`).

**a) Google Custom Search** — `GOOGLE_API_KEY` + `GOOGLE_CSE_ID`
1. Bật [Custom Search API](https://console.cloud.google.com/apis/library/customsearch.googleapis.com) cho project.
2. Tạo **API key** (dạng `AIza...`) tại https://console.cloud.google.com/apis/credentials → "Create credentials" → "API key". File `client_secret_*.json` (OAuth) **không** dùng được cho API này.
3. Tạo search engine tại https://programmablesearchengine.google.com/, bật **"Search the entire web"** và **"Image search"**, copy "Search engine ID".
- Miễn phí 100 lượt/ngày.
- ⚠️ Google đã đóng API này với khách hàng mới và sẽ tắt vào 1/1/2027. Project mới có thể bị lỗi 403 — khi đó chương trình tự chuyển sang nguồn sau.

**b) Serper.dev** — `SERPER_API_KEY`
- Kết quả Google Images qua API, đăng ký tại https://serper.dev. Dùng khi project Google bị chặn.

**c) Pexels** — `PEXELS_API_KEY`
- Key miễn phí tại https://www.pexels.com/api/. 200 lượt/giờ, 20.000 lượt/tháng.
- Ảnh được dùng thương mại miễn phí — **nên dùng nguồn này khi làm video quảng cáo**.

> Ảnh từ Google/Serper thuộc bản quyền của website gốc — chỉ nên dùng cho học tập/thử nghiệm, không dùng cho quảng cáo trả phí.

### 3. Giọng đọc — **không cần API key**
- edge-tts, giọng mặc định `vi-VN-HoaiMyNeural` (nữ). Giọng nam: `vi-VN-NamMinhNeural`.
- Danh sách giọng: `edge-tts --list-voices`

## Cấu trúc code

```
main.py           # CLI
pipeline.py       # điều phối, cache, thư mục output
config.py         # đọc API key từ .env
llm.py            # DeepSeek -> kịch bản (Script/Step), lưu/đọc script.json
image_search.py   # Google / Serper / Pexels -> tải & kiểm tra ảnh, tự chuyển nguồn
tts.py            # edge-tts (+ gTTS dự phòng), chạy song song
graphics.py       # Pillow: phụ đề, nhãn bước, title card, ảnh dự phòng, font tiếng Việt
video_builder.py  # moviepy: Ken Burns, phụ đề theo thời gian, crossfade, nhạc nền
```

## Lưu ý

- Font phụ đề tự tìm Noto Sans / DejaVu Sans / Arial. Nếu chữ tiếng Việt hiển thị lỗi, đặt `FONT_PATH` trong `.env`.
- Máy chủ edge-tts đôi khi từ chối ngẫu nhiên — chương trình tự thử lại nhiều lần và chuyển sang gTTS nếu cần, nên bước tạo giọng có thể mất vài chục giây.
- Pexels không cho phép bán lại nguyên ảnh hoặc dùng ảnh có người theo cách gây hiểu lầm (vd ngụ ý người trong ảnh chứng thực sản phẩm). Với quảng cáo, nên ưu tiên ảnh sản phẩm thật của bạn qua trường `"image"`.
