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
| Bắt đầu | Người | Nút "Bắt đầu" (bật khi đủ: tên, folder, khung hình, ngôn ngữ, kênh hoặc từ khoá) | Ghi vào production rồi chạy `ag-studio-series-plan@3.1.0` |
| Nghiên cứu thị trường | Tự động → **người duyệt** | Cột phải: báo cáo xu hướng; chat để sửa; "Duyệt" | Không có video nghiên cứu thì báo cáo trống, không gọi Claude |
| R&D | Claude (Opus) → **người duyệt** | Chat để sửa ("gộp tập 3 và 4"); cột phải hiện "Bản n · k thay đổi" | Duyệt nộp đúng bản đang hiện |
| Branding | Claude → **người duyệt** | Như trên | |
| Kế hoạch tập | Claude (Opus) → **người duyệt** | Như trên; sửa kéo thả ở `⋯ → Sửa tay` (PlanEditor) | Lệch thời lượng ±20% chỉ cảnh báo. Mỗi tập có kiểu dựng: ghép nguyên video, hoặc **cắt theo shot** (có thể có lời dẫn) — xem mục 2a |
| Timeline mỗi tập | Tự động → **người duyệt** | Mở tập ở cột trái; chat ("nhạc nhỏ lại, thêm chữ … ở clip 2") → "Áp dụng" → "Duyệt"; editor ở `⋯` | `ag-studio-episode@1.3.0`; xem trước 720p ở `⋯ → Render xem trước` (farm) |
| YouTube kit | Claude → **người duyệt** | Chat để sửa tiêu đề, mô tả, tag | Thumbnail thật chọn sau khi render |
| Render, thumbnail, xuất | Tự động | Cột phải của tập: tiến độ, video, file | Render dùng timeline **đã duyệt** |

### 2a. Tập cắt theo shot (`ag-studio-episode-cut@1.0.0`)

