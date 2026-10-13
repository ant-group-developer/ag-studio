# Nâng cấp vòng 2026-10-13: header, bảng, nhạc nền, xem trước, chuẩn bị đầu vào ở ag-go, thống kê ở ag-go, hướng dẫn

**Trạng thái:** đã duyệt 2026-10-13 ("ok làm tất cả đi"), kể cả 5 điểm đề xuất bên dưới. Hợp đồng giữa các repo ở mục cuối.

Nhánh `dev-duc` ở sáu repo: ag-studio, ag-farm, ag-scan-worker, ag-render-worker, ag-go-v2/ag-go-api,
ag-go-v2/ag-go-web. Mỗi task một commit (Conventional Commits), có test, i18n đủ vi/en. Không push khi chưa hỏi.
Khác các vòng trước: vòng này **có đổi ag-go** (P3, P4).

## Đã chốt với người dùng

- Breadcrumb và ô chọn nhóm gộp làm một: nhóm là mục đầu của breadcrumb.
- Danh sách dự án có người tạo.
- Mọi bảng có header dính khi cuộn.
- Hộp chọn nhạc nền đẹp hơn, thứ tự phát kéo thả thay cho nút ↑ ↓.
- Link xem bản render: **bỏ kiểm quyền footage** cho bản xem trước và bản cuối (mp4), **giữ** cho file Premiere (.zip
  đóng gói chính các file footage).
- Chuẩn bị đầu vào **mức c**: ag-go làm ngay khi footage vào, **lưu vào DB ag-go**, chạy bù (backfill) cho toàn bộ
  footage cũ. Studio chỉ **nhờ ag-go chạy** khi asset chưa có dữ liệu; ag-go chạy xong thì lưu lại, lần sau dùng ngay.
  Studio không tự cắt cảnh, không tự gửi farm đọc lời thoại nữa.
- Thống kê tải và dùng footage **xem ở ag-go** (ag-go-web).
- Hướng dẫn người mới gồm: checklist "Bắt đầu", tour, trang hướng dẫn. Không làm dự án mẫu.

## Cần duyệt cùng plan (đề xuất sẵn, sửa nếu không đúng ý)

1. **Cách đếm.** *Lượt dùng* của một footage = số video Studio khác nhau có footage đó trong bản render cuối hoặc file
   Premiere, kèm số dự án Studio đã thêm nó. *Lượt tải* = tải trực tiếp trên ag-go (bảng `download_logs` có sẵn, kể cả
   từng file trong gói zip) cộng số lần xuất Premiere có kèm footage. Bản xem trước và các lần farm tải bản 480p để dựng
   **không** tính.
2. **Khung hình chuẩn bị cắt từ bản sạch** (không watermark), giống keyframe ag-go đang làm. Mọi người dùng Studio thấy
   cùng một bộ khung 480 px. Hiện nay Studio cắt từ bản người chủ dự án được xem (có thể có watermark). Nếu muốn giữ
   watermark thì ag-go phải cắt hai bộ.
3. **Lời thoại:** ag-go lưu bản thô của WhisperX; Studio lọc câu nghe nhầm khi tải về (như hiện nay).
4. **Bản xem trước** giữ khung 1080p (chữ ASS đặt cỡ theo khung), chỉ giảm bitrate.
5. **"Đã xem tour / đã ẩn checklist"** lưu theo người trong DB Studio để không hiện lại trên máy khác.

## Hiện trạng (đã đọc code)

