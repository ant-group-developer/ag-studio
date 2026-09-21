# ADR-0001: Baseline control plane

**Ngày:** 2026-09-11 · **Trạng thái:** Accepted

## Bối cảnh
Blueprint v1.0 định nghĩa harness đa kênh, đa profile, đa worker. Hệ thống cũ chạy bằng phiên Claude Code tương tác và script Node `.mjs` trên máy khác.

## Quyết định
1. Stack TypeScript/Node 22, pnpm monorepo, Zod, Vitest.
2. State store: SQLite WAL qua `node:sqlite` (có sẵn trong Node 22.13+, không cần build native), `busy_timeout` 5000ms; transaction lồng nhau dùng SAVEPOINT. `better-sqlite3` là phương án thay sau interface `StateStore`.
3. Mỗi entity một bảng document (`id`, `state`, `data` JSON) cộng bảng `lease`; index theo cột nghiệp vụ cần lọc.
4. Mọi đổi trạng thái đi qua `transition()` (kiểm bảng transition + ghi event, một transaction) hoặc `claim()`.
5. Fencing token tăng theo attempt của một stage; mọi commit kết quả kiểm token.
6. Agent runtime trung lập, chọn theo `project.yaml` (`claude` | `codex`).
7. Profile đặt tên theo phong cách sản xuất: `cartoon`, `avatar`, `footage`.
8. Mỗi máy một state store; không chia sẻ state giữa máy ở v1.
9. Bổ sung so với blueprint §9: `VERIFYING → WAITING_HUMAN` (lỗi hợp đồng), `VERIFYING → READY` (lease bị bỏ rơi trong lúc verify), `NEEDS_RECONCILIATION → READY` (reconcile xong thì attempt mới), `CLAIMED → READY|FAILED` (lease bị bỏ rơi hết hạn).
10. Test dùng `vitest.shared.ts` ở root, cấu hình plugin `node:sqlite` cho Vite và alias `@harness/*` → `src`; nhờ vậy chạy test không cần build `dist/`. Ngược lại typecheck từng package (`tsc --noEmit`) cần `dist/*.d.ts` của package phụ thuộc, nên `pnpm typecheck` phải chạy sau `pnpm build`.
11. Lệnh script (`__script`) resolve loader `tsx` bằng absolute `file://` URL trong `fakeScriptCommands()`, để worker chạy được từ workspace nằm ngoài repo (khác ổ đĩa, khác thư mục làm việc).
12. `ExecutorContext` mang theo `clock` của harness; mọi executor tính deadline dựa trên `clock` này, không dùng `Date.now()` trực tiếp, để test có thể giả lập thời gian.
13. External operation: cột `idempotency_key` KHÔNG unique trong SQL — một retry sau khi FAILED tạo dòng mới cùng key; dòng mới nhất là dòng hiện hành. Việc suy ra "hiện hành" là trách nhiệm của tầng đọc (`findExternalOperationByKey`, newest-wins), không phải ràng buộc DB.
14. `harness retry` từ chối run ở trạng thái terminal (FAILED/CANCELLED) trước khi ghi bất cứ gì — kiểm tra xảy ra trước mọi side effect.
15. Cancel hai nhịp: stage không do worker giữ (PENDING, READY, WAITING_HUMAN, WAITING_EXTERNAL, NEEDS_RECONCILIATION) đi thẳng `CANCELLED`; stage đang do worker giữ (CLAIMED, RUNNING, VERIFYING) đi qua `CANCEL_REQUESTED` và chỉ thành `CANCELLED` khi worker commit (không stage artifact, không cộng cost) hoặc khi lease reaper thu hồi lease. Run `CANCEL_REQUESTED` tự settle thành `CANCELLED` trong `advance()` ngay khi không còn stage nào nợ xác nhận.
16. `outcome: "deferred"` trong `StageResult` là cửa người duyệt, không phải lỗi: `FAILURE_KINDS` có thêm `deferred`, attempt FAILED với `failure_kind: "deferred"`, stage đỗ ở `WAITING_HUMAN`, không tăng `result_failures`, không retry, không tạo artifact REJECTED.

