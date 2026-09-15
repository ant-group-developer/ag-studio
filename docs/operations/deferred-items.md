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
- ✅ **Đã đóng ở review cuối 2B — scripts.yaml của fixture không còn bị chép tay.** `footage-helpers.ts`'s `scriptsYaml()` đọc chính `fixtures/ops-project-footage/executors/scripts.yaml`, parse bằng `yaml`, set `cwd` tuyệt đối cho từng script rồi `stringify` lại (`yaml` đã thêm vào devDependencies gốc). Fixture `source-catalog/sources.yaml` cũng đổi thành `sources: []` (file mẫu nằm trong `raw/` bị git-ignore) để `harness doctor` trên bản vừa clone không FAIL dòng `sources`.
- Hàm `workspacePathFromUri` (chuyển `file://` URI của workspace thành đường dẫn hệ điều hành, xử lý riêng ổ đĩa Windows `/E:/...`) bị chép lại y hệt ở `tests/acceptance/16-secret-e2e.test.ts` thay vì import từ `footage-helpers.ts` (nơi định nghĩa gốc, không export).
- World của `tests/acceptance/12-old-run-explainable.test.ts` không đóng `SqliteStateStore` sau khi chạy — rò file handle trong bộ test, không ảnh hưởng sản phẩm.
- ✅ **Đã đóng ở review cuối 2B — invalidation bỏ qua run con trỏ.** `invalidateDownstream` resolve tập checksum "đang giữ" của run cũ qua `reused_artifact_ids` khi stage đó được reuse (helper `heldChecksums`, cùng cách `acceptedInputsFor`/`findReusableArtifacts` resolve), nên một run thuần con trỏ không còn bị đánh STALE khi nội dung mới trùng đúng byte nó đang trỏ tới (`packages/core/src/orchestration/invalidation.ts`).
- Đường "reuse lúc release" (`tryLateReuse` trong `releaseReady`) hiếm khi có dịp chạy thật trong bộ test hiện tại: phần lớn kịch bản reuse đã khớp ngay lúc `plan()` trước khi tới `releaseReady`; test acceptance #7 phủ đường release qua gate, nhưng chưa có test cho stage không dưới gate nào vẫn phải chờ tới `releaseReady` mới reuse được.
- Chưa có test nào re-run thật một stage dùng ffmpeg ở lần chạy thứ hai của cùng variant (nội dung input đổi thật sự, không phải reuse) — các test hiện tại thiên về xác nhận đường "reuse" hơn đường "phải chạy lại vì cache key đổi" cho riêng các stage ffmpeg.

## Hoãn, ít rủi ro — thêm sau review toàn nhánh 2B (ledger 2026-09-13)

Các mục C1/I2/I3/I4/I5/I6 của vòng review này đã sửa trong cùng một đợt (xem ADR mục 36, 37, 40, 41, 44, 48).
Những gì còn lại, đã xem xét và cố ý hoãn:

- `harness status <run_id>` gọi `gateOverdue` quét **mọi** run `WAITING`/`RUNNING` của project và ghi event
  `stage.gate_overdue` cho tất cả, không chỉ cho run được hỏi — tác dụng phụ toàn cục của một lệnh đọc.
  `--json` giờ trả `overdue: string[]` nên ít nhất nhìn thấy được, nhưng phạm vi quét thì chưa thu hẹp.
- Dedupe của `gateOverdue` (và của `warnResourceStarvation`) dựa trên `listEvents({ limit: 200, newest: true })`:
  một run sinh hơn 200 event trong cùng cửa sổ sẽ đẩy event `stage.gate_overdue` cũ ra khỏi tầm nhìn và cảnh
  báo lặp lại sớm hơn cửa sổ.
- `Redactor` của tiến trình CLI con (`harness op ...` do wrapper gọi) không biết secret nào — nó chỉ che giá
  trị `EnvSecretResolver` đã resolve **trong tiến trình đó**, mà tiến trình đó không resolve secret nào; thêm
  vào đó `--payload` đi qua argv nên nằm trong bảng tiến trình của máy. Không rò secret hiện tại (payload của
  wrapper là checksum), nhưng là một kênh cần chú ý nếu sau này payload chứa dữ liệu nhạy cảm.
- `ScriptExecutor` kill script con bằng `child.kill()` (SIGTERM) khi hết deadline/abort, không leo thang
  SIGKILL sau một khoảng chờ: một script bắt SIGTERM mà không thoát sẽ treo tới khi worker chết.
- Buffer stdout/stderr của script con không có trần: một wrapper in ra hàng trăm MB sẽ tích luỹ trong bộ nhớ
  worker (stderr) và trong buffer dòng của `forwardStdout` (stdout).
- Checker `audio-integrity` gọi `prober.probe(path)` rồi `prober.silenceRatio(path)` — hai lần `spawnSync`
  trên cùng một file; `silenceRatio` có thể lấy luôn từ lần probe đầu nếu adapter cache lại.
- Ngưỡng media của profile `footage` (`target_duration_seconds`, `max_silence_ratio`) rộng gần như vô nghĩa
  với fixture 5s hiện tại — checker chạy thật nhưng gần như không thể fail; cần ngưỡng sát hơn khi có nội
  dung thật để các test media thực sự có sức phân biệt.
- Bộ test footage (`tests/integration`, `tests/acceptance/16-*`) chạy ffmpeg thật, tốn vài phút thời gian
  thực trong `pnpm test` chung; nên tách thành một vitest project riêng (hoặc gắn tag) để `pnpm test` mặc
  định nhanh lại, chạy đầy đủ trong CI.
