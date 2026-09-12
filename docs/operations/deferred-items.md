# Việc để lại sau sub-project 1 (control plane tối thiểu)

Danh sách rút từ các vòng review trong quá trình xây dựng (ledger SDD, 2026-09-11 → 2026-09-12). Mỗi mục đã được xem xét và cố ý hoãn; không mục nào chặn merge. Mục có dấu ★ nên làm sớm ở sub-project 2.

## Phải làm ở sub-project tiếp theo

- ✅ **Đã đóng ở 2A — Lease ngắn hơn heartbeat.** `resolveEffectiveConfig` ném `CONFIG_INVALID` nếu `lease_seconds <= heartbeat_seconds` (`packages/core/src/config/resolve.ts`).
- ✅ **Đã đóng ở 2A — `harness retry` chưa từ chối run `CANCEL_REQUESTED`.** `retry` giờ từ chối cả FAILED, CANCELLED lẫn CANCEL_REQUESTED trước khi ghi gì (`packages/cli/src/commands/retry.ts`).
- ✅ **Đã đóng ở 2A — Run bị hủy do reaper hoàn tất vẫn ở `CANCEL_REQUESTED`.** Worker gọi `planner.advance(runId)` cho từng run có lease vừa bị reap, để một cancel/requeue do reaper hoàn tất được settle ngay (`packages/worker/src/worker.ts`).
- ✅ **Đã đóng ở 2A — Quét artifact mồ côi.** `harness artifacts sweep [--older-than-minutes] [--dry-run] [--json]` xoá thư mục `artifacts/<...>` không có hàng DB không-PROVISIONAL đứng sau (`packages/core/src/artifacts/sweep.ts`).
- ★ **Test e2e secret redaction.** Vẫn mở — acceptance #11 hiện chỉ chứng minh không rò rỉ theo cấu trúc; khi adapter thực sự dùng `secret://` (sub-project 3) phải có test giá trị đi qua logger/event và bị che.
- **Mime type cố định trong worker** (`mimeTypesFor`): vẫn mở — chưa chuyển sang đọc `outputs[].mime_type` từ stage definition dù StageRun đã mang thông tin đó từ 2A.
- **External operation chỉ đi qua agent executor.** Vẫn mở — script executor chưa có cách ghi intent/dispatch; sub-project 2B/3 cần giao thức file hoặc adapter trong tiến trình.

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

## Hoãn, ít rủi ro — thêm sau sub-project 2A (ledger 2026-09-12 → 2026-09-13)

- `SourceItem` có các trường bắt buộc mới (`original_uri`, `mime_type`, `size_bytes`, `media`) không có default trong schema — chỉ `SourceCatalog.ingest()` biết điền đủ; dựng `SourceItem` tay ở nơi khác (test, migration script) dễ thiếu trường.
- Regex tên tài nguyên (`^[a-z][a-z0-9-]*$`) chỉ ép ở stage definition và `project.yaml`, không ép lại trên `StageRun`, `Lease`, `StageRequest` — tên xấu lọt qua nếu không đi qua `plan()`.
- `source ingest` không transactional giữa filesystem và DB: nếu `insertSourceItem` lỗi vì lý do khác UNIQUE (không phải race), thư mục `data/sources/normalized/<id>/` vừa tạo bị bỏ lại mồ côi (chỉ tốn dung lượng, không sai dữ liệu; id mới nên không đụng ingest khác).
- `materialize: link` chia sẻ inode với file gốc — sửa file gốc sau ingest sẽ đổi luôn bản đã normalize (caveat có chủ đích, ghi trong ADR §18, không phải bug).
- Output chồng nhau đã bị `stageOutputs` từ chối (`IO_ERROR`) trước khi di chuyển, nhưng phép chuẩn hóa đường dẫn chỉ xử lý dấu `\` và `/` cuối, chưa xử lý `.`/`..`/`//` (ví dụ `output/./cuts` và `output/cuts/001.mp4` vẫn lọt). Chuẩn hóa bằng `resolve(workspaceDir, path)` ở 2B.
- `listDirectoryFiles` bỏ qua symlink một cách âm thầm (không lỗi, không liệt kê) khi liệt kê file trong thư mục output.
- Thư mục output rỗng (`kind: directory` không có file con) vẫn được chấp nhận, tạo artifact với listing rỗng.
- Loop reuse ở `plan()` giả định thứ tự stage trong workflow definition là topological (stage đứng trước dependency của nó thì bỏ lỡ cơ hội reuse, không bao giờ reuse sai). Chuỗi reuse nhiều tầng đã có test.
- Run mà mọi stage đều bị `when` loại bỏ (0 stage) sẽ được chốt SUCCEEDED ngay khi enqueue với `reason: all_stages_reused` (đúng về trạng thái, sai về lý do trong event).
- Khi run có cả `--content` (content không có source) lẫn `--source`, lineage lấy danh sách source của content (rỗng) thay vì `run.source_id`.
- `artifacts sweep --older-than-minutes ""` được coi là 0 (`Number("") === 0`), tức quét ngay mọi artifact mồ côi.
- Invalidation tính tập stage phụ thuộc theo graph của run hiện tại, không theo graph của run cũ (khác nhau nếu workflow release đổi mà profile revision không đổi).
- `ProductionProfileSchema` chưa kiểm chéo `options_defaults` với `options_schema`, và `target_duration_seconds` chưa ép `min <= max`.
- Lease đã hết hạn nhưng chưa bị reap vẫn được đếm là đang giữ tài nguyên cho tới lần `runOnce` kế tiếp; `resources status` không nói rõ.
- `harness status` liệt kê artifact theo `run_id` nên run có stage tái sử dụng hiện 0 artifact và không có dấu "reused".
- `DirectoryEntry` được định nghĩa hai nơi (`contracts` và `core`); `store.updateContentItem` chưa có lệnh CLI nào gọi (spec: revision tăng khi đổi danh sách source).
- `source ingest <path>` resolve đường dẫn tương đối theo cwd của tiến trình CLI, không theo `--project`; chưa có test cho hành vi này.
- `warnResourceStarvation` (cảnh báo `stage.waiting_resource`) vẫn quét run/stage ở mỗi vòng poll rảnh của worker; đã có early-out khi không stage READY nào cần tài nguyên, nhưng vẫn tốn `listRuns` + `listStageRuns` mỗi vòng.
