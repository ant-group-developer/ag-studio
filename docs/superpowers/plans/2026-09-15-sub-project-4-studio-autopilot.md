# Sub-project 4: Studio Autopilot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Studio chạy không cần người: năm gate của kho thành stage `agent` với năm skill, harness "xem" video cho agent bằng stage built-in `watch`, worker studio tự nhận request / tự plan / tự plan lại khi review từ chối.

**Architecture:** Hai workflow mới `style-study@1.1.0`, `library-production@1.1.0` (bản 1.0.0 giữ nguyên; loader đọc `workflows/<id>@<version>/` rồi fallback `workflows/<id>/`); stage built-in `harness media watch` (khuôn `library stage`) trích khung + contact sheet + transcript qua hook `transcribe`; năm skill trong `skills/`; `autoAccept` trong core gọi từ nhánh idle của worker; runtime agent-cli và checker giữ nguyên từ SP3/2B.

**Tech Stack:** Node 22, pnpm workspaces, TypeScript strict ESM NodeNext (`.js` import, `exactOptionalPropertyTypes`), Zod 3 + `pnpm gen:schemas`, Vitest (`vitest.shared.ts` alias; test spawn CLI nạp `dist/` → `pnpm build` trước), ffmpeg/ffprobe trên PATH (test `skipIf(!hasFfmpeg())` từ `tests/media.ts`).

**Spec:** `docs/superpowers/specs/2026-09-15-sub-project-4-studio-autopilot-design.md` (gọi tắt "spec"). Đọc §2 (watch), §3 (workflow), §4 (skill), §5 (auto-accept) trước khi làm task tương ứng.

## Global Constraints

- Harness lõi không gọi yt-dlp/whisper: chỉ hook `transcribe` trong `scripts.yaml` và wrapper `collect-samples` của ops project; test dùng wrapper giả (`FAKE_YTDLP=1` tạo video bằng ffmpeg).
- Workflow `style-study@1.0.0`, `library-production@1.0.0`, fixture và test 2C/3 phải xanh nguyên trạng.
- Agent (stage `agent`) không nhận `HARNESS_SECRET_*`; không mạng trừ skill `style-analyze`; chỉ ghi `output/`.
- Chỉ `transition()`/`claim()` đổi state control plane; auto-accept chỉ dùng `planner.plan/enqueue` + `catalog.createContent`, không ghi state tay.
- Không đụng `D:\`; mọi đường dẫn ghi vào JSON gạch xuôi (`posixPath`).
- `pnpm build && pnpm typecheck && pnpm test` xanh sau **mỗi** task; `pnpm gen:schemas` sau mọi đổi schema.
- Commit: `feat(core|cli|contracts|fixtures): …`, `test: …`, `docs: …`; đúng một dòng cuối `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` — không thay tên model khác; kiểm bằng `git log -1 --format=%B` trước khi báo cáo.
- Bug hiển nhiên trong code của plan: sửa và ghi ledger; chỉ hỏi khi là trade-off thiết kế.

## Bản đồ file

| File | Trách nhiệm | Task |
|---|---|---|
| `packages/contracts/src/media.ts` | `watchIndexSchema` (`harness.watch/v1`) | 1 |
| `packages/contracts/src/library.ts` | `reviewSchema`, `surveyIndexSchema`, `ContentRequest.source_hint` | 1 |
| `packages/contracts/src/config.ts` | `library.auto_accept` | 1 |
| `packages/core/src/orchestration/registry.ts` | `loadWorkflow` nhiều version; `listWorkflowDirs` | 1 |
| `packages/core/src/media/watch.ts` | trích khung, contact sheet, transcript hook | 2 |
| `packages/cli/src/commands/media.ts`, `composition.ts` | `harness media watch`, `builtinMediaCommands` | 3 |
| `packages/cli/src/commands/library-stage.ts`, `library.ts`, `packages/core/src/library/review.ts` | `request_notes` trong brief, `reviewSchema` ở apply-review, `styles activate`, `request create --source-hint/--source-id` | 4 |
| `packages/core/src/library/auto-accept.ts`, `packages/worker/src/worker.ts`, `packages/cli/src/commands/worker.ts`, `packages/core/src/doctor/doctor.ts`, `packages/core/src/dashboard/snapshot.ts` | vòng tự nhận request, doctor, alert | 5 |
| `skills/*/SKILL.md`, `fixtures/fake-agent-cli.mjs`, `fixtures/ops-project-studio/executors/wrappers/{collect-samples,transcribe}.mjs`, `scripts.yaml` | skill + agent giả + wrapper | 6 |
| `workflows/style-study@1.1.0/`, `workflows/library-production@1.1.0/`, `production-profiles/studio/profile.yaml` | workflow + profile | 7 |
| `fixtures/ops-project-studio/project.yaml`, `tests/integration/studio-autopilot.test.ts`, `tests/acceptance/27..32` | tích hợp + acceptance | 8 |
| `docs/runbooks/studio-autopilot.md`, ADR, AGENTS, README, deferred, `project-template` | tài liệu | 9 |

---

### Task 1: Contracts (watch, review, survey, source_hint, auto_accept) + loader workflow nhiều version

**Files:**
- Create: `packages/contracts/src/media.ts`
- Modify: `packages/contracts/src/library.ts`, `packages/contracts/src/config.ts`, `packages/contracts/src/index.ts`, `packages/contracts/scripts/gen-json-schema.ts` (thêm `watch`, `review`, `survey-index`), `packages/core/src/orchestration/registry.ts`, `packages/cli/src/commands/doctor.ts` (quét cả `workflows/<id>@<ver>/`)
- Test: `packages/contracts/test/media-review.test.ts`, `packages/core/test/orchestration/registry-versions.test.ts`

**Interfaces (Produces):**

```ts
// contracts/media.ts
export const watchFrameSchema = z.object({ t: z.number().min(0), file: z.string().min(1), kind: z.enum(["scene", "interval"]) }).strict();
export const watchTranscriptSchema = z.object({ segments: z.array(z.object({ start: z.number().min(0), end: z.number().min(0), text: z.string() }).strict()) }).strict();
export const watchVideoSchema = z.object({
  label: z.string().min(1), source_path: z.string().min(1), duration_seconds: z.number().min(0), media: mediaInfoSchema.nullable(),
  frames: z.array(watchFrameSchema), sheets: z.array(z.string()), transcript: watchTranscriptSchema.nullable(), transcript_error: z.string().optional(),
}).strict();
export const WatchIndexSchema = z.object({ schema_version: schemaVersion("watch"), mode: z.enum(["samples", "source", "episode"]), videos: z.array(watchVideoSchema) }).strict();
export type WatchIndex = z.infer<typeof WatchIndexSchema>; export type WatchVideo = …; export type WatchTranscript = …;

// contracts/library.ts — thêm
export const reviewSchema = z.object({
  schema_version: schemaVersion("review").optional(),          // review.json cũ của gate không có trường này
  decision: z.enum(["approved", "rejected"]), note: z.string().default(""),
  checks: z.array(z.object({ id: z.string().min(1), pass: z.boolean(), note: z.string().default("") }).strict()).default([]),
}).strict();
export const surveyIndexSchema = z.object({
  schema_version: schemaVersion("survey-index"),
  shots: z.array(z.object({ in: z.number().min(0), out: z.number().positive(), score: z.number().int().min(0).max(5), tags: z.array(z.string()).default([]), usable: z.boolean(), note: z.string().default("") }).strict()).min(1),
}).strict();
// ContentRequestSchema thêm:
source_hint: z.object({ source_ids: z.array(idSchema("source_item")).optional(), collection: z.string().regex(/^[a-z][a-z0-9-]*$/).optional() }).strict().optional(),
export type Review = …; export type SurveyIndex = …;

// contracts/config.ts — ProjectConfigSchema.library thêm:
auto_accept: z.object({ enabled: z.boolean().default(true), source_collection: z.string().regex(/^[a-z][a-z0-9-]*$/).default("main"), max_replans: z.number().int().min(0).default(2), max_concurrent_runs: z.number().int().min(1).default(1) }).strict().optional(),

// core/orchestration/registry.ts
export function workflowDir(harnessRoot: string, id: string, version: string): string   // `workflows/<id>@<version>` nếu tồn tại, else `workflows/<id>`
export function loadWorkflow(harnessRoot, ref): LoadedWorkflow   // dùng workflowDir; kiểm version như cũ
export function listWorkflowRefs(harnessRoot: string): string[]   // quét `workflows/*/workflow.yaml`, đọc id@version từ yaml, sort, unique — doctor CLI dùng thay `subdirsWith`
```