- (Đã sửa trực tiếp, không hoãn: README của `@harness/script-sdk` không còn nhắc "Task 4" và đã ghi rõ
  `ctx.out.file`'s `mime` bị bỏ qua — mime thật lấy từ `outputs[].mime_type` của stage definition.)

## Hoãn, ít rủi ro — sau re-review đợt sửa cuối 2B (2026-09-13)

- `harness plan` với `executors/scripts.yaml` sai schema: `buildContext` nay nuốt `CONFIG_INVALID` vào `configErrors`, nên `plan` chạy tiếp với `requires_resources` của workflow thay vì bản ghi đè của registry (trước đó lệnh dừng ngay). `doctor` vẫn báo lỗi; worker vẫn thất bại rõ (`NOT_FOUND`). Sửa: `plan` ném `configErrors.scripts` như `source sync` (`packages/cli/src/commands/plan.ts`).
- Lỗi cú pháp YAML (không phải sai schema) trong `scripts.yaml`/`sources.yaml` vẫn ném `YAMLParseError` từ `parse()` trước khi tới Zod, nên vẫn làm mọi lệnh (kể cả `doctor`) dừng; `guard()` trong composition chỉ bắt `CONFIG_INVALID`. Sửa: bọc `parse()` trong `loadScriptsRegistry`/`loadSourcesRegistry` thành `CONFIG_INVALID`.
- `heldChecksums` (invalidation) coi `reused_artifact_ids: []` là stage con trỏ rỗng; planner hiện không bao giờ ghi mảng rỗng nên chỉ tiềm ẩn.

## Ghi nhận trong Task 7 sub-project 2C (2026-09-14)

- (Đã đóng ở fix round 1 cùng ngày.) `harness doctor` giờ chỉ quét `workflow.yaml`/`profile.yaml` mà
  `project.yaml.workflows` liệt kê (khi trường này có mặt) thay vì mọi workflow/profile cài trong harness;
  không khai `workflows` giữ hành vi cũ (quét hết). Xem `packages/cli/src/commands/doctor.ts` và
  `ProjectConfigSchema.workflows` (`packages/contracts/src/config.ts`).

## Hoãn, ít rủi ro — thêm sau sub-project 2C (ledger 2026-09-14)

- `LibraryFs.assertWritable`: nhánh `channel` cho phép `requests/<id>.json` chỉ khớp độ dài đường dẫn
  (`segs[0] === "requests" && segs.length === 2`), không kiểm đuôi `.json` — một ghi `requests/<id>.txt` vẫn
  qua được kiểm tra quyền dù `readRequest`/`listRequestIds` sau đó không bao giờ đọc lại nó.
- `copyFileWithChecksum` đọc lại file vừa copy để hash (`sha256File`) **ngoài** khối `try/catch` bao quanh
  chính việc copy — một lỗi đọc ở bước hash (file bị xoá/khoá ngay sau rename) thoát ra như lỗi chưa được bọc
  `HarnessError`, khác các nhánh lỗi khác của cùng hàm.
- `listStyleIds`/`listItemIds` lọc `!e.name.startsWith(".tmp-")` để loại thư mục tạm còn sót — nhưng file tạm
  thật (`writeJsonAtomic`/`copyFileWithChecksum`) đặt tên `<file>.tmp-<uuid>` (hậu tố trên **file**, không
  phải thư mục), nên điều kiện lọc này không bao giờ khớp bất cứ gì trong thực tế.
- `readdirSync(..., { withFileTypes: true })` cộng `e.isDirectory()`/`e.isFile()` bỏ qua symlink một cách âm
  thầm (giống caveat đã ghi cho `listDirectoryFiles` ở 2A/2B) — một style/item/claim được mount vào kho qua
  symlink sẽ không bao giờ được liệt kê.
- So khớp tiền tố `library.root` trong `assertWritable` phân biệt hoa/thường ngay cả trên Windows (không dùng
  so sánh case-insensitive theo hệ điều hành) — `library.root` lệch case giữa hai máy có thể khiến một ghi
  hợp lệ bị từ chối `CONFIG_INVALID` dù cùng trỏ một mount thật (ghi trong runbook `content-library.md` mục 1
  như một điều cần tránh, chưa sửa trong code).
- `LibraryFs` không biết `channel_id` của chính nó — một channel không có cách nào (ở tầng `LibraryFs`) phân
  biệt "request tôi vừa tạo" khỏi request do channel khác tạo, chỉ có thể lọc theo trường `requested_by` sau
  khi đọc nội dung; đây là thiết kế cố ý (role chỉ gate quyền ghi, không gate danh tính), không phải thiếu sót
  cần sửa.
- ~~`readRequest`/`readItem` map **mọi** `IO_ERROR` … thành `NOT_FOUND`~~ — **đã đóng** ở vòng review cuối
  2C: chỉ file không tồn tại (`existsSync`) mới là `NOT_FOUND`; file tồn tại mà hỏng giữ `IO_ERROR`/
  `CONFIG_INVALID` (ADR-0001 mục 62).
- ~~`applyReview` ghi hai file … không phải một transaction~~ — **đã giảm nhẹ** ở vòng review cuối 2C: kiểm
  transition của request trước khi ghi item, ghi item rồi mới ghi request, lỗi ở bước sau mang
  `item_written: true`, và chạy lại cùng quyết định là idempotent (áp nốt nửa request còn thiếu) — ADR-0001
  mục 64. Vẫn **không** phải transaction thật: một crash đúng giữa hai lần ghi vẫn cần người chạy lại
  `harness library review` (runbook `content-library.md` mục 8).
- `claimItem` có khe TOCTOU giữa `existsSync(claimPath)` và `writeJsonAtomic(claimPath, claim)`: hai tiến
  trình `pick` cùng item/channel gần như đồng thời trên cùng máy có thể cùng thấy claim chưa tồn tại và cùng
  tạo `ContentItem` riêng trước khi tiến trình thua ghi đè file claim của tiến trình thắng.
- Nhánh idempotent của `claimRequest` (cùng run gọi lại `intake`) trả về request hiện có mà không gọi
  `store.upsertContentRequest` lại — vô hại (nội dung không đổi) nhưng khác các nhánh ghi khác của
  `requests.ts`/`review.ts`, vốn luôn upsert sau khi ghi file.
- `requests.ts` (`claimRequest`/`fulfillRequest`/`rejectRequest`/`reopenRequest`) lặp lại cùng khuôn
  đọc-kiểm-status-rồi-ghi ở bốn hàm; `review.ts` cũng vậy — chưa rút thành một helper transition chung.
- `withdrawItem` nối ghi chú mới vào `review.note` cũ bằng `\n` giống `rejectRequest` nối vào `notes` — cách
  nối ghi chú này chưa có test cho trường hợp gọi `withdraw` nhiều lần với nhiều ghi chú khác nhau.
- `harness library accept --request <id>` không tiền-kiểm `status` của request — accept một request không
  còn `open` (đã `claimed`/`fulfilled`/`rejected`) vẫn build xong `library_brief`/`ContentItem`; lỗi chỉ lộ ra
  sau, ở `intake` của run vừa `plan` (`INVALID_TRANSITION`, xem ADR mục 53 và runbook `content-library.md`
  mục 3b).
- `stage_run.last_failure_kind` chỉ được ghi khi một retry thật sự **được lên lịch** (`scheduleRetry`); một
  contract failure (như `intake` gặp request đã bị claim) không bao giờ retry nên `last_failure_kind` giữ
  nguyên giá trị cũ (hoặc rỗng) — lý do thật của lần fail gần nhất luôn nằm ở `failure_kind` của **attempt**
  cuối, không phải ở `stage_run.last_failure_kind` (hành vi có từ trước 2C, không riêng cho kho, nhưng lần
  đầu gây nhầm lẫn khi đọc log của acceptance test #19).
- `fixtures/ops-project-studio/library` và `fixtures/ops-project-channel/library` không tồn tại trên một bản
  clone repo mới (`library.root: ./library` bị git-ignore) — thử tay cần tự tạo `styles/`/`requests/`/`items/`
  hoặc trỏ sang một kho tạm, như `freshLibraryWorld()` của bộ test làm (xem README quick-start).

## Hoãn — ghi nhận ở vòng review cuối 2C (2026-09-14)

- `library-export-valid` (`packages/core/src/verification/library-checkers.ts`) trộn hai loại đường dẫn trong
  `evidence.path`: một số nhánh fail trả đường **tương đối theo workspace** (`o.path`, nhánh "unreadable"),
  số khác trả đường **tuyệt đối** (`receiptPath`, `filePath` — đường trong kho). Người đọc evidence phải tự
  đoán gốc. Thống nhất (luôn tuyệt đối, hoặc luôn kèm cả hai trường) khi có dịp — ghi nhận từ Task 5.
- Cả `style-export` (style-study) và `library-export` (library-production) khai output `type:
  export_receipt`, nhưng **hai hình dạng khác nhau**: style-export ghi `{ style_id, revision, dir }`,
  library-export ghi `ExportReceipt` (`{ item_id, item_dir, files[], manifest_checksum }`). `library-export-
  valid` chỉ hiểu hình dạng thứ hai — hôm nay vô hại vì `style-export.required_checks` không có nó, nhưng
  thêm `library-export-valid` vào `style-export` (hay bất kỳ stage nào khác xuất `export_receipt`) sẽ fail
  ngay với `invalid receipt`. Tách thành hai `type` riêng (`style_export_receipt` / `item_export_receipt`)
  là cách sửa gốc.
- `rejectRequest` (`packages/core/src/library/requests.ts`, `claimed → rejected`) vẫn **không có đường gọi**:
  không CLI, không stage nào dùng — `library-apply-review` từ chối item bằng `reopenRequest` (request về
  `open`) chứ không bao giờ `rejected`. Trạng thái `rejected` của một `content_request` do đó chỉ đến được
  bằng cách sửa tay file trong kho. Giữ lại vì `reopenRequest` nhận cả `rejected` làm đầu vào (đường phục hồi
  cho một request bị sửa tay); nối vào CLI (`library request reject`) khi thật sự cần.
- Đường đọc kho (`readRequest`/`readItem`/`readStyle`) chưa gọi `assertRootMounted`: root rớt hẳn → `existsSync` false → `NOT_FOUND` → `library-stage` map thành contract failure (chờ người) thay vì `transient`. Sửa: kiểm `fs.exists()` trước `existsSync(path)` trong ba hàm đọc, thêm test; sau đó sửa lại câu ở ADR §62 và AGENTS. (Re-review đợt fix cuối 2C.)
- `applyReview` replay khi request đã được run mới re-claim trả về im lặng (không ghi gì, không báo); bản `--json` có `request_status` để nhận ra. Cân nhắc in cảnh báo ở bản text.
- `ContentItem` tạo trước khi có `library_channel_id` sẽ bị `pick` lại tạo thêm bản mới (không ảnh hưởng vì 2C chưa từng phát hành).
- Test tích hợp `library-pipeline`: scenario 2 phụ thuộc scenario 1 (dùng chung world + style thật); chạy lẻ `-t` sẽ fail có thông báo rõ.

## Sau sub-project 3 (ledger 2026-09-14/15)

Rút từ ledger SDD (`.superpowers/sdd/2026-09-14-sub-project-3-channel-publish/progress.md` — thư mục
`.superpowers/` nằm trong `.gitignore`, **không commit**, nên ledger chỉ có trên máy đã chạy vòng SDD đó) và spec §11
(`docs/superpowers/specs/2026-09-14-sub-project-3-channel-publish-design.md`). Đọc code trước khi tin lệch
(`packages/core/src/distribution/`, `packages/adapters/{youtube-playwright,agent-cli}/`,
`packages/cli/src/commands/{channel,publish,publish-stage,dashboard,doctor}.ts`).

- ✅ **Đã đóng ở Task 12 — `Redactor` không biết secret email khi upload/schedule chạy trong tiến trình CLI
  con.** `uploadStage`/`scheduleStage` (`packages/cli/src/commands/publish-stage.ts`) giờ tự
  `app.secrets.resolve(channel.config.youtube.account_email_ref)` ngay trước khi gọi `Publisher` (bọc
  try/catch, không fail stage vì secret unresolved), chỉ để đăng ký giá trị với Redactor của chính tiến
  trình mình (ADR-0001 mục 80; gap ghi nhận cuối Task 11, có test ở `packages/cli/test/publish-stage.test.ts`).

### Rủi ro vận hành (spec §11, chưa có gì để sửa trong code)

- **DOM YouTube Studio đổi** làm hai script Playwright cũ hỏng âm thầm: harness chỉ thấy `transient`/
  `unknown` từ `PlaywrightPublisher`, `harness doctor` không phát hiện được (không kiểm nội dung DOM, chỉ
  kiểm file/profile tồn tại) — người vận hành nhận biết qua log `upload-debug/` của repo kênh (ghi trong
  runbook `channel-publish.md`).
- **Lịch đặt tay ngoài harness** (ai đó tự đặt lịch trên Studio) không được `nextSlot()` biết tới — nó chỉ
  tính theo `PublicationJob` đã có trong state store, nên có thể trùng khung với một lịch đặt tay; sweep
  `verify` phát hiện lệch sau đó (SP3B, khi verify/reconcile đọc trực tiếp Studio nhiều hơn).
- **Chrome ≥127 App-Bound Encryption**: `.upload-profile/` không copy được giữa máy — mỗi máy phải tự
  `harness channel login <id>` một lần; đăng nhập không đồng bộ qua git/rsync được.
- **Phiên đăng nhập hết hạn âm thầm**: không có cách chủ động phát hiện ngoài một lần `upload`/`schedule`
  refused (script cũ tự thoát exit 3) — dashboard không có cờ "đã login thật", chỉ có `profile_dir_exists`
  (thư mục có mặt, không phải phiên còn hiệu lực).
- **Script cũ khác nhau giữa các repo kênh thật**: `Publisher` chỉ hứa giao diện argv/exit-code/
  `publish-queue.json`; một kênh có script lệch khuôn phải tự chuẩn hoá tay trước khi nối vào harness (không
  có adapter tự sửa).

### `packages/core/src/distribution/` — core

- `PublicationState` (`export type PublicationState = (typeof PUBLICATION_STATES)[number]`,
  `packages/contracts/src/entities.ts:267`) không có nơi nào import — thừa từ Task 2, không dùng để gõ kiểu
  `PublicationJob.state` ở bất kỳ chữ ký hàm nào trong `packages/core`/`packages/cli` hiện có (chúng dùng
  `string`/suy luận từ `PublicationJob`). Ruling: giữ nguyên (không phải bug, không tốn gì) — xoá hoặc bắt đầu
  dùng nó lần tới có ai sửa `packages/contracts/src/entities.ts` cho khu vực này (Task 2).
- `createDraftPackage`'s guard cho `library_item_id` thiếu chưa có test riêng (Task 3).
- `zonedToUtc` (dùng bởi `nextSlot`) không xử lý riêng giờ DST bị nhảy/lặp (spring-forward gap, fall-back
  ambiguous hour) — dùng `Intl.DateTimeFormat` thô, hành vi ở đúng giờ chuyển DST chưa được assert (Task 3).
- Nhánh mức độ `info` (không phải `warn`/`error`) của `transitionPublication` khi ghi `Event` chưa có test
  khẳng định riêng (Task 3).
- `channel-identity` (checker, `checkers.ts`) gọi `channels.get()` không bọc guard tồn tại — một `channel_id`
  không nạp được sẽ ném thay vì trả `fail` có ngữ cảnh (Task 4).
- Năm checker của `distributionCheckers` lặp lại gần như y hệt khối đọc + parse output — chưa rút thành một
  helper chung (Task 4).
- Nhánh `reconcilePublication` khi op đã `CONFIRMED` (không phải `NEEDS_RECONCILIATION`) chưa có test riêng
  (Task 4).
- `FakePublisher` (`adapter-fake`) nuốt lỗi parse `publish-queue.json` thay vì báo rõ (Task 4).
- `resolveManifestPath` (checker `package-integrity`) dùng `isAbsolute` của platform hiện tại — một manifest
  ghi đường tuyệt đối kiểu khác hệ điều hành (ví dụ POSIX trên máy Windows) có thể bị hiểu sai (Task 4).
- `nextSlot`/`buildUploadManifest`: `upload-manifest.template.json` (template cũ của repo kênh) mang giá trị
  placeholder — chấp nhận nguyên trạng vì bản thân template của hệ thống cũ vốn chỉ là placeholder, không
  phải nội dung thật cần harness kiểm (ruling Task 5, không phải bug).

### `packages/adapters/youtube-playwright/` — Publisher thật

- `runScript` (spawn script cũ) dùng chung một buffer dòng cho cả stdout lẫn stderr — dòng từ hai luồng có
  thể xen kẽ sai thứ tự thật trong `log_tail` (Task 5).
- Chế độ "im lặng" của script cũ (exit 0, không có dòng `publish-queue.json` khớp) chưa có test riêng cho
  nhánh `unknown` tương ứng (Task 5).
- `episode_no` dạng số (thay vì đã pad `NN`) truyền vào lệnh script cũ chưa có test (Task 5).
- `lookup.mjs` (script adapter, chạy Playwright thật để đọc Studio) không được chạy trong bộ test tự động
  (cần Chrome thật) — chỉ `queue.ts`/exit-code mapping có test; `lookup.mjs` cũng chưa capture `publish_at`
  cho một video đang ở trạng thái Scheduled (Task 5, Task 8 §8 của spec).

### `packages/adapters/agent-cli/` — AgentRuntime thật

- `combinedLog` (log gộp stdout+stderr của CLI agent) bị redact hai lần (vô hại, chỉ dư việc) (Task 6).
- `sha256File` được cài lặp lại ở ba nơi quanh package boundary — chưa gộp thành một helper dùng chung
  (Task 6).
- `child.kill()` khi hết timeout không giết được tiến trình cháu của CLI thật (`claude`/`codex` có thể tự
  spawn tiến trình con) — treo tài nguyên nếu agent thật bị timeout giữa chừng (Task 6).

### `packages/cli/src/commands/publish-stage.ts` — bốn stage built-in

- Log stderr của `gen-thumb-overlay.mjs` bị discard bởi catch-all của `runStage` trước khi redact — mất ngữ
  cảnh lỗi thật khi overlay script fail (Task 8).
- `listChannelPackages({run_id})[0]` (tìm gói draft của run hiện tại, dùng khi attempt `build-package` chạy
  lại) không sắp thứ tự tường minh — dựa vào thứ tự trả về ngầm định của store (Task 8).
- Receipt idempotent của `upload` (khi job đã `PROCESSING`/`SCHEDULED`/`PUBLISHED`) dùng chuỗi rỗng làm sentinel
  cho `video_id`/`operation_id` thay vì `null`/thiếu trường (Task 8).
- Ba hàm `parseDraft`/`parsePackageReceipt`/`parseUploadReceipt` gần như giống hệt nhau — chưa rút thành một
  helper generic (Task 8).
- `fetchStage` luôn đăng ký output `episode_video` dù file `episode.mp4` không tồn tại trong `manifest.files`
  — lỗi lộ ra muộn, ở bước `writeJsonOutput`/`sdk.out.file`, dưới dạng `transient` mơ hồ thay vì `contract` rõ
  ràng (Task 8).
- `publish-stage.ts` dài (~400 dòng sau Task 12): nửa `build-package` ghi trực tiếp vào repo kênh có thể tách
  xuống `packages/core` để dễ test đơn vị hơn (Task 8).
- `updatePublicationJob` không tự bump `updated_at` ở một số điểm gọi — không sai dữ liệu nghiệp vụ nhưng
  không nhất quán với các hàm ghi khác (Task 8).
- Nhánh op `NEEDS_RECONCILIATION` trong khi job vẫn `UPLOADING` (một tổ hợp hiếm, không phải nhánh chính của
  `recoverUploading`) chưa có test riêng (Task 8).

### `harness channel`/`publish`/`dashboard` — CLI người dùng

- `harness channel login` (spawn `open-channel-chrome.mjs` hoặc in dòng lệnh Chrome tay) chưa có test tự
  động — fixture Chrome giả chưa được viết (Task 9).
- Ba chỗ trong CLI publish tự gộp `listPublicationJobs` theo tay (đếm theo state, lọc theo channel) thay vì
  dùng chung một helper (Task 9).
- `packages/cli/test/dashboard.test.ts` chỉ kiểm một project không có kênh nào (phần snapshot có kênh đã
  được `packages/core/test/dashboard/snapshot.test.ts` phủ, nhưng chưa có test CLI end-to-end cho
  `dashboard snapshot`/`serve` trên một project có kênh thật) (Task 10).
- `DoctorRow` chỉ có `ok: boolean`, không có mức độ nghiêm trọng (`warn` vs `fail`) — mọi dòng doctor hiện
  nhị phân, dù một số (như `channel:<id>:profile` chưa đăng nhập) về bản chất "chưa cần" hơn là "hỏng"
  (Task 10).
- Một kênh cấu hình sai (nằm trong `channelErrors`) không xuất hiện trong `snapshot.episodes[]` — dashboard
  không có cách hiển thị "kênh này đang lỗi cấu hình", chỉ có dòng doctor tương ứng (Task 10).
- `fallbackChannel` (dùng khi build snapshot cho project không có kênh nào) lặp lại logic lọc doctor-row đã
  có ở nơi khác — chưa gộp (Task 10).

### Vệ sinh test (Task 11)

- Helper `copyRepo` (chép `fixtures/legacy-channel-repo` vào temp dir cho mỗi test) được cài lặp lại lần thứ
  ba — ở `tests/integration/publish-helpers.ts` và (theo cùng khuôn) trong test CLI riêng — chưa gộp về một
  chỗ dùng chung.
- `PublishWorld` (kiểu world dùng bởi test tích hợp publish) cần một ép kiểu (`as`) ở một chỗ do interface
  chưa khớp hoàn toàn hình dạng thật.
- Vòng lặp `drain` trong test tích hợp publish chờ tối đa 30 lượt worker — dư khá nhiều so với số lượt thật
  sự cần cho một chu trình 5-stage; chưa thu hẹp.

### Việc vặt khác, không phải bug (Task 1, Task 7)

- `packageMetadataSchema`'s tên field/type chữ thường theo đúng yêu cầu brief (không phải sai sót cần sửa,
  ghi lại vì khác quy ước PascalCase/camelCase thường thấy ở các schema khác — xem ghi nhận cuối 2A về cùng
  chủ đề).
- `pnpm gen:schemas` ở Task 1 sinh lệch dòng cuối (CRLF) trên bốn file JSON Schema không liên quan tới
  sub-project 3 — bản lệch bị bỏ (discard), chỉ khác xuống dòng, không khác nội dung.
- Số dòng báo cáo ở report của Task 7 không khớp số dòng thật (lỗi đếm khi viết báo cáo, không phải lỗi
  code) — không cần sửa gì trong repo.

## Hoãn — ghi nhận ở re-review đợt sửa cuối sub-project 3 (2026-09-15)

Bảy quan sát ngoài phạm vi của re-review cuối; không mục nào chặn merge. Ruling của người điều phối ghi cạnh từng mục.

- `alreadyScheduledAt` (`packages/cli/src/commands/publish-stage.ts`) coi lookup `error: true` như "chưa có
  lịch" rồi đặt lịch lại trên **cùng** video id (không tạo video thứ hai, chỉ có thể dời giờ phát). Ruling: hoãn —
  lần sửa sau cho retry fail `transient` khi không hỏi được YouTube, thay vì đặt lịch.
- `lookupViaScript` (`packages/adapters/youtube-playwright/src/playwright-publisher.ts`) không validate JSON do
  `lookup.mjs` in ra bằng schema; script exit 0 in `{}` sẽ thành "không tìm thấy" dứt khoát. Ruling: hoãn — thêm
  zod parse cho `LookupOutcome` khi chạm file này lần tới; `lookup.mjs` thật luôn đặt `found`.
- `migrations/0004_distribution.sql` được sửa tại chỗ trong nhánh (index unique một phần) và runner chỉ theo dõi
  tên file: máy nào đã chạy bản cũ của nhánh (chỉ máy dev/temp trong phiên này) giữ index cũ. Ruling: chấp nhận —
  migration chưa từng có trên `main`; máy kênh thật chưa có DB nào áp 0004 bản cũ.
- Hai job "sống" trùng `idempotency_key` giờ ném lỗi SQLite thô trong `build-package` → `transient` (retry) thay
  vì thông điệp của checker `duplicate-upload`. Chỉ xảy ra khi hai run cùng kênh có cùng `video_checksum` **và**
  `manifest_digest` (số tập khác nhau nên gần như không thể). Ruling: hoãn — bắt `SQLITE_CONSTRAINT` trong
  `createJob` và ném `HarnessError("INVALID_TRANSITION")` khi có dịp.
- `harness publish slots --days abc` (alias ẩn) báo lỗi nêu tên `--count`. Ruling: chấp nhận (alias ẩn, thông
  điệp vẫn đúng ý).
- `parseScheduledAt` trong `lookup.mjs` lấy ngày đầu tiên trong text của hàng Studio; hàng hiển thị ngày upload
  trước ngày hẹn có thể cho `publish_at` sai. Chỉ dùng khi `visibility === "scheduled"`; sweep `verify` sẽ bắt
  lệch sau. Ruling: hoãn tới khi có mẫu DOM thật để chỉnh selector.
- `cli-agent-runtime.ts` map **mọi** lỗi spawn (ENOENT, EACCES, EPERM…) thành `contract`; spec §4.3 chỉ nói tới
  "không có trên PATH". Ruling: chấp nhận — các lỗi đó đều cần người can thiệp, retry tự động không giúp gì.

## Sau sub-project 4 (ledger 2026-09-15)

Rút từ ledger SDD (`.superpowers/sdd/2026-09-15-sub-project-4-studio-autopilot/progress.md` — thư mục
`.superpowers/` nằm trong `.gitignore`, **không commit**, nên ledger chỉ có trên máy đã chạy vòng SDD đó) và
spec §10 (`docs/superpowers/specs/2026-09-15-sub-project-4-studio-autopilot-design.md`). Đọc code trước khi
tin lệch (`packages/core/src/media/watch.ts`, `packages/core/src/library/auto-accept.ts`,
`packages/cli/src/commands/media.ts`, `fixtures/fake-agent-cli.mjs`, `skills/`).

### Lỗi tài liệu đã biết, chưa sửa lúc Task 9 commit

> Cập nhật (đợt rà soát cuối sub-project 4): mục đầu tiên dưới đây **đã sửa** — hai SKILL.md giờ bảo agent tự
> sinh `style_id`/`hypothesis_id` (Crockford base32) và `created_at`/`updated_at` (ISO 8601 UTC), và
> `packages/adapters/agent-cli/test/fake-agent-outputs.test.ts` grep mọi `skills/*/SKILL.md` để claim này
> không quay lại. Mục `style-review` overclaim quyền công cụ thì **chưa** sửa.

- **`skills/style-analyze/SKILL.md` và `skills/channel-package/SKILL.md` claim sai** (đã sửa, xem ghi chú
  trên): cả hai nói
  `style_id`/`created_at`/`updated_at` (và `hypothesis_id`/`created_at` ở `channel-package`) "để trống hợp lý
  nếu môi trường không có generator — harness sẽ điền lại nếu thiếu". Sai: schema Zod tương ứng
  (`editStyleSchema`, `packageMetadataSchema` hay tương đương) đòi các trường này là chuỗi khớp định dạng
  ngay, không có cơ chế điền lại nào ở harness — một agent thật để trống các trường đó sẽ fail checker
  `schema-valid` ngay lập tức. `channel-package` claim này đã có từ sub-project 3 (ghi nhận ở ledger Task 6
  sub-project 4 là "same false claim pre-exists"), `style-analyze` là bản sao lỗi tương tự viết mới ở Task 6
  sub-project 4. **Rủi ro chạy thật**: đây là claim nằm ngay trong SKILL.md mà một agent `claude`/`codex`
  thật sẽ đọc và làm theo — nếu để trống các trường bắt buộc, lần chạy thật đầu tiên (DoD #3,
  `docs/runbooks/studio-autopilot.md` mục 9) sẽ fail ngay ở checker, không phải một vấn đề chỉ lộ ra khi có
  người đọc tài liệu. Sửa: xoá câu "harness sẽ điền lại nếu thiếu" ở cả hai file, thay bằng hướng dẫn agent
  tự sinh `style_id`/`hypothesis_id` (ULID) và `created_at`/`updated_at` (ISO 8601 tại thời điểm ghi) — để ở
  đợt sửa cuối cùng của sub-project 4/rà soát skill chung, không chặn merge nhánh này.
- **`skills/style-review/SKILL.md` overclaim quyền công cụ**: dòng "skill này không có quyền
  `WebSearch`/`WebFetch`" không đúng — `allowedTools` (`RUNTIME_COMMANDS.claude.argv` trong
  `packages/adapters/agent-cli/src/cli-agent-runtime.ts`) là một chuỗi cố định cho **toàn bộ phiên CLI**,
  không phân biệt theo từng skill/stage; `style-analyze` được liệt trong cùng danh sách
  `WebSearch,WebFetch` mà `style-review` dùng chung runtime. Nội dung SKILL.md không tự chặn được việc agent
  gọi các tool đó, chỉ là hướng dẫn hành vi (không nên dùng), không phải một ràng buộc kỹ thuật. Ghi lại đúng
  câu ("theo hướng dẫn, không dùng WebSearch/WebFetch cho stage này — quyền thật vẫn có") khi sửa cùng đợt
  với hai mục trên.

