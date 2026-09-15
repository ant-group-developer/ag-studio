# Sub-project 3B: Channel Learning Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kênh tự thu số liệu sau 72 h, đánh giá giả thuyết của từng gói, học "chuẩn kênh" bằng quy tắc thuần, đưa ngữ cảnh kênh + chuẩn vào stage `package` qua `channel-brief`, tự sinh `ContentRequest` khi thiếu tập (agent đề xuất chủ đề) và tự pick item approved — không lệnh người ngoài `worker`.

**Architecture:** Cổng `StatsCollector` (adapter `youtube-playwright` với `scripts/collect-stats.mjs` chỉ đọc + `FakeStatsCollector`); bảng `video_metrics` (append-only) và `channel_learned`; module core `packages/core/src/learning/` gồm hàm thuần (`collectDue`, `evaluateHypotheses`, `learnChannelStandard`, `channelDemand`) và ba sweep (`collectStats`, `planRequests`, `autoPick`) gọi từ nhánh idle của worker kênh; workflow `channel-publish@1.1.0` (thêm stage built-in `channel-brief`) và `channel-planning@1.0.0` (`channel-brief` → `demand` → agent `propose-topics` → `create-requests`); skill `channel-plan` mới, skill `channel-package` sửa để đọc `channel-brief.json`.

**Tech Stack:** Node 22, pnpm workspaces, TypeScript strict ESM NodeNext (`.js` import, `exactOptionalPropertyTypes`), Zod 3 + `pnpm gen:schemas`, Vitest (`vitest.shared.ts`; test spawn CLI nạp `dist/` → `pnpm build` trước), ffmpeg cho test tích hợp (`skipIf(!hasFfmpeg())`).

**Spec:** `docs/superpowers/specs/2026-09-15-sub-project-3b-channel-learning-design.md` ("spec"). Đọc §2 (số liệu), §3 (học), §4 (planning/auto-pick) trước task tương ứng.

## Global Constraints

- Không lệnh người ở kênh ngoài `worker` cho chu trình request → pick → phát → thu số → học; mọi việc agent làm là run.
- Phần học là hàm thuần trong core (`evaluateHypotheses`, `learnChannelStandard`, `channelDemand`), test không cần ffmpeg/agent.
- `hypothesis.status`/`hypothesis.evaluated` cập nhật tại chỗ trong `channel_package` qua `updateChannelPackage` (mirror-kiểu); `video_metrics` append-only; sweep không ném, lỗi log + event.
- Collector chỉ đọc Studio; env con không `HARNESS_SECRET_*`; log qua Redactor; không Chrome trong test.
- `channel-publish@1.0.0`, `channel-planning` không có gate; mọi test SP3/SP4 xanh nguyên trạng; profile enum thêm `channel-planning`.
- Workflow versioned dirs (`workflows/<id>@<version>/`) như SP4; `channel-publish@1.1.0` copy 1.0.0 + stage `channel-brief`.
- `pnpm gen:schemas` sau mọi đổi schema; `pnpm build && pnpm typecheck && pnpm test` xanh sau **mỗi** task.
- Commit `feat(...)`/`fix(...)`/`test:`/`docs:`; đúng một dòng cuối `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` — không thay tên model; kiểm bằng `git log -1 --format=%B`.
- Bug hiển nhiên trong plan: sửa và ghi ledger; hỏi chỉ khi là trade-off thiết kế.

## Bản đồ file

| File | Trách nhiệm | Task |
|---|---|---|
| `packages/contracts/src/learning.ts`, `config.ts`, `distribution.ts`, `ids.ts`, `interfaces.ts` | schema số liệu/chuẩn kênh/brief/topic, `StatsCollector`, config kênh/project, `Hypothesis.evaluated` | 1 |
| `migrations/0005_learning.sql`, `packages/core/src/state/sqlite-store.ts` | `video_metrics`, `channel_learned` | 1 |
| `packages/adapters/youtube-playwright/{src/metrics-parse.ts,src/playwright-stats-collector.ts,scripts/collect-stats.mjs}`, `packages/adapters/fake/src/fake-stats-collector.ts`, `packages/cli/src/composition.ts` | cổng thu số | 2 |
| `packages/core/src/learning/{metrics,hypotheses,learned}.ts` | `collectDue`, `collectStats`, `importMetrics`, `evaluateHypotheses`, `learnChannelStandard` | 3 |
| `packages/core/src/learning/{planning,auto-pick,checkers,brief}.ts` | `channelDemand`, `planRequestsRun`, `autoPick`, `topics-valid`, `buildChannelBrief` | 4 |
| `packages/cli/src/commands/publish-stage.ts`, `workflows/channel-publish@1.1.0/`, `workflows/channel-planning@1.0.0/`, `production-profiles/{channel,channel-planning}/`, `skills/channel-plan/`, `skills/channel-package/`, `fixtures/fake-agent-cli.mjs` | stage built-in, workflow, skill, agent giả | 5 |
| `packages/worker/src/worker.ts`, `packages/cli/src/commands/{worker,channel}.ts`, `packages/core/src/doctor/doctor.ts`, `packages/core/src/dashboard/snapshot.ts` | sweep, CLI, doctor, dashboard | 6 |
| `fixtures/ops-project-channel/`, `tests/integration/channel-learning.test.ts`, `tests/acceptance/33..40` | tích hợp + acceptance | 7 |
| `docs/runbooks/channel-learning.md`, ADR, AGENTS, README, deferred, template | tài liệu | 8 |

---

### Task 1: Contracts, config, migration `0005_learning.sql`, store

**Files:**
- Create: `packages/contracts/src/learning.ts`, `migrations/0005_learning.sql`
- Modify: `packages/contracts/src/config.ts` (channel `learning|planning|auto_pick`; project `learning`, `adapters.stats`; profile enum `channel-planning`), `packages/contracts/src/distribution.ts` (`HypothesisSchema.evaluated?`), `packages/contracts/src/ids.ts` (`video_metrics: "metric"`), `packages/contracts/src/interfaces.ts` (`StatsCollector`, `StatsOutcome`, `StateStore` methods), `packages/contracts/src/index.ts`, `packages/contracts/scripts/gen-json-schema.ts` (+`video-metrics`, `channel-learned`, `channel-brief`, `topic-proposal`), `packages/core/src/state/sqlite-store.ts`
- Test: `packages/contracts/test/learning.test.ts`, `packages/core/test/state/learning-store.test.ts`

**Interfaces (Produces):**

