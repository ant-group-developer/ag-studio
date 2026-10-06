# AGENTS.md — nguyên tắc cho mọi agent làm việc trong repo này

## Repo này là gì
**AG Studio**: engine dựng video nội bộ, fork từ YouTube Operations Harness (ADR-0001 mục 127). Người dùng tạo
một *production* (series nhiều tập) từ footage trên **ag-go**; Claude nghiên cứu rồi đề xuất R&D, branding, kế hoạch
tập; người duyệt; mỗi tập tự dựng timeline và render qua **ag-farm**. Bên dưới vẫn là control plane của harness:
session/agent là **worker tạm thời**, **state store (`studio.db`) là nguồn sự thật**. Đọc ADR-0001 (mục 127 trở đi
cho Studio) và `docs/superpowers/specs/` trước khi đổi kiến trúc.

## Cách tìm việc
- **Chạy trên một máy:** `docs/runbooks/studio-local.md`. **Vận hành một production:** `docs/runbooks/studio-production.md`.
- **Việc phát triển:** `docs/superpowers/plans/*.md`, làm theo từng task, mỗi task một commit. Chương trình đang làm:
  `docs/superpowers/specs/2026-10-06-ag-studio-local-chat-design.md` và các plan cùng ngày.
- **Việc còn nợ, lỗi đã biết:** `docs/operations/deferred-items.md` (mục "AG Studio" ở đầu file).
- **Skill nào cho bước nào:** `skills/README.md`.

## Lệnh chuẩn
- Cài: `corepack enable && pnpm install`
- Test: `pnpm test` (toàn bộ), `pnpm vitest run packages/<pkg>` (một package)
- Typecheck: `pnpm -r typecheck` · Build: `pnpm build` · Sinh JSON Schema: `pnpm gen:schemas`
- CLI dev: `pnpm harness --project fixtures/ops-project-minimal <command>`
- Build trên máy không có `pnpm` trên PATH: `corepack pnpm -r run build` (script `build` ở gốc gọi `pnpm` trần).
- Stack local chạy trực tiếp (không Docker): `node scripts/local-stack.mjs up|down|status` — ag-go-api 3738, farm
  3010, Studio API 3101, Studio web 3100, worker Studio/render/scan; chi tiết, lệnh chạy tay từng dịch vụ và cấu hình
  ở `docs/runbooks/studio-local.md`. Triển khai: `docker-compose.yml` (api → worker → web, cần checkout
  `../ag-farm`), `deploy.sh`, `.github/workflows/deploy.{dev,prod}.yml`.
- E2E (vitest, không phải Playwright): `E2E=1 pnpm vitest run tests/e2e` — dựng ag-farm hub (Docker Postgres),
  api/worker Studio và ag-render-worker thật, Claude/ag-go/S3 giả.
- `pnpm typecheck` cần chạy sau `pnpm build`: typecheck từng package dùng `tsc --noEmit` và cần `dist/*.d.ts` của các package phụ thuộc; test (`vitest`) thì không cần build vì `vitest.shared.ts` ở root đã cấu hình alias `@harness/*` trỏ thẳng vào `src`.
- `node:sqlite` in ra `ExperimentalWarning` trên Node 22 — đây là bình thường, không phải lỗi; có thể tắt bằng `NODE_OPTIONS=--no-warnings` khi chạy test nếu muốn output sạch.
- Sau khi sửa bất kỳ schema Zod nào trong `packages/contracts/src/` (entity, config, execution): chạy `pnpm gen:schemas` rồi commit các file JSON Schema sinh ra cùng lúc — `test/json-schema.test.ts` kiểm tra chúng khớp.

