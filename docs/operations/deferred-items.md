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