| Việc | Hiện trạng |
|---|---|
| Header | `WorkspaceShell.tsx:52-82`: `TeamPicker` (Select riêng) đứng trước breadcrumb; trang dự án hiện tên nhóm hai lần. `/teams`, `/teams/:id` dùng ProLayout riêng (`App.tsx:29-75`), không có breadcrumb. |
| Người tạo dự án | DB có `projects.created_by` (`0030_projects.sql`), API đã trả `createdBy`, web không hiện. Tên tra qua `AccountDirectoryService.summaries` (đã dùng ở audit). |
| Bảng | 3/9 bảng có sticky (Teams, Members, project ag-go). Trang workspace cuộn trong `.ws-page`, nên cần `offsetHeader: 0` (`CONTAINER_TABLE_STICKY`, chưa ai dùng). |
| Hộp nhạc | `AudioControls.tsx:158-227`: danh sách tích chọn, thứ tự bằng nút ↑ ↓, không nghe thử, không có thời lượng. Không có thư viện kéo thả trực tiếp (dnd-kit chỉ nằm trong lockfile qua pro-table). |
| Link xem render | `video-media.controller.ts:152-164` kiểm quyền mọi clip bằng ag-go `resolve` (lô 10, lô đầu chạy riêng); ag-go xử lý **tuần tự** từng clip (HEAD R2 hoặc 2 query + ký URL) rồi ghi log; Studio bỏ hết URL nhận về. Nhớ 10 phút trong RAM, mất khi restart. Thêm một vòng `/renders` → `/link` → video, preflight CORS mỗi request. |
| File xem trước | Mã hoá như bản cuối: `final-graph.ts:226` luôn `tier: "final"` (NVENC p6 cq19 maxrate 60M / x264 slow crf18). |
| Tab Tệp | `files.ts:130-143` đọc cả file + SHA-256 **đồng bộ** (khoá event loop của API), đọc lại lần nữa để trả, không Range, web tải xong blob mới phát. |
| Chuẩn bị đầu vào | Mỗi dự án tự tải bản 480p, cắt cảnh, cắt khung, ghép tờ, gửi farm đọc lời thoại (`prepare.ts:136-286`), lưu theo `(project_id, asset_id)`: cùng footage dùng ở dự án khác làm lại từ đầu. Không có TTS ở bước này (TTS ở `fit`, đã cache chung). |
| ag-go scan | `scan.extract` (cảnh không chia 20 s, keyframe lọc trùng ≤ 48 ảnh 640 px, tờ 6 cột, không tách tiếng) và `scan.ai`. Danh sách cảnh không lưu DB. Không có transcript. |
| Thống kê | Không ai đếm. ag-go có `download_logs` nhưng thống kê không đọc; Studio có dữ liệu thô (`project_sources`, `video_revisions`, job render). |
| Người mới | Chỉ có câu gợi ý ở màn trống và chip bước tiếp theo. Không tour, không trang hướng dẫn. |

---

## P1 — Header, người tạo, bảng, hộp nhạc (chỉ Studio)

1. `feat(web): the team is the first crumb` — `HeaderCrumbs`: mục đầu là ô đổi nhóm (giữ mọi thứ của `TeamPicker`:
   tìm, "Nhóm của tôi / Nhóm khác" cho admin, Tạo nhóm, Quản lý nhóm), mục hai là ô đổi dự án trong nhóm (tìm theo
   tên) trên trang dự án/video, rồi tới video/luồng. Bỏ ô chọn nhóm đứng riêng và tên nhóm lặp ở trang dự án. Trang
   không thuộc nhóm (Hàng đợi, Kho nhạc, Audit, Thống kê) hiện nhóm làm việc gần nhất rồi tên trang.
   ```
   AG Studio  ›  [Nhóm Du lịch ▾]  ›  [Kênh Hoa Lư ▾]  ›  Video 3
   ```
2. `feat(web): team pages in the workspace shell` — `/teams`, `/teams/:id` dùng `WorkspaceShell` thay ProLayout
   (`Quản lý nhóm › Tên nhóm`); bảng hai trang này đổi sang sticky trong khung cuộn.
3. `feat(api,web): who made each project` — `GET /teams/:teamId/projects` thêm `creator: UserSummary`; thẻ dự án
   hiện avatar + tên, bảng có cột "Người tạo"; lọc "Do tôi tạo", sắp theo người tạo.
4. `feat(web): every table keeps its header in view` — sticky cho Projects, Audit, hai bảng Thống kê, Team skills,
   Footage picker; bảng có cuộn ngang trỏ `getContainer` vào khung cuộn. Thêm spec quét mã nguồn: mọi `<Table`/`<ProTable`
   phải có `sticky`, để bảng mới không quên.
5. `feat(api): a short link to play a workspace file` — token HMAC ngắn hạn (dự án, đường dẫn, người, hết hạn 15 phút,
   theo mẫu `agent/token.ts`), route `@Public()` `GET projects/:id/files/stream?path&t=` phục vụ bằng `res.sendFile`
   (có Range, 206). `files[]` của view giọng/nhạc kèm `listenUrl`. Dùng cho hộp nhạc (task 6) và tab Tệp (P2.4).