```ts
// contracts/learning.ts
export const VideoMetricsSchema = z.object({
  schema_version: schemaVersion("video-metrics"), metric_id: idSchema("video_metrics"),
  publication_job_id: idSchema("publication_job"), channel_id: z.string().min(1), video_id: z.string().min(1),
  collected_at: timestampSchema, age_hours: z.number().min(0), source: z.enum(["studio", "manual"]),
  views: z.number().int().min(0), impressions: z.number().int().min(0).nullable(), ctr_pct: z.number().min(0).max(100).nullable(),
  avg_view_sec: z.number().min(0).nullable(), retention30_pct: z.number().min(0).max(100).nullable(),
}).strict();
export const TITLE_PATTERN_LABELS = ["number", "plain", "question", "statement", "long", "short"] as const;   // ghép: `${number|plain}+${question|statement}+${long|short}`
export const ChannelLearnedSchema = z.object({
  schema_version: schemaVersion("channel-learned"), channel_id: z.string().min(1), updated_at: timestampSchema, sample_size: z.number().int().min(0),
  metric: z.enum(["ctr", "views_72h", "avg_view_pct"]).nullable(),                      // metric của kênh (phổ biến nhất)
  medians: z.object({ views_72h: z.number().nullable(), ctr_pct: z.number().nullable(), avg_view_pct: z.number().nullable() }).strict(),
  winners: z.object({ angles: z.array(groupStat), title_patterns: z.array(groupStat), overlay: z.array(groupStat) }).strict(),   // groupStat = { value: string, supported: int, refuted: int, lift: number }
  standard: z.object({ angle: z.string().optional(), title_pattern: z.string().optional(), overlay_lines: z.enum(["0", "1-2", "3"]).optional(), note: z.string().default("") }).strict(),
  history: z.array(z.object({ at: timestampSchema, standard: z.object({ angle: z.string().optional(), title_pattern: z.string().optional(), overlay_lines: z.enum(["0","1-2","3"]).optional() }).strict() }).strict()).max(20).default([]),
}).strict();
export const ChannelBriefSchema = z.object({
  schema_version: schemaVersion("channel-brief"), generated_at: timestampSchema,
  channel: z.object({ channel_id, display_name, seo: <seo object của ChannelConfigSchema — export `channelSeoSchema` từ config.ts và tái dùng>, publication: z.object({ timezone, publish_times: z.array(z.string()) }).strict() }).strict(),
  learned: ChannelLearnedSchema.nullable(),
  hypotheses: z.array(z.object({ hypothesis_id, episode_no: int, chosen: z.object({ title, angle, overlay_text: z.array(z.string()) }).strict(), expected: <HypothesisSchema.shape.expected>, status: z.enum([...]), metric_value: z.number().optional() }).strict()).max(10),
  recent_metrics: z.array(z.object({ episode_no: int, title, views: int, impressions: int|null, ctr_pct: number|null, avg_view_sec: number|null, age_hours: number }).strict()).max(10),
  open_requests: z.array(z.object({ request_id, topic, status: z.enum(["open", "claimed"]) }).strict()),
  item: z.object({ item_id, title_hint, summary, duration_seconds }).strict().nullable(),
}).strict();
export const TopicProposalSchema = z.object({
  schema_version: schemaVersion("topic-proposal"),
  topics: z.array(z.object({ topic: z.string().min(8), angle: z.string().default(""), why: z.string().min(1), style_id: idSchema("edit_style").optional(), voice: z.enum(["none","tts","original"]).optional(), target_duration_seconds: z.tuple([z.number().min(0), z.number().min(0)]).optional(), source_hint: z.object({ collection: z.string().regex(/^[a-z][a-z0-9-]*$/).optional() }).strict().optional() }).strict()).min(1),
}).strict();
export const DemandSchema = z.object({ schema_version: schemaVersion("demand"), channel_id, needed: int ≥0, slots: z.array(timestampSchema), covered: z.object({ jobs: int, runs: int, items: int, requests: int }).strict(), open_requests: int, max_open_requests: int }).strict();
export type VideoMetrics, ChannelLearned, ChannelBrief, TopicProposal, Demand

// interfaces.ts
export type StatsOutcome = { kind: "ok"; views: number; impressions?: number; ctr_pct?: number; avg_view_sec?: number; retention30_pct?: number; note?: string } | { kind: "no-views" } | { kind: "blocked"; reason: string } | { kind: "error"; reason: string };
export interface StatsCollector { readonly name: string; collect(p: { channel: PublisherChannel; video_id: string; timeout_seconds: number; log?: (line: string) => void }): Promise<StatsOutcome> }
// StateStore thêm:
insertVideoMetrics(m: VideoMetrics): void; listVideoMetrics(filter: { publication_job_id?: string; channel_id?: string }): VideoMetrics[];   // ORDER BY collected_at
upsertChannelLearned(l: ChannelLearned): void; getChannelLearned(channelId: string): ChannelLearned | undefined;

// distribution.ts HypothesisSchema thêm: evaluated: z.object({ at: timestampSchema, metric_value: z.number(), metric_id: idSchema("video_metrics") }).strict().optional()
// config.ts ChannelConfigSchema thêm (mọi khối .strict().default({...}) để channel.yaml cũ parse):
learning: { horizon_hours: int ≥1 default 72, recollect_hours: z.array(int ≥1).default([168, 720]), min_impressions: int ≥0 default 50, min_samples: int ≥1 default 2 }
planning: { enabled: bool default false, lookahead_slots: int ≥1 default 3, topics_per_run: int ≥1 default 3, max_open_requests: int ≥1 default 3, check_seconds: int ≥60 default 3600 }
auto_pick: { enabled: bool default false, max_concurrent_runs: int ≥1 default 1 }
// ProjectConfigSchema: learning: { collect_seconds: int ≥60 default 1800, collect_batch: int ≥1 default 5 } .default; adapters.stats: z.enum(["playwright","fake"]).default("fake")
// ProductionProfileSchema/RefSchema profile_id enum + "channel-planning"
```

```sql
-- migrations/0005_learning.sql
-- Append-only snapshots read from YouTube Studio (or imported from the legacy channel-metrics.jsonl); never updated.
CREATE TABLE video_metrics (id TEXT PRIMARY KEY, publication_job_id TEXT NOT NULL, channel_id TEXT NOT NULL, collected_at TEXT NOT NULL, age_hours REAL NOT NULL, data TEXT NOT NULL);
CREATE INDEX video_metrics_job_idx ON video_metrics(publication_job_id, age_hours);
CREATE INDEX video_metrics_channel_idx ON video_metrics(channel_id, collected_at);
-- One learned standard per channel, rewritten by learnChannelStandard; not control-plane state.
CREATE TABLE channel_learned (channel_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
```

- [ ] **Step 1: Test thất bại** — contracts: mẫu hợp lệ của 5 schema; `VideoMetricsSchema` từ chối `ctr_pct 101`; `ChannelConfigSchema` cũ (không khối mới) → defaults `learning.horizon_hours 72`, `planning.enabled false`, `auto_pick.enabled false`; `ProjectConfigSchema` → `learning.collect_seconds 1800`, `adapters.stats "fake"`; `HypothesisSchema` với `evaluated`; profile `channel-planning` hợp lệ. Store: migrate có `0005`; insert/list metrics theo job (thứ tự `collected_at`) và theo channel; upsert/get learned.
- [ ] **Step 2–4:** triển khai, `pnpm gen:schemas`, `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(contracts): video metrics, channel learned standard, channel brief, topic proposal, StatsCollector port; learning tables`.

---

### Task 2: Adapter thu số — `metrics-parse.ts`, `PlaywrightStatsCollector`, `collect-stats.mjs`, `FakeStatsCollector`, composition

