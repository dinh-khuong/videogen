# VideoGen Studio — Tạo video hướng dẫn bằng AI

Ứng dụng web (Next.js) để tạo video hướng dẫn tự động và quản lý thư viện ảnh, video và khách hàng (CRM). Việc dựng video do một **engine Python** chạy ở tiến trình riêng đảm nhận. Engine này cũng dùng độc lập được như một CLI.

Quy trình tạo một video: **chủ đề** → DeepSeek viết kịch bản → lấy ảnh (từ thư viện của bạn hoặc tìm trên mạng) → edge-tts đọc lời bình → dựng video có phụ đề, nhãn bước, hiệu ứng Ken Burns, chuyển cảnh.

```
┌──────────── web/ (Next.js) ────────────┐        ┌──────── engine/ (Python) ────────┐
│ Giao diện: tạo video, hàng đợi,        │ spawn  │ python -m videogen job spec.json │
│ thư viện ảnh/video, CRM                │ ─────► │  kịch bản → ảnh → giọng → video  │
│ API + SQLite + hàng đợi job            │ ◄───── │  sự kiện tiến độ JSON (stdout)   │
│ Lưu file: data/media, data/app.db      │ result │  result.json                     │
└────────────────────────────────────────┘        └──────────────────────────────────┘
```

- **web/**: toàn bộ phần CRM và quản lý, gồm giao diện, API, database SQLite và hàng đợi job. Web không tự dựng video.
- **engine/**: toàn bộ phần tạo video. Engine không biết gì về database: nó nhận một file spec JSON và trả về `result.json`. Web app đưa kết quả đó vào thư viện.
- **data/**: dữ liệu local, gồm `app.db` (SQLite), `media/` (ảnh, video, thumbnail) và `jobs/` (thư mục làm việc của từng job). Thư mục này không được commit.

## Tính năng

- **Tạo video**: gồm khung 16:9, 9:16, 1:1 và **Shorts chia đôi** (nội dung ở trên, video nền như gameplay ở dưới). Có thể chọn giọng đọc, tốc độ đọc, ngôn ngữ và số bước.
- **Ảnh là nội dung chính, không chỉ làm nền**:
  - *AI chọn từ thư viện*: AI đọc mô tả và hashtag của ảnh trong thư viện, rồi gán ảnh phù hợp cho từng bước. Bước nào không có ảnh khớp thì tự tìm trên mạng.
  - *Dùng ảnh tôi chọn*: các ảnh bạn chọn (sản phẩm, món ăn, ảnh chụp màn hình...) là nội dung chính. AI viết kịch bản xoay quanh từng ảnh, theo đúng thứ tự bạn chọn.
  - Ảnh thư viện hiển thị **trọn vẹn trong khung** (không bị cắt) trên nền mờ. Ảnh tìm trên mạng phủ kín khung. Bạn có thể chọn cách hiển thị khác trong form tạo video.
- **Hàng đợi job**:
  - Mỗi video được dựng bởi một tiến trình Python riêng, xử lý lần lượt từng job.
  - Có tiến độ theo từng giai đoạn, log của engine, nút hủy (dừng cả ffmpeg) và nút chạy lại.
  - Nếu server tắt giữa chừng, job đang chạy được đánh dấu lỗi để chạy lại.
- **Thư viện ảnh và video**:
  - Mỗi ảnh/video có mô tả. Hashtag trong mô tả (`#caphe #huongdan`) tự thành tag để lọc.
  - Ảnh tìm được khi tạo video được lưu vào thư viện, kèm mô tả, hashtag và nguồn.
  - Ảnh trùng nội dung chỉ lưu một lần.
  - Video có tiêu đề, mô tả và hashtag do AI viết sẵn để đăng mạng xã hội, kèm nút sao chép.
  - Bạn có thể **sửa kịch bản, đổi ảnh từng bước rồi tạo lại video**.
- **CRM khách hàng**:
  - Lưu trạng thái (tiềm năng → khách hàng), số điện thoại, email, nguồn, ghi chú có hashtag và ngày hẹn chăm sóc.
  - Nhật ký chăm sóc (ghi chú, gọi điện, email, gặp mặt).
  - Gắn video đã làm cho khách, hoặc tạo video cho khách ngay từ hồ sơ.

## Cài đặt

Cần **Python 3.10+** và **Node.js 20+**.

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
python -m videogen "giới thiệu menu quán" --library-dir anh_mon/                # ảnh của bạn làm nội dung chính
python -m videogen "cách thay lốp xe đạp" --script-only                         # chỉ viết kịch bản
python -m videogen --script output/cach_thay_lop_xe_dap/script.json             # render lại từ kịch bản đã sửa
python main.py ...                                                               # cách gọi cũ vẫn dùng được
```

- `--library-dir`: thư mục ảnh. Mô tả của ảnh `pho.jpg` đặt trong file `pho.txt` cạnh nó; nếu không có file mô tả thì dùng tên file. Thêm `--library-mode auto` để AI chỉ dùng những ảnh phù hợp thay vì dùng tất cả.
- `--image-style cover|frame|auto`: ảnh phủ kín khung, ảnh hiển thị trọn vẹn, hoặc tự động.

Xem tất cả tùy chọn: `python -m videogen -h`

### Các lệnh dành cho web app

| Lệnh | Việc làm |
|---|---|
| `python -m videogen job spec.json` | Chạy một job. Mỗi sự kiện tiến độ là một dòng `@@videogen {json}` trên stdout; kết quả ghi vào `<work_dir>/result.json` |
| `python -m videogen probe file... --thumbnail-dir dir` | In mảng JSON gồm kích thước/thời lượng của từng file và tạo thumbnail |
| `python -m videogen doctor` | Kiểm tra cấu hình (API key, nguồn ảnh, font, thư viện) và in JSON |

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

### 3. Giọng đọc — **không cần key**
- edge-tts, giọng mặc định `vi-VN-HoaiMyNeural`. Nếu edge-tts lỗi, chương trình tự chuyển sang gTTS.

## Cấu trúc code

```
engine/                      # Python: tạo video (process riêng, CLI)
  videogen/
    cli.py                   # lệnh make / job / probe / doctor
    job.py                   # spec JSON -> pipeline -> result.json (giao tiếp với web)
    events.py                # sự kiện tiến độ JSON cho web, thanh tiến độ cho CLI
    pipeline.py              # điều phối: kịch bản -> ảnh -> giọng -> video
    llm.py                   # DeepSeek: kịch bản, hashtag, chọn ảnh thư viện
    image_search.py          # DuckDuckGo / Google / Serper / Pexels
    tts.py                   # edge-tts (+ gTTS dự phòng)
    graphics.py              # Pillow: phụ đề, nhãn bước, khung ảnh nội dung
    video_builder.py         # moviepy: Ken Burns, crossfade, chia đôi màn hình
    probe.py                 # đọc thông tin ảnh/video, tạo thumbnail
web/                         # Next.js: giao diện + API + CRM
  src/app/                   # trang (tổng quan, tạo video, hàng đợi, video, ảnh, khách hàng) và api/
  src/components/            # giao diện
  src/lib/server/            # db (SQLite + migration), runner (hàng đợi, spawn Python), ingest, repo
data/                        # dữ liệu local (tự tạo khi chạy)
```

## Lưu ý

- **Bản quyền gameplay**: gameplay của game (ví dụ Subway Surfers) là tài sản của nhà phát hành. Hãy tự quay màn hình khi chơi rồi tải lên mục Video để làm video nền.
- **Định dạng file**:
  - Ảnh hỗ trợ jpg, png, webp, gif và bmp. Ảnh HEIC của iPhone cần đổi sang JPG trước, hoặc chọn "Định dạng: Tương thích nhất" trong phần Camera của iPhone.
  - Video .MOV quay bằng iPhone dùng làm video nền được. Một số trình duyệt có thể không xem trước được video HEVC.
- **Hiệu năng**: dựng video tốn nhiều CPU, nên mặc định mỗi lần chỉ chạy một job (`JOB_CONCURRENCY`). Một video khoảng 1 phút mất 1–2 phút để dựng.
- **Font**: chương trình tự tìm Noto Sans / DejaVu Sans / Arial. Nếu chữ tiếng Việt hiển thị lỗi, đặt `FONT_PATH` trong `engine/.env`.