### `packages/core/src/media/watch.ts` — stage `watch`

- `pickFrameTimes` không tự khử trùng khoảng mốc đều dưới 1 giây trong chính nó (chỉ khử trùng khi hợp với
  scene-change) — `interval_seconds` cấu hình nhỏ hơn 1 có thể sinh mốc trùng gần nhau.
- Contact sheet dừng giữa vòng vẽ (`drawtext` lỗi ở một sheet) để lại sheet nhãn thiếu một phần thay vì bỏ
  hẳn sheet đó hoặc thử lại toàn bộ không nhãn.
- `detectSceneChanges` nuốt lỗi ffmpeg thành mảng rỗng — **đã sửa một nửa** ở đợt rà soát cuối sub-project 4:
  ffmpeg không spawn được (ENOENT/EACCES) giờ ném `CONFIG_INVALID`, nhưng một lần chạy thật trả mã khác 0
  (file hỏng, codec lạ) vẫn trông giống "không có scene nào".
- ~~Khối ghi `watch.json` bị lặp lại ở hai nhánh~~ — đã rút thành `writeWatchIndex` (đợt rà soát cuối).
- `label` (tên thư mục con `output/watch/<label>/`) không được làm sạch trước khi join đường dẫn — một
  `samples.json` với `label` chứa `/`/`..` có thể ghi ra ngoài thư mục dự kiến (input `samples.json` do
  wrapper `collect-samples` của chính ops project ghi, không phải dữ liệu ngoài, nên rủi ro thấp trong thực
  tế hôm nay).