**Files:**
- Create: `packages/adapters/youtube-playwright/src/metrics-parse.ts`, `packages/adapters/youtube-playwright/src/playwright-stats-collector.ts`, `packages/adapters/youtube-playwright/scripts/collect-stats.mjs`, `packages/adapters/fake/src/fake-stats-collector.ts`
- Modify: `packages/adapters/youtube-playwright/src/index.ts`, `packages/adapters/fake/src/index.ts`, `packages/cli/src/composition.ts` (`AppContext.stats: StatsCollector` theo `adapters.stats`; `learning: { collectSeconds, collectBatch }`)
- Test: `packages/adapters/youtube-playwright/test/metrics-parse.test.ts`, `packages/adapters/youtube-playwright/test/playwright-stats-collector.test.ts`, `packages/adapters/fake/test/fake-stats-collector.test.ts`

**Interfaces (Produces):**

```ts
// metrics-parse.ts (thuần, chép từ D:\<kênh>\scripts\lib\metrics-parse.mjs — đọc file gốc để lấy đúng quy tắc, KHÔNG sửa file gốc)
export function parseCount(s: unknown): number | null        // "1.2K"→1200, "1,234"→1234, "1,2 N"→1200, "3.4M"→3400000, ""→null
export function parsePercent(s: unknown): number | null      // "5.3%"→5.3, "5,3 %"→5.3
export function parseDuration(s: unknown): number | null     // "1:02"→62, "1:02:03"→3723
export function parseStatsJson(raw: string): StatsOutcome    // dòng JSON của collect-stats.mjs → StatsOutcome; JSON hỏng → { kind: "error" }

// playwright-stats-collector.ts
export interface PlaywrightStatsCollectorOptions { node?: string; redact?: (s: string) => string; script?: string /* mặc định <pkg>/scripts/collect-stats.mjs */; statsFile?: string /* test-only: env HARNESS_FAKE_STATS_FILE → đọc { [video_id]: StatsOutcome } thay vì spawn */ }
export class PlaywrightStatsCollector implements StatsCollector {
  readonly name = "youtube-playwright-stats";
  // spawnSync(node, [script, "--profile", <repo>/.upload-profile, "--video", video_id], { timeout: timeout_seconds*1000, killSignal: "SIGKILL", env: publisherChildEnv(process.env) })
  // exit 0 → parseStatsJson(stdout); exit 2 → { kind: "blocked", reason: stderr tail }; exit 3 → { kind: "error" }; timeout/ENOENT → { kind: "error", reason }
}
// fake-stats-collector.ts
export class FakeStatsCollector implements StatsCollector { readonly name = "fake-stats"; constructor(o?: { outcomes?: Record<string, StatsOutcome>; file?: string /* env HARNESS_FAKE_STATS_FILE */; default?: StatsOutcome }); calls: string[] }
// mặc định: { kind: "ok", views: 100, impressions: 500, ctr_pct: 5, avg_view_sec: 60 }; file được đọc lại mỗi lần collect (test đổi kịch bản giữa chừng)
```

`collect-stats.mjs` (Playwright thật, chỉ đọc; `node --check` trong test; header ghi rõ không bấm/gõ): `launchPersistentContext(profile, { headless: true })`; nếu URL sau `goto` chuyển về `accounts.google.com` hoặc trang có "Verify it's you" → in `{ kind: "blocked", reason }` exit 2; `tab-overview/period-since_publish`: text vùng chính; "hasn't gotten any views|chưa có lượt xem" → `{ kind: "no-views" }` exit 0; lấy Views theo nhãn `["Views","Lượt xem"]`; `tab-reach`: `["Thumbnail impressions","Impressions","Số lần hiển thị theo hình thu nhỏ","Số lần hiển thị"]`, CTR `["Thumbnail click-through rate","Impressions click-through rate","Tỷ lệ nhấp"]`; `tab-engagement`: `["Average view duration","Thời lượng xem trung bình"]`; in `{ kind: "ok", views, impressions, ctr_pct, avg_view_sec }` (giá trị đã parse bằng cùng quy tắc — chép 3 hàm parse vào script dưới dạng JS); lỗi → `{ kind: "error", reason }` exit 3.

- [ ] **Step 1: Test thất bại** — `metrics-parse.test.ts` với vector: `parseCount` ("1.2K", "1,234", "1,2 N", "12", "—", null), `parsePercent` ("5.3%", "5,3 %", ""), `parseDuration` ("0:45", "1:02:03", "45 giây"? → null), `parseStatsJson` (ok/no-views/blocked/JSON hỏng). `playwright-stats-collector.test.ts`: script giả `.mjs` trong temp trả theo env `FAKE_STATS_EXIT` (0 với JSON ok / 2 / 3 / in JSON hỏng / `hang` 5 s với timeout 1 s) → đúng `StatsOutcome`; `statsFile` → không spawn; env con không có `HARNESS_SECRET_*` (script giả in tên env có prefix, kiểm rỗng). `fake-stats-collector.test.ts`: map, file, default, `calls`.
- [ ] **Step 2–4:** triển khai; composition: `stats = project.adapters.stats === "playwright" ? new PlaywrightStatsCollector({ redact, statsFile: process.env.HARNESS_FAKE_STATS_FILE }) : new FakeStatsCollector({ file: process.env.HARNESS_FAKE_STATS_FILE })`; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(adapter): Studio stats collector (read-only Playwright script) with legacy metric parsing; fake collector`.

---

### Task 3: Core `learning/{metrics,hypotheses,learned}.ts`

**Files:**
- Create: `packages/core/src/learning/metrics.ts`, `packages/core/src/learning/hypotheses.ts`, `packages/core/src/learning/learned.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/learning/metrics.test.ts`, `hypotheses.test.ts`, `learned.test.ts`

**Interfaces (Produces):**

```ts
// metrics.ts
export interface DueCollection { job: PublicationJob; target_age_hours: number }
export function collectDue(store: StateStore, channel: LoadedChannel, now: string, batch: number): DueCollection[]
//  jobs PUBLISHED của kênh có published_at; targets = [horizon_hours, ...recollect_hours]; due khi now ≥ published_at + t giờ và không có VideoMetrics source studio với age_hours ≥ t − 6; sort theo (published_at + t) tăng; slice(batch)
export function ageHours(publishedAt: string, now: string): number
export interface CollectDeps { store: StateStore; collector: StatsCollector; channels: ChannelRegistry; clock: Clock; batch: number; logger: { info; warn; error } }
export interface CollectReport { collected: { job_id: string; metric_id: string; age_hours: number }[]; blocked: string[] /* channel_ids */; failed: { job_id: string; reason: string }[]; evaluated: EvaluationReport[]; learned: string[] /* channel_ids có standard đổi */ }
export async function collectStats(d: CollectDeps, o?: { channelId?: string; jobId?: string; force?: boolean }): Promise<CollectReport>
//  per channel: due = force ? mọi job PUBLISHED (target = ageHours hiện tại) : collectDue; per due: collector.collect(...) →
//   ok → insertVideoMetrics({ metric_id: newId("video_metrics"), ..., age_hours: ageHours(published_at, now), source: "studio" }) + event stats.collected { job_id, metric_id }
//   no-views → insert views 0, others null
//   blocked → event stats.blocked { channel_id, reason } (dedup: listEvents({ event_type: "stats.blocked", newest: true }) có payload.channel_id trong 24 h → không ghi lại); dừng kênh này
//   error → job.receipt.collect_failures = (n ?? 0) + 1 (updatePublicationJob); ≥3 → event stats.failing { job_id } dedup 24 h
//   ok/no-views → receipt.collect_failures = 0
//  sau mỗi kênh có collected>0: evaluateHypotheses(...) rồi learnChannelStandard(...)
export function importMetrics(store: StateStore, p: { channel_id: string; jsonl: string; clock: Clock }): { imported: number; skipped: { videoId: string; why: string }[] }
//  mỗi dòng có videoId & views: job = listPublicationJobs({ channel_id }).find(youtube_video_id === videoId) → thiếu → skipped; ageHours từ job.published_at (thiếu → từ publishedAt của dòng) tới collectedAt; source manual; bỏ dòng "$schema"

