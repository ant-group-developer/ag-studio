# Plan: AG Studio làm việc như Claude Code trong một dự án (2026-10-10)

Nhánh: `feat/agent-workspace` (từ `dev-duc`). Spec: `docs/superpowers/specs/2026-10-10-ag-studio-agent-workspace-design.md`.
Mỗi task một commit (Conventional Commits), test viết trước. Số dành riêng: ADR-0001 mục `179`–`195`, migration
`0030`–`0036`. Không push, không đổi hợp đồng ag-farm; đổi ag-go chỉ ở nhánh riêng và hỏi trước khi push.

**Xong khi:** người dùng tạo dự án cho một kênh, chọn project ag-go, chat với agent qua research → channel → branding,
tạo video mới (luồng mới, tuỳ chọn học từ chat cũ), chuẩn bị đầu vào, chọn cảnh, kế hoạch dựng, timeline, xem trước
(nguồn 480p sạch khi ag-go đã sửa), bấm xác nhận render bản cuối; mọi việc nặng hiện ai xử lý, đã trôi, còn ≈, Dừng
được; giao diện và code pipeline cũ đã gỡ; `pnpm test`, `corepack pnpm -r run build`, `pnpm -r typecheck` sạch.

## P0 — Spike CLI, spec, ADR

- [x] Spike Claude Code 2.1.285 (spec mục 9), mẫu `fixtures/agent-stream/*.jsonl`.
- [x] Spec.
- [x] ADR-0001 mục 179–190.
- Probe thật (`packages/adapters/agent-cli/test/real-agent-cli.test.ts`, `HARNESS_REAL_CLAUDE_TEST=1`) viết ở P2 trên
  `AgentSessionRuntime` thật, mã hoá checklist spike.

## P1 — Dữ liệu, workspace, file, khung web mới

1. `feat(db): projects, sources, videos, video revisions, file versions` — `migrations/0030_projects.sql`.
2. `feat(engine): project and video store` — `packages/studio-engine/src/workspace/project-db.ts` (`saveVideoRevision`
   theo `saveEpisodeRevision`).
3. `feat(engine): workspace folders and safe file IO` — `workspace/{paths,files,templates}.ts`: chặn đường tuyệt đối,
   `..`, symlink, cỡ; đường bảo vệ; seed mẫu; phiên bản; `scanWorkspace()`.
4. `feat(api): roles guard reads project/video/thread`.
5. `feat(contracts): workspace DTOs` + `pnpm gen:schemas`.
6. `feat(api): projects, videos, files endpoints` — `apps/api/src/workspace/*`.
7. `feat(web): new shell, projects grid, project page, files tab`.

## P2 — Chat agent

1. `feat(agent-cli): stream-json parser` (test trên `fixtures/agent-stream`).
2. `feat(agent-cli): kill a process tree`.
3. `feat(agent-cli): AgentSessionRuntime` + probe thật.
4. `feat(db): agent threads, thread refs, messages` — `0031`.
5. `feat(engine): agent turn tokens`.
6. `feat(mcp): stdio Studio MCP server` — `packages/studio-mcp`.
7. `feat(api): agent-tools endpoints and guard`.
8. `feat(engine): agent runner` (slot, plugin dir, settings, system prompt, `<studio_context>`, history export, recap,
   rate limit, cancel, `llm_calls`).
9. `feat(api): thread endpoints, SSE deltas, activity`.
10. `feat(web): agent chat, activity drawer, thread list, new video/chat modal`.
11. `test: fake agent CLI` — `fixtures/fake-studio-agent.mjs`.

## P3 — Playbook, kiểm file, skills, bài học

1. `feat(contracts): playbook and frontmatter schemas`.
2. `feat(engine): default playbook and status` + `0032_step_marks.sql`.
3. `feat(engine): file validators`.
4. `feat(engine): project skill plugin` — `agent-skills/<slug>/SKILL.md` + team + project → plugin dir.
5. `feat(agent): playbook in context, post-turn validation, auto-fix`.
6. `feat(engine): thread summaries and lessons`.
7. `feat(api): playbook endpoints`; `feat(web): step rail, next-step chips, file issues, history`.

## P4 — Đầu vào (xong 2026-10-10)

- [x] `0033`: `project_jobs` (phase, progress, eta, máy, units, dừng, báo luồng), `project_farm_jobs` (stage_key,
  attempt_id cho tiền tố farm), `prepared_assets`.
