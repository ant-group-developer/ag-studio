# YouTube Operations Harness: cấu trúc tổng thể và control plane tối thiểu

**Ngày:** 2026-09-11
**Trạng thái:** Đã duyệt thiết kế qua brainstorming, chờ implementation plan
**Tài liệu gốc:** `docs/architecture/YOUTUBE_OPERATIONS_HARNESS_BLUEPRINT_v1.0.md` (blueprint tham chiếu v1.0)

Spec này gồm hai phần. Phần A chốt cấu trúc tổng thể của harness và cách tách sub-project. Phần B là thiết kế chi tiết cho sub-project 1: control plane tối thiểu (giai đoạn 0 + 1 của blueprint). Các sub-project sau có spec riêng.

---

## 0. Bối cảnh và quyết định đã chốt

### 0.1 Hệ thống đang chạy

Ở các máy khác đang có một hệ thống sản xuất theo mô hình phiên Claude Code tương tác: mỗi kênh là một repo có `channel.config.json`, pipeline S01→S09 bằng script Node `.mjs` (gen-tts, gen-anim, assemble-episode, gen-thumb-qc, build-upload-manifest), Remotion, ffmpeg, Chatterbox TTS, HeyGen, Codex sinh ảnh, Pexels. Máy này không có hệ thống đó. Harness được xây mới trên máy này.

### 0.2 Quyết định từ brainstorming

| Chủ đề | Quyết định |
|---|---|
| Quan hệ với hệ thống cũ | Xây harness mới làm lớp điều phối. Script sản xuất cũ được bọc thành executor/adapter, không viết lại. |
| Stack | TypeScript, Node 20+, pnpm workspace. Zod cho contract, xuất JSON Schema. SQLite WAL qua `better-sqlite3`. Vitest. |
| Agent runtime | Trung lập. Mỗi operations project khai báo runtime (`claude` hoặc `codex`) trong `project.yaml`. Harness có adapter cho cả hai. |
| Nghĩa của source và profile | Source = kho video/transcript/tài liệu thô. Profile = phong cách sản xuất: `cartoon`, `avatar`, `footage`. Không dùng tên `direction-a/b/c` trong code. |
| Topology máy | Mỗi máy độc lập, có state store và runtime data riêng. Kênh gán cố định cho máy. Repository interface cho phép đổi sang store chung sau. |
| Cấu trúc repo | Monorepo pnpm cho harness. Operations project là repo riêng theo máy, ghim harness release. |
| Sub-project đầu tiên | Control plane tối thiểu với adapter giả. Chưa nối script thật, chưa nối YouTube. |

---

## Phần A: Cấu trúc tổng thể

### A.1 Ba vùng trên mỗi máy

| Vùng | Đường dẫn ví dụ | Git | Vai trò |
|---|---|---|---|
| Harness | `E:\YOUTUBE_OPERATIONS_HARNESS` | Repo này | Mã lõi, contract, workflow, profile, skill, template. Phát hành theo release. |
| Operations project | `E:\youtube-content-operations` | Repo riêng theo máy | Cấu hình kênh, lịch, policy, source catalog, `template.lock.yaml` ghim harness release. Cấu trúc theo blueprint mục 5. |
| Runtime data | `E:\youtube-operations-data` | Không | SQLite state, workspace, artifact, publication receipt, log, incident, archive. Cấu trúc theo blueprint mục 5. |

Đường dẫn cụ thể của hai vùng sau nằm trong `project.yaml` và biến môi trường `HARNESS_DATA_ROOT`, không hard-code.

### A.2 Cây monorepo harness

