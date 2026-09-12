# Việc để lại sau sub-project 1 (control plane tối thiểu)

Danh sách rút từ các vòng review trong quá trình xây dựng (ledger SDD, 2026-09-11 → 2026-09-12). Mỗi mục đã được xem xét và cố ý hoãn; không mục nào chặn merge. Mục có dấu ★ nên làm sớm ở sub-project 2.

## Phải làm ở sub-project tiếp theo

- ★ **Lease ngắn hơn heartbeat.** Worker đặt lease theo `effective_config_snapshot.lease_seconds`; một override nhỏ hơn `heartbeat_seconds` (30s) sẽ tự làm hết lease giữa chừng. Thêm validation `lease_seconds > heartbeat_seconds` khi resolve config, hoặc `Math.max(default, snapshot)` trong worker. (`packages/worker/src/worker.ts`)
- ★ **`harness retry` chưa từ chối run `CANCEL_REQUESTED`.** Stage đã FAILED trước khi cancel có thể bị đưa lại READY trong một run đang hủy. Thêm `CANCEL_REQUESTED` vào guard. (`packages/cli/src/commands/retry.ts`)
- ★ **Run bị hủy do reaper hoàn tất vẫn ở `CANCEL_REQUESTED`** cho tới lần `harness cancel` kế tiếp (reaper ở tầng store không gọi planner). Cân nhắc cho worker gọi `planner.advance` sau khi reap. (`packages/core/src/state/sqlite-store.ts`, `packages/worker/src/worker.ts`)
- ★ **Quét artifact mồ côi.** Crash hoặc cancel rơi vào giữa `stageOutputs` và commit để lại file trong `artifacts/` không có hàng DB (manifest ghi `provisional`). Cần lệnh `harness artifacts sweep`. (`packages/core/src/artifacts/registry.ts`)
- ★ **Test e2e secret redaction.** Acceptance #11 hiện chỉ chứng minh không rò rỉ theo cấu trúc; khi adapter thực sự dùng `secret://` (sub-project 3) phải có test giá trị đi qua logger/event và bị che.
- **Mime type cố định trong worker** (`mimeTypesFor`): chuyển sang đọc `outputs[].mime_type` từ stage definition khi StageRun mang thông tin đó.
- **External operation chỉ đi qua agent executor.** Script executor chưa có cách ghi intent/dispatch; sub-project 3 cần giao thức file hoặc adapter trong tiến trình.

## Hoãn, ít rủi ro

- Reaper bỏ qua lease có attempt/stage bị mất mà không ghi event; nên `warn`.
- `claim()` chỉ quét 100 stage READY đầu tiên; cần cursor khi hàng đợi lớn.
- Reaper requeue stage bị bỏ rơi với `not_before = now`, không backoff như lỗi transient.
- `workspaces prune` đếm thư mục còn mới vào `skipped`; `statSync` không được bảo vệ khi thư mục bị xóa đồng thời.
- `WAITING_EXTERNAL` nằm trong danh sách hủy-ngay của planner nhưng chưa bao giờ là trạng thái bền (chỉ tồn tại trong một transaction).
- Logger dùng `new Date()` cho trường `time` thay vì clock tiêm vào; test snapshot log sẽ không xác định.
- `registerRejected` trỏ URI vào workspace có thể bị prune; bằng chứng REJECTED mất sau retention.
- `Redactor` không che key của object hay giá trị số.
- `plan` dùng `HARNESS_ROOT` cấp module thay vì `harnessRoot` của context.
- `worker --once` thoát 0 cả khi trả về `lost`.
- `tsxLoaderUrl()` đọc lại `tsx/package.json` mỗi lần gọi.
- `sha256File` lỗi nào cũng thành `IO_ERROR "output missing"`; `toManifest` cast status không kiểm tra; `renameSync` yêu cầu workspace và artifact store cùng ổ đĩa.
- Typecheck từng package (`tsc --noEmit`) phụ thuộc `dist/*.d.ts` của package anh em: luôn `pnpm build` trước `pnpm typecheck` (đã ghi trong AGENTS.md).
- Test listener của worker chờ 4.5s thời gian thật; cân nhắc fake timers.
- `tests/integration/` trống; test tích hợp nằm trong `packages/core/test/**` (spec B.13 nêu bố cục khác).
- Đặt tên schema con camelCase/PascalCase chưa thống nhất; brief nói "18 entity" nhưng có 20 schema.
