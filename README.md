# VideoGen Studio — Tạo video hướng dẫn bằng AI

Ứng dụng web (Next.js) để tạo video hướng dẫn tự động và quản lý assets (ảnh, video nguồn, audio), video đã tạo và khách hàng (CRM). Việc dựng video do một **engine Python** chạy ở tiến trình riêng đảm nhận. Engine này cũng dùng độc lập được như một CLI.

Quy trình tạo một video: **chủ đề** → DeepSeek viết kịch bản (hướng dẫn, top danh sách, mẹo, sự thật thú vị, quảng cáo, kể chuyện) và tự chọn ảnh/video từ Assets (bước nào không có asset phù hợp thì tìm clip/ảnh trên mạng) → edge-tts đọc lời bình (hơn 50 giọng, 10 ngôn ngữ) → dựng video có phụ đề karaoke khớp từng từ, nhãn bước động, chuyển cảnh đa dạng, hiệu ứng âm thanh.

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

- **Đạo diễn AI** (mặc định): AI làm việc như một người dựng phim. Nó không viết kịch bản một lần rồi chạy cứng nhắc
  mà tự gọi công cụ qua nhiều lượt. **Số bước và số cảnh do AI quyết định.**
  - Tìm tư liệu: tìm trong Assets (kể cả kho meme nhập từ dataset), tìm và tải clip/ảnh trên mạng, xem kỹ từng asset.
  - Dựng storyboard: thêm, sửa, xóa, đổi chỗ cảnh. Sau đó **tự duyệt** với bộ nhận xét tự động (dài hay ngắn so với
    mục tiêu, giọng đều đều, cảnh thiếu hình, hình bị lặp, lạm dụng hiệu ứng, chưa dùng meme...) rồi sửa tiếp tới khi chốt.
  - **Giọng điệu biến hóa theo từng câu**: mỗi câu thoại có cảm xúc riêng (hào hứng, sốc, kịch tính, thì thầm, cà khịa,
    tỉnh bơ, liến thoắng...). Engine đổi tốc độ, cao độ và khoảng ngừng cho từng câu rồi ghép lại, phụ đề vẫn khớp từng từ.
    Có **giọng phụ** khác giới chen ngang hoặc đối đáp, như hai người dẫn.
  - **Chọn hình theo cảm xúc**: AI tìm ảnh/clip theo cảm xúc của từng câu (sốc, cà khịa, tỉnh bơ...), ưu tiên meme và clip
    reaction; chuyển động ảnh cũng theo cảm xúc (kịch tính thì đẩy chậm vào, hào hứng thì lia, tỉnh bơ thì đứng yên), không
    gò bó một kiểu.
  - **Video lồng trên ảnh**: cảnh dùng ảnh nền vẫn có clip chạy bên trong — clip lồng trong khung nhỏ ở một góc (hoặc khung lớn
    giữa) suốt cảnh, hay clip reaction bật ra đúng câu thoại rồi biến mất. Clip lồng được tắt tiếng và tự lặp.
  - **Câu cửa miệng meme Việt**: "vắt cực khô", "lỗi như thế này là đúng rồi", "đây không phải bug, đây là tính năng",
    "người ở hành tinh Nga", "người Florida", "hảo hán", "X quốc dân", "đứa nào tạo ra cái này?", "toang rồi", "còn cái nịt"...
    AI chèn vào chỗ đắt nhất và tìm ảnh/clip meme hợp với câu đó (vd "người Florida" ~ "Florida man").
  - **Meme**: chữ meme trên/dưới hình ("KHI BẠN..."), sticker meme/reaction (ảnh hoặc clip) bật ra theo câu, chữ nhấn mạnh to giữa khung,
    âm thanh meme (bùm, ting, đĩa rít, trống dồn, tèn ten, cốp — tự tổng hợp, không vướng bản quyền), zoom giật, rung khung, zoom chậm kịch tính.
  - Trang job hiện **nhật ký Đạo diễn AI** trực tiếp: từng suy nghĩ, hành động và kết quả.
  - **Góp ý để AI làm lại**: dưới video đã tạo, viết góp ý (vd "thêm meme khi nói về giá, hook mạnh hơn"). AI mở lại
    storyboard cũ và sửa theo góp ý.
  - Cần mô hình hỗ trợ gọi công cụ (function calling). `deepseek-chat` có sẵn khả năng này; đặt mô hình khác bằng `DIRECTOR_MODEL`.
  - Chế độ **Kịch bản nhanh** (khung cố định: mở đầu, các bước, lời kết) vẫn còn, dùng khi cần nhanh và ít lượt gọi AI.