### `packages/cli/src/commands/media.ts` / stage script

- `readJsonFile` map JSON hỏng thành `CONFIG_INVALID`; các hàm đọc JSON tương tự ở nơi khác trong repo dùng
  `IO_ERROR` cho lỗi đọc file — không nhất quán mã lỗi giữa các stage (không sai hành vi, chỉ khác phân loại
  khi người đọc log tra cứu theo mã).
- `runStage`/`readJsonFile` bị chép lặp lại ở nhiều file stage (`watch`, và các stage built-in khác) thay vì
  gộp vào `packages/cli/src/commands/shared.ts`.
- ~~`--mode samples` xử lý tất cả-hoặc-không-gì khi rơi về `watchFromExistingFrames`~~ — **đã sửa** ở đợt rà
  soát cuối sub-project 4: `handleSamples` phân giải từng mục một, chỉ mục nào mất file mới rơi về khung có
  sẵn (và `collect-samples.mjs` ghi `path` tương đối cho clip tải về nên chúng không còn mất đường dẫn sau
  khi workspace đổi tên thành `artifacts/`).

### `packages/core/src/library/auto-accept.ts` / CLI `library styles activate`, `request create`

- ~~Doctor `library:auto_accept` và dashboard alert `request_stuck` không nhìn `library.role` lẫn
  `auto_accept.enabled: false`~~ — **đã sửa** ở đợt rà soát cuối sub-project 4: cả hàng doctor lẫn alert giờ
  đòi `role === "studio"` **và** `enabled`, đúng điều kiện `autoAcceptDepsFor` của worker dựng vòng lặp.
