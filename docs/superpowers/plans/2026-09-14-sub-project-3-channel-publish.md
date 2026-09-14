# Sub-project 3: Channel Publish, Agent CLI Runtime, Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Máy kênh lấy `LibraryItem` đã `approved` (qua `library pick`), tự đóng gói theo kênh bằng agent headless, upload PRIVATE qua script Playwright cũ, hẹn lịch native trên YouTube, đối soát; cộng dashboard chỉ đọc từ `snapshot.json`.

**Architecture:** Module `distribution` trong core (bảng `channel_package`, `publication_job`, `channel_sequence`; máy trạng thái `publication_job` đi qua `store.transition("publication_job", …)`); bốn stage built-in `harness publish stage fetch|build-package|upload|schedule` chạy như CLI con (khuôn `library stage` của 2C); cổng `Publisher` (adapter `youtube-playwright` bọc script của repo kênh cũ + `FakePublisher`); cổng `AgentRuntime` có implementation thật `@harness/adapter-agent-cli` (spawn `claude -p`/`codex exec`); worker quét `verify` và làm mới snapshot; `packages/dashboard` là một `server.ts` lõi Node + `hub.html`.

**Tech Stack:** Node 22 (`node:sqlite`, `node:http`, `Intl.DateTimeFormat`), pnpm workspaces, TypeScript strict ESM NodeNext (`.js` import, `exactOptionalPropertyTypes`), Zod 3 + `pnpm gen:schemas`, Vitest (`vitest.shared.ts` alias; test spawn CLI nạp `dist/` → `pnpm build` trước), commander, yaml.

**Spec:** `docs/superpowers/specs/2026-09-14-sub-project-3-channel-publish-design.md` (gọi tắt "spec"). Đọc §0 (quyết định), §2 (dữ liệu), §3 (stage), §4 (core/adapter/CLI), §6 (dashboard) trước khi làm task tương ứng.

## Global Constraints

- Không sửa repo kênh cũ trên `D:\` ngoài `outputs/<legacy_project_id>/episodes/episode-NN/`, `outputs/<legacy_project_id>/publish-queue.json`, `work/`; test **không bao giờ** trỏ vào `D:\`, chỉ dùng `fixtures/legacy-channel-repo` chép vào temp.
- Không gõ mật khẩu/2FA; không mở Chrome trong test; `lookup.mjs` (Playwright thật) không có test tự động.
- Secret: chỉ ref `secret://scope/name`, giá trị từ env `HARNESS_SECRET_<SCOPE>_<NAME>` (scope/name viết hoa, `-` giữ nguyên), Redactor xóa khỏi log; tiến trình agent **không** nhận `HARNESS_SECRET_*`.
- Chỉ `transition()`/`claim()` đổi `state` của control plane; `publication_job.state` chỉ đổi qua `store.transition("publication_job", …)`; `channel_package.status` là mirror-kiểu (update trực tiếp).
- Contracts không phụ thuộc gì; core chỉ phụ thuộc contracts; core không import adapters/executors/cli; composition root duy nhất `packages/cli/src/composition.ts`.
- `pnpm build && pnpm typecheck && pnpm test` xanh sau **mỗi** task; `pnpm gen:schemas` sau mọi thay đổi schema (test drift chặn).
- Commit: `feat(core): …`, `feat(cli): …`, `test: …`, `docs: …`; cuối message đúng một dòng `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` — không thay tên model khác.
- Bug hiển nhiên trong code của plan: sửa và ghi ledger, không hỏi; chỉ hỏi khi là trade-off thiết kế.
- Mọi đường dẫn ghi vào JSON (manifest, snapshot, receipt) dùng gạch xuôi (`posix()` = `p.split("\\").join("/")`).

## Bản đồ file

| File | Trách nhiệm | Task |
|---|---|---|
| `packages/contracts/src/distribution.ts` | `HypothesisSchema`, `ChannelPackageDraftSchema`, `PackageReceiptSchema`, `UploadReceiptSchema`, `ScheduleReceiptSchema`, kiểu `Publisher` | 1 |
| `packages/contracts/src/config.ts` | `ChannelConfigSchema` viết lại; `ProjectConfigSchema` thêm `adapters`, `publication`, `dashboard`; profile enum thêm `channel` | 1 |
| `packages/contracts/src/entities.ts` | mở rộng `ChannelPackageSchema`, `PublicationJobSchema` | 1 |
| `packages/contracts/src/interfaces.ts` | `TransitionKind` + `publication_job`; `StateStore` thêm package/job/sequence | 1, 2 |
| `migrations/0004_distribution.sql`, `packages/core/src/state/{sqlite-store,transitions}.ts` | bảng + máy trạng thái | 2 |
| `packages/core/src/distribution/channels.ts` | `loadChannels`, `ChannelRegistry` | 3 |
| `packages/core/src/distribution/packages.ts` | limits, manifest, gói, cấp số tập | 3 |
| `packages/core/src/distribution/publication.ts` | job, key, `nextSlot`, `transitionPublication` | 3 |
| `packages/core/src/distribution/checkers.ts` | 5 checker | 4 |
| `packages/core/src/distribution/verify.ts`, `reconcile.ts` | sweep + reconcile | 4 |
| `packages/adapters/fake/src/fake-publisher.ts` | `FakePublisher` | 4 |
| `packages/adapters/youtube-playwright/` | `PlaywrightPublisher`, `scripts/lookup.mjs` | 5 |
| `fixtures/legacy-channel-repo/` | repo kênh giả (script giả) | 5 |
| `packages/adapters/agent-cli/`, `fixtures/fake-agent-cli.mjs`, `skills/channel-package/SKILL.md` | `CliAgentRuntime` + skill | 6 |
| `workflows/channel-publish/workflow.yaml`, `production-profiles/channel/profile.yaml` | workflow + profile | 7 |
| `packages/cli/src/commands/publish-stage.ts`, `composition.ts` | 4 stage built-in, chọn adapter | 8 |
| `packages/cli/src/commands/{channel,publish,skills}.ts`, `doctor.ts`, `reconcile.ts`, `packages/worker/src/worker.ts`, `packages/core/src/doctor/doctor.ts` | CLI, doctor, worker sweep | 9 |
| `packages/core/src/dashboard/snapshot.ts`, `packages/dashboard/`, `packages/cli/src/commands/dashboard.ts` | snapshot + server + hub | 10 |
| `fixtures/ops-project-channel/`, `tests/integration/publish-*.ts`, `tests/acceptance/21..26` | tích hợp + acceptance | 11 |
| `docs/runbooks/channel-publish.md`, ADR, AGENTS, README, deferred, `project-template/` | tài liệu | 12 |

---

### Task 1: Contracts — ChannelConfig, Hypothesis, ChannelPackage/PublicationJob, Publisher, ProjectConfig, profile `channel`

**Files:**
- Create: `packages/contracts/src/distribution.ts`
- Modify: `packages/contracts/src/config.ts` (`ChannelConfigSchema` thay hẳn bản cũ — chưa ai dùng; `ProjectConfigSchema`; `ProductionProfileSchema.profile_id`), `packages/contracts/src/entities.ts` (`ProductionProfileRefSchema.profile_id`, `ChannelPackageSchema`, `PublicationJobSchema`), `packages/contracts/src/ids.ts` (`hypothesis: "hyp"`), `packages/contracts/src/interfaces.ts` (`TransitionKind`, `Publisher`), `packages/contracts/src/index.ts` (export `distribution.js`), `packages/contracts/scripts/gen-json-schema.ts` (thêm `hypothesis`, `channel-package-draft`, `package-receipt`, `upload-receipt`, `schedule-receipt`)
- Test: `packages/contracts/test/distribution.test.ts`

**Interfaces (Produces):**

```ts
// config.ts — thay ChannelConfigSchema cũ (schema_version giữ "harness.channel-config/v1" vì "harness.channel/v1" đã thuộc entity Channel)
export const ChannelConfigSchema = z.object({
  schema_version: schemaVersion("channel-config"),
  channel_id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  display_name: z.string().min(1),
  portfolio_id: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#5b8cff"),
  repo_dir: z.string().min(1),
  legacy_project_id: z.string().min(1).default("project-01"),
  youtube: z.object({ expected_channel_id: z.string().min(1), account_email_ref: secretRefSchema }).strict(),
  publication: z.object({
    timezone: z.string().min(1),
    publish_times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1),
    max_daily_uploads: z.number().int().min(1).default(1),
    min_gap_hours: z.number().min(0).default(20),
    visibility_default: z.literal("private").default("private"),
  }).strict(),
  seo: z.object({
    niche: z.string().default(""), audience: z.string().default(""), angle: z.string().default(""),
    language: z.string().min(1).default("en"), market: z.string().default(""), keywords: z.array(z.string()).default([]),
    title_rules: z.string().default(""), description_template: z.string().default(""),
  }).strict().default({}),
  episode: z.object({ start: z.number().int().min(1).default(1), dir_pattern: z.string().regex(/\{nn\}/).default("episode-{nn}") }).strict().default({}),
  overlay: z.object({ enabled: z.boolean().default(true), side: z.enum(["left", "right"]).default("right") }).strict().default({}),
}).strict();
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;

// ProjectConfigSchema thêm (mọi khối optional/default để project.yaml cũ vẫn parse):
adapters: z.object({
  publisher: z.enum(["playwright", "fake"]).default("fake"),
  agent: z.enum(["cli", "fake"]).default("fake"),
  /** Ghi đè argv của runtime agent (test dùng runtime giả). `{prompt}` được thay bằng câu chỉ tới agent-prompt.md. */
  agent_argv: z.array(z.string().min(1)).optional(),
}).strict().default({ publisher: "fake", agent: "fake" }),
publication: z.object({ verify_seconds: z.number().int().min(60).default(900), verify_grace_hours: z.number().min(0).default(2) }).strict().default({ verify_seconds: 900, verify_grace_hours: 2 }),
dashboard: z.object({ port: z.number().int().min(1).max(65535).default(5200), refresh_seconds: z.number().int().min(10).default(60) }).strict().default({ port: 5200, refresh_seconds: 60 }),
// ProductionProfileSchema.profile_id và ProductionProfileRefSchema.profile_id: z.enum(["cartoon","avatar","footage","studio","channel"])

// distribution.ts
export const HypothesisSchema = z.object({
  schema_version: schemaVersion("hypothesis"),
  hypothesis_id: idSchema("hypothesis"),
  basis: z.array(z.object({ kind: z.enum(["market", "channel", "manual"]), note: z.string().min(1), evidence_ref: z.string().optional() }).strict()).min(1),
  chosen: z.object({ title: z.string().min(1), thumbnail_candidate: z.string().min(1), overlay_text: z.array(z.string()).max(3).default([]), angle: z.string().default("") }).strict(),
  rejected: z.array(z.object({ title: z.string().min(1), angle: z.string().default(""), why: z.string().min(1) }).strict()).min(1),
  expected: z.object({ metric: z.enum(["ctr", "views_72h", "avg_view_pct"]), target: z.number().positive(), horizon_hours: z.number().int().min(24) }).strict(),
  status: z.enum(["open", "supported", "refuted", "void"]).default("open"),
  created_at: timestampSchema,
}).strict();
export const packageMetadataSchema = z.object({
  title: z.string().min(1), description: z.string().default(""), tags: z.array(z.string().min(1)).default([]),
  playlists: z.array(z.string()).default([]), hashtags: z.array(z.string().regex(/^#\S+$/)).default([]),
  pinned_comment: z.string().default(""), category_id: z.string().optional(), language: z.string().min(1).default("en"),
}).strict();
export const ChannelPackageDraftSchema = z.object({ schema_version: schemaVersion("channel-package-draft"), metadata: packageMetadataSchema, hypothesis: HypothesisSchema }).strict();
export const PackageReceiptSchema = z.object({
  schema_version: schemaVersion("package-receipt"), package_id: idSchema("channel_package"), publication_job_id: idSchema("publication_job"),
  channel_id: z.string().min(1), episode_no: z.number().int().min(1), episode_dir: z.string().min(1), manifest_path: z.string().min(1),
  video_checksum: checksumSchema, thumbnail_checksum: checksumSchema, manifest_digest: checksumSchema,
}).strict();
export const UploadReceiptSchema = z.object({ schema_version: schemaVersion("upload-receipt"), publication_job_id: idSchema("publication_job"), video_id: z.string().min(1), operation_id: idSchema("external_operation"), state: z.string().min(1) }).strict();
export const ScheduleReceiptSchema = z.object({ schema_version: schemaVersion("schedule-receipt"), publication_job_id: idSchema("publication_job"), video_id: z.string().min(1), scheduled_at: timestampSchema }).strict();
export type Hypothesis = …; export type PackageMetadata = …; export type ChannelPackageDraft = …; export type PackageReceipt = …; export type UploadReceipt = …; export type ScheduleReceipt = …;

// entities.ts — ChannelPackageSchema (giữ các trường cũ, thêm):
content_id: idSchema("content_item"), library_item_id: idSchema("library_item"), run_id: idSchema("run"),
episode_no: z.number().int().min(1), episode_dir: z.string().min(1), metadata: packageMetadataSchema, hypothesis: HypothesisSchema,
video_checksum: checksumSchema, thumbnail_checksum: checksumSchema, status: z.enum(["draft", "committed"]), updated_at: timestampSchema,
// (entities.ts import { HypothesisSchema, packageMetadataSchema } from "./distribution.js" — distribution.ts chỉ import common/ids, không import entities)
// PublicationJobSchema thêm:
channel_id: z.string().min(1), library_item_id: idSchema("library_item"), run_id: idSchema("run"), operation_id: idSchema("external_operation").nullable(),
scheduled_at: timestampSchema.nullable(), published_at: timestampSchema.nullable(), last_verified_at: timestampSchema.nullable(), note: z.string().nullable(),

// interfaces.ts
export type TransitionKind = "run" | "stage_run" | "attempt" | "artifact" | "external_operation" | "publication_job";
export interface PublisherChannel { channel_id: string; repo_dir: string; legacy_project_id: string; expected_channel_id: string }
export type UploadOutcome = { kind: "uploaded"; video_id: string; receipt: Record<string, unknown> } | { kind: "unknown"; reason: string } | { kind: "refused"; reason: string } | { kind: "busy"; reason: string };
export type ScheduleOutcome = { kind: "scheduled" } | { kind: "refused"; reason: string } | { kind: "busy"; reason: string };
export type LookupOutcome = { found: true; video_id: string; visibility: "public" | "private" | "unlisted" | "scheduled"; publish_at?: string; title?: string } | { found: false; reason?: string };
export interface Publisher {
  readonly name: string;
  upload(p: { channel: PublisherChannel; episode_no: number; episode_dir: string; intent_at: string; timeout_seconds: number; log?: (line: string) => void }): Promise<UploadOutcome>;
  schedule(p: { channel: PublisherChannel; video_id: string; at: string; timeout_seconds: number; log?: (line: string) => void }): Promise<ScheduleOutcome>;
  lookup(p: { channel: PublisherChannel; video_id?: string; title?: string; since?: string }): Promise<LookupOutcome>;
}
```

