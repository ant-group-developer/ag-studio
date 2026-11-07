# Trang Chẩn đoán (admin) — kế hoạch

Ngày 2026-11-07. Mục tiêu: thay việc định kỳ "pg_dump + log + tar /data về máy rồi phân tích" bằng một trang trong
Studio. Admin chọn khoảng thời gian, xem lỗi và chất lượng video của khoảng đó, so với kỳ trước, và tải gói dữ liệu để
Claude phân tích sâu khi cần. Chưa sửa code. Làm trên `dev-duc`, mỗi phase một commit, không push cho tới khi được bảo.

## Quyết định mặc định (đổi được khi duyệt)

- Chỉ **admin** thấy trang (giống `/queue`), API `requireAdmin`. Owner team không thấy.
- Khoảng thời gian: preset 7 / 14 / 30 ngày + tuỳ chọn (RangePicker như `ClaudeStatsView`), tối đa 90 ngày (bằng retention
  của `audit_log`). Mọi số liệu có cột "kỳ trước" (cùng độ dài, ngay trước `from`).
- Tính khi mở trang (SQL trên DB prod, chỉ đọc), không thêm job nền. Phần đọc file (`inspect.json`) giới hạn số video.
- Gói tải về **không** gồm nội dung chat của người dùng trừ khi tick "kèm transcript".

## P1 — API tổng quan + lỗi (engine `diagnostics.ts`, `apps/api/src/studio/diagnostics.controller.ts`)

- `GET /api/studio/diagnostics/overview?from&to&tz`: số job theo `kind` × `status`, tỉ lệ lỗi, job kẹt (`running` quá
  ngưỡng theo kind / `queued` quá lâu), lượt agent theo `status` và `trigger` (failed, rate_limited, timeout), chi phí
  Claude, biểu đồ theo ngày.
- `GET /api/studio/diagnostics/errors`: gom lỗi theo **chữ ký** (chuẩn hoá text: bỏ id, uuid, số, đường dẫn) từ
  `project_jobs.error`, `agent_messages.error`, `agent_actions.error`, `audit_log` (`outcome='error'`),
  `llm_calls.problems`, `claude_accounts.last_error`, và `error_events` (P2). Mỗi nhóm: nguồn, số lần, số dự án bị ảnh
  hưởng, lần đầu / lần cuối, nhãn **mới** (không có ở kỳ trước) / **đã hết** (có ở kỳ trước, kỳ này không), 5 ví dụ có
  link tới dự án / video / job.

## P2 — Lưu lỗi đang chỉ nằm ở stdout (migration `0012_error_events.sql`)

- Bảng `error_events (id, at timestamptz, service, level, signature, message, context jsonb, request_id)`, index `(at)`,
  `(signature, at)`; dọn theo retention 90 ngày cùng `cleanup.ts`.
- Ghi từ: `api-exception.filter.ts` (5xx, cả GET), worker `studioLogger` mức error/warn có chọn lọc, lỗi poll farm.
  Ghi lỗi không bao giờ được làm hỏng request (nuốt lỗi khi insert).
- Từ lúc deploy, log container không còn cần cho việc chẩn đoán định kỳ.

## P3 — Render

- Thời gian render preview / final (`started_at → finished_at`), số lần thử, theo máy (`node_id`), tỉ lệ realtime
  (thời lượng video ÷ thời gian render), p50 / p90.
- Lỗi farm: đọc `GET /v1/owner/jobs` bằng owner key có sẵn, phân trang tới khi `created_at < from`; gom theo
  `error.code`. Danh sách máy từ `/v1/owner/nodes`.

## P4 — Chất lượng video

Với mỗi video có render final (hoặc preview nếu chưa có final) trong khoảng, từ `video_revisions.data` (timeline) và
`project_jobs.result` + `inspect.json`:

- Nhịp cắt: số shot, độ dài shot trung bình / trung vị, % shot > 8 s, % shot < 0,6 s.
- Footage lặp: cùng `asset_id` với đoạn in/out chồng nhau, số asset khác nhau ÷ số shot.
- Voice: khoảng hở giữa các câu narration, đoạn hình không có voice quá dài, câu chưa có audio.
- Kỹ thuật: độ phân giải, tỉ lệ khung, LUFS / true peak, freeze, black, silence, `clip_loudness`, `repeated_onset`,
  transition bị hạ cấp, text bị bỏ, warnings.
- Mức chỉnh sửa: số revision, số revision do người (không phải agent) sau render đầu, số lần render lại — chỉ báo những
  chỗ agent làm chưa ưng.
- Bảng video (lọc, sắp xếp, cờ đỏ / vàng) + bảng "vấn đề hay gặp" tổng hợp. Giới hạn 300 video mỗi lần tính.

## P5 — Trang web `/diagnostics`

- Route + mục menu admin (`App.tsx`, `ManageMenu.tsx`), client trong `studio-client.ts`.
- Thanh chọn khoảng thời gian; tab: Tổng quan · Lỗi · Render · Chất lượng video. Bấm một nhóm lỗi → danh sách ví dụ.
- Nút **Tải gói phân tích** (`GET /api/studio/diagnostics/export`): zip gồm `report.md` (tóm tắt), JSON của từng tab,
  timeline + `inspect.json` của các video trong khoảng, tuỳ chọn transcript agent. Đưa zip cho Claude là phân tích được,
  không cần pg_dump.

## P6 — Kiểm thử

Spec engine trên PGlite (chuẩn hoá chữ ký lỗi, so kỳ trước, chỉ số video từ timeline mẫu), spec controller (403 khi không
phải admin), spec web cho trang. Chạy thử local với dữ liệu snapshot `ag_studio_prod`.

## Thứ tự deploy

Chỉ Studio (có migration 0012). Không đụng farm hay worker render.
