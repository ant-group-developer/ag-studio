# Trang dự án gọn, tập trung làm việc (2026-10-28, đã duyệt)

## Đã chốt
1. Danh sách dự án mở mặc định dạng **bảng** (chỉ trang Dự án; ngăn chọn project ag-go giữ dạng lưới).
2. Icon lệch chữ trong nút: sửa một lần bằng CSS chung (đo trên máy: nút antd có icon lucide lệch 0,8–1,3 px).
3. Cây thư mục dự án **chỉ admin Studio** (`me.isAdmin`) xem; người khác thấy tab Tài liệu đã lọc.
4. Font và màu chữ chọn **theo từng video**.
5. Bắt đầu làm một video thì chat **tự chuyển sang luồng của video đó**, không làm tiếp ở chat Kênh.

## Đã chốt theo đề xuất (duyệt 2026-10-28)
- **Nghiên cứu, Cài đặt**: đề xuất Nghiên cứu thành một nhóm trong tab Tài liệu (báo cáo đã có + nút "Chạy nghiên
  cứu" mở form hiện tại trong modal), Cài đặt chuyển vào nút ⚙ trên thanh tiêu đề (mở drawer).
- **Thứ tự ưu tiên chữ**: chọn trên giao diện cho video > `text_look` trong kế hoạch dựng > branding kênh. Agent
  không ghi đè lựa chọn của người.
- **Thumbnail** của video dùng cùng font/màu chữ đã chọn cho video (hiện đọc branding).

## Tiến độ
| Bước | Trạng thái | Commit |
|---|---|---|
| P1 nhanh | xong: đo trên máy 62 nút (trang Dự án, mọi tab trang dự án, ngăn ag-go) lệch ≤ 0,3 px; nút Bảng/Lưới chỉ còn icon, giữa ô | (commit này) |
| P2 tab Tài liệu | xong: tab Tài liệu · Nguồn (+ Xem trước), ⚙ Cài đặt dự án (drawer, `?tab=settings` cũ vẫn mở), Chạy nghiên cứu trong nhóm Nghiên cứu; `CLAUDE.md` hiện là "Ghi chú cho agent"; admin có Tài liệu/Thư mục; render trùng tên kèm giờ. Xem trên máy (tài khoản admin); người thường qua test | (commit này) |
| P3 tab Phong cách + chữ theo video | chưa làm | |
| P4 tự chuyển sang chat video | chưa làm | |
| P5 kiểm tra | chưa làm | |

## P1 – Sửa nhanh (web)
- `ProjectsPage.tsx`: `useViewMode("studio.projects.viewMode", "table")`. Người đã chọn lưới giữ lưới (localStorage).
- CSS chung (`workspace.css` hoặc file nạp ở `main.tsx`): `.ant-btn > .ant-btn-icon { display: inline-flex;
  align-items: center }`, `svg.lucide { display: block }` trong ô icon của antd (nút, tag, segmented, menu,
  radio), icon trong `ant-badge` của nút "Đang chạy". Đo lại: mọi nút về ≤ 0,3 px.
- Thống nhất cỡ icon: 14 trong nút `size="small"`, 16 trong nút thường (đang lẫn 12/13/14/16).
- `.ws-sr` chuyển từ `inputs.css` sang CSS chung: nút Bảng/Lưới ở trang Dự án đang hiện chữ thừa vì `inputs.css`
  chỉ nạp khi mở tab Đầu vào.

## P2 – Tab Tài liệu thay tab Files (web, API nhỏ)
- Tab bên phải còn: Xem trước (khi mở video) · **Tài liệu** · **Nguồn** (tab Đầu vào hiện nay, đổi tên) ·
  **Phong cách** (P3).
- Tài liệu = danh sách nhóm theo ý nghĩa, tên dễ đọc (bảng tên ở web, không đổi đường dẫn file):
  - Kênh: `channel/strategy.md`, `channel/branding.md`, `channel/style.md`.
  - Video (video đang mở trước, rồi các video khác theo tên, không theo uuid): brief, kế hoạch dựng, gói YouTube,
    các bản render (`renders/*.md`).
  - Nghiên cứu: `research/**/README.md`, `research/report.md`.
  - Tệp đã thêm: `context/**` (trừ `context/README.md`).
  - Ẩn: `.studio/`, `CLAUDE.md`, `memory/`, `skills/`, `threads/`, `inputs/`, `videos/*/sources/`,
    `timeline.json`, `survey.json`, `edit-plan.json` (kế hoạch dựng đọc bản markdown nếu có, không thì hiện "Kế
    hoạch dựng" mở JSON viewer như cũ).
- "Thêm file" (upload vào `context/`) và "Tài liệu mới" ở đầu tab.
- Admin Studio thấy thêm "Xem toàn bộ thư mục" → cây như hiện nay (`FilesPanel` giữ nguyên, đặt sau công tắc).
- Link file trong chat (`onOpenFile`) vẫn mở mọi file cho mọi người như cũ: ẩn chỉ là giao diện, API files không
  đổi quyền.
- Nghiên cứu / Cài đặt theo mục "Cần chốt".

## P3 – Tab Phong cách, chữ theo video (engine, API, web)
- Lưu: bảng `videos` thêm `text_look jsonb`, `look text`, `color_match boolean` (migration Postgres) — giống nhạc
  riêng của video.
- API: `GET/PUT /videos/:id/look {text_look?, look?, color_match?}` (editor), kiểm bằng `TextLookSchema`,
  `VIDEO_LOOKS`; font trong `TEXT_FONTS`.
- `fit.ts`: `textStyle = video.text_look ?? plan.text_look ?? branding.textLook` (tương tự `look`, `colorMatch`).
- Timeline đã có: lưu xong thì áp ngay vào timeline (op mới `setTextStyle`, cùng `setLook`/`setColorMatch` có sẵn),
  không cần fit lại; bản xem trước kế tiếp thấy chữ mới. `RENDER_FEATURE_LEVEL` không đổi (trường đã có).
- `thumbnails.ts`: dùng chữ của video nếu có.
- Agent: `<studio_context>` của luồng video báo chữ/màu đã chọn; prompt + skill edit-plan: có lựa chọn của người thì
  không ghi `text_look`/`look` vào kế hoạch.
- Web, tab Phong cách:
  - Trong video: ô xem trước chữ (font thật qua Google Fonts / file font đóng kèm), chọn font (nhóm Latin/Nhật/Hàn,
    đánh dấu đủ dấu tiếng Việt), cỡ s/m/l, màu chữ, viền, hộp, bóng, màu hình, khớp màu; "Về mặc định của kênh".
  - Ở chat Kênh: hiện mặc định của kênh (từ branding) chỉ xem, cùng phong cách dựng (`channel/style.md` tóm tắt),
    tải video mẫu, nút "Nhờ agent học phong cách" (điền sẵn lời nhắn vào ô chat).

## P4 – Tự chuyển sang chat của video (engine, web)
- `video_create` (agent tạo video từ chat Kênh / chat tự do): Studio đăng vào luồng video một tin nhắn chuyển giao
  (brief, điều người dùng vừa yêu cầu, file liên quan) để agent của video bắt đầu; luồng cũ hiện thẻ "Đã chuyển
  sang chat video #n" có link.
- Tool mới `video_focus {video_id, message}`: agent ở chat Kênh muốn làm tiếp một video có sẵn thì chuyển giao như
  trên. Các tool việc của video (chọn cảnh, kế hoạch dựng, fit, timeline, render) gọi từ luồng không phải của video
  đó bị từ chối, mã `use_video_thread`, kèm gợi ý `video_focus`.
- Sự kiện SSE `thread.handoff {from, to, videoId}`: web đang mở luồng `from` thì tự điều hướng tới
  `/p/:id/v/:videoId` và báo nhỏ "Đã chuyển sang chat của video #n"; người khác đang xem chỉ thấy thẻ link.
- Modal "Video mới" đã tự chuyển (giữ nguyên).
- Prompt: bỏ chỉ dẫn làm việc video trong luồng Kênh; luồng Kênh lo kênh, mở video thì chuyển.

## P5 – Kiểm tra
- `pnpm test`, `pnpm vitest run apps/web`, typecheck sau build.
- Máy local (footage Hoa Lư): đo lại icon trên các trang; trang Dự án mở bảng; tab Tài liệu với tài khoản thường
  và admin; đổi font cho một video → timeline đổi, bản xem trước đúng font; chat Kênh bảo "làm video mới về …" →
  tự chuyển sang chat video và agent bắt đầu ở đó.
