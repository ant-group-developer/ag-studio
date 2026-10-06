# Việc để lại (deferred items)

## AG Studio (cập nhật 2026-10-06)

Rút từ lúc rà soát để viết bù tài liệu (ADR-0001 mục 127–142). Mỗi dòng: hiện tượng · chỗ trong code · ghi chú.

### Lỗi đã biết

- **Xuất Premiere: tiếng gốc đã tắt vẫn có trong project.** `ag-render-worker/src/premiere-handler.ts` đặt cứng
  `sourceAudioMuted: false`, bỏ qua `source_audio.muted` của timeline. Sửa khi đưa xuất Premiere về chạy local
  (spec local-chat, pha 4).
- **Xuất Premiere: gain nhạc luôn 0 dB, mất fade.** Cùng file, `gainDb: 0`; `cues[].gain_db` và fade của
  composition bị bỏ qua. Sửa cùng lúc với mục trên.
- ✅ **Đã đóng 2026-10-06 — Không nhận ra mọi câu báo hết hạn mức Claude.** `isRateLimitMessage`
  (`packages/adapters/agent-cli/src/cli-agent-runtime.ts`) khớp cả nháy cong, "you have", "reached your … limit" và
  "usage limit reached".
- ✅ **Đã đóng 2026-10-06 — Spawn `claude` hỏng trên Windows khi chạy ngoài Docker.** `resolveCommand`
  (`packages/adapters/agent-cli/src/resolve-command.ts`) đi theo shim `claude.cmd` tới `claude.exe`.

### Baseline test trên máy dev Windows (2026-10-06)

- `pnpm -r typecheck` sạch. `vitest run`: 1330 pass, 168 skip (E2E cần `E2E=1`, test media cần ffmpeg trên PATH,
  test Claude thật cần `HARNESS_REAL_CLAUDE_TEST=1`), **1 fail chập chờn**:
  `apps/web/src/modules/production/episodes-table.spec.tsx` › "Video (mp4)" quá 5 s khi chạy cả bộ (máy tải nặng),
  chạy riêng thì pass (2,3 s). Nên tăng timeout riêng cho test này hoặc giảm việc render trong nó.
- `pnpm build` ở gốc repo gọi `pnpm -r run build`, hỏng khi `pnpm` không có trên PATH (chỉ có qua `corepack`).
  Dùng `corepack pnpm -r run build`.
- Ngoài repo: script `migration:run` của `ag-farm/apps/api` trỏ `./node_modules/typeorm/cli.js` nhưng typeorm
  được hoist ra `ag-farm/node_modules`; chạy tay `node --require ts-node/register ../../node_modules/typeorm/cli.js
  migration:run -d src/database/data-source.ts`.

### Nợ dọn dẹp

- `packages/ag-go-client` còn `getSegmentMedia`/`resolveSegments` gọi `/footage/segments/*`, route mà ag-go-api v2
  đã gỡ. Chỉ test của chính client dùng; web còn `useSegmentMedia` không ai import. Xoá được.
- `production-profiles/studio-production/profile.yaml` khai `workflow_release: ag-studio-production@1.0.0`, workflow
  đã bị xoá. Vô hại vì engine truyền workflow tường minh, nhưng gây hiểu nhầm.
- `.env` của máy dev còn `STUDIO_WORKFLOW` (do `E:ag-localsetupconfig-local.cjs flow …` ghi), không còn code nào đọc.
- Bảng `comments` (migration `0008`) chưa bao giờ được dùng; `timeline_revisions`, `studio_editor_jobs` là bảng cũ.
- `packages/studio-engine/src/voice.ts` và job farm `studio.tts` là phần sót từ luồng có lời dẫn; không workflow
  Studio nào dùng.
- Kiểu thumbnail `ai` có trong schema nhưng không có bộ sinh.
- Workflow harness cũ (`library-production*`, `channel-*`, `style-study*`, `footage-production`) còn trong
  `workflows/` nhưng không chạy được vì built-in đã bị gỡ (ADR mục 127). Giữ cho test byte-identical và cho kiểu
  "cắt theo shot" về sau; không dùng để chạy.
- `tests/e2e/production.e2e.test.ts` là `describe.skip` (luồng đã xoá) và còn mock `/footage/segments/resolve`.

### Sau pha 2 — giao diện chat (2026-10-06)

Plan: `docs/superpowers/plans/2026-10-06-ag-studio-phase-2-chat.md`. Cố ý chưa làm, hoặc lệch mockup:

- **Không có SSE**: luồng chat polling 2 s khi Claude đang trả lời, 5 s khi không; cột trái và chip header 5 s.
- **Chọn thumbnail ở bước YouTube kit** (mockup màn 10) chưa làm: thumbnail cắt từ `final.mp4`, chỉ có sau render.
  Gate kit chỉ sửa tiêu đề, mô tả, tag, ý tưởng thumbnail.
- **Màn 13 "Áp dụng đề xuất và chạy lại"**: Claude không sửa thẳng đầu ra REJECTED của stage hỏng (phải đổi core);
  thay bằng "Chạy lại" kèm góp ý trong chat (ADR mục 147).
- **Menu `⋯` chưa có "Làm lại bước này"** (resume từ một bước khi run đã xong) và "Huỷ": dùng màn cũ.
- **Màn cũ không có nút cho các gate mới** (`approve-trend-report` của plan 3.0.0, `approve-timeline`,
  `approve-youtube-kit` của tập 1.3.0): production tạo sau pha 2 phải duyệt trong giao diện chat (API gate cũ
  `POST /productions/:id/run/gates/approve-trend-report` vẫn có). `EpisodesPanel` cũ không coi `waiting_approval`
  là đang chạy (không polling).
- **Sửa tay** chỉ có cho R&D, branding, kế hoạch tập (editor sẵn có); báo cáo xu hướng và YouTube kit chỉ sửa qua chat.
- Lưu ở editor timeline **không** thêm dòng hệ thống vào chat (autosave lưu nhiều lần); cột phải vẫn hiện revision
  mới nhất.
- `queueAhead` của luồng chat đếm mọi câu trả lời đang chờ cũ hơn, kể cả của scope đang chạy — số gần đúng.
- **Prompt cache của chat chưa đo** với Claude thật: phần đầu prompt giống từng byte với stage, nhưng `--json-schema`
  khác nhau giữa stage và chat.
- Trang video lấy vai của người xem qua `GET /teams?pageSize=100`: người ở hơn 100 team có thể bị coi là không có vai.
- Render xem trước trên "máy này" và chọn máy cho bản cuối: pha 3.

### Rủi ro vận hành

- Build bắt buộc có checkout `../ag-farm` (`@ag-farm/*` là `link:`), kể cả khi không dùng farm.
- ✅ Đã đóng 2026-10-06 — Mỗi worker chỉ một lượt Claude cùng lúc: giờ là `STUDIO_CLAUDE_MAX_CONCURRENT` (mặc định 20) và pool vòng lặp (ADR mục 143).
- Render chỉ có đường farm: farm hoặc render worker dừng thì `render-final` chờ tới hết deadline 4 giờ.

---

## Việc để lại sau sub-project 1 (control plane tối thiểu)

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

## Sau sub-project 3B (ledger 2026-09-15/16)

Rút từ ledger SDD (`.superpowers/sdd/2026-09-15-sub-project-3b-channel-learning/progress.md` — thư mục
`.superpowers/` nằm trong `.gitignore`, **không commit**, nên ledger chỉ có trên máy đã chạy vòng SDD đó) và
spec §10 (`docs/superpowers/specs/2026-09-15-sub-project-3b-channel-learning-design.md`). Đọc code trước khi
tin lệch (`packages/core/src/learning/`, `packages/adapters/youtube-playwright/`, `packages/cli/src/commands/
{channel,publish-stage,worker,doctor}.ts`).

