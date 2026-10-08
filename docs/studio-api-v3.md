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
type TeamSkillStep = 'intake' | 'web-research' | 'trend-report' | 'style' | 'rnd' | 'branding' | 'plan-episodes'
  | 'source-survey' | 'edit-plan' | 'timeline' | 'youtube-kit';
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
  hasStyle: boolean;              // plan 3.2.0: an edit style is kept (a skipped one counts)
  planWorkflow: string | null;    // the plan run's release ('ag-studio-series-plan@3.2.0'…); 3.2.0 on has the style step
  waitingGate: 'approve-trend-report' | 'approve-style' | 'approve-rnd' | 'approve-branding' | 'approve-plan' | null;
  aspect: '16:9' | '9:16'; language: string;
  music: { track: string; gainDb: number; ducking: boolean } | null;
  status: ProductionStatus;       // derived, see below
  runId: string | null;           // the plan run
  episodeCounts: { total: number; ready: number; producing: number; failed: number };
  ownerUserId: string | null; createdAt: string; updatedAt: string;
}
```
Status: `archived` if archived; `draft` without plan run; `planning` while the plan run is active and not waiting
at a gate; `waiting_approval` when approve-trend-report, approve-style, approve-rnd, approve-branding or approve-plan waits; `producing` when some episode is producing; `failed`
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
- Plan 3.2.0: `GET /productions/:id/style` (viewer), `PUT /productions/:id/style` (producer) body `{document:
  StudioStyle}` — the edit style learned from the reference videos, same answers as rnd/branding (the check does not
  read the frames again). `GET /productions/:id/style/frames?at=<video id>@<seconds>,…` (viewer, at most 12) ->
  `{frames: {video_id, t, url}[]}`: short-lived URLs of the frames the style cites as evidence (frames of the YouTube
  reference videos, kept under the production on the bucket; the videos themselves are deleted when measured). 422
  `bad_frame` for anything that is not `<11-char id>@<t>`.
- `GET /productions/:id/access` (as today)
- `GET /productions/:id/catalog` -> `StudioCatalog` of the plan run (404 before the catalog stage ran)
- `GET /productions/:id/assets/:assetId/media` -> ag-go `FootageAssetMedia` for the caller:
  `{assetId, previewUrl, previewWidth, previewHeight, watermarked, posterUrl, keyframes: {url, tMs}[], contactSheetUrl, durationMs, expiresAt}`

## Plan run (`/productions/:id/run`)

- `POST` (producer) -> `{runId}` starts the plan run (`ag-studio-series-plan@3.2.0`: research (YouTube API, the
  web for what it misses) -> trend report -> approve-trend-report -> R&D -> approve-rnd -> branding -> approve-branding
  -> brief -> episode plan -> approve-plan -> episodes; beside them, from the research: reference videos -> style ->
  approve-style, which branding and the brief wait for). Needs a footage folder and a channel or keyword. 409 `episode_producing` while an episode is producing (re-plan refused),
  409 when a plan run is active, 422 with a Vietnamese `message` when the production is incomplete.
- `GET` -> `RunView` (404 `no_run` before the first run)
- `GET documents/:stage/:name` -> the JSON document (e.g. `research/research.json`, `trend-report/trend-report.json`,
  `catalog/catalog.json`, `plan-episodes/series-plan.json`, `approve-plan/series-plan.json`; plan 3.2.0 also
  `research-api/research.json`, `research-web/web-finds.json`, `pick-references/references.json`, `analyze-style/style.json`)
- `POST gates/approve-trend-report` body `{document: TrendReport}` (plan 3.0.0), `POST gates/approve-style` body
  `{document: StudioStyle}` (plan 3.2.0), `POST gates/approve-rnd` body `{document: StudioRnd}`, `POST gates/approve-branding` body `{document:
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
// waiting_approval: an episode 1.3.0 waits at approve-timeline or approve-youtube-kit (shot-cut 1.0.0: also
// approve-survey, approve-edit-plan)
type EpisodeStatus = 'planned' | 'producing' | 'waiting_approval' | 'ready' | 'failed' | 'cancelled';
interface EpisodeSummary {
  id: string; idx: number; title: string; hook: string; status: EpisodeStatus;
  currentStage: string | null;       // key of the running/waiting/failed stage of its run
  progress: number | null;           // 0..100 while render-final runs (farm job progress), else null
  durationSeconds: number | null;    // from the latest export, else the timeline length
  thumbnailUrl: string | null;       // signed, the picture the episode uses (null without the footage scope)
  updatedAt: string;
  editStyle: 'whole' | 'cut';        // whole videos (timeline v3) or shot by shot (timeline v4, phase 5)
}
interface EpisodeDetail extends EpisodeSummary {
  plan: StudioEpisode;                    // episodes.plan
  run: RunView | null;
  workflow: string | null;                // the run's workflow 'id@version' ('ag-studio-episode-cut@1.0.0'…); null before a run
  youtube: YoutubeKit | null;             // effective kit: episodes.youtube ?? the run's youtube-kit.json
  selectedTitle: number;
  selectedThumbnailId: string | null;     // see Thumbnails
  selectedThumbnail: number; thumbnails: { url: string; index: number }[];   // deprecated: the export's 3 pictures
  exportFiles: { kind: 'mp4' | 'thumbnail' | 'youtube' | 'timeline' | 'pack'; url: string; downloadUrl: string;
    sizeBytes: number; name: string }[];   // 'pack' only for episodes exported before 1.2.0
  finalVideoUrl: string | null; finalVideoDownloadUrl: string | null;   // the download URL saves the file
  latestRevision: number | null;
  render: EpisodeRender;
}
// The scene selection of a shot-cut episode (survey.json, harness.survey-index/v2), shot by shot
interface EpisodeShots {
  state: 'pending' | 'waiting' | 'approved';   // not made yet / at approve-survey (chat edits included) / as approved
  turnId: string | null;                        // the chat turn of the version on show while waiting (for chat/approve)
  shots: { sourceId: string; shotId: string;   // shotId 's000-002' = first video, third shot
    in: number; out: number;                    // seconds in the video
    score: number; tags: string[]; usable: boolean; note: string; speech: 'none' | 'talking' | 'ambient';
    frameUrl: string | null;                    // signed middle frame of the shot (null before watch-source)
    changed: boolean }[];                       // usable/score/note differs from Claude's selection
}
type RenderMachine = 'any' | 'nvenc' | 'gpu';   // ag-farm requirements {} | {nvenc: true} | {gpu: true}
interface EpisodeRender {
  machine: RenderMachine | null;          // chosen for the current run's final render (null: none, the job goes out as {})
  defaultMachine: RenderMachine;          // what a picker starts on: machine ?? the production's latest choice ?? 'any'
  // where Render lại starts now: 'start' (no run), 'render-final' (the approved timeline did not change),
  // 'approve-timeline' (edited since approval), 'freeze-timeline' (episode 1.2.0, or a run parked there); null: producing
  restartFrom: 'start' | 'render-final' | 'approve-timeline' | 'freeze-timeline' | null;
  job: { farmJobId: string; runId: string; machine: RenderMachine | null; createdAt: string } | null;   // latest final render
  farmStatus: { status: string; progress: number | null } | null;   // the farm's view of `job` while the run renders it
}
```
- `GET ?page&pageSize&sortBy(idx|title|status|updatedAt)&sortOrder` -> `Paged<EpisodeSummary>` (default idx asc)
- `GET /:episodeId` -> EpisodeDetail
- `PATCH /:episodeId` (editor) `{youtube?: YoutubeKit, selectedTitle?: 0..2, selectedThumbnail?: 0..2}` -> EpisodeDetail
  (the kit is validated with YoutubeKitSchema + validateYoutubeKit; 422 with problems)
- `POST /:episodeId/rerender` (producer) `{renderMachine?: RenderMachine}` -> `{runId, reused, from}`; `from` as
  `render.restartFrom`. The type is kept for that run's final render; without one the run's choice stays, or `{}`.
  409 `episode_running` while its run is active
- `POST /:episodeId/rerun-from` (producer) `{stage: 'approve-survey' | 'approve-edit-plan'}` -> `{runId, reused}`
  (shot-cut episodes): a new run waiting at that gate again with Claude's document, the stages before it reused
  (proxies, shots and frames are not made again). Only when the run has ended or waits at a later gate (that run is
  cancelled); 409 `gate_not_passed`, 409 `episode_running`; 422 `not_cut` for a whole-video episode; any other
  stage -> 400
- `GET /:episodeId/shots` (viewer with the footage scope, else 403 `footage_hidden`) -> EpisodeShots; 422 `not_cut`
- `POST /:episodeId/cancel` (producer); `POST /:episodeId/stages/:stage/retry` (producer)
- `GET /:episodeId/documents/:stage/:name`
  (shot-cut: `source-survey/survey.json`, `approve-survey/survey.json`, `plan-edit/edit-plan.json`,
  `approve-edit-plan/edit-plan.json`, `fit-timeline/fit-report.json`, `media-index/shots.json`)
- `POST /:episodeId/youtube-pack` (viewer with the footage scope) -> `{url, name, sizeBytes}`: the zip as the episode
  is now — the picked thumbnail, `youtube.json`, `title.txt`, `description.txt` (with the chapters), `tags.txt`; no
  video (download it on its own). Built on demand, stored once per content; the URL saves the file.

## Step documents (`/productions/:id/steps/:kind`, `/productions/:id/episodes/:episodeId/steps/:kind`)

A step's document read again after its approval and edited (plan 2026-10-07 step history). `kind`: series
`trend_report | rnd | branding | series_plan | style` (plan 3.2.0), episode `youtube_kit | survey | edit_plan` (the other side: 422
`bad_kind`).
- `GET` (viewer) -> `{kind, gate, state: 'not_yet' | 'waiting' | 'approved', document, inUse, edit: {inPlace,
  inPlaceCode, reopen, reopenCode, replacesEpisodes, reruns: string[]}}`. `document` (approved only): the version in
  use when one was edited (`productions.trend_report|rnd|branding`, `episodes.youtube`), else the gate's approved
  output. `waiting`: edit through the chat's manual edit at that gate.
- `PUT` body `{document, reopen?: boolean}` -> `{mode: 'saved' | 'reopened', runId?, warnings, view}`. `reopen`
  false replaces the version in use (only trend report once the episodes exist, R&D, branding, YouTube kit; 409
  `only_reopen` otherwise, `apply_pending`). `reopen` true starts the run again from the gate (a run parked at a later
  gate with nothing working is cancelled first) and puts the edit on show there as a manual-edit turn: approving it
  runs the steps after. 409 `running`, `episode_producing` (plan steps), `render_again` (the kit: save, then Render
  lại), `at_gate`, `not_approved_yet`; 422 `{problems}` when the schema check fails (the gate's checks run when it is
  approved again). Reopening a series step makes the episodes again after `approve-plan` (`replacesEpisodes`).
  Series: producer. Episode: editor for the kit in place, producer otherwise.

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

- `GET timeline` -> `{revision: number, data: TimelineV3 | TimelineV4, issues: TimelineIssue[], savedAt, authorId}` (404
  before build-timeline / fit-timeline). An episode keeps the version of its first revision: whole-video episodes v3,
  shot-cut episodes v4 (contract in `packages/contracts/src/studio.ts`, ADR-0001 item 151)
- `GET timeline/revisions` -> `{revision, baseRevision, authorId, label, createdAt}[]`; `GET timeline/revisions/:rev`
- `POST timeline/revisions` (editor) `{baseRevision, data: TimelineV3 | TimelineV4, label?}` -> `{revision, issues, approved}`; 409
  `revision_conflict` with `currentRevision`. `approved`: the episode's timeline is already approved (episode 1.3.0),
  so this revision is rendered only after Render lại (`rerender` resumes such a run from approve-timeline). A v4
  timeline on a v3 episode is stored as v3; one v3 cannot hold (a trim, a transition, narration, captions) -> 422 `not_v3`.
- `POST editor/previews` (editor) `{revision}` -> EditorJob; `GET editor/jobs/:jobId` -> EditorJob & `{url?}`
- `EditorJob = {id, kind: 'render_preview' | 'export_premiere', status: 'queued'|'running'|'completed'|'failed',
  progress: number | null, request, result, error, createdAt}`
- (GĐ6) `POST exports/premiere {media: 'proxy'|'original'}` -> EditorJob; `GET editor/jobs?kind=export_premiere`.
  A v4 timeline with trims, transitions or narration -> 422 `premiere_needs_phase_4`.

## Call log (`/productions/:id`)

- `GET llm-calls?episodeId&page&pageSize` (editor, footage scope) -> `Paged<LlmCallView>`: every Claude call of the
  production, `source` `claude` (a stage) or `claude-chat` (a chat reply; `attemptId` is the reply's turn id)
- `GET llm-calls/:callId` -> the call with its prompt and answer (from the bucket)
- `GET human-edits?page&pageSize` (editor) -> what people approved or changed next to what Claude proposed

## Chat (spec local-chat §3.1)

One thread per production and one per episode. A message goes to the step the production (or episode) is at now —
its **scope**: `intake` (no run yet), `gate` (a gate waiting: `approve-trend-report`, `approve-style` (plan 3.2.0; when
two wait at once, the earlier stage's), `approve-rnd`,
`approve-branding`, `approve-plan`, `approve-timeline`, `approve-youtube-kit`; shot-cut episodes also `approve-survey`,
`approve-edit-plan`), `failed` (a Claude stage that
failed its check), `timeline` (an episode with no gate waiting). Claude's reply is written by the worker (it waits
for a `claude` slot, ahead of the steps that run on their own); poll the thread. Nothing a reply proposes is applied
until someone presses Áp dụng / Bắt đầu / Duyệt.

```ts
interface ChatTurn { id: string; production_id: string; episode_id: string | null; run_id: string | null;
  scope: 'intake' | 'gate' | 'failed' | 'timeline'; stage_key: string; turn: number; role: 'user' | 'assistant' | 'system';
  text: string; mentions: {kind: 'folder'; id: string; name: string}[]; context: unknown;
  proposal: unknown | null;   // the stage's document; intake: IntakeDraft; timeline: {ops, base_revision, timeline};
                              // approve-survey: {ops: SurveyOp[], survey} (SurveyOp: keep | reject | setScore | setNote)
  action: 'answer' | 'revise' | 'suggest_approve' | 'render' | 'export' | 'retry' | null;
  status: 'pending' | 'running' | 'done' | 'failed' | 'rate_limited'; not_before: string | null;
  problems: {code: string; message: string}[];   // a proposal Claude could not make pass the check
  llm_call_id: string | null; created_by: string | null; applied_at: string | null; created_at: string; updated_at: string }
interface ChatThreadView { turns: ChatTurn[];
  scope: {productionId; episodeId; runId; stageKey; scope} | null;
  blocked: {code: 'busy' | 'nothing_to_chat' | 'needs_voice' | 'stage_failed'; stage: string | null;
    problems?: {code, message}[]} | null;   // why no message can be sent now (see below)
  current: {turnId: string | null; document: unknown; draft: unknown; pendingApply: boolean;
    problems: {code, message}[]} | null;   // on show; problems: why a failed stage was refused
  queueAhead: number }   // replies of other threads waiting for a Claude slot before this one
```

`blocked.code`: `busy` (Claude or a machine is working on the step), `nothing_to_chat` (the run is over),
`needs_voice` (a narrated shot-cut episode stopped at `tts`: the production has no voice; give one or decline narration
under "Audio" below), `stage_failed` (a machine step (farm, script, in-process) stopped; `problems` are the errors of
its newest failed attempt; run it again with `POST .../stages/:stage/retry`). The intake draft may carry
`audio_links: {voice, music}` (links the person pasted in the chat; nothing is fetched until they press it).

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
- `POST /productions/:id/chat/approve` (producer) `{stageKey, episodeId?, turnId?, renderMachine?}` -> `{stageState,
  runState, revision?}`: approves the document on show (`turnId` = `current.turnId`; 409 `stale_version` when a newer
  one exists, `stale_step` when the gate is no longer waiting). `approve-timeline` submits the latest revision (409
  `not_applied` when `turnId` is a timeline proposal not applied yet). Draft and approved version go to `human_edits`.
  `renderMachine` only with `approve-youtube-kit` (it starts the final render; 422 `no_render_here` on another gate).
- `POST /productions/:id/chat/retry` (producer) `{stageKey, episodeId?}` -> 202: runs the failed Claude stage again
  with the chat's messages about it in its prompt; 409 `not_failed`
- `POST /productions/:id/chat/manual` (producer) `{stageKey, episodeId?, document}` -> ChatTurn: a version written by
  hand becomes the one on show (422 `rejected` with `failed` when it does not match the stage's schema)

## Audio (`/productions/:id/audio`): voice sample and music, both optional (ADR-0001 items 167-168)

```ts
interface ProductionAudio {
  voice: {mode: 'none'; decided_at: string}                                  // narration declined
    | {mode: 'clone'; origin: 'synthetic' | 'own' | 'licensed' | null; source: AudioSource | null; duration_s: number | null;
       reference_text: string | null; reference: string; listenUrl: string | null}   // source null: set before (SQL/env)
    | null;                                                                   // not asked (Studio default if configured)
  music: {track: string; gain_db: number; ducking: boolean; source: AudioSource | null; duration_s: number | null;
    listenUrl: string | null} | null }
type AudioSource = {kind: 'link'; url: string} | {kind: 'upload'; filename: string} | {kind: 'ag-go'; asset_id: string}
```

- `GET /productions/:id/audio` (viewer) -> ProductionAudio (`listenUrl`: signed, only for files a person gave)
- `POST /productions/:id/audio/voice|music` (editor): multipart `file` **or** JSON `{url}`, plus for a voice
  `origin` and `confirm: true` (the person vouches they may use it), `referenceText?` (what is said; empty = the TTS
  engine listens); for music `gainDb?` (default -18), `ducking?` (default true) -> ProductionAudio &
  `{resumedEpisodes: string[]}`. The server fetches a link itself (public addresses only unless
  `STUDIO_AUDIO_ALLOW_PRIVATE_URLS`; Google Drive share links work), checks it with ffprobe, keeps a voice as 24 kHz mono
  WAV (first 20 s) and music as AAC under `library/studio/<production>/...`. A voice runs on the episodes stopped at
  `tts`. 400 `voice_consent` / `audio_missing` / `url_not_allowed` / `invalid`, 413 `audio_too_large` (voice 20 MB,
  music 100 MB), 422 `audio_invalid` (no sound, voice < 3 s, music < 5 s), 502 `url_fetch_failed`, 503 `audio_disabled`
  (no `STUDIO_FFMPEG_PATH`/`STUDIO_FFPROBE_PATH`).
- `POST /productions/:id/audio/voice/none` (editor) -> ProductionAudio & `{resumedEpisodes}`: "Bỏ lời dẫn" for the whole
  production; episodes waiting for a voice are cut without lines; the series plan no longer picks `tts`.
- `DELETE /productions/:id/audio/voice|music` (editor) -> ProductionAudio: back to not asked / no music.

Every change goes to `human_edits` (`kind: voice | music`).

## Studio (`/studio`)

- `GET overview` -> `{items: OverviewItem[]}`, most urgent first:
  `{id, teamId, title, updatedAt, step: string | null, group: 'waiting_you' | 'needs_attention' | 'running' | 'done',
  episodes: {id, idx, title, status: EpisodeStatus, step, group}[]}` — the productions of the caller's teams (an admin:
  all), not archived
- `GET claude` -> `{running, waiting, max, source: 'settings' | 'env', assistantName}`: Claude slots held (stages and
  chat replies), replies in line, the cap; `assistantName` is what the web calls the AI (`"Claude"` until set)
- `PUT settings` (Studio admin) `{claudeMaxConcurrent?: 1..100, assistantName?: string}` (at least one, else 400) -> the
  same as `GET claude`; the worker applies the cap on its next claim. `assistantName` is display only (1–40 characters
  on one line, 422 `invalid_setting` otherwise; blank goes back to `"Claude"`): the model, CLI and prompts stay as they
  are. Both are saved in one transaction
- `GET queue` -> the Queue screen, filtered like `overview` (others' items are only counted in `hidden*`):
  ```ts
  interface Where { productionId; productionTitle; episodeId: string | null; episodeIdx: number | null; episodeTitle: string | null }
  {
    claude: { running; waiting; max; hidden: number;
      items: (Where & { source: 'chat' | 'stage'; waiting: boolean; step: string; since: string | null })[] };
    renders: (Where & { farmJobId; kind: 'final' | 'preview' | 'export_premiere' | 'other'; machine: RenderMachine | null;
      status: 'queued' | 'leased' | 'paused'; progress: number | null; progressStage: string | null; attempt: number;
      createdAt: string; stuck: boolean })[];   // stuck: queued > 10 min — no node took it, maybe none fits
    hiddenRenders: number;
    farm: { ok: true } | { ok: false; error: string };   // the farm out of reach is not an error
  }
  ```
  Jobs come from ag-farm's owner API (`listJobs`, cached 3 s); it names no machines, so there is no machine list.
- Music library (plan 2026-10-08 task 29): background tracks tagged by mood that a shot-cut episode with no music of
  its own gets when its cut is fitted (cut 1.1.0: the first of the edit plan's, the branding's, the style's moods some
  track has, compared without case or marks; tracks long enough or that loop first). Rows of `music_track`, files AAC
  under `library/music/` (not swept: a retired track still renders where a timeline uses it).
  - `GET music` -> `{tracks: {trackId, displayName, moods: string[], durationSeconds, loopOk, origin: 'own' | 'licensed' |
    'royalty_free', originNote, active, track: 'library:music/<sha>.m4a', listenUrl}[]}` — active ones; a Studio admin
    sees the retired ones too
  - `POST music` (Studio admin, multipart) `file` + `displayName`, `moods` (comma-separated, 1–10), `origin`,
    `originNote`, `loopOk?` -> the track. The same file again is the same track (id from its content), its fields
    updated. 400 `invalid` / `audio_missing`, 413 `audio_too_large`, 422 for a file that is not audio, 503
    `audio_disabled` without ffmpeg
  - `PATCH music/:trackId` (Studio admin) `{displayName?, moods?, active?}` -> the track; 404 `not_found`