- [ ] **Step 1: Test thất bại** — `packages/contracts/test/distribution.test.ts`:
  - `ChannelConfigSchema.parse(minimalYamlObject)` áp default (`color`, `episode.start = 1`, `overlay.enabled = true`); `publish_times: ["25:00"]` → throw; `channel_id: "Bad_Id"` → throw.
  - `HypothesisSchema`: thiếu `rejected` → throw; `overlay_text` 4 dòng → throw; `status` default `open`.
  - `ChannelPackageDraftSchema` parse mẫu hợp lệ (dùng lại ở test sau: export `SAMPLE_DRAFT` từ file test này? Không — chép mẫu vào `tests/integration/publish-helpers.ts` ở Task 11).
  - `ProjectConfigSchema.parse(cũ không có adapters)` → `adapters.publisher === "fake"`, `dashboard.port === 5200`.
  - `ProductionProfileSchema` nhận `profile_id: "channel"`.
  - `PublicationJobSchema` mẫu đầy đủ parse được; `ChannelPackageSchema` mẫu đầy đủ parse được.
- [ ] **Step 2:** `pnpm --filter @harness/contracts test` → fail (module thiếu).
- [ ] **Step 3: Triển khai** theo Interfaces; `ids.ts` thêm `hypothesis: "hyp"`; `index.ts` export `./distribution.js`; `gen-json-schema.ts` thêm 5 schema mới (tên file: `hypothesis`, `channel-package-draft`, `package-receipt`, `upload-receipt`, `schedule-receipt`); chạy `pnpm gen:schemas`.
- [ ] **Step 4:** `pnpm build && pnpm typecheck && pnpm test` (test drift schema phải xanh; `TransitionKind` mở rộng làm `TRANSITIONS`/`TABLE_BY_KIND` trong core lỗi typecheck → thêm tạm `publication_job: {}`/`"publication_job"`/`"state"` ở Task này để build xanh; Task 2 điền bảng thật).
- [ ] **Step 5: Commit** — `feat(contracts): channel config, hypothesis, publication receipts, Publisher port, project adapters block`.

---

### Task 2: Migration `0004_distribution.sql`, store, máy trạng thái `publication_job`

**Files:**
- Create: `migrations/0004_distribution.sql`
- Modify: `packages/core/src/state/transitions.ts`, `packages/core/src/state/sqlite-store.ts`, `packages/contracts/src/interfaces.ts` (`StateStore`)
- Test: `packages/core/test/state/distribution-store.test.ts`

**Interfaces (Produces):**

```sql
-- migrations/0004_distribution.sql
-- channel_package.state mirrors ChannelPackage.status (draft|committed); updated directly, never via transition().
CREATE TABLE channel_package (id TEXT PRIMARY KEY, state TEXT NOT NULL, channel_id TEXT NOT NULL, run_id TEXT NOT NULL, library_item_id TEXT NOT NULL, episode_no INTEGER NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX channel_package_channel_idx ON channel_package(channel_id, episode_no);
CREATE INDEX channel_package_run_idx ON channel_package(run_id);
-- publication_job.state is control-plane state: only transition("publication_job", …) changes it.
CREATE TABLE publication_job (id TEXT PRIMARY KEY, state TEXT NOT NULL, channel_id TEXT NOT NULL, library_item_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, scheduled_at TEXT, data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX publication_job_channel_state_idx ON publication_job(channel_id, state);
CREATE INDEX publication_job_key_idx ON publication_job(idempotency_key);
CREATE TABLE channel_sequence (channel_id TEXT PRIMARY KEY, next_episode_no INTEGER NOT NULL);
```

```ts
// transitions.ts — thêm vào TRANSITIONS (spec §2.6):
publication_job: {
  DRAFT: ["READY"],
  READY: ["UPLOADING", "FAILED"],
  UPLOADING: ["PROCESSING", "NEEDS_RECONCILIATION", "READY"],   // READY: refused/busy — upload chưa diễn ra
  PROCESSING: ["SCHEDULED", "NEEDS_RECONCILIATION", "FAILED"],
  SCHEDULED: ["PUBLISHED", "NEEDS_RECONCILIATION", "FAILED"],
  NEEDS_RECONCILIATION: ["PROCESSING", "SCHEDULED", "PUBLISHED", "READY", "FAILED"],
  PUBLISHED: [], FAILED: [],
},
// TABLE_BY_KIND.publication_job = "publication_job"; STATE_FIELD_BY_KIND.publication_job = "state"

// StateStore (interfaces.ts) thêm:
insertChannelPackage(p: ChannelPackage): void;
getChannelPackage(id: string): ChannelPackage | undefined;
updateChannelPackage(p: ChannelPackage): void;                       // ghi đè data + state(status) + cột chỉ mục
listChannelPackages(filter?: { channel_id?: string; run_id?: string; status?: string }): ChannelPackage[];
insertPublicationJob(j: PublicationJob): void;
getPublicationJob(id: string): PublicationJob | undefined;
updatePublicationJob(j: PublicationJob): void;                       // KHÔNG đổi state: nếu j.state khác cột state hiện tại → HarnessError("STALE_STATE")
listPublicationJobs(filter?: { channel_id?: string; state?: string; library_item_id?: string; idempotency_key?: string; run_id?: string }): PublicationJob[];
/** Cấp số tập kế tiếp cho kênh trong một transaction: hàng chưa có → tạo với `start`, trả `start`; có → trả next rồi tăng. */
allocateEpisodeNo(channelId: string, start: number): number;
```

- [ ] **Step 1: Test thất bại** — `distribution-store.test.ts` với `openTempStore()` (helper hiện có trong `packages/core/test/`; nếu tên khác, dùng helper mà `library` tests dùng):
  - migrate → `listAppliedMigrations()` chứa `0004_distribution.sql`.
  - `allocateEpisodeNo("c1", 15)` → 15, gọi lại → 16; `allocateEpisodeNo("c2", 1)` → 1; hai kênh độc lập.
  - insert/get/list package (lọc theo `run_id`, `status`); `updateChannelPackage` đổi `status: "committed"` → `listChannelPackages({ status: "committed" })` thấy.
  - insert job `READY`; `transition("publication_job", id, "READY", "UPLOADING", ev)` → `getPublicationJob(id).state === "UPLOADING"` và có Event (`listEvents({ run_id })` có `event_type` `publication.uploading`); `transition(…, "READY", "PUBLISHED")` → `INVALID_TRANSITION`; `transition` với from sai → `STALE_STATE`.
  - `updatePublicationJob({ ...job, state: "PUBLISHED" })` khi cột là `UPLOADING` → `STALE_STATE`; cùng state → ghi `scheduled_at`, `listPublicationJobs({ channel_id, state })` đúng.
  - `listPublicationJobs({ idempotency_key })` tìm được.
- [ ] **Step 2:** chạy → fail.
- [ ] **Step 3: Triển khai** trong `sqlite-store.ts` theo khuôn `upsertLibraryItem`/`getDoc`/`listDocs` (parse qua `ChannelPackageSchema`/`PublicationJobSchema`); `allocateEpisodeNo` = `transaction(() => { SELECT next_episode_no …; nếu không có INSERT (channel_id, start+1) và trả start; có thì UPDATE next+1 và trả next })`. Sự kiện cho `transition("publication_job")`: `EventInput` do caller cung cấp (Task 3 có helper `publicationEvent`).
- [ ] **Step 4:** `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(core): channel_package, publication_job and channel_sequence tables; publication_job state machine`.

---

### Task 3: Core `distribution/` — channels, packages, publication (`nextSlot`)

**Files:**
- Create: `packages/core/src/distribution/channels.ts`, `packages/core/src/distribution/packages.ts`, `packages/core/src/distribution/publication.ts`
- Modify: `packages/core/src/index.ts` (export ba file)
- Test: `packages/core/test/distribution/channels.test.ts`, `packages.test.ts`, `publication.test.ts`

**Interfaces (Produces):**