- [ ] **Step 1: Test thất bại** — `media-review.test.ts`: `WatchIndexSchema` mẫu hợp lệ (2 video, một transcript null + `transcript_error`); `reviewSchema` nhận `{ decision: "approved" }` (cũ) và bản có `checks`; `surveyIndexSchema` từ chối `shots: []`; `ContentRequestSchema` nhận `source_hint: { collection: "main" }` và từ chối `collection: "Main"`; `ProjectConfigSchema` với `library.auto_accept: {}` → defaults `enabled true, source_collection "main", max_replans 2, max_concurrent_runs 1`; không có `auto_accept` → `undefined`. `registry-versions.test.ts`: harness root temp với `workflows/wf/workflow.yaml` (v1.0.0) và `workflows/wf@1.1.0/workflow.yaml` (v1.1.0) → `loadWorkflow(root,"wf@1.1.0").definition.version === "1.1.0"`, `"wf@1.0.0"` → 1.0.0, `"wf@2.0.0"` → `WORKFLOW_INVALID`; `listWorkflowRefs(root)` → `["wf@1.0.0","wf@1.1.0"]`.
- [ ] **Step 2:** chạy → fail.
- [ ] **Step 3: Triển khai**; `doctor.ts` (cli) thay vòng `subdirsWith(join(harnessRoot,"workflows"),"workflow.yaml")` bằng `listWorkflowRefs(ctx.harnessRoot)`; `pnpm gen:schemas`.
- [ ] **Step 4:** `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(contracts): watch index, review with checks, survey index, request source_hint, library.auto_accept; versioned workflow dirs`.

---

### Task 2: Core `media/watch.ts` — khung, contact sheet, transcript hook

**Files:**
- Create: `packages/core/src/media/watch.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/media/watch.test.ts` (`describe.skipIf(!hasFfmpeg())`, dùng `makeVideo` từ `tests/media.ts` — import tương đối `../../../../tests/media.js`)

**Interfaces (Produces):**

```ts
export type WatchMode = "samples" | "source" | "episode";
export const WATCH_DEFAULTS: Record<WatchMode, { interval_seconds: number; max_frames: number }> = { samples: { interval_seconds: 8, max_frames: 60 }, source: { interval_seconds: 10, max_frames: 120 }, episode: { interval_seconds: 15, max_frames: 80 } };
export interface WatchVideoInput { label: string; path: string; shot_marks?: number[] }   // shot_marks: thêm khung tại các mốc này (kind "scene")
export interface WatchDeps { prober: MediaProber; ffmpeg?: string /* "ffmpeg" */; transcribe?: { argv: string[]; cwd: string; timeout_seconds: number; env?: Record<string, string> }; log?: (level: "info" | "warn", msg: string, data?: Record<string, unknown>) => void }
export interface WatchOptions { mode: WatchMode; outDir: string; interval_seconds?: number; max_frames?: number; scene_threshold?: number /* 0.3 */; frame_width?: number /* 640 */ }
/** ffmpeg select=gt(scene,thr),showinfo → pts_time[] (giây, tăng dần) */
export function detectSceneChanges(ffmpeg: string, path: string, threshold: number): number[]
/** hợp scene + interval, khử trùng trong 1 s, cắt max_frames: thưa mốc interval trước (giữ đều), scene giữ tới khi vẫn vượt thì thưa scene đều */
export function pickFrameTimes(p: { duration: number; scene: number[]; marks: number[]; interval_seconds: number; max_frames: number }): { t: number; kind: "scene" | "interval" }[]
export function frameFileName(t: number): string          // `f-${t.toFixed(1).padStart(7,"0")}.png`  → f-00012.5.png
export async function watchVideos(d: WatchDeps, o: WatchOptions, videos: WatchVideoInput[]): Promise<WatchIndex>
//  với mỗi video: probe (media, duration) → times → ffmpeg -ss t -i path -frames:v 1 -vf scale=W:-2 <outDir>/<label>/frames/<file>
//  → contact sheets: từng nhóm 16 khung → ffmpeg -i f1 … -filter_complex "…tile=4x4" <label>/sheet-NN.png (drawtext nhãn t; nếu ffmpeg báo lỗi drawtext/font thì chạy lại không nhãn và log warn)
//  → transcript: d.transcribe ? spawnSync(argv[0], [...argv.slice(1), "--in", path, "--out", <label>/transcript.json], { cwd, timeout, env }) rồi đọc + parse watchTranscriptSchema; lỗi bất kỳ → transcript null + transcript_error
//  → ghi <outDir>/watch.json (WatchIndexSchema.parse trước khi ghi; file path trong index là tương đối outDir, gạch xuôi)
export function watchFromExistingFrames(o: { mode: "samples"; outDir: string }, groups: { label: string; source_path: string; frames: string[] }[]): WatchIndex   // fixture 2C: dùng ảnh sẵn, t = index*1, kind interval, không sheet, transcript null
```

