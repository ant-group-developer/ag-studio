# Studio API v4 (dự án và agent) — hợp đồng giữa apps/api, apps/web và server MCP của agent

Spec: `docs/superpowers/specs/2026-10-10-ag-studio-agent-workspace-design.md`. Mọi route dưới `/api`, JSON, bọc trong
envelope `{data, requestId, timestamp, success, error}` như v3. DTO của API là camelCase; tài liệu và kết quả của engine
(`TimelineV4`, `StudioCrawl`, kết quả job…) giữ snake_case. Vai: `viewer < editor < producer < owner`; admin Studio qua
mọi kiểm vai. Route có `:projectId`, `:videoId`, `:threadId` được `RolesGuard` tra về team của dự án.

Me, team, thành viên, skill team, thư viện nhạc, hàng đợi farm, cài đặt: như v3 (`docs/studio-api-v3.md`, các mục đó).

## Dự án và video

- `GET /teams/:teamId/projects?archived` (viewer) → `{projects: (Project & {videoCount, lastActivityAt})[]}`
- `POST /teams/:teamId/projects` (producer) `{name, channelUrl?, description?, language?, aspect?, settings?}` → Project;
  tạo thư mục dự án (`CLAUDE.md`, `memory/lessons.md`, `context/`, `research/`, `channel/`, `videos/`…) và luồng "Kênh"
- `GET /projects/:projectId` (viewer) → `Project & {videos: Video[]}`; `PATCH` (producer); `DELETE` (owner, lưu trữ)
- `GET /projects/:projectId/videos` (viewer); `POST /projects/:projectId/videos` (editor)
  `{title?, prompt?, learning?: {useLessons, threads: [{threadId, mode: summary|full}]}}` → `Video & {threadId}`
  (luồng chat mới của video; `prompt` là tin đầu tiên gửi agent)
- `GET /videos/:videoId` (viewer) → `Video & {threadId}`; `PATCH {title?, status?}` (editor); `DELETE` (producer, lưu trữ)

## Tệp của dự án (`projects/:projectId/files`)

- `GET ?under` (viewer) → `{entries: WorkspaceEntry[]}` (đường dẫn, loại, cỡ, quyền `write|read`)
- `GET content?path` → `WorkspaceFile & {issues: FileIssue[]}`; `GET raw?path` → byte (ảnh, PDF)
- `PUT content {path, content, baseSha256?}` (editor) → `SavedFile & {issues}`; `baseSha256` khác bản trên đĩa → 409
  `file_conflict`; đường chỉ đọc (`inputs/**`, `videos/*/sources/**`, `.studio/**` trừ `playbook.yaml`) → 422 `read_only`
- `DELETE ?path&baseSha256` (editor); `POST upload` multipart `file` + `dir?` (editor, ≤ 50 MB)
- `GET versions?path`, `GET versions/:versionId`, `POST versions/:versionId/restore {baseSha256?}` (editor)

## Luồng chat với agent

- `GET /projects/:projectId/threads` (viewer); `POST {title?, learning?}` (editor) → Thread
- `GET /threads/:threadId` → `ThreadDetail` (tin nhắn, `refs`, `useLessons`); `GET /threads/:threadId/messages?afterSeq`
- `POST /threads/:threadId/messages {text, attachments?: path[]}` (editor) → `{message, turn}`; lượt agent chạy trong worker
- `POST /threads/:threadId/messages/:messageId/cancel` (editor) → Dừng lượt (kill cả cây tiến trình, giữ phần đã viết)
- `PATCH /threads/:threadId {title}`, `PUT /threads/:threadId/learning {useLessons, threads}`, `DELETE` (editor)
- SSE (đọc bằng fetch, có bearer): `GET /threads/:threadId/events` (`messages`), `GET /projects/:projectId/events` (`changed`)
- `GET /projects/:projectId/activity` → `{activity: Activity[]}`: lượt agent, tool đang gọi, job nền
  (`{kind, status, title, detail, startedAt, progress, etaSeconds, node, cancellable, threadId, jobKind}`)

## Quy trình gợi ý, bài học

- `GET /projects/:projectId/playbook?videoId` → `PlaybookStatus` (bước dự án/video: `missing|draft|invalid|done|skipped|stale|running`,
  file, lỗi, gợi ý tiếp theo); `POST playbook/steps/:stepKey/mark {status: done|skipped|draft, videoId?}` (editor);
  `POST playbook/customize` (producer) → tạo `.studio/playbook.yaml`
- `GET /projects/:projectId/lessons?status&threadId`; `POST lessons/:id/accept {text?}`, `POST lessons/:id/dismiss` (editor)

## Đầu vào và việc nền

