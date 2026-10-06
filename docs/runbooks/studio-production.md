# Runbook: vận hành một production trên AG Studio

Từ lúc tạo production tới khi có các tập đã render, kèm cách xử lý khi một bước hỏng. Cách dựng môi trường:
`docs/runbooks/studio-local.md`. Hợp đồng API: `docs/studio-api-v3.md`. Từ pha 2 (2026-10-06) đường chính là
**giao diện chat** ở `/`; màn cũ (bảng production, các editor) vẫn ở `/productions` và trong menu `⋯ → Sửa tay`.

## 1. Trước khi tạo production

- Footage đã có trên ag-go và **đã quét** (có mô tả AI): chỉ video `usable` mới vào catalog của Claude.
- Người tạo phải xem được các folder ag-go sẽ gắn, và phải có vai `producer` trở lên trong team.
- Muốn có nghiên cứu thị trường: đặt `YOUTUBE_API_KEY`. Mỗi từ khoá tốn 100 đơn vị quota (`search.list`); kết quả
  cache 24 giờ.
- Claude giả hay thật: `docs/runbooks/studio-local.md` mục 4.

## 2. Luồng một production (giao diện chat)

| Bước | Ai làm | Trên web | Ghi chú |
|---|---|---|---|
| Video mới | Người (producer) | Trang chủ: gõ một câu, gắn folder bằng `@` ("Làm series vlog Kyoto từ @Kyoto 2025, giống kênh Mei Time…") | Tạo production nháp; Claude (`studio-intake`) tóm yêu cầu ở cột phải và hỏi lại từng câu còn thiếu |
| Bắt đầu | Người | Nút "Bắt đầu" (bật khi đủ: tên, folder, khung hình, ngôn ngữ, kênh hoặc từ khoá) | Ghi vào production rồi chạy `ag-studio-series-plan@3.0.0` |
| Nghiên cứu thị trường | Tự động → **người duyệt** | Cột phải: báo cáo xu hướng; chat để sửa; "Duyệt" | Không có video nghiên cứu thì báo cáo trống, không gọi Claude |
| R&D | Claude (Opus) → **người duyệt** | Chat để sửa ("gộp tập 3 và 4"); cột phải hiện "Bản n · k thay đổi" | Duyệt nộp đúng bản đang hiện |
| Branding | Claude → **người duyệt** | Như trên | |
| Kế hoạch tập | Claude (Opus) → **người duyệt** | Như trên; sửa kéo thả ở `⋯ → Sửa tay` (PlanEditor) | Lệch thời lượng ±20% chỉ cảnh báo |
| Timeline mỗi tập | Tự động → **người duyệt** | Mở tập ở cột trái; chat ("nhạc nhỏ lại, thêm chữ … ở clip 2") → "Áp dụng" → "Duyệt"; editor ở `⋯` | `ag-studio-episode@1.3.0`; xem trước 720p ở `⋯ → Render xem trước` (farm) |
| YouTube kit | Claude → **người duyệt** | Chat để sửa tiêu đề, mô tả, tag | Thumbnail thật chọn sau khi render |
| Render, thumbnail, xuất | Tự động | Cột phải của tập: tiến độ, video, file | Render dùng timeline **đã duyệt** |

"Duyệt" luôn là nút; gõ "ok" trong chat chỉ làm Claude hiện thẻ xác nhận. Production bắt đầu trên màn cũ
(`series-plan@1.0.0`/`@2.0.0`) vẫn sinh tập 1.2.0 không gate và chạy như trước.

## 3. Sau khi tập render xong

- **YouTube kit:** đã duyệt ở bước kit; sửa thêm trong ngăn kéo của tập ở màn cũ.
- **Thumbnail:** chọn trong các gợi ý, khung cắt từ video, hoặc ảnh tự tải lên; vẽ chữ theo branding có xem trước;
  mở sang Canva rồi lấy bản sửa về (`docs/runbooks/canva.md`).