## Lệnh 2B (script, gate, media, doctor)
- `harness stage submit <stage_run_id> [--from <dir>] [--json]`: submit `output/` của một stage gate đang `WAITING_HUMAN` — verify theo `required_checks` của stage rồi commit đúng đường một worker đi (claim đích danh `stage_run_id` đó, attempt owner mặc định `cli-submit`); thiếu file hay check fail thì bị từ chối, **không đổi state**, in ra `missing`/`failed`; `--from <dir>` copy đè `dir` vào `output/` trước khi verify.
- `harness op intent|confirm|lost ...`: sổ external operation cho wrapper script (qua `ctx.op.*` của `@harness/script-sdk`), luôn cần `--attempt`/`--fencing-token` (hoặc chỉ `--fencing-token` cho `confirm`/`lost` theo `operation_id`) của attempt hiện tại — fencing sai bị từ chối ngay. `intent` trả lại operation `CONFIRMED` sẵn có nếu cùng idempotency key (`kind`+`target`+`payload`); một operation `FAILED` không được coi là hiện hành nên `intent` kế tiếp cùng key ghi dòng mới (gọi provider lại).
- `harness doctor [--json]`: kiểm project + harness install không đổi gì, không gọi mạng — migration đã áp, ffprobe có trên PATH hay không, mỗi stage script của mỗi workflow có entry trong `scripts.yaml` (hoặc là built-in fake) + wrapper file tồn tại + mỗi secret `env_refs` resolve được + mỗi `requires_resources` có capacity > 0, mỗi gate có output đặt `name`, mỗi profile nạp được workflow của nó + mọi `when` tham chiếu option đã khai trong `options_schema` + `options_defaults` hợp lệ, `source-catalog/sources.yaml` không thiếu file. Thiếu hẳn `executors/scripts.yaml` không phải lỗi — gộp thành một dòng `ok` duy nhất.
- `harness source sync [--json]`: đồng bộ `source-catalog/sources.yaml` vào DB catalog (ingest entry chưa có, dedupe theo sha256 như `source ingest`); báo `added`/`already`/`missing_files` (entry trỏ file đã mất)/`unregistered` (source đã có trong DB không entry nào khớp checksum) — thoát mã 1 nếu có `missing_files`.
- `harness retry <run_id> [--stage <key>] [--raise-budget <usd>]`: `--raise-budget` nâng `run.budget_usd` lên trên mức đã chi của variant đó rồi tự advance() — dùng riêng (không kèm `--stage`) khi chỉ cần mở ngân sách, không retry stage nào.

### Quy tắc wrapper / scripts.yaml / secret / gate
- Mỗi stage `executor: { type: script, script: <tên> }` cần một entry `<tên>` trong `executors/scripts.yaml` (khoá theo **tên script**, không theo `stage.key` — nhiều stage có thể dùng chung một script) trỏ `argv` tới một wrapper `.mjs` dùng `@harness/script-sdk`. Xem `docs/runbooks/wrap-a-channel.md` để nối một kênh thật.
- `scripts.yaml.<tên>.requires_resources` (nếu khai) **ghi đè hẳn** (không merge) `requires_resources` của stage trên workflow, chỉ áp dụng tại thời điểm `plan()`. `timeout_seconds` cap thời lượng chạy thật của script con (`min(deadline attempt, timeout_seconds)`) — không khai thì chạy tới hết deadline chung.
- Secret vào env qua `env_refs: { TÊN: "secret://scope/name" }`, resolve vào **env của process con** ngay trước khi spawn — không bao giờ vào `stage-request.json`, event hay log; `Redactor` che mọi giá trị đã resolve xuất hiện trong log dùng chung kể cả khi chính script tự in nó ra. Set biến `HARNESS_SECRET_<SCOPE>_<NAME>` tương ứng trong shell/`.env` của máy chạy worker; không commit giá trị.
- stdout của wrapper: một dòng JSON hợp lệ có `level` (`info`/`warn`/`error`) + `msg` string được log có cấu trúc; dòng khác log nguyên văn ở `info`. `HARNESS_CLI_ARGV` (đặt sẵn cho mọi attempt script) cho `ctx.op.*` biết cách gọi lại CLI harness này.
- Gate (`executor: { type: gate }`) không thực thi gì — chỉ ghi `stage-request.json` + `brief.md` (đề bài) rồi đỗ `WAITING_HUMAN`; xong việc thì `harness stage submit`, không có lệnh nào khác đưa một gate ra khỏi `WAITING_HUMAN`. Executor `gate` không bao giờ được reuse (đã có từ 2A).
- Checker media chọn output theo **mime khai trong `expected_outputs`**, không theo phần mở rộng file; ngưỡng lấy từ `StageRequest.policy` (build từ `profile.content`). Thiếu ffprobe trên máy rơi về `NullMediaProber` và composition root gọi `mediaCheckers(prober, { available: false })` — **bốn checker dựa trên prober** (`media-probe`, `duration-range`, `audio-integrity`, `clip-set-complete`) trả `skip` với `reason: "no media prober available"` thay vì `fail`; `edl-valid` **được miễn** (chỉ parse JSON theo `EdlSchema` + đối chiếu `request.source_items`, không cần prober) nên vẫn pass/fail bình thường. `skip` **không** phải là pass: `allRequiredPassed` cần mọi kết quả là `pass`, nên một check media bắt buộc bị skip làm `classifyFailure` trả `"result"` → stage `FAILED` (output `REJECTED`), và vì `retry_on` mặc định `["transient","abandoned"]` nên không retry, run chốt `FAILED`. Tức là thiếu ffprobe **chặn** đường ống footage — `harness doctor` báo dòng `ffprobe` FAIL chính là cảnh báo trước. Prober **có mặt** mà trả `null` cho một file vẫn là `fail` (output hỏng, không phải thiếu công cụ).
- `harness stage submit` chuyển `WAITING_HUMAN → READY` **và** claim đích danh trong cùng một `store.transaction`, nên không có khe nào để worker khác claim mất gate; claim không thành thì transition rollback, gate ở nguyên `WAITING_HUMAN`.
- Heartbeat của worker chạy xuyên suốt execute → verify → commit (verify gọi ffprobe chặn tới 120s mỗi probe), chỉ `stop()` trong `finally` bọc cả ba.
- `executors/scripts.yaml`/`source-catalog/sources.yaml` sai schema không làm chết mọi lệnh: `buildContext` bắt `CONFIG_INVALID`, để registry `undefined` và ghi thông điệp vào `AppContext.configErrors`; `doctor` in dòng `scripts`/`sources` FAIL, `source sync` ném lại lỗi đó.

