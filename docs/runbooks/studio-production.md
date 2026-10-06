# Runbook: vận hành một production trên AG Studio

Từ lúc tạo production tới khi có các tập đã render, kèm cách xử lý khi một bước hỏng. Cách dựng môi trường:
`docs/runbooks/studio-local.md`. Hợp đồng API: `docs/studio-api-v3.md`.

## 1. Trước khi tạo production

- Footage đã có trên ag-go và **đã quét** (có mô tả AI): chỉ video `usable` mới vào catalog của Claude.
- Người tạo phải xem được các folder ag-go sẽ chọn, và phải có vai `producer` trở lên trong team.
- Muốn có nghiên cứu thị trường: đặt `YOUTUBE_API_KEY`. Mỗi từ khoá tốn 100 đơn vị quota (`search.list`), web hiện
  ước tính trước khi chạy; kết quả cache 24 giờ.
- Claude giả hay thật: `docs/runbooks/studio-local.md` mục 2.

## 2. Luồng một production

| Bước | Ai làm | Trên web | Ghi chú |
|---|---|---|---|
| Tạo production | Người (producer) | Ngăn kéo "Tạo production": tên, folder ag-go, kênh của mình / kênh tham khảo và/hoặc từ khoá (ít nhất một), gợi ý tuỳ chọn, khung 16:9/9:16, ngôn ngữ, nhạc | Gợi ý là thứ R&D phải theo |
| Chạy | Người | Nút chạy trên trang production | Bắt đầu run `ag-studio-series-plan@2.0.0` |
| Nghiên cứu, catalog, báo cáo xu hướng | Tự động | Bước "Nghiên cứu thị trường" (chỉ xem) | Không có video nghiên cứu thì bỏ qua báo cáo, không gọi Claude |
| R&D | Claude (Opus) → **người duyệt** | `RndEditor`: sửa rồi "Duyệt" | Checker `rnd-valid` có thể từ chối kèm danh sách lỗi tiếng Việt |
| Branding | Claude → **người duyệt** | `BrandingEditor` | |
| Kế hoạch tập | Claude (Opus) → **người duyệt** | `PlanEditor`: sắp xếp, bỏ/thêm clip từ catalog, đổi clip dự phòng, gộp/thêm tập, sửa tiêu đề phần → "Duyệt & tạo tập" | Lệch thời lượng ±20% chỉ cảnh báo |
| Mỗi tập | Tự động | Bảng tập: tiến độ từng tập | `ag-studio-episode@1.2.0`: timeline nháp → YouTube kit → chốt timeline → render ở farm → thumbnail → export |

Không bước nào của tập chờ người, trừ khi có lỗi.

## 3. Sau khi tập render xong

- **YouTube kit:** sửa tiêu đề, mô tả, tag trong ngăn kéo của tập.
- **Thumbnail:** chọn trong các gợi ý, khung cắt từ video, hoặc ảnh tự tải lên; vẽ chữ theo branding có xem trước;
  mở sang Canva rồi lấy bản sửa về (`docs/runbooks/canva.md`).
- **Sửa hình:** mở editor của tập (thêm/xoá/đổi clip, chữ, nhạc, tắt tiếng gốc), "Render preview" để xem trước
  (job farm), rồi "Render lại": tạo run mới chạy lại từ `freeze-timeline` với bản sửa mới nhất.
- **Tải về:** file mp4, hoặc "gói YouTube" (zip, tạo lúc tải).
- **Xuất Premiere:** chọn proxy 720p hoặc bản gốc (bản gốc cần quyền tải gốc trên ag-go). Đây là job farm
  `studio.export_premiere`; kết quả là zip FCP7 XML + media + PNG chữ + `README.txt` hướng dẫn relink. Hai lỗi đã
  biết (tiếng gốc đã tắt vẫn có, gain nhạc luôn 0 dB): `docs/operations/deferred-items.md`.

## 4. Khi một bước hỏng

| Tình huống | Dấu hiệu | Cách xử lý |
|---|---|---|
| Claude trả lời sai hợp đồng hai lần (lần đầu + vòng sửa) | Stage đỗ `WAITING_HUMAN`, bảng "Log" (tab "Lần gọi Claude") có lượt bị từ chối | Xem lỗi trong nhật ký, chỉnh gợi ý hoặc quy chuẩn nhóm nếu cần, rồi **thử lại** stage đó |
| Hết hạn mức gói Claude | Stage chạy lâu, log có `RATE_LIMITED` | Không làm gì; executor chờ 5→60 phút rồi tự thử lại |
| Render treo | `render-final` chạy tới deadline (4 giờ) | Kiểm farm (web 3011) và render worker; huỷ run tập rồi "Render lại" |
| Muốn đổi R&D/branding sau khi đã duyệt | | Sửa trên web (`PUT /productions/:id/rnd|branding`), rồi "Chạy lại từ bước này" ở `brief` |
| Muốn làm lại từ R&D | | "Chạy lại từ bước này" ở `rnd` hoặc `approve-rnd` (`resumeRunFrom`: run mới, dùng lại các bước trước) |
| Gate từ chối tài liệu | API trả 422 kèm danh sách vấn đề | Sửa đúng các mục được liệt kê rồi duyệt lại |
| Huỷ | | Nút huỷ run; stage đang chạy đi qua `CANCEL_REQUESTED` rồi `CANCELLED` |

Mọi lượt gọi Claude (prompt, câu trả lời, lỗi kiểm) và mọi chỉnh sửa của người đều xem được ở bảng "Log" của
production (tab "Lần gọi Claude" và "Người sửa").

## 5. Chi phí và hạn mức

- Theo giá API (chỉ để so sánh, gói subscription không tính tiền theo token): báo cáo xu hướng khoảng 0,1 USD, kế
  hoạch tập (Opus, catalog ≤300 video) khoảng 0,9 USD, YouTube kit khoảng 0,04 USD mỗi tập.
- Gói subscription có hạn mức theo cửa sổ vài giờ và theo tuần, dùng chung với Claude Code/desktop của cùng tài
  khoản. Nên dùng tài khoản riêng cho Studio.
- Số lượt Claude chạy cùng lúc: `STUDIO_CLAUDE_MAX_CONCURRENT` (mặc định 20). Nhiều production chạy song song thì
  hạn mức gói hết nhanh hơn; khi hết, các lượt tự chờ rồi chạy lại.