- [x] `ag-go-client` (cả bản CJS của API): `searchFootage` (`GET /footage/search`), `resolveAssets.prefer`.
- [x] Engine: `jobs-db`, `eta` (tiến độ → lịch sử theo đơn vị → mặc định; đang chờ máy farm thì không đoán),
  `job-runner` (2 làn, nhịp 2 s, Dừng, worker tắt thì trả việc về hàng, báo luồng + tự chạy tiếp ≤3), `farm`
  (gửi/theo dõi/huỷ, correlation id theo job, hết hạn chờ máy), `prepare` (ag-go → tải → dò cảnh → khung, tờ ghép →
  lời thoại qua farm, lỗi lời thoại không làm hỏng bước), `video-index`, `sources-db`, `inputs`, `step-facts`
  (bước `prepare` của playbook theo DB).
- [x] `/farm/sign` tìm cả `project_farm_jobs`, chủ dự án từ `projects`, bản xem trước gửi `prefer` 480p sạch.
- [x] Tool agent: `inputs_list`, `footage_search`, `inputs_add`, `inputs_prepare(wait_s≤60)`, `input_describe`,
  `job_status`, `job_cancel`; hoạt động dự án gồm job.
- [x] API `InputsController`: nguồn (kiểm chủ dự án dùng được, 422 `owner_cannot_access`), tải lên vào `context/`
  theo loại (Word, video bị từ chối), tìm footage theo quyền người xem, chuẩn bị, job + Dừng.
- [x] Web: tab Đầu vào (chọn project ag-go, chọn video theo thứ tự tick, tải file), thẻ job (ai xử lý, đang làm gì,
  tiến độ, đã trôi, còn ≈, Dừng), job của luồng ngay trên ô chat, Dừng job từ "Việc đang chạy".
- [x] Kiểm thật trên stack local: agent gọi `footage_search` → `inputs_add` → `inputs_prepare`; job tải proxy ag-go,
  dò cảnh, khung hình, farm "local-render" đọc lời thoại; Studio báo vào luồng, agent tự làm tiếp và báo xong.
- Còn lại: audio tải lên chưa được đọc thành chữ (job `transcribe_upload`) — ghi ở `deferred-items.md`.

## P5 — Nghiên cứu (xong 2026-10-10)

- [x] Contracts `studio-crawl.ts`: `CrawlRequestSchema` (trending, topic, top_channels, channel_top), `estimateCrawlUnits`,
  `isLargeCrawl` (> 500 đơn vị hoặc > 100 video), `StudioCrawlSchema` (`schemas/studio-crawl.json`).
- [x] Engine `workspace/youtube-crawl.ts`: Data API (mostPopular, search theo lượt xem trong N ngày, search kênh + 5 video
  xem nhiều gần đây của mỗi kênh, search theo kênh) có cache theo ngày; không có key thì yt-dlp (`ytsearchN:`, 100 video
  mới nhất của kênh) và ghi chú; xu hướng cần API.
- [x] Job `research` → `research/<ngày>-<slug>.{json,md}` (bảng, ⭐ vượt trội, nhận xét nhanh), trùng ngày thì `-2`.
- [x] Tool agent `youtube_trending`, `youtube_search`, `youtube_top_channels`, `youtube_channel_top_videos` (chờ ≤ 60 s,
  tự làm tiếp khi xong; crawl lớn bị từ chối, người chạy ở tab Nghiên cứu).
- [x] API `ResearchController` (ước lượng, chạy, danh sách tài liệu); web tab Nghiên cứu.
- [x] Kiểm thật trên stack local (API key): xu hướng VN 10 video (1 đơn vị), "phố cổ Hội An" 365 ngày (102 đơn vị).
- Thẻ xác nhận cho crawl lớn do agent đề xuất: ở P6 (`propose_action(crawl_large)`).

## P6 — Làm video (xong 2026-10-10, trừ editor trực quan)

- [x] `0034` thẻ xác nhận (`agent_actions`): `propose_action` (render_final, export_premiere, delete_video, crawl_large,
  reference_download), vai cần có, hết hạn 24 giờ hoặc khi timeline đổi; API xác nhận/từ chối; thẻ trong chat.
