# Studio API v4 (dự án và agent) — hợp đồng giữa apps/api, apps/web và server MCP của agent

Spec: `docs/superpowers/specs/2026-10-10-ag-studio-agent-workspace-design.md`. Mọi route dưới `/api`, JSON, bọc trong
envelope `{data, requestId, timestamp, success, error}`. DTO của API là camelCase; tài liệu và kết quả của engine
(`TimelineV4`, `StudioCrawl`, kết quả job…) giữ snake_case. Vai: `viewer < editor < producer < owner`; admin Studio qua
mọi kiểm vai. Route có `:projectId`, `:videoId`, `:threadId` được `RolesGuard` tra về team của dự án.

## Me, team, thành viên

Danh sách phân trang: query `page` (từ 1), `pageSize` (mặc định 20, tối đa 100), `sortBy`, `sortOrder` (`asc|desc`), `q`
tuỳ chọn; trả `Paged<T> = {items: T[], total, page, pageSize}`.

- `GET /me` → `{userId, name, email, avatar, isAdmin}`
- `GET /me/onboarding` → `{steps: {key, done, count}[], done, total: 7, links: {teamId, projectId, video: {projectId,
  videoId} | null}}` — checklist "Bắt đầu", đếm trong các nhóm người gọi là thành viên (`key`: `team`, `project`,
  `footage` = project/video ag-go đã thêm, `video`, `chat` = tin nhắn của chính người gọi, `preview`, `final` = job
  render xong); `links` là nhóm/dự án làm gần nhất và video sửa gần nhất (cho nút "Đi tới").
- `GET /me/prefs` → `{tourSeen: {projects, project}, checklistHidden}`; `PUT /me/prefs` (chỉ đổi trường gửi lên, không ghi
  nhật ký hoạt động) → prefs đầy đủ. Lưu ở `user_prefs` (0041).
- `GET /teams?page&pageSize&sortBy(name|createdAt)&sortOrder&q` → `Paged<Team & {role: TeamRole | null, isMember, memberCount, projectCount}>`
  (admin Studio thấy mọi nhóm — controller tự hỏi `StudioAdminService.isAdmin` vì route không có `@Roles`; `role` là vai
  của người gọi, null và `isMember: false` với admin không phải thành viên; `q` tìm theo tên)
- `POST /teams {name}` → Team; `PATCH /teams/:teamId {name}` (owner) → Team; `DELETE /teams/:teamId` (owner; 409
  `team_has_active_runs` khi một job hay một lượt agent của dự án nào trong team còn chạy)