## Hệ quả
- Script cũ được bọc qua giao thức file `stage-request.json` / `stage-result.json` trong workspace (sub-project 2).
- Chuyển sang Postgres/object storage chỉ cần implementation mới của `StateStore` và `ArtifactRegistry`.
- Test acceptance cho rò rỉ secret (#11) chỉ chứng minh không rò rỉ theo cấu trúc code (không có đường dẫn nào ghi giá trị secret ra ngoài `secret://scope/name`); trường hợp end-to-end với agent runtime thật để lại cho sub-project 3.

## Sub-project 2A (2026-09-13)

Catalog nguồn/nội dung, `plan` theo option, tài nguyên chia sẻ trong `claim()`, artifact thư mục, invalidation và cache. Đọc code (`packages/core/src/source-catalog/`, `packages/core/src/orchestration/`) để xác nhận hành vi, không chép từ plan.

17. `SourceItem` dedupe theo sha256: cột `checksum` có UNIQUE index. `ingest()` hash file, ghi bản normalize, rồi mới `insertSourceItem`; nếu một ingest khác thắng UNIQUE trước, bản normalize vừa tạo bị xoá và hàng đã thắng được trả về — race-safe giữa nhiều tiến trình ingest cùng file.
18. Vật liệu hoá nguồn theo `project.yaml.source.materialize`: `link` (mặc định) hardlink file gốc vào `data/sources/normalized/<source_id>/`, dùng chung inode — sửa file gốc sau đó cũng đổi bản normalize (caveat có chủ đích, không copy-on-write); `copy` nhân bản byte; `reference` chỉ ghi `original_uri`/`uri` trỏ vào file gốc, không tạo bản sao. Hardlink thất bại (khác ổ đĩa) rơi về `copy`.
19. `ContentVariant` là get-or-create khoá theo `content_id` + `profile_id` + `profile.revision` + digest của options đã chuẩn hoá (sort key). Options truyền vào `plan --option` được hợp nhất với `options_defaults` của profile rồi kiểm theo `options_schema` (`{ key: [allowed values] }`); key lạ hoặc giá trị ngoài danh sách → `CONFIG_INVALID` trước khi tạo run.
20. `when: options.<key> == "<v>"` / `!=` trên stage definition được planner đánh giá tại `plan()` theo options đã resolve của variant (`resolveStageGraph`). Stage có `when` sai bị loại khỏi `StageRun` của run đó (không tạo dòng); mọi stage phụ thuộc nó (`depends_on`) được nối lại xuyên qua các dependency của chính stage bị loại, đệ quy nếu cả chuỗi đều bị loại — không để lại cạnh treo. `when` tham chiếu option không có trong `options_schema` của profile là lỗi `CONFIG_INVALID` ngay khi `plan()`.
21. `depends_on_optional` là dependency mềm: một khi còn trong graph (không bị `when` loại), nó bắt buộc y như `depends_on` — planner chờ nó SUCCEEDED trước khi thả stage phụ thuộc. Khác biệt duy nhất là lúc rewire: nếu stage được tham chiếu tối bị `when` loại, cạnh optional bị bỏ hẳn (không nối xuyên qua như cạnh bắt buộc) vì bản thân nó vốn không bắt buộc phải tồn tại. Sau khi rewire, nếu một dependency vừa là bắt buộc vừa còn sót trong danh sách optional thì bị lọc khỏi optional (tránh liệt kê trùng).
22. Tài nguyên chia sẻ khai ở `project.yaml.resources: { name: capacity }`; stage khai `requires_resources`. `claim()` bỏ qua một stage READY nếu bất kỳ tài nguyên nào trong `requires_resources` đã hết slot trống — tính bằng số lease đang hiệu lực giữ tài nguyên đó (`lease.resources`, cột JSON), tên không khai trong `project.yaml` coi như capacity 0. Lease ghi lại `resources` nó đang giữ để tính held-count không cần join qua stage definition. Stage READY chờ quá `resource_wait_warn_seconds` (mặc định 600s) sinh `stage.waiting_resource`, chỉ lặp lại sau khi hết cửa sổ đó (không spam log mỗi vòng poll).
23. `gate_deadline_seconds` và executor `type: "gate"` đã có trong schema (`stageDefinitionSchema`, `executorRefSchema`) để workflow footage khai trước, nhưng chưa có hành vi thực thi — planner chỉ đối xử đặc biệt với `gate` ở một điểm: không bao giờ reuse cache cho nó. Cổng người duyệt (`stage submit`) và cưỡng chế deadline để lại cho 2B.
24. Output khai `kind: "directory"` tạo **một** artifact cho cả thư mục thay vì một artifact mỗi file: `listDirectoryFiles` liệt kê mọi file con (đường dẫn tương đối, sha256, size), `checksum` của artifact là canonical digest của listing đó (nội dung quyết định checksum, không phải thứ tự đọc đĩa). Input thư mục cho stage kế tiếp được vật liệu hoá lại thành cây bằng hardlink, rơi về copy khi khác ổ đĩa (`copyTree`).
25. Invalidation: khi một stage của run hiện tại commit một artifact ACCEPTED mới, mọi artifact ACCEPTED của **chính stage đó** và các stage phụ thuộc nó xuyên suốt (`depends_on` lẫn `depends_on_optional`, tính transitive) ở **run khác trước đó của cùng variant** chuyển sang STALE — mỗi artifact một event `artifact.stale` (ghi trên run/stage cũ, kèm `superseded_by_run`), cộng một event `stage.invalidated_downstream` trên run vừa commit nếu có ít nhất một artifact bị đánh STALE. Run không có `variant_id` (không qua catalog) không kích hoạt invalidation.
26. Cache: `cache_key = canonicalDigest(stageDefinitionDigest, sort(inputChecksums), variant.options_digest, effective_config_digest, executor_version)`, ghi vào `StageRun.cache_key` khi controller commit SUCCEEDED. Tại `plan()`, nếu `profile.reuse !== "never"` và stage không phải `gate`, và toàn bộ dependency của nó đã được đánh dấu reuse (theo thứ tự khai trong workflow — giả định topological), planner tính trước cache key dự kiến và tìm run khác của cùng variant có stage cùng `stage_key` ở trạng thái SUCCEEDED với cùng `cache_key`; nếu thấy, `StageRun` mới được tạo thẳng ở trạng thái SUCCEEDED với `reused_artifact_ids` trỏ vào artifact ACCEPTED cũ, không dispatch — event `stage.reused`. `profile.reuse: "never"` tắt hẳn cơ chế này cho mọi stage của profile đó.
27. Thành phần của `cache_key` khớp spec §3.3: ngoài stage definition, input checksums, options digest và effective-config digest còn có `executor_version` (khóa `x`). Controller lấy version từ executor vừa chạy; planner cần `PlanInput.executorVersionFor` để tính trước cùng một key — không truyền hàm đó thì reuse bị tắt hẳn (không đoán version, không tính key không bao giờ khớp). Nâng cấp executor vì thế tức thì phá cache cho mọi stage nó chạy.
28. Giá trị option của variant luôn là **string**: `options_schema` của profile là `Record<string, string[]>`, nên boolean viết thành `"true"`/`"false"` và số viết thành chuỗi. `plan --option k=v` vì thế không coerce kiểu (khác `--override`, có coerce), và `when: options.x == "true"` so sánh chuỗi. Options digest khóa variant cũng tính trên chuỗi đó.

## Sub-project 2B (2026-09-13)

Script cũ được bọc qua `@harness/script-sdk`, gate người duyệt (`harness stage submit`), checker media
(ffprobe), `harness doctor`, `harness source sync`, ngân sách theo variant. Đọc code
(`packages/core/src/config/scripts.ts`, `packages/core/src/orchestration/{gate,budget,cache,invalidation,
planner,journal}.ts`, `packages/core/src/verification/media-checkers.ts`, `packages/core/src/doctor/doctor.ts`,
`packages/executors/src/{script-executor,gate-executor}.ts`, `packages/adapters/ffprobe/`) để xác nhận hành
vi, không chép từ plan.

29. `executors/scripts.yaml` khoá theo **tên script**, không theo stage key: `ScriptsRegistrySchema.scripts`
    là `Record<tên, ScriptSpec>`; một stage định danh script của nó qua `executor.script` (không phải
    `stage.key`) nên nhiều stage có thể dùng chung một entry (một script chạy cho nhiều workflow/stage khác
    nhau). `ScriptExecutor` tra `request.stage_config.__script` — tên đó do `buildStageRequest` gắn vào từ
    `stageRun.executor.script` khi executor là `script`.
30. `requires_resources` trong `scripts.yaml` **ghi đè** khai báo trên workflow stage, nhưng chỉ tại thời
    điểm `plan()`: `planner.plan()` nhận `requiresResourcesOverride(stage)` từ CLI
    (`ctx.scripts?.scripts[s.executor.script]?.requires_resources`), và giá trị đó (nếu có) thay hẳn
    `stage.requires_resources` khi ghi vào `StageRun.requires_resources` — không merge hai danh sách. Đổi
    `scripts.yaml` sau khi plan không hồi tố các run đã tạo (mỗi `StageRun` giữ bản `requires_resources` của
    riêng nó).
31. `timeout_seconds` của một script cap thời lượng **chạy thật** của child process, độc lập với deadline
    chung của attempt: `ScriptExecutor` tính `timeoutMs = min(deadlineMs, timeout_seconds * 1000)` — một
    script không khai `timeout_seconds` chạy tới hết deadline của attempt như trước 2B; khai nhỏ hơn deadline
    thì fail "transient" (`EXECUTOR_TIMEOUT`) sớm hơn deadline chung.
32. Secret của `env_refs` chỉ vào **env của process con** (script cũ), không bao giờ vào `stage-request.json`,
    event hay log: `ScriptExecutor` resolve từng `env_refs` bằng `SecretResolver` ngay trước `spawn`, đặt
    thẳng vào object `env` truyền cho `spawn` — không đi qua bất kỳ giá trị nào khác của request. `Redactor`
    (khởi tạo từ `secrets.resolvedValues()`, đã có từ sub-project 1) che mọi giá trị secret đã từng resolve
    xuất hiện trong bất kỳ dòng log nào của logger dùng chung, kể cả khi chính script cũ tự in giá trị đó ra
    (`console.log`) — dòng đó vẫn đi qua `forwardStdout` → `ctx.logger` → `Redactor` (acceptance #16).
33. stdout của script con được đọc theo dòng (`forwardStdout`): một dòng JSON hợp lệ với `level` thuộc
    `{info,warn,error}` và `msg` là string được log **có cấu trúc** qua `logger[level](msg, rest)` — mọi
    field khác của object đó thành payload của log entry. Dòng không parse được thành JSON, hoặc parse được
    nhưng thiếu `level`/`msg` đúng dạng, được log nguyên văn ở mức `info` với `{ stream: "stdout" }`. stderr
    luôn log `warn` nguyên văn, không parse JSON.
34. `HARNESS_*` env cho wrapper: `HARNESS_WORKSPACE`, `HARNESS_PROJECT`, `HARNESS_RUN_ID`,
    `HARNESS_STAGE_RUN_ID`, `HARNESS_ATTEMPT_ID`, `HARNESS_FENCING_TOKEN`, `HARNESS_STAGE_KEY` do
    `ScriptExecutor` đặt cho mọi attempt; `HARNESS_CLI_ARGV` (JSON array, ví dụ `["node",
    "/path/to/cli.js"]`, sinh bởi `cliArgv()` trong `packages/cli/src/self.ts` — quy đổi `--import`/`--loader`
    tương đối thành `file://` tuyệt đối để script con chạy được dù cwd khác) chỉ được đặt khi
    `ScriptExecutorOptions.cliArgv` được truyền (composition root luôn truyền) — thiếu nó thì `ctx.op.*` của
    script-sdk ném lỗi rõ ràng thay vì spawn một lệnh rỗng.
35. `harness op intent|confirm|lost` đều bắt buộc `--fencing-token`, kiểm bằng `store.assertFencing(...)`
    trước khi đọc/ghi gì — một attempt đã bị supersede (lease mới, fencing token mới) gọi `ctx.op.*` sẽ bị
    `FENCING_REJECTED` ngay, không sửa được state của operation. `intent` khoá theo
    `sha256(canonicalJson({kind, target, payload}))`: nếu đã có một operation cùng key **và không phải
    FAILED** (kể cả CONFIRMED), `intent` trả lại chính nó — không tạo dòng mới, không gọi provider lại; một
    operation FAILED bị coi là không hiện hành, `intent` kế tiếp cùng key ghi **dòng mới**. Payload vì thế
    phải ổn định qua các lần retry (dùng checksum input, không dùng đường dẫn workspace — path đổi mỗi
    attempt vì workspace mới).
36. Gate không thực thi gì: `GateExecutor.execute` chỉ ghi `stage-request.json` và `brief.md` (đề bài render
    từ inputs/expected_outputs/options/source_items của request) vào workspace rồi trả `outcome: "deferred"`
    — `deferred` không phải lỗi (đã có từ sub-project 1, mục 24), stage đỗ `WAITING_HUMAN`. `harness stage
    submit <stage_run_id>` đi đúng đường một worker sẽ đi: verify `output/` (pre-check bằng
    `d.verifier.verify` trên chính attempt gate đang đỗ, để reject sớm mà **không đổi state** nếu thiếu file
    hay fail check) rồi mới `WAITING_HUMAN → READY`, `claim({ stageRunId })` (claim **đích danh** stage này,
    không quét toàn bộ READY) với `owner` mặc định `"cli-submit"`, rồi `Controller.commit` y hệt worker. Một
    lỗi *sau* claim (input ACCEPTED bị stale, artifact bị sweep, …) không strand lease: `submitGate` bắt lỗi
    đó và tự commit một `StageResult` "failed" tổng hợp (trừ `FENCING_REJECTED`, vẫn propagate) để lease được
    giải phóng và stage đỗ đúng chỗ như một setup failure của worker. Transition `WAITING_HUMAN → READY` và
    `claim({ stageRunId })` nằm **trong cùng một `store.transaction`** (claim lồng qua savepoint): nếu tách
    hai transaction thì giữa chúng stage là READY thuần, đủ để một worker đang poll claim mất gate, chạy lại
    `GateExecutor` và bỏ rơi output người duyệt vừa nộp. Hệ quả: claim không thành (`STALE_STATE`) thì
    transition cũng rollback — gate ở nguyên `WAITING_HUMAN`, không bị bỏ lại READY.
37. `stage.gate_overdue` chỉ ghi **một lần mỗi cửa sổ** `resource_wait_warn_seconds` cho cùng một stage:
    `gateOverdue(store, now, windowSeconds)` quét mọi run `WAITING`/`RUNNING`, mọi stage gate `WAITING_HUMAN`
    quá `gate_deadline_seconds`, và bỏ qua nếu event `stage.gate_overdue` gần nhất của đúng stage đó còn nằm
    trong cửa sổ. Hàm này **không thuần đọc** — nó tự ghi event khi phát hiện quá hạn — nhưng được gọi từ hai
    nơi độc lập: worker (`runOnce`, mỗi vòng poll rảnh) và `harness status <run_id>` (mỗi lần gọi, để đánh
    dấu `OVERDUE` trên dòng stage) — cả hai dùng chung logic dedupe nên `status` một mình (không cần worker
    đang chạy) cũng sinh và thấy được cảnh báo. Vì tác dụng phụ đó xảy ra dù sao, `harness status --json`
    trả thêm `overdue: string[]` (danh sách `stage_run_id` vừa bị đánh dấu ở chính lần gọi này), không chỉ
    hiện " OVERDUE" ở output người đọc.
38. `EdlSchema` (`schema_version: "harness.edl/v1"`, `entries: EdlEntry[]`, tối thiểu 1 entry, `order` không
    trùng nhau) là hợp đồng giữa gate `edit-plan` và script `cut`/`assemble`: mỗi entry
    `{ source_id, in, out, order, overlay?, note? }` (`in < out`, `overlay` chỉ nhận `"avatar"` hoặc null).
    Checker `edl-valid` kiểm output khai `type: "edl"` khớp schema và mọi `source_id` nằm trong
    `request.source_items`; checker `clip-set-complete` đọc **input** `type: "edl"` của chính stage đang
    verify (không phải output) để đối chiếu số file `NNN.mp4` và thời lượng từng file trong một output
    `kind: "directory"` khai `type: "clip_set"`.
39. Checker media (`media-probe`, `duration-range`, `audio-integrity`, `clip-set-complete`, `edl-valid` —
    `mediaCheckers(prober)`) chọn output cần kiểm theo **mime khai trong `expected_outputs` của request**
    (`mimeOf(input, o)` tra theo `type`), không đoán theo phần mở rộng file; một output có mime không phải
    `video/*`/`audio/*` bị bỏ qua (`skip`, không fail). Ngưỡng (`target_duration_seconds`,
    `max_silence_ratio`) đọc từ `StageRequest.policy`, `request.ts`'s `policyFor(profile)` build từ
    `profile.content` — thiếu policy (profile không khai, hoặc profile file đã mất lúc build request) thì
    checker tương ứng `skip` thay vì fail cứng.
40. `packages/adapters/ffprobe` là **phụ thuộc hệ thống** (binary `ffprobe`/`ffmpeg` trên PATH, hoặc
    `FFPROBE_PATH`/`FFMPEG_PATH`), không phải gói npm — `core` không bao giờ import nó trực tiếp (composition
    root quyết định). Mọi lời gọi `spawnSync` đều có timeout cứng (`DEFAULT_TIMEOUT_MS` 120s cho probe,
    10s cho `isAvailable()`) và `maxBuffer` 16MB, khác biệt với `ScriptExecutor` (dùng `child.kill()` qua
    `setTimeout`) vì đây là lời gọi đồng bộ. Thiếu `ffprobe` rơi về `NullMediaProber`, và composition root
    truyền luôn `mediaCheckers(prober, { available: FfprobeMediaProber.isAvailable() })`: với
    `available: false`, **bốn checker dựa trên prober** (`media-probe`, `duration-range`, `audio-integrity`,
    `clip-set-complete`) trả thẳng `{ verdict: "skip", evidence: { reason: "no media prober available" } }`
    trước khi nhìn tới output nào. `edl-valid` **được miễn**: nó chỉ parse JSON theo `EdlSchema` và đối chiếu
    `request.source_items`, không cần prober, nên vẫn cho verdict pass/fail thật trên máy không có ffprobe.
    Một prober **có mặt** mà trả `null` cho một file vẫn là `fail`: đó là output hỏng, không phải thiếu công cụ.
    Cần nói rõ hệ quả state: `Verifier.verify` chỉ tính `allRequiredPassed` khi **mọi** kết quả là `pass`,
    nên một `skip` trên một check bắt buộc làm `allRequiredPassed = false`; `classifyFailure` khi đó trả
    `"result"` (không phải `"contract"` — `verify.missing` rỗng, không có lỗi `contract` nào trong result),
    nên stage đi `RUNNING → VERIFYING → FAILED`, output được `registerRejected`, và vì `retry_on` mặc định là
    `["transient", "abandoned"]` thì **không có retry** — run chốt `FAILED`. Nói cách khác: thiếu `ffprobe`
    **không** làm đường ống footage chạy hết; nó dừng ở stage media đầu tiên (`index-source`, `required_checks`
    có `media-probe`) với một `check_result` `skip` ghi rõ lý do (trước đây là `fail` "no probeable media
    stream", cùng hệ quả state nhưng khó đọc hơn). Vì `edl-valid` được miễn, gate `edit-plan` vẫn được kiểm
    đúng như bình thường kể cả khi không có ffprobe.
    `harness doctor` báo dòng `ffprobe` FAIL chính là cảnh báo trước cho tình huống này.
41. `harness doctor` liệt kê các `check` id: `migrations`, `ffprobe`, `resources`,
    `script:<workflow_id>/<stage_key>` (một dòng cho mỗi stage script của mỗi workflow), `wrapper:<tên>` và
    `secret:<tên>:<env>` (một dòng cho mỗi wrapper file / mỗi biến `env_refs`, dedupe theo tên script — không
    lặp nếu nhiều stage dùng chung một script), `resource:<stage_key>:<tên>` (theo `requires_resources` hiệu
    lực — override của `scripts.yaml` nếu có, không thì của workflow), `gate-output:<stage_key>` (mọi output
    của gate phải có `name`), `profile:<id>:workflow`, `profile:<id>:when:<stage_key>`,
    `profile:<id>:options_defaults`, `sources`. Project **không có** `executors/scripts.yaml` không phải lỗi
    — doctor gộp thành đúng **một** dòng `ok` (`check: "scripts"`, "chỉ built-in fake script khả dụng") và bỏ
    qua toàn bộ check theo-từng-script (không có registry thì không có gì để kiểm ở mức đó); một tên script
    không có trong `scripts.yaml` nhưng nằm trong `builtinScripts` (danh sách fake do composition root gộp
    vào, ví dụ `fake-stage` dùng trong test) vẫn `ok`, ghi rõ "provided by built-in commands". Một
    `executors/scripts.yaml` / `source-catalog/sources.yaml` **sai schema** không còn làm `buildContext` ném
    `CONFIG_INVALID` cho *mọi* lệnh: composition root bắt đúng lỗi đó, để registry `undefined` và ghi thông
    điệp vào `AppContext.configErrors.{scripts,sources}`; `doctor` nhận qua `DoctorInput.configErrors` và in
    dòng `scripts`/`sources` FAIL với chính thông điệp đó (các dòng khác vẫn chạy). Lệnh thật sự cần registry
    vẫn fail to: `harness source sync` ném lại `CONFIG_INVALID` đã lưu, còn script executor báo `NOT_FOUND`
    cho tên script không nạp được.
42. `harness source sync` đối chiếu `source-catalog/sources.yaml` với DB, trả `SourceSyncReport { added,
    already, missing_files, unregistered }`: `added`/`already` là `{source_id, path}` theo entry vừa
    ingest/đã có; `missing_files` là `path` của entry mà file trên đĩa không còn tồn tại (không tự xoá gì
    khỏi DB); `unregistered` là `{source_id, uri}` của source **đã có trong DB** nhưng checksum không khớp
    entry nào hiện có trong `sources.yaml` (báo, không hành động). Exit code 1 khi `missing_files.length >
    0`; `already`/`unregistered` không ảnh hưởng exit code.
43. Ngân sách tính theo **variant**, không theo run: `variantSpent` cộng `total_cost_usd` của **mọi** run
    cùng `variant_id` (kể cả run đang xét); `budgetBlocks` so với `run.budget_usd` của chính run đó
    (`plan`/`retry --raise-budget` đặt). Vượt/chạm ngân sách chặn **dispatch mới** (`releaseReady` return
    sớm nếu `blocked`, trước khi tới dispatch thường lẫn `tryLateReuse`) và event `run.budget_exceeded` ghi ở
    `enqueue()` (chưa từng READY) lẫn `advance()` (đang RUNNING, hết việc active nhưng còn PENDING); run
    chuyển `RUNNING → WAITING`. `harness retry --raise-budget <usd>` (usd phải lớn hơn `variantSpent` hiện
    tại) nâng `run.budget_usd`, ghi `run.budget_raised`, rồi tự `planner.advance()`. **Bất đối xứng có chủ
    đích**: reuse lúc `plan()` (chọn artifact cũ khi tạo `StageRun`, trước `enqueue`) hoàn toàn không nhìn
    ngân sách — không phát sinh chi phí mới nên không cần chặn; reuse **lúc release** (`tryLateReuse`, một
    stage `PENDING` dưới gate tính lại cache key khi dependency vừa `SUCCEEDED`) nằm trong cùng vòng lặp với
    dispatch thường trong `releaseReady` nên **bị chặn y hệt dispatch** dù bản thân nó miễn phí — một stage
    lẽ ra tái sử dụng được vẫn phải chờ `--raise-budget`.
44. Invalidation theo **nội dung** (spec §3.2), không chỉ theo graph: `invalidateDownstream` so tập checksum
    vừa commit (`newChecksums`, đã sort) với tập checksum ACCEPTED hiện có của **chính stage đó** ở mỗi run
    khác của cùng variant; khớp y hệt (cùng độ dài, cùng thứ tự sau sort) thì bỏ qua run đó hoàn toàn — không
    đánh STALE gì, kể cả các stage phụ thuộc xuôi dòng. Nhờ vậy submit lại một gate với đúng nội dung cũ
    (byte giống hệt) không phá cache của run trước. Tập checksum "đang giữ" của run cũ được resolve **giống
    `acceptedInputsFor`/`findReusableArtifacts`**: stage nào có `reused_artifact_ids` (stage được reuse — một
    run "con trỏ", không có hàng artifact của riêng nó) thì lấy checksum của các artifact nó trỏ tới và còn
    ACCEPTED, thay vì `listArtifacts({ stage_run_id })` (luôn rỗng, khiến run con trỏ bị invalidate oan). **Ngoại lệ**: nếu `newChecksums` rỗng (stage vừa commit
    không tạo output nào), so sánh nội dung bị bỏ qua — `invalidateDownstream` quay về hành vi thuần theo
    graph (invalidate mọi ACCEPTED artifact của chính stage đó và xuôi dòng ở run khác), vì không có gì để
    so nội dung.
45. Reuse còn xảy ra **lúc release** ngoài lúc `plan()`: `tryLateReuse(store, run, stage)` áp dụng cho một
    `StageRun` `PENDING` đã đủ dependency `SUCCEEDED` — dùng `stage_definition_digest` và
    `expected_executor_version` mà `planner.plan()` đã ghi sẵn lên `StageRun` lúc tạo (`reuse_eligible` cũng
    ghi sẵn lúc đó: false nếu stage là gate, hoặc profile `reuse: never`, hoặc thiếu
    `executorVersionFor`), cộng checksum input **ACCEPTED thật** (không phải input dự đoán lúc plan) để tính
    lại `cache_key`; trúng thì `StageRun` đi thẳng `PENDING → SUCCEEDED` (event `stage.reused`, payload thêm
    `at: "release"` để phân biệt với reuse lúc plan), field `reused_artifact_ids`/`cache_key` được ghi, không
    dispatch. Cơ chế này là lý do một stage nằm dưới gate — thứ không bao giờ reuse lúc plan (mục 23) — vẫn
    có thể tái sử dụng được nếu gate cho ra đúng nội dung cũ.
46. `StateStore.claim({ stageRunId })`: tham số tùy chọn thêm vào chữ ký `claim()` sẵn có (2A) để claim
    **đích danh một stage READY cụ thể** thay vì quét theo capability/thứ tự `ready_at` — chỉ `submitGate`
    dùng, vì gate submit đã biết chính xác `stage_run_id` cần claim (chính nó, vừa chuyển `WAITING_HUMAN →
    READY`) và không muốn tranh chấp với worker đang quét các stage khác.
47. `reconcileOperation` đưa stage từ `NEEDS_RECONCILIATION` về `READY` ngay khi **không còn operation nào
    khác của stage đó còn `NEEDS_RECONCILIATION`** — **bất kể kết quả reconcile là `CONFIRMED` hay
    `FAILED`**; runbook/AGENTS trước đây viết "FAILED → cần người xem xét rồi mới retry" là sai so với code
    (đã sửa ở `docs/runbooks/reconcile-and-retry.md` và `AGENTS.md`, không đổi hành vi). Khác biệt thật sự
    giữa hai kết quả nằm ở lần attempt kế tiếp của wrapper: `ctx.op.intent` cùng idempotency key trả lại
    ngay operation đã `CONFIRMED` (không gọi provider lại); với `FAILED`, idempotency key giữ nguyên nhưng
    `recordIntent` ghi một **dòng mới** (một operation `FAILED` không được coi là hiện hành — mục 13), nên
    lần attempt kế tiếp gọi provider lại từ đầu.
48. Heartbeat của worker sống qua **cả** `verifier.verify` và `controller.commit`, không dừng ngay sau
    `executor.execute`: verify giờ có checker media gọi `ffprobe` qua `spawnSync` (chặn, tối đa 120s mỗi
    probe) và commit còn chuyển từng output vào artifact store, nên nếu dừng nhịp tim sớm thì một stage chạy
    chậm-nhưng-khoẻ có thể mất lease vào tay reaper đúng giữa execute và commit. `hb.stop()` nằm trong một
    `finally` bọc quanh execute + verify + commit; các kiểm tra `hb.lost`/fencing trước commit và đường cancel
    (`cancelCurrent`) giữ nguyên vị trí cũ.
49. Sub-project 2C (Task 3) đổi tên `SyncReport` (kiểu trả về của `syncSources`, `source-catalog/sources-file.ts`,
    2B) thành `SourceSyncReport`: brief của Task 3/9 đặt tên `SyncReport` cho kiểu trả về mới của `syncLibrary`
    (`packages/core/src/library/sync.ts`), và `export *` của hai module trong `packages/core/src/index.ts` không
    thể mang hai kiểu trùng tên (`tsc` báo lỗi ambiguity ở barrel) — đây là chỗ đụng tên không được thấy trước
    khi viết brief 2B lẫn 2C, không phải đánh đổi thiết kế, nên sửa thẳng theo quy tắc "lỗi rõ ràng trong code
    của plan thì sửa ngay". Đổi tên bản 2B (ít rủi ro hơn: không nơi nào trong `packages/cli` import kiểu này
    theo tên, chỉ suy ra qua `Awaited<ReturnType<...>>`) thay vì đổi `SyncReport` mới của kho — giữ đúng tên mà
    brief Task 6/9 đã viết sẵn cho `library sync`.

## Sub-project 2C (2026-09-14)

Kho nội dung (content library): máy studio dựng episode từ nguồn theo một edit style đã học rồi xuất vào một
thư mục chia sẻ ("kho"); máy channel xin nội dung, đồng bộ, rồi nhận một item đã duyệt. Đọc code
(`packages/contracts/src/library.ts`, `migrations/0003_library.sql`, `packages/core/src/library/
{files,sync,requests,review,export}.ts`, `packages/core/src/verification/library-checkers.ts`,
`packages/cli/src/commands/{library,library-stage,doctor}.ts`, `packages/cli/src/composition.ts`,
`packages/worker/src/worker.ts`) để xác nhận hành vi, không chép từ plan/spec.

50. Kho là filesystem chia sẻ (mount SMB/NAS/Drive), không phải service: mỗi file có đúng một "chủ ghi" theo
    vai (`LibraryFs.assertWritable`) — `studio` ghi `styles/**`, `items/**` trừ mọi đường có đoạn `claims`,
    `index.json`, và chỉ **overwrite** `requests/<id>.json` đã tồn tại (không bao giờ tạo mới); `channel` tạo
    hoặc ghi đè `requests/<id>.json` và `items/<id>/claims/<channel_id>.json`. Ghi ngoài root hay ngoài các
    đường trên ném `CONFIG_INVALID` trước khi chạm đĩa. Mọi ghi đi qua `writeJsonAtomic`/
    `copyFileWithChecksum`: file tạm `<file>.tmp-<uuid>` cùng thư mục đích rồi `renameSync` đè lên.
51. Ba bảng mirror `edit_style`/`content_request`/`library_item` (migration `0003_library.sql`) **không** đi
    qua `transition()` — cột `state` chỉ được `syncLibrary`/`upsert*` ghi trực tiếp từ nội dung đọc được trên
    kho, phản ánh trạng thái của file chứ không phải một state machine control-plane; không có bảng transition
    nào ràng buộc chuyển đổi của chúng.
52. Bốn stage kho (`intake`, `style-export` script `library-style-export`, `export` script `library-export`,
    `apply-review` script `library-apply-review`) là built-in trong CLI composition
    (`builtinLibraryCommands`, `packages/cli/src/composition.ts`) thay vì wrapper ops project phải cung cấp:
    mỗi lệnh chỉ tự gọi lại chính CLI này (`harness --project <dir> library stage <name>`) qua executor
    `script` bình thường (`ScriptExecutor` không phân biệt), nhưng cần `StateStore`/`LibraryFs` trực tiếp
    (`claimRequest`, `applyReview`, `exportItem`, `exportStyle`) — việc một wrapper `.mjs` độc lập không làm
    được. Một ops project studio thật vì thế chỉ cần khai `scripts.yaml` cho các wrapper media của mình (xem
    `fixtures/ops-project-studio/executors/scripts.yaml`), không cần bốn entry kho.
53. `intake` là nơi duy nhất một `content_request` chuyển `open → claimed` (`claimRequest`): cùng run gọi lại
    là idempotent (trả lại request không ghi lại); request đang `claimed` bởi run khác, hay không còn `open`,
    ném `INVALID_TRANSITION` → stage `WAITING_HUMAN` (contract failure, không retry). `harness library
    accept` (CLI) chỉ build `library_brief`/`ContentItem` cục bộ, **không** tiền-kiểm `status` của request —
    accept một request không còn `open` vẫn thành công, lỗi chỉ lộ ra sau, ở `intake` của run vừa `plan`
    (deferred, ledger Task 8).
54. `library-apply-review` (built-in stage, sau gate `library-review`) và `harness library review` (CLI,
    không qua gate) đều gọi thẳng `applyReview` (`packages/core/src/library/review.ts`) — hàm duy nhất ghi
    kết quả duyệt vào kho: `approved` gọi `fulfillRequest` (đẩy `item_id`, `fulfilled` khi `item_ids.length >=
    count`); `rejected` gọi `reopenRequest` (`open`, nối ghi chú vào `notes`, xoá `claimed_by_run`).
55. `syncLibrary` phân loại `imported`/`updated`/`unchanged` bằng `updated_at` (file mới hơn mirror) rồi
    `canonicalDigest` (nội dung khác mirror) — nội dung giống hệt không ghi lại dù `updated_at` khác, để đồng
    hồ lệch giữa hai máy không tạo vòng lặp ghi vô ích qua mount chậm.
56. `ProductionProfileSchema.profile_id` thêm `"studio"` vào enum (`cartoon | avatar | footage | studio`),
    kéo theo `ProductionProfileRefSchema` và JSON Schema sinh lại bằng `pnpm gen:schemas`.
57. `project.yaml.workflows` (đã có từ trước, optional) giờ còn scope `harness doctor`
    (`packages/cli/src/commands/doctor.ts`): không khai = quét mọi `workflow.yaml`/`profile.yaml` cài trong
    harness (hành vi cũ); khai `[]` = không quét workflow/profile nào (đúng cho một project channel không có
    `executors/`); khai danh sách = chỉ quét đúng các release đó (và profile có `workflow_release` nằm trong
    danh sách) — một ref không nạp được thành dòng `workflow:<ref>` FAIL riêng thay vì làm chết lệnh `doctor`
    (ledger Task 7, sửa ngay trong vòng review đầu vì spec không tính tới project chỉ chạy một phần workflow
    của harness).
58. `claimItem` (channel `library pick`): một claim đã tồn tại
    (`items/<id>/claims/<channel_id>.json`) được tôn trọng **bất kể trạng thái hiện tại của item** — trả lại
    đúng claim và `ContentItem` cũ, không ghi lại, không kiểm `approved` lại. Chỉ một claim **mới** mới đòi
    item đang `approved` (nếu không thì `INVALID_TRANSITION`). Cố ý khác `claimRequest` (mục 53, chỉ
    idempotent trong cùng run): ở đây idempotent theo channel, vĩnh viễn — một channel đã `pick` một item giữ
    nguyên `ContentItem` của nó kể cả khi item đó sau này chuyển `withdrawn`/`rejected`.
59. `exportItem` (`library-export`) là chỗ duy nhất kho xoá file: idempotent trên `existingItemId` (chạy lại
    cùng `item_id` ghi đè cùng thư mục `items/<id>/`, giữ `created_at` cũ), rồi `pruneStaleFiles` xoá mọi file
    thường nằm trực tiếp trong thư mục item không còn nằm trong `files[]` của lần xuất mới (ví dụ ít thumbnail
    hơn lần trước) — không đệ quy, nên `claims/` (do channel ghi) không bao giờ bị đụng tới.
60. `harness retry --stage <key>` chỉ đưa stage `FAILED`/`WAITING_HUMAN` về `READY`. Một run mà
    `library-apply-review` ghi `rejected` kết thúc với **mọi** stage `SUCCEEDED` — từ chối là một kết quả
    bình thường của workflow, không phải lỗi — nên không có gì để `retry`; `retry --stage plan-edit` in
    `nothing to retry`. Đường làm lại thật sự: request đã `reopenRequest` về `open`, `library accept --request
    <cùng id>` lần nữa rồi `plan` một **run mới** (không phải `retry` run cũ). Spec §3.2/§6 nhắc `retry
    --stage plan-edit` như một lựa chọn khả dĩ sau khi bị từ chối — ghi chú sửa lại ở cuối tài liệu spec 2C
    (`docs/superpowers/specs/2026-09-14-sub-project-2c-content-library-design.md`).
61. Kho là một **mount**, không phải thư mục do process này sở hữu: mọi ghi qua `LibraryFs`
    (`writeJsonAtomic`, `copyFileWithChecksum`) kiểm `exists()` của `library.root` trước, và `syncLibrary`
    cũng vậy — root không có mặt ném `IO_ERROR` (`transient` với `library-stage`, exit 1 với CLI) thay vì để
    `mkdirSync(..., { recursive: true })` dựng một cây thư mục cục bộ đóng vai kho rồi báo "thành công".
    Không có check này, một máy chưa mount kho vẫn chạy `library-export` "xong" vào đĩa cục bộ, và
    `library sync` báo mọi thứ `missing` như thể ai đó vừa xoá sạch kho.
62. `readRequest`/`readItem` chỉ map **file không tồn tại** (`existsSync` trả `false`) thành `NOT_FOUND`; lỗi
    đọc/parse của một file **có tồn tại** giữ nguyên mã của `readJson` (`IO_ERROR`, hoặc `CONFIG_INVALID` khi
    sai schema). Trước đó mọi `IO_ERROR` bị đổi thành `NOT_FOUND`, nên một mount rớt giữa chừng trông hệt như
    "request chưa từng tồn tại" và `library-stage` biến nó thành contract failure vĩnh viễn thay vì retry.
    Giới hạn còn lại: **đường đọc chưa kiểm root còn mount** (chỉ đường ghi có `assertRootMounted`), nên root
    rớt hẳn vẫn làm `existsSync` trả `false` → `NOT_FOUND` → contract failure; việc thêm kiểm root cho
    `readRequest`/`readItem`/`readStyle` ghi ở `docs/operations/deferred-items.md`.
63. `ContentRequestSchema.count` ghim `z.literal(1)`: `intake` claim một request đúng một lần và item đầu tiên
    `fulfillRequest` đóng nó, nên một request `count > 1` sẽ kẹt `claimed` vĩnh viễn (không có cơ chế
    re-claim). CLI `library request create --count` chỉ nhận `1` (khác đi là `CONFIG_INVALID`). Phép so
    `item_ids.length >= count` vẫn giữ trong `fulfillRequest` cho ngày mở lại giới hạn này.
64. `applyReview` ghi hai file (manifest item, rồi request) mà kho không có transaction, nên: (a) transition
    của request được **kiểm trước** khi ghi item (request phải `claimed` để `fulfill`, `claimed`/`rejected` để
    `reopen`) — request không nhận được thì item vẫn `pending_review`, không có nửa vời; (b) ghi item trước,
    request sau, và nếu bước request ném lỗi thì lỗi mang `details.item_written: true` cùng cả hai id; (c)
    chạy lại cùng một quyết định là **idempotent**: item đã mang đúng `status` thì trả về nguyên trạng, và nếu
    nửa request chưa kịp áp (vẫn `claimed` bởi đúng `lineage.run_id` của item) thì áp nốt lúc đó — tức
    `harness library review <item_id> --approve|--reject` là cách hồi phục một lần ghi dở.
65. `ContentItem.library_channel_id` (mới): `claimItem` ghi cùng `library_item_id` và tra cứu claim cũ theo
    **cả hai**. Hai channel cùng `pick` một item của kho là hai `ContentItem` riêng; trước đó nhánh idempotent
    tra theo `library_item_id` một mình nên channel thứ hai có thể nhận lại `ContentItem` của channel thứ
    nhất (và `plan` một run phát hành trên content của kênh khác).
66. `syncLibrary` chỉ hash lại file dữ liệu của item **mới hoặc đã đổi** (`classify` chạy trước `verifyFile`);
    `syncLibrary(d, { verify: true })` / `harness library sync --verify` ép kiểm toàn bộ. Worker (sync định kỳ
    mỗi `sync_seconds`) dùng đường rẻ — nếu không, mỗi lần rảnh việc là một lần đọc lại toàn bộ kho qua
    mount. Đổi lại: một file dữ liệu bị sửa **sau** khi item đã import chỉ lộ ra ở lần `--verify`.
67. `harness library withdraw <item_id> [--note]` (vai `studio`) nối CLI vào `withdrawItem` —
    `approved|rejected → withdrawn`, trạng thái kho dùng thay cho xoá. Trước đó `withdrawn` chỉ đến được bằng
    cách sửa tay `manifest.json`, dù `claimItem` và `library pick` đều kiểm nó.
68. `doctor` ghi file thử tên `.doctor-<role>-<uuid>.tmp` (dot-name, không bao giờ `.json`) và
    `listRequestIds`/`listStyleIds`/`listItemIds` bỏ qua mọi tên bắt đầu bằng `.`: một file thử sót lại
    (doctor chết giữa chừng) trước đây là `requests/.doctor-channel-<uuid>.json` và bị `listRequestIds` đọc
    như một request thật rồi báo `corrupt`.
69. `exportItem` ghi `manifest.json` **trước** rồi mới `pruneStaleFiles`: giữa hai bước, một máy khác đang
    `library sync` chỉ thấy manifest liệt kê đúng những file còn trên đĩa. Thứ tự ngược lại tạo một khe trong
    đó manifest cũ bảo chứng cho file vừa bị xoá — đúng định nghĩa `corrupt` của sync.

## Sub-project 3 (2026-09-14/15)

Phát hành kênh: máy `channel` lấy một `LibraryItem` đã `approved` (qua `library pick` có sẵn của 2C), đóng
gói theo hướng SEO của kênh (agent, skill `channel-package`), rồi đưa lên YouTube bằng cách bọc lại script
Playwright cũ của kênh (`upload-youtube-playwright.mjs`, `publish-video-playwright.mjs`) — không dùng YouTube
Data API. Cộng một dashboard chỉ đọc, dựng từ file `snapshot.json`. Đọc code (`packages/core/src/
distribution/`, `packages/adapters/{youtube-playwright,agent-cli}/`, `packages/cli/src/commands/{channel,
publish,publish-stage,dashboard}.ts`, `migrations/0004_distribution.sql`) để xác nhận hành vi, không chép từ
plan/spec.

70. `publication_job` là **`TransitionKind` thứ sáu** (`run | stage_run | attempt | artifact |
    external_operation | publication_job`, `packages/contracts/src/interfaces.ts`) — cột `state` của nó chỉ
    đổi qua `transitionPublication()` (bọc `store.transition("publication_job", ...)`), giống mọi bảng
    transition khác, **khác** ba bảng mirror của kho (mục 51). Ngược lại, `channel_package.status` (`draft |
    committed`) **là mirror-style**: `commitPackage` ghi thẳng qua `store.updateChannelPackage`, không qua
    `transition()` — gói không có máy trạng thái riêng, chỉ có hai giá trị tuần tự không thể lùi.
71. `ChannelPackage.channel_config_revision` là **sha256 canonical của `channel.yaml`** (`checksumSchema`),
    không phải số nguyên tăng dần như bản nháp đầu của schema — khác trường cùng tên trên
    `Artifact.reproducibility.channel_config_revision` (`z.number().int().nullable()`, không liên quan, giữ
    nguyên từ trước). Đổi từ int sang checksum ngay ở Task 3 vì spec §2.3 nói rõ "sha256 canonical".
72. Bốn stage built-in của `channel-publish` (`fetch-library-item`, `build-package`, `upload`, `schedule`)
    chạy qua CLI con giống khuôn 2C (mục 52): mỗi script `publish-<tên>` trong composition chỉ là
    `harness --project <dir> publish stage <tên>` (`builtinPublishCommands`,
    `packages/cli/src/composition.ts`), đăng ký vào cùng `ScriptExecutor` với các script kho — một ops
    project vai `channel` không cần `executors/scripts.yaml` cho bốn stage này. Stage `package` (thứ hai) là
    executor `agent`, không đi qua CLI con.
73. Cổng `Publisher` (`packages/contracts`) có hai implementation: `PlaywrightPublisher`
    (`@harness/adapter-youtube-playwright`) bọc hai script Playwright cũ bằng `spawn`, đọc kết quả qua exit
    code + `publish-queue.json`; `FakePublisher` (`@harness/adapter-fake`) cho test. **Exit-code-primary**:
    kết quả `uploaded` chỉ được trả khi script thoát **0 và** `publish-queue.json` có dòng khớp — thoát khác 0
    luôn là `unknown` **kể cả khi** dòng queue đã có mặt (kịch bản script chết sau khi tạo video nhưng trước
    khi thoát sạch) — một điểm dừng để người kiểm tra qua `publish reconcile` thay vì tự tin nhận video đó
    (ledger Task 5, giải quyết một mâu thuẫn trong brief giữa "có dòng queue là uploaded bất kể exit code" và
    test "lost mode" đòi `unknown`).
74. `idempotency_key = sha256(channel_id + ":" + video_checksum + ":" + manifest_digest)`
    (`idempotencyKeyFor`, `packages/core/src/distribution/publication.ts`) — khác kênh hoặc khác nội dung
    (checksum/manifest đổi) luôn ra khoá khác, nên hai kênh cùng phát một mục kho không bao giờ đụng khoá
    của nhau (mục "Lineage" spec §2.7).
75. Stage `upload` ghi `ExternalOperation` **`DISPATCHED` trước khi gọi `Publisher.upload()`** (có thể mất
    tới 45 phút), không phải sau: một crash giữa chừng luôn để lại op ở `DISPATCHED` (không bao giờ kẹt
    `INTENT_RECORDED`), để nhánh phục hồi `UPLOADING` của attempt kế tiếp (`recoverUploading`,
    `packages/cli/src/commands/publish-stage.ts`) phân biệt được ba tình huống theo **trạng thái thật của
    op**: `CONFIRMED` (video đã tạo, chỉ ghi lại output, không upload lại) → job `PROCESSING`; `FAILED`
    (chưa hề upload) → job về `READY`, attempt này upload lại ngay, không chờ retry mới; còn lại
    (`INTENT_RECORDED`/`DISPATCHED`/đã `NEEDS_RECONCILIATION`/hàng op mất) → coi như `unknown` sống,
    `markLost` rồi job/op `NEEDS_RECONCILIATION`. (ledger Task 8, sửa ở fix round 1-2: bản đầu chỉ biết
    "job đang UPLOADING" mà không phân theo trạng thái op, có thể kẹt hoặc upload đúp.)
76. `harness publish reconcile <job>` (và `harness reconcile --publication <job>`, hai đường gọi cùng
    `reconcilePublication`) luôn **hỏi provider trước** (`Publisher.lookup`) rồi mới cho phép một lần upload
    lại — tìm thấy video → job/op xác nhận theo §2.6 (không có video thứ hai, acceptance 21); không tìm
    thấy → op `FAILED`, job `READY`, và **đây là lần duy nhất** attempt `upload` kế tiếp được phép gọi lại
    `Publisher.upload()` cho cùng job (acceptance 26) — không có đường nào khác trong toàn bộ pipeline cho
    upload lặp lại một khi op đã `CONFIRMED`.
77. `@harness/adapter-agent-cli`'s `CliAgentRuntime`: prompt được ghi ra **file** (`agent-prompt.md` trong
    workspace, không qua argv/stdin) rồi child CLI (`claude -p …` hay `codex exec …`, bảng lệnh
    `RUNTIME_COMMANDS`) được trỏ đọc file đó qua `PROMPT_POINTER`; env con chỉ có `env_passthrough` của
    runtime (`ANTHROPIC_API_KEY`/`CLAUDE_CONFIG_DIR` hay `OPENAI_API_KEY`/`CODEX_HOME`, cộng
    `FAKE_AGENT_MODE` — **chỉ để test**, không dùng ở production) cộng vài biến `HARNESS_*` cố định
    (`HARNESS_WORKSPACE`, …); **không bao giờ** `HARNESS_SECRET_*`, kể cả khi vô tình có mặt trong
    `env_passthrough` — lọc theo tiền tố, không theo danh sách trắng (acceptance 25).
78. Dashboard (`packages/dashboard`) **chỉ đọc**: `src/server.ts` dùng mỗi `node:http`/`node:fs`/`node:path`
    (không dependency ngoài), phục vụ `GET /hub` (và `/`), `GET /api/snapshot` (nội dung
    `<data_root>/dashboard/snapshot.json`, `Cache-Control: no-store`, 404 `{ error: "no snapshot" }` nếu
    chưa có), `GET /thumbnails/<file>`; **mọi method khác 405**, mọi route khác 404. Không `POST`, không ghi
    gì cả — snapshot là ảnh chụp do `harness dashboard snapshot`/worker sinh, không phải state hai chiều như
    tài liệu bàn giao hệ thống cũ. `buildSnapshot` cô lập theo kênh: một kênh cấu hình sai không kéo sập
    snapshot của kênh khác (fix round 1 Task 10).
79. `ChannelConfigSchema` cũ (nếu từng tồn tại trước sub-project 3) bị thay hẳn bằng bản mới ở spec §1.3 —
    chưa ai dùng bản cũ (không ops project thật nào phát hành trước SP3), nên đây là thay thế, không phải
    migration dữ liệu. Secret ref của kênh dùng đúng khuôn hai đoạn của `secretRefSchema` hiện có
    (`^secret://[a-z0-9-]+/[a-z0-9-]+$`, `packages/contracts/src/common.ts`): `secret://youtube-<channel_id>/
    email`, không phải ví dụ ba đoạn `secret://youtube/<channel>/email` từng xuất hiện trong bản nháp đầu
    của spec §1.3 — env tương ứng là `HARNESS_SECRET_YOUTUBE_<CHANNEL_ID upper, "-"→"_">_EMAIL`
    (`EnvSecretResolver.envName`, ledger Task 11).
80. Redactor của tiến trình `harness publish stage upload|schedule` chỉ che giá trị secret **chính tiến
    trình đó** đã resolve (`EnvSecretResolver.resolvedValues()`) — `channel-identity` (chạy trong tiến trình
    `build-package`) resolve `account_email_ref` không giúp gì cho hai stage sau, chạy trong hai tiến trình
    CLI con khác. Hai stage `uploadStage`/`scheduleStage` (`packages/cli/src/commands/publish-stage.ts`) vì
    vậy tự gọi `app.secrets.resolve(channel.config.youtube.account_email_ref)` ngay trước khi gọi
    `Publisher`, bọc try/catch (secret không resolve được không được làm fail stage này — `channel-identity`
    đã báo lỗi đó ở `build-package`) — chỉ để đăng ký giá trị với Redactor, không log/lưu giá trị. Không có
    lời gọi này, dòng cổng tài khoản mà script cũ tự in (`[upload] account <email>`) sẽ lọt nguyên văn vào
    `log_tail`/receipt của `PublicationJob`/`ExternalOperation` (Task 12, phát hiện ở review cuối Task 11).
    Test: `packages/cli/test/publish-stage.test.ts` ("redacts the channel's account email from stdout, the
    stage result, and the stored receipt", `describe("upload", ...)`) — xác nhận fail (email lộ nguyên văn)
    khi bỏ lời gọi này, pass khi có.

## Sub-project 4 (2026-09-15)

Studio tự vận hành: năm gate của kho (`analyze-style`, `style-review`, `survey-source`, `plan-edit`,
`library-review`) thành stage `agent` với năm skill mới; harness tự "xem" video cho agent bằng stage built-in
`watch`; worker studio tự nhận request kho, tự `plan`, tự plan lại khi review từ chối. Đọc code
(`packages/core/src/{media/watch,library/auto-accept,orchestration/registry}.ts`,
`packages/cli/src/commands/media.ts`, `packages/contracts/src/{library,media}.ts`, `workflows/{style-study,
library-production}@1.1.0/`, `skills/{style-analyze,style-review,source-survey,edit-plan,library-review}/`)
để xác nhận hành vi, không chép từ plan/spec.

81. Workflow nhiều version cùng thư mục `workflows/`: `workflowDir(harnessRoot, id, version)` dùng
    `workflows/<id>@<version>/workflow.yaml` nếu thư mục đó tồn tại, ngược lại rơi về `workflows/<id>/`
    (dạng cũ, không version trong tên thư mục) — `loadWorkflow` vẫn kiểm `parsed.data.version === version`
    sau khi đọc dù đi đường nào. `listWorkflowRefs` (`packages/core/src/orchestration/registry.ts`) quét cả
    hai dạng thư mục để liệt kê ref cho `harness doctor`: một thư mục không có `workflow.yaml` bị bỏ qua hẳn;
    một `workflow.yaml` sinh `id`/`version` được (kể cả khi tên thư mục không có `@`) luôn được ghi theo
    đúng `id@version` đọc từ file; một `workflow.yaml` hỏng cú pháp/thiếu trường chỉ còn được liệt kê nếu
    tên thư mục *đã* theo khuôn `<id>@<version>` (nguồn ref đáng tin duy nhất còn lại) — thư mục cũ dạng
    `<id>/` không version trong tên mà file hỏng thì bị bỏ qua hoàn toàn khỏi danh sách quét, không ném lỗi.
    `harness doctor` (`computeDoctorRows`, `packages/cli/src/composition.ts`) ghi một dòng
    `workflow:<ref>` FAIL riêng cho ref nào `loadWorkflow` không nạp được, không làm chết lệnh `doctor`.
82. Stage `watch` là **built-in trong CLI**, không phải wrapper ops project phải cung cấp, vì lý do khác với
    bốn stage kho built-in của 2C (ADR mục 52): (a) cần `ffmpeg`/`ffprobe` — một phụ thuộc hệ thống harness
    đã biết cách phát hiện qua `@harness/adapter-ffprobe`, một wrapper riêng sẽ phải tự dò lại; (b) hợp đồng
    ảnh đưa cho agent (contact sheet 4×4 + khung đơn 640px, nhãn thời gian) phải cố định giữa ba mode
    (`samples`/`source`/`episode`) để năm skill đọc được theo cùng một khuôn — để một wrapper ops project tự
    triển khai sẽ phá tính nhất quán đó. `harness media watch --mode <m>` (`packages/cli/src/commands/
    media.ts`) đăng ký ba lệnh script built-in `watch-samples`/`watch-source`/`watch-episode`
    (`builtinMediaCommands`, cùng khuôn `builtinLibraryCommands`) mà `executor: { type: script, script:
    "watch-<mode>" }` của hai workflow 1.1.0 gọi — không cần entry nào trong `executors/scripts.yaml` của ops
    project cho ba stage này. Hook `transcribe` (tuỳ chọn, `scripts.yaml.transcribe`) là con đường **duy nhất**
    lấy transcript: không khai → `watch.json` ghi `transcript: null` cho mọi video, không lỗi.
83. Năm gate người của kho (2C) trở thành năm stage `executor: { type: agent, skill: <tên> }` trong hai
    workflow `@1.1.0`, thay cho `executor: { type: gate }` của `@1.0.0` (bản 1.0.0 giữ nguyên, hai bản chạy
    song song — mục 84 dưới). Hợp đồng chung cho cả năm agent (spec §2.3): chỉ đọc `brief.md`,
    `stage-request.json`, input theo `inputs[].path`; ghi `output/<name>` đúng `expected_outputs`; đọc ảnh
    bằng công cụ `Read` của agent, không phải một API riêng của harness; `retry: { max_attempts: 2,
    backoff_seconds: [60], retry_on: [transient, abandoned] }` trên cả năm stage — **không có `contract`**
    trong `retry_on`, nên một agent không ghi output/JSON sai schema (lỗi `contract`, xem mục 88) đỗ thẳng
    `WAITING_HUMAN` sau đúng **một** attempt, không phải hai. Runtime vẫn `@harness/adapter-agent-cli` y hệt
    sub-project 3 (`claude -p`/`codex exec` headless, prompt qua file `agent-prompt.md`).
84. `reviewSchema` (`packages/contracts/src/library.ts`, `harness.review/v1`): `{ decision, note, checks:
    ReviewCheck[] }` với `checks` mặc định `[]` khi vắng mặt — một `review.json` cũ từ trước sub-project 4
    (chỉ có `decision`/`note`, không có `checks`) vẫn parse được nguyên vẹn qua schema mới; `library-
    apply-review` (built-in stage) và `harness library review` (CLI) đều đi qua schema này nên tương thích cả
    hai đường ghi kết quả duyệt. Stage agent `library-review` ghi `checks[]` theo bảng kiểm cố định sáu mục
    (spec §4) — checker không đọc nội dung `checks[]`, chỉ `schema-valid`; ý nghĩa "đạt hay không" vẫn nằm ở
    `decision`.
85. `libraryBriefSchema` thêm trường tuỳ chọn `request_notes?: string` (`z.string().optional()` — vắng mặt,
    không phải `null`) — stage `intake` (built-in, đã
    có từ 2C) giờ chép thêm `request.notes` (kho) vào `brief.json.request_notes` mỗi lần chạy, để stage agent
    `plan-edit` đọc được lý do từ chối của lần review trước (nếu request đã bị `library-apply-review` mở lại
    qua `reopenRequest`, ghi nối `notes`) và sửa theo trong `edit-plan.json.notes` — đường phản hồi giữa vòng
    review-từ-chối và lần plan lại, không cần người chuyển tay.
86. `autoAccept(d)` (`packages/core/src/library/auto-accept.ts`), gọi từ worker studio ở nhánh idle sau
    `maybeSyncLibrary` khi `library.auto_accept.enabled`: một request được nhận và tạo run trong **một
    `store.transaction`** (`createContent` + `plan` + `enqueue`, sự kiện `request.auto_accepted`) — không có
    khe nào giữa "đã tạo `ContentItem`" và "đã enqueue run" mà một auto-accept khác cùng lúc có thể đọc thấy
    và nhận trùng request. `intake` (không phải `autoAccept`) vẫn là nơi duy nhất request chuyển `open →
    claimed` (giữ nguyên từ 2C, mục 53) — `autoAccept` chỉ tạo run rồi để `intake` của chính run đó claim khi
    worker dispatch tới. Hai cơ chế chống trùng: (a) `isTerminal("run", state)` (`packages/core/src/state/
    transitions.ts`) đếm số run đã **kết thúc** của một request (`finishedRunCounts`) thay vì so sánh hai bảng
    danh sách trạng thái riêng — một trạng thái run mới thêm sau này tự động được phân loại đúng miễn
    `isTerminal` cập nhật theo (mục 91 dưới ghi caveat của hàm này); (b) sự kiện `request.auto_accept_skipped
    { reason: "no source" }` dedupe bằng `listEvents({ event_type: "request.auto_accept_skipped", newest: true
    })` lọc theo `request_id`+`reason` trước khi ghi thêm — request không có source hợp lệ chỉ sinh một sự
    kiện mỗi lý do, không log mỗi vòng poll. Sự kiện riêng `request.auto_accept_exhausted { request_id,
    finished_runs, max_replans }` (spec §5.4, mục 87) đi cùng khuôn dedupe đó trên `event_type` của chính nó.
87. `max_replans` (`library.auto_accept.max_replans`, mặc định 2) đếm theo **số run đã kết thúc** của một
    request (`finishedRunCounts`, mục 86), không phải số lần "từ chối": vòng đầu chấp nhận request là
    `replan_no: 0`; mỗi lần `library-apply-review` mở lại request (`rejected → open`) và `autoAccept` thấy lại
    `open`, nó tạo run mới với `replan_no` = số run kết thúc hiện tại, cho tới khi số đó vượt `max_replans` —
    tức tối đa `max_replans + 1` run cho một request trước khi event `request.auto_accept_exhausted` và
    dashboard alert `request_stuck` (mục 90). `profile` dùng để `plan()` trong `autoAccept` là hardcode
    `"studio"` ở lớp nối dây CLI (`packages/cli/src/commands/worker.ts`) — brief cho phép hardcode này; một
    project studio khác tên profile phải đổi trực tiếp trong code, chưa có trường cấu hình
    (`library.auto_accept.profile_id`) cho việc đó.
88. Một agent-stage thất bại **không được retry**: cả năm skill khai `retry_on: [transient, abandoned]` (mục
    83) — lỗi "agent không ghi `output/<name>`" hay "JSON sai schema" là `kind: "contract"`
    (`CliAgentRuntime.runTask`), và `controller.ts`'s `classifyFailure`/`scheduleRetry` không bao giờ retry một
    `contract` failure bất kể `max_attempts` khai bao nhiêu. Stage đỗ `WAITING_HUMAN` sau **đúng một
    attempt**. Đây là điểm tài liệu spec §7 (`docs/superpowers/specs/2026-09-15-sub-project-4-studio-
    autopilot-design.md`, mô tả acceptance 29 là "FAILED sau 2 attempt") viết sai so với hành vi thật của
    code — runbook (`docs/runbooks/studio-autopilot.md` mục 5) và AGENTS.md ghi đúng "một attempt", không sửa
    lại spec. Trong lúc stage đỗ, request giữ nguyên `claimed` (run chưa kết thúc) nên `autoAccept` không tạo
    run thứ hai cho cùng request — acceptance 29 xác nhận.
89. `RUNTIME_COMMANDS[runtime].env_passthrough` (`@harness/adapter-agent-cli`,
    `packages/adapters/agent-cli/src/cli-agent-runtime.ts`) giờ gồm cả các biến `FAKE_AGENT_MODE`,
    `FAKE_REVIEW_MODE`, `FAKE_AGENT_FAIL_STAGE`, `FAKE_STYLE_STATUS`, `FAKE_STYLE_REVIEW` (`FAKE_AGENT_TEST_ENV`)
    bên cạnh `ANTHROPIC_API_KEY`/`CLAUDE_CONFIG_DIR` (`claude`) hay `OPENAI_API_KEY`/`CODEX_HOME` (`codex`) —
    cần thiết để test tích hợp chạy `fake-agent-cli.mjs` **qua đúng đường runtime thật**
    (`CliAgentRuntime.runTask` spawn CLI theo `RUNTIME_COMMANDS`) thay vì gọi thẳng fixture, nhưng nghĩa là
    năm biến này lọt vào env con của **cả `claude`/`codex` thật** nếu chúng vô tình được set trong shell chạy
    `harness worker` trên máy studio thật — vô hại trong production (bản thân `claude`/`codex` không đọc các
    biến đó), khác `HARNESS_SECRET_*` (luôn bị lọc theo tiền tố tên biến bất kể có trong `env_passthrough`
    hay không, ADR mục 77) nên đây là hai lớp lọc khác nhau cho hai mục đích khác nhau. Đây là biến **chỉ
    dùng cho test**, không có tác dụng gì với CLI agent thật; AGENTS.md ghi rõ quy tắc "không dựa vào các
    biến `FAKE_*` khi vận hành production".
90. `library-production@1.1.0`'s stage `plan-edit` thêm `index-source` vào `depends_on` (bên cạnh
    `survey-source`, `watch-source`, `intake` mà spec §3.2 liệt kê ban đầu) —
    `workflows/library-production@1.1.0/workflow.yaml` — vì skill `edit-plan` cần đọc trực tiếp `shots.json`
    (output của `index-source`), không chỉ `survey.json`/`survey.md` phái sinh từ nó; thiếu dependency đó thì
    input `shots` không được vật liệu hoá vào workspace của `plan-edit`. Sửa ngay trong review (ledger Task 8,
    commit `854057a`) theo quy tắc "lỗi rõ ràng trong code của plan thì sửa ngay", không phải đánh đổi thiết
    kế cần hỏi.
91. Hai điểm sai trong nội dung skill, ghi nhận là lỗi tài liệu đã biết (chưa sửa tại thời điểm Task 9 commit
    — xem `docs/operations/deferred-items.md` mục "Sau sub-project 4"): `skills/style-analyze/SKILL.md` (dòng
    "`style_id`/`created_at`/`updated_at` để trống hợp lý nếu môi trường không có generator — harness sẽ điền
    lại nếu thiếu") và `skills/channel-package/SKILL.md` (dòng tương tự cho `hypothesis_id`/`created_at`) đều
    **sai** — `editStyleSchema`/`packageMetadataSchema` (hay tương đương) đòi các trường này là chuỗi khớp
    định dạng, không có giá trị mặc định nào được harness điền lại; một agent thật để trống các trường đó sẽ
    fail checker `schema-valid` ngay. `skills/style-review/SKILL.md` claim "skill này không có quyền
    `WebSearch`/`WebFetch`" cũng sai — `allowedTools` của runtime agent (spec §2.3: `style-analyze` được thêm
    `WebSearch`/`WebFetch` để xác nhận kênh mẫu) là cấu hình **toàn cục** của agent-cli cho cả phiên, không
    theo từng skill; `style-review` không tự chặn được các tool đó bằng nội dung SKILL.md của chính nó.
92. Spec §8 DoD #3 (`docs/superpowers/specs/2026-09-15-sub-project-4-studio-autopilot-design.md`) đếm sai số
    stage agent: câu "Bốn stage agent của `library-production@1.1.0` chạy với agent-cli thật ít nhất một
    tập" gộp lẫn hai workflow. `library-production@1.1.0` có **ba** stage agent (`survey-source`, `plan-edit`,
    `library-review`); `style-study@1.1.0` có thêm **hai** (`analyze-style`, `style-review`) — tổng **năm**
    trên hai workflow, không phải bốn trên một. Cùng lớp lỗi tài liệu với mục 88 (spec viết "2 attempt" cho
    một lỗi `contract` không bao giờ retry); runbook (`docs/runbooks/studio-autopilot.md` mục 9) và README
    ghi đúng số, không sửa lại câu chữ của spec.

