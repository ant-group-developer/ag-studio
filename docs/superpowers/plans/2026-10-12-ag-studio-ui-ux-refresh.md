# Plan: làm mới UI/UX Studio (2026-10-12)

Nhánh: `feat/ui-ux-refresh` (từ `main`). Mỗi task một commit (Conventional Commits), có test, i18n đủ vi/en.
Không push. Không đổi ag-go/ag-farm.

**Xong khi:** step trong chat có tên dễ hiểu và nút mở file ngay trên dòng; JSON xem dạng cây; xem file vẫn thấy cây
thư mục; list dự án có grid/table; chọn project ag-go trong drawer toàn màn hình giống ag-go-web, chọn nhiều một lúc;
thống kê xem được từng lượt; không còn uuid thay tên video; các panel cuộn được, không mất UI;
`pnpm test`, `corepack pnpm -r run build`, `pnpm -r typecheck` sạch.

Đã quyết: **chưa cho xoá dự án** (bỏ khỏi plan).

## P1 — Chat, file, sửa lỗi nhỏ

0. `feat(web): readable names for every agent tool` — nhãn vi/en cho mọi tool engine đăng ký + tool Claude có sẵn;
   thiếu nhãn thì tên viết thường dễ đọc, tên gốc ở tooltip; đích (query, số video…) sau tên; test đủ nhãn.
1. `feat(web): open-file button on file tool chips` — nút mở ngay trên dòng chip Read/Write/Edit.
2. `fix: no asset ids in place of video names` — `inputs_add` bắt buộc `name`; nhãn/tiêu đề việc cũ là uuid thì hiện
   tên thay thế, không hiện uuid.
3. `fix(web): panels scroll instead of clipping` — tab Đầu vào và các panel bị cắt.
4. `feat(web): JSON viewer` — cây đóng/mở, màu theo kiểu, mở/đóng hết, copy giá trị/đường dẫn, Cây/Thô, JSON hỏng thì
   báo dòng, `.jsonl` từng dòng.
5. `feat(web): folder tree beside the open file` — cây bên trái file đang xem, ẩn/hiện, nhớ trạng thái; hẹp thì phủ.

## P2 — List dự án

1. `feat(web): projects list as grid or table` — tìm, sắp xếp, grid/table nhớ lựa chọn.

## P3 — Chọn project ag-go

1. `feat(web): full-screen ag-go project drawer` — chép ag-go-web `ProjectsPage` (sidebar lọc 300px, tìm có gợi ý,
   sort, list/grid, thẻ vuông thumbnail + hover info, bảng, skeleton, phân trang 12/24/48/96).
2. `feat(web): pick several ag-go projects at once` — checkbox, giữ qua trang, thanh chọn, thêm lần lượt, báo lỗi riêng.

## P4 — Thống kê từng lượt

1. `feat(engine): claude turns list and detail` — `llm_calls` ⋈ `agent_messages` (+ audit `changed`).
2. `feat(api): GET studio/stats/claude/turns[/:id]` — cùng `viewScope`; `docs/studio-api-v4.md`.
3. `feat(web): per-turn table and detail drawer` — lọc theo dòng gộp, drawer chi tiết, mở lại chat.

## Trạng thái (2026-10-12)

Xong P1–P4 trên `feat/ui-ux-refresh`, chưa push. `corepack pnpm -r run build`, `pnpm -r typecheck`, `pnpm test` sạch.
Kiểm giao diện bằng trang thử cục bộ với dữ liệu giả (chip, việc nền, JSON, cây + file, drawer ag-go, thống kê từng lượt);
chưa kiểm trên stack thật có đăng nhập. Ngoài plan: biến màu `--ws-*` chuyển lên `:root` để drawer/modal (portal) nhận màu.