// hypotheses.ts
export type HypothesisMetric = "ctr" | "views_72h" | "avg_view_pct";
export function metricValue(metric: HypothesisMetric, m: VideoMetrics, durationSeconds: number | null): number | null
//  ctr → m.ctr_pct; views_72h → m.views; avg_view_pct → m.avg_view_sec / duration × 100 (null khi thiếu)
export function snapshotAtHorizon(list: VideoMetrics[], horizonHours: number): VideoMetrics | undefined   // ảnh chụp studio|manual đầu tiên age_hours ≥ horizon
export interface EvaluationReport { channel_id: string; evaluated: { hypothesis_id: string; package_id: string; status: "supported"|"refuted"|"void"; metric_value: number | null }[] }
export function evaluateHypotheses(d: { store: StateStore; clock: Clock; channel: LoadedChannel; durationOf: (pkg: ChannelPackage) => number | null }): EvaluationReport
//  pkg committed, hypothesis.status open, job PUBLISHED (listPublicationJobs({ channel_id }) match package_id); snapshot = snapshotAtHorizon(listVideoMetrics({ publication_job_id }), expected.horizon_hours) → none: skip;
//  void khi: metric ctr và (impressions null || impressions < min_impressions); metric avg_view_pct và (avg_view_sec null || duration null); metric views_72h không bao giờ void (views luôn có)
//  value ≥ target → supported else refuted; updateChannelPackage({ ...pkg, hypothesis: { ...h, status, evaluated: { at: now, metric_value: value ?? 0, metric_id } }, updated_at: now }); event hypothesis.evaluated

// learned.ts
export function titlePattern(title: string): string        // `${/\d/.test(t) ? "number" : "plain"}+${t.trim().endsWith("?") ? "question" : "statement"}+${t.length > 60 ? "long" : "short"}`
export function overlayGroup(lines: string[]): "0" | "1-2" | "3"
export function median(xs: number[]): number | null
export function learnChannelStandard(d: { store: StateStore; clock: Clock; channel: LoadedChannel; durationOf: (pkg: ChannelPackage) => number | null }): { learned: ChannelLearned; changed: boolean }
//  evaluated = pkgs committed với hypothesis.status supported|refuted và evaluated; metric = mode của expected.metric (tie → "views_72h"); chỉ gộp giả thuyết cùng metric
//  medians từ snapshotAtHorizon(72) của mọi job PUBLISHED của kênh (views_72h: views; ctr_pct; avg_view_pct qua durationOf)
//  groups theo angle (lowercase trim, rỗng → bỏ), titlePattern(chosen.title), overlayGroup(chosen.overlay_text): { value, supported, refuted, lift = mean(metric_value)/medians[metric] } (medians[metric] null hoặc 0 → lift 0)
//  candidate mỗi chiều = nhóm supported ≥ min_samples && lift > 1 && supported > refuted, lift cao nhất; standard mới = { angle?, title_pattern?, overlay_lines? } từ candidates; so với cũ: chiều nào cũ có mà mới lift < cũ×1.10 → giữ cũ (lưu lift cũ trong winners để so)
//  không candidate nào → standard { note: `cần ≥${min_samples} giả thuyết supported cùng nhóm; hiện có ${n} đã đánh giá` }
//  changed = JSON của standard (không note) khác cũ → history push { at, standard } (cap 20), event channel.learned_updated; upsertChannelLearned luôn (updated_at, sample_size, medians, winners)
```

- [ ] **Step 1: Test thất bại** — `metrics.test.ts`: `collectDue` (chưa tới giờ → rỗng; tới 72 h → 1; đã có ảnh 70 h → không due 72 nhưng due 168 khi tới; batch cắt; sort); `collectStats` với `FakeStatsCollector` (ok → hàng + event; no-views → views 0; blocked → không hàng, event dedup lần 2, kênh khác vẫn thu; error ×3 → `stats.failing`; sau ok reset); `importMetrics` (3 dòng, 1 không khớp job, dòng `$schema` bỏ). `hypotheses.test.ts`: `metricValue` ba metric; `snapshotAtHorizon`; `evaluateHypotheses` supported/refuted/void/skip-when-no-snapshot/idempotent/event. `learned.test.ts`: `titlePattern` ("Bí quyết 5 bước?" → `number+question+short`), `overlayGroup`; `learnChannelStandard`: 2 supported cùng angle lift 1.5 → standard.angle; 1 supported → note; refuted ≥ supported → không; ngưỡng 10 % giữ cũ; history cap 20; `changed` đúng; nhóm theo metric phổ biến.
- [ ] **Step 2–4:** triển khai; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(core): stats collection sweep, hypothesis evaluation and channel learned standard`.

---

### Task 4: Core `learning/{brief,planning,auto-pick,checkers}.ts`

**Files:**
- Create: `packages/core/src/learning/brief.ts`, `packages/core/src/learning/planning.ts`, `packages/core/src/learning/auto-pick.ts`, `packages/core/src/learning/checkers.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/learning/brief.test.ts`, `planning.test.ts`, `auto-pick.test.ts`, `checkers.test.ts`

**Interfaces (Produces):**