## Lệnh catalog, resource, artifact (sub-project 2A)
- `harness source ingest <path> [--collection <name>] [--rights unknown|cleared|restricted] [--language <code>] [--json]`: đăng ký một file nguồn, dedupe theo sha256 (UNIQUE trên `checksum`, an toàn khi ingest đua nhau); vật liệu hoá theo `project.yaml.source.materialize` (`link` mặc định — hardlink dùng chung inode với file gốc, sửa file gốc sau đó sẽ đổi cả bản normalize; `copy`; `reference` — chỉ trỏ URI, không nhân bản).
- `harness source list [--collection <name>] [--json]`, `harness source verify [--json]` (hash lại toàn bộ nguồn đã đăng ký; thoát mã 1 nếu có nguồn hỏng).
- `harness content create --title <t> --source <src_id>... [--json]`.
- `harness plan --workflow <id@version> --profile <id> --content <content_id> [--option k=v]... [--no-reuse] [--json]`: get-or-create variant khoá theo `content_id` + `profile_id` + `profile.revision` + digest của options (đã hợp nhất với `options_defaults` và kiểm theo `options_schema`); `--option` không có `--content` là lỗi `CONFIG_INVALID`.
- `harness resources status [--json]`: capacity khai trong `project.yaml.resources` so với số lease đang giữ mỗi tài nguyên.
- `harness artifacts sweep [--older-than-minutes 60] [--dry-run] [--json]`: xoá thư mục artifact cũ hơn ngưỡng không có hàng DB không-PROVISIONAL đứng sau (crash/cancel để lại rác giữa lúc ghi output và commit).


## AG Studio (apps/api, apps/web, apps/worker, packages/studio-engine)

### Tiến trình và dữ liệu
- Ba tiến trình dùng chung **một** `studio.db` (`STUDIO_DB_PATH`, mặc định `./data/studio.db`) và một
  `STUDIO_DATA_ROOT` (workspace, artifact): `apps/api` (NestJS, cổng `PORT`, mặc định 3100), `apps/worker`
  (`createStudioWorker(...).runForever()`), `apps/web` (Vite/React). API migrate lúc khởi động; chạy worker
  **sau** khi API healthy. Không có Postgres.
- API dựng engine core ngay trong tiến trình (`apps/api/src/studio/engine.service.ts` → `createStudioEngineCore`),
  nên gate nộp từ web được kiểm bằng đúng checker worker dùng. API ghi `studio.db` bằng `BEGIN IMMEDIATE`.
- Bảng Studio (migration `0008`–`0024`): `teams`, `team_members`, `team_skills`, `productions`, `episodes`,
  `episode_revisions`, `episode_jobs`, `episode_thumbnails`, `studio_farm_jobs` (có `requirements`, `episode_id`),
  `sign_audit_log`, `youtube_cache`, `llm_calls`, `human_edits`, `canva_*`, `stage_chat_turns` (chat, 0019),
  `studio_settings` (cấu hình chỉnh trên web, 0020), `studio_render_choices` (kiểu máy render, 0021),
  `studio_agent_sessions` (session Claude của stage file mode, 0022), `episodes.edit_style` (0023),
  `studio_voice_lines` (kho giọng, 0024). `comments`, `timeline_revisions`, `studio_editor_jobs` là bảng cũ, không dùng.
- File hướng ra trình duyệt nằm trên R2 (`S3Bucket`, `packages/studio-engine/src/bucket.ts`), URL ký có hạn.
- Biến môi trường: `.env.example` (nhóm Auth0, Account API, ag-go, farm, R2, Claude, Canva, YouTube). API kiểm
  bằng zod ở `apps/api/src/config/env.ts`; worker dùng `requireEnv` ở `apps/worker/src/main.ts`. **Không bao giờ in
  hay commit giá trị** — chỉ nhắc tên khoá.