### Hổng vận hành còn thật (không chỉ ghi nhận, có tác động)

- **Request tạo tay không `--duration` vẫn dead-end ở studio** (SP4 gap, phát hiện lại ở Task 7 khi sửa lỗi
  tương tự cho request tự sinh): `harness library request create` không kèm `--duration` để
  `target_duration_seconds` trống; `library-production@1.1.0`'s `assemble` liệt `brief-duration` vào
  `required_checks`, checker đó `skip` khi brief không có target duration, và `skip` không phải `pass` — stage
  fail, request bị replan tới `max_replans` rồi kẹt `request_stuck` vĩnh viễn. 3B tự sửa cho **request nó tự
  sinh** (`create-requests` luôn gán `target_duration_seconds`, xem ADR mục 97 lân cận) nhưng đường người tạo
  tay vẫn hở — sửa ở `createRequest` (mặc định một khoảng rộng) hoặc bỏ `brief-duration` khỏi
  `required_checks` của `assemble`, chuyển xuống `duration-range` cấp profile.

### `packages/core/src/learning/metrics.ts` — thu số, `collectStats`, `importMetrics`

- `jobId` filter (CLI `--job`) áp dụng **sau** khi đã cắt `batch` — một job cụ thể có thể bị batch slice loại
  trước khi filter kịp thấy nó.
- Một job đến hạn ở hai mốc `recollect_hours` cùng lúc bị thu **hai lần** trong một sweep (hình dạng
  "per-target" do brief quy định) — không sai dữ liệu (mỗi lần vẫn một `metric_id` riêng, append-only) nhưng
  tốn một lượt gọi `StatsCollector` thừa.
- Kiểm `void` (giả thuyết dưới sàn) nên coi `duration <= 0` giống `null` (hiện chỉ `null` mới kích hoạt);
  `ctr_pct: null` với `impressions` đủ sàn hiện thành `refuted` với giá trị 0 thay vì `void`.
- `toPublisherChannel` tính lại cho từng job thay vì một lần mỗi kênh; các hàm cập nhật receipt không luôn bump
  `updated_at`; `importMetrics` gặp tuổi âm (`age < 0`) ném lỗi giữa chừng một lượt nhập (dòng trước đã nhập
  vẫn giữ, nhưng lượt nhập dừng ở đó thay vì bỏ qua dòng và tiếp tục); `importMetrics` chấp nhận `views: NaN`
  (không kiểm `Number.isFinite`).
- Nhánh `blocked` của `collectStats` đặt `break` (dừng hẳn kênh đó cho lượt sweep này) **bên trong** khối
  `try`/`catch` bọc quanh `appendEvent` — nếu chính `appendEvent` ném lỗi (ví dụ store lỗi tạm thời), `break`
  không chạy tới và kênh đó bị coi như còn tiếp tục thu bình thường thay vì dừng đúng ý; chưa có test riêng
  cho tổ hợp hiếm này.
- `harness channel collect --channel <id không tồn tại>` là no-op im lặng, thoát mã 0 — không báo lỗi rõ
  "kênh không có trong `channels/`".
- `statsFailingAlerts` (dashboard) quét job **toàn project**, không lọc theo `d.channels` đang nạp được — một
  kênh lỗi cấu hình (không load được) vẫn có thể góp alert `stats_failing` vào snapshot.
- Không có chỉ mục cho `json_extract(..., '$.channel_id')` (video_metrics/channel_learned) — quét tuyến tính
  khi số hàng lớn.

### `packages/core/src/learning/learned.ts`/`hypotheses.ts` — chuẩn kênh, giả thuyết

- `ChannelLearnedSchema.history` (`.max(20)`) chưa có test riêng cho việc từ chối một mảng vượt 20 phần tử;
  vài trường hợp biên của `Demand` (0 slot, `needed` âm giả định) cũng chưa có test riêng.
- Vài nhánh của `CollectReport` (`report.evaluated`/`report.learned` khi rỗng), việc thu hẹp kiểu
  `channelId`/`jobId` trong `collectStats`, và nhánh fallback tuổi (`age`) khi `importMetrics` thiếu
  `collectedAt` chưa có test riêng — hành vi đúng, chỉ thiếu assertion trực tiếp.

### `packages/adapters/youtube-playwright/` — thu số thật

- Test giả lập lỗi ENOENT override cả script lẫn `node` thay vì chỉ chương trình con, nên nhánh
  `result.error` thật của `spawnSync` (binary có mặt nhưng gọi lỗi) chưa được phủ riêng.
- `HARNESS_FAKE_STATS_FILE`/`FakeStatsCollector`'s file hook ép JSON đọc được về kiểu `StatsOutcome` bằng cast
  (`as`), không validate hình dạng — một file test viết sai field vẫn "chạy được" tới khi giá trị sai lộ ra ở
  chỗ khác.
- Lý do (`reason`) của `blocked`/`error` (exit 2/3) là **đuôi thô của stdout**, không phải một trường JSON đã
  parse riêng — giống hệt cách `Publisher.lookup`'s `error: true` báo lý do (tiền lệ đã chấp nhận ở SP3, xem
  "Sau sub-project 3").
- Tab Engagement (`avg_view_sec`) vẫn `goto` thẳng URL thay vì bấm từ tab hiện tại (khác tab Reach — bấm, xem
  comment đầu `collect-stats.mjs`); cơ chế reload-rồi-bấm-lại của tab Reach có thể là no-op nếu cú bấm đầu đã
  `pushState` sang đúng tab đó trước khi timeout — cần một lượt smoke-test tay trên Studio thật (DoD #4,
  `docs/runbooks/channel-learning.md` mục 9) để xác nhận, chưa kiểm được trong môi trường build agent.

### `packages/core/src/learning/planning.ts`/`auto-pick.ts` — kế hoạch, tự pick

- `channelDemand` gọi `listRuns`/`listContentItems` bên trong vòng lặp lọc theo từng item thay vì tính một lần
  ngoài vòng lặp; `autoPick` tính `demand` (gọi `channelDemand`) ngay cả khi không có ứng viên nào cần tới nó;
  kiểm "item có run `FAILED`/`WAITING_HUMAN`" chỉ nhìn **run mới nhất**, không toàn bộ lịch sử run của cặp
  item+kênh.
- `channel-brief` (stage built-in) gọi `listVideoMetrics` hai lần cho cùng một job; một chỗ ép kiểu `status`
  không qua kiểm tra hình dạng; checker `topics-valid` đọc lại `channel-brief.json` riêng cho mỗi output thay
  vì một lần.
- `TopicProposal` không tự kiểm trùng **trong chính nó** (hai chủ đề agent đề xuất cùng lượt giống nhau) —
  chỉ kiểm trùng với `open_requests`/20 gói gần nhất; thứ tự ưu tiên bỏ qua ứng viên (`skip` vì trùng/thiếu
  style) và cách phá ngang điểm hoà (`sort` khi lift bằng nhau) chưa test riêng từng trường hợp biên.
- `requests-receipt.json` chỉ liệt request của **lượt gọi hiện tại**, không phải toàn bộ request từng tạo bởi
  run (idempotent rerun vẫn đúng, chỉ receipt không phải nhật ký đầy đủ); `run_id` xuất hiện dư thừa trong
  payload một event (chấp nhận, không sai).
- Ba hàm `parseTopicProposal`/`parseDemand`/`parseChannelBrief` gần giống hệt nhau — chưa rút thành helper
  chung; `normalizeTopic` được cài lặp lại ba nơi.
