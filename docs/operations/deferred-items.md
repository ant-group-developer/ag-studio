# Việc để lại sau sub-project 1 (control plane tối thiểu)

Danh sách rút từ các vòng review trong quá trình xây dựng (ledger SDD, 2026-09-11 → 2026-09-12). Mỗi mục đã được xem xét và cố ý hoãn; không mục nào chặn merge. Mục có dấu ★ nên làm sớm ở sub-project 2.

## Phải làm ở sub-project tiếp theo

- ✅ **Đã đóng ở 2A — Lease ngắn hơn heartbeat.** `resolveEffectiveConfig` ném `CONFIG_INVALID` nếu `lease_seconds <= heartbeat_seconds` (`packages/core/src/config/resolve.ts`).
- ✅ **Đã đóng ở 2A — `harness retry` chưa từ chối run `CANCEL_REQUESTED`.** `retry` giờ từ chối cả FAILED, CANCELLED lẫn CANCEL_REQUESTED trước khi ghi gì (`packages/cli/src/commands/retry.ts`).
- ✅ **Đã đóng ở 2A — Run bị hủy do reaper hoàn tất vẫn ở `CANCEL_REQUESTED`.** Worker gọi `planner.advance(runId)` cho từng run có lease vừa bị reap, để một cancel/requeue do reaper hoàn tất được settle ngay (`packages/worker/src/worker.ts`).
- ✅ **Đã đóng ở 2A — Quét artifact mồ côi.** `harness artifacts sweep [--older-than-minutes] [--dry-run] [--json]` xoá thư mục `artifacts/<...>` không có hàng DB không-PROVISIONAL đứng sau (`packages/core/src/artifacts/sweep.ts`).
- ✅ **Đã đóng ở 2B — Test e2e secret redaction.** `tests/acceptance/16-secret-e2e.test.ts` chạy một wrapper thật (`avatar.mjs`) in giá trị secret ra cả stdout thô lẫn một dòng log có cấu trúc; test khẳng định giá trị đó không xuất hiện ở output worker, `status`, `events tail`, `stage-request.json`/`stage-result.json`, manifest artifact hay `project.yaml`/`scripts.yaml`, và **có** xuất hiện `[REDACTED]` trong log — chứng minh `Redactor` che theo giá trị đã resolve, không chỉ theo cấu trúc code.
- ✅ **Đã đóng ở 2B — Mime type cố định trong worker.** `mimeTypesFor(def)` (`packages/core/src/orchestration/request.ts`) đọc `outputs[].mime_type` từ chính stage definition của workflow đang chạy; `packages/worker/src/worker.ts` và `submitGate` đều gọi qua hàm này, không còn bảng mime hardcode.
- ✅ **Đã đóng ở 2B — External operation chỉ đi qua agent executor.** `harness op intent|confirm|lost` (`packages/cli/src/commands/op.ts`) cho script executor một giao thức CLI đầy đủ; `@harness/script-sdk`'s `ctx.op.*` gọi nó qua `HARNESS_CLI_ARGV` (xem `fixtures/ops-project-footage/executors/wrappers/avatar.mjs`).
- ✅ **Đã đóng ở 2B — Chuẩn hóa `.`/`..`/`//` trong đường dẫn output.** `ArtifactRegistry.stageOutputs` tính từng path output bằng `resolve(p.workspaceDir, o.path)` (Node tự chuẩn hóa `.`/`..`/`//`) trước khi so trùng lặp/lồng nhau, thay vì chỉ cắt dấu `/`/`\` cuối như trước 2A.
- ✅ **Đã đóng ở 2B — `harness status` không đánh dấu artifact tái sử dụng.** `packages/cli/src/commands/status.ts` in thêm một dòng `artifact <id> (reused)` cho mỗi `reused_artifact_ids` của từng stage, cạnh danh sách artifact theo `run_id` như cũ.

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
- `listDirectoryFiles` bỏ qua symlink một cách âm thầm (không lỗi, không liệt kê) khi liệt kê file trong thư mục output.
- Thư mục output rỗng (`kind: directory` không có file con) vẫn được chấp nhận, tạo artifact với listing rỗng.
- Loop reuse ở `plan()` giả định thứ tự stage trong workflow definition là topological (stage đứng trước dependency của nó thì bỏ lỡ cơ hội reuse, không bao giờ reuse sai). Chuỗi reuse nhiều tầng đã có test.
- Run mà mọi stage đều bị `when` loại bỏ (0 stage) sẽ được chốt SUCCEEDED ngay khi enqueue với `reason: all_stages_reused` (đúng về trạng thái, sai về lý do trong event).
- Khi run có cả `--content` (content không có source) lẫn `--source`, lineage lấy danh sách source của content (rỗng) thay vì `run.source_id`.
- `artifacts sweep --older-than-minutes ""` được coi là 0 (`Number("") === 0`), tức quét ngay mọi artifact mồ côi.
- Invalidation tính tập stage phụ thuộc theo graph của run hiện tại, không theo graph của run cũ (khác nhau nếu workflow release đổi mà profile revision không đổi).
- `ProductionProfileSchema` chưa kiểm chéo `options_defaults` với `options_schema`, và `target_duration_seconds` chưa ép `min <= max`.
- Lease đã hết hạn nhưng chưa bị reap vẫn được đếm là đang giữ tài nguyên cho tới lần `runOnce` kế tiếp; `resources status` không nói rõ.
- `DirectoryEntry` được định nghĩa hai nơi (`contracts` và `core`); `store.updateContentItem` chưa có lệnh CLI nào gọi (spec: revision tăng khi đổi danh sách source).
- `source ingest <path>` resolve đường dẫn tương đối theo cwd của tiến trình CLI, không theo `--project`; chưa có test cho hành vi này.
- `warnResourceStarvation` (cảnh báo `stage.waiting_resource`) vẫn quét run/stage ở mỗi vòng poll rảnh của worker; đã có early-out khi không stage READY nào cần tài nguyên, nhưng vẫn tốn `listRuns` + `listStageRuns` mỗi vòng.

## Hoãn, ít rủi ro — thêm sau sub-project 2B (ledger 2026-09-13)

- `stageOutputs` (Task 1) trùng logic `resolve()` ở hai chỗ gần nhau (overlap-check và path thật) — gộp lại được, không phải bug.
- Tuple `[min, max]` của `target_duration_seconds` được định nghĩa lặp lại ở `packages/contracts/src/execution.ts` và `config.ts` — nên rút về một schema chung.
- `claim({ stageRunId })` (claim đích danh, dùng bởi `submitGate`) chưa có test cho các case tiêu cực — capability không khớp, `not_before` chưa tới, tài nguyên đã hết slot cho chính stage được claim đích danh — chỉ đường happy path được phủ.
- `packages/worker`'s `tsconfig.json` loại `test/` khỏi typecheck (có từ trước 2B, không phải hồi quy mới, nhưng vẫn chưa dọn).
- Chưa có test cho: một dòng stdout hợp lệ JSON nhưng `level` không phải `info`/`warn`/`error`, một dòng kết thúc bằng CRLF, hay `timeout_seconds` trong `scripts.yaml` lớn hơn deadline chung của attempt — `forwardStdout`/`ScriptExecutor` xử lý được các case này nhưng không có assertion trực tiếp.
- `scriptCommandsFrom` (`packages/core/src/config/scripts.ts`) luôn set `env_refs: {}` cho một script không khai `env_refs` trong YAML (thay vì để `undefined`) — vô hại (spread rỗng) nhưng không khớp optionality thật của kiểu `ScriptCommand`.
- `packages/cli/src/commands/op.ts`: logic tra attempt/operation, kiểm fencing, parse JSON lặp lại gần như y hệt ở cả ba subcommand `intent`/`confirm`/`lost` — chưa rút hàm dùng chung.
- `harness op intent --payload` mặc định `"{}"` thay vì bắt buộc; brief gợi ý payload nên bắt buộc để tránh một intent trống vô tình khoá idempotency key theo `{kind, target, payload: {}}`.
- `submitGate`'s pre-verify (chống lỗi sớm, không đổi state) và verify thật sau khi claim là hai lần verify riêng; nếu `output/` đổi giữa hai lần đó (hai lệnh `stage submit` đua nhau) chỉ lần verify thật quyết định kết quả — chưa có test cho tình huống đua này.
- `gateOverdue` (dùng bởi cả worker mỗi vòng poll rảnh lẫn `harness status`) quét toàn bộ run `WAITING`/`RUNNING` mỗi lần gọi, không cursor — chấp nhận được ở quy mô hiện tại, chi phí tăng theo số run đang mở đồng thời (plan-mandated, giống `warnResourceStarvation` ở 2A).
- Nhánh ngân sách trong `Planner.advance()` được xét **trước** các nhánh chốt `FAILED`/`WAITING_HUMAN`: một run vừa hết ngân sách mà đồng thời có stage `FAILED` hay `WAITING_HUMAN` sẽ đỗ `WAITING` (do ngân sách) thay vì `FAILED`/`WAITING_HUMAN`, cho tới khi ngân sách được nâng bằng `--raise-budget` (plan-mandated, thứ tự if/else cố ý theo brief 2B).
- Guard chặn run terminal trước khi `raiseBudget` (FAILED/CANCELLED/CANCEL_REQUESTED không cho nâng ngân sách) bị lặp lại ở cả `packages/cli/src/commands/retry.ts` lẫn logic tương tự trong `packages/core/src/orchestration/budget.ts` — an toàn (double-checked) nhưng trùng code.
- Bằng chứng (`evidence`) trong test của fake media prober còn mỏng — chưa assert đủ field khi một checker media trả `fail`.
- `FfprobeMediaProber.probe()` fallback `width`/`height` về `0` khi ffprobe không trả stream video đủ thông tin — có thể không khớp một ràng buộc `min(1)` nếu contract media siết lại sau này; chưa kiểm tra kỹ.
- `FfprobeMediaProber` hardcode `maxBuffer` 16MB cho `spawnSync`, không cho override qua constructor — đủ cho fixture, có thể cần chỉnh khi probe file rất lớn ngoài đời thật.
- Wrapper giả `cut.mjs`/`thumbnail-render.mjs` (fixture footage) throw `Error` thô thay vì `ctx.fail(...)` khi input thiếu — `ScriptExecutor` vẫn bắt được (process thoát khác 0 mà không có `stage-result.json` → "transient"), nhưng `errors[].kind`/`message` thiếu ngữ cảnh cụ thể của lỗi.
- `tests/integration/footage-helpers.ts`'s `cli()` và `cliAsync()` là hai hàm spawn gần giống nhau (đồng bộ/bất đồng bộ), chưa hợp nhất.
- `executors/scripts.yaml` thật của `fixtures/ops-project-footage` bị chép tay thành một template string thứ hai trong `footage-helpers.ts`'s `scriptsYaml()` (để pin `cwd` cho project tạm) — hai nơi phải sửa cùng lúc nếu đổi fixture, ghi chú "kept in sync by hand" ngay trong code nhưng không có test canh giữ.
- Hàm `workspacePathFromUri` (chuyển `file://` URI của workspace thành đường dẫn hệ điều hành, xử lý riêng ổ đĩa Windows `/E:/...`) bị chép lại y hệt ở `tests/acceptance/16-secret-e2e.test.ts` thay vì import từ `footage-helpers.ts` (nơi định nghĩa gốc, không export).
- World của `tests/acceptance/12-old-run-explainable.test.ts` không đóng `SqliteStateStore` sau khi chạy — rò file handle trong bộ test, không ảnh hưởng sản phẩm.
- `invalidateDownstream` so checksum của run cũ với checksum vừa commit mà không loại trừ trường hợp run cũ đó đang **reuse** (giữ `reused_artifact_ids` trỏ sang artifact của một run khác nữa, không phải artifact của chính nó) — một run thuần "con trỏ" như vậy có thể bị đánh STALE dù chưa từng tự tạo artifact nào của riêng nó; sửa một dòng (so trực tiếp `held` qua `reused_artifact_ids` khi có) nhưng chưa làm ở 2B.
- Đường "reuse lúc release" (`tryLateReuse` trong `releaseReady`) hiếm khi có dịp chạy thật trong bộ test hiện tại: phần lớn kịch bản reuse đã khớp ngay lúc `plan()` trước khi tới `releaseReady`; test acceptance #7 phủ đường release qua gate, nhưng chưa có test cho stage không dưới gate nào vẫn phải chờ tới `releaseReady` mới reuse được.
- Chưa có test nào re-run thật một stage dùng ffmpeg ở lần chạy thứ hai của cùng variant (nội dung input đổi thật sự, không phải reuse) — các test hiện tại thiên về xác nhận đường "reuse" hơn đường "phải chạy lại vì cache key đổi" cho riêng các stage ffmpeg.
