# Thêm một chi nhánh: nhóm riêng, tài khoản Claude riêng, máy farm riêng

Kế hoạch: `docs/superpowers/plans/2026-10-30-team-claude-accounts-farm-pools.md`. Mọi bước dưới đây do **admin Studio** (và
admin farm cho bước máy) làm; owner của nhóm chỉ xem được tab "Tài nguyên".

## 0. Một lần cho cả hệ thống
- Đặt `STUDIO_SECRET_KEY` (cùng giá trị) cho **API và worker** Studio rồi khởi động lại cả hai. Thiếu khoá thì trang
  Tài khoản Claude báo không lưu được token và chỉ tài khoản mặc định chạy.
- Thứ tự lên bản: farm hub (migration `2700000000000-node-pool`) → Studio API + worker (migration `0007`) → web. Hub cũ từ
  chối job có `requirements.pool`, nên đừng gán pool cho nhóm trước khi hub đã lên.

## 1. Tạo nhóm
`/teams` → tạo nhóm cho chi nhánh, thêm thành viên như mọi nhóm.

## 2. Tài khoản Claude của chi nhánh
1. Trên một máy đã đăng nhập tài khoản Claude của chi nhánh: `claude setup-token`, chép token in ra.
2. Studio → `/claude-accounts` (có link ở màn Hàng đợi) → **Thêm tài khoản**: tên (vd "Chi nhánh HCM"), dán token, số lượt
   cùng lúc nếu muốn giới hạn riêng (để trống: chỉ cap chung của Studio).
3. Bấm **Kiểm tra**: worker gọi một lượt rất nhỏ; vài giây sau dòng tài khoản báo "dùng được" hoặc lỗi.
4. Trang nhóm → tab **Tài nguyên** → chọn tài khoản (nhiều tài khoản: thứ tự chọn là thứ tự dùng) → Lưu.

Cách chạy: lượt chat của nhóm dùng tài khoản đầu còn chỗ (luồng giữ tài khoản lần trước nếu được). Tài khoản hết hạn mức
gói thì nghỉ 5 → 60 phút (tăng dần theo số lần liên tiếp) và lượt chạy ngay trên tài khoản kế tiếp; mọi tài khoản của
nhóm đều hết thì lượt chờ tới khi cái đầu tiên mở lại, **không** dùng tài khoản mặc định. Nhóm chưa chọn tài khoản nào (hoặc
mọi tài khoản đã tắt) dùng tài khoản mặc định (`CLAUDE_CODE_OAUTH_TOKEN` của máy chủ). Hàng đợi (admin) hiện lượt đang chạy
và trạng thái hết hạn mức của từng tài khoản.

Đổi token: Sửa → dán token mới (trạng thái hết hạn mức và lỗi cũ được xoá). Xoá tài khoản: nhóm đang dùng chuyển sang tài
khoản khác của nhóm, hoặc tài khoản mặc định.

## 3. Máy farm của chi nhánh
1. Cài ag-render-worker trên máy chi nhánh như mọi máy render (README của ag-render-worker), ghi danh vào farm.
2. Farm web → trang Máy → Sửa từng worker render của chi nhánh → **Pool** = tên pool (chữ thường, số, `-`, `_`), vd `hcm`.
   Worker scan cho ag-go để trống (job của ag-go không có pool, máy có pool sẽ không nhận).
3. Studio → trang nhóm → tab **Tài nguyên** → Pool máy farm = cùng tên (ô gợi ý các pool đang có trên farm) → Lưu.

Luật giao việc là hai chiều chặt: máy có pool chỉ làm job của pool đó; job của nhóm có pool chỉ chạy trên máy của pool
(máy pool tắt hết thì job chờ, quá `STUDIO_FARM_QUEUE_TIMEOUT_MINUTES` thì huỷ và báo); nhóm không pool dùng máy chung.
Video mẫu YouTube tải qua máy farm cũng chỉ tính máy của pool nhóm. Ghim máy cho bản cuối phải ghim máy cùng pool.

## Kiểm tra sau khi bật
- Một thành viên chi nhánh chat một câu trong dự án của nhóm → `/stats` hoặc DB: `llm_calls.claude_account_id` là tài khoản
  chi nhánh.
- Render bản xem trước → màn Hàng đợi hiện máy của chi nhánh nhận job; trên farm web, job có `requirements.pool`.