```text
YOUTUBE_OPERATIONS_HARNESS/
├── AGENTS.md                      # nguyên tắc cho mọi agent; CLAUDE.md chỉ chứa một dòng trỏ sang AGENTS.md
├── README.md
├── package.json  pnpm-workspace.yaml  tsconfig.base.json  vitest.workspace.ts
├── packages/
│   ├── contracts/                 # @harness/contracts: Zod schema, type, error, interface. Không phụ thuộc package nào khác.
│   ├── core/                      # @harness/core, modular monolith với các module:
│   │   └── src/ state/ orchestration/ artifacts/ policy/ verification/ observability/
│   │            config/ environment/ source-catalog/ production/ distribution/ channels/ context/
│   ├── executors/                 # @harness/executors: script, agent, media-job
│   ├── adapters/
│   │   ├── fake/                  # @harness/adapter-fake: adapter giả cho test và sub-project 1
│   │   ├── legacy-scripts/        # bọc script .mjs cũ qua child process (sub-project 2)
│   │   ├── youtube/  tts-chatterbox/  heygen/  remotion/  image-codex/  pexels/   (sub-project 2, 3)
│   ├── agent-runtime/
│   │   ├── claude/                # Claude Agent SDK (sub-project 4)
│   │   └── codex/                 # Codex SDK (sub-project 4)
│   ├── worker/                    # @harness/worker: vòng lặp claim → execute → verify → commit
│   └── cli/                       # @harness/cli: binary `harness`; composition root nối adapter theo config
├── workflows/                     # định nghĩa workflow yaml có version + digest
├── production-profiles/           # cartoon/  avatar/  footage/
├── project-template/              # skeleton sinh operations project
├── skills/                        # nguồn duy nhất; `harness skills sync` sinh .claude/skills và .agents/skills
├── migrations/                    # SQL migration cho SQLite, đánh số tăng
├── releases/                      # release manifest, compatibility matrix
├── fixtures/                      # dữ liệu test nhỏ
├── tests/
│   ├── integration/               # SQLite thật trên file tạm
│   └── acceptance/                # mỗi test map một mục blueprint 18.3
├── evals/                         # eval chất lượng nội dung (sub-project 2 trở đi)
└── docs/
    ├── architecture/              # blueprint + sơ đồ
    ├── adr/                       # quyết định kiến trúc
    ├── runbooks/
    └── superpowers/specs/         # spec như file này
```

Chỉ tạo thư mục khi có file thực. Cây trên là đích, không phải yêu cầu tạo rỗng ngay.

### A.3 Quy tắc dependency giữa package

Ép bằng `dependencies` trong `package.json` và một lint rule boundary. Mũi tên là "được phụ thuộc vào".

```text
contracts  <- core  <- executors <- worker <- cli
contracts  <- adapters/*  (adapter chỉ phụ thuộc contracts, không phụ thuộc core)
contracts  <- agent-runtime/*
core       không import adapters/* hay agent-runtime/*; chỉ nhận qua interface tại composition root (cli, worker)
```

Quy tắc bổ sung từ blueprint 4.2: `verification` chỉ tạo `CheckResult`, không sửa artifact. `observability` nhận event đã redaction, không quyết định trạng thái. Không module nào đọc thư mục module khác để suy đoán trạng thái.

### A.4 Skill viết một lần

Thư mục `skills/<skill-name>/SKILL.md` là nguồn. Lệnh `harness skills sync --project <path>` đọc `runtime` trong `project.yaml` của operations project và sinh `.claude/skills/` hoặc `.agents/skills/` tương ứng, hoặc cả hai. Skill mô tả cách làm; state và transaction vẫn thuộc harness.

### A.5 Tách sub-project

| # | Sub-project | Phạm vi | Đạt khi |
|---|---|---|---|
| 1 | Control plane tối thiểu | Phần B của spec này | Hai worker cạnh tranh không trùng, resume sau crash, CLI end-to-end với adapter giả |
| 2 | Source catalog + fan-out profile + bọc script cũ | source-catalog, production, profile cartoon/avatar/footage, adapter legacy-scripts, tts, remotion, image, pexels | Một source ra ba variant đã kiểm chứng, lineage độc lập |
| 3 | Distribution và publishing | channels, distribution, channel package, adapter youtube, upload idempotent, reconcile; test e2e secret redaction khi executor thực sự dùng `secret://` (sub-project 1 chỉ chứng minh theo cấu trúc) | Publish đúng kênh, retry sau lỗi mạng không tạo video thứ hai |
| 4 | Agent runtime và scheduled operations | agent-runtime claude/codex, skill sync, scheduled run, human gate, alert | Scheduled run mới chạy từ state, không cần lịch sử chat |
| 5 | Release, template, governance | releases, project-template đầy đủ, canary, rollback, migration report | Nâng template cho canary rồi rollback không mất state |

Mỗi sub-project có spec và implementation plan riêng. Không bắt đầu sub-project sau khi acceptance test của sub-project trước chưa pass.