6. `feat(web): music picker with listening and drag to order` — hộp hai cột:
   ```
   ┌ Chọn nhạc nền ────────────────────────────────────────────┐
   │ [Tìm file…]                   │ Thứ tự phát · 3 bài · 7:42 │
   │ ☑ ▶ chill-01.mp3    2:31      │ ⠿ 1  chill-01     2:31  ✕  │
   │ ☐ ▶ lofi-02.mp3     3:05      │ ⠿ 2  lofi-03      2:40  ✕  │
   │ ☑ ▶ lofi-03.mp3     2:40      │ ⠿ 3  piano-07     2:31  ✕  │
   │ [+ Tải thêm file]             │ Chuyển mờ [───●──] 2 s     │
   │                               │        [Dùng làm nhạc nền] │
   └───────────────────────────────────────────────────────────┘
   ```
   Kéo thả bằng `@dnd-kit/core` + `@dnd-kit/sortable` (thêm làm dependency trực tiếp, cùng bản lockfile đang có), có tay
   nắm, kéo được bằng bàn phím. Nghe thử từng bài; thời lượng đọc từ metadata của `<audio preload="metadata">` (không cần
   API đo). Tổng thời lượng trừ phần chuyển mờ. Màn hẹp thì hai cột xếp dọc.

## P2 — Xem trước nhanh (Studio + render worker)

1. `perf(api): render links without a footage check, except Premiere` — `link` chỉ gọi `footageVerdict` khi
   `kind === 'export_premiere'`. `GET videos/:id/renders` trả luôn `url` cho bản mp4 (ký URL là phép tính tại chỗ), bỏ
   vòng `/link` thứ hai; Premiere vẫn xin link lúc bấm. Web chỉ hiện "bị ẩn" cho dòng Premiere. Sửa
   `video-media.spec.ts:71-111` (ma trận quyền chuyển sang job Premiere), `VideoPanel.spec.tsx:78-90`,
   `docs/studio-api-v4.md:210-216`, `docs/runbooks/studio-project.md:54`, ADR mục mới.
   Lưu ý đã chốt: bản cuối dựng từ bản gốc của chủ dự án, nên người trong dự án xem được bản cuối chất lượng đầy đủ dù
   quyền ag-go riêng của họ không phủ footage đó.
2. `perf(core): a lighter encode for previews` — `videoEncoderArgs` thêm tier `preview` (NVENC `p4 -cq 25 -maxrate 6M
   -bufsize 12M`, x264 `veryfast -crf 24 -maxrate 6M -bufsize 12M`); `RenderInput.tier` đi qua `finalInput` →
   `FinalGraphInput`. Mezzanine không đổi (khoá cache giữ nguyên). Test `encoder`, `final-graph`, `run`.
3. ag-render-worker `perf: previews encode lighter` — `render-handler.ts:385-395` đặt `tier: isPreview ? 'preview' :
   'final'`; build lại `@ag-studio/render`, phát hành **0.9.1** (máy tự cập nhật).
4. `perf(api,web): stream workspace videos` — `GET files/content` với file nhị phân chỉ `stat` (không đọc cả file, không
   hash); tab Tệp phát video/audio/PDF bằng link stream của P1.5 thay vì tải blob trước.
5. `perf(api): fewer waits on Account API and CORS` — `enableCors({ maxAge: 7200 })`; `AccountApiService` có timeout
   5 s, gộp các lần hỏi cùng người đang chạy, lỗi thì dùng tạm kết quả cũ; JWKS cũng có timeout.

**Xong khi:** mở tab Xem trước thấy player có link ngay cùng danh sách (một request); file preview nhỏ đi nhiều lần;
xem video 300 MB ở tab Tệp phát ngay và không làm chậm request khác.

## P3 — Chuẩn bị đầu vào ở ag-go

### Thiết kế

Một **luồng riêng "prep"** trong ag-go, không gộp vào analysis: analysis chỉ thành `is_current` sau `scan.ai`, lỗi
bước nào cũng hỏng cả analysis, và chạy lại là chạy lại cả mô hình ảnh. Prep có bảng, trạng thái, job farm riêng.

```
footage vào ag-go ─► asset_preps (queued)
   │  farm: scan.prep (scan worker, CPU)
   │     cảnh theo luật Studio · khung giữa mỗi cảnh 480 px · tờ 4×16 · audio.wav 16 kHz
   ▼
cutting ─► ingest prep.json → shots, sheets vào DB
   │  có tiếng (và scan không báo "không lời") → farm: studio.transcribe (render worker, GPU), dùng lại handler sẵn có
   ▼
transcribing ─► ingest transcribe.json → transcript vào DB, xoá audio.wav
   ▼
ready  (đọc lời thoại lỗi: vẫn ready, transcript_status = failed — lời thoại là phần thêm, như Studio hiện nay)
```

- **Lưu ở đâu:** Postgres `asset_preps` (một bản `is_current` mỗi asset): `duration_s, width, height, fps, has_audio,
  shots jsonb, sheets jsonb, transcript jsonb, transcript_text, transcript_status, language, source_kind, status, error,
  priority, batch_id`. Ảnh trên R2 ở `<variants>/prep/<prepId>/frames/NNN.jpg`, `sheets/NN.jpg`.