## Sub-project 3B (2026-09-16)

93. `video_metrics` (migration `0005_learning.sql`) là bảng **append-only**: mỗi lần `collectStats`/`channel
    metrics import` ghi thêm một hàng mới (`metric_id` riêng), không bao giờ `UPDATE` một ảnh chụp cũ, kể cả
    khi cùng một `publication_job_id` được thu lại nhiều lần theo `learning.recollect_hours`. `collectDue`
    (`packages/core/src/learning/metrics.ts`) tự loại các mốc đã có ảnh chụp `source: "studio"` với
    `age_hours ≥ mốc − 6` thay vì dựa vào bất kỳ cờ "đã thu" nào trên chính hàng đó — lịch sử đầy đủ của một
    video luôn nằm nguyên trong bảng, không phần nào bị ghi đè, kể cả khi `channel metrics import` thêm một
    hàng `source: "manual"` xen giữa các ảnh chụp `studio` thật. Đọc ngược lại lịch sử đó, `snapshotAtHorizon`
    (`packages/core/src/learning/hypotheses.ts`) chọn ảnh chụp có `age_hours` **gần mốc nhất trong cửa sổ
    `[mốc − 12, mốc + 24]`** — với mốc mặc định 72 h đúng bằng "gần 72 nhất trong `[60, 96]`" của spec §2.2.
    Cửa sổ có **cận trên** là điểm mấu chốt (sửa ở review cuối 3B): quy tắc cũ "ảnh chụp đầu tiên đạt mốc"
    khiến một video bị chặn thu ở 72 h bị chấm bằng chính ảnh chụp 168 h của nó — lượt xem cả tuần đọ với
    mục tiêu 72 h, sai cả ở phán quyết lẫn ở `medians` mà mọi `lift` khác đem ra so. Không có ảnh chụp nào
    trong cửa sổ = mốc đó **chưa từng được đo**: `evaluateHypotheses` để giả thuyết nguyên `open`, và
    `learnChannelStandard` loại job đó khỏi `medians` (thay vì mượn tạm một con số khác).