- [ ] **Step 1: Test thất bại** — `pickFrameTimes` thuần: duration 100, scene [3, 3.5, 40], marks [50], interval 10, max 8 → kết quả sort, không có hai mốc cách <1 s (3.5 bị loại), có 3/40/50 kind scene, tổng ≤ 8, interval được thưa trước scene; `max_frames 2` với 3 scene → 2 scene cách đều. `frameFileName(12.5) === "f-00012.5.png"`. Với ffmpeg: `makeVideo(a, { seconds: 12 })` hai màu (mở rộng `makeVideo` nhận `o.scene_cut_at?: number` để ghép hai màu bằng `-f lavfi` + `concat`; nếu phức tạp, tạo hai video rồi `ffmpeg concat`) → `detectSceneChanges` có một mốc gần `scene_cut_at` ±0.5 s; `watchVideos` mode source với `shot_marks [4]`, `interval 3`, `max_frames 6` → `watch.json` parse được, `frames.length ≤ 6`, có `kind: "scene"` tại ~4, mọi `file` tồn tại, `sheets.length === 1`, `transcript === null`; với `transcribe` giả (`node fixtures/fake-transcribe.mjs` — tạo ở task này trong `packages/core/test/media/fake-transcribe.mjs`: ghi `{ segments: [{ start: 0, end: 1, text: "xin chào" }] }` khi có `--out`; `FAKE_TRANSCRIBE=crash` exit 1) → segments; crash → null + `transcript_error`; `watchFromExistingFrames` với 2 nhóm ảnh giả → index hợp lệ.
- [ ] **Step 2:** chạy → fail.
- [ ] **Step 3: Triển khai** (spawnSync ffmpeg với `timeout` 300 s mỗi lệnh; `scale=640:-2`; thư mục tạo `recursive`).
- [ ] **Step 4:** `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(core): watch — scene/interval frames, contact sheets and transcribe hook for agent stages`.

---

### Task 3: CLI `harness media watch` (stage built-in) + composition

**Files:**
- Create: `packages/cli/src/commands/media.ts`
- Modify: `packages/cli/src/composition.ts` (`builtinMediaCommands`, hợp nhất vào `commands` trước registry ops project; `scriptCommandNames` gồm), `packages/cli/src/main.ts`
- Test: `packages/cli/test/media-watch.test.ts` (spawn CLI; `pnpm build` trước; `skipIf(!hasFfmpeg())`)

**Interfaces (Produces):**

```ts
export function builtinMediaCommands(argv: string[], projectDir: string): Record<string, ScriptCommand>
//  { "watch-samples": { argv: [...argv, "--project", projectDir, "media", "watch", "--mode", "samples"], cwd: "." }, "watch-source": …"source", "watch-episode": …"episode" }
// harness media watch --mode <m>: start({ env }) → withContext → runStage (map lỗi như library-stage):
//  samples: input `sample_set` dir: có samples.json ([{ index|label, path, frames? }]) → nếu mọi path tồn tại → watchVideos(videos = [{ label: label ?? String(index), path }]) ; ngược lại (chỉ ảnh) → watchFromExistingFrames
//  source:  input `proxy_video` + `shots` → watchVideos([{ label: "source", path: proxy, shot_marks: shots[].in }])
//  episode: input `episode_video` → watchVideos([{ label: "episode", path }])
//  transcribe hook: nếu app.scripts?.scripts.transcribe → { argv (giải như scriptCommandsFrom: cwd theo scripts.yaml), cwd, timeout_seconds ?? 900, env: env sạch không HARNESS_SECRET_* } ; log qua sdk.log
//  outDir = <workspace>/output/watch ; sdk.out.dir("output/watch", { type: "watch" }) ; done()
//  thiếu ffmpeg (app.proberAvailable false hoặc spawn ENOENT) → fail contract
```