- **Tạo video**: gồm khung 16:9, 9:16, 1:1 và **Shorts chia đôi** (nội dung ở trên, video nền như gameplay ở dưới).
  - **Mẫu nhanh**: TikTok/Reels viral, YouTube hướng dẫn, Quảng cáo sản phẩm, Kể chuyện thư giãn, Kiến thức — một lần bấm đặt sẵn khung hình, nhịp dựng, phụ đề, giọng... rồi tinh chỉnh tiếp.
  - **Loại video**: hướng dẫn, top danh sách, mẹo hay, sự thật thú vị, quảng cáo/giới thiệu, kể chuyện. Nhãn trong video đổi theo loại ("Bước 1", "#1"...).
  - **Giọng văn** (thân thiện, hài hước, chuyên nghiệp, bán hàng, Gen Z... hoặc tự nhập) và **độ dài** (ngắn < 45 giây, vừa, dài).
  - **Tạo hàng loạt**: mỗi dòng một chủ đề, tạo tối đa 20 video cùng cài đặt.
  - Form **nhớ cài đặt của lần tạo trước**; trang job có nút **"Tạo video tương tự"** để điền sẵn cài đặt của job đó.
- **Giọng đọc**:
  - 10 ngôn ngữ (Việt, Anh, Trung, Nhật, Hàn, Pháp, Tây Ban Nha, Đức, Thái, Indonesia), hơn 50 giọng; giọng **đa ngôn ngữ** (Ava, Andrew, Emma, Brian...) đọc được cả tiếng Việt.
  - **Nghe thử** giọng ngay trong form; **sắc thái giọng** (trầm ấm, kể chuyện, trẻ trung, quảng cáo sôi nổi, tin tức) đặt nhanh tốc độ + cao độ.
  - **Thanh trượt cao độ** (−30…+30 Hz): kéo xong là tự phát giọng mẫu đúng mức vừa chỉnh. Mẫu do engine tạo qua cùng đường
    xử lý với giọng trong video (cùng giọng, tốc độ, cao độ, hiệu ứng) nên nghe thử thế nào thì video y như vậy; chỉnh tiếp khi
    mẫu cũ chưa xong thì mẫu cũ bị hủy, dòng "Đang phát" luôn ghi rõ mức đang nghe.
  - **AI tinh chỉnh giọng cho hợp video** (bật mặc định, tắt được): AI viết kịch bản / Đạo diễn AI được chỉnh thêm cao độ (±15 Hz)
    và tốc độ (±20%) quanh mức bạn chọn theo không khí video (chuyện ma trầm, chậm hơn; quảng cáo sáng, nhanh hơn), kèm lý do.
    Trang video hiện mức AI đã chỉnh, nghe thử được cả mức đó lẫn mức ban đầu; "Sửa kịch bản & tạo lại" bắt đầu từ mức AI đã chỉnh.
  - **Giọng thứ hai đọc xen kẽ** các bước chẵn, như hai người dẫn.
  - **Giọng kiểu kênh quen thuộc** (một lần bấm): kênh kiến thức, "chị Google", "anh Google", ngọng Tây dễ thương, bé ngọng, sóc chuột lầy lội, kể chuyện ma, robot, tổng đài.
  - **Giọng "chị Google"** và **"anh Google"** (gTTS, miễn phí; Google chỉ có giọng nữ nên giọng nam là cùng giọng đó hạ trầm) và **FPT.AI** (Ban Mai, Lê Minh, Lan Nhi... — giọng Việt tự nhiên, cần `FPT_AI_API_KEY`).
  - **Hiệu ứng giọng**: dễ thương/ngọng nhẹ, sóc chuột, trầm ma mị, robot, radio, vang. Xử lý bằng ffmpeg, giữ nguyên tốc độ nên phụ đề vẫn khớp.