- `publish-stage.ts` giờ còn ôm cả các stage planning (`channel-brief`, `demand`, `create-requests`) bên cạnh
  bốn stage publish gốc — file dài hơn, mô tả lệnh CLI nội bộ cũ chưa cập nhật theo.
- `sdk.input(...)` thiếu file input báo `transient` thay vì `contract` rõ ràng hơn (hành vi có từ trước 3B,
  không phải hồi quy mới, ghi nhận lại vì planning stage mới lộ ra đường này nhiều hơn).
- CLI `channel learned` lặp lại câu "chưa đủ mẫu" ở hai nhánh code (có ảnh và không có `channel_learned` nào)
  thay vì dùng chung một hằng chuỗi.
- Nhánh sweep ném lỗi bất ngờ (khác `channel.planning_failed`/`channel.auto_pick_failed` đã xử lý có chủ đích)
  chỉ log, không có event riêng để dashboard/alert nhìn thấy.
- `fallbackChannel`/`newestChannelEvent` (dashboard) trả `last_collect_at: null` khi chính `buildChannel` của
  kênh đó ném lỗi (kênh lỗi cấu hình) — có thể giữ alert `stats_blocked` treo trên một kênh không thực sự
  đang bị chặn thu, chỉ đang lỗi nạp cấu hình.
- `skippedAlreadyEmittedToday` (`planning.ts`) dùng chung cửa sổ 1000-event mới nhất **toàn project** để dedupe
  (giống caveat `newestChannelEvent` đã ghi ở "Sau sub-project 4") — một project nhiều kênh/sự kiện dày có thể
  làm event `channel.planning_skipped` của một kênh bị "trôi" khỏi cửa sổ trước khi kịp dedupe đúng ngày.

### Vệ sinh test

- `tests/cli` cho lệnh `channel learned`/`demand`/... phụ thuộc thứ tự chạy trong cùng file (không cô lập
  hoàn toàn); hai assertion còn yếu — test worker "không kênh nào" và test `plan-requests` chỉ kiểm
  `started`/`open-cap` mà chưa phân biệt rạch ròi từng nhánh `skipped`.
- Acceptance 33 (`stats_blocked` không chặn phát) chạy nhánh publish trên `channel-publish@1.0.0`, không phải
  `@1.1.0` — không sai (mục đích của test không phải kiểm `channel-brief`), chỉ ghi nhận để người đọc test
  không hiểu nhầm cả hai workflow đều được acceptance này phủ.
- Tiêu đề mô tả trong `tests/integration/channel-learning.test.ts` nói "không lệnh người nào" hơi phóng đại:
  `library sync` (poll) và một item thứ tư viết tay (`writeLibraryItem`, không qua planning thật vì planning
  giới hạn một run/ngày) vẫn là can thiệp trực tiếp vào state, dù không phải lệnh CLI theo nghĩa "người vận
  hành gõ tay".
- `pickAndPlan` (helper test) nhận `itemId` rỗng ở một nhánh mà không có guard rõ ràng.
- Khối `learning` mức project (`project.yaml`) trong fixture `ops-project-channel` **không** bị
  `freshPublishWorld` tước bỏ cho các thế giới không yêu cầu `learning: true` (chỉ ba khối mức kênh
  `learning`/`planning`/`auto_pick` trong `channel.yaml` mới bị tước) — mọi test dựng trên fixture này thừa
  hưởng sweep thu số khi rảnh (vô hại vì `adapters.stats: fake` và không có job `PUBLISHED` nào để thu, nhưng
  không đối xứng với cách tước ở cấp kênh).
- Hai file YAML workflow mới (`channel-planning@1.0.0`, và bản sửa của `channel-publish@1.1.0`) dùng line
  ending LF trong khi các file `workflow.yaml` khác của repo là CRLF — chỉ gây nhiễu diff, không phải lỗi nội
  dung.

### Rủi ro vận hành (spec §10, chưa có gì để sửa trong code)

- **Chuẩn kênh học từ mẫu nhỏ** (`min_samples` mặc định 2): dễ nhiễu ở kênh mới; ngưỡng đổi 10% và `history`
  (tối đa 20 dòng) để người soi lại quyết định nào đã đổi chuẩn và vì sao (ADR mục 96) — sub-project sau có
  thể nâng ngưỡng theo số tập đã publish.
- **Studio Analytics đổi DOM** làm thu số dừng âm thầm: alert `stats_failing` sau 3 lỗi liên tiếp một video;
  runbook (`docs/runbooks/channel-learning.md` mục 6) chỉ đúng ba khối cần sửa trong `collect-stats.mjs`
  (nhãn Views/Overview, Thumbnail impressions+CTR/Reach, Average view duration/Engagement) — không có cách
  phát hiện chủ động ngoài đếm lỗi liên tiếp.
- **Agent đề xuất chủ đề trùng lặp theo thời gian**, ngoài phạm vi kiểm trùng hiện tại (`open_requests` +
  20 gói gần nhất của kênh): chấp nhận có chủ đích (spec) — một sub-project sau có thể thêm bộ nhớ chủ đề dài
  hạn hơn.
- **`channelDemand` tính theo item `approved` chưa claim** có thể trùng với một kênh khác cũng đang định pick
  cùng item chung (item không `request_id`): chấp nhận có chủ đích — hai kênh cùng pick một item chung là hợp
  lệ theo thiết kế kho (SP2C/SP3), `needed` chỉ là ước lượng nhu cầu, không phải khoá giữ chỗ.
- **`hypothesis.evaluated` ghi vào `channel_package`** làm một gói "committed" thay đổi nội dung sau khi đã
  publish: chỉ đúng trường `hypothesis` (ADR mục 94) thay đổi, `manifest`/checksum của gói không đụng tới —
  chấp nhận có chủ đích, đây chính là cơ chế duy nhất giả thuyết được đánh giá.

## Hoãn — ghi nhận ở re-review đợt sửa cuối sub-project 3B (2026-09-16)

Ba quan sát mức thấp còn lại sau đợt sửa `b13029e` (cửa sổ horizon, trung vị theo horizon kênh, `void` khi
metric null, ranh giới adapter). Không cái nào chặn merge; ghi để sub-project sau cân nhắc.

- **Giả thuyết có `expected.horizon_hours` khác `learning.horizon_hours` của kênh sẽ `open` mãi, không báo**
  (`packages/core/src/learning/hypotheses.ts`, `collectDue` chỉ thu tại mốc của kênh nên không bao giờ có ảnh
  chụp lọt cửa sổ `[h−12, h+24]` của giả thuyết). Không có gì kiểm hai số này khớp nhau — skill
  `channel-package` chỉ nói "72 trừ khi brief nói khác". Việc sau: doctor/checker `package-valid` cảnh báo khi
  hai số lệch, hoặc kẹp `expected.horizon_hours` về horizon kênh lúc commit gói.
- **Ngân sách thu số 300 s/video × `collect_batch` 5 (spawnSync tuần tự) → worker kênh có thể đứng ~25 phút**
  trong tình huống xấu nhất, vượt `collect_seconds` mặc định 1800 s (`packages/core/src/learning/metrics.ts`).
  Đổi đúng hướng (timeout thật thay vì `stats_failing` giả) nhưng runbook nên có một dòng về cadence; việc sau:
  thu số bất đồng bộ hoặc giảm `collect_batch` mặc định.
- **`void` vẫn lưu `metric_value: 0` vào `channel_package.hypothesis.evaluated` và event `hypothesis.evaluated`**
  vì `HypothesisSchema.evaluated.metric_value` là `z.number()` bắt buộc; `channel hypotheses` và
  `channel-brief.json` in `metric_value: 0` cạnh `status: "void"`. Phép học không bị ảnh hưởng
  (`learnChannelStandard` chỉ đọc supported|refuted). Việc sau: nới schema thành `nullable()` + `gen:schemas`.