```ts
// brief.ts
export function buildChannelBrief(d: { store: StateStore; clock: Clock; channel: LoadedChannel; item?: LibraryItem | null }): ChannelBrief
//  learned = getChannelLearned; hypotheses = 10 gói committed mới nhất (episode_no desc) → { hypothesis_id, episode_no, chosen{title,angle,overlay_text}, expected, status, metric_value: evaluated?.metric_value };
//  recent_metrics = 10 job PUBLISHED mới nhất có ảnh chụp: ảnh chụp mới nhất mỗi job + episode_no/title từ gói; open_requests = listContentRequests({ status: open|claimed }) lọc requested_by.channel_id === channel_id;
//  item → { item_id, title_hint, summary, duration_seconds } | null. Kết quả phải ChannelBriefSchema.parse được. KHÔNG chứa secret (seo là văn bản cấu hình; không đưa youtube.account_email_ref).

// planning.ts
export function channelDemand(d: { store: StateStore; clock: Clock; channel: LoadedChannel; libraryItems: LibraryItem[]; libraryClaimsOf: (itemId: string) => LibraryClaim[] }): Demand
//  slots = lookahead_slots khung từ nextSlot lặp (taken = SCHEDULED|PUBLISHED của kênh); jobs = PROCESSING|SCHEDULED của kênh; runs = run channel-publish đang chạy của kênh (content.library_channel_id === channel_id, run không terminal, workflow id channel-publish);
//  items = library approved chưa có claim của kênh này và (request_id thuộc request của kênh || không request_id); requests = request open|claimed của kênh;
//  covered = jobs + runs + items + requests; needed = max(0, slots.length − covered); open_requests = requests.filter(open).length
export function planningNeeded(demand: Demand): boolean   // needed > 0 && open_requests < max_open_requests
export interface PlanRequestsDeps { store; clock; channel: LoadedChannel; catalog: SourceCatalog; planner: Planner; harness: HarnessConfig; projectId: string; portfolioId: string; profile: ProductionProfile /* channel-planning */; workflows; executorVersionFor; libraryItems; libraryClaimsOf; logger }
export async function planRequestsRun(d: PlanRequestsDeps): Promise<{ started?: { run_id: string; needed: number }; skipped?: "covered" | "open-cap" | "run-active" | "cooldown" | "plan-failed" }>
//  run-active: run channel-planning chưa terminal cho kênh (content title bắt đầu "planning <channel_id>"); cooldown: event channel.planning_failed cho kênh trong 24 h;
//  một transaction: createContent({ source_ids: [], title: `planning ${channel_id} ${YYYY-MM-DD}`, library_channel_id: channel_id }) (mở rộng createContent nhận library_channel_id không cần library_item_id — kiểm schema ContentItem cho phép), getOrCreateVariant(profile, {}), planner.plan(...), enqueue; event channel.planning_started
//  skipped covered/open-cap → event channel.planning_skipped { reason } dedup theo ngày (listEvents event_type + payload.channel_id + cùng YYYY-MM-DD)

// auto-pick.ts
export interface AutoPickDeps { store; fs: LibraryFs; clock; channel: LoadedChannel; catalog; planner; harness; projectId; portfolioId; profile: ProductionProfile /* channel */; workflows; executorVersionFor; libraryItems: LibraryItem[]; logger }
export async function autoPick(d: AutoPickDeps): Promise<{ picked?: { item_id: string; run_id: string }; skipped?: "concurrency" | "no-candidate" | "pick-failed" }>
//  candidates: approved, không có claim của kênh (fs.listClaims), không phải item đã có ContentItem(library_item_id, library_channel_id=channel) với run FAILED|WAITING; (a) request_id ∈ request của kênh, sort theo created_at request; (b) không request_id, chỉ khi channelDemand.needed > 0
//  active runs channel-publish của kênh ≥ max_concurrent_runs → concurrency
//  một transaction: claimItem({ store, fs, clock, catalog }, { item_id, channel_id, portfolio_id }) → content; getOrCreateVariant(profile, {}); planner.plan(...); enqueue; event channel.auto_picked
//  lỗi → event channel.auto_pick_failed { item_id, reason }, skipped pick-failed (không ném)

// checkers.ts
export function learningCheckers(d: { store: StateStore }): Checker[]
//  topics-valid (1.0.0): output type topic_proposal → TopicProposalSchema.safeParse; đọc input type channel_brief (open_requests[].topic) và 20 gói committed mới nhất của kênh (channel_id từ brief) → chuẩn hóa lowercase/trim; trùng → fail { duplicates }; input demand (demand.json) có → topics.length > topics_per_run? — không có config trong workspace: bỏ; pass
```

- [ ] **Step 1: Test thất bại** — `brief.test.ts`: kênh không có gì → `learned null`, mảng rỗng, `item null`, parse được; có 12 gói → 10 hypotheses mới nhất; `recent_metrics` đúng ảnh chụp mới nhất; không có chuỗi `secret://` trong JSON. `planning.test.ts`: `channelDemand` (3 khung, 0 covered → needed 3; 1 job SCHEDULED + 1 item approved chung + 1 request open → 0; item có request_id của kênh khác không tính; item đã claim không tính); `planRequestsRun` (started → run READY + content `library_channel_id`; run-active; open-cap event dedup theo ngày; cooldown sau `channel.planning_failed`). `auto-pick.test.ts`: item của request kênh được ưu tiên trước item chung; item chung chỉ khi needed>0; item với run FAILED bỏ; concurrency; claim file được ghi và run READY. `checkers.test.ts`: `topics-valid` pass; trùng open_request → fail; trùng tiêu đề gói → fail; schema sai → fail.
- [ ] **Step 2–4:** triển khai (`createContent` cần cho phép `library_channel_id` mà không có `library_item_id` — nếu `ContentItemSchema` ràng buộc, nới comment/schema và ghi ledger); `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(core): channel brief, demand and planning run, auto-pick, topics-valid checker`.

---

### Task 5: Stage built-in `channel-brief|demand|create-requests`, workflows, profiles, skill `channel-plan`, sửa skill `channel-package`, agent giả

**Files:**
- Create: `workflows/channel-publish@1.1.0/workflow.yaml`, `workflows/channel-planning@1.0.0/workflow.yaml`, `production-profiles/channel-planning/profile.yaml`, `skills/channel-plan/SKILL.md`
- Modify: `packages/cli/src/commands/publish-stage.ts` (3 stage + `STAGES`), `packages/cli/src/composition.ts` (`builtinPublishCommands` thêm `publish-channel-brief|publish-demand|publish-create-requests`; Verifier thêm `learningCheckers`), `production-profiles/channel/profile.yaml` (rev 2 → `channel-publish@1.1.0`), `skills/channel-package/SKILL.md`, `fixtures/fake-agent-cli.mjs`
- Test: `packages/cli/test/learning-stages.test.ts`, `packages/core/test/orchestration/channel-workflows-1-1.test.ts`, `packages/adapters/agent-cli/test/fake-agent-outputs.test.ts` (thêm)

**Stage built-in (`harness publish stage …`, khuôn `library-stage`):**
- `channel-brief`: run → content (`library_channel_id` bắt buộc → channel); item = `content.library_item_id` ? `lib.fs.readJson(manifest)` : null; `buildChannelBrief` → `output/channel-brief.json` type `channel_brief`.
- `demand`: channel như trên; `channelDemand` với `libraryItems = store.listLibraryItems({ status: "approved" })`, `libraryClaimsOf = lib.fs.listClaims` → `output/demand.json` type `demand`.
- `create-requests`: inputs `topic_proposal` + `demand` + `channel_brief`; `topics.slice(0, demand.needed)`; mỗi topic: `style_id` = topic.style_id ?? `listEditStyles({ status: "active" })` mới nhất (không có → CONFIG_INVALID contract); `createRequest({ requested_by: { portfolio_id: run.portfolio_id, channel_id }, topic, style_id, style_revision, voice: topic.voice ?? "none", language: seo.language, target_duration_seconds?, source_hint?, notes: `auto-plan ${run_id}: ${why}` })`; idempotent: bỏ topic đã có request với `notes` chứa `run_id` và cùng topic; output `output/requests-receipt.json` `{ request_ids }` type `requests_receipt`; event `channel.requests_created`.