- [ ] **Step 1: Test thất bại** — project temp (copy `fixtures/ops-project-studio/project.yaml`, migrate), workspace temp với `stage-request.json` dựng tay (run/stage/attempt thật qua `plan`/`enqueue`/`store.claim({ stageRunId })` như `packages/cli/test/publish-stage.test.ts` — có thể dùng workflow `sample-three-stage` chỉ để có run) và inputs: (a) `--mode source` với `proxy.mp4` (makeVideo 12 s) + `shots.json` `{ shots: [{ in: 0, out: 6 }, { in: 6, out: 12 }] }` → `stage-result.json` succeeded, output `watch` dir, `watch.json` hợp lệ, frames tồn tại; (b) `--mode samples` với thư mục `samples/` chỉ có ảnh (kiểu fixture 2C: `0-start.png…`) → index từ ảnh sẵn; (c) `--mode samples` với `samples.json` có `path` video thật → khung trích; (d) `scripts.yaml` khai `transcribe` giả → transcript có segments; (e) `--mode episode` thiếu input → failed `contract`.
- [ ] **Step 2–4:** triển khai; đăng ký `registerMedia` trong `main.ts`; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(cli): harness media watch built-in stage (samples|source|episode)`.

---

### Task 4: Intake `request_notes`, `apply-review` đọc `reviewSchema`, `library styles activate`, `request create --source-hint/--source-id`

**Files:**
- Modify: `packages/cli/src/commands/library-stage.ts` (`intake`, `applyReviewStage`), `packages/cli/src/commands/library.ts`, `packages/core/src/library/review.ts` (`activateStyle`), `packages/core/src/library/requests.ts` (`createRequest` nhận `source_hint`), `packages/contracts/src/library.ts` (`libraryBriefSchema.request_notes?: string`)
- Test: `packages/cli/test/library.test.ts` (thêm), `packages/core/test/library/review.test.ts` (thêm), `packages/core/test/library/requests.test.ts` (thêm)

**Interfaces (Produces):**

```ts
// contracts: libraryBriefSchema thêm request_notes: z.string().optional()
// core/library/review.ts
export function activateStyle(d: LibraryDeps, p: { style_id: string; note?: string }): EditStyle   // studio; đọc styles/<id>/style.json từ kho; draft|retired → active, revision+1, updated_at; active → trả nguyên (idempotent); upsert store
// core/library/requests.ts: createRequest(d, p & { source_hint?: ContentRequest["source_hint"] })
// cli:
//  intake: brief.json = { ...brief, request_notes: request?.notes ?? "", style_snapshot } (đọc request từ kho qua readRequest khi brief.request_id; không có request → "")
//  apply-review: parseReview → reviewSchema.safeParse (chấp nhận review.json cũ); apply-receipt thêm checks_failed: number
//  harness library styles activate <style_id> [--note] [--json]  → activateStyle; role channel → CONFIG_INVALID (assertWritable)
//  harness library request create … [--source-hint <collection>] [--source-id <src_id> …repeatable] → source_hint
```

- [ ] **Step 1: Test thất bại** — core: `activateStyle` draft → active rev 2 và file kho đổi; active → idempotent; `createRequest` với `source_hint` ghi file có trường. cli: `library request create --source-hint main --json` → file `requests/<id>.json` có `source_hint.collection`; `--source-id src_x --source-id src_y` → `source_ids`; `library styles activate <id> --json` trên studio → `status active`; trên channel → exit 1 `CONFIG_INVALID`; stage `intake` chạy tay (như test 2C `library stage intake`) với request có `notes: "lý do cũ"` → `brief.json.request_notes === "lý do cũ"`; `apply-review` với `review.json` có `checks: [{ id: "audio_present", pass: false }]` → item `rejected`, receipt `checks_failed: 1`; review.json cũ `{ decision: "approved" }` vẫn chạy.
- [ ] **Step 2–4:** triển khai; `pnpm gen:schemas` (brief đổi); `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(library): request notes in brief, review checks, styles activate, request source hints`.

---

### Task 5: `autoAccept` trong core, worker `maybeAutoAccept`, doctor, alert dashboard

**Files:**
- Create: `packages/core/src/library/auto-accept.ts`
- Modify: `packages/core/src/index.ts`, `packages/worker/src/worker.ts`, `packages/cli/src/commands/worker.ts`, `packages/cli/src/composition.ts` (`AppContext.library.autoAccept?`), `packages/core/src/doctor/doctor.ts` (+`library:auto_accept`), `packages/core/src/dashboard/snapshot.ts` (+`library.requests_open`, alert `request_stuck`)
- Test: `packages/core/test/library/auto-accept.test.ts`, `packages/worker/test/worker.test.ts` (thêm), `packages/core/test/doctor/doctor.test.ts` (thêm), `packages/core/test/dashboard/snapshot.test.ts` (thêm)

**Interfaces (Produces):**

```ts
export interface AutoAcceptConfig { enabled: boolean; source_collection: string; max_replans: number; max_concurrent_runs: number }
export interface AutoAcceptDeps { store: StateStore; fs: LibraryFs; catalog: SourceCatalog; planner: Planner; clock: Clock; harness: HarnessConfig; projectId: string; portfolioId: string; profile: ProductionProfile; workflows: (ref: string) => LoadedWorkflow; executorVersionFor: (ref: ExecutorRef) => string; requiresResourcesOverride?: (s: StageDefinition) => string[] | undefined; config: AutoAcceptConfig; logger: { info; warn; error } }
export interface AutoAcceptReport { accepted: { request_id: string; run_id: string; replan_no: number; source_id: string }[]; skipped: { request_id: string; reason: "no-style" | "style-inactive" | "run-active" | "exhausted" | "no-source" | "concurrency" | "plan-failed" }[] }
export async function autoAccept(d: AutoAcceptDeps): Promise<AutoAcceptReport>
// Thuật toán (spec §5):
//  active = runs RUNNING|READY|WAITING (listRuns) có content.library_brief.request_id (tập hợp request đang chạy) và đếm runs auto (event "request.auto_accepted" trong listEvents? — đơn giản hơn: đếm run có variant content với library_brief.request_id, không cần phân biệt auto/tay)
//  for request of listContentRequests({ status: "open" }) sort created_at:
//    !style_id → skip no-style; getEditStyle(style_id)?.status !== "active" → style-inactive
//    request đang có run chưa kết thúc → run-active
//    finishedRuns = runs SUCCEEDED|FAILED|CANCELLED của request (qua content.library_brief.request_id); finishedRuns.length > config.max_replans → exhausted (đánh dấu notes `auto-exhausted` một lần qua reopen? KHÔNG sửa request; chỉ event + report)
//    activeCount ≥ max_concurrent_runs → concurrency (dừng vòng)
//    source = pickSource(...) → không có → no-source (event `request.auto_accept_skipped` một lần: lưu trong store? dùng listEvents lọc payload.request_id để không lặp event; skipped vẫn báo cáo)
//    createContent({ source_ids: [source.source_id], title: request.topic, library_brief: { topic, style_id, style_revision, voice, language, target_duration_seconds?, request_id } })
//    variant = catalog.getOrCreateVariant({ content_id, profile, options: { voice: request.voice } })
//    run = planner.plan({ workflow: workflows(profile.workflow_release), profile, harness, projectId, portfolioId, runOverrides: {}, executorVersionFor, requiresResourcesOverride, content, variant }); planner.enqueue(run.run_id)
//    appendEvent request.auto_accepted { request_id, run_id, replan_no: finishedRuns.length, source_id } (EventInput run_id = run.run_id)
//    lỗi plan → event request.auto_accept_failed { reason } + skip plan-failed (không ném)
export function pickSource(store: StateStore, p: { request: ContentRequest; defaultCollection: string; busySourceIds: Set<string> }): SourceItem | undefined
//  source_hint.source_ids → đầu tiên tồn tại (bỏ qua busy không áp dụng — chỉ định rõ thì lấy); else collection = source_hint.collection ?? defaultCollection → listSourceItems({ collection }) lọc rights_status !== "restricted" && !busy, sort ingested_at desc → [0]
//  busySourceIds = source_ids của mọi ContentItem có library_brief.request_id thuộc request open|claimed (trừ request hiện tại)
// worker: WorkerDeps.library thêm autoAccept?: Omit<AutoAcceptDeps, "store"|"fs"|"clock"|"logger"> ; maybeAutoAccept() sau maybeSyncLibrary, cùng stamp lastLibrarySyncAt (chạy ngay sau sync thành công), log report, lỗi log không ném
// doctor: library:auto_accept → không có auto_accept → không hàng; có: ok "enabled, collection <c> (<n> sources)" | fail "collection <c> has no sources" | fail "adapters.agent is fake" ; enabled false → ok "disabled"
// snapshot: library.requests_open (đếm open); alert request_stuck { request_id } cho request open có finishedRuns > max_replans (snapshot nhận autoAccept config qua deps)
```

- [ ] **Step 1: Test thất bại** — `auto-accept.test.ts` với `openTempStore` + kho temp + `SourceCatalog` thật + `Planner` thật + workflow `library-production@1.0.0` (đủ để plan; không chạy): request open + style active + 2 source trong `main` → 1 accepted, run READY sau enqueue, event `request.auto_accepted`, ContentItem có `library_brief.request_id`; gọi lại → skipped `run-active`; request không style → `no-style`; style draft → `style-inactive`; `source_hint.collection: "other"` không có source → `no-source`; `source_hint.source_ids` → đúng source; hai request open + `max_concurrent_runs 1` → 1 accepted + 1 `concurrency`; request có 3 run kết thúc (seed run SUCCEEDED bằng store) + `max_replans 2` → `exhausted`; `pickSource` bỏ source đang bận bởi request khác. worker: `makeWorld` với `library.autoAccept` → `runOnce` idle chạy autoAccept một lần (spy planner.plan gọi 1), lần hai trước `syncSeconds` không gọi. doctor 3 case. snapshot: `requests_open`, `request_stuck`.
- [ ] **Step 2–4:** triển khai; `packages/cli/src/commands/worker.ts` truyền `autoAccept` khi `project.library.role === "studio" && project.library.auto_accept?.enabled`; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(core): studio auto-accept loop (request → source → plan → enqueue, replan cap); worker, doctor and dashboard wiring`.