- Ngoài phạm vi: `waitForLabels` trong `collect-stats.mjs` kiểm deadline trước `waitForTimeout(1000)` và
  `page.evaluate` không chịu `setDefaultTimeout`, nên mỗi lần chờ có thể quá `LABEL_WAIT_MS` ~1 s; 275 s trong
  header là sàn, không phải trần cứng (còn 25 s dư so với 300 s).

## Sau sub-project 5A (xưởng dựng có engine media thật, 2026-09-21)

Gom từ sổ SDD của kế hoạch 5A (mọi dòng `minor (deferred)` và `NOTE` của Task 1–11) cộng phần rủi ro còn lại
của spec §10. Không dòng nào chặn merge; `library-production@1.2.0` đã chạy thật đủ 15 stage, ba chế độ
giọng, trên GPU của máy build (`docs/runbooks/studio-media.md` mục 7 và 9).

### `engines/python/` — hai script engine

- `transcribe.py` giữ **toàn bộ mảng audio của mọi clip trong bộ nhớ** xuyên suốt cả hai pha (nghe rồi căn
  chỉnh) để pha 2 không phải đọc lại file — khoảng 1–2 GB RAM cho 40 clip. Việc sau: đọc lại từ đĩa ở pha 2,
  hoặc xử lý theo lô.
- `spawn()` trong `run()` **không bọc try**: nếu chính lời gọi ném (khác với sự kiện `error`), file job vừa
  ghi bị bỏ lại trong workspace.
- Ghi nguyên tử của Python (`write_result`) để lại file `.tmp` nếu tiến trình bị SIGKILL (timeout) đúng giữa
  chừng; không test nào kiểm file job/result tạm đã được xoá.
- Comment mô tả env của tiến trình con bỏ sót `PATHEXT` (Windows cần nó để phân giải một lệnh không có đuôi).
- `FakeMediaEngine` gặp file audio không đọc được thì trả **0 segment một cách im lặng**, không phân biệt với
  "clip này thật sự không có tiếng".
- Danh sách allow-list trong `allow_vad_checkpoint_globals()` (sửa ở Task 11) **gắn với phiên bản**: nâng
  whisperx/pyannote lên bản đổi tên hay dời các lớp đó thì hàm lặng lẽ góp ít mục hơn và `load_model` fail
  lại với đúng thông điệp cũ. Không có test nào bắt được điều đó mà không cần GPU + trọng số thật; dấu hiệu
  là dòng log `allow-listed VAD checkpoint globals for torch.load` ngắn đi.
- **Lỗi unpickle VAD bị xếp `transient`, đáng lẽ là `contract`** (Task 11): `whisperx.load_model` hỏng vì
  `UnpicklingError` được `transcribe.py` báo về là `failed to load whisperx model: …` kind `transient`, nên
  stage retry đủ số lần rồi mới bỏ cuộc — trong khi đây là lỗi cài đặt, retry không bao giờ cứu được. Việc
  sau: nhận diện `UnpicklingError`/`Unsupported global` và trả `contract`.
- **`requirements.txt` không ghim `pyannote.audio`/`transformers`** (Task 11): hai gói này vào venv gián tiếp
  qua `whisperx`, và chính chúng quyết định danh sách allow-list ở trên có còn đúng tên lớp hay không. Một
  `pip install -U` vô tình có thể làm gãy `load_model` mà `requirements.txt` không nói gì. Việc sau: ghim
  cận trên cho cả hai.

### `packages/core/src/media/` — bóc cảnh, nghe nguồn, đọc lời, khớp hình

- `shotId` > 999 phá regex `shot_id` (đã thêm guard, nhưng trần vẫn là 999 shot mỗi source).
- Lỗi encode bản proxy bị **log rồi nuốt**, không để lại dấu nào trong `shots.json` — downstream không phân
  biệt được "không có proxy" với "proxy hỏng".
- Không có test cho nhánh ffmpeg trích audio thất bại trong `transcribeSources`.
- Timeout của transcribe chỉ cộng thời lượng của những clip **có audio**, nên một buổi quay lẫn nhiều clip
  câm được cấp deadline ngắn hơn tổng thời lượng thật.
- `edl-valid` **bỏ qua** phần narration khi stage không có output `edl`.
- File `.tmp-*` mồ côi trong `cache/tts` không bao giờ được quét dọn, và lỗi ghi cache là `Error` trần.
- Tách câu: vẫn **thiếu tách** sau một dấu ngoặc kép đóng.
- `tts-valid` spawn **một ffmpeg cho mỗi dòng** lời.
- ffmpeg **có mặt nhưng hỏng** làm `tts-valid` báo đỉnh âm lượng là `unknown` một cách im lặng (quyết định có
  chủ đích: không fail vì thiếu công cụ).
- Nhánh kẹp `loudnorm` bị trôi và nhánh cache JSON hỏng chưa có test.
- `fitEdl`: cặp `expandOnly` có thể để điểm thua nằm **giữa một từ** mà không cảnh báo; `refine`
  không ép bất biến `missing = reused + uncovered`; entry không nằm trong shot nào bị dán nhãn `kept` dù đã
  phải nối thêm hình, và phần đuôi rảnh của shot chứa điểm giữa nó thì không dùng tới; một shot bị đánh dấu
  "đã dùng" theo khoảng **gốc chưa cắt**, nên phần đuôi đã cắt bỏ không tái sử dụng được; `report.entries[]`
  lặp `order` cho các dòng bị loại; `markUsed` đánh dấu cả shot chứa điểm giữa dù chỉ chồng ≤ 0.2 s; pha quét
  narration mồ côi bị cổng theo `voice: tts` (thừa); tên test `fit-edl.test.ts:524` gây hiểu nhầm; còn thiếu
  test cho rule 4 nhiều lựa chọn, entry trải hai shot, và câu nói không có dòng transcript tương ứng.

### `packages/core/src/library/` — giọng đọc, tự nhận request

- `library sync --verify` **không** băm lại `ref.wav` của hồ sơ giọng (chỉ item mới băm lại).
- Không test nào kiểm việc lan truyền trạng thái `retired` sang studio khi sync, cũng không kiểm `--ref-text`
  đọc từ file.
- `sha256FileSync` trả `size_bytes` mà không ai dùng.
- Chạy lại `create-requests` **không** tính lại trạng thái hạ giọng (`downgraded_voice`) cho một request đã
  tồn tại — kênh vừa thêm giọng vẫn thấy request cũ ở `voice: none`.
- `d.config.source_collections` là mã chết bên trong `core` (chế độ đã được quyết ở `AutoAcceptDeps.sources`).
- Mỗi lượt quét auto-accept vẫn duyệt `listRuns` lần thứ hai và hỏi từng source một.
- Tên collection **không được kiểm ở CLI** — regex của schema bắt nó muộn, sau khi đã ingest.
- Worker nuốt im lặng một `TypeError` từ auto-accept (có từ trước 5A).

### `packages/cli/` — stage, doctor, dashboard

- `default_deadline_seconds: 14400` của profile `studio` revision 3 áp cho **mọi** stage, kể cả stage agent —
  một agent treo giờ mất 4 tiếng mới chạm deadline thay vì 1 tiếng như trước.
- Brief inline của `survey-source`/`plan-edit` bị **viết đè** thay vì nối thêm khi profile ghi đè.
- Test verifier độc lập của `survey-source` **hard-code** `required_checks` thay vì đọc từ workflow.
- `pinnedWorkflowLoadable` lặp lại non-null assertion; `mediaEngineOptions()` bị tính lại trong
  `computeDoctorRows`.
