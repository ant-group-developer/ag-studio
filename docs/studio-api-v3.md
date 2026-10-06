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
  // What the person typed before research: hints for the R&D (it must follow those given). The values in use
  // come from the approved R&D (`GET /productions/:id/rnd`).
  description: string;            // stored in productions.brief
  goal: string; audience: string; tone: string; notes: string;
  sources: string[];              // ag-go folder ids
  ownChannels: string[];          // the team's own YouTube channels (assessed by the R&D)
  youtubeChannels: string[];      // reference channels
  keywords: string[];
  episodeTargetSeconds: number | null; maxEpisodes: number | null;   // null = the R&D proposes it
  hasRnd: boolean; hasBranding: boolean;   // an approved R&D / branding is in use
  waitingGate: 'approve-rnd' | 'approve-branding' | 'approve-plan' | null;
  aspect: '16:9' | '9:16'; language: string;
  music: { track: string; gainDb: number; ducking: boolean } | null;
  status: ProductionStatus;       // derived, see below
  runId: string | null;           // the plan run
  episodeCounts: { total: number; ready: number; producing: number; failed: number };
  ownerUserId: string | null; createdAt: string; updatedAt: string;
}
```
Status: `archived` if archived; `draft` without plan run; `planning` while the plan run is active and not waiting
at a gate; `waiting_approval` when approve-rnd, approve-branding or approve-plan waits; `producing` when some episode is producing; `failed`
when the plan run failed or an episode failed and none is producing; `done` when every episode is ready.

- `GET /productions?page&pageSize&sortBy(title|updatedAt|createdAt|status)&sortOrder&q&teamId&status` -> `Paged<Production>`
  (what the caller can see; admins: all)
- `GET /teams/:teamId/productions` — same, filtered (kept for the team page)
- `POST /teams/:teamId/productions` (producer) body = `ProductionInput` -> Production (atomic with its sources)
- `GET /productions/:id` -> Production (404 when missing)
- `PATCH /productions/:id` (producer) body = `Partial<ProductionInput>` -> Production
- `DELETE /productions/:id` (producer) — cancels the plan run and every episode run first
- `ProductionInput = {title, description?, goal?, audience?, tone?, notes?, sources: string[1..50], ownChannels?: string[],
  youtubeChannels?: string[], keywords?: string[≤20, each ≤100], episodeTargetSeconds?: 10..3600 | null,
  maxEpisodes?: 1..30 | null, aspect, language, music?}` — own + reference channels ≤ 20 together (422
  `too_many_channels`); description ≤ 4000, goal/audience/tone ≤ 1000/1000/500, notes ≤ 4000
- `GET /productions/:id/rnd`, `GET /productions/:id/branding` -> `{document: StudioRnd | StudioBranding | null,
  updatedAt, updatedBy}` (the approved one in use, or the last edit of it)
- `PUT /productions/:id/rnd`, `PUT /productions/:id/branding` (producer) body `{document}` -> the same plus
  `warnings: {code, message}[]`: an edit after approval, used by the AI steps from then on ("Lập lại kế hoạch tập"
  takes it). 409 `not_approved_yet` before the first approval, `gate_waiting` while that gate waits, `apply_pending`
  while the approved one is being applied; 422 `{problems}` when the check fails
- `GET /productions/:id/access` (as today)
- `GET /productions/:id/catalog` -> `StudioCatalog` of the plan run (404 before the catalog stage ran)
- `GET /productions/:id/assets/:assetId/media` -> ag-go `FootageAssetMedia` for the caller:
  `{assetId, previewUrl, previewWidth, previewHeight, watermarked, posterUrl, keyframes: {url, tMs}[], contactSheetUrl, durationMs, expiresAt}`

## Plan run (`/productions/:id/run`)

- `POST` (producer) -> `{runId}` starts the plan run (`ag-studio-series-plan@3.0.0`: research -> trend report ->
  approve-trend-report -> R&D -> approve-rnd -> branding -> approve-branding -> brief -> episode plan -> approve-plan -> episodes). Needs a
  footage folder and a channel or keyword. 409 `episode_producing` while an episode is producing (re-plan refused),
  409 when a plan run is active, 422 with a Vietnamese `message` when the production is incomplete.
- `GET` -> `RunView` (404 `no_run` before the first run)
- `GET documents/:stage/:name` -> the JSON document (e.g. `research/research.json`, `trend-report/trend-report.json`,
  `catalog/catalog.json`, `plan-episodes/series-plan.json`, `approve-plan/series-plan.json`)
- `POST gates/approve-trend-report` body `{document: TrendReport}` (plan 3.0.0), `POST gates/approve-rnd` body `{document: StudioRnd}`, `POST gates/approve-branding` body `{document:
  StudioBranding}`, `POST gates/approve-plan` body `{document: SeriesPlan}` (producer; admins too) ->
  `{accepted: true}`; refused -> 422 `{code: 'gate_rejected', failed: [{check_id, evidence: {problems: {code,
  message}[]}}]}`. What Claude proposed and what was approved go to the dataset (`human_edits` rnd / branding /
  series_plan).
- Doing a step again (run ended, no episode producing): `POST stages/brief/resume` re-plans the episodes with the
  latest R&D and branding; `stages/approve-rnd/resume` proposes the branding again; `stages/rnd/resume` the R&D.
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
// waiting_approval: an episode 1.3.0 waits at approve-timeline or approve-youtube-kit
type EpisodeStatus = 'planned' | 'producing' | 'waiting_approval' | 'ready' | 'failed' | 'cancelled';
interface EpisodeSummary {
  id: string; idx: number; title: string; hook: string; status: EpisodeStatus;
  currentStage: string | null;       // key of the running/waiting/failed stage of its run
  progress: number | null;           // 0..100 while render-final runs (farm job progress), else null
  durationSeconds: number | null;    // from the latest export, else the timeline length
  thumbnailUrl: string | null;       // signed, the picture the episode uses (null without the footage scope)
  updatedAt: string;
}
interface EpisodeDetail extends EpisodeSummary {
  plan: StudioEpisode;                    // episodes.plan
  run: RunView | null;
  youtube: YoutubeKit | null;             // effective kit: episodes.youtube ?? the run's youtube-kit.json
  selectedTitle: number;
  selectedThumbnailId: string | null;     // see Thumbnails
  selectedThumbnail: number; thumbnails: { url: string; index: number }[];   // deprecated: the export's 3 pictures
  exportFiles: { kind: 'mp4' | 'thumbnail' | 'youtube' | 'timeline' | 'pack'; url: string; downloadUrl: string;
    sizeBytes: number; name: string }[];   // 'pack' only for episodes exported before 1.2.0
  finalVideoUrl: string | null; finalVideoDownloadUrl: string | null;   // the download URL saves the file
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
- `POST /:episodeId/youtube-pack` (viewer with the footage scope) -> `{url, name, sizeBytes}`: the zip as the episode
  is now — the picked thumbnail, `youtube.json`, `title.txt`, `description.txt` (with the chapters), `tags.txt`; no
  video (download it on its own). Built on demand, stored once per content; the URL saves the file.

## Thumbnails (`/productions/:id/episodes/:episodeId/thumbnails`)

Episode runs `ag-studio-episode@1.2.0` cut up to 36 clean frames of the final video (away from on-screen words and
clip edges) and draw the YouTube kit's 3 suggestions on them in the branding's thumbnail style. Every picture
carries footage: the routes answer only someone whose footage scope covers the production (`GET` returns
`footageHidden: true` and no items; the others 403 `footage_hidden`). Drawing needs ffmpeg on the API box (503
`thumbnails_unavailable` without it).

```ts
type ThumbnailKind = 'frame' | 'suggestion' | 'composed' | 'upload' | 'canva' | 'ai';
interface ThumbnailView {
  id: string; kind: ThumbnailKind; tS: number | null; assetId: string | null; parentId: string | null;
  text: string | null; style: ThumbnailStyle | null; width: number; height: number; sizeBytes: number;
  createdBy: string;                 // 'system' for a render's frames and suggestions
  createdAt: string; url: string; downloadUrl: string;
  deletable: boolean;                // a person made it
  drawable: boolean;                 // words can go on its clean picture
  inCanva: boolean;                  // the caller opened a Canva design for it
}
interface ThumbnailStyle { position: 'bottom' | 'top' | 'center' | 'left' | 'right'; size: 's' | 'm' | 'l';
  text_color: string; outline_color: string; box_color: string | null; uppercase: boolean }   // colours #RRGGBB
