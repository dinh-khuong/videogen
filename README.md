# VideoGen Studio — Tạo video hướng dẫn bằng AI

Ứng dụng web (Next.js) để tạo video hướng dẫn tự động và quản lý assets (ảnh, video nguồn, audio), video đã tạo và khách hàng (CRM). Việc dựng video do một **engine Python** chạy ở tiến trình riêng đảm nhận. Engine này cũng dùng độc lập được như một CLI.

Quy trình tạo một video: **chủ đề** → DeepSeek viết kịch bản và tự chọn ảnh/video từ Assets (bước nào không có asset phù hợp thì tìm ảnh trên mạng) → edge-tts đọc lời bình → dựng video có phụ đề, nhãn bước, hiệu ứng Ken Burns, chuyển cảnh.

```
┌──────────── web/ (Next.js) ────────────┐        ┌──────── engine/ (Python) ────────┐
│ Giao diện: tạo video, hàng đợi,        │ spawn  │ python -m videogen job spec.json │
│ assets, thư viện video, CRM            │ ─────► │  kịch bản → ảnh → giọng → video  │
│ API + SQLite + hàng đợi job/phân tích  │ ◄───── │  sự kiện tiến độ JSON (stdout)   │
│ Lưu file: data/media, data/app.db      │ result │  result.json                     │
└────────────────────────────────────────┘        └──────────────────────────────────┘
```