- **Phép dò engine media bị bỏ qua khi đang giữ lease GPU có thể che một engine hỏng vô thời hạn** trên một
  GPU bận liên tục — không có chỉ báo "đã bỏ qua lần dò" nào cho người vận hành thấy.
- Không có khử trùng lặp cho các lần dò song song đang bay; `_resetMediaProbeCacheForTests` chưa nằm trong
  setup test toàn cục; tỉ lệ `cache_hit_ratio` của dashboard đọc trần 200 event.
- `library-export` trong 1.2.0 **không còn** artifact `captions` nào để xuất (`hasInput("captions")` luôn
  false), nên mọi item 1.2.0 ra kho **không có phụ đề** cho tới sub-project 5B.
- Workspace của `assemble` giờ vật liệu hoá cả `proxy_set` (hardlink, rơi về copy) — một syscall mỗi file,
  đáng lưu ý với buổi quay lớn.
- **Một run `library-production` FAILED bỏ request của nó ở `claimed`** — có hệ thống, không chỉ riêng hai
  Critical đã sửa ở review cuối 5A (`brief-duration`, `intake` claim trước khi kiểm giọng). Hôm nay chỉ có
  alert `run_failed` của dashboard; không có đường nào tự mở lại request, nên mọi lỗi máy ở giữa ống dẫn đều
  cần người vào gỡ. **Quy tắc ứng viên cho một sub-project sau:** quyết định cho **từng checker** điều kiện
  nào là *máy hỏng* (fail stage) và điều kiện nào là *dựng không đạt* (reject + replan), rồi đặt một lưới an
  toàn chung — ví dụ `library-apply-review` hoặc một stage dọn dẹp luôn chạy khi run kết thúc FAILED, ghi
  `rejected` và mở lại request.
- `media.ts` dài hơn 550 dòng và trộn `media watch` với bốn stage `media index|transcribe|tts|fit-edl`; nên
  tách phần stage ra `media-stages.ts`. `publish-stage.ts` đã có cảnh báo tương tự từ 3B.
- `tts-valid` **hard-fail** `media-tts` trên một máy không có `ffprobe`, khác với bốn checker media dựa trên
  prober (chúng `skip` với `reason: "no media prober available"`). Không sai về mặt vận hành (thiếu ffprobe
  vốn đã chặn ống dẫn) nhưng lệch quy ước.
- Profile `studio` còn quảng cáo tuỳ chọn `subtitles` trong `options_schema` mà **không stage nào đọc** —
  1.2.0 không sinh `captions` (xem dòng trên). Bỏ đi hoặc nối vào 5B.
- Skill `library-review` nhắc `thumbnail_set` nhưng stage `library-review` **không** `depends_on`
  `thumbnail-candidates`, nên input đó không bao giờ có mặt và mục kiểm `thumbnails_textless` chấm mò. Có
  sẵn từ 1.1.0, không phải hồi quy của 5A.
- `library-review` nhận **hai** input `edl` (pre-fit từ `plan-edit`, đã khớp từ `media-fit-edl`). Đúng ý đồ,
  và skill + brief của workflow nay đã nói rõ đọc bản nào; nhưng hợp đồng vẫn dựa vào chữ nghĩa chứ không
  phải vào kiểu artifact. Việc sau: đặt một type riêng cho bản đã khớp (ví dụ `fitted_edl`).

### Vệ sinh test

- Phần lớn test hợp đồng mới của Task 1 **không được quan sát fail trước** (test và cài đặt viết cùng một
  lượt).
- Test cache TTS chứng minh "được tất cả hoặc không được gì", **không** chứng minh tái dùng **từng dòng** khi
  chỉ một dòng đổi — đúng cái mà vòng replan cần nhất. (Lần chạy thật ở Task 11 cũng chỉ chứng minh mức tất
  cả: hai dòng đều `cached: true`.)
- Chỉ có **một** ngôn ngữ nguồn trong bộ test tự động; đường `vi` chỉ được kiểm bằng tay ở Task 11.
- `studio-media` "channel can pick" chỉ kiểm exit code.
- `artifactPathFor` trả `undefined` rồi bị non-null assertion ở chỗ gọi.
- `ffprobeHasAudio` gộp "probe lỗi" với "không có audio".
- `writeProjectYaml` đặt `adapters.media: fake` cho cả thế giới ghim 1.1.0 (vô hại, không đối xứng).
- Tham số `language` của `ingestShoot` không dùng tới.
- Acceptance 43 ("ít nhất một điểm cắt được hít") phụ thuộc con số 2.51 s do ffmpeg sinh ra.
- Hai khối `describe` của 1.0.0/1.1.0 giờ khẳng định các sự kiện của profile revision 3.

### Rủi ro vận hành còn lại (spec §10)

- **Cache TTS lớn dần.** `harness artifacts sweep` **chưa** biết tới `<data_root>/cache/tts`; không có dọn
  theo tuổi. Với giọng và lời ổn định thì thư mục này chỉ có lớn lên. Việc sau: đưa nó vào `artifacts sweep`
  với ngưỡng tuổi riêng.
- **Dò cảnh bằng ngưỡng cố định** (`media.scene.threshold`, mặc định 0.30) dễ sai với cảnh quay tay rung hay
  ánh sáng đổi; `max_shot_seconds` chỉ chặn hậu quả. Dò cảnh tốt hơn là việc sau.
- **Nhân giọng: harness không xác minh được `origin`.** Trường này chỉ ghi lại lời khai; trách nhiệm hoàn
  toàn thuộc người tạo hồ sơ (ADR mục 105). Không có việc kỹ thuật nào để làm ở đây, chỉ có quy tắc.
- **`reused`/`shortfalls` lặp vô hạn** đã bị `max_replans` của SP4 chặn; hết lượt thì `request_stuck` như cũ.
- **Thời gian chạy trên buổi quay lớn chưa đo.** Số đo của Task 11 lấy từ ba clip mỗi buổi; với 40 clip,
  phần nạp mô hình (~12 s OmniVoice, ~4 s whisper) không tăng nhưng phần nghe thì có, và `lease_seconds` của
  profile phải ≥ timeout của stage dài nhất.
- **Engine media chưa chạy trên máy studio thật.** Task 11 chạy trên máy build; venv, mô hình và driver CUDA
  của máy đích là việc của `docs/runbooks/go-live.md` bước 3b.

### Ngoài phạm vi 5A, ghi lại để khỏi quên (spec §9)

- **Phụ đề**: 1.2.0 không sinh artifact `captions` nào, nên item ra kho không có phụ đề — sub-project 5B.
  Cùng đó: chữ trên hình, nhạc + ducking, chuyển cảnh, tỉ lệ khung. `timeline.json` đã là hợp đồng sẵn cho
  chúng (ADR mục 107).
- **Lệnh sinh clip mẫu bằng voice design** chưa được bọc vào CLI — hiện phải gọi `OmniVoice.generate(...,
  instruct=...)` bằng tay theo `studio-media.md` mục 4, dù đó chính là cách duy nhất để `origin: synthetic`
  đúng sự thật mà không cần giọng người nào.
- **Dịch transcript giữa hai ngôn ngữ** (nguồn nói tiếng này, kênh phát tiếng kia): chưa có.
- **`style-study` vẫn dùng hook `transcribe` của `executors/scripts.yaml`**, không dùng engine transcribe
  thật — hai đường nghe khác nhau trong cùng một repo.
- **Tách người nói (diarization)** và **engine đám mây**: chưa có, không định có sớm.

### Tên profile `cartoon`/`avatar` còn sót