```ts
// channels.ts
export const CHANNELS_DIR = "channels";
export interface LoadedChannel { config: ChannelConfig; dir: string; config_revision: Checksum }   // revision = canonicalDigest(config)
/** Đọc <projectDir>/channels/<id>/channel.yaml; thư mục không có → []. Lỗi: yaml/schema → CONFIG_INVALID (path trong details);
 *  channel_id ≠ tên thư mục → CONFIG_INVALID; portfolio_id không có trong project.portfolios → CONFIG_INVALID. */
export function loadChannels(projectDir: string, project: Pick<ProjectConfig, "portfolios">): LoadedChannel[]
export class ChannelRegistry {
  constructor(channels: LoadedChannel[])
  list(): LoadedChannel[]
  get(id: string): LoadedChannel                    // NOT_FOUND
  has(id: string): boolean
  toPublisherChannel(id: string): PublisherChannel  // { channel_id, repo_dir (resolve tuyệt đối, gạch xuôi), legacy_project_id, expected_channel_id }
}
/** posix path: split("\\").join("/") */
export function posixPath(p: string): string

// packages.ts
export const YOUTUBE_LIMITS = { title: 100, description: 5000, tags_total: 500, tag: 100, playlist: 150, tags_count: 500 } as const;   // chép từ D:\<kênh>\scripts\lib\youtube-limits.mjs; nếu file cũ khác thì lấy số của file cũ và ghi ledger
export interface LimitProblem { field: string; length: number; max: number }
export function youtubeLimitProblems(m: PackageMetadata): LimitProblem[]   // tags_total = tags.join(",").length
/** Đúng dạng templates/upload-manifest.template.json của repo cũ. */
export function buildUploadManifest(p: { metadata: PackageMetadata; videoPath: string; thumbnailPath: string }): { videoPath: string; thumbnailPath: string; visibility: "private"; title: string; description: string; playlists: string[]; tags: string[]; pinnedComment: string; hashtags: string[] }
export function manifestDigest(manifest: unknown): Checksum      // canonicalDigest
export function episodeDirName(pattern: string, episodeNo: number): string   // "{nn}" → String(n).padStart(2, "0")
export interface PackageDeps { store: StateStore; clock: Clock }
/** Một transaction: cấp episode_no, tạo ChannelPackage draft (checksum tạm "sha256:" + "0".repeat(64), episode_dir đã tính). */
export function createDraftPackage(d: PackageDeps, p: { channel: LoadedChannel; run: Run; content: ContentItem; draft: ChannelPackageDraft; variant_id: string; video_artifact_id: string; thumbnail_artifact_id: string; repoEpisodesDir: string }): ChannelPackage
export function findDraftForRun(store: StateStore, runId: string): ChannelPackage | undefined     // status draft, run_id
export function commitPackage(d: PackageDeps, p: { package_id: string; video_checksum: Checksum; thumbnail_checksum: Checksum; manifest_digest: Checksum }): ChannelPackage   // draft → committed

// publication.ts
export function idempotencyKeyFor(p: { channel_id: string; video_checksum: Checksum; manifest_digest: Checksum }): Checksum   // sha256String(`${channel_id}:${video_checksum}:${manifest_digest}`)
export function publicationEvent(job: PublicationJob, event_type: string, severity: "info" | "warn" | "error", payload?: Record<string, unknown>): EventInput
//  { run_id: job.run_id, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null, channel_id: job.channel_id, content_id: null, variant_id: null, workflow_release: null, severity, event_type, payload: { publication_job_id, ...payload } }
export function transitionPublication(store: StateStore, jobId: string, from: PublicationJob["state"], to: PublicationJob["state"], payload?: Record<string, unknown>): PublicationJob
//  event_type = `publication.${to.toLowerCase()}`; severity warn khi to ∈ {NEEDS_RECONCILIATION, FAILED}; trả job mới
export function createJob(d: { store: StateStore; clock: Clock }, p: { pkg: ChannelPackage }): PublicationJob    // state READY, idempotency_key từ pkg
export interface SlotPolicy { timezone: string; publish_times: string[]; max_daily_uploads: number; min_gap_hours: number }
/** Khung phát kế tiếp (ISO UTC) sau `now`: theo từng ngày (tối đa maxDays, mặc định 60) và từng giờ trong publish_times (sắp xếp),
 *  bỏ khung ≤ now, khung trùng phút với một mốc trong `taken`, ngày (theo timezone) đã có ≥ max_daily_uploads mốc, hoặc cách một mốc < min_gap_hours.
 *  Hết → HarnessError("CONFIG_INVALID", "no free publish slot within N days"). */
export function nextSlot(policy: SlotPolicy, taken: string[], now: string, maxDays = 60): string
/** ISO UTC của (ngày địa phương y-m-d, hh:mm) trong timezone; Intl.DateTimeFormat, đúng qua DST bằng hai lần hiệu chỉnh. */
export function zonedToUtc(p: { y: number; m: number; d: number; hh: number; mm: number }, timezone: string): Date
export function localDate(iso: string, timezone: string): string   // "YYYY-MM-DD" trong timezone
```

- [ ] **Step 1: Test thất bại**
  - `channels.test.ts`: temp project với `channels/a/channel.yaml` hợp lệ + `channels/b/channel.yaml` có `channel_id: c` → `CONFIG_INVALID` nêu `b`; portfolio lạ → `CONFIG_INVALID`; không có `channels/` → `[]`; `toPublisherChannel` trả `repo_dir` gạch xuôi tuyệt đối.
  - `packages.test.ts`: `youtubeLimitProblems` với title 101 ký tự → `[{ field: "title", length: 101, max: 100 }]`; tags tổng > 500 → `tags_total`; `buildUploadManifest` đúng khóa/thứ tự và `visibility: "private"`; `manifestDigest` ổn định với thứ tự khóa khác; `episodeDirName("episode-{nn}", 7) === "episode-07"`, `(…, 123) === "episode-123"`; `createDraftPackage` với store temp: hai gói cùng kênh → `episode_no` 15 và 16 khi `episode.start = 15`; `findDraftForRun`; `commitPackage` → `committed` với checksum thật.
  - `publication.test.ts`: `zonedToUtc({2026,3,8,13,0}, "America/New_York")` → `2026-03-08T17:00:00.000Z` (EDT, ngày đổi giờ), `({2026,1,15,13,0}, …)` → `18:00Z`; `localDate("2026-09-14T03:00:00.000Z","Asia/Bangkok") === "2026-09-14"`, `("2026-09-14T18:00:00.000Z","America/New_York") === "2026-09-14"`; `nextSlot({ tz NY, ["13:00"], 1, 20 }, [], now "2026-09-14T18:00:00.000Z")` → `2026-09-15T17:00:00.000Z`; với `taken = ["2026-09-15T17:00:00.000Z"]` → `2026-09-16T17:00:00.000Z`; `publish_times ["09:00","13:00"]`, `max_daily_uploads 2`, `min_gap_hours 3` → hai khung cùng ngày; `min_gap_hours 20` → ngày sau; `maxDays 1` hết khung → `CONFIG_INVALID`; `idempotencyKeyFor` ổn định; `transitionPublication` ghi Event `publication.uploading` với `channel_id`; `createJob` state READY và `listPublicationJobs({ idempotency_key })` thấy.
- [ ] **Step 2:** chạy → fail.
- [ ] **Step 3: Triển khai.** `zonedToUtc`: `guess = Date.UTC(y, m-1, d, hh, mm)`; `partsOf(date, tz)` qua `Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year, month, day, hour, minute })` → `asIfUtc = Date.UTC(parts)`; `result = guess - (asIfUtc - guess)`; lặp lần hai với `result` để bù DST. `nextSlot`: từ ngày địa phương của `now` (`localDate`), cộng `i` ngày bằng `Date.UTC(y, m-1, d+i)` rồi lấy y-m-d, với mỗi `hh:mm` tính `zonedToUtc`, kiểm điều kiện.
- [ ] **Step 4:** `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(core): channel registry, channel packages with episode allocation, publication jobs and nextSlot`.

---

### Task 4: Checker phát hành, `verifyScheduled`, `reconcilePublication`, `journal.markFailed`, `FakePublisher`

**Files:**
- Create: `packages/core/src/distribution/checkers.ts`, `packages/core/src/distribution/verify.ts`, `packages/core/src/distribution/reconcile.ts`, `packages/adapters/fake/src/fake-publisher.ts`
- Modify: `packages/core/src/orchestration/journal.ts` (`markFailed`), `packages/core/src/index.ts`, `packages/adapters/fake/src/index.ts` (export `FakePublisher`)
- Test: `packages/core/test/distribution/checkers.test.ts`, `verify.test.ts`, `reconcile.test.ts`, `packages/adapters/fake/test/fake-publisher.test.ts`

**Interfaces (Produces):**

```ts
// journal.ts
/** INTENT_RECORDED|DISPATCHED|NEEDS_RECONCILIATION → FAILED (ghi event external_operation.failed với reason); FAILED → trả nguyên; CONFIRMED → INVALID_TRANSITION. */
markFailed(operationId: string, reason: string): ExternalOperation

// checkers.ts
export interface DistributionCheckerDeps { store: StateStore; channels: ChannelRegistry; secrets: SecretResolver }
export function distributionCheckers(d: DistributionCheckerDeps): Checker[]
// youtube-limits (1.0.0): output type channel_package_draft → ChannelPackageDraftSchema.safeParse; fail { problems } khi youtubeLimitProblems ≠ []; skip khi không có output.
// hypothesis-complete (1.0.0): cùng output; fail khi chosen.thumbnail_candidate không phải tên file trong input type thumbnail_set (đọc thư mục input trong workspace) hoặc expected.target ≤ 0 (schema đã chặn nhưng kiểm lại); pass ngược lại.
// package-integrity (1.0.0): output type channel_package → PackageReceiptSchema; fail khi video/thumbnail tại episode_dir (đọc manifest_path: videoPath/thumbnailPath) không tồn tại hoặc sha256File ≠ receipt; manifest parse lỗi hoặc manifestDigest ≠ manifest_digest → fail.
// channel-identity (1.0.0): output channel_package; đọc <repo_dir>/channel.config.json của kênh (channels.get(receipt.channel_id)); fail khi youtube.channelId ≠ expected_channel_id, projectId ≠ legacy_project_id, hoặc youtube.accountEmail ≠ giá trị của account_email_ref (resolve qua d.secrets: SecretResolver — thêm vào deps; ref không resolve được → fail "secret unresolved").
// duplicate-upload (1.0.0): output channel_package; store.listPublicationJobs({ idempotency_key }) có job ≠ receipt.publication_job_id và state ≠ FAILED → fail; store.listPublicationJobs({ library_item_id, channel_id }) có job ≠ receipt.publication_job_id với state ∈ {PROCESSING, SCHEDULED, PUBLISHED} → fail.

// verify.ts
export interface VerifyDeps { store: StateStore; publisher: Publisher; channels: ChannelRegistry; clock: Clock; graceHours: number }
export interface VerifyReport { checked: string[]; published: string[]; reconcile: string[]; errors: { job_id: string; message: string }[]; warnings: { job_id: string; message: string }[] }
export async function verifyScheduled(d: VerifyDeps): Promise<VerifyReport>
//  job SCHEDULED với scheduled_at + graceHours ≤ now: lookup({ channel, video_id }) →
//   found public → PUBLISHED (published_at = publish_at ?? now); found scheduled/private với publish_at > now → giữ, cập nhật scheduled_at nếu khác;
//   found private không publish_at, unlisted, hoặc found:false → NEEDS_RECONCILIATION (note = lý do);
//   lookup ném lỗi → receipt.verify_failures += 1 (updatePublicationJob), ≥ 2 → NEEDS_RECONCILIATION, ngược lại errors[].
//  job PROCESSING quá 24 h (updated_at) → warnings[]. Mọi job đã kiểm: last_verified_at = now.

// reconcile.ts
export interface ReconcileDeps { store: StateStore; publisher: Publisher; channels: ChannelRegistry; journal: ExternalOperationJournal; planner: Planner; clock: Clock }
export interface PublicationReconcileReport { job_id: string; from: "NEEDS_RECONCILIATION"; to: PublicationJob["state"]; video_id: string | null; stage_state?: string }
export async function reconcilePublication(d: ReconcileDeps, jobId: string): Promise<PublicationReconcileReport>
//  job phải NEEDS_RECONCILIATION (khác → INVALID_TRANSITION). pkg = getChannelPackage(job.package_id).
//  lookup: job.youtube_video_id ? { video_id } : { title: pkg.metadata.title, since: op?.created_at }.
//  found → job.youtube_video_id = video_id; to = visibility public → PUBLISHED; scheduled|private có publish_at tương lai → SCHEDULED (scheduled_at = publish_at); private khác → PROCESSING;
//          op (job.operation_id) nếu ≠ CONFIRMED → journal.confirmExternal(op, { provider_ref: video_id, receipt: { reconciled: true } });
//  không found → to = READY; op → journal.markFailed(op, "not found on provider").
//  Sau đó: stage upload của run (listStageRuns(job.run_id).find(stage_key === "upload")) nếu state NEEDS_RECONCILIATION và không còn op NEEDS_RECONCILIATION → transition NEEDS_RECONCILIATION → READY (event stage.reconciled), set ready_at/not_before = now, planner.advance(run_id).

// fake-publisher.ts
export interface FakePublisherOptions { upload?: "uploaded" | "unknown" | "refused" | "busy"; schedule?: "scheduled" | "refused" | "busy"; lookup?: LookupOutcome | ((p: { video_id?: string; title?: string }) => LookupOutcome); writeQueue?: boolean }
export class FakePublisher implements Publisher {
  readonly name = "fake-publisher";
  uploads: { episode_no: number; video_id: string }[] = []; schedules: { video_id: string; at: string }[] = []; lookups: number = 0;
  constructor(opts?: FakePublisherOptions)
  // upload: video_id = `fake-${n}`; khi writeQueue (mặc định true) ghi dòng { ep, videoId, addedAt, via: "fake" } vào <episode_dir>/../../publish-queue.json (kể cả khi kết quả "unknown" — mô phỏng video đã tạo mà script chết); "refused"/"busy" không ghi.
}
```