```yaml
# workflows/channel-planning@1.0.0/workflow.yaml
schema_version: harness.workflow/v1
id: channel-planning
version: 1.0.0
defaults: {}
stages:
  - key: channel-brief
    executor: { type: script, script: publish-channel-brief }
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: channel_brief, mime_type: application/json, name: channel-brief.json }
  - key: demand
    executor: { type: script, script: publish-demand }
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: demand, mime_type: application/json, name: demand.json }
  - key: propose-topics
    executor: { type: agent, skill: channel-plan, brief: "Đọc channel-brief.json (hướng SEO, chuẩn kênh, giả thuyết đã đánh giá, số liệu gần đây, request đang mở) và demand.json (needed). Tìm 3–5 video cùng ngách gần đây trên web. Viết output/topics.json (harness.topic-proposal/v1) với tối đa needed chủ đề mới, mỗi chủ đề có why dựa trên số liệu/giả thuyết/thị trường, không trùng request đang mở hay tập gần đây." }
    depends_on: [channel-brief, demand]
    retry: { max_attempts: 2, backoff_seconds: [60], retry_on: [transient, abandoned] }
    required_checks: [schema-valid, output-exists, checksum-match, topics-valid]
    outputs:
      - { type: topic_proposal, mime_type: application/json, name: topics.json }
  - key: create-requests
    executor: { type: script, script: publish-create-requests }
    depends_on: [propose-topics, demand, channel-brief]
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: requests_receipt, mime_type: application/json, name: requests-receipt.json }
```

`workflows/channel-publish@1.1.0/workflow.yaml`: chép 1.0.0, `version: 1.1.0`, chèn sau `fetch-library-item`: `channel-brief` (script `publish-channel-brief`, `depends_on: [fetch-library-item]`, output `channel_brief`); `package.depends_on: [fetch-library-item, channel-brief]`, `package.brief` thêm "đọc channel-brief.json trước". `production-profiles/channel/profile.yaml`: `revision: 2`, `workflow_release: channel-publish@1.1.0`. `production-profiles/channel-planning/profile.yaml`: `profile_id: channel-planning`, `revision 1`, `workflow_release: channel-planning@1.0.0`, `reuse: never`, `limits: { max_cost_usd_per_variant: 3, max_concurrency: 1 }`.

**Skill `channel-plan`** (80–110 dòng, khuôn `channel-package`): mục tiêu; input (`channel-brief.json`, `demand.json`, `stage-request.json`); quy trình: đọc chuẩn kênh (`learned.standard`) và giả thuyết supported/refuted; tìm web 3–5 video cùng ngách gần đây (`WebSearch`/`WebFetch`); đề xuất `min(needed, topics_per_run)` chủ đề, mỗi chủ đề `why` nêu số liệu/giả thuyết/thị trường, `angle` ưu tiên chuẩn kênh, không trùng `open_requests[].topic` và tiêu đề trong `hypotheses[]`; cấu trúc `output/topics.json` (JSON mẫu); tự kiểm trùng (lowercase/trim); điều cấm (không tạo request, không secret, chỉ `output/`).

**Skill `channel-package` sửa:** input chính `channel-brief.json` (thay `brief.json` mô tả kênh); bước 2 web bổ sung; bước 3: nếu `learned.standard.angle`/`title_pattern`/`overlay_lines` có thì theo và ghi `basis` `{ kind: "channel", note: "theo chuẩn kênh: …" }`; bước 6: `expected.metric` = `learned.metric` nếu có, `target = medians[metric] × 1.1` khi có trung vị; giữ phần còn lại.

**`fake-agent-cli.mjs` thêm:** `topic_proposal` → đọc input `demand` (`needed`) và `channel_brief` (`open_requests[].topic`, `hypotheses[].chosen.title`) → `topics = [{ topic: "Chủ đề tự động N về <seo.niche>", angle: learned?.standard?.angle ?? "", why: "fake: theo demand" }]` với N tăng tới không trùng, số lượng `max(1, min(needed, 3))`; `channel_package_draft` khi có input `channel_brief`: `angle = learned?.standard?.angle ?? ""`, `basis` thêm `{ kind: "channel", note: "theo chuẩn kênh (fake)" }` khi có standard, `expected.metric = learned?.metric ?? "views_72h"`, `target = medians[metric] × 1.1 || 1000`; env `FAKE_ANGLE` ghi đè `angle` (test học chuẩn cần hai gói cùng angle).

- [ ] **Step 1: Test thất bại** — workflow test: `channel-planning@1.0.0` 4 stage đúng, `channel-publish@1.1.0` 6 stage với `channel-brief` trước `package`, 1.0.0 không đổi, profile `channel` rev 2, profile `channel-planning` nạp được. `learning-stages.test.ts` (CLI spawn, `pnpm build`): project kênh temp + kho + item approved đã pick → chạy tay `publish stage channel-brief` (workspace dựng như `publish-stage.test.ts`) → `channel-brief.json` parse, `item` đúng, `seo` có, không `secret://`; `demand` → `demand.json` `needed` đúng; `create-requests` với `topics.json` 3 chủ đề + `demand.needed 2` → 2 request trong kho, `notes` chứa run_id; chạy lại → không tạo thêm; thiếu style active → `contract`. Fake agent: `topic_proposal` hợp lệ theo `TopicProposalSchema`, không trùng open_requests; `channel_package_draft` với `channel_brief` có standard → `basis` kind channel, `angle` đúng.
- [ ] **Step 2–4:** triển khai; SKILL heading test (thêm `channel-plan` vào test grep heading hiện có); `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat: channel-brief/demand/create-requests stages, channel-publish@1.1.0, channel-planning@1.0.0, channel-plan skill, brief-aware channel-package`.

---

### Task 6: Worker sweeps, CLI `harness channel …`, doctor, dashboard

**Files:**
- Modify: `packages/worker/src/worker.ts` (`WorkerDeps.learning?`, `maybeCollectStats`, `maybePlanRequests`, `maybeAutoPick`), `packages/cli/src/commands/worker.ts` (dựng deps khi kênh có `channels/`), `packages/cli/src/commands/channel.ts` (`stats|collect|learned|demand|plan-requests|pick-next|metrics import`), `packages/core/src/doctor/doctor.ts` (`channel:<id>:stats`, `channel:<id>:planning`), `packages/cli/src/composition.ts` (`computeDoctorRows` input; `AppContext.stats`), `packages/core/src/dashboard/snapshot.ts` (`learning` block per channel; alerts `stats_blocked|stats_failing|planning_failed`)
- Test: `packages/worker/test/worker.test.ts` (thêm), `packages/cli/test/channel-learning-commands.test.ts`, `packages/core/test/doctor/doctor.test.ts` (thêm), `packages/core/test/dashboard/snapshot.test.ts` (thêm)

**Interfaces (Produces):**