---

### Task 6: Năm skill, `fake-agent-cli.mjs` mở rộng, wrapper `collect-samples` (URL) và `transcribe`

**Files:**
- Create: `skills/style-analyze/SKILL.md`, `skills/style-review/SKILL.md`, `skills/source-survey/SKILL.md`, `skills/edit-plan/SKILL.md`, `skills/library-review/SKILL.md`, `fixtures/ops-project-studio/executors/wrappers/transcribe.mjs`
- Modify: `fixtures/fake-agent-cli.mjs`, `fixtures/ops-project-studio/executors/wrappers/collect-samples.mjs`, `fixtures/ops-project-studio/executors/scripts.yaml` (+`transcribe`), `tests/integration/library-helpers.ts` (`studioScriptsYaml` giữ nguyên cơ chế)
- Test: `packages/adapters/agent-cli/test/fake-agent-outputs.test.ts` (chạy `fake-agent-cli.mjs` trên workspace giả cho từng skill và validate output bằng schema contracts), `fixtures/ops-project-studio/test/wrappers.test.ts` (nếu fixture có vitest config như footage; không thì đặt trong `tests/integration/studio-wrappers.test.ts`)

**Skill (mỗi file 80–120 dòng, tiếng Việt, khuôn `skills/channel-package/SKILL.md`: Mục tiêu / Input / Ngân sách khung / Quy trình / Cấu trúc output (JSON mẫu) / Tiêu chí tự kiểm / Điều cấm):**
- `style-analyze`: input `watch/` (đọc `watch.json` → mở `sheet-*.png` từng video, khung đơn ≤20), `samples.json`, brief; được web để xác nhận kênh; output `output/style.json` (`harness.edit-style/v1`, `status: draft`, `learned_from` từ samples, `params` đủ trường — chép danh sách trường từ `EditStyleSchema`), `output/evidence/notes.md` (mỗi `params.*` một dòng "video X, t=…: …") + chép ≤8 khung tiêu biểu vào `output/evidence/`.
- `style-review`: input `style.json` draft + `evidence/` + `watch/`; chọn ≥5 khung ngẫu nhiên từ `watch.json` (nêu cách chọn: mỗi video 2 khung cách đều), đối chiếu từng `params`; output `output/style.json` (`status: active` nếu ≤1 mục lệch; giữ `draft` nếu ≥2) + `output/review-notes.md` (bảng mục/đạt/lệch/khung dẫn chứng).
- `source-survey`: input `watch/` source, `shots.json`, `brief.json`; output `output/survey.md` + `output/survey.json` (`harness.survey-index/v1`, mọi shot của `shots.json` có mục, `usable` false khi có chữ/logo/mặt/rung/đen).
- `edit-plan`: input `survey.json`, `survey.md`, `brief.json` (style snapshot, `target_duration_seconds`, `request_notes`), `shots.json`, `watch/`; output `output/edl.json` (`harness.edl/v1`, chỉ shot usable, `source_id` từ `shots.json`, tổng thời lượng trong khoảng đích — nếu brief không có khoảng thì dùng `content.target_duration_seconds` của profile nếu `stage-request.json.policy` có, ngược lại 60–180 s), `output/edit-plan.json` `{ schema_version: "harness.edit-plan/v1", opening: {…}, text_overlays: [], music: {}, notes: "<cách khắc phục request_notes nếu có>" }` (đây là JSON tự do như 2C, không schema chặn), `output/narration.txt`.
- `library-review`: input `watch/` (episode), `edit-plan.json`, `brief.json`, `export-receipt.json`, `thumbnail_set`; output `output/review.json` (`harness.review/v1`, `checks` đúng 6 id cố định: `duration_in_range`, `no_black_or_frozen_over_2s`, `opening_matches_style`, `text_not_clipped`, `audio_present`, `thumbnails_textless`; `decision` = `rejected` khi ≥1 `pass:false`, `note` nêu mốc giây).

**`fake-agent-cli.mjs`** thêm nhánh theo `eo.type`: `style` → EditStyle hợp lệ (`status` = `FAKE_STYLE_STATUS ?? (mode "style-active" ? "active" : "draft")`; ở stage `style-review` (nhận input type `style`) mặc định `active`, env `FAKE_STYLE_REVIEW=keep-draft` giữ draft); `style_evidence`/`review_notes` → thư mục có `notes.md` / file md; `survey` → md; `survey_index` → từ input `shots` (đọc `shots.json`, mọi shot `score 4, usable true`); `edl` → từ `shots.json` (mỗi shot một entry, `source_id` của shots.json, `order` tăng, tổng đúng thời lượng source — nếu brief có `target_duration_seconds` thì cắt `out` để tổng nằm trong khoảng); `edit_plan` → `{ schema_version: "harness.edit-plan/v1", notes: "" }`; `narration` → chuỗi rỗng; `review` → theo `FAKE_REVIEW_MODE` (`approve` mặc định; `reject-once`: `rejected` khi `brief.json.request_notes` rỗng, `approved` khi có; `reject-always`) với `checks` 6 mục; mọi nhánh ghi cả thư mục output `kind: directory` có ít nhất một file thật. `brief.json` tìm qua `inputs[].type === "brief"`.