- **Hiệu ứng làm video sinh động**:
  - **Nhịp dựng** chậm / vừa / nhanh: độ dài mỗi cảnh, tốc độ chuyển, biên độ zoom.
  - **Chuyển cảnh** đa dạng: trượt đẩy, lia máy nhanh (có nhòe chuyển động), zoom xuyên cảnh, quét ngang, mở vòng tròn, lóe sáng, mờ chồng; mặc định tự luân phiên.
  - Ảnh có nhiều kiểu chuyển động Ken Burns (zoom vào/ra, lia ngang/dọc); clip video zoom chậm vào giữa.
  - **Phụ đề khớp từng từ** với giọng đọc (dùng mốc thời gian của edge-tts): kiểu karaoke tô màu từ đang đọc, chữ to viền đen, hoặc chữ trong khung tối.
  - Title card và nhãn bước có hoạt ảnh (trồi lên, trượt vào, bật ra); **màu chủ đạo** tùy chọn.
  - **Màu phim**: rực rỡ, ấm áp, mát lạnh, điện ảnh, hoài cổ, đen trắng.
  - **Thanh tiến độ**, **hiệu ứng âm thanh** tự tổng hợp ("vút" khi chuyển cảnh, "tách" khi hiện nhãn — không dùng file mẫu nên không lo bản quyền).
  - **Logo** (ảnh trong Assets) ở góc trên phải và **lời kêu gọi cuối video** (vd số điện thoại, ưu đãi) dạng nút nổi bật.
- **Giao diện sáng / tối / theo hệ thống** (nút chuyển ở thanh bên).
- **Không còn tiếng khi không xem**: video/audio trong trang tự dừng khi thu nhỏ cửa sổ hoặc chuyển tab, khi cuộn/thu gọn
  khiến video khuất khỏi màn hình, khi đóng hộp thoại hay chuyển trang; mỗi lúc chỉ một nguồn phát (kể cả giọng nghe thử).
  Video đang xem toàn màn hình hoặc hình-trong-hình (PiP) được giữ nguyên.
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
  - Bạn có thể **sửa kịch bản, đổi ảnh/video từng bước rồi tạo lại video**, kể cả đổi giọng đọc và hiệu ứng (không cần AI viết lại).
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

## Nhập ảnh từ dataset (Hugging Face)