---

## Phần B: Sub-project 1, control plane tối thiểu

### B.1 Mục tiêu

Xây phần mọi thứ khác đứng lên: contract, state store, state machine, claim/lease/fencing, artifact manifest, worker loop, executor với adapter giả, CLI. Kết thúc khi các acceptance test trong B.13 pass.

Sub-project 1 cũng khởi tạo monorepo, `AGENTS.md`, một workflow mẫu và một `project-template/` tối thiểu để CLI có cái chạy.

### B.2 Ngoài phạm vi sub-project 1

- Không gọi script sản xuất thật, không gọi LLM, TTS, YouTube.
- Không có adapter Claude/Codex thật, chỉ `FakeAgentRuntime`.
- Không có dashboard, chỉ log JSON ra stdout và bảng `event`.
- Không có scheduler theo lịch, chỉ worker chạy tay.
- Không có source catalog thật, chỉ `SourceItem` giả trong fixture.

### B.3 Contract

Giai đoạn 0 khóa schema Zod cho toàn bộ 18 entity trong blueprint mục 6, kể cả entity chưa có bảng: `Project`, `Portfolio`, `Channel`, `SourceItem`, `ContentItem`, `ProductionProfile`, `ContentVariant`, `DistributionPlan`, `ChannelPackage`, `PublicationJob`, `WorkflowRelease`, `Run`, `StageRun`, `Attempt`, `Artifact`, `ExternalOperation`, `CheckResult`, `Incident`. Thêm `Event` và `Lease`.

Contract thực thi theo blueprint mục 7: `StageRequest`, `StageResult`, `ArtifactManifest`. Contract cấu hình: `WorkflowDefinition`, `ProductionProfile`, `ChannelConfig`, `ProjectConfig`, `HarnessConfig`.

Quy ước:

- ID = tiền tố + ULID: `run_`, `stage_`, `attempt_`, `artifact_`, `op_` (ExternalOperation), `check_`, `evt_`, `src_`, `content_`, `variant_`, `pkg_`, `pub_`, `inc_`.
- Checksum `sha256:<hex thường>`. Timestamp ISO 8601 UTC có hậu tố `Z`. Revision số nguyên tăng từ 1.
- Mọi schema có `schema_version` dạng `harness.<tên>/v1`. Mọi object schema dùng `.strict()`.
- JSON Schema được sinh từ Zod vào `packages/contracts/schemas/*.json` bằng script build, có test so khớp để không lệch.

Package `contracts` cũng chứa interface: `StateStore`, `Executor`, `AgentRuntime`, `Checker`, `SecretResolver`, `Clock`, `IdGenerator`. Lỗi có mã: `HarnessError` với `code` thuộc một enum đóng.

### B.4 State store

SQLite một file tại `<data-root>/state/harness.db`, chế độ WAL, `busy_timeout` 5 giây. Migration là file SQL đánh số trong `migrations/`, áp dụng bằng `harness db migrate`, ghi bảng `schema_migrations`.

Bảng trong sub-project 1: `run`, `stage_run`, `attempt`, `lease`, `artifact`, `external_operation`, `check_result`, `event`, `schema_migrations`. Bảng cho entity khác thêm ở sub-project tương ứng.

Interface `StateStore` trong `contracts` che SQLite. Implementation `SqliteStateStore` trong `core/state`. Mọi thao tác nhiều bước đi qua `store.transaction(fn)`.

Hàm `transition(entityKind, id, expectedFrom, to, event)`:

1. Kiểm tra cặp `(from, to)` trong bảng transition hợp lệ của entity. Cặp không hợp lệ ném `HarnessError{code: INVALID_TRANSITION}`.
2. `UPDATE ... SET state = to WHERE id = ? AND state = expectedFrom`. Số hàng bằng 0 nghĩa là trạng thái đã đổi bởi người khác, ném `STALE_STATE`.
3. Chèn `event` với đủ correlation field.
4. Cả ba bước trong một transaction.

Không module nào `UPDATE state` ngoài hàm này.

### B.5 State machine

Run, StageRun, Artifact, Publication theo nguyên văn blueprint mục 9. Bổ sung:

```text
Attempt:
  CLAIMED -> RUNNING -> SUCCEEDED | FAILED | CANCELLED
  CLAIMED | RUNNING -> ABANDONED          (lease hết hạn)

ExternalOperation:
  INTENT_RECORDED -> DISPATCHED -> CONFIRMED | FAILED
  DISPATCHED -> NEEDS_RECONCILIATION -> CONFIRMED | FAILED | DISPATCHED (retry sau reconcile)
```

Mỗi bảng transition được khai báo dữ liệu trong `core/state/transitions.ts`. Test liệt kê đủ cặp hợp lệ và một bộ cặp cấm tiêu biểu cho từng entity.

### B.6 Claim, lease, fencing, heartbeat

- Bảng `lease`: `stage_run_id` (khóa chính), `attempt_id`, `owner`, `expires_at`, `fencing_token`. `fencing_token` là số nguyên tăng dần theo từng `stage_run_id`, lấy bằng `MAX(fencing_token) + 1` trên lịch sử attempt của stage đó trong cùng transaction.
- Claim: trong một transaction, chọn một `stage_run` có `state = 'READY'`, capability cần thiết nằm trong capability worker khai báo, sắp xếp theo `ready_at`; `UPDATE stage_run SET state='CLAIMED' WHERE id=? AND state='READY'`; nếu 0 hàng thì thử hàng kế; tạo `attempt` và `lease`. Trả về `Attempt` kèm `fencing_token`.
- Heartbeat: `UPDATE lease SET expires_at=? WHERE attempt_id=? AND fencing_token=?`. 0 hàng nghĩa là lease đã mất, worker phải dừng.
- Commit kết quả: mọi hàm ghi kết quả (`commitSucceeded`, `commitFailed`, `registerArtifact`) nhận `fencing_token` và kiểm `lease.fencing_token = ?`. Sai thì ném `FENCING_REJECTED` và không ghi gì.
- Quét lease hết: `harness leases reap` và worker loop tự gọi trước mỗi lần claim. Lease có `expires_at < now` chuyển Attempt sang `ABANDONED`, StageRun về `READY` nếu `attempt_count < max_attempts`, ngược lại `FAILED`.
- Lease mặc định 90 giây, heartbeat mỗi 30 giây. Cấu hình trong `harness.yaml`.

### B.7 Planner, worker, executor, verifier

**Planner** (`core/orchestration`):

- Đọc workflow yaml, xác thực bằng `WorkflowDefinition`. Workflow có `id`, `version`, danh sách `stages` với `key`, `executor`, `depends_on`, `required_capabilities`, `required_checks`, `retry`.
- Tính digest workflow bằng sha256 của canonical JSON.
- Hợp nhất config theo blueprint 13.1: system defaults → workflow defaults → profile overrides → channel overrides → run overrides → policy constraints. Key lạ fail. Kết quả là `effective_config_snapshot` lưu JSON kèm digest trong `run`.
- Tạo `run` ở `DRAFT` và một `stage_run` ở `PENDING` cho mỗi stage. `harness enqueue` chuyển run sang `READY` và stage không có dependency sang `READY`.
- Sau khi một stage `SUCCEEDED`, planner kiểm tra stage phụ thuộc và chuyển sang `READY` khi mọi dependency đã `SUCCEEDED`. Khi mọi stage kết thúc, run sang `SUCCEEDED` hoặc `FAILED`.

**Worker loop** (`packages/worker`):

```text
loop:
  reap lease hết hạn
  claim một stage hợp capability (không có thì ngủ theo poll interval rồi lặp)
  tạo workspace <data-root>/workspaces/<run>/<stage>/<attempt>/
  dựng StageRequest, ghi stage-request.json
  bật heartbeat định kỳ
  result = executor.execute(request)
  checks = verifier.verify(request, result)
  controller.commit(attempt, result, checks, fencing_token)
  tắt heartbeat
```

Worker nhận cờ `--once` để chạy đúng một stage rồi thoát, phục vụ test và scheduled run. Worker bắt SIGINT/SIGTERM để chuyển Attempt sang `CANCELLED` trước khi thoát.

**Executor** (`packages/executors`): interface `execute(request: StageRequest, ctx): Promise<StageResult>`.