```ts
// worker.ts — WorkerDeps thêm:
learning?: {
  channels: ChannelRegistry; collector: StatsCollector; collectSeconds: number; collectBatch: number;
  planning: { checkSeconds: number; run: (channel: LoadedChannel) => Promise<unknown> };     // planRequestsRun đã bọc deps ở CLI
  autoPick: { run: (channel: LoadedChannel) => Promise<unknown> };                            // autoPick đã bọc deps
};
// idle branch: if (await maybeSyncLibrary()) { await maybeAutoAccept(); await maybeAutoPick(); }  await maybeVerifyPublications(); await maybeCollectStats(); await maybePlanRequests(); await maybeRefreshDashboard();
// maybeCollectStats: stamp lastCollectAt, collectStats({ ..., logger }) — log report; maybePlanRequests: stamp lastPlanAt; với mỗi kênh planning.enabled → planning.run(channel); maybeAutoPick: với mỗi kênh auto_pick.enabled → autoPick.run(channel). Lỗi log không ném.

// CLI (packages/cli/src/commands/channel.ts)
harness channel stats <id> [--json]                    // mỗi job PUBLISHED: episode_no, title, ảnh chụp mới nhất (age_hours, views, impressions, ctr_pct, avg_view_sec), số ảnh chụp
harness channel collect [--channel <id>] [--job <id>] [--force] [--json]   // collectStats một lượt; in CollectReport; exit 1 nếu failed ≠ []
harness channel learned <id> [--json]                  // ChannelLearned; text: metric, medians, standard, top 3 winners mỗi chiều
harness channel demand <id> [--json]                   // Demand
harness channel plan-requests <id> [--json]            // planRequestsRun (bỏ cadence, vẫn tôn trọng run-active/open-cap/cooldown)
harness channel pick-next <id> [--json]                // autoPick một lượt
harness channel metrics import <id> <jsonl> [--json]   // importMetrics
// doctor: channel:<id>:stats (adapters.stats playwright → script collect-stats.mjs tồn tại + .upload-profile/Default; fake → ok "fake"); channel:<id>:planning (planning.enabled → loadProfile("channel-planning") + loadWorkflow ok, adapters.agent ≠ fake; disabled → không hàng)
// snapshot: DashboardChannel.learning = { hypotheses: { open, supported, refuted, void }, last_collect_at: ts|null, standard: ChannelLearned["standard"]|null, metric, demand: { needed, open_requests } | null (null khi planning disabled) }; alerts: stats_blocked (event stats.blocked trong 24 h chưa có stats.collected sau đó cho kênh), stats_failing (job receipt.collect_failures ≥ 3), planning_failed (event channel.planning_failed trong 24 h)
```