interface ThumbnailList { items: ThumbnailView[]; selectedId: string | null; canDraw: boolean;
  canCutFrames: boolean; framesPending: boolean; framesError: string | null; footageHidden: boolean }
```
- `GET` -> ThumbnailList (an episode exported before 1.2.0 shows its 3 old pictures as suggestions)
- `PUT selected` (editor) `{thumbnailId}` -> ThumbnailList; the pick goes to the dataset (`human_edits` thumbnail)
- `POST preview` (editor) `{baseId, text, style}` -> `{dataUrl}` (half size JPEG, not kept)
- `POST compose` (editor) `{baseId, text ≤60, style}` -> ThumbnailView (`composed`; words on the clean picture under
  `baseId`, never on top of a suggestion's words)
- `POST capture` (editor) `{tS}` -> ThumbnailView (a `frame` of the final video at `tS` seconds)
- `POST upload` (editor) multipart `file` (JPEG/PNG/WebP ≤ 10 MB) -> ThumbnailView (`upload`, filled to 1280×720 or
  720×1280, JPEG ≤ 2 MB)
- `POST frames` (editor) -> 202 `{started, pending}`: cuts the clean frames of an episode rendered before 1.2.0 in the
  background (`framesPending` until they land)
- `DELETE :thumbnailId` (editor) -> ThumbnailList; only pictures a person made (422 `not_user_made`)
- `POST :thumbnailId/canva` (editor) -> `{designId, editUrl}`: the picture as a design in the caller's Canva (with
  words: a PDF import whose words stay editable; else, or when the import fails, the flat picture on a design of its
  size); the same user gets the same design next time. 409 `canva_not_connected` / `canva_reconnect`, 503
  `canva_disabled`, 429 `canva_busy`, 502 `canva_failed`
- `POST :thumbnailId/canva/pull` (editor) -> ThumbnailView: the design as edited, exported and added as a new `canva`
  picture (`parentId` = that thumbnail); 404 `no_canva_design` when the caller never opened it

## Canva (`/canva`) — the caller's own Canva account (docs/runbooks/canva.md)

- `GET connection` -> `{enabled, connected, displayName}` (`enabled` false without the CANVA_* settings: hide Canva)
- `POST authorize` `{returnTo?: string}` (a path of the web app) -> `{authorizeUrl}`; the browser goes there, Canva
  sends it to `GET oauth/callback` (public), which redirects to `STUDIO_WEB_URL + returnTo` with `canva=connected` or
  `canva=error&reason=<code>`
- `DELETE connection` -> `{ok: true}` (the token is revoked at Canva, best effort)

## Editor (`/productions/:id/episodes/:episodeId`)

- `GET timeline` -> `{revision: number, data: TimelineV3, issues: TimelineIssue[], savedAt, authorId}` (404 before build-timeline)
- `GET timeline/revisions` -> `{revision, baseRevision, authorId, label, createdAt}[]`; `GET timeline/revisions/:rev`
- `POST timeline/revisions` (editor) `{baseRevision, data: TimelineV3, label?}` -> `{revision, issues, approved}`; 409
  `revision_conflict` with `currentRevision`. `approved`: the episode's timeline is already approved (episode 1.3.0),
  so this revision is rendered only after Render lại (`rerender` resumes such a run from approve-timeline).
- `POST editor/previews` (editor) `{revision}` -> EditorJob; `GET editor/jobs/:jobId` -> EditorJob & `{url?}`
- `EditorJob = {id, kind: 'render_preview' | 'export_premiere', status: 'queued'|'running'|'completed'|'failed',
  progress: number | null, request, result, error, createdAt}`
- (GĐ6) `POST exports/premiere {media: 'proxy'|'original'}` -> EditorJob; `GET editor/jobs?kind=export_premiere`

## Call log (`/productions/:id`)

- `GET llm-calls?episodeId&page&pageSize` (editor, footage scope) -> `Paged<LlmCallView>`: every Claude call of the
  production, `source` `claude` (a stage) or `claude-chat` (a chat reply; `attemptId` is the reply's turn id)
- `GET llm-calls/:callId` -> the call with its prompt and answer (from the bucket)
- `GET human-edits?page&pageSize` (editor) -> what people approved or changed next to what Claude proposed

## Chat (spec local-chat §3.1)

One thread per production and one per episode. A message goes to the step the production (or episode) is at now —
its **scope**: `intake` (no run yet), `gate` (a gate waiting: `approve-trend-report`, `approve-rnd`,
`approve-branding`, `approve-plan`, `approve-timeline`, `approve-youtube-kit`), `failed` (a Claude stage that
failed its check), `timeline` (an episode with no gate waiting). Claude's reply is written by the worker (it waits
for a `claude` slot, ahead of the steps that run on their own); poll the thread. Nothing a reply proposes is applied
until someone presses Áp dụng / Bắt đầu / Duyệt.

```ts
interface ChatTurn { id: string; production_id: string; episode_id: string | null; run_id: string | null;
  scope: 'intake' | 'gate' | 'failed' | 'timeline'; stage_key: string; turn: number; role: 'user' | 'assistant' | 'system';
  text: string; mentions: {kind: 'folder'; id: string; name: string}[]; context: unknown;
  proposal: unknown | null;   // the stage's document; intake: IntakeDraft; timeline: {ops, base_revision, timeline}
  action: 'answer' | 'revise' | 'suggest_approve' | 'render' | 'export' | 'retry' | null;
  status: 'pending' | 'running' | 'done' | 'failed' | 'rate_limited'; not_before: string | null;
  problems: {code: string; message: string}[];   // a proposal Claude could not make pass the check
  llm_call_id: string | null; created_by: string | null; applied_at: string | null; created_at: string; updated_at: string }