`profile_id` vẫn là enum có `cartoon` và `avatar` (`packages/contracts/src/config.ts`, `entities.ts`), và
`production-profiles/cartoon` vẫn là profile mẫu mà `README.md` quick-start đầu tiên dùng
(`plan --profile cartoon`) — di sản của ADR mục 7, đặt tên profile theo phong cách sản xuất. Profile đó ghim
`workflow_release: sample-three-stage@1.0.0`, tức workflow **demo** của sub-project 1, không phải một đường
ống hoạt hình; `avatar` chỉ có trong enum, không có thư mục profile nào. **Harness này không dành cho nội
dung hoạt hình** — phạm vi là sản xuất từ footage nguồn có thật (spec 5A §0, **ADR-0001 mục 116**) — nên hai
tên đó giờ chỉ gây hiểu nhầm cho người đọc mới. Đổi tên là một refactor cơ học (enum + thư mục profile +
fixture + vài test đếm) chứ không phải đổi hành vi, và **chưa được yêu cầu** — để lại nguyên trạng cho tới
khi chủ máy muốn.

## Hoãn — ghi nhận ở re-review đợt sửa cuối sub-project 5A (2026-09-22)

Các quan sát mức thấp còn lại sau đợt sửa `cdd7ddd..d13bb98` (brief-duration nhường cho library-review, intake
kiểm giọng trước khi claim, khoá cache TTS theo revision giọng, replan quay lại buổi quay của chính nó, lỗi
proxy được ghi nhận, retry rename, assemble đệm audio từng clip). Không cái nào chặn merge.

- **`assemble.mjs` đệm im lặng cố định `anullsrc=r=44100:cl=stereo`** trong khi clip có tiếng được giữ nguyên:
  buổi quay 48 kHz hoặc mono sẽ cho concat demuxer các đoạn khác tham số audio (lấy theo đoạn đầu). Fixture
  test đều 44,1 kHz nên suite không thấy. Việc sau: dò clip có tiếng đầu tiên rồi khớp rate/layout.
- **Cùng file: `-shortest` với `anullsrc` vô hạn + `-c:v copy`** được ffmpeg ghi nhận là không ổn định trên một
  số bản build; nếu không cắt được thì tiến trình không dừng và stage đốt hết `default_deadline_seconds: 14400`.
  Việc sau: thêm `-t <thời lượng clip>`. Clip có codec hình không `-c:v copy` được vào mp4 cũng làm `assemble`
  ném lỗi mới.
- **Guard "không proxy nào dựng được" của `media index`** (`packages/core/src/media/index.ts`) là một đường
  `CONFIG_INVALID` → `contract` → run FAILED → request kẹt `claimed` mới, cùng lớp với C1/C2. Chấp nhận có chủ
  đích (máy không có libx264 là hỏng máy thật), tính vào mục hệ thống "run FAILED để request ở `claimed`" ở trên.
- **`ArtifactRegistry.stageOutputs` dừng giữa chừng khi khoá file kéo dài**: một số output đã được chuyển khỏi
  workspace, để lại thư mục artifact PROVISIONAL không bao giờ commit và workspace thiếu file trước khi
  `harness retry` chạy lại. Hành vi có sẵn của nhánh `CHECKSUM_MISMATCH`; đợt sửa chỉ làm đường này dễ tới hơn.
- **`brief-duration` tin vào sự có mặt của fit report, không đối chiếu với file đã probe.** Skill
  `library-review` thật tự tính lại `duration_in_range` từ `watch.json` nên vẫn bắt được; agent giả thì không
  (chỉ đọc fit report). Cần nhớ khi mở rộng agent giả.
- **Vòng replan theo thời lượng chưa có bằng chứng hội tụ end-to-end**: `plan-edit` giả bỏ qua
  `target_duration_seconds` ở 1.2.0, nên test chỉ khẳng định trạng thái cuối đã thiết kế (`request_stuck`,
  request `open`, không run FAILED). Vòng replan theo thiếu hình thì đã có (acceptance 42).
- JSDoc đầu file `packages/adapters/media-python/src/child-env.ts` vẫn thiếu `PATHEXT` trong phần mô tả, dù
  `FIXED_ALLOWLIST` có.

## Sau sub-project 5B (dựng hình 4K: chữ, phụ đề, nhạc, chuyển cảnh — 2026-09-23)

Gom từ sổ SDD của kế hoạch 5B (mọi dòng `minor (deferred)`, `finding`, `ruling` và `NOTE` của Task 1–10),
phần rủi ro để ngỏ của spec §11, và những gì **lần chạy thật 4K ở Task 11** lộ ra
(`docs/runbooks/studio-composition.md`). Không dòng nào chặn merge: `library-production@1.3.0` đã chạy thật
bốn tập đủ 15 stage trên máy build.

### Hai mục đầu bảng (có tác động thật, nên làm trước)

- **Run FAILED ở một stage agent để request kẹt vĩnh viễn ở `claimed`.** `overlays-valid` fail ở `plan-edit`
  là lỗi `result` → stage `FAILED` → run FAILED. `intake` là chỗ **duy nhất** đưa request `open → claimed`,
  `library-apply-review` là chỗ **duy nhất** đưa nó ngược lại, và một run chết ở `plan-edit` không bao giờ
  tới được `library-apply-review` — nên request nằm ở `claimed` mãi mãi, `autoAccept` (chỉ quét request
  `open`) không bao giờ thấy nó nữa, và **alert `request_stuck` cũng không nổ** (alert đó cũng chỉ nhìn
  request `open`). Không có gì báo cho người vận hành. Đây là **hổng hệ thống của sub-project 4**, không phải
  do 5B: `edl-valid` của 5A rơi vào đúng đường đó, và guard "không dựng được proxy nào" của `media index`
  cũng vậy (mục "Sau sub-project 5A"). `tests/acceptance/48-overlays-too-dense-rejected-then-replanned.test.ts`
  **ghim nguyên trạng thái bế tắc này ở test (a)**; test (b) đi vòng qua đường duyệt (`text_dropped` →
  `library-review` từ chối → replan), là đường **duy nhất** hiện chạy được cho một lỗi chữ.
  **Đề xuất:** ở sub-project sau, cho SP4 **mở lại request kèm ghi chú khi một run kết thúc FAILED**
  (`request → open`, `request_notes` mang `stage_key` + `error_summary` + danh sách check fail), trong hạn
  `max_replans` y như đường từ chối — rồi `request.auto_accept_exhausted`/`request_stuck` mới có việc để làm.
  Sửa ở một chỗ (`library-apply-review`, hoặc một sweep "reopen failed runs" của worker studio) là đủ cho
  **cả ba** đường (`edl-valid`, `overlays-valid`, `media index`).