- [x] `workspace/renders.ts`: job render_preview / render_final (máy farm chọn được) / export_premiere qua
  `project_farm_jobs`, ghi chú `videos/<id>/renders/`, video "done" khi xong bản cuối.
- [x] `0035` giọng đọc và nhạc của dự án (từ file audio tải lên, nguồn gốc giọng do người dùng nói).
- [x] `workspace/fit.ts` (job `fit`): edit-plan.json + survey.json + sources/index.json → TTS trên farm (giọng dự án, kho giọng)
  → `fitCutTimeline` → bản timeline mới + `videos/<id>/timeline.json`; chữ theo branding, nhạc dự án hoặc thư viện.
- [x] Tool `timeline_from_edit_plan`, `timeline_get`, `timeline_apply_ops` (theo bản đã đọc), `render_preview`,
  `thumbnail_make`, `music_list`; kiểm file survey/edit-plan theo mã cảnh của video; bước timeline/preview/final theo DB;
  skill `scene-selection`, `edit-plan`.
- [x] Thumbnail (job `thumbnail`) cắt khung từ bản render, chữ theo branding → `videos/<id>/thumbnails/`.
- [x] Học phong cách (job `style_watch` sau thẻ `reference_download`): tải ≤480p, đo nhịp, tờ ghép, xoá video.
- [x] API trang video (render + link theo quyền footage của người xem, timeline, dựng lại, giọng/nhạc); web tab Xem trước.
- [x] Kiểm thật trên stack local: agent chọn cảnh → kế hoạch dựng → timeline bản 1 → render xem trước trên farm (11 s,
  1920×1080), Studio báo vào luồng, agent làm tiếp.
- Còn lại: editor timeline trực quan cho video (`modules/editor` vẫn gắn với tập cũ) — `deferred-items.md`.

## P7 — Nguồn 480p sạch (xong 2026-10-10, chưa push ag-go)

- [x] Studio: `resolveAssets.prefer` trong cả hai client ag-go; `/farm/sign` gửi `{short_edge: 480, clean: true}` cho job xem
  trước của dự án (bản cuối thì không); bước chuẩn bị đầu vào cũng xin bản đó. ag-go cũ bỏ qua trường lạ, vẫn chạy.
- [x] ag-go-api nhánh `feat/resolve-prefer` (commit `b6dc043`, **chưa push**): `ResolveAssetsDto.prefer`, `pickRendition`
  (sạch trước nếu người xem được phép, rồi cạnh ngắn bằng mục tiêu, không có thì nhỏ nhất lớn hơn, rồi lớn nhất nhỏ hơn;
  cùng cỡ thì preview < proxy < gốc), trả `width`/`height`; test đơn vị.
- Việc vận hành (hỏi người dùng trước): thêm `{resolution: 480, watermark: false}` vào profile render của ag-go và chạy lại
  variant cho asset cũ. Chưa có bản 480 sạch thì người có quyền nhận proxy 720 sạch, người khác nhận bản watermark gần nhất.

## P8 — Gỡ hệ thống cũ, tài liệu (xong 2026-10-10)

- [x] Engine, API, worker (`6b7466b`): gỡ run control, stage, chat theo bước, tài liệu bước, overview/queue cũ, editor,
  thumbnail cũ, Canva, nhật ký LLM cũ, workflow `ag-studio-*`, skill `studio-*`, `StudioAgentExecutor`; core chỉ còn
  migration/clock/dataRoot; pool = agent runner + job runner + quét dọn mới; `/farm/sign` chỉ còn job dự án; màn Hàng đợi
  đọc activity của mọi dự án (`studioActivity`).
- [x] Web (`1ef0fad`): gỡ chat/production/editor/render, trang production, playground, Canva; Hàng đợi và kho nhạc dùng
  khung workspace; form admin (tên AI, cap Claude) ở `modules/admin`; i18n gọn về `ws.*`.
- [x] Tài liệu: `AGENTS.md`, `README.md`, `docs/studio-api-v4.md` (gộp phần team/skill/Studio của v3; v3 đã xoá), runbook
  local, `skills/README.md`, `agent-skills/README.md`, `deferred-items.md`, `.env.example`, Dockerfile; xoá runbook
  production và Canva.
- Còn lại (`deferred-items.md`): schema thời workflow trong contracts/core, chọn máy farm trên thẻ bản cuối, editor kéo-thả,
  E2E đường dự án.