- Nhánh nuốt lỗi (`try/catch` quanh `maybeAutoAccept` trong worker) chưa có test riêng cho trường hợp
  `autoAccept` tự ném lỗi bất ngờ (khác `request.auto_accept_failed` đã xử lý có chủ đích cho lỗi
  planner/workflow).
- Biên `finished === max_replans` (đúng lần thử cuối cùng còn được phép) chưa có test riêng — test hiện có
  phủ `< max_replans` (còn thử) và `> max_replans` (đã kẹt), không phủ đúng ranh giới bằng.
- `AutoAcceptDeps.fs` được khai trong interface nhưng không hàm nào trong `auto-accept.ts` thật sự dùng nó.
- `autoAccept` chỉ được gọi ở nhánh **idle** của worker (không còn việc gì khác để dispatch) — `library.
  auto_accept.max_concurrent_runs > 1` vì vậy không bao giờ được "châm" thêm run trong khi worker đang bận
  dispatch việc khác, dù còn dưới hạn mức; đây là hành vi kế thừa từ cách `maybeSyncLibrary` (2C) cũng chỉ
  chạy ở nhánh idle, không phải lỗi riêng của sub-project 4.
- `finishedRunCounts` quét lại toàn bộ run mỗi lần `autoAccept`/dashboard `buildSnapshot` gọi (không cache
  giữa các lần gọi liền nhau) — chấp nhận được ở quy mô hiện tại, cùng dạng đánh đổi với `gateOverdue`/
  `warnResourceStarvation` đã ghi nhận ở các sub-project trước.