### Đăng nhập, quyền
- Web đăng nhập Auth0 (`VITE_AUTH0_*`); API kiểm JWT bằng `Auth0Guard` toàn cục (issuer, audience, `azp` thuộc
  `AUTH0_ALLOWED_CLIENT_IDS`). Vai trong team: `viewer < editor < producer < owner` (`RolesGuard`, bảng
  `team_members`); admin Studio là `user_type = ADMIN` từ Account API và qua mọi phép kiểm vai.
- Footage: web gọi thẳng ag-go bằng bearer của người dùng (cây folder, xem trước). Worker và API gọi ag-go bằng
  `AG_GO_SERVICE_KEY` + `X-Act-As-User` = Auth0 sub của chủ production. Ảnh/URL có hình footage chỉ trả cho người
  xem được các folder của production (`FootageAccessService.coversProduction`), kể cả khi đẩy sang Canva.

### Workflow, gate, run
- Hợp đồng API: `docs/studio-api-v3.md`. Run kế hoạch `ag-studio-series-plan@3.0.0`: `intake` → `research`
  (YouTube Data API) + `catalog` (ag-go) → `trend-report` → **`approve-trend-report`** → `rnd` → **`approve-rnd`** →
  `apply-rnd` → `branding` → **`approve-branding`** → `apply-branding` → `brief` → `plan-episodes` →
  **`approve-plan`** → `spawn-episodes`. Run tập `ag-studio-episode@1.3.0`: `episode-intake` → `build-timeline` →
  **`approve-timeline`** (nộp revision mới nhất) → `youtube-kit` → **`approve-youtube-kit`** → `freeze-timeline`
  (`studio-freeze-timeline-v2`: timeline **đã duyệt**) → `render-final` (farm) → `thumbnails` → `export`. Tập chờ
  gate có trạng thái `waiting_approval`. Plan 1.0.0/2.0.0 vẫn sinh tập 1.2.0 không gate (`episodeWorkflowForPlan`).
- **Plan `ag-studio-series-plan@3.1.0`** (đang dùng) chỉ khác 3.0.0 ở `spawn-episodes` (`studio-spawn-episodes-v2`):
  `plan-episodes` chọn kiểu dựng từng tập (`edit_style: whole|cut`, `narration: none|tts|original`), lưu ở
  `episodes.edit_style`; tập `cut` chạy **`ag-studio-episode-cut@1.0.0`** (`episodeWorkflowFor`): `episode-intake`
  → `fetch-proxies` (proxy 720p từ ag-go) → `media-index` (shot) → `transcribe` (farm `studio.transcribe`) →
  `watch-source` (khung + contact sheet) → `source-survey` → **`approve-survey`** → `plan-edit` →
  **`approve-edit-plan`** → `tts` (farm `studio.tts`) → `fit-timeline` (timeline v4) → **`approve-timeline`** →
  `youtube-kit` → **`approve-youtube-kit`** → `freeze-timeline` → `render-final` → `thumbnails` → `export`. Các khoá
  gate/render giống 1.3.0 để `run-control` dùng chung (ADR mục 158). Stage media ở
  `packages/studio-engine/src/cut-stages.ts`; chạy lại từ một gate: `rerunEpisodeFrom` (`cut-episode.ts`).
  Phiên bản đang dùng ở `STUDIO_WORKFLOWS` (`packages/studio-engine/src/core.ts`), gate ở `STUDIO_GATES`
  (`packages/studio-engine/src/run-control.ts`).
- Thư mục workflow đã phát hành **không bao giờ sửa**: làm phiên bản mới. Script/payload builder đổi đầu ra thì đặt
  **tên mới** (`studio-episode-export-v2`…) và giữ tên cũ cho run cũ; `workflow-wiring.test.ts` kiểm mọi phiên bản.
  Một stage chỉ nhận artifact của stage nó phụ thuộc **trực tiếp**, và mỗi kiểu chỉ đến từ một nguồn.
- Gate nhận **tài liệu người đã sửa** (`submitStudioGate` → core `submitGate`); R&D/branding chỉ được ghi vào
  production bởi stage script **sau** gate (`apply-rnd`, `apply-branding`), không ghi trong API lúc nộp gate. Sửa
  sau khi duyệt: `PUT /productions/:id/rnd|branding` rồi chạy lại từ `brief` (`resumeRunFrom`).
- Timeline v3: clip luôn là **cả asset**, nối tiếp, không trim; không trùng trong một tập, được dùng lại giữa các
  tập; lệch thời lượng ±20% chỉ cảnh báo. Thao tác thuần ở `packages/core/src/studio/layout.ts` (web dùng chung qua
  alias `@studio/timeline`). Render: `timelineToComposition` → `harness.composition/v1`.