Claude chọn kiểu này ở kế hoạch tập khi footage nhiều hơn tập cần (≥ 1,5 lần) hoặc khi nên có lời dẫn ("cắt theo shot
kiểu đi bộ du lịch, có lời dẫn"). Đầu tập có dòng "cắt theo shot · khoảng N phút · có lời dẫn".

| Bước | Ai làm | Trên web | Ghi chú |
|---|---|---|---|
| Chuẩn bị footage | Tự động | Vạch ngăn "tự động · N video, M shot" | Tải proxy 720p, dò shot, nghe tiếng nói (farm `studio.transcribe`), cắt khung + contact sheet |
| Chọn cảnh | Claude (xem contact sheet) → **người duyệt** | Lưới shot ở cột phải, lọc Dùng được / Bị loại / Tất cả; bấm shot để xem đoạn 720p; chat "giữ lại s000-002", "bỏ mấy cảnh có người nhìn máy" | Claude chat **nhớ các khung đã xem** (cùng session của bước này); shot đổi so với bản trước được tô |
| Kế hoạch dựng | Claude (Opus) → **người duyệt** | Bảng `# · Shot · Vào–ra · Dài`, lời dẫn từng dòng, chữ trên hình; chat "câu L002 ngắn lại" | Không có video xem trước ở bước này; nghe thử ở bước Timeline |
| Lời dẫn, khớp hình | Tự động | — | Farm đọc **chỉ các câu chưa đọc** (kho giọng theo nội dung); hình kéo dài/cắt bớt theo độ dài câu. Series chưa có giọng thì tập dừng ở đây với "cần giọng đọc" (xem dưới) |
| Timeline | **Người duyệt** | Như tập thường; thêm: cắt đầu/cuối clip, chuyển cảnh, phụ đề (chat "ngắn lại clip đầu", hoặc editor: ô Vào/Ra, chuyển cảnh, phụ đề) | Xem trước 720p có giọng |
| YouTube kit, render | Như tập thường | | Bản cuối theo khung của production (4K nếu đặt 3840×2160) |

- **Chạy lại từ một bước:** `⋯ → Chạy lại từ chọn cảnh…` hoặc `⋯ → Chạy lại từ kế hoạch dựng…` (có thẻ xác nhận). Run
  mới giữ footage, shot, khung đã làm và dừng ở bước đó với bản Claude viết; được khi tập đã xong hoặc đang chờ duyệt
  ở bước sau (run đang chờ bị huỷ). Đang có bước chạy thì 409 `episode_running`.
- **Giọng đọc và nhạc nền (tuỳ chọn):** đưa ở cột phải lúc intake, ở màn cũ, hoặc khi tập dừng với "cần giọng đọc":
  dán link (file audio, Google Drive chia sẻ công khai) hoặc tải file lên. Giọng mẫu 3–20 giây, một người nói rõ;
  phải chọn giọng là của ai (giọng máy / của mình / có giấy phép) và tick xác nhận có quyền dùng. Có giọng thì các tập
  đang chờ tự chạy tiếp. **Bỏ lời dẫn** áp cho cả series: tập dựng chỉ với hình, tiếng gốc và nhạc; lời đã viết trong
  kế hoạch dựng bị bỏ; kế hoạch tập sau đó không chọn lời dẫn nữa. Nhạc đưa vào trước bước khớp hình thì tập dùng nhạc
  đó; tập đã có timeline thì sửa nhạc trong timeline.
- Tập ghép nguyên video không có các ô cắt đầu/cuối, chuyển cảnh, phụ đề.

"Duyệt" luôn là nút; gõ "ok" trong chat chỉ làm Claude hiện thẻ xác nhận. Production bắt đầu trên màn cũ
(`series-plan@1.0.0`/`@2.0.0`) vẫn sinh tập 1.2.0 không gate và chạy như trước.

## 3. Sau khi tập render xong

- **YouTube kit:** đã duyệt ở bước kit; sửa thêm trong ngăn kéo của tập ở màn cũ.
- **Thumbnail:** chọn trong các gợi ý, khung cắt từ video, hoặc ảnh tự tải lên; vẽ chữ theo branding có xem trước;
  mở sang Canva rồi lấy bản sửa về (`docs/runbooks/canva.md`).
- **Sửa hình:** chat trên timeline của tập (hoặc `⋯ → Mở editor timeline`), "Áp dụng", rồi `⋯ → Render bản cuối…`:
  run mới chạy lại từ `approve-timeline`, duyệt lại timeline rồi kit.
- **Render lại trên kiểu máy khác** (timeline không đổi): `⋯ → Render bản cuối…`, chọn kiểu máy — chỉ bước render chạy
  lại, không gọi Claude, không duyệt lại. Lần render đầu chọn kiểu máy ngay trên thẻ duyệt YouTube kit.
- **Tải về:** file mp4, hoặc "gói YouTube" (zip, tạo lúc tải).
- **Xuất Premiere:** `⋯ → Xuất project Premiere` (proxy 720p), hoặc màn cũ để chọn bản gốc (cần quyền tải gốc trên
  ag-go). Job farm `studio.export_premiere`; zip FCP7 XML + media + PNG chữ + `README.txt` hướng dẫn relink. Tập cắt
  theo shot: clip đúng điểm vào/ra, chuyển cảnh, lời dẫn trên A3 (A1 trống), nhạc tự hạ dưới lời dẫn (keyframe A2);
  phụ đề là `captions.srt` trong zip, nhập bằng File → Import rồi kéo lên timeline. "Lời dẫn … không còn trong kho
  giọng" (422 `narration_missing`): render lại tập để đọc lại lời. Cảnh báo của bản xuất hiện dưới dòng job.
- **Thứ tự deploy:** render worker đọc v4 (`ag-render-worker` từ `e882a6c`) lên **mọi** máy farm trước, rồi mới tới
  Studio. Máy còn worker cũ vẫn nhận job xuất Premiere của tập cắt và ra project sai (clip từ đầu file, không chuyển
  cảnh, không lời dẫn) mà không báo lỗi (ADR mục 171).

## 4. Khi một bước hỏng

| Tình huống | Dấu hiệu | Cách xử lý |
|---|---|---|
| Claude trả lời sai hợp đồng hai lần (lần đầu + vòng sửa) | Video ở nhóm "Cần xử lý"; cột phải liệt kê vấn đề | Nói trong chat cách sửa ("bỏ video tối, mỗi clip một lần") rồi bấm "Chạy lại": góp ý vào prompt của bước đó |
| Claude không sửa được theo góp ý trong chat | Câu trả lời kèm "Claude chưa sửa được…" | Bản cũ giữ nguyên; nói rõ hơn, hoặc `⋯ → Sửa tay` |
| Hết hạn mức gói Claude | Chat hiện "hết hạn mức, tự thử lại lúc …"; stage log `RATE_LIMITED` | Không làm gì; tự chờ 5→60 phút rồi chạy lại |
| Tin nhắn chờ lâu | "Đang chờ lượt (n lượt trước)" | Đủ số lượt Claude cùng lúc; admin tăng ở chip header |
| Render treo | `render-final` chạy tới deadline (4 giờ) | Kiểm farm (web 3011) và render worker; huỷ run tập rồi "Render lại" |
| Tập dừng ở lời dẫn | Cột phải "cần giọng đọc" | Đưa giọng mẫu, hoặc **Bỏ lời dẫn** (cả series) |
| Bước máy hỏng (farm, ffmpeg…) | Cột phải "cần xử lý" kèm lỗi | Sửa nguyên nhân (máy farm, cấu hình) rồi bấm "Chạy lại" |
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
