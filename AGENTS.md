# AGENTS.md — nguyên tắc cho mọi agent làm việc trong repo này

## Repo này là gì
**AG Studio**: công cụ dựng video nội bộ, fork từ YouTube Operations Harness (ADR-0001 mục 127). Người dùng tạo một
*dự án* (một kênh YouTube) trong team và chat tự do với agent (Claude Code chạy trong thư mục dự án như một repo): nghiên
cứu, chiến lược, branding, rồi từng *video* từ footage trên **ag-go** — chọn cảnh, kế hoạch dựng, timeline, render qua
**ag-farm**. Kết quả là file người sửa trực tiếp hoặc bảo agent sửa; việc nặng hiện ai đang làm, bao lâu, dừng được. Bên
dưới vẫn là control plane của harness (CLI `harness`, workflow khác ngoài Studio): **state store là nguồn sự thật**. Đọc
ADR-0001 (mục 127 trở đi cho Studio, 179–190 cho workspace agent) và `docs/superpowers/specs/` trước khi đổi kiến trúc.

## Cách tìm việc
- **Chạy trên một máy:** `docs/runbooks/studio-local.md`. **Vận hành một dự án:** `docs/runbooks/studio-project.md`.
- **Việc phát triển:** `docs/superpowers/plans/*.md`, làm theo từng task, mỗi task một commit. Chương trình đang làm:
  `docs/superpowers/specs/2026-10-10-ag-studio-agent-workspace-design.md` và plan cùng ngày.
- **Việc còn nợ, lỗi đã biết:** `docs/operations/deferred-items.md` (mục "AG Studio" ở đầu file).
- **Skill của agent Studio:** `agent-skills/README.md`; skill của harness CLI: `skills/README.md`.

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
  API Studio và ag-render-worker thật, ag-go/S3 giả; job farm ghi như job của dự án.
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

Spec: `docs/superpowers/specs/2026-10-10-ag-studio-agent-workspace-design.md`; plan và tiến độ:
`docs/superpowers/plans/2026-10-10-ag-studio-agent-workspace.md`; hợp đồng API: `docs/studio-api-v4.md`; ADR-0001 mục 179–190.
Runbook: `docs/runbooks/studio-local.md` (chạy local), `docs/runbooks/studio-project.md` (làm một dự án tới bản cuối).
Hệ thống cũ (production, run workflow `ag-studio-*`, gate, chat theo bước, Canva) **đã gỡ** ở P8; bảng cũ còn trong DB
nhưng không code nào đọc.

### Tiến trình và dữ liệu
- Ba tiến trình dùng chung **một** `studio.db` (`STUDIO_DB_PATH`) và một `STUDIO_DATA_ROOT`: `apps/api` (NestJS, cổng
  `PORT`), `apps/worker` (`createStudioWorkerPool`: vòng agent + vòng job dự án + quét dọn), `apps/web` (Vite/React). API
  migrate lúc khởi động; chạy worker **sau** khi API healthy. Không có Postgres. API ghi `studio.db` bằng `BEGIN IMMEDIATE`.
- Team → **dự án** (một kênh YouTube, bảng `projects`) → **video** (`videos`), thêm dần theo lời người dùng. Mỗi dự án là một
  thư mục làm việc như một repo: `<STUDIO_WORKSPACES_ROOT>/<projectId>/` (mặc định `<STUDIO_DATA_ROOT>/workspaces`, phải nằm
  **ngoài mọi repo** để CLAUDE.md của thư mục cha không lọt vào; API và worker phải thấy cùng thư mục): `CLAUDE.md` (kênh,
  khán giả, quy tắc; import `@memory/lessons.md`), `context/` (tài liệu, ảnh, audio tải lên), `research/`, `channel/`
  (strategy, style, branding), `inputs/<asset>/` (video ag-go đã chuẩn bị, chỉ đọc), `videos/<id>/` (brief, scenes,
  survey.json, edit-plan, timeline.json bản soi, youtube-kit, thumbnails, renders, `sources/index.json`), `skills/`, `memory/`,
  `.studio/` (Studio ghi; chỉ `playbook.yaml` người sửa được). Đường bảo vệ và quyền ghi: `accessFor` (`workspace/files.ts`).
- DB là nguồn sự thật cho team/dự án/video/nguồn/luồng chat/tin nhắn/job/revision timeline/thẻ xác nhận; file là nguồn sự
  thật cho tài liệu. Mỗi lần file đổi ghi `project_file_versions` (người, agent, Studio).