- [ ] **Step 1: Test thất bại**
  - `checkers.test.ts`: dựng workspace temp với `output/package.json` (draft mẫu) → `youtube-limits` pass; title 120 ký tự → fail; `hypothesis-complete` với `thumbnail_set` input là thư mục có `thumb-01.png` và `chosen.thumbnail_candidate: "thumb-01.png"` → pass, `"nope.png"` → fail; `package-integrity` với episode_dir temp + manifest + receipt đúng → pass, sửa video → fail nêu `videoPath`; `channel-identity` với `channel.config.json` giả khớp → pass, `channelId` lệch → fail, email lệch → fail (secret qua `process.env.HARNESS_SECRET_YOUTUBE_C1_EMAIL`); `duplicate-upload` với job thứ hai PROCESSING cùng `library_item_id + channel_id` → fail.
  - `verify.test.ts`: store temp + job SCHEDULED `scheduled_at` quá hạn: `FakePublisher({ lookup: { found: true, video_id, visibility: "public" } })` → `PUBLISHED`, `published_at` set; `visibility: "private"` không `publish_at` → `NEEDS_RECONCILIATION`; `publish_at` tương lai → giữ SCHEDULED; chưa quá grace → không lookup (`lookups === 0`); lookup ném → lần 1 `errors`, lần 2 `NEEDS_RECONCILIATION`.
  - `reconcile.test.ts`: run + stage `upload` NEEDS_RECONCILIATION + op NEEDS_RECONCILIATION + job NEEDS_RECONCILIATION (không `youtube_video_id`): lookup found private → job PROCESSING với video_id, op CONFIRMED, stage READY; lookup found:false → job READY, op FAILED, stage READY; job PROCESSING → `INVALID_TRANSITION`.
  - `fake-publisher.test.ts`: upload ghi `publish-queue.json` đúng dạng; `unknown` vẫn ghi; `refused` không ghi.
- [ ] **Step 2:** chạy → fail.
- [ ] **Step 3: Triển khai.** Checker đọc file như `library-checkers.ts` (safeParse, fail sạch). Reconcile chuyển stage: copy đúng bốn dòng trong `orchestration/reconcile.ts` (transition + updateStageRun ready_at/not_before + advance). Cần `SecretResolver` trong `DistributionCheckerDeps` (`secrets`).
- [ ] **Step 4:** `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(core): publication checkers, scheduled-job verify sweep, publication reconcile; fake publisher`.

---

### Task 5: `@harness/adapter-youtube-playwright` + fixture `legacy-channel-repo`

**Files:**
- Create: `packages/adapters/youtube-playwright/{package.json,tsconfig.json,vitest.config.ts,src/index.ts,src/playwright-publisher.ts,src/queue.ts,scripts/lookup.mjs}`, `fixtures/legacy-channel-repo/{channel.config.json,scripts/upload-youtube-playwright.mjs,scripts/publish-video-playwright.mjs,scripts/gen-thumb-overlay.mjs,scripts/open-channel-chrome.mjs,templates/upload-manifest.template.json,.upload-profile/Default/.keep}`
- Modify: `vitest.shared.ts` (alias `@harness/adapter-youtube-playwright`), `tsconfig.json` gốc nếu có `references`, `.gitignore` (`fixtures/legacy-channel-repo/outputs/`, `fixtures/legacy-channel-repo/work/`)
- Test: `packages/adapters/youtube-playwright/test/playwright-publisher.test.ts`, `packages/adapters/youtube-playwright/test/queue.test.ts`

`package.json` như `adapter-ffprobe` (name `@harness/adapter-youtube-playwright`, dependency `@harness/contracts`, `@harness/core` cho `Redactor`? — **không**: adapter chỉ phụ thuộc contracts; nhận `redact: (s: string) => string` qua constructor).

**Interfaces (Produces):**

```ts
// queue.ts — thuần, test được không cần spawn
export interface QueueLine { ep: string; videoId: string; addedAt: string; url?: string; title?: string; via?: string; removed?: boolean }
export function readQueue(path: string): QueueLine[]                      // file thiếu/JSON hỏng → []
/** Dòng của tập episode_no (so `String(ep).padStart(2,"0")`), có videoId, không removed, addedAt ≥ since; lấy dòng mới nhất. */
export function newestUploadFor(lines: QueueLine[], episode_no: number, since: string): QueueLine | undefined
export const EXIT_REFUSED = 3; export const EXIT_BUSY = 4;

// playwright-publisher.ts
export interface PlaywrightPublisherOptions {
  node?: string;                                  // mặc định process.execPath
  redact?: (s: string) => string;                 // mặc định identity
  fetchImpl?: typeof fetch;                       // oEmbed
  /** Test-only: đường dẫn JSON { [video_id | "title:<title>"]: LookupOutcome }; đặt qua env HARNESS_PUBLISHER_LOOKUP_FILE — khi có, lookup không chạm mạng/Studio: tra `video_id` trước, rồi `title:<title>`, không có → { found: false }. */
  lookupFile?: string;
  lookupScript?: string;                          // mặc định <package>/scripts/lookup.mjs
}
export class PlaywrightPublisher implements Publisher {
  readonly name = "youtube-playwright";
  constructor(opts?: PlaywrightPublisherOptions)
  // upload: spawn(node, ["scripts/upload-youtube-playwright.mjs", `episode-${nn}`], { cwd: channel.repo_dir, env: process.env (không thêm gì), timeout })
  //   → sau khi thoát: line = newestUploadFor(readQueue(<repo>/outputs/<legacy_project_id>/publish-queue.json), episode_no, intent_at)
  //   line → { kind: "uploaded", video_id, receipt: { exit_code, url, added_at, log_tail } }; không line: code 3 → refused; code 4 → busy; code 0/khác/timeout → unknown.
  //   stdout/stderr từng dòng qua redact rồi p.log?.(line); giữ 40 dòng cuối làm log_tail (đã redact).
  // schedule: spawn(node, ["scripts/publish-video-playwright.mjs", video_id, "--schedule", at]) → 0 scheduled; 3 refused; 4 busy; khác/timeout → throw HarnessError("EXECUTOR_FAILED", …) (stage coi là transient).
  // lookup: lookupFile ?? env → đọc file; else video_id → GET https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=<id>&format=json:
  //   200 → { found: true, video_id, visibility: "public", title }; 401/403/404 hoặc không video_id → spawnSync lookup.mjs (args: --profile <repo>/.upload-profile --channel <expected_channel_id> [--video <id>] [--title <t>] [--since <iso>]) đọc JSON một dòng ở stdout; script exit ≠ 0 → { found: false, reason }.
}
```

`scripts/lookup.mjs` (Playwright, chỉ đọc; **không test tự động**): mở `https://studio.youtube.com/channel/<channel>/videos/upload` với `chromium.launchPersistentContext(profile, { headless: true })`, chờ danh sách, lọc theo `--video` (href chứa id) hoặc `--title` + ngày ≥ `--since`, đọc cột visibility (`Public`/`Private`/`Unlisted`/`Scheduled` + ngày), in `{ found, video_id, visibility, publish_at?, title }`; mọi lỗi → in `{ found: false, reason }` exit 2. Đầu file ghi rõ: KHÔNG bấm gì, KHÔNG gõ mật khẩu; `playwright` nạp qua `createRequire(<repo>/package.json)` (repo kênh có sẵn), thiếu → `{ found:false, reason:"playwright not installed in <repo>" }`.

**Fixture `legacy-channel-repo`** (script giả, cùng argv/exit code/file như script thật; đọc `channel.config.json` để lấy `projectId`):
- `upload-youtube-playwright.mjs episode-NN`: `mode = process.env.FAKE_UPLOAD_MODE ?? "ok"`; kiểm `outputs/<pid>/episodes/episode-NN/publish/episode-NN-upload-manifest.json` tồn tại (thiếu → in lỗi, exit 3); `refused` → in "✋ DỪNG — sai tài khoản" exit 3; `busy` → exit 4; `ok` → push `{ ep: NN, videoId: "fk" + 9 ký tự ngẫu nhiên, url, title, addedAt, via: "auto-upload" }` vào `outputs/<pid>/publish-queue.json`, in "[upload] videoId …", exit 0; `lost` → ghi queue như `ok` rồi exit 1 (mô phỏng chết sau khi video đã tạo); `silent` → không ghi, exit 0.
- `publish-video-playwright.mjs <videoId> --schedule <ISO>`: `mode = FAKE_SCHEDULE_MODE ?? "ok"`: `ok` → ghi `outputs/<pid>/schedules/<videoId>.json` `{ videoId, at }` exit 0; `refused` → 3; `busy` → 4; `crash` → 1.
- `gen-thumb-overlay.mjs --bg <in> --out <out> …`: copy `in` → `out`, ghi `out + ".args.json"` chứa argv (test kiểm `--line1`).
- `open-channel-chrome.mjs`: in "fake chrome" và thoát 0.
- `channel.config.json`: `{ "projectId": "project-01", "youtube": { "channelId": "UCfake000000000000000001", "accountEmail": "owner@example.com" } }`.
- `templates/upload-manifest.template.json`: chép nguyên bản từ repo cũ.

- [ ] **Step 1: Test thất bại** — `queue.test.ts`: `newestUploadFor` bỏ dòng cũ hơn `since`, dòng `removed`, dòng tập khác; lấy dòng mới nhất. `playwright-publisher.test.ts`: chép fixture vào temp (`cpSync`), tạo `episode-15/publish/episode-15-upload-manifest.json` giả; `upload` với `FAKE_UPLOAD_MODE=ok` → `uploaded` + video_id khớp queue; `lost` → `unknown` nhưng queue có dòng (để reconcile tìm); `refused` → `refused`, `busy` → `busy`; `timeout_seconds: 1` với `FAKE_UPLOAD_MODE=hang` (script `setTimeout` 5 s) → `unknown`; log qua `redact` (secret "owner@example.com" → "[REDACTED]" trong `log_tail`); `schedule` ok/refused/busy/crash; `lookup` với `lookupFile` → kết quả từ file; `fetchImpl` giả trả 200 → public; 404 + không lookupScript khả dụng (`lookupScript: "<temp>/missing.mjs"`) → `{ found: false }`.
- [ ] **Step 2:** chạy → fail.
- [ ] **Step 3: Triển khai** (spawn với `stdio: ["ignore","pipe","pipe"]`, timer kill như `ScriptExecutor`).
- [ ] **Step 4:** `pnpm install && pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(adapter): youtube-playwright publisher wrapping the legacy upload/schedule scripts; fake legacy channel repo fixture`.

---

### Task 6: `@harness/adapter-agent-cli`, runtime giả, skill `channel-package`

**Files:**
- Create: `packages/adapters/agent-cli/{package.json,tsconfig.json,vitest.config.ts,src/index.ts,src/cli-agent-runtime.ts}`, `fixtures/fake-agent-cli.mjs`, `skills/channel-package/SKILL.md`
- Modify: `vitest.shared.ts` (alias), `packages/adapters/fake/src/fake-agent-runtime.ts` (**không đổi** — vẫn dùng cho test cũ)
- Test: `packages/adapters/agent-cli/test/cli-agent-runtime.test.ts`

**Interfaces (Produces):**

```ts
export type AgentCliRuntimeKind = "claude" | "codex";
export const RUNTIME_COMMANDS: Record<AgentCliRuntimeKind, { argv: string[]; env_passthrough: string[] }> = {
  claude: { argv: ["claude", "-p", "{prompt}", "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", "Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Bash(ffprobe:*)"], env_passthrough: ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "FAKE_AGENT_MODE"] },
  codex:  { argv: ["codex", "exec", "--full-auto", "--json", "{prompt}"], env_passthrough: ["OPENAI_API_KEY", "CODEX_HOME", "FAKE_AGENT_MODE"] },
};
export const PROMPT_POINTER = "Read the file ./agent-prompt.md in the current directory and follow it exactly. Work only inside this directory.";
export interface CliAgentRuntimeOptions { runtime: AgentCliRuntimeKind; skillsDir: string; argv?: string[]; redact?: (s: string) => string; baseEnv?: Record<string, string | undefined> }
export class CliAgentRuntime implements AgentRuntime {
  readonly name: string;      // `agent-cli-${runtime}`
  readonly version = "0.1.0";
  constructor(opts: CliAgentRuntimeOptions)
  static isAvailable(runtime: AgentCliRuntimeKind, argv0?: string): boolean   // spawnSync(argv0 ?? runtime, ["--version"], { timeout: 10000 }).status === 0
  async runTask(task: AgentTask, ctx: ExecutorContext): Promise<StageResult>
}
/** Env con: PATH, PATHEXT, SystemRoot, ComSpec, TEMP, TMP, HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_CONFIG_HOME + env_passthrough; HARNESS_WORKSPACE = workspace; KHÔNG bao giờ HARNESS_SECRET_*. */
export function agentChildEnv(base: Record<string, string | undefined>, passthrough: string[], workspace: string): Record<string, string>
```