94. `hypothesis.status`/`hypothesis.evaluated` (trường mới optional trong `HypothesisSchema`, spec §3.1) cập
    nhật **tại chỗ** trong `channel_package.data` (cột JSON) qua `updateChannelPackage`, không qua
    `transition()` — cùng khuôn "mirror-kiểu" với ba bảng mirror của kho (`edit_style`/`content_request`/
    `library_item`, AGENTS.md mục "Giới hạn quyền") và với `ChannelPackage.status` (ADR mục 70): trường thay
    đổi phản ánh một kết quả tính toán ngoài băng (`evaluateHypotheses` đọc `video_metrics`), không phải một
    bước trong máy trạng thái stage/run/attempt của chính gói đó. Một gói `committed` "thay đổi sau khi
    publish" chỉ ở đúng trường `hypothesis` — `manifest`/checksum của gói không bị đụng (spec §10 rủi ro).
95. `learnChannelStandard` (`packages/core/src/learning/learned.ts`) là **hàm thuần, test được**, không phải
    agent quyết định (phương án A đã chọn, spec §0, loại phương án B "một agent quyết định tất cả"): nhóm
    tiêu đề dùng đúng ba nhãn nhị phân cố định kết hợp bằng `+` — `titlePattern()` trả
    `${number|plain}+${question|statement}+${long|short}` (có chữ số hay không; kết thúc `?` hay không; dài
    hơn 60 ký tự hay không, ví dụ `number+question+short`) — và `overlayGroup()` trả số dòng chữ đè
    (`"0"`/`"1-2"`/`"3"`). Một nhóm thành `standard` khi `supported ≥ min_samples`, `lift > 1` (trung bình
    `metric_value` chia trung vị kênh của cùng metric) và `supported > refuted`; không nhóm nào đạt →
    `standard.note` ghi rõ số mẫu còn thiếu thay vì để trống im lặng. Trung vị lấy tại `horizon_hours` **của
    chính kênh** (không phải 72 h cố định — sửa ở review cuối 3B: một kênh đặt `horizon_hours: 48` thu số ở
    ~48 h nên với mốc cứng 72 h không ảnh chụp nào lọt, mọi trung vị `null`, mọi `lift` bằng 0, kênh đó không
    bao giờ học được gì mà cũng không báo lỗi); tên trường `medians.views_72h` giữ nguyên vì nằm trong shape
    đã lưu `harness.channel-learned/v1` và nay đọc là "views tại mốc của kênh".
    **Chỉ số đọc không ra là `void`, không phải `refuted` 0** (sửa ở review cuối 3B): `evaluateHypotheses`
    trả `void` bất cứ khi nào `metricValue` cho `null` — `ctr` mà `ctr_pct` null dù `impressions` đã vượt
    `min_impressions`, `avg_view_pct` mà `avg_view_sec` null hoặc thời lượng null/≤ 0 — bên cạnh điều kiện
    `void` sẵn có cho `ctr` dưới sàn `min_impressions`. Trước đó `(null ?? 0) >= target` biến một ô Studio
    không vẽ ra thành một phán quyết `refuted` với `metric_value: 0`, kéo trung bình nhóm (và qua đó cả chuẩn
    kênh) xuống bằng một con số chưa ai từng đo. `views_72h` không bao giờ `null` nên không đổi gì.