- [ ] **Step 1: Test thất bại** — worker: `makeWorld` với `learning` (collector fake, `collectSeconds 10`, planning/autoPick spies) → sau `runOnce` idle: `collectStats` chạy 1 lần, planning.run và autoPick.run gọi cho kênh bật; lần hai trước cadence không gọi; spy ném → `runOnce` vẫn `idle`. CLI (spawn, `pnpm build`): project kênh temp với job PUBLISHED `published_at` lùi 80 h (ghi tay qua store) + `HARNESS_FAKE_STATS_FILE` → `channel collect --channel c1 --json` → `collected` 1, `channel stats c1 --json` có hàng; `channel learned c1 --json` note khi chưa đủ; `channel demand c1 --json` `needed 3`; `channel plan-requests c1 --json` → run READY (`status`) hoặc `skipped open-cap`; `channel pick-next c1 --json` với item approved của request kênh → `picked`; `metrics import c1 file.jsonl --json` → imported/skipped. Doctor 4 case. Snapshot: `learning` block đếm đúng; alert `stats_blocked` sau event; `stats_failing` khi receipt ≥3.
- [ ] **Step 2–4:** triển khai; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(cli): channel stats/learned/demand/plan-requests/pick-next/metrics import; worker collect/plan/auto-pick sweeps; doctor and dashboard learning rows`.

---

### Task 7: Fixture kênh học, test tích hợp `channel-learning`, acceptance 33–40

**Files:**
- Modify: `fixtures/ops-project-channel/project.yaml` (`adapters.stats: fake`, `learning { collect_seconds: 60, collect_batch: 5 }`, `workflows` thêm `channel-publish@1.1.0`, `channel-planning@1.0.0`), `fixtures/ops-project-channel/channels/channel-one/channel.yaml` (`learning`, `planning { enabled: true, lookahead_slots: 3, topics_per_run: 3, max_open_requests: 3, check_seconds: 60 }`, `auto_pick { enabled: true }`), `channel-two` (planning/auto_pick tắt), `tests/integration/publish-helpers.ts` (`freshPublishWorld({ learning?: true })`: kênh bật học + studio autopilot từ `freshLibraryWorld({ autopilot: true })`; `statsFile(world, map)` ghi `HARNESS_FAKE_STATS_FILE`; `backdatePublished(world, jobId, hours)` sửa `published_at`/`scheduled_at` qua store; `channelWorkerUntil(pred)`; `studioWorkerUntil` tái dùng)
- Create: `tests/integration/channel-learning.test.ts`, `tests/acceptance/33-stats-blocked-does-not-stop-publishing.test.ts`, `34-low-impressions-void.test.ts`, `35-standard-needs-10pct-lift.test.ts`, `36-demand-covered-no-planning.test.ts`, `37-max-open-requests-cap.test.ts`, `38-metrics-import-legacy-ledger.test.ts`, `39-no-secret-in-channel-brief-and-planning.test.ts`, `40-channel-publish-1-0-0-still-runs.test.ts`

- [ ] **Step 1: `channel-learning.test.ts`** (`skipIf(!hasFfmpeg())`, 900 s): `freshPublishWorld({ learning: true })` (kho + studio autopilot + kênh học; env `FAKE_YTDLP=1`, `FAKE_REVIEW_MODE=approve`, lookup file public, stats file): (1) kênh rỗng, `channelWorkerUntil(() => requests của kênh ≥ 1)` → run `channel-planning` SUCCEEDED, ≤3 request trong kho với `notes` chứa `auto-plan`; (2) `studioWorkerUntil(item approved)` (SP4 fixture, style active ghi sẵn bằng `writeActiveStyle`); (3) `channelWorkerUntil(job SCHEDULED)` → auto-pick → `channel-publish@1.1.0`; workspace `package` có `channel-brief.json` với `seo` và `learned: null`; (4) `backdatePublished(job, 80)` + lookup public → `channelWorkerUntil(PUBLISHED)` → `channelWorkerUntil(video_metrics ≥ 1)` với stats file `{ [vid]: ok views 1000 impressions 5000 ctr 6 }` → giả thuyết `supported` (target 1000 từ fake, views_72h); lặp (1)–(4) cho tập thứ hai với `FAKE_ANGLE=chợ nổi` cả hai gói → `channel learned --json` `standard.angle === "chợ nổi"`; (5) tập thứ ba: `package` workspace `channel-brief.json.learned.standard.angle` và gói mới `hypothesis.basis` có `kind: "channel"`.
- [ ] **Step 2: Acceptance**
  - **33**: stats file `{ [vid]: { kind: "blocked", reason: "verify" } }` → `channel collect` → không hàng, `dashboard snapshot` alert `stats_blocked`; pick + publish tập tiếp vẫn SCHEDULED.
  - **34**: stats `impressions 10` với giả thuyết metric `ctr` (đặt qua `FAKE_METRIC=ctr` cho fake agent — thêm env này vào fake + passthrough) → `void`; `channel learned` không standard.
  - **35**: hai gói angle A supported lift 1.5 → standard A; hai gói angle B supported lift 1.6 (< 1.5×1.1) → standard vẫn A; angle B lift 1.7 → đổi sang B, `history` 2 mục.
  - **36**: item approved chung sẵn trong kho đủ `lookahead_slots` → `channel demand` needed 0 → `plan-requests` skipped `covered`, không request mới, event `planning_skipped`.
  - **37**: 3 request open sẵn + `max_open_requests 3` → skipped `open-cap`.
  - **38**: sổ jsonl 3 dòng (2 khớp `youtube_video_id`, 1 lạ) → `imported 2`, `skipped 1`, `channel stats` có `source manual`.
  - **39**: chạy planning với `HARNESS_SECRET_X_Y=s3cret` và email secret → `channel-brief.json`, `agent-prompt.md`, `logs/*.log`, events không chứa `s3cret`, `owner@example.com`, `HARNESS_SECRET_`.
  - **40**: `loadWorkflow("channel-publish@1.0.0")` không có `channel-brief`; `tests/integration/publish-pipeline.test.ts` tồn tại và dùng `--workflow channel-publish@1.0.0` (nếu nó dùng profile mặc định thì sửa test đó truyền `--workflow` rõ; ghi ledger).
- [ ] **Step 3:** `pnpm build && pnpm test`; không media/data trong repo.
- [ ] **Step 4: Commit** — `test: channel learning loop integration (planning → studio → auto-pick → stats → standard); acceptance 33-40`.

---

### Task 8: Tài liệu và báo cáo

**Files:** Create `docs/runbooks/channel-learning.md`; Modify `AGENTS.md` ("Lệnh 3B (vòng học kênh)": lệnh `channel stats|collect|learned|demand|plan-requests|pick-next|metrics import`, cờ `learning|planning|auto_pick`, quy tắc "thu số chỉ đọc, không cổng học"), `README.md` (trạng thái + quick-start vòng kín hai máy), `docs/adr/0001-control-plane-baseline.md` (mục 93+ "Sub-project 3B": `video_metrics` append-only; `hypothesis.status/evaluated` mirror-kiểu trong gói committed; chuẩn kênh là quy tắc thuần với ba nhãn tiêu đề; ngưỡng đổi 10 %; `channel-brief` vá lỗ hổng SP3; planning là run; auto-pick ưu tiên request của kênh; không cổng học), `docs/operations/deferred-items.md` ("Sau sub-project 3B" từ ledger + spec §10), `project-template/project.yaml` (`learning`, `adapters.stats` comment), `project-template/channels/example/channel.yaml` (`learning|planning|auto_pick` comment).

- [ ] **Step 1: Runbook** `channel-learning.md`: (1) điều kiện (Chrome đã đăng nhập cho thu số thật; `adapters.stats: playwright`), (2) bật `learning/planning/auto_pick` và cadence, (3) vòng kín: kênh rỗng → request → studio → pick → phát → thu số → học; theo dõi bằng `channel demand|stats|learned`, dashboard `learning`, (4) nhập sổ cũ `metrics import`, (5) đọc `channel learned` và cách chuẩn đổi (ngưỡng 10 %, `history`), (6) sự cố: `stats_blocked` (`channel login`), `stats_failing` (sửa selector `collect-stats.mjs`), `planning_failed` (đọc `topics.json`/log agent, cooldown 24 h), request không ai làm (studio autopilot tắt?), (7) chi phí (một run planning ≤ 3 USD; thu số không tốn token), (8) quay về thủ công (tắt cờ; `request create` tay vẫn dùng được), (9) DoD #4: kết quả thu số thật một lần (bảng trống nếu máy build không có Chrome đăng nhập, ghi rõ).
- [ ] **Step 2:** ADR/AGENTS/README/deferred/template như trên.
- [ ] **Step 3:** `pnpm build && pnpm typecheck && pnpm test`; chạy tay quick-start trên fixture; dọn dữ liệu sinh ra.
- [ ] **Step 4: Commit** — `docs: channel learning runbook, ADR 93+, AGENTS/README, project template for sub-project 3B`.
- [ ] **Step 5:** Báo cáo trong chat: bảng DoD spec §8 (item → bằng chứng → trạng thái); điều để lại.

---

## Tự rà soát plan 3B

**Phủ spec:** §0 → toàn bộ; §1.1 → Task 1, 2, 3, 4, 5, 6, 8; §1.2 config → Task 1, 7; §1.3 bảng → Task 1; §2.1 cổng → Task 1, 2; §2.2 `VideoMetrics` → Task 1; §2.3 `collectDue` → Task 3; §2.4 sweep → Task 3 (hàm), 6 (worker); §2.5 CLI/doctor → Task 6; §3.1 → Task 3; §3.2 → Task 3; §3.3 `channel-brief` + skill → Task 4 (hàm), 5 (stage, workflow, skill); §4.1 demand → Task 4; §4.2 workflow/skill/checker/create-requests → Task 4 (checker), 5; §4.3/§4.4 sweep → Task 4 (hàm), 6 (worker); §4.5 CLI → Task 6; §5 dashboard/doctor/event → Task 6; §6 lỗi → Task 3 (blocked/error/failing), 4 (cooldown/cap), 5 (contract khi thiếu style), 6; §7 test → mọi task + Task 7; §8 DoD → Task 7, 8; §9/§10 → Task 8.

**Nhất quán kiểu:** `StatsOutcome`/`StatsCollector` (Task 1) dùng ở 2, 3, 6; `VideoMetrics`/`ChannelLearned`/`ChannelBrief`/`Demand`/`TopicProposal` (1) dùng ở 3, 4, 5, 6, 7; `collectStats`/`CollectReport` (3) dùng ở 6 (CLI + worker); `evaluateHypotheses`/`learnChannelStandard` (3) gọi trong `collectStats` (3) và hiển thị ở 6; `buildChannelBrief`/`channelDemand`/`planRequestsRun`/`autoPick` (4) dùng ở stage 5 và worker/CLI 6; output type `channel_brief`, `demand`, `topic_proposal`, `requests_receipt` khớp giữa workflow (5), stage (5), checker (4), fake agent (5); script built-in `publish-channel-brief|publish-demand|publish-create-requests` khớp composition (5) và workflow (5); env test `HARNESS_FAKE_STATS_FILE` (2, 6, 7), `FAKE_ANGLE`/`FAKE_METRIC` (5, 7 — thêm vào `env_passthrough` của agent-cli ở Task 5).

**Điểm chú ý khi thực thi:**
- Task 4 `createContent` với `library_channel_id` nhưng không `library_item_id`: `ContentItemSchema` comment nói "set together"; nới thành optional độc lập (planning content không có item) và ghi ledger.
- `durationOf(pkg)`: đọc `LibraryItem.duration_seconds` qua `content.library_item_id` từ mirror; thiếu → null (metric `avg_view_pct` thành `void`).
- `nextSlot` cần `taken` là ISO; `channelDemand` dùng lại `nextSlot` lặp như `publish slots --count`.
- Test tích hợp Task 7 dài (planning + studio + publish ×3); đặt `testTimeout` 900 s và cadence tối thiểu; nếu quá chậm, giảm tập thứ ba thành kiểm `channel-brief.json` qua `publish stage channel-brief` chạy tay (ghi ledger).
- `FAKE_METRIC`/`FAKE_ANGLE` phải vào `RUNTIME_COMMANDS[*].env_passthrough` (agent-cli) như `FAKE_REVIEW_MODE` ở SP4.