**Wrapper:** `collect-samples.mjs` — mỗi dòng `samples.txt`: URL `^https?://` → nếu `process.env.FAKE_YTDLP === "1"` tạo `samples/dl-<i>.mp4` 6 s bằng ffmpeg `lavfi testsrc`; ngược lại spawn `yt-dlp -f "bv*[height<=480]+ba/b" -o <samples>/dl-<i>.%(ext)s <url>` (tool path từ env `YTDLP_PATH ?? "yt-dlp"`; lỗi → `ctx.fail("transient")`); cục bộ → dùng tại chỗ; ghi `samples.json` `[{ index, label: "s<i>", path, url?, frames }]` (giữ 3 khung cũ). `transcribe.mjs --in <media> --out <json>`: nếu có `<media>.txt` cạnh → segments 1 dòng/segment (5 s mỗi dòng), ngược lại `{ segments: [] }`; `FAKE_TRANSCRIBE=crash` → exit 1. `scripts.yaml` thêm `transcribe: { argv: [node, executors/wrappers/transcribe.mjs], timeout_seconds: 300 }`.

- [ ] **Step 1: Test thất bại** — `fake-agent-outputs.test.ts`: với mỗi skill dựng workspace `stage-request.json` (expected_outputs đúng như workflow Task 7 sẽ khai, inputs giả: `shots.json` 2 shot với `source_id` hợp lệ, `brief.json` với `target_duration_seconds [1, 20]`, `style` draft) chạy `node fixtures/fake-agent-cli.mjs` → validate: `EditStyleSchema`, `surveyIndexSchema`, `EdlSchema` (+ tổng thời lượng trong khoảng), `reviewSchema` (6 checks; `reject-once` với/không `request_notes`), file md tồn tại; `SKILL.md` của 5 skill tồn tại, có các mục bắt buộc (grep heading). Wrapper: `collect-samples` với `FAKE_YTDLP=1` và samples.txt gồm 1 URL + 1 file → `samples.json` 2 mục có `label`, video tải giả tồn tại; `transcribe.mjs` với `.txt` cạnh → segments; crash → exit 1.
- [ ] **Step 2–4:** triển khai; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat: five studio skills; fake agent CLI covers style/survey/edl/review; collect-samples downloads URLs via wrapper; transcribe hook fixture`.

---

### Task 7: Workflow `style-study@1.1.0`, `library-production@1.1.0`, profile `studio` revision 2

**Files:**
- Create: `workflows/style-study@1.1.0/workflow.yaml`, `workflows/library-production@1.1.0/workflow.yaml`
- Modify: `production-profiles/studio/profile.yaml` (`revision: 2`, `workflow_release: library-production@1.1.0`, `limits.max_cost_usd_per_variant: 8`)
- Test: `packages/core/test/orchestration/studio-workflows-1-1.test.ts`

```yaml
# workflows/style-study@1.1.0/workflow.yaml
schema_version: harness.workflow/v1
id: style-study
version: 1.1.0
defaults: {}
stages:
  - key: collect-samples
    executor: { type: script, script: collect-samples }
    requires_resources: [cpu]
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: sample_set, mime_type: application/x-directory, kind: directory, name: samples }
  - key: watch-samples
    executor: { type: script, script: watch-samples }
    depends_on: [collect-samples]
    requires_resources: [cpu]
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: watch, mime_type: application/x-directory, kind: directory, name: watch }
  - key: analyze-style
    executor: { type: agent, skill: style-analyze, brief: "Xem watch/ (contact sheet + khung đơn + transcript nếu có) của các video mẫu, viết output/style.json (harness.edit-style/v1, status draft) và output/evidence/ (khung tiêu biểu + notes.md dẫn chứng từng tham số)." }
    depends_on: [watch-samples, collect-samples]
    retry: { max_attempts: 2, backoff_seconds: [60], retry_on: [transient, abandoned] }
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: style, mime_type: application/json, name: style.json }
      - { type: style_evidence, mime_type: application/x-directory, kind: directory, name: evidence }
  - key: style-review
    executor: { type: agent, skill: style-review, brief: "Đối chiếu style.json với ≥5 khung trong watch/. Đạt → ghi output/style.json với status active; lệch ≥2 tham số → giữ draft. Luôn ghi output/review-notes.md." }
    depends_on: [analyze-style, watch-samples]
    retry: { max_attempts: 2, backoff_seconds: [60], retry_on: [transient, abandoned] }
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: style, mime_type: application/json, name: style.json }
      - { type: review_notes, mime_type: text/markdown, name: review-notes.md }
  - key: style-export
    executor: { type: script, script: library-style-export }
    depends_on: [style-review, analyze-style]
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: export_receipt, mime_type: application/json, name: export-receipt.json }
```

`workflows/library-production@1.1.0/workflow.yaml`: chép `workflows/library-production/workflow.yaml` (1.0.0) rồi: `version: 1.1.0`; sau `index-source` thêm `watch-source` (script `watch-source`, `depends_on: [index-source]`, `requires_resources: [cpu]`, output `{ type: watch, kind: directory, name: watch }`); `survey-source` → `executor: { type: agent, skill: source-survey, brief: "Chấm từng shot trong shots.json bằng watch/ theo brief.json; ghi output/survey.md và output/survey.json (harness.survey-index/v1)." }`, `depends_on: [watch-source, index-source, intake]`, bỏ `gate_deadline_seconds`, thêm `retry` như trên, outputs thêm `{ type: survey_index, mime_type: application/json, name: survey.json }`; `plan-edit` → agent `edit-plan` (brief: "Từ survey.json/survey.md, brief.json (style, thời lượng đích, request_notes) và shots.json, viết output/edl.json (harness.edl/v1), output/edit-plan.json, output/narration.txt."), `depends_on: [survey-source, watch-source, intake]`, giữ `required_checks` có `edl-valid`; sau `assemble` thêm `watch-episode` (script `watch-episode`, `depends_on: [assemble]`, output type `watch`); `library-review` → agent `library-review` (brief: "Soi bản dựng qua watch/ (episode), đối chiếu edit-plan.json và brief.json; ghi output/review.json (harness.review/v1) với 6 checks cố định; ≥1 fail → rejected."), `depends_on: [watch-episode, library-export, plan-edit, intake]`, bỏ `gate_deadline_seconds`, thêm `retry`; các stage còn lại nguyên.

- [ ] **Step 1: Test thất bại** — `loadWorkflow(HARNESS_ROOT, "style-study@1.1.0")` 5 stage đúng thứ tự, `analyze-style`/`style-review` là `agent` với skill đúng; `library-production@1.1.0` 13 stage đúng thứ tự (`intake, index-source, watch-source, survey-source, plan-edit, tts, cut, assemble, watch-episode, thumbnail-candidates, library-export, library-review, library-apply-review`), không stage nào `gate`, `resolveStageGraph` với `voice=none` bỏ `tts`; `loadWorkflow(…, "library-production@1.0.0")` vẫn có gate (không đổi); `loadProfile("studio").workflow_release === "library-production@1.1.0"`, `revision 2`.
- [ ] **Step 2–4:** viết YAML; test; `pnpm test` (test 2C dùng `library-production@1.0.0` qua `--workflow` tường minh — kiểm `tests/integration/library-pipeline.test.ts` và acceptance 17–20: nếu chúng lấy workflow từ profile `studio` thì sửa test truyền `--workflow library-production@1.0.0` rõ ràng, không đổi hành vi test).
- [ ] **Step 5: Commit** — `feat: style-study@1.1.0 and library-production@1.1.0 with agent stages and watch; studio profile revision 2`.

---

### Task 8: Fixture studio autopilot, test tích hợp, acceptance 27–32

**Files:**
- Modify: `fixtures/ops-project-studio/project.yaml` (`library.auto_accept: { enabled: true, source_collection: main, max_replans: 2, max_concurrent_runs: 1 }`, `adapters: { agent: cli, agent_argv: [node, ../fake-agent-cli.mjs, "{prompt}"] }` — helper ghi đè tuyệt đối), `tests/integration/library-helpers.ts` (`freshLibraryWorld` thêm tùy chọn `{ autopilot?: boolean }` ghi `agent_argv` tuyệt đối + `FAKE_YTDLP=1`; giữ hành vi cũ khi không truyền)
- Create: `tests/integration/studio-autopilot.test.ts`, `tests/acceptance/27-review-reject-once-replans.test.ts`, `28-review-reject-cap-request-stuck.test.ts`, `29-agent-no-output-parks-not-replans.test.ts`, `30-watch-frames-and-transcript.test.ts`, `31-no-secret-in-studio-agent-stages.test.ts`, `32-workflow-1-0-0-still-runs.test.ts`

**Helper bổ sung (`library-helpers.ts`):**
```ts
export function freshLibraryWorld(o?: { media?: boolean; autopilot?: boolean }): LibraryWorld   // autopilot: studio project.yaml có auto_accept + adapters.agent cli/agent_argv tuyệt đối; scripts.yaml có transcribe
export function studioEnv(world, extra?: Record<string,string>): Record<string,string>   // { FAKE_YTDLP: "1", ...extra } dùng cho cli()/drain()
export function requestCreate(world, o: { topic: string; style: string; sourceHint?: string; voice?: string }): string   // channel: library request create --json → request_id
export function studioWorkerUntil(world, pred: () => boolean, max = 60, env?): void   // lặp `worker --once` (studio) tới khi pred() đúng hoặc hết max; mỗi vòng `library sync` không cần (worker tự sync)
export function requestStatus(world, id): ContentRequest   // đọc file kho
```

- [ ] **Step 1: `studio-autopilot.test.ts`** (`describe.skipIf(!hasFfmpeg())`, 600 s): `freshLibraryWorld({ media: true, autopilot: true })`; (1) style-study: `samples.txt` = sample cục bộ + `https://example.invalid/v1` → `source ingest` → `content create` → `plan --workflow style-study@1.1.0 --profile studio --content` → `enqueue` → `drain(studio, studioEnv)` → run SUCCEEDED, kho có style `active`, `watch/` của `watch-samples` có 2 video với frames; (2) `library sync` channel → `requestCreate(topic, style, sourceHint "main")` → `studioWorkerUntil(() => requestStatus(id).status === "fulfilled")` với `FAKE_REVIEW_MODE=approve` → item `approved`, run 13 stage SUCCEEDED, `watch/` của source và episode hợp lệ (`frames.length ≤ max_frames`), event `request.auto_accepted` có `replan_no: 0`; channel `pick` ok; không lệnh nào ở studio ngoài `worker --once` (helper chỉ gọi worker/sync); (3) `harness doctor` studio có hàng `library:auto_accept` ok.
- [ ] **Step 2: Acceptance**
  - **27**: `FAKE_REVIEW_MODE=reject-once` → `studioWorkerUntil(fulfilled)`: hai run kết thúc cho request (đếm ContentItem với `library_brief.request_id`), run 1 item `rejected`, run 2 `approved`; event `request.auto_accepted` với `replan_no` 0 và 1; `brief.json` của run 2 có `request_notes` không rỗng.
  - **28**: `reject-always`, `max_replans: 1` (ghi project.yaml) → sau đủ vòng: đúng 2 run kết thúc, request vẫn `open`, `dashboard snapshot --json` có alert `request_stuck` với `request_id`; thêm 5 vòng worker → không run thứ ba.
  - **29**: `FAKE_AGENT_MODE=no-output` chỉ khi `HARNESS_STAGE_KEY === "survey-source"` (fake agent đọc `stage-request.json.stage_key`; mở rộng: env `FAKE_AGENT_FAIL_STAGE=survey-source` → mode no-output cho stage đó) → sau các vòng: stage `survey-source` WAITING_HUMAN sau 2 attempt (kiểm `status --json`), run WAITING, request `claimed`, **không** có ContentItem thứ hai cho request.
  - **30**: `harness media watch` qua stage (dùng run của test 27 hoặc chạy tay như Task 3): `watch.json` của `watch-source` có `frames.length ≤ 120`, có ít nhất một `kind: "scene"` khi source là video hai màu (`makeVideo` với `scene_cut_at`), `transcript === null` khi `scripts.yaml` không có `transcribe`; thêm `transcribe` giả + `.txt` cạnh proxy? (proxy là output của index-source — đặt `.txt` không được) → dùng `--mode samples` với video có `.txt` cạnh → segments ≥1.
  - **31**: chạy chuỗi như (2) với `HARNESS_SECRET_X_Y=s3cret` trong env studio: grep `data/workspaces/**` (`agent-prompt.md`, `logs/*.log`, `stage-result.json`) và `events --json` không chứa `s3cret` và không chứa `HARNESS_SECRET_`.
  - **32**: `freshLibraryWorld({ media: true })` (không autopilot) chạy `library-production@1.0.0` bằng đường 2C (`library accept` + `plan --workflow library-production@1.0.0` + gate `submitGate`) tới `library-export` SUCCEEDED — bằng chứng workflow cũ còn chạy với profile mới (profile `studio` rev 2 vẫn hợp lệ cho 1.0.0 qua `--workflow` tường minh). Nếu `tests/integration/library-pipeline.test.ts` đã chứng minh điều này sau Task 7, acceptance 32 chỉ khẳng định `loadWorkflow("library-production@1.0.0")` có gate và test đó tồn tại (assert bằng `existsSync`) — ghi rõ trong file.