- **Timeline v4** (tập cắt theo shot, hợp đồng ở `TimelineV4Schema`, ADR mục 151): clip là đoạn `[in, out)` của video
  (`out: null` = tới hết), có `shot_id`, `line_id`, `transition_out`; timeline có `edit_style`, `narration`,
  `captions`. **Đọc** luôn ra v4 (`readTimeline`); **ghi** giữ phiên bản revision đầu của tập (`timelineAsVersion`):
  tập ghép nguyên video vẫn lưu v3, v4 mất dữ liệu trên tập đó là 422 `not_v3`. Không bao giờ ghi lại revision v3 cũ.
  `trimClip`/`setTransition`/`setCaptions` chỉ cho v4 (`needs_v4`). Composition luôn suy từ revision (không có stage
  compose): lời dẫn `stage:voice/<line_id>.wav`, phụ đề, ducking, chuyển cảnh.
- Stage in-process (`InProcessExecutor`) nằm ở `packages/studio-engine/src/stages.ts`. Các workflow harness cũ
  (`library-production*`, `channel-*`, `style-study*`, `footage-production`) vẫn trong `workflows/` nhưng **không
  chạy được** vì built-in của chúng đã bị gỡ (ADR mục 127).

### Claude
- Gọi qua CLI bằng gói subscription, dạng **structured**: `STUDIO_ARGV` trong
  `packages/adapters/agent-cli/src/cli-agent-runtime.ts` (`--tools ""`, `--no-session-persistence`,
  `--json-schema`, prompt qua stdin). Env con là danh sách trắng: có `CLAUDE_CODE_OAUTH_TOKEN`/`CLAUDE_CONFIG_DIR`,
  **không** có `ANTHROPIC_API_KEY`, không bao giờ có `HARNESS_SECRET_*`.
- `StudioAgentExecutor` (`packages/executors/src/studio-agent-executor.ts`): prompt = skill + brief + quy chuẩn nhóm
  (`<team_guide>`) + input inline; kiểm bằng `VALIDATORS` theo skill; **một** vòng sửa rồi `contract`. Lỗi giới hạn
  gói (`RATE_LIMITED`) chờ 5→60 phút, không tính là attempt.
- Model theo skill (`packages/studio-engine/src/models.ts`): Opus cho `studio-rnd`/`studio-plan-episodes`/
  `studio-edit-plan`, Sonnet còn lại; ghi đè bằng `STUDIO_CLAUDE_MODEL[_<SKILL>]`.
- **File mode có session** (ADR mục 155): chỉ `studio-source-survey` (bước chọn cảnh xem contact sheet) chạy
  `CliAgentRuntime` mode `files` (`--allowedTools Read,Write,Glob,Grep`, không Bash, không web, giữ session); Claude
  tự ghi `output/survey.json`, vòng sửa `--resume` đúng session; session + thư mục lưu ở `studio_agent_sessions`
  (`saveAgentSession`/`agentSessionFor`). Mọi skill khác vẫn structured.
- Số lượt Claude cùng lúc: `studio_settings.claude.max_concurrent` (admin sửa trên web, `PUT /api/studio/settings`)
  thắng `STUDIO_CLAUDE_MAX_CONCURRENT` (1–100, mặc định 20; env sai là `CONFIG_INVALID` lúc khởi động) → capacity
  `claude` của `studioResources()`, đọc lại ở mỗi lần claim. Worker chạy `createStudioWorkerPool`: `claude + farm +
  cpu` vòng trong một tiến trình, phối hợp qua `claim()`/lease (ADR mục 143), tự thêm/thả vòng khi cap đổi. Đừng
  quay lại một vòng duy nhất: stage farm giữ vòng của nó suốt lúc render.

### Chat (spec local-chat §3.1, ADR mục 144–147)
- Mỗi production và mỗi tập có một luồng chat (`stage_chat_turns`). Tin nhắn đi vào **scope** bước đang ở
  (`chatScopeFor`, `packages/studio-engine/src/chat-context.ts`): `intake` (chưa có run), `gate`, `failed` (stage
  Claude hỏng), `timeline` (tập không còn gate chờ). Đang chạy thì 409 `busy`.
- Vòng chat (`chat-runner.ts`) chạy **trong worker pool**, không qua `claim()`: mỗi lượt giữ dòng lease
  `owner = chat:<turn>` (`claude-slots.ts`); hết slot thì giữ `chat-wait:<turn>` — cũng tính vào cap, nên tin nhắn
  được ưu tiên trước stage xếp hàng. Một scope một lượt một lúc. Hết hạn mức: `rate_limited` tới `not_before`.