- `script`: chạy lệnh khai báo trong stage definition bằng child process với cwd là workspace. Script đọc `stage-request.json`, ghi `output/` và `stage-result.json`. Executor đọc file result, xác thực schema. Timeout theo `limits.deadline_at`.
- `agent`: gọi `AgentRuntime.runTask({ skill, brief, workspace, limits })`. Sub-project 1 chỉ có `FakeAgentRuntime`.
- `media-job`: hoãn sang sub-project 2.

**Verifier** (`core/verification`): registry `Checker` theo `check_id`. Sub-project 1 có ba checker: `schema-valid` (result đúng schema), `output-exists` (mọi output khai báo tồn tại trong workspace), `checksum-match` (sha256 file bằng checksum khai báo). Verifier trả danh sách `CheckResult`, không sửa gì.

**Controller commit** (`core/orchestration`): chỉ `SUCCEEDED` khi result đúng schema, mọi `required_checks` pass, fencing token hợp lệ, và artifact được ghi nguyên tử: copy hoặc move output vào `<data-root>/artifacts/<content>/<variant>/<artifact>/`, ghi `manifest.json`, chèn hàng `artifact` với `status = ACCEPTED` trong cùng transaction với transition StageRun. Trường hợp khác là `FAILED`, artifact nếu có ở `REJECTED`.

### B.8 Workspace và giao tiếp file

```text
<data-root>/workspaces/<run_id>/<stage_key>/<attempt_id>/
├── stage-request.json
├── input/            # artifact ACCEPTED của stage upstream, copy hoặc hardlink
├── output/           # nơi executor ghi
├── stage-result.json
└── logs/
```

Đây là cầu nối duy nhất giữa harness và script bên ngoài. Sub-project 2 bọc script `.mjs` cũ bằng cách viết một wrapper đọc request và ghi result vào đúng chỗ, không đụng core.

Workspace của attempt kết thúc giữ lại theo `retention.workspace_days` trong `harness.yaml`, mặc định 7 ngày. Lệnh `harness workspaces prune` dọn.

### B.9 Xử lý lỗi

| Loại | Ví dụ | Hành vi |
|---|---|---|
| Tạm thời | timeout, process chết, disk bận | Attempt `FAILED`, StageRun về `READY` theo retry policy có backoff mũ, attempt và workspace mới |
| Kết quả | checksum sai, check bắt buộc fail, output thiếu | Attempt `FAILED`, artifact `REJECTED`, đếm retry riêng (`result_failures`) |
| Hợp đồng | StageResult sai schema, fencing token cũ | Từ chối commit, Event cảnh báo, StageRun sang `WAITING_HUMAN`, không retry tự động |
| Không rõ | external operation mất kết nối sau dispatch | ExternalOperation `NEEDS_RECONCILIATION`, StageRun `NEEDS_RECONCILIATION`; `harness reconcile` hỏi adapter trước khi cho retry |
| Crash worker | lease hết | Attempt `ABANDONED`, StageRun `READY`, cùng đường với lỗi tạm thời |

Retry policy khai báo trong stage definition: `max_attempts`, `backoff_seconds`, `retry_on` (danh sách loại lỗi). Mặc định `max_attempts = 3`, `backoff_seconds = [10, 60, 300]`, `retry_on = [transient, abandoned]`.

Adapter giả có cờ mô phỏng: `fail_transient_times`, `write_bad_checksum`, `lose_connection_after_dispatch`, `sleep_ms`. Cờ đặt qua config của stage trong workflow fixture.

### B.10 CLI

Binary `harness`, package `cli`, dùng `commander`. Lệnh sub-project 1:

```text
harness db migrate
harness plan   --workflow <id@version> --profile <id> --source <src_id> [--override k=v]   → in run_id
harness enqueue <run_id>
harness worker [--once] [--capabilities a,b] [--owner name]
harness status <run_id> [--json]
harness retry  <run_id> [--stage key]
harness cancel <run_id>
harness reconcile <run_id|op_id>
harness leases reap
harness workspaces prune
harness events tail [--run run_id]
```

Composition root nằm ở `cli/src/composition.ts`: đọc `harness.yaml` và `project.yaml`, chọn `StateStore`, `Executor`, `AgentRuntime`, `SecretResolver`, `Checker` theo config. Sub-project 1 chỉ có lựa chọn `fake` cho executor script và agent runtime.