96. **Ngưỡng đổi chuẩn 10%**: `decideDimension` (`packages/core/src/learning/learned.ts`) chỉ thay một giá
    trị `standard` đang đứng khi nhóm mới có `lift ≥ lift cũ × 1.10` — một nhóm nhỉnh hơn chút không đủ lật
    chuẩn (chống nhiễu mẫu nhỏ, spec §10 "chuẩn kênh học từ mẫu nhỏ"). Hệ quả trực tiếp: **một chuẩn không
    bao giờ hình thành chỉ từ hai tập** dù cả hai `supported` cùng nhóm — trung vị của đúng hai mẫu là trung
    bình của chính chúng nên `lift` của nhóm đó luôn đúng bằng 1.0, không bao giờ `> 1`; cần ít nhất một mẫu
    khác (kể cả `refuted`, nhóm khác) để kéo trung vị kênh lệch đi. Đây không phải lỗi thiết kế — brief Task 7
    ban đầu mô tả một chuẩn hình thành sau hai tập là **sai** so với luật đã spec (số học ở trên), sửa lại ở
    test tích hợp (`tests/integration/channel-learning.test.ts`) bằng một tập thứ ba, góc khác và yếu hơn,
    thay vì sửa luật để khớp brief.
97. Stage built-in `channel-brief` (`packages/cli/src/commands/publish-stage.ts`, chạy trong cả
    `channel-publish@1.1.0` trước `package` lẫn `channel-planning@1.0.0`) vá đúng lỗ hổng spec 3 để lại (spec
    3 §10, spec 3B §0 "kiến trúc"): stage `package` của `channel-publish@1.0.0` chưa từng nhận `seo` của kênh
    hay bất kỳ số liệu/chuẩn/giả thuyết đã đánh giá nào làm input có cấu trúc — skill `channel-package` chỉ
    đọc thẳng `channel.yaml`/`stage-request.json`. `channel-brief.json` (`harness.channel-brief/v1`) gộp cả
    bốn nguồn đó (`channel.seo`, `learned: ChannelLearned | null`, tối đa 10 giả thuyết đã đánh giá gần nhất,
    tối đa 10 ảnh chụp số liệu gần nhất, request đang mở của kênh) thành một input duy nhất, có schema, cho cả
    hai workflow — `channel-publish@1.0.0` giữ nguyên không có stage này (chạy song song, acceptance 40).
