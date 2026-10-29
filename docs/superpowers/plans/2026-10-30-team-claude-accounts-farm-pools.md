# Nhóm chi nhánh: nhiều tài khoản Claude, máy farm riêng theo nhóm (2026-10-30)

Mục tiêu: chi nhánh có nhóm riêng, dùng tài khoản Claude riêng và máy farm riêng. Admin Studio cài nhiều tài khoản
Claude và gán cho từng nhóm tài khoản Claude nào, nhóm máy farm (pool) nào.

## Tiến độ
- P1–P3, P5–P6: ag-studio `dev-duc` (716c3d7, 5c6cd0c, 3cb14c8 và commit tài liệu). P4: ag-farm `dev-duc` d93adce.
- Chưa: deploy (hub → Studio), đặt `STUDIO_SECRET_KEY`, nhập tài khoản thật. Runbook: `docs/runbooks/branch-team.md`.

## Đã chốt
- "Worker riêng" = **máy farm** (ag-render-worker: render, Premiere, TTS, nhịp nhạc, tải video mẫu). Worker Studio trên
  VPS và máy chuẩn bị footage của ag-go vẫn dùng chung.
- Máy farm gán pool thì **chỉ** làm job của pool đó; job có pool chỉ chạy trên máy cùng pool. Máy không pool = pool
  chung, chỉ nhận job không pool.
- Nhóm chưa gán tài khoản Claude dùng **tài khoản mặc định** (`CLAUDE_CODE_OAUTH_TOKEN` của env).
- Mọi tài khoản của nhóm hết hạn mức thì lượt **chờ**, không mượn tài khoản mặc định.

## Hiện trạng
- Một token `CLAUDE_CODE_OAUTH_TOKEN` cho mọi lượt; runner (`agent/runner.ts`, lượt + tóm tắt) chuyền `baseEnv`.
- Cap Claude chung qua `lease` (`claude-slots.ts`, `studio_settings.claude.max_concurrent`).
- Farm: `Requirements.node_id` ghim một máy; không có khái niệm nhóm máy. Worker farm chỉ dùng `meetsRequirements`
  cho `baseRequirements` của loại job, nên điều kiện mới chủ yếu ở hub.

## P1 – Dữ liệu (migration 0007)
- `claude_accounts`: `id`, `name`, `token_enc` (AES-256-GCM, khoá env mới `STUDIO_SECRET_KEY`), `token_hint` (4 ký tự
  cuối), `max_concurrent`, `enabled`, `rate_limited_until`, `last_check_at/status`, `created_at/updated_at`.
- `team_claude_accounts (team_id, account_id, position)`; `teams.farm_pool text NULL`.
- `llm_calls.claude_account_id`, `agent_messages.claude_account_id` (NULL = mặc định).
- Tài khoản mặc định là id cố định `default`, token đọc từ env, không lưu DB.

## P2 – Runner chọn tài khoản
- `pickClaudeAccount(team)`: tài khoản của nhóm theo `position`, bỏ qua tắt/đang `rate_limited_until`; luồng giữ tài
  khoản lượt trước nếu còn dùng được. Nhóm không gán → `default`.
- Slot: lease thêm resource `claude:<accountId>`, cap từng tài khoản + cap chung giữ nguyên.
- `rate_limited` → ghi `rate_limited_until` cho tài khoản; lượt thử tài khoản kế tiếp của nhóm, hết thì chờ như cũ.
- Token đè `CLAUDE_CODE_OAUTH_TOKEN` trong env của process con (bỏ `ANTHROPIC_API_KEY`), luôn qua Redactor.

## P3 – API + web
- `/admin/claude-accounts` (admin Studio): thêm (dán token `claude setup-token`), sửa tên/cap, tắt, "Kiểm tra" (gọi thử
  rất nhỏ; không chạy trong test). Token không bao giờ trả về.
- Trang nhóm (admin sửa, owner xem): tài khoản Claude (chọn nhiều, kéo thứ tự) và pool máy farm.
- Hàng đợi: slot + hết hạn mức từng tài khoản. Thống kê: lọc/nhóm theo tài khoản.

## P4 – ag-farm (đổi hợp đồng)
- Cột `pool` của node, admin farm đặt ở web farm; `Requirements.pool?: string`; claim theo luật ở mục Đã chốt (cả
  `node-priority` khi chọn máy xếp trước); `/v1/owner/nodes` trả `pool`. Lên hub trước Studio.

## P5 – Studio gửi job farm theo nhóm
- Mọi job farm của dự án gắn `requirements.pool = teams.farm_pool` (`workspace/farm.ts`, `reference-fetch.ts`, beats,
  tts, transcribe).
- Ghim máy bản cuối, ETA, `referenceRoute`, danh sách máy ở Hàng đợi chỉ tính máy cùng pool.

## P6 – Tài liệu, triển khai
- Runbook "thêm một chi nhánh"; AGENTS.md; `.env.example` (`STUDIO_SECRET_KEY`).
- Thứ tự: farm hub → Studio API/worker → web.