Output người đọc là bảng text; `--json` cho máy đọc. Exit code khác 0 khi lỗi.

### B.11 Config và secret

- `configs/harness.yaml` trong harness: defaults hệ thống, lease, heartbeat, retention, poll interval.
- `project.yaml` trong operations project: `project_id`, `template_release`, `runtime` (`claude` | `codex`), `data_root`, danh sách portfolio.
- Sub-project 1 tạo `project-template/project.yaml` tối thiểu và một fixture operations project trong `fixtures/ops-project-minimal/`.
- Secret chỉ ở dạng `secret://<scope>/<name>`. `EnvSecretResolver` đọc biến môi trường `HARNESS_SECRET_<SCOPE>_<NAME>`. Không có giá trị secret nào vào snapshot, event, log, manifest. Bộ redaction trong `observability` che mọi chuỗi trùng giá trị đã resolve trước khi persist.

### B.12 Observability tối thiểu

- Bảng `event` append-only, mỗi hàng có đủ trường blueprint mục 15: `event_id, occurred_at, run_id, stage_run_id, attempt_id, project_id, portfolio_id, channel_id, content_id, variant_id, workflow_release, severity, event_type, payload`.
- Log JSON một dòng ra **stderr** (stdout dành cho output máy đọc của CLI), đã qua redaction. Logger tự viết, không dùng `pino` (quyết định khi triển khai).
- `usage` trong `StageResult` (wall_seconds, cost_usd) được cộng vào `run.total_cost_usd` khi commit.

### B.13 Kiểm thử

Ba tầng, chạy bằng Vitest, xác định, không mạng, không LLM.

1. **Unit** trong từng package: schema round-trip và JSON Schema khớp; bảng transition hợp lệ và cấm; config precedence và unknown-key; redaction; ID và checksum.
2. **Integration** với SQLite thật trên file tạm: claim đồng thời, lease hết hạn, fencing, resume, reconcile, commit nguyên tử.
3. **Acceptance** trong `tests/acceptance/`, mỗi file map một mục blueprint 18.3. Sub-project 1 phủ:

| Mục 18.3 | Test |
|---|---|
| 1 | Ba worker cùng claim, chỉ một thắng mỗi stage |
| 2 | Worker chết giữa chừng, lease hết, worker mới chạy lại an toàn |
| 3 | Worker cũ quay lại không thể commit artifact |
| 5 | Query artifact cho stage downstream không trả artifact `PROVISIONAL` |
| 10 | Unknown config key fail trước khi tạo run |
| 11 | Secret không xuất hiện trong snapshot, event, log |
| 15 | Worker `--once` mới toanh nhận việc chỉ từ project path + capability, không cần trạng thái khác |

Thêm một test end-to-end: `plan → enqueue → worker --once` lặp tới khi run `SUCCEEDED` với workflow mẫu ba stage dùng adapter giả, có artifact ACCEPTED và lineage đúng.

### B.14 Definition of Done cho sub-project 1

- Monorepo cài được bằng `pnpm install`, `pnpm test` xanh, `pnpm build` ra binary `harness`.
- `AGENTS.md` có: cách tìm task, lệnh test, giới hạn quyền, quy tắc artifact, cách commit state, định nghĩa hoàn thành.
- 18 entity + 3 contract thực thi + 5 contract cấu hình có schema Zod và JSON Schema sinh ra.
- 9 bảng SQLite với migration.
- Tất cả acceptance test ở B.13 pass.
- Một ADR ghi các quyết định trong mục 0.2.
- Báo cáo: file đã tạo, contract đã khóa, test đã chạy, rủi ro còn lại.

---

## Rủi ro và điểm mở

- **`better-sqlite3` cần build native trên Windows.** Nếu cài lỗi, phương án dự phòng là `node:sqlite` (Node 22.5+) sau interface `StateStore`.
- **Hardlink artifact vào `input/`** có thể không dùng được khi data root ở ổ khác; fallback copy.
- **Script `.mjs` cũ** chưa có trên máy này. Sub-project 2 cần chép hoặc mount chúng trước khi bọc.
- **Chọn runtime theo project** kéo theo hai bộ SDK trong monorepo. Sub-project 4 mới cài, sub-project 1 không kéo dependency đó vào.