98. `maybePlanRequests`/`planRequestsRun` (`packages/core/src/learning/planning.ts`) đối xử **planning như
    một run bình thường**, đúng nguyên tắc "mọi việc agent làm đều là run" (spec §0): không có nhánh tắt nào
    gọi thẳng agent ngoài vòng workflow/checker/artifact như ba sweep kia. Planning bị giới hạn **tối đa một
    run mỗi kênh mỗi ngày UTC**: `content.title` của run mang tiền tố `"planning <channel_id> "` cộng ngày
    UTC hiện tại, và `run-active` chặn bất kỳ run `channel-planning` nào cùng tiền tố còn sống, hoặc đã kết
    thúc **trong đúng ngày hôm nay** — một run FAILED thì vào cooldown 24h riêng qua event
    `channel.planning_failed` (`recentlyEmitted`, không tính theo ranh giới ngày UTC, khác cơ chế trên).
99. `autoPick` (`packages/core/src/learning/auto-pick.ts`, spec §4.4) ưu tiên rõ ràng: (a) item `approved`
    gắn `request_id` của một request do **chính kênh này** tạo (sắp theo `created_at` request, cũ trước) —
    trước khi cân nhắc (b) item chung không có `request_id`, và (b) chỉ được xét khi `demand.needed +
    demand.covered.items > 0`, tức còn ít nhất một khung phát chưa được job/run/request che phủ — cố ý
    **không** tính chính các item chung vào phần "đã che phủ" ở phép so này, vì `channelDemand` vẫn gộp
    chúng vào `covered.items` như đã che phủ trên giấy; nếu gate chỉ so `needed > 0` một item chung tồn tại
    sẵn sẽ tự kéo `needed` về 0 rồi vĩnh viễn tự chặn chính nó khỏi được pick. Item đã có run `channel-publish`
    `FAILED`/`WAITING_HUMAN` của chính kênh này bị loại khỏi ứng viên — tránh auto-pick lặp lại một item vừa thất bại
    vô hạn lần; một claim rollback (transaction pick+plan+enqueue thất bại) xoá luôn file claim vừa ghi, không
    để lại claim mồ côi (sửa ở review Task 4, xem ledger).