- **Ưu tiên khi Studio cần:** footage mới và backfill đi lane `batch`, ưu tiên thấp (nhường việc của Studio). Studio xin
  chạy thì ag-go gửi lane `interactive`, ưu tiên cao; nếu asset đang chờ trong lô backfill thì nâng job đó lên (endpoint
  mới ở hub).
- **Studio:** `prepare_asset` hỏi ag-go → có thì tải khung, tờ về `inputs/<assetId>/`, ghi `shots.json`,
  `transcript.json/.md`, `README.md` **đúng định dạng hiện nay** (video-index, fit, skill chọn cảnh đọc không đổi) →
  chưa có thì xin chạy rồi chờ, hiện tiến độ "đang chờ máy / đang cắt cảnh / đang đọc lời thoại". Không còn tải video,
  không cắt cảnh, không gửi farm ở Studio.
- **Dự án đã chuẩn bị** giữ nguyên file cũ (Studio chỉ chuẩn bị lại khi bấm "Chuẩn bị lại"), để `survey.json` và kế
  hoạch dựng đang có không lệch mã cảnh.

### ag-farm

1. `feat(protocol): scan.prep` — `JOB_TYPES` thêm `scan.prep`; spec `{owner: ag-go, lane: batch, slot: cpu}`;
   `jobs/scan-prep.ts`: payload `{asset_id, source, params: {scene_threshold 0.3, min_shot_s 1, max_shot_s 20,
   frame_width 480, sheet_cols 4, sheet_shots 16, audio}}`, manifest `prep.json` `{schema: ag.scan.prep/v1, media,
   shots[{n,in,out,frame}], sheets[{file,shots}], audio}`. Loại job mới nên không vướng schema strict của `scan.extract`.
2. `feat(hub): ag-go may run scan.prep and studio.transcribe` — migration thêm hai loại vào `allowed_types` của owner
   ag-go.
3. `feat(hub): raise a queued job` — `POST /owner/jobs/:id/raise {lane?, priority}`, chỉ job `queued` của chính owner.

### ag-scan-worker

4. `feat: scan.prep` — tải nguồn, cắt cảnh theo **đúng luật Studio** (port `buildShots` của `packages/core/src/media/
   scene.ts` kèm bộ test của nó: gộp cảnh < 1 s, chia cảnh > 20 s, lưới 0,1 s; bỏ giới hạn 120 s của dò cảnh, timeout
   theo thời lượng), khung giữa mỗi cảnh `scale=480:-2`, tờ `tile=4x…` 16 cảnh/tờ, `audio.wav` 16 kHz mono khi có
   tiếng, báo tiến độ. Phát hành **0.5.0**.

### ag-render-worker

Không đổi code cho bước này: `studio.transcribe` nhận job của bất kỳ owner nào, tải `audio` qua link ký của owner đó.

### ag-go-api

5. `feat(farm): know every farm job type` — đồng bộ bản chép protocol (`JOB_TYPES` thiếu `scan.prep`,
   `studio.transcribe`, `studio.export_premiere`, `studio.reference_fetch`); poller bỏ qua loại không phải của mình thay
   vì hỏng cả lượt.
6. `feat(prep): asset_preps` — migration `2120000000000-asset-preps`: `asset_preps`, `asset_prep_farm_jobs`; entity đăng
   ký ở `data-source.ts` và `app.module.ts`.
7. `feat(prep): run a prep on the farm` — `PrepService.enqueue`, gửi `scan.prep` (`<prepId>:prep`), ingest rồi gửi
   `studio.transcribe` (`audio: artifact:audio.wav`), ingest transcript, xoá `audio.wav`. `FarmTicketGuard` và sign
   service thêm nhánh prep: nguồn = bản sạch nhỏ nhất có cạnh ngắn ≥ 480 (không có thì proxy 720, rồi bản gốc), chỉ cho
   ghi `frames/`, `sheets/`, `prep.json`, `audio.wav`, `transcribe.json`; không ghi log hệ thống cho từng ảnh tải lên.
8. `feat(prep): prep new footage and backfill the rest` — footage video mới xong xử lý tự vào hàng (`PREP_AUTO_ENQUEUE`,
   mặc định bật, độc lập với `ANALYSIS_AUTO_ENQUEUE`); `POST /prep/backfill {mode: missing|all, dryRun}`
   (`go.analysis.manage`), lane batch, tạm dừng / tiếp / huỷ cả lô qua `group_key`; `GET /prep/stats`.
