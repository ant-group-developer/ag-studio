# Studio API v3 (series) — the contract between apps/api and apps/web

All routes are under `/api`, JSON, wrapped in the response envelope `{data, requestId, timestamp, success, error}`
(as today). DTOs the API owns are camelCase; engine views (`RunView`, `StageView`) and the Studio documents
(`packages/contracts/src/studio.ts`: `SeriesPlan`, `TimelineV3`, `YoutubeKit`, `StudioResearch`, `TrendReport`,
`StudioCatalog`…) keep their snake_case shape. Roles: `viewer < editor < producer < owner`; a Studio admin
(Account API `user_type = ADMIN`) passes every role check. Paged lists: query `page` (1-based), `pageSize`
(default 20, max 100), `sortBy`, `sortOrder` (`asc|desc`), optional `q`; answer `Paged<T> = {items: T[], total,
page, pageSize}`.

## Me / teams (GĐ3)

- `GET /me` -> `{userId, name, email, avatar, isAdmin}`
- `GET /teams?page&pageSize&sortBy(name|createdAt)&sortOrder&q` -> `Paged<Team & {role: TeamRole | null, memberCount, productionCount}>`
  (admins see every team; `role` is the caller's role, null for an admin who is not a member)
- `POST /teams {name}` -> Team; `PATCH /teams/:teamId {name}` (owner) -> Team; `DELETE /teams/:teamId` (owner; 409
  `team_has_active_runs` while any production of it has an active run)
- `GET /teams/:teamId/members?page&pageSize&sortBy(role|joinedAt|name)&sortOrder&q` -> `Paged<TeamMember>`;
  existing member add/role/remove routes keep working; removing or demoting the last owner -> 409 `last_owner`
- `GET /teams/:teamId` (viewer) -> `{id, name, role: TeamRole | null, memberCount, productionCount, createdAt, updatedAt}`

## Team skills ("quy chuẩn & skill")

Markdown a team writes about how it makes videos. Every Claude stage of one of the team's productions gets the
enabled skills that apply to its step, read when the call is made (`teamGuidesForRun`), in a `# Quy chuẩn của nhóm`
section before `# Dữ liệu vào`, each one in `<team_guide name="…" purpose="…">…</team_guide>`.

```ts
type TeamSkillStep = 'trend-report' | 'rnd' | 'branding' | 'plan-episodes' | 'youtube-kit';
interface TeamSkill {
  id: string; teamId: string; name: string; purpose: string;
  appliesTo: TeamSkillStep[];      // [] = every step
  content: string;                 // markdown
  enabled: boolean; position: number;
  createdBy: string; updatedBy: string; createdAt: string; updatedAt: string;
}
```
- `GET /teams/:teamId/skills` (viewer) -> `TeamSkill[]` ordered by `position`, then creation
- `POST /teams/:teamId/skills` (producer) `{name, purpose?, appliesTo?, content, enabled?, position?}` -> 201 TeamSkill
- `PATCH /teams/:teamId/skills/:skillId` (producer) `Partial<…>` -> TeamSkill
- `DELETE /teams/:teamId/skills/:skillId` (producer) -> 204
- Limits: name 1..100, purpose ≤ 500, content 1..20 000 characters; the enabled skills of a team together ≤ 60 000
  (422 `team_skills_too_long`); a name used twice in a team -> 409 `team_skill_name_taken`; another team's skill -> 404.

## Productions

```ts
type ProductionStatus = 'draft' | 'planning' | 'waiting_approval' | 'producing' | 'done' | 'failed' | 'archived';
interface Production {
  id: string; teamId: string; teamName: string; title: string;
  description: string;            // stored in productions.brief
  goal: string; audience: string; tone: string; notes: string;
  sources: string[];              // ag-go folder ids
  youtubeChannels: string[]; keywords: string[];
  episodeTargetSeconds: number | null; maxEpisodes: number;   // default 10
  aspect: '16:9' | '9:16'; language: string;
  music: { track: string; gainDb: number; ducking: boolean } | null;
  status: ProductionStatus;       // derived, see below
  runId: string | null;           // the plan run
  episodeCounts: { total: number; ready: number; producing: number; failed: number };
  ownerUserId: string | null; createdAt: string; updatedAt: string;
}
```
Status: `archived` if archived; `draft` without plan run; `planning` while the plan run is active and not waiting
at approve-plan; `waiting_approval` when approve-plan waits; `producing` when some episode is producing; `failed`
when the plan run failed or an episode failed and none is producing; `done` when every episode is ready.

- `GET /productions?page&pageSize&sortBy(title|updatedAt|createdAt|status)&sortOrder&q&teamId&status` -> `Paged<Production>`
  (what the caller can see; admins: all)
- `GET /teams/:teamId/productions` — same, filtered (kept for the team page)
- `POST /teams/:teamId/productions` (producer) body = `ProductionInput` -> Production (atomic with its sources)
- `GET /productions/:id` -> Production (404 when missing)
- `PATCH /productions/:id` (producer) body = `Partial<ProductionInput>` -> Production
- `DELETE /productions/:id` (producer) — cancels the plan run and every episode run first
- `ProductionInput = {title, description, goal?, audience?, tone?, notes?, sources: string[1..50], youtubeChannels?:
  string[≤20], keywords?: string[≤20, each ≤100], episodeTargetSeconds: 10..3600, maxEpisodes?: 1..30, aspect,
  language, music?}`
- `GET /productions/:id/access` (as today)
- `GET /productions/:id/catalog` -> `StudioCatalog` of the plan run (404 before the catalog stage ran)
- `GET /productions/:id/assets/:assetId/media` -> ag-go `FootageAssetMedia` for the caller:
  `{assetId, previewUrl, previewWidth, previewHeight, watermarked, posterUrl, keyframes: {url, tMs}[], contactSheetUrl, durationMs, expiresAt}`

## Plan run (`/productions/:id/run`)

- `POST` (producer) -> `{runId}` starts the plan run. 409 `episode_producing` while an episode is producing (re-plan
  refused), 409 when a plan run is active, 422 with a Vietnamese `message` when the production is incomplete.
- `GET` -> `RunView` (404 `no_run` before the first run)
- `GET documents/:stage/:name` -> the JSON document (e.g. `research/research.json`, `trend-report/trend-report.json`,
  `catalog/catalog.json`, `plan-episodes/series-plan.json`, `approve-plan/series-plan.json`)
- `POST gates/approve-plan` (producer) body `{document: SeriesPlan}` -> `{accepted: true}`; refused -> 422
  `{code: 'gate_rejected', failed: [{check_id, evidence: {problems: {code, message}[]}}]}`
- `POST stages/:stage/retry`, `POST stages/:stage/resume` (producer), `POST cancel` (producer)

```ts
interface RunView { run_id: string; state: string; created_at: string; updated_at: string; cost_usd: number;
  waiting_gate: string | null; stages: StageView[]; latest_revision: number | null }
interface StageView { key: string; executor: string; state: string; attempts: number; is_gate: boolean;
  error: string | null; failed_checks: {check_id: string; evidence: Record<string, unknown>}[];
  outputs: {name: string; type: string; size_bytes: number}[] }
```

## Episodes (`/productions/:id/episodes`)

```ts
type EpisodeStatus = 'planned' | 'producing' | 'ready' | 'failed' | 'cancelled';
interface EpisodeSummary {
  id: string; idx: number; title: string; hook: string; status: EpisodeStatus;
  currentStage: string | null;       // key of the running/waiting/failed stage of its run
  progress: number | null;           // 0..100 while render-final runs (farm job progress), else null
  durationSeconds: number | null;    // from the latest export, else the timeline length
  thumbnailUrl: string | null;       // signed, the selected thumbnail of the latest export
  updatedAt: string;
}
interface EpisodeDetail extends EpisodeSummary {
  plan: StudioEpisode;                    // episodes.plan
  run: RunView | null;
  youtube: YoutubeKit | null;             // effective kit: episodes.youtube ?? the run's youtube-kit.json
  selectedTitle: number; selectedThumbnail: number;
  thumbnails: { url: string; index: number }[];                 // latest render
  exportFiles: { kind: 'mp4' | 'thumbnail' | 'youtube' | 'timeline' | 'pack'; url: string; sizeBytes: number; name: string }[];
  finalVideoUrl: string | null;
  latestRevision: number | null;
}
```
- `GET ?page&pageSize&sortBy(idx|title|status|updatedAt)&sortOrder` -> `Paged<EpisodeSummary>` (default idx asc)
- `GET /:episodeId` -> EpisodeDetail
- `PATCH /:episodeId` (editor) `{youtube?: YoutubeKit, selectedTitle?: 0..2, selectedThumbnail?: 0..2}` -> EpisodeDetail
  (the kit is validated with YoutubeKitSchema + validateYoutubeKit; 422 with problems)
- `POST /:episodeId/rerender` (producer) -> `{runId}`; 409 `episode_running` while its run is active
- `POST /:episodeId/cancel` (producer); `POST /:episodeId/stages/:stage/retry` (producer)
- `GET /:episodeId/documents/:stage/:name`

## Editor (`/productions/:id/episodes/:episodeId`)

- `GET timeline` -> `{revision: number, data: TimelineV3, issues: TimelineIssue[], savedAt, authorId}` (404 before build-timeline)
- `GET timeline/revisions` -> `{revision, baseRevision, authorId, label, createdAt}[]`; `GET timeline/revisions/:rev`
- `POST timeline/revisions` (editor) `{baseRevision, data: TimelineV3, label?}` -> `{revision, issues}`; 409
  `revision_conflict` with `currentRevision`
- `POST editor/previews` (editor) `{revision}` -> EditorJob; `GET editor/jobs/:jobId` -> EditorJob & `{url?}`
- `EditorJob = {id, kind: 'render_preview' | 'export_premiere', status: 'queued'|'running'|'completed'|'failed',
  progress: number | null, request, result, error, createdAt}`
- (GĐ6) `POST exports/premiere {media: 'proxy'|'original'}` -> EditorJob; `GET editor/jobs?kind=export_premiere`