`runTask`: (1) ghi `agent-prompt.md` = `# Skill\n` + nội dung `<skillsDir>/<task.skill>/SKILL.md` (thiếu → `failed contract` "skill not found") + `\n\n# Brief\n` + `task.brief` + `\n\n# Stage request\nĐọc stage-request.json cùng thư mục. Ghi output vào output/ theo skill.\n`; (2) argv = `(opts.argv ?? RUNTIME_COMMANDS[runtime].argv).map(a => a === "{prompt}" ? PROMPT_POINTER : a)`; (3) spawn argv0 với cwd = workspace, env = `agentChildEnv`, timeout = `deadline_at - now` (từ `request.limits`); stdout/stderr qua `redact` → `ctx.logger.info/warn` và `logs/agent-stdout.log`; (4) exit ≠ 0 → `failed transient` `{ code: "EXECUTOR_FAILED", exit_code }`; timeout → `failed transient` `EXECUTOR_TIMEOUT`; (5) với mỗi `request.expected_outputs` (`name` bắt buộc): file `output/<name>` (hoặc thư mục khi `kind: directory`) tồn tại → output `{ type, path: "output/<name>", kind, checksum: sha256 (file) hoặc directory checksum }` — dùng đúng cách `@harness/script-sdk` tính (`sha256File` cho file; thư mục: liệt kê đệ quy, sort, sha256 của `path:checksum\n` nối lại — chép hàm `directoryListing` từ `packages/script-sdk/src/index.js` sang adapter dưới dạng TS để adapter không phụ thuộc sdk); thiếu → `failed contract` "agent wrote no output/<name>"; (6) `usage.cost_usd` = `total_cost_usd` từ dòng JSON cuối stdout nếu parse được, else 0; `wall_seconds` đo; `outcome: "succeeded"`.

`fixtures/fake-agent-cli.mjs`: argv `["--version"]` → in `fake-agent 0.1.0` exit 0; ngược lại đọc `./agent-prompt.md` (thiếu → exit 2), đọc `./stage-request.json`, `mode = process.env.FAKE_AGENT_MODE ?? "ok"`: `ok` → với mỗi `expected_outputs` ghi file `output/<name>`: nếu `type === "channel_package_draft"` ghi draft mẫu **hợp lệ** (title lấy từ `brief` dòng `title_hint:` nếu có, `thumbnail_candidate` = file đầu tiên trong thư mục input type `thumbnail_set` theo `inputs[].path`, `basis` 1 mục `manual`, `rejected` 1 mục, `expected { metric: "views_72h", target: 1000, horizon_hours: 72 }`, `hypothesis_id: "hyp_" + ULID giả 26 ký tự [0-9A-HJKMNP-TV-Z]`), loại khác ghi `{ "fake": true }`; in dòng cuối `{"total_cost_usd":0.01}`; `no-output` → exit 0 không ghi; `crash` → exit 1; `env-dump` → in mọi key env bắt đầu `HARNESS_` rồi làm như `ok`; `long-title` → title 150 ký tự.

`skills/channel-package/SKILL.md` (tiếng Việt, ~80 dòng) theo spec §5: mục tiêu, input (brief.md, brief.json, edit-plan.json, thumbnail ứng viên), quy trình 7 bước, cấu trúc `output/package.json` (chép schema dạng JSON mẫu), giới hạn YouTube, quy tắc `hypothesis` (basis ≥1 có `market` nếu tìm web được, rejected ≥1, expected), điều cấm (không upload, không secret, không ra ngoài workspace), tự kiểm trước khi kết thúc.

- [ ] **Step 1: Test thất bại** — `cli-agent-runtime.test.ts`: workspace temp có `stage-request.json` (expected_outputs `[{ type: "channel_package_draft", mime_type: "application/json", kind: "file", name: "package.json" }]`, inputs có `thumbnail_set` thư mục với `thumb-01.png`), `skillsDir` = `<harness>/skills`; runtime `{ runtime: "claude", argv: [process.execPath, fixtures/fake-agent-cli.mjs, "{prompt}"] }`: `ok` → `succeeded`, output `output/package.json` checksum khớp `sha256File`, `usage.cost_usd === 0.01`, file `agent-prompt.md` chứa nội dung SKILL.md và brief; `no-output` → `failed` kind `contract`; `crash` → `transient`; `env-dump` với `process.env.HARNESS_SECRET_X_Y = "s3cret"` → stdout log không chứa `HARNESS_SECRET_X_Y` và không chứa `s3cret`; skill lạ → `contract`; timeout (`deadline_at` = now + 1 s, mode `hang`) → `transient` `EXECUTOR_TIMEOUT`; `isAvailable("claude", process.execPath)` true (node --version), `isAvailable("claude", "definitely-missing-bin")` false. `describe.skipIf(!CliAgentRuntime.isAvailable("claude"))` một test thật: brief "Ghi output/package.json …" với skill thật, kiểm schema — timeout 300 s.
- [ ] **Step 2:** chạy → fail.
- [ ] **Step 3: Triển khai.**
- [ ] **Step 4:** `pnpm install && pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(adapter): agent-cli runtime spawning claude/codex headless; fake agent CLI; channel-package skill`.

---

### Task 7: Workflow `channel-publish@1.0.0`, profile `channel`

**Files:**
- Create: `workflows/channel-publish/workflow.yaml`, `production-profiles/channel/profile.yaml`
- Test: `packages/core/test/orchestration/channel-publish-workflow.test.ts`

```yaml
# workflows/channel-publish/workflow.yaml
schema_version: harness.workflow/v1
id: channel-publish
version: 1.0.0
defaults: {}
stages:
  - key: fetch-library-item
    executor: { type: script, script: publish-fetch }
    required_checks: [schema-valid, output-exists, checksum-match, media-probe]
    outputs:
      - { type: episode_video, mime_type: video/mp4, name: episode.mp4 }
      - { type: thumbnail_set, mime_type: application/x-directory, kind: directory, name: thumbnails }
      - { type: library_brief, mime_type: application/json, name: brief.json }
  - key: package
    executor: { type: agent, skill: channel-package, brief: "Đóng gói tập này cho kênh: đọc brief.md (hướng SEO của kênh, gợi ý tiêu đề, ứng viên thumbnail), tìm mẫu tiêu đề cùng ngách trên web, viết output/package.json gồm metadata và hypothesis theo schema harness.channel-package-draft/v1." }
    depends_on: [fetch-library-item]
    retry: { max_attempts: 2, backoff_seconds: [30], retry_on: [transient, abandoned] }
    required_checks: [schema-valid, output-exists, checksum-match, youtube-limits, hypothesis-complete]
    outputs:
      - { type: channel_package_draft, mime_type: application/json, name: package.json }
  - key: build-package
    executor: { type: script, script: publish-build-package }
    depends_on: [package, fetch-library-item]
    required_checks: [schema-valid, output-exists, checksum-match, package-integrity, channel-identity, duplicate-upload]
    outputs:
      - { type: channel_package, mime_type: application/json, name: package-receipt.json }
  - key: upload
    executor: { type: script, script: publish-upload }
    depends_on: [build-package]
    requires_resources: [browser]
    retry: { max_attempts: 3, backoff_seconds: [60, 600], retry_on: [transient, abandoned] }
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: upload_receipt, mime_type: application/json, name: upload-receipt.json }
  - key: schedule
    executor: { type: script, script: publish-schedule }
    depends_on: [upload]
    requires_resources: [browser]
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: publication_receipt, mime_type: application/json, name: schedule-receipt.json }
```

(`captions` là output tùy chọn — hệ thống outputs hiện bắt buộc khớp `expected_outputs`; **không** khai `captions` ở đây, `fetch` chỉ chép captions vào `output/captions/` nếu có mà không đăng ký output; ghi ledger nếu executor từ chối file thừa.)

```yaml
# production-profiles/channel/profile.yaml
schema_version: harness.production-profile/v1
profile_id: channel
revision: 1
status: active
workflow_release: channel-publish@1.0.0
overrides: {}
options_schema:
  overlay: [auto, none]
options_defaults: { overlay: auto }
reuse: never
content: {}
verification: { required_checks: [], required_checks_by_stage: {} }
limits: { max_cost_usd_per_variant: 3, max_concurrency: 1 }
```

- [ ] **Step 1: Test thất bại** — `loadWorkflow(HARNESS_ROOT, "channel-publish@1.0.0")` 5 stage đúng thứ tự/loại; `package` là `agent` skill `channel-package`; `upload`/`schedule` `requires_resources` `[browser]`; mọi output có `name`; `loadProfile(HARNESS_ROOT, "channel").workflow_release === "channel-publish@1.0.0"`, `reuse === "never"`.
- [ ] **Step 2–4:** viết YAML, test xanh, `pnpm test`.
- [ ] **Step 5: Commit** — `feat: channel-publish workflow and channel profile`.

---

### Task 8: Stage built-in `harness publish stage …`, composition (adapter, registry, checker)

**Files:**
- Create: `packages/cli/src/commands/publish-stage.ts`
- Modify: `packages/cli/src/composition.ts`, `packages/cli/src/main.ts` (đăng ký `registerPublish` — file `publish.ts` tạo ở Task 9; ở task này tạo `publish.ts` tối thiểu chỉ gọi `registerPublishStage`), `packages/cli/package.json` (deps `@harness/adapter-youtube-playwright`, `@harness/adapter-agent-cli`)
- Test: `packages/cli/test/publish-stage.test.ts`

**Interfaces (Produces):**

```ts
// composition.ts
export function builtinPublishCommands(argv: string[], projectDir: string): Record<string, ScriptCommand>
//  { "publish-fetch": { argv: [...argv, "--project", projectDir, "publish", "stage", "fetch"], cwd: "." }, "publish-build-package": …"build-package", "publish-upload": …"upload", "publish-schedule": …"schedule" }
// AppContext thêm:
channels: ChannelRegistry;                       // luôn có (rỗng khi không có channels/)
channelErrors: string[];                         // lỗi loadChannels nuốt như configErrors (doctor báo), lệnh cần kênh ném lại
publisher: Publisher;                            // theo project.adapters.publisher: "playwright" → new PlaywrightPublisher({ redact: (s) => redactor.redact(s), lookupFile: process.env.HARNESS_PUBLISHER_LOOKUP_FILE }); "fake" → new FakePublisher()
agentRuntime: AgentRuntime;                      // "cli" → new CliAgentRuntime({ runtime: project.runtime, skillsDir: join(harnessRoot, "skills"), argv: project.adapters.agent_argv, redact }); "fake" → FakeAgentRuntime({ journal })
publication: { verifySeconds: number; graceHours: number }; dashboard: { port: number; refreshSeconds: number };
// commands = { ...fakeScriptCommands(), ...builtinLibraryCommands(argv, projectDir), ...builtinPublishCommands(argv, projectDir), ...(scripts ? … : {}) }
// executors.register("agent", new AgentExecutor(agentRuntime));
// Verifier thêm ...distributionCheckers({ store, channels, secrets })
```

`publish-stage.ts` — khuôn y hệt `library-stage.ts` (`start({ env: process.env })`, `withContext`, `runStage` map lỗi: CONFIG_INVALID/INVALID_TRANSITION/NOT_FOUND → `contract`; IO_ERROR/EXECUTOR_FAILED/khác → `transient`). Helper `requireChannel(app, id): LoadedChannel` (channelErrors ≠ [] → CONFIG_INVALID nêu lỗi). Bốn stage (spec §3):

