# Studio API v4 (dự án và agent) — hợp đồng giữa apps/api, apps/web và server MCP của agent

Spec: `docs/superpowers/specs/2026-10-10-ag-studio-agent-workspace-design.md`. Mọi route dưới `/api`, JSON, bọc trong
envelope `{data, requestId, timestamp, success, error}`. DTO của API là camelCase; tài liệu và kết quả của engine
(`TimelineV4`, `StudioCrawl`, kết quả job…) giữ snake_case. Vai: `viewer < editor < producer < owner`; admin Studio qua
mọi kiểm vai. Route có `:projectId`, `:videoId`, `:threadId` được `RolesGuard` tra về team của dự án.

## Me, team, thành viên

Danh sách phân trang: query `page` (từ 1), `pageSize` (mặc định 20, tối đa 100), `sortBy`, `sortOrder` (`asc|desc`), `q`
tuỳ chọn; trả `Paged<T> = {items: T[], total, page, pageSize}`.

- `GET /me` → `{userId, name, email, avatar, isAdmin}`
- `GET /teams?page&pageSize&sortBy(name|createdAt)&sortOrder&q` → `Paged<Team & {role: TeamRole | null, memberCount, projectCount}>`
  (admin thấy mọi team; `role` là vai của người gọi, null với admin không phải thành viên)
- `POST /teams {name}` → Team; `PATCH /teams/:teamId {name}` (owner) → Team; `DELETE /teams/:teamId` (owner; 409
  `team_has_active_runs` khi một job hay một lượt agent của dự án nào trong team còn chạy)
- `GET /teams/:teamId` (viewer) → `{id, name, role: TeamRole | null, memberCount, projectCount, createdAt, updatedAt}`
- `GET /teams/:teamId/members?page&pageSize&sortBy(role|joinedAt|name)&sortOrder&q` → `Paged<TeamMember>`;
  `GET /teams/:teamId/member-candidates?keyword`, `POST /teams/:teamId/members {userId, role}`,
  `PATCH /teams/:teamId/members/:userId {role}`, `DELETE /teams/:teamId/members/:userId`; bỏ hay hạ vai owner cuối cùng →
  409 `last_owner`

## Skill của team ("quy chuẩn & skill")

Markdown team viết về cách làm video. Agent của dự án có các skill đang bật của team (`settings.team_skills` chọn một phần; không đặt = mọi skill đang bật)
(`studio:team-<tên>`, xem `agent-skills/README.md`).

```ts
interface TeamSkill {
  id: string; teamId: string; name: string; purpose: string;
  appliesTo: TeamSkillStep[];      // ghi chú bước (thời pipeline cũ); agent không lọc theo trường này
  content: string;                 // markdown
  enabled: boolean; position: number;
  createdBy: string; updatedBy: string; createdAt: string; updatedAt: string;
}
```
- `GET /teams/:teamId/skills` (viewer) → `TeamSkill[]` theo `position`, rồi thứ tự tạo
- `POST /teams/:teamId/skills` (producer) `{name, purpose?, appliesTo?, content, enabled?, position?}` → 201 TeamSkill
- `PATCH /teams/:teamId/skills/:skillId` (producer) `Partial<…>` → TeamSkill; `DELETE …` (producer) → 204
- Giới hạn: tên 1..100, purpose ≤ 500, content 1..20 000 ký tự; các skill đang bật của một team cộng lại ≤ 60 000
  (422 `team_skills_too_long`); trùng tên trong team → 409 `team_skill_name_taken`; skill của team khác → 404.

## Studio (`/studio`)

- `GET claude` → `{running, waiting, max, source: 'settings' | 'env', assistantName}`: slot Claude đang giữ (lượt agent,
  tóm tắt luồng), lượt đang chờ, cap; `assistantName` là tên web gọi AI (`"Claude"` tới khi admin đặt)
- `PUT settings` (admin Studio) `{claudeMaxConcurrent?: 1..100, assistantName?: string}` (ít nhất một, không thì 400) → như
  `GET claude`. `assistantName` chỉ để hiển thị (1–40 ký tự một dòng, sai → 422 `invalid_setting`; để trống → `"Claude"`).
  Hai giá trị lưu trong một transaction
- `GET queue` → màn Hàng đợi: việc đang chạy ở các dự án người gọi thấy (team của họ; admin: mọi dự án), việc của dự án
  khác chỉ được đếm:
  ```ts
  {
    claude: ClaudeUsage;                                    // như GET claude
    items: (Activity & { projectId; projectName; teamId })[]; // Activity như GET /projects/:id/activity
    hidden: number;
    machines: OwnerNodeView[] | null;                       // máy của farm (owner API, cache 3 s); null khi không đọc được
    farm: { ok: true } | { ok: false; error: string };      // farm không với tới không phải lỗi
  }
  ```
- `GET farm/nodes` → `{nodes}`: máy nhận `studio.render_final` (ghim bản cuối qua `node_id` của thẻ `render_final`);
  farm không với tới → `{nodes: []}`
- Kho nhạc: bài nhạc nền gắn mood; video không có nhạc riêng được chọn một bài theo mood của branding (bài đủ dài hay
  lặp được trước). Dòng `music_track`, file AAC ở `library/music/` (không bị quét: bài đã ngừng vẫn render được ở timeline
  đang dùng nó).
  - `GET music` → `{tracks: {trackId, displayName, moods: string[], durationSeconds, loopOk, origin: 'own' | 'licensed' |
    'royalty_free', originNote, active, track: 'library:music/<sha>.m4a', listenUrl}[]}` — bài đang dùng; admin Studio thấy
    cả bài đã ngừng
  - `POST music` (admin Studio, multipart) `file` + `displayName`, `moods` (phân cách bằng dấu phẩy, 1–10), `origin`,
    `originNote`, `loopOk?` → bài nhạc. Cùng file lần nữa là cùng bài (id theo nội dung), các trường được cập nhật. 400
    `invalid` / `audio_missing`, 413 `audio_too_large`, 422 với file không phải audio, 503 `audio_disabled` khi thiếu ffmpeg
  - `PATCH music/:trackId` (admin Studio) `{displayName?, moods?, active?}` → bài nhạc; 404 `not_found`

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
- `GET footage?agGoProjectIds&q&categoryIds&ownerUserIds&provinceIds&resolutions&tags&genres&timesOfDay&orientations&minDurationMs&maxDurationMs&usability&sortBy&sortOrder&page|cursor&limit`
  → video trong các project ag-go của dự án (chỉ những project đã gắn; `agGoProjectId` cũ vẫn nhận), theo quyền ag-go của
  người hỏi; danh sách là chuỗi cách bằng dấu phẩy, enum như ag-go `/footage/search`; khoá lạ → 400 `invalid`, project
  chưa gắn → `not_an_input`. Mỗi item thêm `prepared`.
- `GET footage/facets?<cùng bộ lọc>` → `{tags, genres, timesOfDay, orientations, resolutions, categories, provinces, authors,
  projects}` (mỗi mục `[{value, label?, count}]`); `projects` là các project đã gắn, `count` của ag-go hoặc `null`
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