- Bảng (migration `0030`–`0037`): `projects` (+`voice`, `music`), `videos`, `project_sources`, `video_revisions` (chỉ timeline
  v4), `project_file_versions`, `agent_threads`, `thread_refs`, `agent_messages`, `step_marks`, `thread_summaries`,
  `lesson_proposals`, `project_jobs`, `project_farm_jobs`, `prepared_assets`, `agent_actions`, `audit_log` (nhật ký hoạt động,
  0036). Dùng chung từ trước: `teams`,
  `team_members`, `team_skills`, `sign_audit_log`, `youtube_cache`, `llm_calls`, `studio_settings`, `studio_voice_lines`,
  `music_track` (kho nhạc), `lease` (slot Claude).
- File hướng ra trình duyệt nằm trên R2 (`S3Bucket`, `packages/studio-engine/src/bucket.ts`), URL ký có hạn.
- Biến môi trường: `.env.example`. API kiểm bằng zod ở `apps/api/src/config/env.ts`; worker đọc ở `apps/worker/src/main.ts`.
  **Không bao giờ in hay commit giá trị** — chỉ nhắc tên khoá.

### Đăng nhập, quyền
- Web đăng nhập Auth0 (`VITE_AUTH0_*`); API kiểm JWT bằng `Auth0Guard` toàn cục (issuer, audience, `azp` thuộc
  `AUTH0_ALLOWED_CLIENT_IDS`). Vai trong team: `viewer < editor < producer < owner` (`RolesGuard` tra
  `teamId|projectId|videoId|threadId` ra team); admin Studio là `user_type = ADMIN` từ Account API và qua mọi phép kiểm vai.
- Footage: video chỉ đến từ ag-go (chọn project/video ag-go ở tab Đầu vào; không còn `@folder`); web gọi thẳng ag-go bằng
  bearer người dùng (`/projects`, `/projects/:id/media`), API và worker gọi bằng `AG_GO_SERVICE_KEY` + `X-Act-As-User` = chủ
  dự án. Link render chỉ trả cho người mà quyền ag-go của chính họ phủ mọi video trong bản đó. Tài liệu/ảnh/audio tải lên
  Studio. **Không bao giờ lấy giọng hay nhạc từ ag-go.**

### Agent
- Mỗi luồng chat là một session Claude Code (`claude -p --output-format stream-json --restricted`, chỉ Read/Write/Edit/Glob/
  Grep/Skill, không Bash, không web; `--settings` chặn ghi `.claude/**`, `.studio/**`, `.git/**`; `CLAUDE_CONFIG_DIR` riêng
  `STUDIO_AGENT_CLAUDE_CONFIG_DIR`). Runner: `packages/studio-engine/src/agent/runner.ts`. CLAUDE.md được nhúng vào system
  prompt (dưới `--restricted` CLI không tự đọc); skill qua plugin dir (`agent-skills/` + skill team dự án bật + `skills/` của
  dự án → `studio:<tên>`). Video mới → luồng mới; "Học từ chat cũ" ghi `thread_refs`, tóm tắt ở `SUMMARY.md`.
- Tool Studio qua MCP stdio (`packages/studio-mcp/server.mjs`) → `POST /api/agent-tools/call` với token HMAC theo lượt
  (`STUDIO_AGENT_TOKEN_SECRET`, chỉ dùng khi tin nhắn còn `running`). Danh sách tool: `agent/*-tools.ts`; thêm tool thì thêm
  vào `agentTools()` (cả API lẫn worker đọc chung để `--allowedTools` khớp).
- Việc có tác dụng thật (render bản cuối, xuất Premiere, xoá video, crawl lớn, tải video mẫu) **không bao giờ** do agent
  tự làm: `propose_action` → thẻ trong chat → người có vai bấm (`agent/actions.ts`, hết hạn 24 giờ hoặc khi timeline đổi).
- Playbook mềm (`workspace/playbook.ts`, ghi đè bằng `.studio/playbook.yaml`): gợi ý bước, không chặn; trạng thái tính từ file
  + DB (`playbook-status.ts`, `step-facts.ts`); kiểm file ở `workspace/validators.ts` (dùng lại validator của
  `packages/core/src/studio/*`). Bài học chung ở `memory/lessons.md` (thẻ "Lưu vào bài học dự án?").
- Slot Claude (`claude-slots.ts`): mỗi lượt giữ dòng `lease` `agent:<id>` (chờ: `agent-wait:<id>`, cũng tính vào cap), nên mọi
  worker dùng chung một cap: `studio_settings.claude.max_concurrent` (admin sửa ở màn Hàng đợi) thắng
  `STUDIO_CLAUDE_MAX_CONCURRENT` (1–100, mặc định 20). Hết hạn mức gói: `rate_limited`, chờ 5→60 phút rồi chạy lại.
- **Tên AI trên web** (`studio_settings.assistant.name`): admin đặt ở màn Hàng đợi, mặc định `Claude`; chỉ là tên hiển thị.
  Chuỗi i18n nhắc AI dùng `{{ai}}` và component gọi `useAiTranslation()` (`apps/web/src/modules/common/assistant-name.tsx`).
