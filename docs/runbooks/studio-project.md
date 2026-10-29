# Runbook: vận hành một dự án trên AG Studio

Một dự án là một kênh YouTube; mỗi video của kênh là một luồng chat với agent. Agent làm việc trong thư mục của dự án
như trong một repo: đọc, viết tài liệu, gọi tool của Studio. Quy trình chỉ là gợi ý — người dùng chat để làm bước nào,
quay lại bước nào cũng được; mọi kết quả là file sửa được trực tiếp (tab Tài liệu) hoặc nhờ agent sửa.

## 1. Tạo dự án

- Trang team → **Dự án mới**: tên, link kênh (nếu có), ngôn ngữ, khung hình (16:9 / 9:16). Cần vai producer.
- Studio tạo thư mục dự án (`CLAUDE.md`, `context/`, `research/`, `channel/`, `videos/`, `memory/lessons.md`) và luồng
  **Kênh**. Sửa `CLAUDE.md` (tab Tài liệu, mục "Ghi chú cho agent") để nói về kênh, khán giả, giọng văn, điều cấm: mọi luồng chat đều đọc nó.
- Cài đặt dự án (nút ⚙ trên thanh tiêu đề): model, skill team dùng cho dự án, tự sửa lỗi file, tự làm tiếp khi việc nền xong, quy trình riêng.

## 2. Nguồn

- Tab **Nguồn** → **Thêm project** ag-go: chỉ project mà **chủ dự án** thấy video bên trong (agent và render dùng quyền
  của chủ dự án). Agent tìm video trong đó bằng `footage_search`.
- Nhiều project/video: dòng tóm tắt đầu tab ("78 video · 70 sẵn sàng · 5 đang chuẩn bị · 3 lỗi", bấm một phần để lọc), mục
  **Footage** có ô tìm, lọc trạng thái, gom theo video ở trang dự án, nút **Chuẩn bị các video chưa chuẩn bị** và **Thử lại
  các video lỗi** (editor). Tài liệu, ảnh, audio và video mẫu ở mục **Tài liệu, ảnh, audio**.
- Tài liệu (PDF, markdown, CSV…), ảnh, audio: **Tải lên** → `context/…`. File Word: lưu thành PDF trước.
- Giọng đọc và nhạc nền: thẻ đầu tiên của tab **Nguồn**. **Giọng đọc** (cần producer): **Tải giọng mẫu** (3–20 giây) hoặc
  **Chọn file đã tải**, rồi khai nguồn gốc (giọng máy / của tôi / có bản quyền); **Không lời dẫn** (lời thành phụ đề); **Bỏ
  chọn**. **Nhạc nền** (cần editor): **Tải nhạc** (≤ 100 MB, dùng ngay), **Chọn từ kho nhạc** (nghe thử rồi chọn), **Chọn file
  đã tải** (cả file audio bỏ vào `context/audio/` qua tab Tài liệu), **Tự chọn theo mood** (bỏ nhạc riêng: khi dựng timeline Studio
  lấy bài trong kho nhạc theo mood của kế hoạch dựng, rồi branding). Nút không dùng được thì mờ và nói lý do (thiếu vai, máy
  Studio chưa có ffmpeg). Giọng và nhạc không bao giờ lấy từ ag-go.

## 3. Kênh: nghiên cứu, chiến lược, branding

- **Chạy nghiên cứu** (nhóm Nghiên cứu, tab **Tài liệu**): crawl YouTube (xu hướng, theo chủ đề, kênh top, video top của một kênh). Ước lượng hạn mức API hiện
  trước khi chạy; kết quả ở `research/<ngày>-<chủ đề>.md`. Agent cũng crawl được (crawl lớn cần người xác nhận thẻ).
