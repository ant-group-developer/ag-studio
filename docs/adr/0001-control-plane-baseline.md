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
42. `harness source sync` đối chiếu `source-catalog/sources.yaml` với DB, trả `SyncReport { added,
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