9. `feat(footage): Studio reads and asks for preps` — `POST footage/assets/prep {assetIds}` (`footage:read`): mỗi asset
   `ready | running (phase, progress) | missing | failed` kèm dữ liệu và URL ký của khung, tờ;
   `POST footage/assets/prep/run {assetIds}` (`footage:resolve`): missing/failed → chạy interactive; đang chờ trong
   backfill → nâng job. Kiểm phạm vi bằng `assertAssetsInScope`.

### ag-go-web

10. `feat(analysis): Studio prep progress and backfill` — trên trang phân tích (admin): số ready / đang chạy / lỗi /
    chưa có, nút chạy bù, tạm dừng, tiếp, huỷ.

### Studio

11. `feat(ag-go-client): read and ask for preps` — thêm hai hàm vào `packages/ag-go-client` (worker) và
    `apps/api/src/ag-go/client.ts`.
12. `feat(engine): prepare from ag-go` — `prepare_asset` đọc / xin / chờ (hỏi lại mỗi 5 s, tối đa 60 phút), tải khung và
    tờ (8 luồng), ghi file theo định dạng hiện nay, lọc transcript bằng `transcript-clean.ts`, `savePrepared`. Gỡ phần cắt
    cảnh, tách tiếng, gửi farm của prepare (giữ hàm còn dùng ở chỗ khác như `style_watch`). ETA theo trạng thái ag-go.
13. `docs: inputs come prepared from ag-go` — ADR mục mới, runbook, mô tả tool `inputs_prepare` và prompt agent (đang ghi
    "tải bản xem 480p … lời thoại qua farm"), skill chọn cảnh nếu có nhắc.

**Xong khi:** footage mới vào ag-go tự có cảnh, khung, tờ, lời thoại trong DB; lô chạy bù chạy được và dừng được;
"Chuẩn bị" ở Studio với footage đã có xong trong vài giây; với footage chưa có thì Studio chờ ag-go chạy (ưu tiên) và
lần sau ở dự án khác là tức thì.

## P4 — Thống kê dùng footage ở ag-go

### ag-go-api

1. `feat(auth): service-only routes` — decorator `@ServiceOnly(scope)`: cần `X-Service-Key` có scope, không cần
   `X-Act-As-User` (khỏi gọi Account API mỗi lần), từ chối JWT người dùng.
2. `feat(usage): Studio usage events` — migration `2130000000000-studio-usage`: `studio_usage_events` (`event_key`
   unique để gửi lại không đếm trùng, `kind`: source_added / source_removed / final_render / premiere_export, `asset_id`,
   `ag_go_project_id`, `studio_project_id/name`, `studio_video_id/title`, `studio_user_id`, `occurred_at`); thêm index
   `download_logs(asset_id)`, `download_logs(project_id)`, `download_job_items(asset_id)`. `POST /usage/studio-events`
   (≤ 500 sự kiện mỗi lần, scope `usage:write`).
3. `feat(usage): usage of an asset and a project` — `GET /footage/assets/:id/studio-usage`,
   `GET /projects/:id/studio-usage`: số dự án Studio, số video, số bản cuối, số lần xuất Premiere, lượt tải, lần dùng gần
   nhất, 20 video Studio gần nhất (tên, dự án, lúc nào, link). Project cộng dồn qua `project_media` (footage dùng chung
   tính cho mọi project chứa nó) và sự kiện thêm cả project ag-go.
4. `feat(statistics): Studio usage` — `GET /statistics/studio-usage` theo kỳ và phạm vi thư mục như các widget khác:
   tổng, top 20 footage, top 20 project, xu hướng theo ngày.

### ag-go-web

5. `feat(footage): Studio usage of a video and a project` — tab "Studio" trong drawer footage
   (`footage-video-drawer.tsx`) và chi tiết file trong drawer project (`project-review-drawer.tsx`); thẻ "Dùng trong
   Studio" của project. Link về Studio qua `VITE_STUDIO_WEB_URL`.
6. `feat(statistics): Studio usage card` — thẻ trên trang Thống kê: số liệu chính, top footage, top project.

### Studio

7. `feat(engine): usage outbox` — migration `0040_ag_go_usage.sql`: bảng `ag_go_usage_outbox` (`event_key` PK, payload,
   `sent_at`, `attempts`, `next_at`, `last_error`), **kèm chạy bù** bằng SQL từ `project_sources` và job
   `render_final`/`export_premiere` đã xong (asset lấy từ `video_revisions.clips[].asset_id`). Ghi sự kiện ở
   `addSource`/`removeSource` (mọi đường thêm, kể cả tool agent) và khi job bản cuối/Premiere xong (`INSERT OR IGNORE`
   theo id job nên chạy lại không trùng).