- **Loudness: dây chuyền tiếng không lên nổi −14 LUFS khi hệ số đỉnh của bản trộn > 13 dB.** Phát hiện ở lần
  chạy thật; số đo và cách chẩn đoán ở `studio-composition.md` mục 6. Lượt 2 xin `linear=true`, nhưng ffmpeg
  **âm thầm** lùi về `dynamic` khi `measured_TP + (−14 − measured_I) > −1`, tức khi `TP − I > 13 dB`; bộ giới
  hạn của chế độ dynamic khoá đỉnh ở đúng −1 dBTP và bỏ chương trình lại **dưới** −14. Đo được: một bản trộn
  ở **−19.35 LUFS / −1.43 dBTP** (hệ số đỉnh 17.9 dB) ra **−16.13 LUFS** → ngoài dải `render-valid`
  `[−16, −12]` → stage FAILED → **run FAILED, không replan** (mục trên). Giọng OmniVoice đọc **câu thật** có
  hệ số đỉnh ~12–14 dB nên lọt (−13.85…−14.19 LUFS ở cả bốn tập), nhưng chỉ vừa đủ. Task 11 đã thêm cảnh báo
  `loudnorm_not_linear` vào `render-report.warnings` để lần sau còn biết vì sao; **chưa** sửa dây chuyền.
  **Đề xuất (quyết định thiết kế, cố ý không tự làm ở 5B):** chèn một `alimiter`/`acompressor` nhẹ vào lớp
  lời **trước** `amix` để kéo hệ số đỉnh xuống dưới 13 dB; hoặc nới dải chấp nhận của `render-valid`; hoặc
  đổi thất bại loudness từ "fail cứng" thành cảnh báo để `library-review` quyết.
  Một nguyên nhân gốc nằm ở **5A**: `normalizeLoudness` (`packages/core/src/media/tts.ts`) chuẩn hoá **một
  lượt** (`loudnorm=I=-16:TP=-1.5:LRA=11:linear=true`), mà một lượt thì ffmpeg bỏ qua `linear` và chạy
  dynamic; trên một dòng lời 2–3 giây (ngắn hơn cửa sổ nhìn trước 3 s của chính nó) kết quả lệch xa mục tiêu
  — đo được **−21.57 LUFS** thay vì −16. Chuẩn hoá hai lượt từng dòng sửa cả gốc lẫn ngọn, nhưng làm **mọi
  cache TTS cũ hết hiệu lực**.

### Chưa từng chạy thật

- **NVENC chưa được kiểm trên phần cứng thật, ở đâu cả.** `h264_nvenc` của ffmpeg 8.1.2 đòi nvenc API 13.1,
  tức **driver NVIDIA ≥ 610.00**; máy build đang ở 581.29 (RTX 3060) nên `probeNvenc` luôn trả `false`,
  `encoder: auto` giải ra `cpu`, và **toàn bộ** đường NVENC (argv mezzanine `p4 cq 18`, argv phát hành
  `p6 cq 19 maxrate 60M`, retry-một-lần-bằng-CPU khi NVENC gãy giữa chừng, chuyển cả run sang CPU) chỉ được
  phủ bằng test fake-spawn. Nâng driver là việc của chủ máy, không phải của harness. Kiểm đầu tiên sau khi
  nâng: `harness doctor` dòng `media:render` phải `ok … NVENC`, rồi so `render_seconds` với bảng CPU trong
  `studio-composition.md` mục 7.
- **Bitrate 4K chưa đo được trên vật liệu thật.** Spec §11 đặt cửa "thấp hơn 30 Mbps thì đổi sang `-cq 17`".
  Nguồn của lần chạy thật là các mảng màu phẳng sinh bằng `lavfi`, nén gần như miễn phí, nên bitrate ra chỉ
  **0.51–0.82 Mbps** — con số đó nói về **vật liệu**, không nói gì về cấu hình encoder, và **không** phải lý
  do để đổi `-cq`/`-crf`. Đo lại trên footage thật trước khi động vào hằng số nào.

### Spec §11 — những điểm để ngỏ, vẫn để ngỏ

- **Nhạc lặp không crossfade**: `aloop` nối thẳng đầu-cuối vòng lặp. Lần chạy thật không chạm tới đường này
  (track 60 s dài hơn mọi tập, `loop: false`), nên "điểm nối nghe có rõ không" vẫn chưa có câu trả lời.
  Việc sau: bản trễ + `acrossfade`, quyết khi có một tập dài hơn track.
- **`duck_threshold_db` trong brand**: ngưỡng sidechain đang là hằng số `0.031` (≈ −30 dBFS), hợp với TTS đã
  chuẩn hoá; nguồn `original` tiếng nhỏ có thể không kích ducking. Chưa thấy ở lần chạy thật (tập `original`
  vẫn ducking đủ sâu), nhưng vẫn là một khoá brand nên có.
- **Dựng theo khối khi > 300 đoạn**: một `filter_complex` cho cả tập là một tiến trình. Lần chạy thật chỉ có
  3–4 đoạn mà đỉnh RAM ffmpeg đã là **~4.2 GB**, nên trần thật vẫn chưa biết. Phương án lùi ghi sẵn: mỗi 50
  đoạn một mezzanine cấp 2.
- **`media-render` vẫn xin lease `gpu` khi render bằng CPU**: giữ đơn giản có chủ đích; nếu nó chặn
  `media-tts` của run khác thì tách `requires_resources` theo encoder.
- **`mezz_cache.bytes` trên dashboard**: cố ý không có (ruling Task 9) — snapshot dựng từ event
  `media.rendered`, mà event đó mang số đoạn cached/rendered chứ không mang dung lượng thư mục cache. Muốn
  biết thì đo thẳng `<data_root>/cache/mezz/`. Spec §6.4 đã sửa lại cho khớp.
- **Ngoài phạm vi 5B, ghi lại để khỏi quên** (spec §10): intro/outro, 9:16 / Shorts, kinetic typography,
  LUT / color grade / ổn định hình, nhiều track nhạc trong một tập, SFX, dịch phụ đề sang ngôn ngữ thứ hai,
  kiểm giấy phép font/nhạc, render phân tán, HDR.

### CLI và cấu hình

- **Dạng chạy tay của `media compose|render` chưa cài** (spec §6.5 đã sửa lại): chỉ có dạng stage. Dựng lại
  một tập hiện phải đi qua một run (`harness retry --stage media-render` khi stage đang FAILED/WAITING_HUMAN,
  hoặc `plan` một run mới), không có đường gọi thẳng từ một `composition.json` có sẵn.
- **`plan-edit` không có input `edit_style` ở 1.3.0**, nên mật độ chữ mà `overlays-valid` áp **luôn** là
  `medium` (spacing 8 s) dù style của kênh khai `high`/`low`/`none`. Thêm `edit_style` vào `inputs` của
  stage là đủ.
- **Không có đường đặt `subtitles` cho từng request trong vòng autopilot**: `autoAccept` chỉ truyền
  `{ voice }` vào `startPlannedRun`, nên tuỳ chọn `subtitles` của profile `studio` (ghi đè
  `brand.subtitles.mode`) chỉ tới được bằng `harness plan --option subtitles=…` chạy tay — đúng cách tập
  `en` + `burn-in` của lần chạy thật phải dùng. Việc sau: một trường `subtitles` trên `ContentRequest`, hoặc
  cho `auto_accept` chuyển tiếp options của request.
- **`library music add` nhận cả file không có phần mở rộng** (đích thành `track.`); danh sách đuôi cho phép
  chỉ nằm trong phần trợ giúp của CLI, không được ép.
- **`TRACK_ID_SCHEMA`/`CHANNEL_ID_SCHEMA` trong `packages/core/src/library/files.ts`** chép lại regex của
  `contracts` thay vì dùng chung.

### `packages/core/src/media/` — dựng hình

- **`packages/cli/src/commands/media.ts` đã 809 dòng cho 7 stage** — tách `compose`/`render` ra file riêng
  (triage ở review cuối Task 8).
- **`composition-valid` dựng `Map` theo `order`**, nên hai entry `timeline.video[]` trùng `order` sẽ gộp mất
  một (`TimelineSchema` không ép `order` duy nhất).
- **`overlays-valid` duyệt `items` hai lượt**; `compose.ts` lặp lại nhiều lần cùng một guard `brand === null`.
- **Mật độ `none` cho `limit = 0`** — hiện được đường "luôn cho ít nhất một" lấp lại; nên nói thẳng trong mã.
- **Trôi lượng tử khung ±0.03 s mỗi đoạn** từ cặp `-t` + `-r fps` khi dựng mezzanine; dung sai của
  `render-valid` (±0.1 s cho cả tập) che được vài chục đoạn, không che được vài trăm. Cân nhắc `-frames:v`.