- `fetch`: run → content (`library_item_id`, `library_channel_id` thiếu → CONFIG_INVALID); `app.library` thiếu → CONFIG_INVALID; manifest = `library.fs.readJson(paths.manifest(item_id), LibraryItemSchema)`; `status !== "approved"` → CONFIG_INVALID `item <id> is <status>`; `claims/<channel>.json` không tồn tại → CONFIG_INVALID; với mỗi `manifest.files`: `episode.mp4` → `output/episode.mp4`; ảnh (`mime_type` `image/*`) → `output/thumbnails/<path>`; `captions*` → `output/captions/<path>` (không đăng ký); còn lại bỏ; chép bằng `copyFile` rồi `sha256File` so `checksum` (lệch → IO_ERROR "checksum mismatch …" → transient); `output/brief.json` = `{ item_id, title_hint, summary, duration_seconds, style, request_id?, lineage, files }`; `sdk.out.file("output/episode.mp4", { type: "episode_video" })`, `out.dir("output/thumbnails", { type: "thumbnail_set" })`, `out.file("output/brief.json", { type: "library_brief" })`; `done()`.
- `build-package` (không có `package` agent ở đây; đọc `sdk.input("channel_package_draft")` → `ChannelPackageDraftSchema`): channel = `requireChannel(content.library_channel_id)`; `pkg = findDraftForRun(run_id) ?? createDraftPackage(…)` (variant_id = run.variant_id; artifact ids = inputs `episode_video`/`thumbnail_set` `artifact_id`); `episodesDir = <repo_dir>/outputs/<legacy_project_id>/episodes`; `episode_dir = join(episodesDir, episodeDirName(pattern, episode_no))`; `repo_dir` không tồn tại → IO_ERROR; `episode_dir` tồn tại **và không phải do gói này tạo trước** (kiểm file `.harness-package-id` trong đó bằng `pkg.package_id`) → CONFIG_INVALID; mkdir `full-episode`, `thumbnails`, `publish`; ghi `.harness-package-id`; copy video → `full-episode/episode-NN-full-episode.mp4`; thumbnail: ứng viên = `join(sdk.input("thumbnail_set"), draft.hypothesis.chosen.thumbnail_candidate)`; nếu `channel.config.overlay.enabled && overlay_text.length > 0 && existsSync(<repo>/scripts/gen-thumb-overlay.mjs) && sdk.request.options.overlay !== "none"` → spawnSync node `scripts/gen-thumb-overlay.mjs --bg <cand> --out thumbnails/opt1.png --line1 … [--line2 …] [--line3 …] --side <side> --ep NN` (cwd repo, timeout 300 s; status ≠ 0 → EXECUTOR_FAILED → transient) else copy → `thumbnails/opt1.png`; manifest = `buildUploadManifest({ metadata: draft.metadata, videoPath: posix(abs video), thumbnailPath: posix(abs thumb) })` → `publish/episode-NN-upload-manifest.json` (JSON 2 space + `\n`); `commitPackage` với sha256 thật + `manifestDigest`; `job = listPublicationJobs({ run_id }).[0] ?? createJob({ pkg })`; ghi `publications/<channel>/<job>/package-manifest.json` (copy manifest) + `dashboard/thumbnails/<pkg_id>.png` dưới `app.dataRoot`; `output/package-receipt.json` (`PackageReceiptSchema`) type `channel_package`; `done()`.
- `upload`: receipt = input `channel_package`; job = `getPublicationJob` (NOT_FOUND → contract); `job.state === "PROCESSING" || "SCHEDULED" || "PUBLISHED"` → ghi `upload-receipt.json` từ job, `done({ external_operations: job.operation_id ? [job.operation_id] : [] })` (idempotent); `state !== "READY"` → INVALID_TRANSITION; `channel = requireChannel(job.channel_id)`; `intent = journal.recordIntent({ request: { run_id, stage_run_id, attempt_id }, provider: publisher.name, kind: "youtube-upload", target: job.channel_id, payload: { idempotency_key: job.idempotency_key } })`; `updatePublicationJob({ ...job, operation_id: intent.operation_id })`; `transitionPublication(READY → UPLOADING)`; `journal` op INTENT_RECORDED → DISPATCHED (`store.transition("external_operation", …, "INTENT_RECORDED", "DISPATCHED", ev)` — dùng `journal.confirmExternal` sau, nó tự chuyển; với `markLost` cũng tự chuyển); `outcome = await publisher.upload({ channel: channels.toPublisherChannel(id), episode_no: pkg.episode_no, episode_dir: pkg.episode_dir, intent_at: intent.created_at, timeout_seconds: 2700, log: (l) => sdk.log.info(l) })`:
  - `uploaded` → `journal.confirmExternal(op, { provider_ref: video_id, receipt })`; `updatePublicationJob({ youtube_video_id, receipt })`; `transitionPublication(UPLOADING → PROCESSING)`; ghi `upload-receipt.json`; `done({ external_operations: [op] })`.
  - `unknown` → `journal.markLost(op, reason)`; `transitionPublication(UPLOADING → NEEDS_RECONCILIATION, { reason })`; `sdk.unknown(reason, [op])`.
  - `refused` → `journal.markFailed(op, reason)`; `transitionPublication(UPLOADING → READY, { reason })`; `sdk.fail("contract", reason)`.
  - `busy` → `journal.markFailed(op, reason)`; `UPLOADING → READY`; `sdk.fail("transient", reason)`.
- `schedule`: receipt = input `upload_receipt`; job; `SCHEDULED`/`PUBLISHED` → ghi receipt từ job, `done()`; `state !== "PROCESSING"` → INVALID_TRANSITION; `taken = listPublicationJobs({ channel_id })` lọc `SCHEDULED|PUBLISHED` `.map(scheduled_at)`; `at = nextSlot(channel.config.publication, taken, clock.now())`; `outcome = publisher.schedule({ channel, video_id, at, timeout_seconds: 900 })`: `scheduled` → `updatePublicationJob({ scheduled_at: at })`, `PROCESSING → SCHEDULED`, receipt, `done()`; `refused` → `fail("contract")`; `busy` → `fail("transient")`; ném → transient (runStage).

- [ ] **Step 1: Test thất bại** — `publish-stage.test.ts` (CLI spawn → `pnpm build` trước): dựng project kênh temp (copy `fixtures/ops-project-channel/project.yaml` + `channels/c1/channel.yaml` trỏ `repo_dir` = bản chép temp của `fixtures/legacy-channel-repo`, `adapters: { publisher: playwright, agent: fake }`, `library.root` = kho temp có item `approved` + claim `c1` ghi tay bằng helper Task 11? — Task 11 chưa có; ở đây viết helper cục bộ trong test: ghi manifest như `writeLibraryItem` của `tests/integration/library-helpers.ts` (import trực tiếp helper đó — được, test cli đã import helpers tích hợp ở 2C? nếu không, copy 30 dòng)); `db migrate`; `library sync`; `library pick <item> --channel c1 --json` → content; chạy tay từng stage với workspace giả: `stage-request.json` tự dựng (`run_id`/`stage_run_id`/`attempt_id` là bản ghi thật insert qua store: dùng `plan --workflow channel-publish@1.0.0 --profile channel --content <id>` rồi `enqueue` để có run + stage READY; `claim` bằng `store.claim({ stageRunId })` trong test để có attempt/fencing) — **đơn giản hơn**: test cấp workspace bằng `worker --once` thật (agent fake ghi draft? `FakeAgentRuntime` không ghi `package.json`) → vậy ở task này test `fetch` và `build-package`/`upload`/`schedule` bằng cách gọi CLI con trực tiếp với `HARNESS_WORKSPACE` trỏ workspace temp chứa `stage-request.json` dựng tay từ một run thật (plan + enqueue + `store.claim({ stageRunId })` qua `SqliteStateStore` mở trong test) và inputs ghi tay:
  - `fetch`: item approved + claim → `stage-result.json` succeeded, `output/episode.mp4` checksum = manifest; item `withdrawn` → failed `contract` chứa "withdrawn"; claim thiếu → contract.
  - `build-package`: input `channel_package_draft` = draft mẫu + `thumbnail_set` thư mục + `episode_video` → receipt hợp lệ; repo giả có `episode-15/…` đủ file, manifest đúng template, `.args.json` của overlay có `--line1`; `channel_package` committed, job READY, `episode_no === 15` (channel.yaml `episode.start: 15`); chạy lại cùng run → cùng `package_id`, không cấp 16; thư mục `episode-15` có sẵn không có `.harness-package-id` → contract.
  - `upload` với `FAKE_UPLOAD_MODE=ok` → succeeded, job PROCESSING, op CONFIRMED `provider_ref` = videoId; `lost` → `stage-result.json` outcome `unknown`, job NEEDS_RECONCILIATION, op NEEDS_RECONCILIATION; `refused` → contract, job READY, op FAILED; `busy` → transient, job READY.
  - `schedule` sau `ok` → SCHEDULED với `scheduled_at` = `nextSlot`; `schedules/<id>.json` có `at`; gọi lại → idempotent.
- [ ] **Step 2:** chạy → fail.
- [ ] **Step 3: Triển khai.** Tạo `packages/cli/src/commands/publish.ts` với `registerPublish(program)` = `program.command("publish")` + `registerPublishStage(publish)`; Task 9 mở rộng.
- [ ] **Step 4:** `pnpm install && pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(cli): built-in publish stages (fetch, build-package, upload, schedule); publisher and agent runtime chosen by project.yaml`.

---

### Task 9: CLI `harness channel|publish|skills`, `reconcile --publication`, doctor, worker sweep

**Files:**
- Create: `packages/cli/src/commands/channel.ts`, `packages/cli/src/commands/skills.ts`
- Modify: `packages/cli/src/commands/publish.ts`, `packages/cli/src/commands/reconcile.ts`, `packages/cli/src/commands/doctor.ts`, `packages/cli/src/commands/worker.ts` (truyền deps mới), `packages/cli/src/main.ts`, `packages/core/src/doctor/doctor.ts`, `packages/worker/src/worker.ts`
- Test: `packages/cli/test/channel-publish-commands.test.ts`, `packages/core/test/doctor/doctor.test.ts` (thêm), `packages/worker/test/worker.test.ts` (thêm)

**Interfaces (Produces):**

```ts
// CLI (mọi lệnh --json in JSON một dòng; lỗi HarnessError → exit 1 với "<CODE>: <message>")
harness channel list [--json]                      // channel_id, display_name, publish_times, timezone, episode next (channel_sequence hoặc episode.start)
harness channel show <id> [--json]                 // config + config_revision + số job theo state
harness channel hypotheses <id> [--json]           // từ listChannelPackages({ channel_id }) committed: hypothesis_id, episode_no, chosen.title, expected, status
harness channel login <id>                         // spawn node scripts/open-channel-chrome.mjs (cwd repo_dir) nếu có, else in hướng dẫn mở Chrome với --user-data-dir=<repo>/.upload-profile; chờ thoát; không test spawn thật (fixture có script giả in "fake chrome")
harness publish list [--channel <id>] [--state <S>] [--json]
harness publish show <job> [--json]                // job + package.metadata.title + episode_no + events (listEvents({ run_id }) lọc payload.publication_job_id)
harness publish slots <channel> [--days <n>] [--json]   // n khung kế tiếp (mặc định 7) bằng nextSlot lặp với taken += kết quả
harness publish verify [--json]                    // verifyScheduled một lần; exit 1 nếu errors ≠ []
harness publish reconcile <job> [--json]           // reconcilePublication
harness publish cancel <job> --note <text> [--json]   // READY|PROCESSING|SCHEDULED → FAILED với note; PUBLISHED/FAILED → INVALID_TRANSITION; KHÔNG chạm YouTube
harness reconcile … --publication <job>            // cờ mới trên lệnh reconcile hiện có: gọi reconcilePublication thay reconcile op/run
harness skills sync [--json]                       // copy <harnessRoot>/skills/* vào <project>/.claude/skills/ và <project>/.agents/skills/ (rmSync + cpSync theo từng skill); in danh sách

// doctor.ts (core) — DoctorInput thêm:
channels?: { loaded: LoadedChannel[]; errors: string[]; secrets: SecretResolver };
agent?: { kind: "cli" | "fake"; runtime: "claude" | "codex"; argv0: string; isAvailable: (argv0: string) => boolean };
publisher?: { name: string };
// Rows: "channels:config" (errors rỗng → ok "N channels"; có lỗi → fail nối lỗi; không có channels → không hàng);
// mỗi kênh: "channel:<id>:repo" (repo_dir là thư mục), "channel:<id>:scripts" (upload-youtube-playwright.mjs + publish-video-playwright.mjs tồn tại), "channel:<id>:profile" (<repo>/.upload-profile/Default tồn tại → ok; không → fail "chưa đăng nhập: harness channel login <id>"), "channel:<id>:identity" (channel.config.json: youtube.channelId = expected, projectId = legacy_project_id, youtube.accountEmail = secret resolve), "channel:<id>:secrets" (account_email_ref resolve được);
// "agent:runtime": fake → ok "fake"; cli → isAvailable(argv0) ? ok : fail "<argv0> not on PATH"; "publisher": ok "<name>".

// worker.ts — WorkerDeps thêm:
publication?: { publisher: Publisher; channels: ChannelRegistry; verifySeconds: number; graceHours: number };
dashboard?: { refreshSeconds: number; write: () => Promise<void> };   // hàm ghi snapshot do composition cung cấp (Task 10); worker chỉ gọi theo chu kỳ
// idle: … await this.maybeSyncLibrary(); await this.maybeVerifyPublications(); await this.maybeRefreshDashboard(); — mỗi hàm có stamp riêng, đặt stamp trước khi chạy, lỗi log không ném (như maybeSyncLibrary).
```