8. `feat(worker): send usage to ag-go` — vòng lặp 30 s trong worker (theo mẫu dọn rác), gửi lô 200, lỗi thì lùi dần;
   hàm mới trong `packages/ag-go-client`.

**Xong khi:** mở một footage trên ag-go thấy "Dùng trong Studio: N dự án · M video · K lượt tải" và danh sách video;
trang Thống kê có top footage/project; ag-go tắt một lúc rồi bật lại thì không mất sự kiện, không đếm trùng.

## P5 — Hướng dẫn người mới (Studio)

1. `feat(api): getting started progress and prefs` — migration `0041_user_prefs.sql`; `GET /me/onboarding` (đếm trong
   các nhóm của người đó: nhóm, dự án, project ag-go đã thêm, video, lượt chat của mình, bản xem trước, bản cuối);
   `GET/PUT /me/prefs` (đã xem tour, đã ẩn checklist).
2. `feat(web): getting started checklist` — nút "Bắt đầu 3/7" trên header mở bảng việc: vào nhóm → tạo dự án → thêm
   project ag-go → tạo video → chat với agent → render bản xem trước → render bản cuối. Mỗi việc có nút "Đi tới" và
   "Xem cách làm" (mở mục tương ứng ở trang hướng dẫn). Xong hết hoặc bấm ẩn thì thôi hiện.
3. `feat(web): product tour` — `Tour` của antd, gắn `data-tour` vào ô nhóm, nút tạo dự án, thanh video, thanh bước, ô
   chat, các tab bên phải (Đầu vào, Xem trước). Tự chạy lần đầu vào trang dự án; xem lại từ trang hướng dẫn hoặc menu
   avatar.
4. `feat(web): guide page` — route `/guide`, link "Hướng dẫn" trên header cho mọi người. Nội dung viết cho người dùng
   cuối (vi/en), dựa trên `docs/runbooks/studio-project.md`: dự án và video là gì, thêm footage, giọng và nhạc, làm một
   video từ đầu tới bản cuối, chỉnh bằng chat, lỗi thường gặp. Dùng `{{site}}` thay cho chữ "ag-go" như phần còn lại.

---

## Triển khai (thứ tự)

P1, P2 (trừ render worker) và P5 chỉ đổi Studio, lên lúc nào cũng được. P3, P4 theo thứ tự:

1. **ag-farm:** protocol + hub (migration `allowed_types`, endpoint nâng job).
2. **Worker:** ag-scan-worker 0.5.0 (`scan.prep`), ag-render-worker 0.9.1 (tier preview). Máy tự cập nhật.
3. **ag-go-api:** migration 2120, 2130; env `SERVICE_KEYS` thêm scope `usage:write` cho Studio; `PREP_AUTO_ENQUEUE=true`.
   Sau đó chạy bù prep (lane batch).
4. **ag-go-web:** env `VITE_STUDIO_WEB_URL`.
5. **Studio:** migration 0040, 0041 (API tự chạy khi khởi động).

## Cách kiểm

- P1: đổi nhóm/dự án từ breadcrumb; cuộn mọi bảng thấy header đứng yên; hộp nhạc kéo thả bằng chuột và bàn phím, nghe
  thử, tổng thời lượng đúng.
- P2: DevTools — mở tab Xem trước chỉ một request `/renders` có sẵn `url`; dung lượng preview mới so với cũ; xem video
  lớn ở tab Tệp thấy request `206 Partial Content`.
- P3: thêm một footage mới vào ag-go → `asset_preps` qua `cutting → transcribing → ready`; Studio "Chuẩn bị" footage đó
  ở hai dự án: lần đầu chờ, lần hai vài giây; `inputs/<asset>/` khớp định dạng cũ (test so `shots.json` của hai đường
  trên cùng một video mẫu).
- P4: render bản cuối ở Studio → trong 1 phút ag-go hiện thêm một video ở tab "Studio" của footage đó; tắt ag-go-api,
  render tiếp, bật lại → sự kiện tới đủ, không trùng.
- P5: tài khoản mới thấy checklist 0/7 và tour; làm từng bước thì checklist tự đánh dấu.
- Mỗi repo: test + build + typecheck sạch (ag-studio: `pnpm test`, `corepack pnpm -r run build`, `pnpm -r typecheck`).

## Rủi ro, để ngỏ