- **`duck.windows`/`duck.gain_db` trong `composition.json` là thông tin, không phải lệnh**: ducking thật do
  `sidechaincompress` quyết theo **tín hiệu lời**, không đọc hai trường đó. Đã ghi ở runbook mục 5; giữ lại
  ở đây vì đó là một cái bẫy khi đọc file.
- **`prober` hỏng và cache mezzanine hỏng không phân biệt được**: cả hai đều đi đường "xoá entry rồi fail".
- **`cacheEvict` quét LRU ngay cuối mỗi lượt dựng** — an toàn **chỉ vì** `media-render` giữ lease `gpu` duy
  nhất (`resources.gpu: 1` trong `project.yaml` mẫu), nên không thể có hai lượt dựng chạy cùng lúc. Một
  project khai `resources.gpu ≥ 2` thì hai lượt dựng song song có thể quét mất mezzanine **vừa ghi** của
  nhau (cache theo nội dung, không có khoá/refcount nào giữ file đang dùng): không sai kết quả — lượt kia
  encode lại — nhưng mất đúng cái cache sinh ra để tiết kiệm. Việc sau: hoặc refcount file đang được một
  render tham chiếu, hoặc chỉ quét khi không có lease `gpu` nào khác đang giữ.
- **`report.warnings` không gộp `composition.warnings`** — người/agent đọc phải mở cả hai file (skill
  `library-review` đã nói đúng điều đó ở bước 0b).
- **`timeout_seconds` của `media-render` là ngân sách cho cả lượt dựng**, không phải cho từng lệnh ffmpeg.
- **`pcm_s16le` nằm trong `.mp4`** được ffmpeg 8.1 chấp nhận nhưng không phải tổ hợp chuẩn (mezzanine).
- **`LoudnormMeasured` sống ở `audio-graph.ts`** và chỉ được import (không re-export) ở `loudnorm.ts`, vì
  hai dòng `export *` của `packages/core/src/index.ts` sẽ nhập nhằng nếu tên đó xuất ở hai nơi.
- **`AssInput.logo` được nhận nhưng không dùng** — logo do `final-graph.ts` phủ bằng `overlay`, không qua ASS.

### Vệ sinh test

- `ass.test.ts` khẳng định gần như toàn bộ bằng `toContain`, không có phép so khớp **nguyên dòng**
  `Style:`/`Dialogue:`; nhánh nội suy mốc `null`/`undefined` chưa được phủ.
- Không có test `placeOverlays` cho neo `line_id` dưới `voice: original`; biên 0.5 s của `duckWindows` (gộp
  đúng tại 0.5 s nhờ EPS) chưa được phủ.
- ~~`render-valid.test.ts` để lại ~10 workspace 4K trong thư mục temp của hệ điều hành, không dọn.~~
  **Đã xong** (đợt sửa sau review cuối, m8): `render-valid.test.ts` và `run.test.ts` gom mọi thư mục
  `mkdtemp` của chúng và xoá trong `afterAll` (`rmSync(..., { recursive: true, force: true })`, nuốt lỗi).
- `frameStdDev` bị chép lại trong `tests/media.ts` (bản trong checker là private).
- Acceptance 49(b) (`no_tail`) phụ thuộc vào việc dò cảnh trên clip phẳng ra đúng một shot — canh chừng flake.
- `sqlite-store.ts`: nhánh `brand_profile.updated_at ?? clock.now()` chưa có test.
- `mediaRenderInput` ngắt sớm theo vai `channel` chưa có unit test ở tầng composition; nhánh `nvenc: null`
  của dashboard chưa được phủ.

### Đóng lại từ "Sau sub-project 5A"

Ba mục sau đã được `library-production@1.3.0` giải quyết và **chỉ còn đúng với 1.1.0/1.2.0**, hai release giữ
lại làm đường lùi:

- **"1.2.0 không sinh artifact `captions` nào, nên item ra kho không có phụ đề"** — 1.3.0 sinh `captions`
  (SRT + VTT) ở `media-compose` và `library-export` đưa cả hai vào item kho; cùng đó là chữ trên hình,
  nhạc + ducking và chuyển cảnh. 1.2.0 vẫn không có gì trong số đó.
- **`assemble.mjs` đệm im lặng cố định `anullsrc=r=44100:cl=stereo`** và **`-shortest` với `anullsrc` vô hạn
  + `-c:v copy`** — `assemble` không còn là stage của 1.3.0 (`media-render` thay nó: luôn `aresample=48000`,
  luôn cắt theo `total_seconds`), nên hai mục này chỉ còn áp cho ops project nào vẫn chạy 1.1.0/1.2.0. Bản
  mẫu `fixtures/ops-project-footage/executors/wrappers/assemble.mjs` giữ nguyên, không sửa.

Một mục 5A khác **đóng lại hẳn, không còn là nghi vấn**: giả định `fontFamily() = tên file không đuôi` (sổ
Task 3, để ngỏ tới lúc có bản render thật với `fontsdir`) đúng trên thực tế — `fonts/arial.ttf` →
`Fontname: arial` trong ASS, và libass chỉ nhìn `fontsdir` của brand đã vẽ đúng chữ có dấu tiếng Việt ở cả
năm khung trích ra cho chủ máy xem. Lần chạy 4K thật của Task 11 là bằng chứng; **không cần theo dõi tiếp**.

## Hoãn — ghi nhận ở re-review đợt sửa cuối sub-project 5B (2026-09-23)

Ba điểm nhỏ do chính đợt sửa cuối (`2e791bb`..`5ff1fce`) đưa vào; không mở đợt sửa thứ hai, ghi lại để sub-project
sau xử lý:

- **Chú thích nói quá ở `packages/core/src/media/child-env.ts:2-3`** và tiêu đề commit `2e791bb` ("no ffmpeg
  child sees a secret"): `childEnvWithoutSecrets()` mới chỉ áp cho ba chỗ 5B thêm (`render/run.ts`,
  `composition-checkers.ts frameStdDev`, `media-probe-cache.ts`). Các spawn ffmpeg/ffprobe có từ trước
  (`media-checkers.ts volumedetect`, `media/watch.ts`, `media/transcribe.ts`, `media/tts.ts`, `library/voices.ts`,
  `media/index.ts`, `adapters/ffprobe`) vẫn thừa hưởng nguyên `process.env` của worker. Việc cần làm: áp cùng
  helper cho toàn bộ, rồi sửa chú thích cho đúng.
- **`rmSync(tmp, { recursive, force })` trong `finally` của `renderComposition`** (`render/run.ts` ~196): `force` chỉ
  nuốt `ENOENT`; trên Windows một file `tmp/*.mp4` còn bị ffmpeg vừa bị kill giữ tay cầm sẽ ném `EBUSY`/`EPERM`
  từ `finally` và **thay thế** `IO_ERROR` thật (timeout / exit ≠ 0) bằng lỗi fs không phân loại → tầng stage
  phân loại sai. Sửa: bọc `try { } catch { }` quanh dọn dẹp hoặc dùng `maxRetries`/`retryDelay`.
- **Chú thích cũ "one frame of a 260x260 crop"** ở `composition-checkers.ts frameStdDev` (~51-54): kích thước này
  không còn tồn tại sau khi cửa sổ dò được suy từ brand (`logoCrop`/`captionCrop`).

Hai dung sai đã biết của cửa sổ dò mới (không phải lỗi, chỉ để người sửa sau khỏi ngạc nhiên): `captionCrop()`
không tính `cue.raise_px` (cue bị nâng vì `lower_third` vẫn giao đủ với dải dò); `logoCrop()` lấy hình vuông
`2 × height_px` nên logo rộng hơn 2:1 chỉ được dò nửa gần góc.