- `isTerminal("run", state)` coi **mọi trạng thái run không nhận ra** là terminal (mặc định an toàn hiện
  tại, vì mọi trạng thái run có thật hôm nay đều đã liệt kê) — một trạng thái run mới thêm sau này mà quên
  cập nhật `isTerminal` sẽ bị đếm nhầm là "đã kết thúc" trong `finishedRunCounts`, ảnh hưởng trực tiếp
  `max_replans`. Tiềm ẩn, chưa xảy ra.
- `intake` (built-in stage) đọc lại request từ kho **sau khi** `claimRequest` đã ghi — thừa một lần đọc so
  với việc dùng thẳng giá trị `claimRequest` vừa trả về.
- `--source-id` của `library request create` không được CLI tiền-kiểm là một source thật đã ingest (giống
  tiền lệ `--style`/`--source` ở các lệnh `library`/`content` khác trong repo, không riêng gì sub-project
  4) — id sai chỉ lộ ra khi `autoAccept` thử chọn nguồn và không thấy gì khớp.
- `library styles activate --note <n>` nhận tham số nhưng **không lưu** vào đâu cả — `EditStyle` schema
  không có trường `note`/`activation_note`; cờ này hiện chỉ có tác dụng tài liệu hoá trong lệnh gọi, không
  đọc lại được sau đó.