interface ChatThreadView { turns: ChatTurn[];
  scope: {productionId; episodeId; runId; stageKey; scope} | null;
  blocked: {code: 'busy' | 'nothing_to_chat'; stage: string | null} | null;   // why no message can be sent now
  current: {turnId: string | null; document: unknown; draft: unknown; pendingApply: boolean;
    problems: {code, message}[]} | null;   // on show; problems: why a failed stage was refused
  queueAhead: number }   // replies of other threads waiting for a Claude slot before this one
```

- `POST /teams/:teamId/drafts` (producer) `{text}` -> `{productionId, user, assistant}`: a draft production (title
  "Video mới") and its first intake message. `@[name](folder:<id>)` in the text names an ag-go folder; one the
  person cannot see -> 422 `folder_not_accessible`.
- `GET /productions/:id/chat?episodeId&after` (viewer) -> ChatThreadView (`after`: a turn number)
- `POST /productions/:id/chat` (editor) `{text, episodeId?}` -> `{user, assistant}`; 409 `busy` while Claude or a
  render works on the step, `nothing_to_chat` when the run is over. A message sent while a reply waits joins it.
- `POST /productions/:id/chat/:turnId/apply` (intake: producer; timeline: editor) -> `{revision?}`: the intake draft
  into the production, or timeline edits saved as a revision (409 `revision_conflict` when it changed since, 409
  `superseded` / `already_applied`)
- `POST /productions/:id/start` (producer) -> `{runId}`: the newest intake draft into the production, then the plan
  run; 422 `intake_incomplete` with `missing: ('title'|'folder_ids'|'aspect'|'language'|'research')[]`
- `POST /productions/:id/chat/approve` (producer) `{stageKey, episodeId?, turnId?}` -> `{stageState, runState,
  revision?}`: approves the document on show (`turnId` = `current.turnId`; 409 `stale_version` when a newer one
  exists, `stale_step` when the gate is no longer waiting). `approve-timeline` submits the latest revision (409
  `not_applied` when `turnId` is a timeline proposal not applied yet). Draft and approved version go to `human_edits`.
- `POST /productions/:id/chat/retry` (producer) `{stageKey, episodeId?}` -> 202: runs the failed Claude stage again
  with the chat's messages about it in its prompt; 409 `not_failed`
- `POST /productions/:id/chat/manual` (producer) `{stageKey, episodeId?, document}` -> ChatTurn: a version written by
  hand becomes the one on show (422 `rejected` with `failed` when it does not match the stage's schema)

## Studio (`/studio`)

- `GET overview` -> `{items: OverviewItem[]}`, most urgent first:
  `{id, teamId, title, updatedAt, step: string | null, group: 'waiting_you' | 'needs_attention' | 'running' | 'done',
  episodes: {id, idx, title, status: EpisodeStatus, step, group}[]}` — the productions of the caller's teams (an admin:
  all), not archived
- `GET claude` -> `{running, waiting, max, source: 'settings' | 'env'}`: Claude slots held (stages and chat replies),
  replies in line, the cap
- `PUT settings` (Studio admin) `{claudeMaxConcurrent: 1..100}` -> the same as `GET claude`; the worker applies it on
  its next claim