- Chat ở luồng Kênh theo các bước gợi ý (thanh bước trên chat): báo cáo thị trường, chiến lược kênh, phong cách dựng
  (tuỳ chọn; học từ video mẫu cần bấm xác nhận thẻ tải video — YouTube chặn máy chủ Studio thì máy farm có yt-dlp tải
  thay, đo xong xoá ngay; hoặc tải video mẫu lên tab Nguồn), branding (`channel/branding.md`: kiểu chữ trên video, tâm
  trạng nhạc, kiểu thumbnail). Lỗi file (ví dụ chữ khó đọc) hiện ở bước và ở tab Tài liệu.
- Tab **Phong cách**: ở luồng Kênh mở phong cách dựng, video mẫu, nhờ agent học phong cách. Ở một video: chọn font,
  cỡ, màu chữ, viền, hộp, bóng, màu hình, khớp màu cho riêng video đó (thắng kế hoạch dựng và branding); **Lưu cho video
  này** áp ngay vào timeline mới nhất (bản xem trước kế tiếp thấy), **Bỏ lựa chọn riêng** để theo kế hoạch/branding lại.

## 4. Một video

1. **Video mới** (thanh trái): nói video về gì; chọn có học từ chat cũ không (bài học chung, hoặc vài luồng cụ thể).
   Bảo agent làm một video ngay trong chat Kênh cũng được: agent tạo (hoặc chọn) video rồi chuyển việc sang chat của
   video đó (`video_create` có `start`, `video_focus`), trang tự mở chat video; chat Kênh giữ thẻ link sang đó. Việc của
   video (footage cho video, timeline, render) gọi từ luồng khác bị từ chối (`use_video_thread`).
2. Agent viết brief, tìm và thêm video ag-go, **chuẩn bị** chúng (việc nền: chép cảnh, khung hình, tờ ghép và lời thoại
   ag-go đã chuẩn bị sẵn — vài giây; video ag-go chưa chuẩn bị thì Studio xin ag-go chạy ngay và chờ, thẻ việc hiện
   "Đang chờ máy / Đang cắt cảnh / Đang đọc lời thoại", tiến độ, Dừng).
3. Chọn cảnh (`survey.json`), kế hoạch dựng (`edit-plan.json`), dựng timeline, render xem trước. Xem ở tab **Xem trước**.
   Muốn sửa: nói với agent ("bỏ cảnh 3", "chữ to hơn", "mở đầu nhanh hơn") hoặc sửa file rồi bảo dựng lại.
4. Gói YouTube (`youtube-kit.md`), thumbnail (`thumbnails/`).
5. **Bản cuối**: agent đề xuất thẻ "Render bản cuối"; producer bấm Xác nhận (hoặc tự bấm ở tab Xem trước). Xuất Premiere tương tự.

## 5. Khi có sự cố

- Việc nền đứng ở "Farm · đang chờ máy nhận": máy farm offline (xem web farm), hoặc không máy nào nhận loại việc đó. Sau
  `STUDIO_FARM_QUEUE_TIMEOUT_MINUTES` việc tự dừng và báo vào chat; bước chuẩn bị vẫn giữ cảnh và khung hình, chỉ thiếu lời thoại.
- Lượt agent chờ hạn mức gói: tin nhắn hiện "chờ hạn mức" tới giờ thử lại. Dừng lượt bằng nút Dừng (thay nút Gửi).
- Thẻ xác nhận "hết hiệu lực": timeline đã đổi hoặc quá 24 giờ — nhờ agent đề xuất lại.
- File Premiere không tải được ("chưa có quyền xem footage"): quyền ag-go của chính bạn không phủ footage đóng gói trong
  file đó (chia sẻ dự án không mở rộng quyền footage). Bản xem trước và bản cuối (mp4) thì ai trong dự án cũng xem và tải được.

## 6. Chi phí và hạn mức

- Mỗi lượt chat là một lượt Claude Code (ghi `llm_calls`, nguồn `claude-agent`); cap chung với số lượt Claude của Studio
  (màn Hàng đợi). Tự làm tiếp sau việc nền tối đa 3 lượt liên tiếp không có tin người dùng.
- YouTube Data API: 10 000 đơn vị/ngày; một tìm theo chủ đề ≈ 101 đơn vị mỗi 50 video. Không có khoá thì dùng yt-dlp.