- Tăng `revision` khi `retired → active` (nhánh `activateStyle` có viết code cho trường hợp này) không có
  đường nào gọi tới được hôm nay — chưa có lệnh CLI nào đưa một style sang `retired` (giống `rejectRequest`
  không đường gọi ở 2C, ADR mục tương ứng).

### Ngũ skill (`skills/{style-analyze,style-review,source-survey,edit-plan,library-review}/`)

- `fitShotsToRange` (dùng trong ràng buộc thời lượng của `edit-plan`) trả `[]` khi tham số `max` là
  `<= 0` thay vì báo lỗi cấu hình rõ ràng.
- `buildStyle` (helper của `fake-agent-cli.mjs`, đứng thay agent thật khi test) bị gọi lặp lại một lần mỗi
  output thay vì tính một lần rồi dùng chung — chỉ ảnh hưởng tốc độ test, không phải sản phẩm.
- Đường `collect-samples` tải URL thật qua `yt-dlp` (không phải `FAKE_YTDLP=1`) chưa có test nào chạy qua —
  bộ test hiện tại luôn giả lập, đúng theo brief ("harness lõi không gọi yt-dlp trực tiếp") nhưng nghĩa là
  hành vi thật của wrapper trên một máy có `yt-dlp` cài sẵn chưa được xác nhận tự động.

### Workflow `@1.1.0`

- Test cho nhánh `voice: "none"` của `library-production@1.1.0` chưa assert riêng việc `depends_on_optional`
  (stage `tts`) được rewire đúng khi `when` loại nó khỏi graph — hành vi rewire tự nó có test chung từ 2A,
  chỉ riêng workflow 1.1.0 chưa có assertion trực tiếp cho trường hợp cụ thể này.
- `watch-episode` không khai `requires_resources` trong khi `watch-samples`/`watch-source` đều khai `[cpu]`
  — bất đối xứng có trong chính brief (task 7), chưa rõ có chủ đích hay chỉ là sót.

### Test tích hợp/acceptance (Task 8)

- Acceptance 29 chứng minh "không có `ContentItem`/run thứ hai" bằng cách đếm sự kiện
  `request.auto_accepted`, không phải đếm trực tiếp số `ContentItem` trong DB — gián tiếp nhưng đủ, vì mọi
  `ContentItem` do autopilot tạo đều đi kèm đúng một sự kiện đó.