- `GET /projects/:projectId/sources?videoId` → `{sources: SourceItem[]}` (project ag-go, video ag-go kèm trạng thái chuẩn bị,
  file tải lên); `POST sources` (editor) `{kind: ag_go_project, ref, label}` | `{kind: ag_go_asset, ref, label, videoId?,
  meta?, prepare?}` — chủ dự án không dùng được trên ag-go → 422 `owner_cannot_access`; `DELETE sources/:sourceId`
- `POST sources/upload` multipart `file` + `videoId?` (editor): tài liệu → `context/uploads/`, ảnh → `context/images/`,
  audio → `context/audio/`; Word → 415 `docx_not_supported`, video → 415 `video_from_ag_go`
- `GET footage?agGoProjectId&q&cursor&limit` → video trong các project ag-go của dự án, theo quyền ag-go của người hỏi
- `POST prepare {assetIds, again?}` (editor) → job `prepare_asset` cho mỗi video chưa chuẩn bị
- `GET jobs?active&videoId` → `{jobs: JobView[]}`; `POST jobs/:jobId/cancel` (editor) → Dừng
  (`JobView`: `kind, status, title, phase, progress, etaSeconds, nodeId, cancelRequested, startedAt, finishedAt, result, error`)

## Nghiên cứu YouTube (`projects/:projectId/research`)

- `POST estimate` (viewer) `CrawlRequest` → `{request, title, units, large, source: youtube_api|yt-dlp}`
- `POST {crawl: CrawlRequest, threadId?}` (editor) → JobView (`research`); kết quả `research/<ngày>-<slug>.{md,json}`
- `GET` → `{files: ResearchFile[]}` (`research/*.md`, kèm số liệu crawl nếu là của Studio)
- `CrawlRequest` (`packages/contracts/src/studio-crawl.ts`): `trending {region, category?, max}` | `topic {q, region, days, order,
  max}` | `top_channels {q, region, max}` | `channel_top {channel, max}`

## Video: timeline, render, giọng và nhạc

- `GET /videos/:videoId/timeline` → `{latest: TimelineSummary | null, revisions}`; `POST timeline/fit` (editor) → job `fit`
  (dựng từ `videos/<id>/edit-plan.json`)
- `GET /videos/:videoId/renders` → `{renders: RenderView[], jobs, thumbnails: path[]}`; `url` chỉ có khi quyền ag-go của
  người xem phủ mọi video trong bản đó (không thì `urlHidden: footage_scope`)
- `POST /videos/:videoId/renders {kind: render_preview|render_final|export_premiere, nodeId?, media?}` — xem trước: editor;
  bản cuối, Premiere: producer (403 `role`)
- `GET /projects/:projectId/audio` → `{voice, music, summary}`; `POST audio/:kind/from-file {path, origin?, referenceText?}`
  (giọng: producer, phải có `origin` synthetic|own|licensed; nhạc: editor); `POST audio/voice/decline`, `DELETE audio/:kind` (producer)

## Thẻ xác nhận

- `GET /threads/:threadId/actions` → `{actions: ActionView[]}` (`kind: render_final|export_premiere|delete_video|crawl_large|
  reference_download`, `needs` = vai cần có, `revision`, `expiresAt`)
- `POST /projects/:projectId/actions/:actionId/confirm|reject` — vai thiếu → 422 `role`; đã quyết → 409 `decided`;
  timeline đổi hoặc quá 24 giờ → 422 `expired`

## Tool của agent (`/agent-tools`, không qua Auth0)

Server MCP của mỗi lượt (`packages/studio-mcp/server.mjs`) gọi `GET /agent-tools/tools` và `POST /agent-tools/call {name,
arguments}` với `Authorization: Bearer <token lượt>` (HMAC `STUDIO_AGENT_TOKEN_SECRET`, hết hạn theo lượt, chỉ dùng được khi
tin nhắn còn `running`). Luôn 200 `{text, isError?}`. Tool (`packages/studio-engine/src/agent/*-tools.ts`):
`project_info, video_list, video_create, video_update, suggest_replies, playbook_status, validate_file, thread_history,
inputs_list, footage_search, inputs_add, inputs_prepare, input_describe, job_status, job_cancel, youtube_trending,
youtube_search, youtube_top_channels, youtube_channel_top_videos, timeline_from_edit_plan, timeline_get, timeline_apply_ops,
render_preview, thumbnail_make, music_list, propose_action`.

## Farm

`POST /farm/sign` (vé của farm) tra job ở `studio_farm_jobs` rồi `project_farm_jobs`; với dự án: chủ dự án là người hỏi
ag-go, bản xem trước xin `prefer: {short_edge: 480, clean: true}`.