- [ ] **Step 3:** `pnpm build && pnpm test`; không media/data trong repo.
- [ ] **Step 4: Commit** — `test: studio autopilot integration (style-study 1.1.0, request → approved item without human); acceptance 27-32`.

---

### Task 9: Tài liệu và báo cáo

**Files:** Create `docs/runbooks/studio-autopilot.md`; Modify `AGENTS.md` (mục "Lệnh 4 (studio tự vận hành)": `media watch`, `library styles activate`, `request create --source-hint`, cờ `auto_accept`, quy tắc agent stage), `README.md` (trạng thái + quick-start autopilot), `docs/adr/0001-control-plane-baseline.md` (mục 81+ "Sub-project 4": workflow nhiều version cùng thư mục; `watch` là built-in vì cần ffmpeg + hợp đồng ảnh; 5 skill thay gate; review có `checks[]`; auto-accept không claim request (intake claim); `max_replans` đếm run kết thúc; source chọn theo quy tắc, không agent), `docs/operations/deferred-items.md` ("Sau sub-project 4" từ ledger + spec §10), `project-template/project.yaml` (khối `auto_accept` comment), `project-template/executors/scripts.yaml` (`transcribe` comment).

- [ ] **Step 1: Runbook** `studio-autopilot.md`: (1) điều kiện máy studio (ffmpeg, `claude`/`codex` trên PATH, yt-dlp nếu dùng URL, whisper tùy chọn qua `transcribe`), (2) bật `auto_accept`, (3) chu trình: channel tạo request → studio worker tự chạy → item `approved` → channel pick; theo dõi bằng `library list requests`, `status`, dashboard, (4) style-study 1.1.0 với samples.txt (URL/cục bộ) và khi `style-review` giữ draft (`library styles activate`), (5) khi stage agent WAITING_HUMAN (đọc `logs/agent-stdout.log`, sửa input, `retry`), (6) `request_stuck` (đọc note từ chối, đổi source_hint, nới `max_replans`), (7) chi phí (contact sheet, `max_cost_usd_per_variant`), (8) quay về workflow 1.0.0 (gate người) bằng `--workflow` hoặc profile riêng, (9) DoD #3: kết quả chạy agent thật một tập (bảng trống nếu máy build không có CLI, ghi rõ).
- [ ] **Step 2:** ADR/AGENTS/README/deferred/template như trên.
- [ ] **Step 3:** `pnpm build && pnpm typecheck && pnpm test`; chạy tay quick-start trên fixture; dọn `fixtures/**/data`, `library/`, `raw/`, `samples/`.
- [ ] **Step 4: Commit** — `docs: studio autopilot runbook, ADR 81+, AGENTS/README, project template for sub-project 4`.
- [ ] **Step 5:** Báo cáo trong chat: DoD spec §8 từng mục (bảng item → bằng chứng → trạng thái); điều để lại (SP3B; agent chọn source; whisper built-in).