- [ ] **Step 1: Test thất bại**
  - `channel-publish-commands.test.ts` (CLI spawn, cần `pnpm build`): project kênh temp với hai `channel.yaml` (`c1`, `c2`) trỏ repo giả; `channel list --json` 2 hàng; `channel show c1 --json` có `config_revision`; job ghi tay qua store (`insertChannelPackage` + `insertPublicationJob` SCHEDULED, PUBLISHED, NEEDS_RECONCILIATION); `publish list --json` 3; `--state SCHEDULED` 1; `--channel c2` đúng; `publish slots c1 --days 3 --json` 3 mốc tăng dần, khác nhau, sau `now`; `publish cancel <ready> --note x` → FAILED, `cancel <published>` → exit 1 `INVALID_TRANSITION`; `publish verify --json` với `adapters.publisher: playwright` + `HARNESS_PUBLISHER_LOOKUP_FILE` (`{ "<vid>": { found: true, video_id, visibility: "public" } }`) → job SCHEDULED quá hạn thành PUBLISHED; `publish reconcile <job NEEDS_RECONCILIATION có video_id>` với lookup file public → PUBLISHED; `reconcile --publication <job>` tương đương; `channel hypotheses c1 --json` liệt kê từ package; `skills sync` tạo `.claude/skills/channel-package/SKILL.md`; lệnh `channel list` trên project không có `channels/` → `[]` exit 0; `channels/bad/channel.yaml` hỏng → `channel list` exit 1 `CONFIG_INVALID`, nhưng `doctor` chạy được và có hàng `channels:config` fail.
  - `doctor.test.ts`: thêm case: channels hợp lệ + repo giả có `.upload-profile/Default` → 5 hàng ok; xóa `Default` → `channel:<id>:profile` fail; `agent: { kind: "cli", argv0: "missing-bin", isAvailable: () => false }` → `agent:runtime` fail; `kind: "fake"` → ok.
  - `worker.test.ts`: `makeWorld` với `publication` (FakePublisher lookup public, `verifySeconds: 10`, `graceHours: 0`) và job SCHEDULED quá hạn → sau `runOnce` idle job PUBLISHED; `runOnce` lần hai ngay sau → `lookups` không tăng; `dashboard: { refreshSeconds: 10, write: spy }` → gọi 1 lần; `write` ném → runOnce vẫn trả `idle` và log error.
- [ ] **Step 2:** chạy → fail.
- [ ] **Step 3: Triển khai.** `worker.ts` của CLI: truyền `publication` khi `ctx.channels.list().length > 0` (publisher, channels, `verifySeconds` từ `ctx.publication`), `dashboard` luôn (write = `writeDashboardSnapshot(ctx)` từ Task 10 — ở Task này để `dashboard` optional và chưa truyền; Task 10 nối).
- [ ] **Step 4:** `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(cli): channel and publish commands, publication reconcile flag, channel/agent doctor rows, worker verify sweep, skills sync`.

---

### Task 10: Dashboard — snapshot, server, `hub.html`, CLI `harness dashboard`

**Files:**
- Create: `packages/core/src/dashboard/snapshot.ts`, `packages/dashboard/{package.json,tsconfig.json,vitest.config.ts,src/index.ts,src/server.ts,public/hub.html}`, `packages/cli/src/commands/dashboard.ts`
- Modify: `packages/core/src/index.ts`, `packages/cli/src/composition.ts` (`writeDashboardSnapshot`), `packages/cli/src/commands/worker.ts` (nối `dashboard.write`), `packages/cli/src/main.ts`, `packages/cli/package.json` (dep `@harness/dashboard`), `vitest.shared.ts` (alias)
- Test: `packages/core/test/dashboard/snapshot.test.ts`, `packages/dashboard/test/server.test.ts`, `packages/cli/test/dashboard.test.ts`

**Interfaces (Produces):**

```ts
// snapshot.ts (core) — kiểu Snapshot theo spec §6.1, đặt schema Zod DashboardSnapshotSchema trong contracts/distribution.ts? KHÔNG: giữ kiểu TS thuần trong core (dashboard là read model, không vào JSON schema); schema_version "harness.dashboard-snapshot/v1" là chuỗi thường.
export interface SnapshotDeps { store: StateStore; channels: LoadedChannel[]; library?: { fs: LibraryFs }; doctorRows?: DoctorRow[]; clock: Clock; gateWindowSeconds: number }
export function buildSnapshot(d: SnapshotDeps): DashboardSnapshot
//  channels[].today.published = jobs SCHEDULED|PUBLISHED có localDate(scheduled_at ?? published_at, tz) === localDate(now, tz)
//  login.profile_dir_exists = existsSync(<repo_dir>/.upload-profile/Default); last_upload_ok_at = max updated_at của job PROCESSING|SCHEDULED|PUBLISHED
//  latest = package có episode_no lớn nhất của kênh + job của nó
//  episodes[] = mọi job (join package); current_stage = stage đầu tiên của run không SUCCEEDED (listStageRuns) hoặc null
//  runs_active = runs RUNNING|WAITING với stage đang RUNNING/CLAIMED/READY (channel_id từ content.library_channel_id)
//  alerts: reconcile (job NEEDS_RECONCILIATION), run_failed (run FAILED trong 7 ngày), gate_overdue (gateOverdue(store, now, gateWindowSeconds)), doctor (row !ok), library_unmounted (!fs.exists()), missing_today (đã qua khung cuối trong ngày theo tz mà published < target)
//  market: {}
export function writeSnapshotFile(dataRoot: string, snapshot: DashboardSnapshot): string   // <dataRoot>/dashboard/snapshot.json tmp+rename; trả đường dẫn

// server.ts (@harness/dashboard) — chỉ node:http/fs/path
export interface DashboardServerOptions { dataRoot: string; port: number; host?: string; hubHtml?: string }
export function startDashboard(o: DashboardServerOptions): Promise<{ port: number; url: string; close(): Promise<void> }>
//  GET / và /hub → hub.html (text/html; charset=utf-8); GET /api/snapshot → file JSON, Cache-Control: no-store, 404 {"error":"no snapshot"}; GET /thumbnails/<name> → <dataRoot>/dashboard/thumbnails/<basename(name)> (image/png|jpeg theo đuôi), 404 nếu thiếu; khác → 404; mọi path đoạn qua path.basename.
export function hubHtmlPath(): string   // join(dirname(fileURLToPath(import.meta.url)), "..", "public", "hub.html") — đúng cả src/ lẫn dist/

// composition.ts
export async function writeDashboardSnapshot(ctx: AppContext): Promise<string>   // runDoctor (rows) + buildSnapshot + writeSnapshotFile

// CLI
harness dashboard snapshot [--json]   // ghi file, in đường dẫn / snapshot
harness dashboard serve [--port <n>] // ghi snapshot một lần rồi startDashboard; in URL; chạy tới Ctrl+C (SIGINT → close)
```

`public/hub.html` theo spec §6.3 (token §8.1 của tài liệu bàn giao; `esc()`; `STATE_LABEL`, `STAGE_LABEL`; chips; kho bar; lưới thẻ; panel cảnh báo; modal kênh với gói đăng tải, nút chép có fallback, đếm ký tự `.over` > 100, hashtag regex Unicode; polling 30 s có điều kiện; `?v=generated_at` cho thumbnail; co tới 720 px). Không thư viện ngoài, không build.

- [ ] **Step 1: Test thất bại**
  - `snapshot.test.ts`: store temp + 2 kênh (temp repo có/không `.upload-profile/Default`) + package/job ghi tay (SCHEDULED hôm nay theo tz, PUBLISHED hôm qua, NEEDS_RECONCILIATION) → `channels[0].today.published === 1`, `login.profile_dir_exists` đúng từng kênh, `episodes.length === 3`, `alerts` có `reconcile` với `ref` = job id, `missing_today` cho kênh có target 1 published 0 khi `now` sau khung cuối; `library` null khi không có; `doctorRows` fail → alert `doctor`; mọi đường dẫn thumbnail dạng `thumbnails/<pkg_id>.png`; `writeSnapshotFile` không để `.tmp` lại.
  - `server.test.ts`: `startDashboard({ dataRoot: temp, port: 0 })` → `fetch(url + "/api/snapshot")` 404 trước khi có file, 200 + `no-store` sau khi ghi; `/hub` 200 chứa `<title>`; `/thumbnails/../snapshot.json` → 404 (basename → tìm `snapshot.json` trong thumbnails/ không có); `/thumbnails/a.png` 200 image/png; `/x` 404; `close()`.
  - `dashboard.test.ts` (cli): `dashboard snapshot --json` trên project kênh temp → file tồn tại và JSON có `schema_version`.
- [ ] **Step 2:** chạy → fail.
- [ ] **Step 3: Triển khai**; `worker.ts` CLI nối `dashboard: { refreshSeconds: ctx.dashboard.refreshSeconds, write: () => writeDashboardSnapshot(ctx) }`.
- [ ] **Step 4:** `pnpm install && pnpm build && pnpm typecheck && pnpm test`; mở tay `harness dashboard serve` trên fixture kênh và xem `/hub` một lần (ghi kết quả vào ledger, chụp không cần).
- [ ] **Step 5: Commit** — `feat(dashboard): read-only snapshot, core-Node server and single-file hub; worker refreshes the snapshot`.

---

### Task 11: Fixture kênh, test tích hợp `publish-pipeline`, acceptance 21–26

**Files:**
- Create: `fixtures/ops-project-channel/channels/channel-one/channel.yaml`, `fixtures/ops-project-channel/channels/channel-two/channel.yaml`, `tests/integration/publish-helpers.ts`, `tests/integration/publish-pipeline.test.ts`, `tests/acceptance/21-upload-lost-reconciled-once.test.ts`, `22-channel-identity-blocks-package.test.ts`, `23-withdrawn-item-not-fetched.test.ts`, `24-verify-sweep.test.ts`, `25-no-secret-in-agent-env-or-upload-log.test.ts`, `26-reconcile-not-found-reuploads-once.test.ts`
- Modify: `fixtures/ops-project-channel/project.yaml` (`workflows: [channel-publish@1.0.0]`, `resources: { browser: 1 }`, `adapters: { publisher: playwright, agent: cli, agent_argv: [node, ../fake-agent-cli.mjs, "{prompt}"] }` — `agent_argv[0]` `node` = `process.execPath` do helper ghi đè; đường dẫn tương đối tới fixture: helper ghi tuyệt đối), `.gitignore`
- `channel.yaml` fixture: `repo_dir: ../legacy-channel-repo` (helper ghi đè bằng bản chép temp), `expected_channel_id: UCfake000000000000000001`, `account_email_ref: secret://youtube/channel-one/email`, `timezone: Asia/Bangkok`, `publish_times: ["20:00"]`, `episode: { start: 15 }`, `seo` mẫu; `channel-two` tương tự với `episode.start: 3`, `publish_times: ["19:00"]`.