- `acceptedEventsFor` (đọc sự kiện `request.auto_accepted` từ state store) được chép lặp lại ở acceptance
  27/28/29 thay vì gộp vào `tests/integration/library-helpers.ts`.
- `bothRunsTerminal` (dùng trong test chờ acceptance 27/28) mở lại `SqliteStateStore` mỗi lần gọi trong vòng
  lặp poll thay vì giữ một kết nối — chỉ ảnh hưởng tốc độ test.
- Một comment inline giải thích cơ chế retry ở test acceptance viết chưa chính xác hoàn toàn (nội dung mã
  đúng, chỉ chú thích cần rõ hơn) — không ảnh hưởng kết quả test.
- Acceptance 28 (`reject-always`, `max_replans: 1`, khẳng định đúng hai run rồi dừng) có ngân sách 400 vòng
  lặp poll — nhạy với tải máy chạy CI/máy chậm, giống caveat "load-sensitivity" đã ghi ở acceptance khác của
  các sub-project trước (không sửa riêng, ghi nhận theo cùng khuôn).

### Rủi ro vận hành (spec §10, chưa có gì để sửa trong code)

- **Chất lượng agent không kiểm chứng được bằng test tự động**: mọi test/fixture đều dùng
  `fake-agent-cli.mjs`, luôn ghi output "hợp lệ" theo schema bất kể nội dung có đúng hay không — DoD #3
  (`docs/runbooks/studio-autopilot.md` mục 9) là kiểm tay duy nhất; checker + bảng kiểm sáu mục của
  `library-review` là lưới an toàn cuối cùng trước khi một mục vào kho `approved`.
- **Chi phí agent**: năm stage agent (ba của `library-production@1.1.0` mỗi lần dựng một tập — `survey-
  source`, `plan-edit`, `library-review` — cộng hai của `style-study@1.1.0` chạy một lần mỗi khi học style
  mới — `analyze-style`, `style-review`; spec §10 viết "4 stage agent" gộp lẫn hai workflow, sửa lại ở đây
  cùng lý do với ADR-0001 mục 92) đều đọc ảnh (contact sheet trước, tối đa 20 khung đơn); contact sheet giảm
  số lần gọi model khoảng 10× so với gửi từng khung rời. `max_cost_usd_per_variant: 8` (profile `studio`)
  chặn ở mức **run**, chưa có trần chi phí theo ngày/portfolio.
- **Ngưỡng scene-change 0.3`** phù hợp footage cắt cảnh rõ; video chuyển cảnh mềm (dissolve, fade dài) có thể
  cho ít scene frame hơn — mốc đều (`interval_seconds`) bù lại, không phải một cơ chế thích ứng theo nội
  dung.
- **Hai stage cùng output type `watch`** (`watch-source`/`watch-episode` trong `library-production@1.1.0`)
  dựa vào `depends_on` để một stage phía sau biết input `watch` nào là của mình — nếu sau này có một stage
  phụ thuộc cả hai, cần đặt tên `type` khác nhau cho từng nguồn thay vì dùng chung `watch`.
- **Review từ chối liên tiếp cùng một source**: plan lại (`autoAccept` mục 4 spec §5) giữ nguyên source đã
  chọn ở lần đầu — nếu bản thân source là nguyên nhân bị từ chối, phải tới khi chạm `max_replans` mới có
  người biết để đổi source. Chấp nhận có chủ đích (spec), giữ `max_replans` nhỏ (mặc định 2) để giới hạn số
  lần thử vô ích.

## Hoãn — ghi nhận ở re-review đợt sửa cuối sub-project 4 (2026-09-15)

Sáu quan sát ngoài phạm vi của re-review cuối; không mục nào chặn merge. Ruling của người điều phối ghi cạnh từng mục.

- `assertFfmpegSpawned` (`packages/core/src/media/watch.ts`) coi mọi lỗi spawn không kèm signal là `CONFIG_INVALID` →
  `contract` (không retry), kể cả `EAGAIN`/`EMFILE` khi máy cạn fd/process — vốn là lỗi tạm. Ruling: hoãn — lần
  sửa sau chỉ ném `CONFIG_INVALID` cho `ENOENT`/`EACCES`, còn lại ném `IO_ERROR` (→ `transient`).
- Alert `stage_waiting_human` bắn cho cả gate người của workflow 1.0.0 đang chờ bình thường, và khi quá hạn có thêm
  `gate_overdue` cùng `stage_run_id`. Ruling: chấp nhận — dashboard là mặt đồng hồ, gate đang chờ người đúng là
  việc cần thấy; nếu ồn thì lọc ở `hub.html` theo `executor.type`.
- `waitingHumanAlerts` quét toàn bộ run + stage + attempt mỗi lần ghi snapshot. Ruling: hoãn (quy mô hiện tại
  nhỏ); thêm chỉ mục/lọc theo state khi số run vượt vài nghìn.
- Đường mẫu hỗn hợp (một phần tải được, một phần chỉ có ảnh sẵn): `frames` của phần chỉ-ảnh trỏ ra ngoài artifact
  `output/watch` (`../../input/samples/…`) nên sau khi workspace đổi tên vào `artifacts/` có thể treo. Ruling:
  hoãn — chỉ xảy ra với wrapper không để lại video (fixture 2C); wrapper studio luôn để lại video.
- Guard "ContentItem chưa có run" của auto-accept chỉ áp dụng ở `replan_no === 0`; `library accept` tay lần hai sau
  một lần từ chối vẫn có cửa sổ plan đôi; request có ContentItem tay chưa plan bị bỏ qua `run-active` mãi mà không
  có event/alert. Ruling: hoãn — vận hành tự động không dùng `library accept` tay; ghi vào runbook §6 là "không
  trộn accept tay với autopilot trên cùng request".
- Test chặn câu "harness điền hộ" trong SKILL.md chỉ khớp hai cách viết tiếng Việt cố định; `skills/style-review`
  vẫn nói "không có quyền WebSearch/WebFetch" trong khi `allowedTools` là toàn cục (chỉ là quy ước prompt).
  Ruling: hoãn — ghi ADR 91 đã có; sửa chữ khi chạm skill lần tới.