Đưa cả bộ ảnh của một dataset vào Assets, ví dụ [not-lain/meme-dataset](https://huggingface.co/datasets/not-lain/meme-dataset). Chạy web app trước (`npm run dev`), rồi trong thư mục `web/`:

```bash
npm run import-dataset -- not-lain/meme-dataset
```

```bash
npm run import-dataset -- not-lain/meme-dataset --limit 200 --tag meme
```

- Lệnh tự dùng Python của engine (`engine/.venv` hoặc `PYTHON_BIN`) và web app ở `http://localhost:$PORT` (mặc định 3000). Cần cài `datasets` (có trong `engine/requirements.txt`).
- Dataset được đọc dạng streaming (không phải tải hết trước). Lệnh tự tìm cột ảnh và các cột nhãn (nhãn phân loại, tên, chú thích, danh sách tag); chỉ định tay bằng `--image-col`, `--label-col` nếu cần.
- Nhãn của dataset được ghi vào mô tả asset kèm hashtag (vd `#memedataset #drakehotlinebling #funny`). Sau đó web app tự phân tích từng ảnh như ảnh tải lên: đọc chữ, AI tóm tắt và gợi ý hashtag dựa trên chính các nhãn đó (thêm mô hình thị giác nếu đặt `VISION_MODEL`).
- Ảnh trùng nội dung chỉ lưu một lần, nên chạy lại lệnh không tạo bản sao.
- `--out thư-mục`: chỉ lưu ảnh + file mô tả `.txt` ra thư mục (không cần web app), dùng được với `python -m videogen ... --library-dir thư-mục`.
- Cũng chạy được trực tiếp: `cd engine && python -m videogen import-dataset not-lain/meme-dataset`. `source` có thể là thư mục ảnh hoặc file parquet trên máy.
- Kiểm tra giấy phép của dataset trước khi dùng ảnh cho video thương mại (ảnh meme thường thuộc bản quyền của người khác).

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
python -m videogen "5 quán phở ngon Hà Nội" --type listicle --aspect 9:16 --pacing fast --subtitles karaoke --sfx --progress-bar
python -m videogen "giới thiệu quán Mộc" --type promo --tone "thuyết phục" --cta "Gọi ngay 0909 123 456" --logo logo.png --accent "#43a047"
python -m videogen "chuyện cổ tích Tấm Cám" --type story --voice vi-VN-HoaiMyNeural --voice2 vi-VN-NamMinhNeural --rate=-10% --pitch=-6Hz
python -m videogen "5 sự thật về mèo" --type facts --voice gtts:vi --rate=+15% --voice-effect cute   # chị Google ngọng nhẹ
python -m videogen "5 sự thật về mèo" --director --aspect 9:16 --tone "lầy lội" --library-dir meme/ --library-mode auto   # Đạo diễn AI
python -m videogen "5 sự thật về mèo" --director --base-script output/x/script.json --feedback "thêm meme, hook mạnh hơn"     # sửa theo góp ý
python -m videogen "chuyện ma căn nhà cũ" --type story --director --pitch=+4Hz --ai-voice   # AI được chỉnh giọng cho hợp video
python -m videogen voice-sample --voice en-US-AvaMultilingualNeural --out mau.mp3   # nghe thử giọng
python -m videogen "cách thay lốp xe đạp" --script-only                         # chỉ viết kịch bản
python -m videogen --script output/cach_thay_lop_xe_dap/script.json             # render lại từ kịch bản đã sửa
python main.py ...                                                               # cách gọi cũ vẫn dùng được
```

- `--library-dir`: thư mục ảnh/video. Mô tả của `pho.jpg` đặt trong file `pho.txt` cạnh nó; nếu không có file mô tả thì dùng tên file. Thêm `--library-mode auto` để AI tự chọn file phù hợp thay vì dùng tất cả.
- `--analyze-library`: đọc chữ + AI tóm tắt từng file trước khi viết kịch bản (kết quả cache trong `.videogen-analysis.json` của thư mục).
- `--image-style cover|frame|auto`: ảnh phủ kín khung, ảnh hiển thị trọn vẹn, hoặc tự động.
- Giá trị âm cho tốc độ/cao độ cần viết liền bằng dấu `=` (`--rate=-10%`, `--pitch=-6Hz`), nếu không argparse hiểu nhầm là một tùy chọn.
- Phong cách: `--pacing slow|normal|fast`, `--transition mix|slide|whip|zoom|wipe|circle|flash|fade`, `--subtitles auto|karaoke|outline|box|none`, `--filter none|vivid|warm|cool|cinematic|vintage|bw`, `--accent "#e95420"`, `--progress-bar`, `--sfx`, `--logo`, `--cta`.

Xem tất cả tùy chọn: `python -m videogen -h`

### Các lệnh dành cho web app

| Lệnh | Việc làm |
|---|---|
| `python -m videogen job spec.json` | Chạy một job. Mỗi sự kiện tiến độ là một dòng `@@videogen {json}` trên stdout; kết quả ghi vào `<work_dir>/result.json` |
| `python -m videogen probe file... --thumbnail-dir dir` | In mảng JSON gồm kích thước/thời lượng của từng file và tạo thumbnail |
| `python -m videogen analyze --spec spec.json` | Phân tích asset (OCR + AI tóm tắt); mỗi asset xong là một sự kiện `{"type": "asset", ...}` |
| `python -m videogen voice-sample --voice=... --rate=... --pitch=... --out=file.mp3` | Tạo file nghe thử giọng đọc (nút "Nghe thử" trong form) |
| `python -m videogen doctor` | Kiểm tra cấu hình (API key, nguồn ảnh, font, OCR, thư viện) và in JSON |

Cấu trúc spec và kết quả được mô tả trong [engine/videogen/job.py](engine/videogen/job.py).

## API key cần thiết

Tất cả đặt trong `engine/.env`.

### 1. DeepSeek (viết kịch bản) — **bắt buộc**
- Lấy tại: https://platform.deepseek.com/api_keys
- `DEEPSEEK_API_KEY=sk-...`

### 2. Nguồn ảnh — **mặc định không cần key** (DuckDuckGo)
Thứ tự ưu tiên đặt bằng `IMAGE_PROVIDERS` (mặc định `duckduckgo,google,brave,serper,pexels,pixabay`). Một nguồn chỉ được dùng khi có key và nguồn đứng trước bị lỗi.
Trong form tạo video, mục **Công cụ tìm ảnh** cho chọn ưu tiên một nguồn (Brave, Google, DuckDuckGo...) cho từng video; các nguồn khác vẫn làm dự phòng. Dòng lệnh: `--search-engine brave`.

- **DuckDuckGo**: không cần key. Đặt vùng tìm kiếm bằng `DDG_REGION`, lọc giấy phép ảnh bằng `DDG_LICENSE`; làm quảng cáo nên đặt `ShareCommercially`. Nguồn này không có API chính thức nên đôi khi bị giới hạn tốc độ; khi đó chương trình tự chờ rồi chuyển sang nguồn sau.
- **Google Custom Search**: cần `GOOGLE_API_KEY` (dạng `AIza...`) và `GOOGLE_CSE_ID`. File `client_secret_*.json` (OAuth) không dùng được. Google đã đóng API này với khách hàng mới và sẽ tắt vào 1/1/2027.
- **Serper.dev**: cần `SERPER_API_KEY`; trả kết quả Google Images qua API.
- **Brave Search**: cần `BRAVE_API_KEY` (có gói miễn phí, lấy tại https://api-dashboard.search.brave.com). Đặt quốc gia ưu tiên bằng `BRAVE_COUNTRY` (vd `VN`).
- **Pexels**: cần `PEXELS_API_KEY` (miễn phí). Ảnh được phép dùng thương mại, **nên dùng nguồn này khi làm video quảng cáo**.
- **Pixabay**: dùng chung `PIXABAY_API_KEY` với clip video. Ảnh được phép dùng thương mại.

> Ảnh từ DuckDuckGo, Google, Brave hoặc Serper (khi không lọc giấy phép) thuộc bản quyền của website gốc. Chỉ nên dùng cho học tập hoặc thử nghiệm. Với quảng cáo, hãy dùng ảnh của chính bạn (tải lên thư viện) hoặc ảnh Pexels/Pixabay.

### 3. Clip video trên mạng — **Wikimedia Commons không cần key**
- `PEXELS_API_KEY` (dùng chung với ảnh), `PIXABAY_API_KEY` (miễn phí), `YOUTUBE_API_KEY` (hoặc `GOOGLE_API_KEY` đã bật YouTube Data API v3).
- Thứ tự nguồn: `VIDEO_PROVIDERS` (mặc định `pexels,pixabay,wikimedia,youtube`).

### 4. Đọc chữ và mô tả asset — **không cần key**
- Đọc chữ bằng Tesseract chạy trên máy; tóm tắt dùng chung key DeepSeek.
- Tùy chọn: mô hình thị giác (Gemini, OpenAI, hoặc Ollama chạy local) để mô tả ảnh không có chữ. Đặt `VISION_BASE_URL`, `VISION_MODEL`, `VISION_API_KEY`.

### 5. Giọng đọc — **không cần key** (trừ FPT.AI)
- edge-tts, giọng mặc định `vi-VN-HoaiMyNeural`. Nếu edge-tts lỗi, chương trình tự chuyển sang gTTS (khi đó phụ đề chia theo độ dài câu thay vì khớp từng từ).
- `TTS_VOICE` / `--voice` nhận thêm `gtts:vi` ("chị Google"), `gtts:vi-male` ("anh Google") và `fpt:<giọng>` (FPT.AI, cần `FPT_AI_API_KEY` lấy tại https://console.fpt.ai). Giọng FPT lỗi thì tự chuyển sang gTTS.
- Danh sách đầy đủ: `edge-tts --list-voices`. Giọng có chữ `Multilingual` đọc được nhiều ngôn ngữ, kể cả tiếng Việt.
- Video tiếng Trung/Nhật/Hàn/Thái cần font hỗ trợ chữ đó, vd `sudo apt install fonts-noto-cjk fonts-noto-core` (hoặc đặt `FONT_PATH`).

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
    image_search.py          # DuckDuckGo / Google / Brave / Serper / Pexels / Pixabay
    video_search.py          # clip được phép dùng lại: Pexels / Pixabay / Wikimedia / YouTube CC
    tts.py                   # edge-tts (+ gTTS dự phòng), mốc thời gian từng từ, giọng mẫu
    style.py                 # phong cách dựng (nhịp, chuyển cảnh, phụ đề, màu...) + nhãn theo ngôn ngữ
    effects.py               # chuyển cảnh, bộ lọc màu, chuyển động Ken Burns, hoạt ảnh lớp chữ
    subtitles.py             # chia phụ đề + căn thời điểm từng từ (karaoke)
    sfx.py                   # hiệu ứng âm thanh tổng hợp bằng numpy
    graphics.py              # Pillow: font theo ngôn ngữ, phụ đề, nhãn bước, title card, lời kêu gọi, logo
    video_builder.py         # ghép từng khung hình theo timeline, chia đôi màn hình, trộn âm thanh
    probe.py                 # đọc thông tin ảnh/video, tạo thumbnail
    dataset_import.py        # nhập ảnh từ dataset Hugging Face / thư mục vào Assets kèm nhãn
web/                         # Next.js: giao diện + API + CRM
  src/app/                   # trang (tổng quan, tạo video, hàng đợi, video, assets, khách hàng) và api/
  src/components/            # giao diện (video-style-fields: giọng đọc + phong cách, theme-toggle: sáng/tối)
  src/lib/video-options.ts   # danh sách giọng, ngôn ngữ, loại video, phong cách, mẫu nhanh (dùng chung client/server)
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