- **Tên kho footage** là `siteName` của chính ag-go (`GET /settings/public`, không cần đăng nhập; mặc định `AG Go`), không
  viết cứng "ag-go" ở chữ người dùng hay agent đọc: web `{{site}}` qua `useAiTranslation()` (`SiteNameProvider` nằm ngoài
  `AuthGate`; `keys.spec.ts` cấm "ag-go" trong locale), API `SiteNameService`, worker/engine `createSiteNameCache`
  (`site-name.ts`, nạp lại 10 phút) cho lỗi, chữ job, system prompt và mô tả tool (`{{site}}` trong `description`). Tên
  tool, kind nguồn (`ag_go_*`) và mã lỗi giữ nguyên.
- Mọi lượt ghi `llm_calls` (`source = 'claude-agent'`, payload gzip trên bucket; từ 0037 thêm `user_id` = người lượt làm thay,
  `team_id`, `cache_read_tokens`, `cache_creation_tokens`, `num_turns` cho thống kê `claude-stats.ts`). Test luôn dùng CLI giả
  `fixtures/fake-studio-agent.mjs` (directive `@fake …`) và `fixtures/fake-mcp-server.mjs`; **không gọi Claude thật trong
  test** (probe thật chỉ khi `HARNESS_REAL_CLAUDE_TEST=1`). Trên Windows `resolveCommand` dò shim `claude.cmd` ra `claude.exe`.

### Việc nền (job), farm, render
- `project_jobs` (`workspace/jobs-db.ts`) chạy bởi `workspace/job-runner.ts` trong worker (`STUDIO_JOB_LANES`, mặc định 2):
  `prepare_asset` (ag-go → tải bản xem → dò cảnh → khung, tờ ghép → lời thoại `studio.transcribe` trên farm), `research`
  (crawl YouTube: Data API nếu có `YOUTUBE_API_KEY`, không thì yt-dlp), `fit` (timeline v4 từ edit-plan, lời dẫn `studio.tts`
  vào kho giọng `voice-store.ts`), `render_preview|render_final|export_premiere`, `thumbnail`, `style_watch`. Mỗi job báo
  `phase`, `progress`, `eta_seconds` (`eta.ts`, không đoán khi đang chờ máy farm), máy farm; Dừng = `cancel_requested` (kill
  ffmpeg / huỷ job farm). Xong thì đăng tin hệ thống vào luồng và cho agent làm tiếp (≤ 3 lượt tự chạy liên tiếp, tắt bằng
  `settings.auto_continue`). Worker thiếu công cụ thì job loại đó chờ worker khác (`projectJobHandlers`).
- Job farm của dự án ghi `project_farm_jobs`; `/api/farm/sign` tra ở đó, hỏi ag-go bằng quyền **chủ dự án**; bản xem trước xin
  `prefer: {short_edge: 480, clean: true}` (ag-go cũ bỏ qua). Khoá bucket giữ quy ước farm:
  `productions/<projectId>/jobs/<stage>/<jobId>/{in,out}/` (dự án đóng vai "production" trong payload `@ag-farm/protocol`,
  video đóng vai "episode"). **Không đổi hợp đồng ag-farm khi chưa hỏi.** Build cần checkout `../ag-farm`.
- Render worker (`E:\CODE\ag-render-worker`) chạy `renderComposition` của `@harness/core`; **mọi node farm render phải chạy
  ag-render-worker ≥ 0.8.0** (composition có `text_style`, Premiere `audio: per_segment`) và khai `python` (`extra.python_bin`)
  để nhận `studio.tts`/`studio.transcribe`. Bản cuối: `requirements` theo máy chọn (`renderRequirements`; ghim `node_id` qua
  thẻ xác nhận). Xuất Premiere: FCP7 XML zip kèm WAV lời dẫn từ kho giọng.
- Timeline v4 (`TimelineV4Schema`): clip là đoạn `[in, out)` của video, có `shot_id`, `line_id`, `transition_out`; thao tác
  thuần ở `packages/core/src/studio/layout.ts` (`applyTimelineOps`, `timelineIssues`); composition suy từ revision
  (`timelineToComposition`). Revision ở `video_revisions` (`saveVideoRevision`, xung đột → `RevisionConflictError`).
- Giọng đọc/nhạc của dự án: chọn từ file audio đã tải lên (`workspace/project-audio.ts`; giọng cần vai producer và khai nguồn
  gốc); không có nhạc riêng thì lấy kho nhạc theo mood của branding (`music-library.ts`). API cần `STUDIO_FFMPEG_PATH` và
  `STUDIO_FFPROBE_PATH` để nhận audio.
- Thumbnail (`workspace/thumbnails.ts`) cắt khung từ bản render và vẽ chữ trên máy Studio (ffmpeg bất đồng bộ, font Arial của
  hệ thống qua `STUDIO_FONTS_DIR`, không ship font). Quy chuẩn & skill của nhóm (`team_skills`) thành skill của agent khi dự
  án bật.