---

## Tự rà soát plan 4

**Phủ spec:** §0 → toàn bộ; §1.1 → Task 1, 2, 3, 5, 6, 7, 9; §1.2 loader → Task 1; §1.3 `auto_accept` → Task 1, 5, 8; §1.4 hook `transcribe` → Task 2, 3, 6; §2 watch → Task 2, 3 (+ acceptance 30); §2.3 hợp đồng agent → Task 6 (skill), 7 (brief/retry); §3.1/§3.2 → Task 7; §4 skill + `reviewSchema`/`surveyIndexSchema` → Task 1, 4, 6; §5 auto-accept + `source_hint` + `styles activate` + doctor + alert → Task 1, 4, 5; §6 lỗi → Task 2 (transcribe), 3 (ffmpeg contract), 5 (plan-failed, exhausted), 7 (retry agent); §7 test → Task 2, 3, 5, 6, 8; §8 DoD → Task 8, 9; §9/§10 → Task 9 (deferred).

**Nhất quán kiểu:** `WatchIndex`/`WatchIndexSchema` (Task 1) dùng ở 2, 3, 8; `watchVideos`/`watchFromExistingFrames` (2) dùng ở 3; script built-in `watch-samples|watch-source|watch-episode` (3) khớp workflow (7); output type `watch`, `survey_index`, `review_notes`, `style_evidence` khớp giữa workflow (7), fake agent (6), skill (6); `reviewSchema` (1) dùng ở 4 (apply-review) và 6 (fake); `surveyIndexSchema` (1) dùng ở 6; `ContentRequest.source_hint` (1) dùng ở 4 (CLI) và 5 (`pickSource`); `activateStyle` (4) dùng ở CLI 4 và runbook 9; `autoAccept`/`AutoAcceptDeps` (5) nối worker 5 và test 8; `FAKE_REVIEW_MODE`, `FAKE_YTDLP`, `FAKE_TRANSCRIBE`, `FAKE_AGENT_FAIL_STAGE` (6, 8) nhất quán.

**Điểm chú ý khi thực thi:**
- Task 1 đổi `loadWorkflow` tìm thư mục có `@` — trên Windows tên thư mục có `@` hợp lệ; `listWorkflowRefs` phải bỏ qua thư mục không có `workflow.yaml`.
- Task 7 nâng profile `studio` sang 1.1.0 làm test 2C dùng `plan --profile studio` không truyền `--workflow`? — `plan` yêu cầu `--workflow` tường minh nên test 2C vẫn trỏ 1.0.0; nhưng `catalog.getOrCreateVariant` dùng `profile.revision` trong `variant` → variant mới, cache không ảnh hưởng test.
- Task 5: `autoAccept` cần `profile` — lấy `loadProfile(harnessRoot, "studio")`; cho phép `library.auto_accept.profile_id` mặc định `"studio"` nếu muốn tổng quát (bổ sung nhỏ, ghi ledger).
- `fake-agent-cli.mjs` giờ phục vụ 6 skill: giữ một file nhưng tách hàm theo type; nếu vượt ~250 dòng thì báo DONE_WITH_CONCERNS, không tự chia.
- Acceptance 29 cần fake agent biết `stage_key`: `stage-request.json.stage_key` có sẵn.