- `GET /teams/:teamId` (viewer) → `{id, name, role: TeamRole | null, isMember, memberCount, projectCount, createdAt, updatedAt}`
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
    youtube: { blockedAt; until; where: 'studio' } | null;  // YouTube đang chặn tải từ máy chủ Studio (web: chỉ admin thấy)
  }
  ```
- `GET stats/claude?from&to&groupBy=team|project|video|user&teamId&projectId&tz` (admin Studio: mọi nhóm; owner: nhóm
  mình; người khác 403) → thống kê chat Claude (mặc định 30 ngày gần nhất, `tz` = phút lệch UTC cho chuỗi theo ngày):
  ```ts
  {
    from; to; groupBy;
    totals: Metrics;
    rows: (Metrics & { key: string | null; label: string | null; teamId; projectId; user?: UserSummary | null })[]; // tốn nhất trước
    daily: { day: 'YYYY-MM-DD'; turns; costUsd; inputTokens; outputTokens }[];
  }
  // Metrics: turns (lượt agent, lượt chạy lại sau hạn mức tính riêng), threads, userMessages, inputTokens (tổng),
  //          cacheReadTokens, cacheCreationTokens, outputTokens, costUsd, wallSeconds, failed, rateLimited
  ```
  Nguồn: `llm_calls` (`source = 'claude-agent'`, cột `user_id`, `team_id`, cache từ migration 0037) và tin nhắn người gửi
  (`agent_messages`). `groupBy=video` có một dòng `key: null` cho các luồng của dự án. Tóm tắt luồng không tính.
- `GET stats/claude/turns?from&to&teamId&projectId&videoId&userId&threadId&outcome=accepted|failed|rate_limited&sortBy=at|cost|wall|tokens&sortOrder&page&pageSize`
  (cùng phạm vi và khoảng mặc định như trên; `videoId=` rỗng = luồng của dự án; `pageSize` ≤ 200, mặc định 50) → từng lượt:
  ```ts
  { from; to; total; page; pageSize; items: Turn[] } // mới nhất trước
  // Turn: id (llm_calls.id), at, teamId, projectId, projectName, videoId, videoTitle, threadId, threadTitle, messageId, userId,
  //       user: UserSummary | null, model, outcome, status (của tin), trigger, inputTokens, outputTokens, cacheReadTokens,
  //       cacheCreationTokens, costUsd, wallSeconds, numTurns, toolCount, prompt (160 ký tự đầu của tin đã kích lượt)
  ```
- `GET stats/claude/turns/:turnId` → một lượt đầy đủ: `Turn` + `promptText`, `promptBy`, `promptUser`, `text` (câu trả lời),
  `error`, `attempts`, `startedAt`, `finishedAt`, `tools: { id; name; input; result; isError; startedAt; endedAt }[]` (chuỗi
  dài cắt ở 4000 ký tự), `changed` (file đã đổi, từ nhật ký khi còn giữ). Lượt ngoài phạm vi người xem → 404.
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
    `invalid` / `audio_missing`, 413 `audio_too_large`, 422 với file không phải audio, 503 `audio_disabled` khi thiếu ffmpeg.
    Thay cho `file`: `uploadKey` + `name` sau khi trình duyệt PUT file lên R2 (`POST music/uploads`)
  - `POST music/uploads` (admin Studio) `{name, size, contentType?}` → `{key, url, contentType, expiresAt}`: link PUT lên R2
    (`uploads/library/<uuid>`, 1 giờ); > 100 MB → 413 `audio_too_large`
  - `PATCH music/:trackId` (admin Studio) `{displayName?, moods?, active?}` → bài nhạc; 404 `not_found`

## Nhật ký hoạt động (`/audit`)

Bảng `audit_log` (migration 0036): mọi request POST/PUT/PATCH/DELETE của người đã đăng nhập (`AuditInterceptor`; route
`@NoAudit()` như ước lượng crawl không ghi; request bị guard chặn không vào), mọi tool Studio agent gọi (`/agent-tools/call`),
mỗi lượt chat và mỗi tool có sẵn của Claude (worker), mỗi việc nền xong. Không ghi nội dung chat, nội dung file, giá trị bí
mật: `details` chỉ có id, field ngắn trong allowlist, kích thước. Admin Studio xem hết (cả dòng không thuộc nhóm nào), owner
xem nhóm mình; người khác 403.
- `GET audit/scope` → `{all: boolean, teams: {id, name}[]}`: các nhóm người gọi xem được
- `GET audit?teamId&projectId&videoId&threadId&actorId&actorKind&kind&outcome&from&to&page&pageSize` → `{items, total, page,
  pageSize}`, mới trước; item: `{id, at, actorKind: 'user'|'agent'|'studio', actorId, actor: UserSummary | null, kind:
  'http'|'tool'|'turn'|'job', action, outcome: 'ok'|'error', method, route, statusCode, durationMs, team, project, video,
  threadId, messageId, jobId, target, summary, details, costUsd}`; `teamId` không phải của mình → 403
- `GET audit/actors?teamId` → `{actors: UserSummary[]}`: những người có trong nhật ký

## Dự án và video

- `GET /teams/:teamId/projects?archived` (viewer) → `{projects: (Project & {videoCount, lastActivityAt, creator: UserSummary})[]}` (người tạo: tên, email, avatar từ Account API; không tra được thì chỉ có `userId`)
- `POST /teams/:teamId/projects` (producer) `{name, channelUrl?, description?, language?, aspect?, settings?}` → Project;
  tạo thư mục dự án (`CLAUDE.md`, `memory/lessons.md`, `context/`, `research/`, `channel/`, `videos/`…) và luồng "Kênh"
- `GET /projects/:projectId` (viewer) → `Project & {videos: Video[]}`; `PATCH` (producer); `DELETE` (owner, lưu trữ)
- `GET /projects/:projectId/videos` (viewer); `POST /projects/:projectId/videos` (editor)
  `{title?, prompt?, learning?: {useLessons, threads: [{threadId, mode: summary|full}]}}` → `Video & {threadId}`
  (luồng chat mới của video; `prompt` là tin đầu tiên gửi agent)
- `GET /videos/:videoId` (viewer) → `Video & {threadId}`; `PATCH {title?, status?}` (editor); `DELETE` (producer, lưu trữ)

## Tệp của dự án (`projects/:projectId/files`)

- `GET ?under` (viewer) → `{entries: WorkspaceEntry[]}` (đường dẫn, loại, cỡ, quyền `write|read`)
- `GET content?path` → `WorkspaceFile & {issues: FileIssue[], streamUrl: string | null}`: file văn bản (đuôi văn bản, ≤ 2 MB) đọc
  cả file kèm `sha256` như cũ; file khác (video, ảnh, PDF, file văn bản quá lớn) chỉ `stat` — không đọc, không hash (`sha256:
  null`, `binary: true`) — và có `streamUrl` (link `GET stream` bên dưới) để web phát/xem/tải thẳng; `GET raw?path` → byte (ảnh,
  PDF), đọc dần từ đĩa
- `GET stream?path&t` (**không cần đăng nhập**, `@Public()`): phát một file cho `<audio>`/`<video>` (không gửi được bearer). `t` là
  link ký HMAC (`workspace/file-link.ts`: dự án, đường dẫn, người, hết hạn 15 phút; khoá dẫn từ `STUDIO_AGENT_TOKEN_SECRET`, không
  đặt thì khoá riêng của tiến trình API). Sai/hết hạn → 401 `bad_file_link`, file khác → 403, thư mục ẩn/không có/dự án đã lưu
  trữ → 404. Phục vụ từ đĩa có Range (206). API trả sẵn link này ở `listenUrl` và `streamUrl` (đường dẫn dưới `/api`); thêm
  `&download=1` thì trả `Content-Disposition: attachment` (lưu file theo tên).
- `PUT content {path, content, baseSha256?}` (editor) → `SavedFile & {issues}`; `baseSha256` khác bản trên đĩa → 409
  `file_conflict`; đường chỉ đọc (`inputs/**`, `videos/*/sources/**`, `.studio/**` trừ `playbook.yaml`) → 422 `read_only`
- `DELETE ?path&baseSha256` (editor); `POST upload` multipart `file` + `dir?` (editor, ≤ 50 MB; audio ≤ 100 MB), hoặc JSON
  `{uploadKey, name, dir?}` sau khi trình duyệt PUT file lên R2 (`POST /projects/:id/uploads` với `purpose: "file"`)
- `GET versions?path`, `GET versions/:versionId`, `POST versions/:versionId/restore {baseSha256?}` (editor)
- `GET versions/:versionId/diff?base` (viewer) → bản đó đổi gì so với `base` (một bản khác của cùng file, vd. bản trước
  lượt agent; `none` = file rỗng, cho file lượt đó tạo; khác file → 422 `bad_base`) hoặc mặc định bản ngay trước (chưa có = file rỗng; bản xoá = rỗng):
  `{path, version_id, before_version_id, hunks: {old_start, old_lines, new_start, new_lines, lines: {kind:
  'context'|'add'|'del', text}[]}[], added, removed}`, 3 dòng ngữ cảnh; file nhị phân hay không giữ nội dung (> 1 MB) hoặc
  quá nhiều dòng để so (> 50 000) → `{path, version_id, before_version_id, unavailable: 'binary'|'too_large'}`. Diff dòng
  Myers trong engine (`workspace/line-diff.ts`), quá nhiều khác biệt thì phần giữa hiện là bớt rồi thêm (vẫn đúng).

## Luồng chat với agent

- `GET /projects/:projectId/threads` (viewer); `POST {title?, learning?}` (editor) → Thread
- `GET /threads/:threadId` → `ThreadDetail` (tin nhắn, `refs`, `useLessons`); `GET /threads/:threadId/messages?afterSeq`.
  Tin của agent có `changedFiles: {path, change: 'added'|'modified'|'deleted', version_id, before_version_id, added?,
  removed?}[] | null` (từ 0038): file lượt đó đổi, mỗi đường dẫn một dòng, bản cuối của lượt so với bản ngay trước lượt;
  `added`/`removed` là số dòng (chỉ khi cả hai bản là chữ ≤ 1 MB); `null` = lượt cũ hoặc chưa xong.
- `POST /threads/:threadId/messages {text, attachments?: path[]}` (editor) → `{message, turn}`; lượt agent chạy trong worker
- `POST /threads/:threadId/messages/:messageId/cancel` (editor) → Dừng lượt (kill cả cây tiến trình, giữ phần đã viết)
- `PATCH /threads/:threadId {title}`, `PUT /threads/:threadId/learning {useLessons, threads}`, `DELETE` (editor)
- SSE (đọc bằng fetch, có bearer): `GET /threads/:threadId/events` (`messages`), `GET /projects/:projectId/events` (`changed`)
- `GET /projects/:projectId/activity` → `{activity: Activity[]}`: lượt agent, tool đang gọi, job nền
  (`{kind, status, title, detail, startedAt, progress, etaSeconds, node, cancellable, threadId, jobKind}`)

## Quy trình gợi ý, bài học

- `GET /projects/:projectId/playbook?videoId` → `PlaybookStatus` (bước dự án/video: `missing|draft|invalid|done|skipped|stale|running`,
  file, lỗi, gợi ý tiếp theo). `scope` = `video` khi có `videoId`, không thì `project`; `next` (≤ 3) chỉ gồm bước của
  `scope` (luồng video không gợi ý bước kênh); `projectOpen` = số bước kênh còn mở; mỗi bước có `outsideRequires` — bước
  của phạm vi kia nó dựa vào mà chưa xong (Gói YouTube cần Branding kênh): chỉ là ghi chú, không chặn gợi ý; `POST playbook/steps/:stepKey/mark {status: done|skipped|draft, videoId?}` (editor);
  `POST playbook/customize` (producer) → tạo `.studio/playbook.yaml`
- `GET /projects/:projectId/lessons?status&threadId`; `POST lessons/:id/accept {text?}`, `POST lessons/:id/dismiss` (editor)

## Đầu vào và việc nền

- `GET /projects/:projectId/sources?videoId` → `{sources: SourceItem[], counts}` (project ag-go, video ag-go kèm trạng thái chuẩn bị,
  file tải lên; trạng thái tính trong một lượt đọc DB dù bao nhiêu video/job; `counts = {videos, ready, preparing, failed,
  notPrepared}` đếm mỗi video ag-go một lần, `preparing` gồm cả đang chờ); `POST sources` (editor) `{kind: ag_go_project, ref, label}` | `{kind: ag_go_asset, ref, label, videoId?,
  meta?, prepare?}` — chủ dự án không dùng được trên ag-go → 422 `owner_cannot_access`; `DELETE sources/:sourceId`
- `POST uploads {purpose: source|reference|file, name, size, contentType?}` (editor) → `{key, url, contentType, expiresAt}`:
  kiểm tên, loại, dung lượng như lúc tải (cùng mã lỗi 413/415) rồi ký link PUT lên R2 (`uploads/<projectId>/<uuid>`, 1 giờ).
  Trình duyệt PUT file kèm đúng `Content-Type` đó, rồi gọi `sources/upload` hoặc `files/upload` với `{uploadKey: key, name}`:
  API kiểm key thuộc dự án (400 `upload_key`), lấy cỡ thật trên R2 (quá thì 413 và xoá), kéo file về, xử lý như file
  multipart rồi xoá bản trên R2 (không thấy → 404 `upload_missing`). Bucket cần CORS cho origin của web.
- `POST sources/upload` multipart `file` (hoặc JSON `uploadKey` + `name`) + `videoId?` + `reference?` (editor): tài liệu → `context/uploads/`, ảnh →
  `context/images/`, audio → `context/audio/` (audio ≤ 100 MB, file khác ≤ 50 MB); Word → 415 `docx_not_supported`, video → 415 `video_from_ag_go`.
  `reference=1`: video mẫu để học phong cách dựng (mp4, mov, m4v, mkv, webm, avi; ≤ 300 MB) → `context/references/`,
  nguồn `mediaType: video`, `meta.reference: true` (không phải footage); file khác → 415 `not_video`. Agent học bằng tool
  `style_from_files {paths, purpose}` (job `style_watch` với `files`, không cần thẻ, không đổi hay xoá file)
- `GET footage?agGoProjectIds&q&categoryIds&ownerUserIds&provinceIds&resolutions&tags&genres&timesOfDay&orientations&minDurationMs&maxDurationMs&usability&sortBy&sortOrder&page|cursor&limit`
  → video trong các project ag-go của dự án (chỉ những project đã gắn; `agGoProjectId` cũ vẫn nhận), theo quyền ag-go của
  người hỏi; danh sách là chuỗi cách bằng dấu phẩy, enum như ag-go `/footage/search`; khoá lạ → 400 `invalid`, project
  chưa gắn → `not_an_input`. Mỗi item thêm `prepared`.
- `GET footage/facets?<cùng bộ lọc>` → `{tags, genres, timesOfDay, orientations, resolutions, categories, provinces, authors,
  projects}` (mỗi mục `[{value, label?, count}]`); `projects` là các project đã gắn, `count` của ag-go hoặc `null`
- `POST prepare {assetIds, again?}` (editor) → job `prepare_asset` cho mỗi video chưa chuẩn bị
- `GET jobs?active&videoId` → `{jobs: JobView[]}`; `POST jobs/:jobId/cancel` (editor) → Dừng
  (`JobView`: `kind, status, title, phase, progress, etaSeconds, nodeId, cancelRequested, startedAt, finishedAt, result, error`;
  job lỗi có mã thì `result = {error_code}`, ví dụ `youtube_blocked` khi YouTube chặn tải từ máy chủ Studio)

## Nghiên cứu YouTube (`projects/:projectId/research`)

- `POST estimate` (viewer) `CrawlRequest` → `{request, title, units, large, source: youtube_api|yt-dlp}`
- `POST {crawl: CrawlRequest, threadId?}` (editor) → JobView (`research`); kết quả `research/<ngày>-<slug>.{md,json}`
- `GET` → `{files: ResearchFile[]}` (`research/*.md`, kèm số liệu crawl nếu là của Studio)
- `CrawlRequest` (`packages/contracts/src/studio-crawl.ts`): `trending {region, category?, max}` | `topic {q, region, days, order,
  max}` | `top_channels {q, region, max}` | `channel_top {channel, max}`

## Video: timeline, render, giọng và nhạc

- `GET /videos/:videoId/timeline` → `{latest: TimelineSummary | null, revisions}`; `POST timeline/fit` (editor) → job `fit`
  (dựng từ `videos/<id>/edit-plan.json`)
- `GET /videos/:videoId/renders` → `{renders: RenderView[], jobs, thumbnails: path[]}` — đọc DB, không hỏi ag-go, nên tab Xem
  trước hiện ngay; bản xem trước và bản cuối (mp4) có sẵn `url` (ký tại chỗ, sống `STUDIO_BROWSER_URL_TTL_SECONDS`) để player chạy
  không cần request thứ hai; dòng Premiere không có `url` (xin bằng route dưới lúc lưu)
- `GET /videos/:videoId/renders/:jobId/link` (viewer) → `{jobId, url: string | null, urlHidden?}` cho đúng một bản render;
  bản mp4 luôn có `url` (không kiểm quyền footage: bản cuối dựng từ bản gốc của chủ dự án, người trong dự án xem được);
  file Premiere (.zip đóng gói chính các file footage) chỉ có `url` khi quyền ag-go của người xem phủ mọi video trong
  revision của bản đó (không thì `urlHidden: footage_scope`;
  ag-go không trả lời được — lỗi mạng, 5xx… — thì `urlHidden: footage_check_failed`, API ghi log lý do); link Premiere đặt
  sẵn tên file `.zip`; `jobId` không phải bản render xong của video → 404. API nhớ quyền theo (người, video ag-go) 10 phút
  và chỉ hỏi ag-go những video chưa biết (từng lô 10, 4 lô song song), nên revision mới cùng footage trả lời ngay; ag-go
  không trả lời được nhớ 30 s (poll không dồn); 404 của ag-go nêu tên video thì video đó ngoài phạm vi, không nêu thì mọi
  timeline dùng đủ tập video đã hỏi bị ẩn; một lần kiểm > 2 s ghi log
- `POST /videos/:videoId/renders {kind: render_preview|render_final|export_premiere, nodeId?, media?}` — xem trước: editor;
  bản cuối, Premiere: producer (403 `role`)
- `GET /projects/:projectId/audio` (viewer) → `{voice, music, summary, libraryTrack, enabled, files}`: `enabled` = API có
  ffmpeg (`STUDIO_FFMPEG_PATH`; ffprobe là `STUDIO_FFPROBE_PATH` hoặc ffprobe cạnh ffmpeg như worker) để nhận file audio;
  `files` = file audio dùng được `[{path, name, bytes, sourceId, addedAt, listenUrl}]` (`listenUrl`: `GET files/stream`, 15 phút), mới nhất trước: audio đã tải ở tab Đầu vào
  (còn file) và mọi file audio dưới `context/audio/` (cả file tải qua tab Tệp, `sourceId: null`), không dò thời lượng;
  `libraryTrack` = `{trackId, displayName, moods, durationSeconds}` khi nhạc là một bài của kho nhạc
- `POST audio/:kind/from-file {path, origin?, referenceText?, gainDb?, ducking?}` (giọng: producer, phải có `origin`
  synthetic|own|licensed; nhạc: editor); thiếu ffmpeg → 503 `audio_disabled`
- `POST audio/music/from-library {trackId, gainDb?, ducking?}` (editor): nhạc của dự án là bài đó của kho nhạc
  (`track: library:music/…`, không chép file, không cần ffmpeg); bài không có → 404 `not_found`, bài đã gỡ → 422 `audio_invalid`
- `POST audio/voice/decline` (producer); `DELETE audio/voice` (producer), `DELETE audio/music` (editor, như chọn nhạc).
  Bỏ chọn nhạc = Studio tự chọn bài trong kho nhạc theo mood (kế hoạch dựng, rồi branding) khi dựng timeline
- `POST audio/music/from-files {paths, crossfadeS?, gainDb?, ducking?}` (editor): 1–20 file audio của workspace (mỗi file
  ≤ 100 MB, ≥ 5 giây) ghép theo thứ tự thành một bài nhạc nền (AAC); `crossfadeS` 0–10 (mặc định 0 = nối thẳng), phải ngắn
  hơn nửa bài ngắn nhất; tổng ≤ 3 giờ. `music` có thêm `parts [{filename, duration_s}]` và `crossfade_s`. Lỗi ffmpeg → 422
  `audio_invalid` nêu tên file; thiếu ffmpeg → 503 `audio_disabled`
- `GET /videos/:videoId/audio` (viewer) → `{music, uses: video|project|mood, summary, libraryTrack, enabled, files, revision}`:
  nhạc riêng của video (cột `videos.music`, migration 0039; null = dùng nhạc dự án, không có thì Studio chọn theo mood).
  `POST /videos/:videoId/audio/music/from-files` (như của dự án), `POST …/from-library {trackId, gainDb?, ducking?}`,
  `DELETE /videos/:videoId/audio/music` (quay về nhạc dự án), đều editor. Video đã có timeline thì bản mới nhất được ghi
  một revision mới (`label: music`) với nhạc đó, `revision` trả số bản; dựng timeline (`fit`) chọn nhạc video → dự án → mood

## Thẻ xác nhận

- `GET /threads/:threadId/actions` → `{actions: ActionView[], youtubeBlocked}` (`kind: render_final|export_premiere|delete_video|crawl_large|
  reference_download`, `needs` = vai cần có, `revision`, `expiresAt`; `youtubeBlocked` như `youtube` của `GET studio/queue`:
  thẻ `reference_download` đang chờ hiện cảnh báo). Khi YouTube đang chặn, tool `propose_action reference_download` của
  agent từ chối (`youtube_blocked`) thay vì tạo thẻ
- `POST /projects/:projectId/actions/:actionId/confirm|reject` — vai thiếu → 422 `role`; đã quyết → 409 `decided`;
  timeline đổi hoặc quá 24 giờ → 422 `expired`

## Tool của agent (`/agent-tools`, không qua Auth0)

Server MCP của mỗi lượt (`packages/studio-mcp/server.mjs`) gọi `GET /agent-tools/tools` và `POST /agent-tools/call {name,
arguments}` với `Authorization: Bearer <token lượt>` (HMAC `STUDIO_AGENT_TOKEN_SECRET`, hết hạn theo lượt, chỉ dùng được khi
tin nhắn còn `running`). Luôn 200 `{text, isError?}`. Tool (`packages/studio-engine/src/agent/*-tools.ts`):
`project_info, video_list, video_create, video_update, suggest_replies, playbook_status, validate_file, thread_history,
inputs_list, footage_search, inputs_add, inputs_prepare, input_describe, job_status, job_cancel, youtube_trending,
youtube_search, youtube_top_channels, youtube_channel_top_videos, style_from_files, timeline_from_edit_plan, timeline_get, timeline_apply_ops,
render_preview, thumbnail_make, music_list, propose_action`.

## Farm

`POST /farm/sign` (vé của farm) tra job ở `studio_farm_jobs` rồi `project_farm_jobs`; với dự án: chủ dự án là người hỏi
ag-go, bản xem trước xin `prefer: {short_edge: 480, clean: true}`.