- `runChatTurn` (`chat.ts`): prompt = phần đầu prompt của stage nguồn (`studioPromptHead`, giống từng byte) +
  `# Bản hiện tại` + `# Góp ý` + `# Đầu ra (chat)`; trả `{reply, action, proposal}`; `proposal` kiểm bằng validator
  của stage, một vòng sửa. Ghi `llm_calls` với `source = 'claude-chat'`. Skill chỉ có ở chat: `studio-intake`,
  `studio-timeline` (đề xuất `TimelineOp`, áp bằng `applyTimelineOps`), `studio-survey` (gate `approve-survey`:
  đề xuất `SurveyOp` keep/reject/setScore/setNote, áp bằng `applySurveyOps`; còn thư mục của stage thì lượt chat
  chạy `claude --resume <session> --fork-session --json-schema` trong đó, chỉ Read/Glob/Grep — mất thì structured).
  `approve-edit-plan` chat bằng `studio-edit-plan` như mọi gate tài liệu.
- Không gì được áp dụng tới khi người bấm (`chat-actions.ts`): Bắt đầu (`startFromIntake`), Duyệt
  (`approveChatScope`, nộp bản đang hiện theo `turnId`), Áp dụng (intake/timeline, `applyChatProposal`), Chạy lại
  (`retryStageWithFeedback`, tin nhắn vào prompt dạng `# Góp ý của người dùng`), Sửa tay (`saveManualEdit`).
- Web chat: `/` (trang chủ), `/v/:productionId`, `/v/:productionId/e/:episodeId`, `/queue` (`apps/web/src/modules/chat`,
  `pages/Chat*Page.tsx`, `pages/QueuePage.tsx`); màn cũ giữ ở `/productions`, `/teams`, editor timeline. Khung trình
  duyệt nhúng của app desktop báo trang luôn ẩn nên react-query không polling: kiểm bằng khung đó thì tải lại trang.
- Test chạm `claude` thật chỉ chạy khi `HARNESS_REAL_CLAUDE_TEST=1`. Trên Windows `resolveCommand`
  (`packages/adapters/agent-cli/src/resolve-command.ts`) dò shim `claude.cmd` của npm ra `claude.exe`.
- Mọi lượt gọi ghi `llm_calls` (payload gzip trên bucket), mọi lần người duyệt/sửa ghi `human_edits`.
- Test luôn dùng Claude giả `fixtures/fake-studio-claude.mjs` (đặt `STUDIO_CLAUDE_ARGV`); **không gọi Claude thật
  trong test**.

### Render, xuất, thumbnail
- `render-final` và bản xem trước trong editor chạy ở **ag-farm** (`FarmExecutor`, job `studio.render_*`); render
  worker (`E:\CODE\ag-render-worker`) chạy `renderComposition` của `@harness/core`. Worker xin URL qua
  `POST /api/farm/sign` (vé của farm): `asset:` → ag-go `/footage/assets/resolve` (`final` hoặc `preview`),
  `stage:` → input của job; mọi lần ký ghi `sign_audit_log`. Build cần checkout `../ag-farm` (`@ag-farm/*` link
  tới đó).
- **Kiểu máy render bản cuối** (spec local-chat §3.4, ADR mục 148–150): `any` → `{}`, `nvenc` → `{ nvenc: true }`,
  `gpu` → `{ gpu: true }` — `requirements` sẵn có của ag-farm (`renderRequirements`, `packages/contracts/src/studio.ts`).
  Lựa chọn lưu theo `(run_id, stage_key)` ở `studio_render_choices` (`render-choice.ts`); worker đọc qua
  `FarmExecutor.requirementsFor` lúc gửi job; không có dòng nào thì gửi `{}` như trước. Chọn khi duyệt
  `approve-youtube-kit` (`approveChatScope({ renderMachine })`, gate khác → 422 `no_render_here`) hoặc khi Render lại
  (`POST …/episodes/:id/rerender { renderMachine }`). Xem trước 720p và xuất Premiere luôn `{}`. **Ghim một máy theo tên
  node là đổi hợp đồng ag-farm: hỏi trước.**
- **Render lại** (`rerenderEpisode`): run 1.3.0 đã xong mà revision mới nhất **giống** timeline đã duyệt thì chạy lại
  từ `render-final` (không gọi Claude, không duyệt lại); đã sửa sau khi duyệt thì từ `approve-timeline`; tập 1.2.0 từ
  `freeze-timeline`. `episodeRenderInfo` (trường `render` của chi tiết tập) nói bước bắt đầu (`restartFrom`).
- **Màn Hàng đợi** (`/queue`, `GET /api/studio/queue`, `queue.ts`): lượt Claude (dòng `lease` giữ `claude`) và job farm
  chưa xong (owner API `listJobs`, cache 3 s) của video người xem thấy. Owner API **không** có danh sách node nên không
  có danh sách máy; `JobView` chỉ có `node_id`. Job `queued` quá 10 phút hiện cảnh báo (farm không báo vì sao chờ).