- **Chạy bù tốn GPU:** đọc lời thoại cho toàn bộ footage chạy trên máy render có GPU, lane batch nên nhường việc Studio
  nhưng sẽ kéo dài; tranh VRAM với Ollama của `scan.ai` trên cùng máy. `python_timeout_s` của render worker mặc định
  600 s, cần nâng nếu có footage rất dài.
- **Cảnh hơi khác giữa đường cũ và mới** (nguồn khác nhau): dự án cũ giữ file cũ, chỉ đổi khi bấm "Chuẩn bị lại".
- **`download_logs.status` không bao giờ lên `completed`:** lượt tải tính theo dòng `started`.
- **Đưa lời thoại vào tìm kiếm footage của ag-go:** làm sau (có sẵn `transcript_text` để thêm vào `search_vector`).
- **Ảnh bìa project ag-go gọi N+1** (`ProjectGridView.tsx:37-44`) và ký asset từng cái khi render (`farm.controller.ts:
  173-189`): không thuộc vòng này.

---

## Hợp đồng giữa các repo (chốt trước khi làm song song)

Các repo làm song song theo đúng các hình dạng dưới đây. Đổi gì thì sửa mục này trước.

### H1. Farm job `scan.prep` (ag-farm `packages/protocol/src/jobs/scan-prep.ts`)

```ts
ScanPrepParamsSchema = z.strictObject({
  scene_threshold: z.number().min(0).max(1).default(0.3),
  min_shot_s: z.number().positive().default(1),
  max_shot_s: z.number().positive().default(20),
  frame_width: z.number().int().min(64).max(1920).default(480),
  sheet_cols: z.number().int().min(1).max(8).default(4),
  sheet_shots: z.number().int().min(1).max(64).default(16),
  audio: z.boolean().default(true),            // false: không xuất audio.wav
});
ScanPrepPayloadSchema = z.strictObject({
  asset_id: z.string().uuid(),
  source: InputNameSchema,                      // ag-go ký GET của "source" như scan.extract
  params: ScanPrepParamsSchema.default({}),
});
ScanPrepManifestSchema = z.strictObject({      // output "prep.json"
  schema: z.literal('ag.scan.prep/v1'),
  asset_id: z.string().uuid(),
  media: z.strictObject({ duration_s: z.number(), width: z.number().int(), height: z.number().int(),
    fps: z.number().nullable(), has_audio: z.boolean() }),
  scene: z.strictObject({ threshold: z.number(), min_shot_s: z.number(), max_shot_s: z.number() }),
  shots: z.array(z.strictObject({ n: z.number().int().min(1), in: z.number(), out: z.number(),
    frame: z.string() })),                      // "frames/001.jpg" (pad3, 1-based)
  sheets: z.array(z.strictObject({ file: z.string(), shots: z.array(z.number().int()) })), // "sheets/01.jpg" (pad2)
  audio: z.string().nullable(),                 // "audio.wav" (16 kHz mono pcm_s16le) hoặc null khi không có tiếng
  tools: z.record(z.string()).optional(),
});
```
Spec: `{ owner: 'ag-go', lane: 'batch', slot: 'cpu', baseRequirements: {} }`. Đầu ra: `prep.json`, `frames/NNN.jpg`
(`scale=480:-2`, khung giữa cảnh `round(((in+out)/2)*1000)/1000`), `sheets/NN.jpg` (ffmpeg `tile=4x<ceil(n/4)>`, 16 cảnh
mỗi tờ theo thứ tự), `audio.wav`. Cảnh theo đúng `buildShots` của ag-studio `packages/core/src/media/scene.ts`, mốc cắt
làm tròn lưới 0,1 s như `cut-ffmpeg.ts:84-98`.

Hub: owner `ag-go` được phép `scan.prep` và `studio.transcribe`. Endpoint mới `POST /owner/jobs/:id/raise`
body `{ lane?: 'interactive'|'batch', priority: int -100..100 }`, chỉ job `queued` của chính owner, trả `JobView`.

`studio.transcribe` do ag-go gửi: `{ production_id: <prepId>, model: 'large-v3', align_words: true,
sources: [{ source_id: <assetId không gạch ngang hoặc dạng hợp lệ ^[A-Za-z0-9_-]+$>, audio: 'artifact:audio.wav',
language: null }] }`, đầu ra `transcribe.json` (`TranscribeManifest` có sẵn).

### H2. ag-go cho Studio (service key + `X-Act-As-User`, envelope `{ data }` như các route footage khác)