- **web/**: toàn bộ phần CRM và quản lý, gồm giao diện, API, database SQLite và hàng đợi job. Web không tự dựng video.
- **engine/**: toàn bộ phần tạo video. Engine không biết gì về database: nó nhận một file spec JSON và trả về `result.json`. Web app đưa kết quả đó vào thư viện.
- **data/**: dữ liệu local, gồm `app.db` (SQLite), `media/` (assets, video, thumbnail) và `jobs/` (thư mục làm việc của từng job). Thư mục này không được commit.

## Tính năng

- **Tạo video**: gồm khung 16:9, 9:16, 1:1 và **Shorts chia đôi** (nội dung ở trên, video nền như gameplay ở dưới). Có thể chọn giọng đọc, tốc độ đọc, ngôn ngữ và số bước.
- **Assets: ảnh và video là nội dung chính, không chỉ làm nền**:
  - Asset là ảnh hoặc clip video (sản phẩm, menu, ảnh chụp màn hình, clip quay thao tác...) dùng để ghép vào video.
  - *AI tự chọn từ Assets* (mặc định): AI đọc mô tả, tóm tắt và chữ trong từng asset rồi tự gán asset phù hợp cho từng bước. Bước nào không có asset khớp thì tìm ảnh trên mạng.
  - *Dùng asset tôi chọn*: các asset bạn chọn là nội dung chính. AI viết lời bình dựa trên nội dung và chữ đọc được trong từng asset (vd tên món, giá), theo đúng thứ tự bạn chọn.
  - Asset của bạn hiển thị **trọn vẹn trong khung** (không bị cắt) trên nền mờ. Clip video được tắt tiếng và tự lặp nếu ngắn hơn lời bình. Ảnh tìm trên mạng phủ kín khung.
- **Clip video trên mạng** cho các bước chưa có asset: chọn "AI tự chọn ảnh hay clip" (AI dùng clip cho phần lớn các bước, chỉ dùng ảnh cho chân dung, sơ đồ, bảng giá...), "Ưu tiên clip video" hoặc "Chỉ ảnh".
  - Mỗi bước ghép **nhiều clip nối tiếp** (1–6, mặc định 3) với chuyển cảnh mềm; mở đầu và kết thúc là montage cắt nhanh từ clip của các bước.
  - Chỉ lấy video **được phép dùng lại**: Pexels, Pixabay (kho stock, dùng thương mại), Wikimedia Commons (giấy phép tự do, không cần key), YouTube (**chỉ** video Creative Commons Attribution).
  - Mỗi clip lấy một đoạn ~10 giây (`WEB_CLIP_SECONDS`), tắt tiếng, lưu vào Assets kèm tác giả + giấy phép; nguồn được tự thêm vào cuối mô tả video để ghi công khi đăng.
  - Video Wikimedia có giấy phép CC BY-SA yêu cầu video của bạn cũng chia sẻ theo CC BY-SA: kiểm tra mô tả trước khi dùng cho quảng cáo.
  - YouTube: cần bật YouTube Data API cho key (hoặc dùng bộ lọc Creative Commons của trang tìm kiếm). YouTube có thể chặn tải từ máy chủ/máy cá nhân (yêu cầu đăng nhập); khi đó engine tự bỏ qua YouTube và dùng nguồn khác.
- **Phân tích asset tự động** (chạy nền sau khi tải lên):
  - **Đọc chữ trong ảnh/video** bằng Tesseract (chạy trên máy, hỗ trợ tiếng Việt). Với video, engine đọc chữ ở vài khung hình đầu/giữa/cuối.
  - **AI tóm tắt** nội dung + gợi ý hashtag (DeepSeek), đồng thời sửa lỗi nhận dạng chữ. Bạn có thể sửa tóm tắt hoặc bấm "Phân tích lại".
  - Tìm kiếm trong Assets tìm cả trong tóm tắt và chữ đọc được.
  - Job tạo video cần đọc asset sẽ chờ tối đa 3 phút để asset vừa tải lên được phân tích xong.
  - Ảnh không có chữ và chưa có mô tả thì AI chưa "nhìn" được nội dung. Hãy viết mô tả ngắn, hoặc bật mô hình thị giác (`VISION_MODEL`, xem `engine/.env.example`).
- **Hàng đợi job**:
  - Mỗi video được dựng bởi một tiến trình Python riêng, xử lý lần lượt từng job.
  - Có tiến độ theo từng giai đoạn, log của engine, nút hủy (dừng cả ffmpeg) và nút chạy lại.
  - Nếu server tắt giữa chừng, job đang chạy được đánh dấu lỗi để chạy lại.
- **Assets và thư viện video**:
  - Mỗi asset/video có mô tả. Hashtag trong mô tả (`#caphe #huongdan`) tự thành tag để lọc.
  - Ảnh tìm được khi tạo video được lưu vào Assets, kèm mô tả, hashtag và nguồn.
  - File trùng nội dung chỉ lưu một lần.
  - Video nền cho bố cục Shorts chia đôi cũng là một asset (video).
  - **Audio** (mp3, m4a, aac, wav, ogg, flac, opus) nằm chung trang Assets, có ảnh sóng âm và tóm tắt AI (từ tên + mô tả, vd thể loại, tâm trạng). Khi tạo video (hoặc tạo lại từ kịch bản đã sửa), chọn một audio làm **nhạc nền**: nhạc lặp suốt video, chỉnh được âm lượng, mờ dần ở cuối.
  - Video có tiêu đề, mô tả và hashtag do AI viết sẵn để đăng mạng xã hội, kèm nút sao chép.
  - Bạn có thể **sửa kịch bản, đổi ảnh/video từng bước rồi tạo lại video**.
- **CRM khách hàng**:
  - Lưu trạng thái (tiềm năng → khách hàng), số điện thoại, email, nguồn, ghi chú có hashtag và ngày hẹn chăm sóc.
  - Nhật ký chăm sóc (ghi chú, gọi điện, email, gặp mặt).
  - Gắn video đã làm cho khách, hoặc tạo video cho khách ngay từ hồ sơ.

## Cài đặt

Cần **Python 3.10+**, **Node.js 20+** và **Tesseract** (đọc chữ trong asset, không bắt buộc):

```bash
sudo dnf install tesseract tesseract-langpack-vie        # Fedora
sudo apt install tesseract-ocr tesseract-ocr-vie         # Ubuntu/Debian
brew install tesseract tesseract-lang                    # macOS
```

```bash
# 1. Engine Python
pip install -r engine/requirements.txt
cp engine/.env.example engine/.env      # điền DEEPSEEK_API_KEY (xem mục API key)

# 2. Web app
cd web
npm install
```

Nếu bạn dùng virtualenv, đặt nó ở `engine/.venv`; web app sẽ tự dùng Python trong đó. Cách khác là đặt `PYTHON_BIN` trong `web/.env.local` (xem `web/.env.example`).

## Chạy

```bash
cd web
npm run dev                     # phát triển: http://localhost:3000
```

```bash
cd web
npm run build && npm start      # chạy ổn định, nhanh hơn
```

Trang **Tổng quan** có mục "Engine Python": nếu thiếu API key, thiếu thư viện Python hoặc thiếu font tiếng Việt, mục này sẽ báo rõ cần sửa gì.

## Engine Python dùng như CLI

Engine chạy độc lập, không cần web app (chạy trong thư mục `engine/`, video lưu ở `engine/output/<tên>/`):

```bash
cd engine
python -m videogen "cách làm bánh flan"
python -m videogen "cách pha cà phê phin" --aspect 9:16 --steps 6 --music nhac.mp3 --rate +10%
python -m videogen "mẹo học tiếng Anh" --steps 4 --bg-video gameplay/          # Shorts chia đôi
python -m videogen "giới thiệu menu quán" --library-dir anh_mon/ --analyze-library   # ảnh/video của bạn làm nội dung chính
python -m videogen analyze menu.jpg clip.mp4                                     # đọc chữ + AI tóm tắt, in JSON
python -m videogen "cách pha cà phê drip" --web-media auto --clips-per-step 3   # nhiều clip mạng cho mỗi bước
python -m videogen "cách thay lốp xe đạp" --script-only                         # chỉ viết kịch bản
python -m videogen --script output/cach_thay_lop_xe_dap/script.json             # render lại từ kịch bản đã sửa
python main.py ...                                                               # cách gọi cũ vẫn dùng được
```

- `--library-dir`: thư mục ảnh/video. Mô tả của `pho.jpg` đặt trong file `pho.txt` cạnh nó; nếu không có file mô tả thì dùng tên file. Thêm `--library-mode auto` để AI tự chọn file phù hợp thay vì dùng tất cả.
- `--analyze-library`: đọc chữ + AI tóm tắt từng file trước khi viết kịch bản (kết quả cache trong `.videogen-analysis.json` của thư mục).
- `--image-style cover|frame|auto`: ảnh phủ kín khung, ảnh hiển thị trọn vẹn, hoặc tự động.

Xem tất cả tùy chọn: `python -m videogen -h`

### Các lệnh dành cho web app

| Lệnh | Việc làm |
|---|---|
| `python -m videogen job spec.json` | Chạy một job. Mỗi sự kiện tiến độ là một dòng `@@videogen {json}` trên stdout; kết quả ghi vào `<work_dir>/result.json` |
| `python -m videogen probe file... --thumbnail-dir dir` | In mảng JSON gồm kích thước/thời lượng của từng file và tạo thumbnail |
| `python -m videogen analyze --spec spec.json` | Phân tích asset (OCR + AI tóm tắt); mỗi asset xong là một sự kiện `{"type": "asset", ...}` |
| `python -m videogen doctor` | Kiểm tra cấu hình (API key, nguồn ảnh, font, OCR, thư viện) và in JSON |

Cấu trúc spec và kết quả được mô tả trong [engine/videogen/job.py](engine/videogen/job.py).

## API key cần thiết

Tất cả đặt trong `engine/.env`.

### 1. DeepSeek (viết kịch bản) — **bắt buộc**
- Lấy tại: https://platform.deepseek.com/api_keys
- `DEEPSEEK_API_KEY=sk-...`

### 2. Nguồn ảnh — **mặc định không cần key** (DuckDuckGo)
Thứ tự ưu tiên đặt bằng `IMAGE_PROVIDERS` (mặc định `duckduckgo,google,serper,pexels`). Một nguồn chỉ được dùng khi có key và nguồn đứng trước bị lỗi.

- **DuckDuckGo**: không cần key. Đặt vùng tìm kiếm bằng `DDG_REGION`, lọc giấy phép ảnh bằng `DDG_LICENSE`; làm quảng cáo nên đặt `ShareCommercially`. Nguồn này không có API chính thức nên đôi khi bị giới hạn tốc độ; khi đó chương trình tự chờ rồi chuyển sang nguồn sau.
- **Google Custom Search**: cần `GOOGLE_API_KEY` (dạng `AIza...`) và `GOOGLE_CSE_ID`. File `client_secret_*.json` (OAuth) không dùng được. Google đã đóng API này với khách hàng mới và sẽ tắt vào 1/1/2027.
- **Serper.dev**: cần `SERPER_API_KEY`; trả kết quả Google Images qua API.
- **Pexels**: cần `PEXELS_API_KEY` (miễn phí). Ảnh được phép dùng thương mại, **nên dùng nguồn này khi làm video quảng cáo**.

> Ảnh từ DuckDuckGo, Google hoặc Serper (khi không lọc giấy phép) thuộc bản quyền của website gốc. Chỉ nên dùng cho học tập hoặc thử nghiệm. Với quảng cáo, hãy dùng ảnh của chính bạn (tải lên thư viện) hoặc ảnh Pexels.

### 3. Clip video trên mạng — **Wikimedia Commons không cần key**
- `PEXELS_API_KEY` (dùng chung với ảnh), `PIXABAY_API_KEY` (miễn phí), `YOUTUBE_API_KEY` (hoặc `GOOGLE_API_KEY` đã bật YouTube Data API v3).
- Thứ tự nguồn: `VIDEO_PROVIDERS` (mặc định `pexels,pixabay,wikimedia,youtube`).

### 4. Đọc chữ và mô tả asset — **không cần key**
- Đọc chữ bằng Tesseract chạy trên máy; tóm tắt dùng chung key DeepSeek.
- Tùy chọn: mô hình thị giác (Gemini, OpenAI, hoặc Ollama chạy local) để mô tả ảnh không có chữ. Đặt `VISION_BASE_URL`, `VISION_MODEL`, `VISION_API_KEY`.

### 5. Giọng đọc — **không cần key**
- edge-tts, giọng mặc định `vi-VN-HoaiMyNeural`. Nếu edge-tts lỗi, chương trình tự chuyển sang gTTS.

## Cấu trúc code

```
engine/                      # Python: tạo video (process riêng, CLI)
  videogen/
    cli.py                   # lệnh make / job / probe / doctor
    job.py                   # spec JSON -> pipeline -> result.json (giao tiếp với web)
    events.py                # sự kiện tiến độ JSON cho web, thanh tiến độ cho CLI
    pipeline.py              # điều phối: kịch bản -> ảnh/video -> giọng -> video
    llm.py                   # DeepSeek: kịch bản, hashtag, chọn asset thư viện
    analyze.py               # phân tích asset: OCR (Tesseract) + AI tóm tắt
    image_search.py          # DuckDuckGo / Google / Serper / Pexels
    video_search.py          # clip được phép dùng lại: Pexels / Pixabay / Wikimedia / YouTube CC
    tts.py                   # edge-tts (+ gTTS dự phòng)
    graphics.py              # Pillow: phụ đề, nhãn bước, khung ảnh nội dung
    video_builder.py         # moviepy: Ken Burns, clip video, crossfade, chia đôi màn hình
    probe.py                 # đọc thông tin ảnh/video, tạo thumbnail
web/                         # Next.js: giao diện + API + CRM
  src/app/                   # trang (tổng quan, tạo video, hàng đợi, video, assets, khách hàng) và api/
  src/components/            # giao diện
  src/lib/server/            # db (SQLite + migration), runner (hàng đợi job), analyzer (hàng đợi phân tích asset), ingest, repo
data/                        # dữ liệu local (tự tạo khi chạy)
```

## Lưu ý

- **Bản quyền gameplay**: gameplay của game (ví dụ Subway Surfers) là tài sản của nhà phát hành. Hãy tự quay màn hình khi chơi rồi tải lên trang Assets để làm video nền.
- **Định dạng file**:
  - Ảnh hỗ trợ jpg, png, webp, gif và bmp. Ảnh HEIC của iPhone cần đổi sang JPG trước, hoặc chọn "Định dạng: Tương thích nhất" trong phần Camera của iPhone.
  - Video mp4, mov, m4v, webm, mkv, avi. Video .MOV quay dọc bằng iPhone dùng được làm asset hoặc video nền: engine tự xoay đúng chiều và thu nhỏ video lớn hơn 1280px trước khi ghép. Một số trình duyệt có thể không xem trước được video HEVC.
- **Hiệu năng**: dựng video tốn nhiều CPU, nên mặc định mỗi lần chỉ chạy một job (`JOB_CONCURRENCY`). Một video khoảng 1 phút mất 1–2 phút để dựng.
- **Font**: chương trình tự tìm Noto Sans / DejaVu Sans / Arial. Nếu chữ tiếng Việt hiển thị lỗi, đặt `FONT_PATH` trong `engine/.env`.