- Xuất Premiere: job farm `studio.export_premiere`, FCP7 XML (xmeml v5), chữ là PNG, zip kèm README relink. **Tắt cho
  tập cắt theo shot** tới pha 4 (422 `premiere_needs_phase_4`, web ẩn mục; ADR mục 159).
- **Lời dẫn và nhận dạng lời nói ở farm** (tập cắt, ADR mục 154, 156): `studio.tts` chỉ gửi các dòng chưa có trong
  kho giọng (`voice-store.ts`, khoá theo nội dung, WAV ở `<STUDIO_DATA_ROOT>/voice`); `studio.transcribe` nhận WAV 16 kHz
  Studio đã tách. Không có gì để gửi thì payload builder trả `skip` (`FarmExecutor` ghi đầu ra, không gọi farm).
  Render worker phải khai `python` (`extra.python_bin` trong `render.yaml`) mới nhận được hai job này.
- Thumbnail cắt và vẽ chữ trên máy Studio từ `final.mp4` (ffmpeg bất đồng bộ, không `spawnSync`); font Arial của hệ
  thống (`STUDIO_FONTS_DIR`) — không ship font.
- Canva: token mỗi người dùng mã hoá bằng `CANVA_TOKEN_KEY`, không bao giờ trả về trình duyệt; refresh token chỉ
  dùng một lần nên làm mới tuần tự theo người dùng (`docs/runbooks/canva.md`).
- Quy chuẩn & skill của nhóm (`team_skills`, ≤20 000 ký tự mỗi bản, ≤60 000 tổng) chèn vào prompt lúc gọi Claude
  (`teamGuidesForRun`), không thành artifact.

## Pipeline media của harness
Code 5A/5B vẫn còn trong `packages/core/src/media/*` và lệnh `harness media …`; render ở farm dùng
`renderComposition` của nó. **Studio dùng phần này qua `cut-stages.ts`** (tập cắt theo shot): chỉ hàm thuần
(`buildShots`, `shotId`, `fitEdl`, `buildTimeline`); lệnh ffmpeg là bản bất đồng bộ ở
`packages/studio-engine/src/cut-ffmpeg.ts` vì worker Studio là một tiến trình cho cả pool (không `spawnSync`).
Test media cần ffmpeg + ffprobe (`FFMPEG_PATH`/`FFPROBE_PATH`), không có thì skip.
- `harness library voices|brands|music …` (`packages/cli/src/commands/library.ts`): quản lý giọng TTS, hồ sơ
  thương hiệu, nhạc trong thư mục `library.root`. **Không bao giờ nhân giọng một người thật khi chưa có quyền**
  (`--origin` chỉ ghi lời khai, ADR mục 105).
- `harness media watch|index|transcribe|tts|fit-edl|compose|render`: stage built-in, đọc `stage-request.json`
  trong `$HARNESS_WORKSPACE`, không gọi tay.
- `project.yaml` của harness: `adapters.media: python | fake` và khối `media:` (`python`, `device`, `transcribe`,
  `tts`, `scene`, `watch`, `render { codec, encoder, fps, cache_max_gb }`). Engine Python: `engines/python/README.md`.
- Mọi thứ vẽ lên hình trừ logo đi qua **một file ASS** (libass), không `drawtext`; font chỉ lấy từ `fontsdir`.
- `h264_nvenc` của ffmpeg 8.1 cần **driver NVIDIA ≥ 610**; không có thì render bằng CPU (`encoder: auto`).
- Chi tiết: `docs/runbooks/studio-media.md`, `docs/runbooks/studio-composition.md`, ADR mục 102–126.