`POST /footage/assets/prep` — scope `footage:read`, quyền `FOOTAGE_SEARCH`. Body `{ assetIds: string[] }` (1..200).
Asset ngoài phạm vi → 404 như `resolve`. Trả:
```ts
{ items: Array<{
    assetId: string;
    state: 'ready' | 'running' | 'missing' | 'failed';
    phase: 'queued' | 'cutting' | 'transcribing' | null;   // khi running
    progress: number | null;                                // 0..1, khi biết
    error: string | null;                                   // khi failed
    prep: null | {                                          // khi ready
      prepId: string; preparedAt: string;
      durationS: number; width: number; height: number; fps: number | null; hasAudio: boolean;
      sourceKind: string; watermarked: boolean;
      scene: { threshold: number; minShotS: number; maxShotS: number };
      shots: Array<{ n: number; in: number; out: number; frame: string; url: string }>;   // url: GET ký sẵn
      sheets: Array<{ file: string; shots: number[]; url: string }>;
      transcriptStatus: 'none' | 'skipped' | 'done' | 'failed';   // none: không có tiếng; skipped: scan báo không lời
      transcript: null | { language: string | null; alignment: 'word' | 'segment'; engine: string;
        segments: Array<{ start: number; end: number; text: string;
          words: Array<{ word: string; start: number; end: number; score?: number }> }> };
    };
  }> }
```
`POST /footage/assets/prep/run` — scope `footage:resolve`, quyền `FOOTAGE_PRODUCE`. Body `{ assetIds: string[] }`.
missing/failed → tạo prep, lane `interactive`, priority 50; đang chờ trong lô batch → `raise`; ready/đang chạy
interactive → không làm gì. Trả cùng hình dạng như `POST /footage/assets/prep`.

### H3. Studio → ag-go: sự kiện dùng footage

`POST /usage/studio-events` — `@ServiceOnly('usage:write')` (chỉ service key, không act-as). Body:
```ts
{ events: Array<{               // 1..500
    eventKey: string;           // ≤ 200, duy nhất; gửi lại không đếm trùng
    kind: 'source_added' | 'source_removed' | 'final_render' | 'premiere_export';
    occurredAt: string;         // ISO
    assetId: string | null;     // footage; null khi là cả project ag-go
    agGoProjectId: string | null;   // khi biết (source kind ag_go_project, hoặc meta.agGoProjectId)
    studioProjectId: string; studioProjectName: string;
    studioVideoId: string | null; studioVideoTitle: string | null;
    studioUserId: string | null;    // auth0 sub đầy đủ; ag-go tự bỏ tiền tố "auth0|"
  }> }
→ { accepted: number; duplicates: number }
```
Studio tạo `eventKey`: `src:<sourceId>:added`, `src:<sourceId>:removed`, `job:<jobId>:<assetId>` (một sự kiện mỗi
footage của bản cuối / Premiere).

### H4. ag-go cho ag-go-web (JWT người dùng)

- `GET /footage/assets/:id/studio-usage` và `GET /projects/:id/studio-usage` → `StudioUsage`:
  ```ts
  { projects: number; videos: number; finalRenders: number; premiereExports: number;
    downloads: { direct: number; premiere: number; total: number };
    assets?: number;            // chỉ ở project: số footage của project đã được dùng
    lastUsedAt: string | null;
    recent: Array<{ kind: string; occurredAt: string; studioProjectId: string; studioProjectName: string;
      studioVideoId: string | null; studioVideoTitle: string | null; studioUserId: string | null;
      assetId: string | null }> }   // ≤ 20, mới nhất trước
  ```
- `GET /statistics/studio-usage?from&to&tz` (`go.statistics.read`, theo phạm vi thư mục) →
  ```ts
  { totals: { projects: number; videos: number; finalRenders: number; premiereExports: number; downloads: number;
      assetsUsed: number };
    topAssets: Array<{ assetId: string; name: string; videos: number; downloads: number }>;     // ≤ 20
    topProjects: Array<{ projectId: string; name: string; videos: number; downloads: number; assetsUsed: number }>;
    trend: Array<{ date: string; finalRenders: number; premiereExports: number; downloads: number }> }
  ```
- Prep (quyền `go.analysis.manage`): `GET /prep/stats` → `{ counts: { ready, running, failed, missing, total },
  batches: Array<{ id, status: 'running'|'paused'|'cancelled'|'completed', total, done, failed, createdAt }> }`;
  `POST /prep/backfill { mode: 'missing'|'all', dryRun?: boolean }` → `{ batchId: string | null, count: number }`;
  `POST /prep/batches/:id/pause|resume|cancel` → batch.
