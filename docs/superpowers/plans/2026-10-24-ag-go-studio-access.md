# Quyền dùng project ANT Go trong Studio (2026-10-24, đã duyệt)

## Nguyên tắc
1. Picker liệt kê project theo quyền người đang xem, như menu Dự án của ag-go: `go.project.read_all` thấy mọi
   project đã đánh giá (bản watermark); không có thì chỉ project được cấp theo gói / quyền làm việc / của mình.
2. Chỉ project người đó **tải được bản gốc** mới thêm được (giống điều kiện tải bản gốc của ag-go: quyền vai trò
   `download_original` + quyền bản gốc trên project). Project chỉ xem được vẫn mở chi tiết, không tick được.
3. Thêm xong, dự án Studio dùng project đó **không kiểm quyền nữa**: agent, prep, render nháp/cuối (bản gốc), cả team,
   cả bản xuất Premiere.
4. Picker xem chi tiết project ngay trong Studio.

Hệ quả chấp nhận: thu hồi quyền ag-go không ảnh hưởng nguồn đã thêm; thành viên dùng footage họ không có quyền ag-go.

## Tiến độ
| Bước | Trạng thái | Commit |
|---|---|---|
| P1 ag-go-v2 | xong | ag-go-api `02d900d`, `831c8e6` (dev-duc, chưa push) |
| P2 Studio API + worker | xong | `7527289` (dev-duc, chưa push) |
| P3 Studio web | xong | `33ed5ad` (dev-duc, chưa push) |
| P4 kiểm tra | test hai repo xanh (ag-go-api 508 + 146 DB, Studio 2166 + web 196). Local với footage Hoa Lư: chế độ tin cậy tìm 21 video, bản cuối ra bản gốc, xem trước ra proxy sạch, video ngoài project → `missing` / prep 404, thiếu `projectIds` → 400, token người dùng → 401; access như chủ project: thêm được. Giao diện chưa xem trên máy (cần đăng nhập Auth0). SQL prod ở dưới chưa chạy; deploy chưa làm | |

## P1 – ag-go-v2
- `POST /footage/projects/access` (service key `footage:read`, act-as người dùng): mỗi project → thấy được, tải được
  bản gốc, số video đã phân tích / dùng được.
- Chế độ tin cậy cho Studio: scope service key `footage:studio`. search, facets, resolve, prep nhận `projectIds`
  (project ag-go đã thêm vào dự án Studio) và chỉ phục vụ video thuộc các project đó, bỏ qua quyền user.
  Resolve `final` luôn bản gốc; `preview` proxy / 480p sạch; video ngoài các project đó nằm trong `missing` (không
  404, để Studio kiểm nhiều video một lần). Prep video ngoài các project → 404.
- "Media của asset" ở chế độ tin cậy **không làm**: Studio không gọi `GET /footage/assets/:id/media` ở đâu cả (web xem
  chi tiết project bằng `GET /projects/:id/media` với token của người xem).
- Test + OpenAPI.

## P2 – Studio API + worker
- Thêm project: kiểm theo người bấm qua endpoint access (bản gốc + ≥1 video dùng được), báo đúng lý do
  (`ag_go_view_only`, `ag_go_no_videos`, `ag_go_not_visible`).
- Thêm video lẻ (người / agent): video thuộc một project đã thêm (`no_ag_go_project`, `not_in_added_project`).
- Mọi lời gọi footage (tab Đầu vào + facets, agent, đặt tên, prep, resolve ở `farm.controller` và `apps/worker`) sang
  chế độ tin cậy kèm `projectIds` của dự án (`agGoProjectIds()` thay `projectActAs()`).
- Bỏ kiểm quyền theo người tải ở bản xuất Premiere (`footage-rights` đã xoá; `RenderLink.url` luôn có).
- Endpoint cho picker: `POST projects/:id/ag-go-access {projectIds}`.
- Gỡ project ag-go đang có video lẻ dùng (không thuộc project nào khác của dự án): 409 `project_in_use`, `force=1` vẫn gỡ.
- Tài liệu: `docs/studio-api-v4.md`, `AGENTS.md`, ADR mục 197, `.env.example`, README, runbook studio-local.

## P3 – Studio web
- Card và bảng: Đã thêm / Thêm được / Chỉ xem (watermark) / Chưa có video đã phân tích (lý do khi rê chuột); chỉ "Thêm
  được" tick được. Thêm lỗi thì liệt kê lý do theo mã; bị từ chối vì trạng thái thì bỏ tick.
- Drawer chi tiết (`AgGoProjectDetailDrawer`): tên, đường dẫn thư mục, người tạo, danh mục, địa điểm, tag, mô tả, số
  ảnh/video, số video đã phân tích dùng được; lưới media (`GET /projects/:id/media`, phát `previewUrl` theo quyền người
  xem, ảnh mở lớn); nút Thêm vào dự án.
- Gỡ project đang dùng: hộp xác nhận nói bao nhiêu video, trong video nào, rồi "Vẫn gỡ".
- Tab Xem trước: file Premiere luôn tải được (bỏ "bạn chưa có quyền xem footage này").
- i18n vi/en (cả trang Hướng dẫn), test.

## P4 – Kiểm tra, triển khai
- Test hai repo; chạy local với footage Hoa Lư.
- SQL prod: video lẻ đã thêm nhưng không thuộc project ag-go đã thêm của dự án (chế độ tin cậy sẽ chặn: không chuẩn
  bị, không render được). Hai DB khác nhau nên làm hai bước:
  1. DB Studio — xuất mọi video lẻ kèm các project ag-go của dự án:
     ```sql
     \copy (SELECT s.project_id, s.ref AS asset_id, s.video_id, COALESCE((SELECT string_agg(p.ref, ',') FROM project_sources p WHERE p.project_id = s.project_id AND p.kind = 'ag_go_project'), '') AS ag_go_project_ids FROM project_sources s WHERE s.kind = 'ag_go_asset') TO 'studio_assets.csv' CSV HEADER
     ```
  2. DB ag-go — nạp file đó, liệt kê video không thuộc project nào trong danh sách, kèm project ag-go đang chứa nó
     (để thêm project đó vào dự án, hoặc gỡ video):
     ```sql
     CREATE TEMP TABLE studio_assets (project_id text, asset_id text, video_id text, ag_go_project_ids text);
     \copy studio_assets FROM 'studio_assets.csv' CSV HEADER
     SELECT sa.project_id, sa.video_id, sa.asset_id,
            string_agg(DISTINCT pm.project_id::text, ',') AS in_ag_go_projects
     FROM studio_assets sa
     LEFT JOIN project_media pm ON pm.asset_id::text = sa.asset_id AND pm.evaluation_status <> 'rejected'
     WHERE NOT EXISTS (
       SELECT 1 FROM project_media x
       WHERE x.asset_id::text = sa.asset_id AND x.evaluation_status <> 'rejected'
         AND x.project_id::text = ANY (string_to_array(NULLIF(sa.ag_go_project_ids, ''), ','))
     )
     GROUP BY sa.project_id, sa.video_id, sa.asset_id
     ORDER BY sa.project_id, sa.video_id;
     ```
- Deploy: ag-go (thêm scope `footage:studio` cho key `studio` trong `SERVICE_KEYS`) → worker → Studio.