## Giới hạn quyền
- Không sửa cột `state` ngoài `transition()` và `claim()` trong `packages/core/src/state/`. Bảng Studio (`productions`, `episodes`, …) không phải entity của harness: ghi qua `StudioDb` (`packages/studio-engine/src/studio-db.ts`), không qua `transition()`.
- Không import `adapters/*` hay `agent-runtime/*` từ `packages/core`.
- Không ghi giá trị secret vào file, event, log, manifest; chỉ dùng `secret://scope/name`.
- Không gọi mạng hay LLM trong test.
- Không in, ghi file hay commit giá trị của biến môi trường bí mật (`AUTH0_*`, `ACCOUNT_API_KEY`, `AG_GO_SERVICE_KEY`, `FARM_OWNER_KEY`, `STUDIO_R2_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `CANVA_*`, `YOUTUBE_API_KEY`); khi kiểm chỉ in tên khoá.
- Không push, không mở PR khi chưa hỏi người dùng.

## Quy tắc artifact
- Worker ghi vào `workspaces/<run>/<stage>/<attempt>/output/`. Controller mới chuyển vào `artifacts/` và đánh dấu ACCEPTED.
- Downstream chỉ đọc artifact ACCEPTED (`acceptedInputsFor`).
- Mọi artifact có `manifest.json` cạnh file, checksum sha256, lineage.
- Output khai `kind: directory` trong stage definition tạo một artifact cho cả thư mục: manifest liệt kê từng file con kèm checksum riêng, `checksum` của artifact là canonical digest của toàn bộ listing đó; input là thư mục được vật liệu hoá lại thành cây (hardlink, rơi về copy) trong workspace của stage kế tiếp.

## Quy tắc tài nguyên (resources)
- Tài nguyên chia sẻ (GPU, license slot, …) khai trong `project.yaml.resources: { <tên>: <capacity> }`; tên không khai coi như capacity 0.
- Stage khai `requires_resources` trong workflow definition. `claim()` bỏ qua stage nếu bất kỳ tài nguyên yêu cầu nào không còn slot trống (giữ theo lease đang hiệu lực, đếm qua `resources` trên bảng `lease`); worker khác vẫn được claim các stage không tranh chấp.
- Stage READY chờ tài nguyên quá `resource_wait_warn_seconds` (mặc định 600s) sinh event `stage.waiting_resource`, không lặp lại nếu vẫn còn nằm trong cửa sổ đó.

## Quy tắc cache và invalidation
- Controller ghi `cache_key` (digest của stage definition + checksum input đã sort + options digest + effective-config digest + `executor_version`) vào StageRun khi commit SUCCEEDED.
- Khi `plan` một run mới cho cùng variant (`profile.reuse: allow`, mặc định), stage nào có toàn bộ dependency đã reuse/SUCCEEDED sẽ được tái sử dụng artifact nếu tìm thấy stage SUCCEEDED cùng cache_key ở run trước của variant đó — không dispatch lại; event `stage.reused` ghi `reused_artifact_ids`. `profile.reuse: never` tắt hẳn (`harness plan --no-reuse` tắt cho một run); executor `gate` không bao giờ được reuse. Nếu mọi stage đều reuse thì `enqueue` chốt run thành SUCCEEDED ngay, không dispatch gì.
- Khi một stage commit artifact ACCEPTED mới, mọi artifact ACCEPTED của chính stage đó và các stage phụ thuộc (transitive, kể cả `depends_on_optional`) ở các run **trước đó** của cùng variant chuyển sang STALE (`artifact.stale`), kèm event `stage.invalidated_downstream` trên run vừa commit. Artifact STALE không còn được downstream đọc.
- Invalidation theo **nội dung**, không chỉ theo graph (spec §3.2): run cũ nào đang giữ đúng tập checksum vừa commit ở chính stage đó thì được bỏ qua nguyên vẹn — submit lại một gate với nội dung y hệt không làm hỏng gì của run trước. **Ngoại lệ:** một stage commit **không output nào** (tập checksum rỗng) không có gì để so nội dung, nên vẫn invalidate thuần theo graph như trước — không có "byte giống hệt" để so sánh thì không thể bỏ qua.
- Reuse còn xảy ra **lúc release**: một stage PENDING có đủ dependency SUCCEEDED sẽ tính lại cache_key từ input ACCEPTED thật (`stage_definition_digest`, `expected_executor_version`, `reuse_eligible` planner ghi sẵn lên StageRun) và nếu trúng thì đi thẳng `PENDING → SUCCEEDED` với event `stage.reused` (`at: "release"`), không dispatch. Nhờ đó stage nằm dưới một gate — thứ không bao giờ reuse lúc plan — vẫn tái sử dụng được khi gate cho ra đúng nội dung cũ. Ngân sách (variant) chặn nhánh reuse-lúc-release này y hệt dispatch thường (nằm trong cùng vòng lặp `releaseReady`) dù bản thân nó miễn phí; reuse lúc `plan()` thì không bao giờ bị ngân sách chặn.

## Cách commit state
- Mọi kết quả stage đi qua `Controller.commit()` với fencing token của attempt hiện tại.
- Kết quả không rõ (mất kết nối sau dispatch) → `NEEDS_RECONCILIATION`; `harness reconcile <run_id>` hỏi provider rồi tự đưa stage về `READY` ngay khi không còn operation nào của nó còn treo — **kể cả khi provider không xác nhận được (kết quả `FAILED`)**, không chỉ khi `CONFIRMED`; khác biệt duy nhất là lần attempt kế tiếp gọi lại provider (idempotency key cũ bị coi là không hiện hành) thay vì tái dùng kết quả đã confirm. Không bao giờ `retry` trước khi `reconcile`.

## Định nghĩa hoàn thành cho một task phát triển
1. Test viết trước, fail, rồi pass. 2. `pnpm -r typecheck` sạch. 3. Commit theo Conventional Commits. 4. Không để lại TODO/placeholder.