**`publish-helpers.ts`:**
```ts
export { cli, drain, status, stageId } from "./footage-helpers.js";
export interface PublishWorld extends LibraryWorld { repos: Record<string, string>; itemId: string; styleId: string; secretsEnv: Record<string, string> }
/** freshLibraryWorld({ media:false }) + chép hai repo giả vào temp + ghi channels/<id>/channel.yaml với repo_dir tuyệt đối + project.yaml kênh với adapters/agent_argv tuyệt đối + item approved trong kho (writeLibraryItem, kèm thumbnail `thumb-01.png` và `thumb-02.png` trong files) + library sync. secretsEnv = { HARNESS_SECRET_YOUTUBE_CHANNEL-ONE_EMAIL: "owner@example.com", …TWO… } (cli() nhận env thêm). */
export function freshPublishWorld(o?: { uploadMode?: string; scheduleMode?: string; agentMode?: string; lookup?: Record<string, unknown> }): PublishWorld
export function pickAndPlan(world: PublishWorld, channelId: string): { contentId: string; runId: string }   // library pick → plan --workflow channel-publish@1.0.0 --profile channel --content → enqueue
export function jobs(world: PublishWorld, channelId?: string): PublicationJob[]     // publish list --json
export function readQueue(repo: string): { ep: string; videoId: string }[]
```
`writeLibraryItem` hiện chỉ ghi `episode.mp4`; mở rộng tham số `extraFiles?: { path: string; body: string; mime_type: string }[]` trong `library-helpers.ts` (thay đổi tương thích).

- [ ] **Step 1: `publish-pipeline.test.ts`** (`testTimeout` 300 s, không cần ffmpeg — `media-probe` skip vì `NullMediaProber`/không ffprobe? **Không**: máy dev có ffprobe và file giả không phải mp4 → `media-probe` fail. Giải pháp: `writeLibraryItem` ghi `episode.mp4` bằng `makeVideo` khi `hasFfmpeg()`, và test `describe.skipIf(!hasFfmpeg())` như 2C — ghi rõ trong helper):
  1. `pickAndPlan(world, "channel-one")` → `drain` (env `FAKE_UPLOAD_MODE=ok`, `HARNESS_PUBLISHER_LOOKUP_FILE`) → run SUCCEEDED; `status --json` mọi stage SUCCEEDED; job SCHEDULED, `scheduled_at` là 20:00 Asia/Bangkok kế tiếp (`13:00Z`); repo one có `outputs/project-01/episodes/episode-15/{full-episode/episode-15-full-episode.mp4,thumbnails/opt1.png,publish/episode-15-upload-manifest.json}`, manifest có `visibility: "private"`, `title` = draft; `publish-queue.json` 1 dòng; `schedules/<vid>.json.at === scheduled_at`; package `hypothesis.basis.length ≥ 1`; `publications/channel-one/<job>/package-manifest.json` tồn tại; `dashboard snapshot --json` có 1 kênh với `episodes_count 1`.
  2. Cùng item, `pickAndPlan(world, "channel-two")` → SUCCEEDED, job thứ hai, `episode_no 3`, `idempotency_key` khác; `publish list --json` 2.
  3. `publish verify --json` với lookup file public cho cả hai vid và `verify_grace_hours: 0` (ghi project.yaml) → cả hai PUBLISHED; snapshot `today.published`.
- [ ] **Step 2: Acceptance**
  - **21**: `FAKE_UPLOAD_MODE=lost` → `drain` dừng với stage `upload` NEEDS_RECONCILIATION, job NEEDS_RECONCILIATION, queue 1 dòng; lookup file `{ "<vid từ queue>": private, không publish_at }` — job chưa có video_id nên reconcile lookup theo title: lookup file hỗ trợ khóa `"title:<title>"` (bổ sung vào `PlaywrightPublisher.lookup` khi dùng lookupFile: tìm theo `video_id` rồi `title:<title>`) → `publish reconcile <job>` → PROCESSING với video_id; đổi `FAKE_UPLOAD_MODE=ok`, `drain` → SCHEDULED; **queue vẫn 1 dòng** (không upload lần hai).
  - **22**: sửa `channel.config.json` của repo one `youtube.channelId` khác → `drain` → stage `build-package` FAILED, check `channel-identity` fail, `publish list` rỗng cho kênh, queue rỗng.
  - **23**: sau `pick`, ghi manifest `withdrawn` (`writeLibraryItem` cùng id, status withdrawn) → `drain` → `fetch-library-item` FAILED kind `contract` chứa "withdrawn".
  - **24**: job SCHEDULED ghi tay quá hạn: lookup public → `publish verify` → PUBLISHED; job khác lookup private không publish_at → NEEDS_RECONCILIATION; `dashboard snapshot` alerts có `reconcile`.
  - **25**: `FAKE_AGENT_MODE=env-dump`, `FAKE_UPLOAD_MODE=ok` với secret env đặt; sau `drain` grep toàn bộ `data/workspaces/**/logs/*.log`, `stage-result.json`, events (`events --json`) và `publications/**/*.log` không chứa `owner@example.com` và không chứa `HARNESS_SECRET_`; `agent-prompt.md` không chứa secret.
  - **26**: `lost` như 21 nhưng lookup file trả `found:false` cho mọi khóa → `publish reconcile` → job READY, op FAILED, stage READY; `FAKE_UPLOAD_MODE=ok` → `drain` → SCHEDULED; queue **2 dòng** (lần "lost" + lần upload lại — đúng một lần upload lại, sau khi đã hỏi provider).
- [ ] **Step 3:** `pnpm build && pnpm test`; không media/data trong repo (`git status` sạch ngoài file mới).
- [ ] **Step 4: Commit** — `test: channel fixture with two channels over a shared kho; publish pipeline integration; acceptance 21-26`.

---

### Task 12: Tài liệu và báo cáo

**Files:** Create `docs/runbooks/channel-publish.md`; Modify `AGENTS.md` (mục "Lệnh 3 (phát hành kênh, dashboard)", quy tắc repo kênh cũ + secret agent), `README.md` (trạng thái + quick-start kênh), `docs/adr/0001-control-plane-baseline.md` (mục 70+ "Sub-project 3"), `docs/operations/deferred-items.md` (mục "sau sub-project 3"), `project-template/project.yaml` (khối `adapters`/`publication`/`dashboard` comment), `project-template/channels/example/channel.yaml` (mẫu có comment), `packages/script-sdk/README.md` (không đổi).

- [ ] **Step 1: Runbook** `channel-publish.md`: (1) khai kênh (`channels/<id>/channel.yaml`, secret email, `expected_channel_id` từ `channel.config.json`), (2) đăng nhập lần đầu `harness channel login <id>` (không copy profile giữa máy — App-Bound Encryption), (3) `harness doctor` các hàng kênh/agent, (4) chu trình `library sync` → `library pick` → `plan --workflow channel-publish@1.0.0 --profile channel --content` → `enqueue` → worker, (5) đọc `publish list|show|slots`, (6) `NEEDS_RECONCILIATION`: `publish reconcile`, khi nào vào Studio tay, `cancel`, (7) đổi giờ phát/`max_daily_uploads` (chỉ ảnh hưởng job sau), (8) dừng kênh (bỏ khỏi `channels/`), (9) dashboard `serve`, checklist nghiệm thu tay (từ tài liệu bàn giao §11 rút gọn), (10) kết quả chạy tay skill `channel-package` với `claude`/`codex` trên máy này (DoD #6) — ghi ngày, model, có qua checker không.
- [ ] **Step 2: ADR 70+:** `publication_job` là transition kind thứ sáu; `channel_package.status` là mirror; stage phát hành built-in; `Publisher` bọc script cũ thay API; `idempotency_key` = channel + video checksum + manifest digest; reconcile hỏi provider trước khi cho upload lại (26); agent-cli: prompt qua file, env sạch, không secret; dashboard đọc snapshot, không ghi; `ChannelConfigSchema` cũ thay bằng bản mới (chưa ai dùng). AGENTS.md: lệnh + quy tắc "không sửa repo kênh cũ ngoài outputs/work". README: trạng thái SP3 + còn lại SP3B/SP4. Deferred: mục từ ledger SP3 + spec §11 (DOM Studio đổi; lịch đặt tay ngoài harness; phiên đăng nhập hết hạn; `captions` không đăng ký output; `lookup.mjs` không test).
- [ ] **Step 3:** `pnpm build && pnpm typecheck && pnpm test`; chạy tay quick-start kênh trên fixture; dọn `fixtures/**/data`, `outputs/`, `work/`, `library/`.
- [ ] **Step 4: Commit** — `docs: channel publish runbook, ADR 70+, AGENTS/README, project template for sub-project 3`.
- [ ] **Step 5:** Báo cáo trong chat: DoD spec §9 từng mục; điều để lại cho SP3B (thu số liệu, đánh giá giả thuyết, tự sinh request) và SP4 (skill cho 5 gate kho).

---

## Tự rà soát plan 3

**Phủ spec:** §0 quyết định → toàn bộ; §1.1 cấu trúc → Task 1, 5, 6, 7, 8, 10; §1.2 `project.yaml` (`adapters`, `publication`, `dashboard`, `resources.browser`) → Task 1, 11; §1.3 `channel.yaml` → Task 1, 3; §1.4 data root `publications/`, `dashboard/` → Task 8, 10; §1.5 ranh giới ghi repo cũ → Task 8 (chỉ `episode-NN`), Global Constraints; §2.1–2.4 entity → Task 1; §2.5 bảng → Task 2; §2.6 máy trạng thái → Task 2 (bảng), Task 8 (upload/schedule), Task 4 (verify/reconcile), Task 9 (cancel); §2.7 lineage → Task 3, 8; §3 5 stage → Task 7 (yaml), 8 (built-in), 6 (agent); profile `channel` → Task 7; §4.1 core → Task 3, 4; §4.2 Publisher + adapter + fake → Task 1, 4, 5; §4.3 agent-cli → Task 6; §4.4 CLI/doctor/worker/composition → Task 8, 9, 10; §5 skill → Task 6, `skills sync` Task 9; §6 dashboard → Task 10; §7 lỗi → Task 8 (map lỗi runStage), 4, 5; §8 test → mọi task + Task 11; §9 DoD → Task 11, 12; §10/§11 → Task 12 (deferred).

**Nhất quán kiểu:** `Publisher`/`UploadOutcome` (`kind` discriminant) dùng ở Task 4 (fake), 5 (playwright), 8 (stage); `LoadedChannel`/`ChannelRegistry` (Task 3) dùng ở 4, 8, 9, 10; `PackageReceiptSchema`/`UploadReceiptSchema`/`ScheduleReceiptSchema` (Task 1) ghi ở Task 8, đọc ở checker Task 4 và test Task 11; output type `episode_video`, `thumbnail_set`, `library_brief`, `channel_package_draft`, `channel_package`, `upload_receipt`, `publication_receipt` khớp giữa workflow (7), stage (8), checker (4), fake agent (6); tên script built-in `publish-fetch|publish-build-package|publish-upload|publish-schedule` khớp giữa composition (8) và workflow (7); `transitionPublication` (Task 3) là đường duy nhất đổi `state` ở 4, 8, 9; `journal.markFailed` (Task 4) dùng ở 8 và 4; `nextSlot` (Task 3) dùng ở 8 và 9; `writeDashboardSnapshot` (Task 10) nối vào worker ở Task 10 (không phải 9).

**Điểm chú ý khi thực thi:**
- Task 1 mở rộng `TransitionKind` kéo theo `TRANSITIONS`/`TABLE_BY_KIND`/`STATE_FIELD_BY_KIND` trong core: thêm khóa `publication_job` ngay ở Task 1 để typecheck xanh (bảng rỗng), Task 2 điền.
- `ChannelPackageSchema`/`PublicationJobSchema` mở rộng có thể làm test cũ của contracts (mẫu entity) fail → cập nhật mẫu.
- Stage built-in chạy qua CLI con: test spawn cần `pnpm build`; `HARNESS_PUBLISHER_LOOKUP_FILE` và `FAKE_*_MODE` phải lọt vào env con (ScriptExecutor kế thừa `process.env`; `CliAgentRuntime` **không** kế thừa — `FAKE_AGENT_MODE` phải nằm trong `env_passthrough` khi test: thêm `"FAKE_AGENT_MODE"` vào passthrough mặc định của cả hai runtime, vô hại ở production).
- `media-probe` trong `fetch-library-item`: test tích hợp cần ffmpeg để item giả là mp4 thật; acceptance 22–26 cũng qua `fetch` nên cùng `skipIf`; acceptance 24 không chạy stage → không cần.
- `reconcilePublication` khi job chưa có `video_id` tra theo title: `PlaywrightPublisher.lookup` với lookupFile hỗ trợ khóa `title:<title>` (Task 5 ghi rõ khi triển khai; Task 11 dùng).