100. **Cổng học không chặn** (spec §0 "cổng học: không chặn, chỉ ưu tiên", đối lập tường minh với
    `lib/learning-gate.mjs` của hệ cũ — bị loại hẳn, không mang sang): thu số bị Studio chặn (`stats_blocked`)
    hay lỗi liên tiếp (`stats_failing`) không bao giờ dừng `channel-publish`/`channel-planning`; một kênh chưa
    học được gì (`ChannelLearned.standard` rỗng, `channel-brief.json.learned: null`) vẫn phát đều theo
    `channel.yaml.seo` y hệt trước sub-project 3B. `learned.standard` chỉ **ưu tiên** đề xuất kế tiếp (agent
    `channel-plan` đọc `learned.standard.angle`; skill `channel-package` dẫn chứng `basis` kind `"channel"`
    khi có) — không trường nào trong toàn bộ đường ống 3B coi việc chưa học xong là điều kiện chặn dispatch.
101. **Adapter thật không nghe biến môi trường test, và tự khai ngân sách thời gian của mình** (cả hai sửa ở
    review cuối 3B). (a) `HARNESS_FAKE_STATS_FILE` chỉ đi tới `FakeStatsCollector`: composition root
    (`packages/cli/src/composition.ts`) truyền nó cho nhánh `adapters.stats: fake` và **không** truyền gì cho
    `PlaywrightStatsCollector`, còn chính collector đó không đọc `process.env` nữa (chỉ nhận `statsFile`
    truyền tay trong test). Một biến còn sót trong shell của người vận hành từng đủ để biến một lượt thu số
    thật thành đọc file JSON, rồi ghi lại như ảnh chụp `source: "studio"` — số bịa lẫn vào chính bảng
    append-only mà mục 93 nói là lịch sử đầy đủ của kênh. Quy tắc chung: chọn adapter là việc của
    `project.yaml.adapters.*`, không bao giờ của một biến môi trường. (b) Ngân sách thời gian thu số khai đúng
    **một** chỗ: `COLLECT_STATS_TIMEOUT_SECONDS = 300` trong `packages/adapters/youtube-playwright/src/
    playwright-stats-collector.ts` vừa là timeout `spawnSync`, vừa là `StatsCollector.timeout_seconds` mà
    `collectStats` truyền ngược lại vào `collect()` (collector nào không khai thì sweep dùng
    `DEFAULT_COLLECT_TIMEOUT_SECONDS = 120`). `scripts/collect-stats.mjs` tự chặn worst case của nó dưới mức
    đó bằng ba hằng số có phép tính ghi ở đầu file (`LABEL_WAIT_MS` 45 s × 4 + `NAV_TIMEOUT_MS` 15 s × 5 +
    launch 20 s = 275 s < 300 s). Trước đó sweep cắt ở 120 s trong khi script có thể chạy tới ~240 s, nên một
    widget Studio chậm bị báo là "collect script timed out" và ba lần như thế dựng một alert `stats_failing`
    hoàn toàn giả.
102. **Engine media là tiến trình con trao đổi file JSON, không phải thư viện và không phải service**
    (sub-project 5A §1.2). `packages/core` không bao giờ `import` torch/whisperx/omnivoice — nó chỉ thấy
    interface `MediaEngine`; `PythonMediaEngine` (`packages/adapters/media-python`) ghi
    `engine-job-<uuid>.json` vào workspace, `spawn` (bất đồng bộ, **không** `spawnSync`: một stage GPU chạy
    nhiều phút sẽ chặn cả event loop lẫn heartbeat của worker) `python transcribe.py|tts.py --job … --result …`,
    rồi đọc `engine-result-<uuid>.json` và xoá cả hai. **Exit code luôn 0**: mọi thất bại đi qua file result
    dưới dạng `{ ok: false, kind: "contract" | "transient", reason }` — `contract` cho lỗi đầu vào mà retry
    không bao giờ cứu được (thiếu `ref_audio`, gói không import được, `cuda:*` trên máy không có CUDA),
    `transient` cho phần còn lại. Exit code khác 0, timeout, hay file result thiếu/hỏng đều bị phía TypeScript
    quy về `transient` — tiến trình tự nó hỏng chứ không báo cáo được một thất bại sạch. Không có dịch vụ
    Python thường trú (spec §9) nên mỗi stage trả giá một lần nạp mô hình; đo thật trên RTX 3060 là ~12 s cho
    OmniVoice và ~4 s cho whisper large-v3 + VAD, tức với buổi quay ngắn thì **nạp mô hình chi phối tổng thời
    gian, không phải tính toán** (`docs/runbooks/studio-media.md` mục 7).
103. **`adapters.media: python | fake` là khoá duy nhất chọn engine**, đọc **chỉ** ở composition root
    (`packages/cli/src/composition.ts`, `mediaEngineOptions()`) — đúng quy tắc mục 101(a) đã đặt cho
    `adapters.stats`: chọn adapter là việc của `project.yaml`, không bao giờ của một biến môi trường. Mặc định
    `fake` để mọi test SP1–4 và CI không GPU chạy nguyên trạng. Env của tiến trình Python con là một **danh
    sách trắng** (`PATH`, `SystemRoot`, `TEMP`, `TMP`, `CUDA_*`, `HF_HOME`, `HF_HUB_OFFLINE`, `PYTHONUTF8=1`),
    không phải bộ lọc theo tiền tố như `publisherChildEnv` — một script tính toán thuần không cần môi trường
    người dùng đầy đủ, nên chặn mặc định rẻ hơn lọc mặc định; `HARNESS_SECRET_*` không bao giờ lọt qua và
    stderr đi qua `Redactor` (giữ 2000 ký tự cuối).
104. **Buổi quay = một collection, và có đúng HAI chế độ chọn nguồn, phân biệt tường minh bằng
    `library.auto_accept.source_collections`.** Không khai khoá đó → chế độ cũ của sub-project 4 nguyên vẹn
    (một request một source, bận theo từng source). Khai rồi → chế độ collection: một request lấy cả
    collection khớp glob, giới hạn bởi `max_sources` (mặc định 40), và một collection đã được một run thành
    công dùng thì đánh dấu **đã dùng** nên request khác không lấy lại — có miễn trừ cho chính request đó khi
    replan, nếu không thì vòng loại→replan của SP4 chết ngay trong chế độ 5A (run bị `library-review` loại vẫn
    kết thúc SUCCEEDED, nên collection của nó thành "đã dùng" và request mở lại không bao giờ chọn được nó
    nữa). `AutoAcceptDeps.sources` là union phân biệt `{ mode: "legacy" | "collections" }` chứ không phải một
    nhánh `if` rải rác, và nhánh legacy đã được kiểm là byte-equivalent với bản trước 5A.