- **Sửa hình:** chat trên timeline của tập (hoặc `⋯ → Mở editor timeline`), "Áp dụng", rồi "Render lại" ở màn cũ:
  run mới chạy lại từ `approve-timeline`, duyệt lại timeline rồi kit.
- **Tải về:** file mp4, hoặc "gói YouTube" (zip, tạo lúc tải).
- **Xuất Premiere:** `⋯ → Xuất project Premiere` (proxy 720p), hoặc màn cũ để chọn bản gốc (cần quyền tải gốc trên
  ag-go). Job farm `studio.export_premiere`; zip FCP7 XML + media + PNG chữ + `README.txt` hướng dẫn relink. Hai lỗi
  đã biết (tiếng gốc đã tắt vẫn có, gain nhạc luôn 0 dB): `docs/operations/deferred-items.md`.

## 4. Khi một bước hỏng

| Tình huống | Dấu hiệu | Cách xử lý |
|---|---|---|
| Claude trả lời sai hợp đồng hai lần (lần đầu + vòng sửa) | Video ở nhóm "Cần xử lý"; cột phải liệt kê vấn đề | Nói trong chat cách sửa ("bỏ video tối, mỗi clip một lần") rồi bấm "Chạy lại": góp ý vào prompt của bước đó |
| Claude không sửa được theo góp ý trong chat | Câu trả lời kèm "Claude chưa sửa được…" | Bản cũ giữ nguyên; nói rõ hơn, hoặc `⋯ → Sửa tay` |
| Hết hạn mức gói Claude | Chat hiện "hết hạn mức, tự thử lại lúc …"; stage log `RATE_LIMITED` | Không làm gì; tự chờ 5→60 phút rồi chạy lại |
| Tin nhắn chờ lâu | "Đang chờ lượt (n lượt trước)" | Đủ số lượt Claude cùng lúc; admin tăng ở chip header |
| Render treo | `render-final` chạy tới deadline (4 giờ) | Kiểm farm (web 3011) và render worker; huỷ run tập rồi "Render lại" |
| Muốn đổi R&D/branding sau khi đã duyệt | | Màn cũ: sửa (`PUT /productions/:id/rnd|branding`), rồi "Chạy lại từ bước này" ở `brief` |
| Muốn làm lại từ R&D | | Màn cũ: "Chạy lại từ bước này" ở `rnd` hoặc `approve-rnd` (`resumeRunFrom`) |
| Gate từ chối tài liệu | 422 kèm danh sách vấn đề | Sửa đúng các mục được liệt kê (chat hoặc Sửa tay) rồi duyệt lại |
| Huỷ | | Nút huỷ run ở màn cũ; stage đang chạy đi qua `CANCEL_REQUESTED` rồi `CANCELLED` |

Mọi lượt gọi Claude (của bước và của chat, `source = claude-chat`) và mọi lần người duyệt đều xem được ở
`⋯ → Nhật ký Claude`.

## 5. Chi phí và hạn mức

- Theo giá API (chỉ để so sánh, gói subscription không tính tiền theo token): báo cáo xu hướng khoảng 0,1 USD, kế
  hoạch tập (Opus, catalog ≤300 video) khoảng 0,9 USD, YouTube kit khoảng 0,04 USD mỗi tập. Mỗi tin nhắn chat là
  một lượt gọi nữa, cùng model với bước đang trao đổi.
- Gói subscription có hạn mức theo cửa sổ vài giờ và theo tuần, dùng chung với Claude Code/desktop của cùng tài
  khoản. Nên dùng tài khoản riêng cho Studio.
- Số lượt Claude chạy cùng lúc (chat và các bước tự chạy dùng chung): chip "Claude: n/max" ở header; admin sửa ở đó,
  chưa sửa thì theo `STUDIO_CLAUDE_MAX_CONCURRENT` (mặc định 20). Nhiều lượt thì hạn mức gói hết nhanh hơn; khi hết,
  các lượt tự chờ rồi chạy lại.