- Quét dọn (`cleanup.ts`, mỗi `STUDIO_CLEANUP_HOURS`): dòng kho giọng lâu không đọc, audio dự án không còn ai trỏ tới, thư mục
  tạm của job/lượt bị bỏ dở, `.trash` của dự án, dòng `audit_log` cũ hơn `STUDIO_RETENTION_AUDIT_DAYS` (90).
- **Nhật ký hoạt động** (`audit-log.ts`, `apps/api/src/audit/`): `AuditInterceptor` (APP_INTERCEPTOR) ghi mọi POST/PUT/PATCH/DELETE
  của người đã đăng nhập (route `@NoAudit()` thì bỏ; request bị guard chặn không vào); `/agent-tools/call` ghi mọi tool Studio
  agent gọi; runner ghi mỗi lượt (`turn`) và mỗi tool có sẵn của Claude; job runner ghi mỗi việc nền xong. `logAudit` không bao
  giờ ném lỗi; `details` qua `redactDetails` (bỏ khoá giống bí mật, cắt ≤ 4 KB) và **không bao giờ chứa nội dung chat hay nội
  dung file** (chỉ kích thước). Xem: admin Studio mọi dòng, owner nhóm mình (`StudioAdminService.viewScope`).

### Web
- `/` trang chủ, `/t/:teamId` danh sách dự án, `/p/:projectId` (luồng Kênh), `/p/:projectId/c/:threadId`, `/p/:projectId/v/:videoId`.
  Cột phải: Xem trước (trang video), Tệp, Đầu vào, Nghiên cứu, Cài đặt. Việc đang chạy: nút "Đang chạy" ở đầu trang (agent,
  tool, job; Dừng). `/queue` (việc đang chạy của mọi dự án người xem thấy, slot Claude, máy farm; admin đặt cap và tên AI),
  `/audit` (nhật ký hoạt động), `/stats` (thống kê chat Claude theo nhóm/dự án/video/người; hai màn này cho admin và owner
  nhóm), `/music` (kho nhạc), `/teams`, `/teams/:teamId` (thành viên, skill, thống kê và nhật ký của nhóm; layout quản trị).
  Chọn project ag-go: drawer toàn màn hình dựng lại **y như trang Projects của ag-go-web** (`modules/inputs/ag-go-projects/`:
  sidebar lọc, ô tìm có gợi ý, sort, list/grid, thẻ và CSS chép từ `project-grid-view` của ag-go; `/projects`, lookup và
  `/assets/:id/preview-url` của ag-go gọi thẳng); tick nhiều project qua các trang rồi thêm lần lượt, cái bị từ chối giữ tick và
  báo lý do. Đổi giao diện này thì so với nguồn ag-go-web (`E:\CODE\ag-go-v2\ag-go-web`), đừng tự chế. Picker video: `GET footage`
  + `footage/facets` qua API, chỉ trong các project đã gắn, bảng hoặc lưới (nhớ ở localStorage). `/stats` có thêm bảng **từng
  lượt** (`GET studio/stats/claude/turns[/:id]`; bấm dòng của bảng gộp để lọc, bấm lượt mở drawer chi tiết).
  Tên tool trong chat/nhật ký: `ws.tool.<tên>` ở `ws.vi.ts`/`ws.en.ts` — thêm tool cho agent thì thêm nhãn cả hai ngôn ngữ
  (`agent-chat/labels.spec.ts` đọc tên tool từ engine và báo thiếu). Không bao giờ hiện uuid thay tên video: `inputs_add` bắt
  buộc `name`; nguồn cũ thiếu tên được API đặt lại khi liệt kê nguồn. Biến màu `--ws-*` ở `:root` (drawer/modal là portal).
  Ô chọn nhóm trên thanh trên (`TeamPicker`) có
  "Tạo nhóm mới" và "Quản lý nhóm", gõ để tìm qua `GET /teams?q` (không cắt ở trang đầu); admin Studio thấy thêm "Nhóm
  khác" (nhóm không là thành viên, `isMember: false`), vẫn sửa được như owner, và có dải "Bạn đang xem với quyền admin" ở
  những nhóm đó. Tên nhóm trên breadcrumb và vai lấy từ `GET /teams/:id` (`useTeam`, `useTeamRole` có `ready` để trang
  không nháy chỉ-đọc lúc `/me` chưa về); ai chưa ở nhóm nào thì trang chủ cho tạo nhóm (người tạo là owner). Tiếng Việt gọi là
  **nhóm** (không viết "team" trong chuỗi giao diện).
- Khung trình duyệt nhúng của app desktop báo trang luôn ẩn nên react-query không polling: kiểm bằng khung đó thì tải lại trang.

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