105. **Giọng đọc thuộc kênh, `origin` là bắt buộc, và harness không xác minh được nó.** Hồ sơ giọng
    (`VoiceProfile`) sống trong `voices/` của kho; vai `channel` ghi, vai `studio` chỉ đọc — cùng ranh giới
    quyền ghi mà `LibraryFs.assertWritable` đã áp cho `styles/`, `items/`, `requests/`. `library voices add`
    kiểm clip mẫu (3–30 s) và chuyển sang PCM mono 24 kHz trước khi chạm kho; `origin: synthetic | own |
    licensed` bắt buộc. Harness **chỉ ghi lại lời khai** — không có cách nào kiểm chứng một clip có phải giọng
    người thật hay không (spec §10), nên trách nhiệm thuộc người tạo hồ sơ và runbook nói thẳng điều đó.
    `--voice tts` thiếu `--voice-id` (hay trỏ hồ sơ `retired`) bị từ chối **lúc tạo request**, nhưng khi chính
    kênh tự sinh request thì `create-requests` **hạ xuống `voice: none` kèm ghi chú** thay vì làm hỏng stage —
    một kênh chưa có giọng vẫn phải sản xuất được.
106. **`media-fit-edl` không bao giờ fail vì thiếu hình.** Nó ghi `fit-report.json` (mỗi dòng một `action`
    thuộc `FIT_ACTIONS` — `kept|trimmed|extended|appended|reused|snapped|dropped`,
    `packages/contracts/src/media-engine.ts` — cộng `shortfalls[]`) rồi để agent `library-review` quyết định
    loại hay không, và vòng replan của SP4 xử lý phần còn lại. Đây là hệ quả trực tiếp của nguyên tắc "không
    cổng người" (spec §0): một stage fail vì dữ liệu không vừa ý sẽ dựng đúng cái cổng người mà sub-project 4
    vừa gỡ bỏ. Hằng số khớp hình cố định trong mã (vào trước 0.3 s, ra sau 0.4 s, hít cắt ±0.4 s, khe tối
    thiểu 0.15 s, tay cầm 0.08 s, bỏ đoạn < 0.2 s, dự phòng 0.5 s) chứ không cấu hình được — chúng là quy ước
    dựng phim, không phải tham số vận hành.
107. **`timeline.json` là hợp đồng cho sub-project 5B**, không phải một file gỡ lỗi: `video[]` (thứ tự,
    source, in/out, start/end trên trục thời gian), `narration[]` (dòng lời, wav, vị trí, `words[]`),
    `speech[]` (câu gốc giữ lại khi `voice: original`), `total_seconds`. Chữ trên hình, phụ đề, nhạc + ducking
    và chuyển cảnh của 5B đều cần **mốc từ** trên một trục thời gian đã chốt; sinh lại chúng từ `edl.json` +
    `narration-timing.json` ở 5B sẽ là tính lại đúng phép tính mà `fitEdl` vừa làm, với rủi ro lệch.
108. **Cache TTS băm theo nội dung, không theo run.** `ttsCacheKey` (`packages/core/src/media/tts.ts`) băm
    sha256 của đúng chín trường: `text`, `voice_checksum`, `params` (tức `speed` + `num_step` của hồ sơ
    giọng), `model`, `language`, `dtype`, `max_chars`, `pause_seconds`, `loudness_lufs`. Bốn trường cuối là
    sửa ở review Task 5: thiếu chúng, đổi `dtype` hay `loudness_lufs` trong `project.yaml` sẽ lặng lẽ tái
    dùng wav cũ đọc bằng cấu hình cũ. `voice_checksum` là checksum của chính `ref.wav`
    (`profile.ref_audio.checksum`), nên bump hồ sơ giọng bằng một clip mẫu khác tự làm mất hiệu lực cache của
    giọng đó; bump mà **chỉ** sửa `ref_text` trên đúng clip cũ thì không — ghi ở deferred. Nhờ đó vòng replan
    chỉ đọc lại **dòng đã
    sửa** (`narration-timing.json` ghi `cached: true` cho phần còn lại; đo thật: `media-tts` 33.4 s → 0.4 s).
    `harness artifacts sweep` **chưa** biết tới `<data_root>/cache/tts` — ghi ở deferred, không sửa trong 5A.
109. **Hai loại artifact khảo sát, và `survey_index` mới là file JSON.** Stage `survey-source` ghi cả
    `survey.md` (type `survey`, cho người đọc) lẫn `survey.json` (type `survey_index`, `harness.survey-index/v2`,
    cho `media-fit-edl` và checker `survey-valid` đọc). Nhầm hai type này là lỗi Critical của Task 8: cả
    `media-fit-edl` lẫn checker đều đi đọc `survey.md` và mọi run 1.2.0 thật sẽ fail.
110. **`audio-integrity` miễn trừ đúng một trường hợp: "silent by brief".** Khi `brief.voice` là `none` **và**
    không nguồn nào trong `shots.json` có luồng audio, tập dựng ra là một đoạn `anullsrc` gần như im lặng hoàn
    toàn (tỉ lệ lặng ~0.997) và checker `max_silence_ratio: 0.9` của profile studio làm run **FAILED** — không
    phải một bản duyệt bị loại, nên vòng replan của SP4 không bao giờ thấy nó và request kẹt ở `claimed` chờ
    người, đúng cái cổng người bị cấm. Sửa ở **checker**, ghi `evidence: { reason: "silent by brief" }`, chứ
    tuyệt đối không nới `max_silence_ratio` — nới ngưỡng sẽ làm mù cả những tập đáng lẽ phải bị bắt.
111. **`library.auto_accept.workflow_release` là nút lùi có tài liệu, và là cách test giữ nguyên release của
    mình.** Nó ghim vòng autopilot vào một release cụ thể thay vì đi theo `workflow_release` của profile
    studio; không khai = đi theo profile. Nhờ đó (a) người vận hành lùi về `library-production@1.1.0` mà không
    phải sửa profile, và (b) mọi test autopilot của sub-project 4 vẫn chạy trên 1.1.0 trong khi profile đã
    tiến lên 1.2.0. Đi kèm là dòng doctor `media:engine`, chỉ xuất hiện khi release **hiệu lực** của autopilot
    từ `library-production@1.2.0` trở lên mà `adapters.media` vẫn `fake`: chạy được, nhưng sinh ra transcript
    và giọng giữ chỗ — đúng cái bẫy mà dòng đó tồn tại để bắt **trước** một run nhiều giờ.
112. **Phép dò engine media không được nằm trên đường nóng của dashboard.** `MediaEngine.probe()` spawn một
    tiến trình Python; `buildSnapshot` chạy mỗi ~60 s từ worker, nên bản dò được memo hoá (TTL 900 s,
    `packages/cli/src/media-probe-cache.ts`) cho đường snapshot, còn `harness doctor` gõ tay thì luôn dò mới.
    Phép dò cũng **bỏ qua khi đang có lease GPU** — dò lúc đó sẽ xếp hàng sau một stage dài nhiều phút. Đổi
    lại: một engine hỏng có thể không bị phát hiện chừng nào GPU còn bận liên tục (ghi ở deferred). Bốn dòng
    `media:python|packages|device|engine` dựng **duy nhất** alert `media_engine_unavailable`, không dựng thêm
    alert doctor chung — một sự cố một alert; `media:models` cố ý đứng ngoài nhóm đó vì "chưa tải mô hình" là
    cảnh báo, không phải hỏng.
113. **Lần chạy thật đầu tiên (task 11, RTX 3060 12 GB) chốt ba điều spec §10 để ngỏ.** (a) **Một venv là đủ**:
    torch 2.8.0+cu126 cài trước, rồi `requirements.txt` không hề đụng tới torch, và `import whisperx` lẫn
    `import omnivoice` cùng sống trong `E:\harness-venv` — phương án hai venv (`media.transcribe.python` /
    `media.tts.python`) vẫn còn nguyên trong schema như đường lùi, chưa cần dùng. (b) **Tiếng Việt của
    OmniVoice dùng được**: mẫu sinh bằng **chính `engines/python/tts.py`** (đúng payload job mà
    `PythonMediaEngine.synthesize()` ghi ra — xem mục 115 về vì sao phải là đường đó), nghe ngược bằng
    WhisperX cho **WER 3.1 % / CER 1.9 %** (từ sai duy nhất là `sào`→`xảo`, một cặp `s`/`x` giọng Nam không
    phân biệt), tốc độ đọc **16.47 ký tự/giây** ngang với **15.52** của tiếng Anh (tiếng Anh: WER 0 % /
    CER 0 %), và mô hình căn chỉnh tiếng Việt khớp được **từng từ** (32/32) vào audio sinh ra — `en` và `vi`
    đều là ngôn ngữ được hỗ trợ, không có gì phải đẩy sang deferred. Số đo đầy đủ ở
    `docs/runbooks/studio-media.md` mục 9. (c) **VRAM đỉnh 4047–4083 MiB (~4.1 GB)** trên cả bốn run, thấp
    hơn nhiều so với 12 GB của card, vì `transcribe.py`/`tts.py` đều
    giải phóng mô hình chính (`del` + `torch.cuda.empty_cache()`) trước khi nạp mô hình căn chỉnh.
114. **torch ≥ 2.6 và checkpoint VAD của WhisperX: allow-list, không phải `weights_only=False`.** Defect duy
    nhất mà lần chạy thật lộ ra: `whisperx.load_model` (mặc định `vad_method="pyannote"`) unpickle
    `whisperx/assets/pytorch_model.bin` qua `torch.load`, mà torch 2.6 đã đổi mặc định `weights_only` thành
    `True` — mọi lần transcribe chết với `UnpicklingError: Weights only load failed ... Unsupported global`,
    báo về harness là `transient` nên bị retry vô ích. `transcribe.py::allow_vad_checkpoint_globals()`
    allow-list đúng những lớp checkpoint đó gọi tên (node cấu hình omegaconf, `TorchVersion`,
    `Introspection`/`Specifications` của pyannote, `typing.Any` và vài builtin) thay vì tắt `weights_only`:
    phần còn lại của file vẫn không được phép unpickle mã tuỳ ý. Hàm là best-effort (phiên bản whisperx/
    pyannote khác chỉ góp ít mục hơn, máy không có torch trả về danh sách rỗng thay vì ném) — nhờ đó test hồi
    quy chạy được **không cần GPU và không cần trọng số**.
115. **Ngôn ngữ của job phải tới được cả hai mô hình.** `tts.py` mang `job.language` tới
    `whisperx.load_align_model` nhưng **không** tới `OmniVoice.generate` — mà hàm đó nhận `language` và tài
    liệu của chính nó nói đọc tốt hơn khi được cho biết ngôn ngữ. Phát hiện lúc dựng bằng chứng DoD #3 ở
    task 11: mẫu tiếng Việt đang được đo bằng một đường gọi **khác** đường harness thật chạy, nên con số đo
    được không nói về mã đã ship. Truyền thẳng giá trị của job xuống là đủ và không tạo chế độ lỗi mới:
    `_resolve_language` của OmniVoice cảnh báo rồi lùi về chế độ không phụ thuộc ngôn ngữ với giá trị lạ —
    đúng hành vi cũ — và `en`/`vi` đều là mã hợp lệ. Nguyên tắc rút ra: bằng chứng cho một DoD phải đi qua
    đúng mã sẽ được ship, không phải một lời gọi thư viện viết riêng cho phép đo.
116. **Harness này không dành cho nội dung hoạt hình.** Phạm vi của nó là sản xuất từ **footage nguồn có
    thật**: đăng ký nguồn, bóc cảnh, nghe nguồn, dựng theo EDL, khớp hình theo lời, xuất kho, phát hành.
    Không có stage nào sinh hình vẽ, không có adapter nào gọi dịch vụ dựng hoạt hình hay avatar, và
    sub-project 5A không thêm gì theo hướng đó (spec 5A §0). Hai cái tên còn sót lại **không** phải bằng
    chứng ngược lại: `profile_id` vẫn là enum có `cartoon` và `avatar`
    (`packages/contracts/src/config.ts`, `entities.ts`) từ mục 7 — đặt tên profile theo phong cách sản xuất
    — và `production-profiles/cartoon` vẫn tồn tại, nhưng nó ghim
    `workflow_release: sample-three-stage@1.0.0`, tức **workflow demo của sub-project 1**, không phải một
    đường ống hoạt hình; `avatar` thì chỉ có trong enum, không có thư mục profile nào cả. Đổi tên hai id đó
    là refactor cơ học (enum + thư mục profile + fixture + vài test đếm), không đổi hành vi, và **chưa được
    yêu cầu** — để lại nguyên trạng, ghi ở `docs/operations/deferred-items.md` mục "Sau sub-project 5A".
