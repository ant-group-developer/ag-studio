# Plan: góp ý vòng 2026-10-12 (chat, xem trước, đầu vào, gợi ý, admin, video mẫu, farm, worker)

Nhánh `dev-duc` ở cả bốn repo: ag-studio, ag-farm (đang sau `origin/dev` 10 commit, không có commit riêng →
fast-forward trước khi làm), ag-render-worker (0.8.1 → 0.9.0), ag-scan-worker (0.3.5 → 0.4.0). Mỗi task một commit
(Conventional Commits), có test, i18n đủ vi/en. Không push khi chưa hỏi. Không đổi ag-go.

Hợp đồng farm: P1–P6 không đổi `@ag-farm/protocol` hay worker-sdk. P7–P9 **có đổi** (đã nêu trong plan để duyệt): thêm
trường **tuỳ chọn** vào heartbeat/capabilities/`worker/me` và loại job `studio.reference_fetch` — worker cũ vẫn chạy với
hub mới; hub lên trước, rồi worker, rồi Studio.

Đã chốt (2026-10-12): thứ tự worker = máy xếp trước nhận việc trước; **chưa làm** trang "Tất cả dự án"; có "Xem thay đổi"
(diff) cho file đổi; làm trên `dev-duc`; video mẫu bị YouTube chặn thì **tải qua máy farm** (job `studio.reference_fetch`,
vẫn không cookie, không đăng nhập); worker tự cài thư viện/công cụ và tự nhận loại job khi cập nhật; farm theo dõi CPU,
RAM, ổ đĩa, mạng của từng máy.

**Xong khi:** bài học đề xuất chỉ hiện 1, có "Xem tất cả"; mỗi lượt chat thu thành một dòng "đã làm N bước · thời gian",
file đổi hiện dưới lượt có nút Mở và Xem thay đổi; tab Xem trước hiện ngay, player có link sau một lần hỏi ag-go; tab Đầu
vào có mục giọng & nhạc ở đầu, nhập được trực tiếp, danh sách nhiều project/video tìm, lọc, gom nhóm được; chat video chỉ
gợi ý bước của video; admin Studio thấy và mở được mọi nhóm; tải video mẫu bị YouTube chặn thì báo rõ lý do và tải được qua
máy farm; admin farm kéo thả thứ tự máy và máy xếp trước nhận việc trước; phát hành worker mới thì mọi máy **tự** cập nhật,
tự cài Python/thư viện/yt-dlp, tự nhận loại job mới, không phải ngồi từng máy; trang Máy của farm thấy CPU, RAM, ổ đĩa,
mạng, GPU hiện tại và biểu đồ gần đây; `pnpm test`, `corepack pnpm -r run build`, `pnpm -r typecheck` sạch (ag-farm: test
unit + `test:db`; worker: test + `install.tests.ps1`).

## Nguyên nhân đã tìm thấy (đọc code)

| # | Hiện tượng | Nguyên nhân |
|---|---|---|
| 1 | Bài học đề xuất chiếm chỗ | `LessonCards.tsx` render **mọi** bài `proposed`, không giới hạn, `.ws-lessons` không có max-height nên ép vùng chat. Bài mới không đẩy qua SSE vì `projectFingerprint` (`agent/activity.ts:110`) không tính `lesson_proposals`. |
| 2 | Bước tool dài, không gọn | `MessageItem.tsx:65-76` render từng `ToolChip` nối nhau, không gom. Dữ liệu đủ: mỗi tool có `started_at/ended_at`, lượt có `startedAt/finishedAt`. File đổi của lượt chỉ nằm trong `audit_log.details.changed` (chỉ màn thống kê đọc), web chat không nhận. `project_file_versions` giữ nội dung chữ ≤ 1 MB nên dựng được diff. |
| 3 | Xem trước load lâu | `GET videos/:id/renders` (`video-media.controller.ts:78`) kiểm quyền footage với ag-go **cho mọi bản render** (≤ 20, cả bản cuối/Premiere cũ), tuần tự từng revision; mỗi lần là `POST /footage/assets/resolve` đầy đủ (ag-go ký URL + HEAD R2 từng video, lô 10). Lỗi ag-go **không nhớ** → mỗi lần poll (2 s khi có job) hỏi lại. `VideoPanel.tsx:59` chờ cả danh sách mới hiện gì. |
| 4 | Không nhập được nhạc/giọng ở Đầu vào | Không có ô nhập trực tiếp: `AudioSummary` chỉ hiện trạng thái + câu hướng dẫn, ở **cuối** tab sau mọi danh sách. Cách duy nhất: tải file ở "Tài liệu, ảnh, audio" rồi bấm nút nhỏ trên dòng file (giọng cần producer; editor không thấy nút giọng). Audio tải qua tab Tệp không có dòng nguồn → không có nút. Thiếu ffmpeg chỉ báo sau khi điền modal; `GET audio` lỗi thì cả mục biến mất. Upload giới hạn 50 MB < 100 MB cho nhạc. Không chọn được bài từ kho nhạc. |
| 5 | Tab Đầu vào rối khi nhiều project/video | Một cột cuộn dài: project ag-go là `<ul>` phẳng; ở trang dự án "Video của dự án" liệt kê **mọi** asset của mọi video, không gom, trùng lặp; không tìm/lọc/phân trang. API `GET sources` gọi `activePrepare` cho từng dòng (O(n·m)). |
| 6 | Chat video vẫn gợi ý "Nghiên cứu thị trường" | `playbookStatus` (`playbook-status.ts:143`) tính `next` từ `[...bước kênh, ...bước video]`, bước kênh luôn trước; web (`ProjectPage.tsx:94`) và prompt agent (`runner.ts:162`) dùng nguyên `next`. Test (`workspace-playbook.test.ts:83`) đang khoá hành vi này. Tên bước viết cứng tiếng Việt (UI tiếng Anh vẫn hiện chữ Việt). |
| 7 | Admin không thấy mọi nhóm | `GET /teams` không có `@Roles` nên `RolesGuard` trả `true` sớm, **không bao giờ** gán `authContext.isAdmin` → controller đọc `undefined` → lọc theo thành viên. Web: `ProjectsPage.canCreate` bỏ qua admin, breadcrumb/ô chọn nhóm vỡ với nhóm không là thành viên, `useTeams` cắt ở 100. |
| 8 | "Không xem được video mẫu nào: … -from-browser or --cookies …" | Job `style_watch` chạy yt-dlp **trên VPS Studio**; YouTube chặn IP máy chủ ("Sign in to confirm you're not a bot") nên mọi video đều hỏng như nhau. Câu lỗi bị cắt mất đầu vì `lastWords` lấy 300 ký tự **cuối** (`yt-dlp.ts:64`), rồi `.slice(-300)`, `.slice(0, 400)` (`style-watch.ts:73,110`); job vẫn thử đủ 5 video dù video đầu đã bị chặn. ADR-0001 mục 175 chốt: không cookie, không đăng nhập, không lách chặn. Research không có `YOUTUBE_API_KEY` cũng đi yt-dlp nên cũng bị chặn. |
| 9 | Farm không xếp ưu tiên máy | Claim kiểu kéo (`worker.service.ts:103-243`, `FOR UPDATE SKIP LOCKED`): máy nào gọi trước thì lấy; không có cột thứ tự/ưu tiên máy nào. Có sẵn trong `farm_nodes` đủ dữ liệu để xét máy khác (status, kinds, capabilities, `free_slots`, `last_seen_at`). |
| 10 | Cập nhật worker phải làm tay từng máy | **Không có tự cập nhật**: chỉ `install.ps1` đọc `latest.json`; cập nhật = chạy lại lệnh cài (bỏ `-Code`) trên từng máy. Đường cập nhật **không ghi lại `config.yaml`** (`install.ps1:385`) nên `kinds` mới và `extra` mới (`python_bin`…) không bao giờ tới máy cũ. Python chỉ cài khi thêm `-WithTts`, và cần sẵn `py -3.11` (`setup-python.ps1` không cài Python, không kiểm mã lỗi pip, venv mặc định `D:\`). yt-dlp không có ở farm/worker nào. Model tải lần đầu khi chạy job. `kinds` worker báo lấy từ `config.yaml`, không theo handler + công cụ có thật; admin đặt `allowed_kinds` thì loại mới bị chặn tới khi thêm tay. Capabilities chỉ dò một lần lúc khởi động; dò ffmpeg trên PATH chứ không phải bản kèm theo. |
| 11 | Farm không thấy tình trạng máy | Heartbeat (`HeartbeatRequestSchema`, strict) chỉ gửi **tổng** CPU core, RAM, VRAM; không đo CPU %, RAM đang dùng, ổ trống, mạng, GPU %, nhiệt độ ở đâu cả. Trang Máy chỉ hiện cấu hình, slot trống, số job, lần thấy cuối, phiên bản (không so với bản mới nhất). |

## P1 — Quyền admin và gợi ý (nhỏ, rủi ro thấp, làm trước)

1. `fix(api): a Studio admin lists every team` — `GET /teams` hỏi `StudioAdminService.isAdmin(req)` thay vì đọc
   `authContext.isAdmin`; mỗi nhóm trả thêm `isMember`. Test qua guard thật (controller + `RolesGuard`), không chỉ service.
2. `feat(web): an admin finds and opens any team` — ô chọn nhóm: "Nhóm của tôi" + "Nhóm khác" (chỉ admin), có ô tìm (`q`
   của API, không còn cắt 100); `/teams` liệt kê mọi nhóm cho admin; breadcrumb lấy tên từ `GET /teams/:id`; `canCreate`
   tính admin; không nháy chỉ-đọc lúc `/me` đang tải; dải nhỏ "Bạn đang xem với quyền admin" ở nhóm không phải thành viên.
   Admin vẫn sửa được như hiện nay (chat, render ghi là admin trong nhật ký).
3. `fix(engine): suggest the steps of where the chat is` — `playbookStatus(…, { scope })`: luồng video → `next` chỉ bước
   video; bước kênh chưa xong chỉ còn là lời nhắc "Kênh còn N bước" (đã có trên rail). Yêu cầu khác phạm vi (Gói YouTube
   cần Branding kênh) không chặn gợi ý trong video, thành ghi chú trên bước. Luồng kênh/chat tự do → chỉ bước kênh. Prompt
   agent: "Bước gợi ý tiếp theo" theo phạm vi luồng; trạng thái kênh chỉ là bối cảnh. Sửa test cũ đang khoá hành vi sai.
4. `fix(web): suggestions fit the page` — rà mọi chỗ gợi ý (chip bước, `suggest_replies`, rail, câu gợi ý khi chat
   trống, modal tạo video, skill `agent-skills/*` nhắc bước kế) theo bảng ngữ cảnh: kênh mới / kênh đã có nghiên cứu /
   chat tự do / video mới / video đã chuẩn bị / video có timeline / video xong → viết thành test web. Tên và mô tả bước
   qua i18n theo `key` (playbook tuỳ biến giữ chữ của nó).

## P2 — Video mẫu bị YouTube chặn

1. `fix(engine): say plainly why a reference video was not downloaded` — phân loại lỗi yt-dlp thành mã + câu ngắn:
   YouTube chặn máy chủ (bot check / đòi đăng nhập), riêng tư, đã xoá, giới hạn tuổi, chỉ hội viên, đang live, quá dài/quá
   lớn, không có bản ≤ 480p, lỗi mạng; giữ **đầu** dòng `ERROR` (không cắt đuôi). Bị chặn kiểu bot check thì dừng ngay,
   không thử các video còn lại; job lỗi với mã `youtube_blocked` và câu "YouTube đang chặn tải từ máy chủ Studio". Áp cho
   cả `metadata`/`search`/`listChannel` (research).
2. `feat(engine): Studio remembers YouTube is blocking it` — lần bị chặn ghi `studio_settings` (`youtube.blocked_until`,
   6 giờ): prompt agent và tool `propose_action reference_download` nói trước thay vì tạo thẻ chắc chắn hỏng; thẻ đang chờ
   hiện cảnh báo; màn Hàng đợi (admin) hiện dòng cảnh báo + gợi ý đặt `YOUTUBE_API_KEY` cho research.
3. `feat(engine): learn an edit style from an uploaded video` — `style_watch` nhận thêm video người dùng tải lên
   (`context/…`): đo y như video YouTube (cắt cảnh, tờ ghép), không xoá file người dùng; tool agent `style_from_files
   {paths}` (không cần thẻ xác nhận vì không ra mạng). Khi YouTube chặn, agent đề nghị: tải video mẫu lên, hoặc tả phong
   cách bằng lời.
Tải được từ YouTube khi máy chủ bị chặn: **P9** (qua máy farm; làm sau P7 để máy farm tự có yt-dlp).

## P3 — Tab Xem trước nhanh

1. `perf(api): the renders list does not wait for ag-go` — `GET videos/:id/renders` chỉ đọc DB (không kiểm quyền, không
   ký); thêm `GET videos/:id/renders/:jobId/link` kiểm quyền + ký đúng một bản (giữ `urlHidden` như cũ).
2. `perf(api): footage rights remembered per video` — nhớ theo (người, video ag-go) 10 phút; chỉ hỏi ag-go phần chưa
   biết, nên revision mới cùng footage (đa số lần sửa) không hỏi lại; lỗi ag-go nhớ 30 s để poll không dồn; log khi một lần
   kiểm > 2 s.
3. `perf(web): the preview tab shows at once` — timeline và danh sách hiện ngay, player có khung chờ riêng và xin link cho
   bản đang chọn; tải về / Premiere xin link lúc bấm (giữ tự tải Premiere xong); link đã có giữ như hiện nay.

Mục tiêu: mở tab < 1 s (chỉ SQL); lần đầu player chờ đúng một lần hỏi ag-go cho một bản; lần sau tức thì.

## P4 — Chat

1. `feat(web): one suggested lesson, the rest on demand` — hiện 1 bài, "Xem tất cả (N)" / "Thu gọn" (mẫu `JobList`), khi mở
   có max-height và cuộn; `projectFingerprint` tính `lesson_proposals` để bài mới hiện ngay.
2. `feat(engine): a turn remembers the files it changed` — migration `0038`: `agent_messages.changed_files` (JSON
   `[{path, change: added|modified|deleted, version_id, added, removed}]`) ghi từ `scanWorkspace` sau lượt; số dòng +/− tính
   từ bản trước trong `project_file_versions` (chữ ≤ 1 MB, không thì bỏ số). `messageView` trả `changedFiles`.
3. `feat(api): what a version changed` — `GET projects/:id/files/versions/:versionId/diff`: so bản đó với bản ngay trước
   cùng đường dẫn, trả các khối thay đổi (dòng thêm/bớt + vài dòng ngữ cảnh); file nhị phân hoặc > 1 MB trả "không so được".
4. `feat(web): a turn's work folds into one line` — lượt xong: một dòng "Đã làm N bước · 1 phút 20 giây" (tổng =
   `finishedAt − startedAt`), **đóng sẵn**; mở ra thấy chữ trung gian + từng bước (`ToolChip` giữ nguyên, vẫn mở được
   input/kết quả). Câu trả lời cuối (chữ sau bước cuối) luôn hiện. Lượt đang chạy: dòng tổng có đồng hồ + bước đang chạy,
   Dừng. Việc nền của luồng (`ThreadJobs`, vd. chuẩn bị video) thành một dòng tóm tắt có tiến độ chung, mở ra xem từng việc.
5. `feat(web): changed files under each turn` — thẻ "N file đã thay đổi" dưới câu trả lời: đường dẫn, nhãn mới/sửa/xoá,
   +x −y, nút **Mở** (mở tab Tệp tại file như chip hiện nay) và **Xem thay đổi** (drawer diff: dòng thêm xanh, bớt đỏ,
   ngữ cảnh thu gọn); file đã xoá chỉ có Xem thay đổi. Lịch sử file (`FileHistory`) dùng chung diff: "So với bản trước".

## P5 — Tab Đầu vào

1. `feat(api): voice and music straight from the inputs tab` — `GET projects/:id/audio` trả thêm `enabled` (máy có
   ffmpeg) và các file audio dùng được (cả file trong `context/audio/` tải qua tab Tệp); ffprobe mặc định cạnh ffmpeg như
   worker; `POST …/audio/music/from-library {trackId}` chọn bài từ kho nhạc (`library:music/…`, không đổi schema); bỏ
   chọn nhạc cần editor (khớp chọn nhạc); audio tải lên tới 100 MB.
2. `feat(web): voice and music at the top of the inputs tab` — hai dòng gọn ở đầu tab:
   **Giọng đọc** [trạng thái] [Tải giọng mẫu · Chọn file đã tải · Không lời dẫn · Bỏ chọn];
   **Nhạc nền** [trạng thái] [Tải nhạc · Chọn từ kho nhạc (nghe thử) · Chọn file đã tải · Tự chọn theo mood].
   Tải xong dùng luôn (giọng vẫn hỏi nguồn gốc). Thiếu vai: nút mờ + tooltip "cần vai producer". Máy chưa có ffmpeg: báo
   trước, không mở modal. Lỗi tải: hiện lỗi, không biến mất.
3. `perf(api): sources list in one pass` — tính job chuẩn bị đang chạy một lần thay vì mỗi dòng; trả kèm số đếm theo trạng
   thái.
4. `feat(web): inputs tab for many projects and videos` —
   - thanh tóm tắt: "78 video · 70 sẵn sàng · 5 đang chuẩn bị · 3 lỗi"; việc nền một dòng;
   - hai mục con **Footage** | **Tài liệu, ảnh, audio** (có đếm, nhớ lựa chọn);
   - project ag-go: dòng gọn, ô tìm khi > 5, hiện 5 + "Xem tất cả";
   - video: ô tìm, lọc trạng thái (tất cả / chưa chuẩn bị / đang / lỗi / sẵn sàng); ở trang dự án gom theo video Studio
     (đếm + trạng thái chung, đóng/mở nhóm, bỏ trùng); hiện 30 dòng + "Xem thêm"; làm hàng loạt "Chuẩn bị các video chưa
     chuẩn bị", "Thử lại các video lỗi".

## P6 — Farm: thứ tự ưu tiên máy (repo ag-farm, chỉ hub)

1. `feat(api): nodes carry a priority order` — migration `1800000000000`: `farm_nodes.priority_order` (số nhỏ trước; mặc
   định theo thứ tự tạo); `PATCH admin/nodes/:id` nhận `priority_order`; `POST admin/nodes/reorder {ids}`; `GET admin/nodes`
   mặc định sắp theo thứ tự; `GET owner/nodes` trả theo thứ tự (không đổi schema, Studio /queue tự hiện đúng thứ tự).
2. `feat(api): earlier nodes claim first` — máy B xin việc: bỏ qua một job nếu có máy A xếp trước đang online, bật, trong
   lịch, nhận loại job đó, đủ `requirements` và còn slot trống (`free_slots` của heartbeat trừ job đã giao cho A từ lần
   heartbeat đó). Job chờ quá `NODE_PRIORITY_GRACE_SECONDS` (mặc định 10 s) thì máy nào cũng nhận, để không kẹt khi A chậm.
   Job ghim `node_id` giữ nguyên. Đọc `farm_nodes` một lần mỗi claim. Test DB: A rảnh → B không lấy; A bận / offline /
   tắt / không nhận loại đó → B lấy; quá grace → B lấy; claim đồng thời không trùng.
3. `feat(web): drag to order the farm's nodes` — cột "Thứ tự" + kéo thả (`DragSortTable` của pro-components đã có), hiện
   slot trống / job đang chạy; `docs/protocol.md` mục claim.

P6 chỉ cần hub + web farm (migration chạy qua `deploy.sh`), không cần phát hành lại worker.

## P7 — Worker tự cài, tự cập nhật, tự nhận loại job (ag-farm protocol/SDK/installer + hai worker)

1. `feat(installer): one setup that installs everything a role needs` — `setup-render.ps1` (trong gói worker, chạy cả
   lúc cài lẫn lúc cập nhật, chạy lại nhiều lần không sao): thiếu Python 3.11 thì tự cài (winget, không có thì bộ cài
   python.org chạy im lặng); venv ở `C:\ag-farm\venv`; máy có GPU NVIDIA thì torch CUDA + `requirements.txt`
   (OmniVoice, WhisperX); mọi máy render có **yt-dlp** trong venv (mỗi lần cập nhật nâng lên bản mới vì YouTube đổi
   thường xuyên); kiểm mã lỗi từng bước, kiểm `import torch, omnivoice, whisperx` + CUDA; `HF_HOME` riêng
   (`C:\ag-farm\models`, task chạy dưới SYSTEM) và tải trước model (OmniVoice, Whisper large-v3) để job đầu không chậm;
   ghi dấu (hash requirements + bản torch) nên lần sau không đổi gì thì bỏ qua pip, cập nhật nhanh. Log
   `C:\ag-farm\logs\setup.log`. Scan giữ phần Ollama đã có. Bỏ cờ `-WithTts` (tự quyết theo máy).
2. `feat(installer): an update rewrites the managed config` — cập nhật ghi lại `config.yaml`: giữ `name`, `token`,
   cache, khoá người tự thêm; viết lại các khoá Studio quản lý (`python_bin`, `ytdlp_bin`, `encoder`, `hf_home`…); bỏ danh
   sách `kinds` cứng (để worker tự tính). README hai worker bỏ hướng dẫn NSSM/venv tay cũ.
3. `feat(sdk): a worker takes every kind it can run` — `kinds` trong config thành tuỳ chọn; không khai thì worker báo mọi
   loại có handler **và** đủ điều kiện máy (GPU, Python, yt-dlp, NVENC theo `JOB_TYPE_SPECS`); capabilities dò lại sau mỗi
   lần cài/cập nhật; dò ffmpeg bằng bản kèm theo (`ffmpeg-static`), không phải PATH. Protocol: `engines.ytdlp` (tuỳ chọn)
   trong capabilities.
4. `feat(api): new job kinds are allowed unless blocked` — hub đổi `allowed_kinds` (danh sách cho phép) thành
   `blocked_kinds` (danh sách chặn; migration chuyển: chặn = đã báo − đã cho phép), nên loại job mới máy báo lên **tự**
   chạy; trang Máy: mỗi loại job một công tắc bật/tắt. Chủ job `studio` tự có loại mới qua migration như
   `1600000000000-studio-transcribe`.
5. `feat(sdk): workers update themselves` — worker xem `/dist/latest.json` mỗi 15 phút; có bản mới hơn của gói mình và
   hub cho phép (`GET /v1/worker/me` thêm `auto_update`, tuỳ chọn) thì ngừng nhận việc, chờ việc đang chạy xong (tối đa
   `update_drain_minutes`), rồi chạy task `ag-farm-updater` (SYSTEM, cài kèm lúc cài; cũng chạy hằng đêm làm dự phòng):
   dừng task worker → tải, kiểm sha256, thay `app` (giữ `app.prev`) → chạy setup (P7.1) → ghi config (P7.2) → bật lại;
   bản mới không heartbeat trong 3 phút thì **tự quay về `app.prev`**. Máy đang chạy bản cũ (0.8.1 / 0.3.5) cần chạy lệnh
   cập nhật **một lần cuối** bằng tay; từ đó tự cập nhật.
6. `feat(web): see and steer worker updates` — trang Máy: phiên bản đang chạy so với bản mới nhất (tag "cũ"), trạng thái
   cập nhật (đang chờ việc xong / đang cài / lỗi + dòng cuối `setup.log`), công tắc "Tự cập nhật" từng máy, nút "Cập nhật
   ngay"; báo thiếu gì (Python, CUDA, yt-dlp, NVENC) ngay trên dòng máy.
7. `feat(api): publish a worker release from the release script` — `POST /v1/admin/releases` (khoá admin) nhận zip +
   `latest.json` vào `FARM_RELEASES_DIR`; `release.mjs --publish --upload` đẩy thẳng lên hub, không còn scp tay. Cũ hơn
   bản đang có thì từ chối.

## P8 — Theo dõi tài nguyên máy farm (ag-farm protocol/SDK/hub/web)

1. `feat(sdk): measure the machine` — đo nền mỗi 15 s, không chặn heartbeat: CPU %, RAM dùng/tổng, ổ trống/tổng của ổ
   `work_dir` và cache, mạng vào/ra (byte/s, cộng các card đang chạy), GPU % / VRAM dùng / nhiệt độ (`nvidia-smi`), thời
   gian máy đã chạy. Số nào không đo được thì bỏ trường đó. Protocol: `metrics` **tuỳ chọn** trong heartbeat (hub mới nhận,
   worker cũ không gửi vẫn chạy).
2. `feat(api): keep machine readings` — `farm_nodes.metrics` + `metrics_at` (số mới nhất); bảng `farm_machine_metrics`
   (gộp node cùng `machine`, mỗi phút một dòng, giữ 7 ngày, reaper dọn); `GET /v1/admin/machines/:machine/metrics?range=1h|24h|7d`.
3. `feat(web): live machine health` — trang Máy: cột CPU, RAM, Ổ đĩa, Mạng ↓↑, GPU (thanh + số, vàng ≥ 80 %, đỏ ≥ 95 %;
   ổ trống < 20 GB đỏ), sắp xếp theo các cột này; bấm máy mở drawer biểu đồ 1 giờ / 24 giờ / 7 ngày (dùng lại
   `TimeSeriesChart` của trang thống kê); đầu trang báo gộp "2 máy sắp đầy ổ, 1 máy RAM > 90 %".

## P9 — Tải video mẫu qua máy farm (ag-farm protocol + ag-render-worker + Studio)

1. `feat(protocol): studio.reference_fetch` — loại job mới, lane `interactive`, slot cpu, cần `ytdlp`; payload:
   `video_id` (11 ký tự đã kiểm), giới hạn ≤ 480p / ≤ 30 phút / ≤ 300 MB, khoá ra
   `productions/<projectId>/jobs/reference_fetch/<jobId>/out/`; kết quả: khoá file, `duration_s`, `size_bytes`, tiêu đề,
   kênh; lỗi có mã (`youtube_blocked`, `unavailable`, `too_long`, …) như P2.1. Test protocol.
2. `feat: fetch a reference video for Studio` (ag-render-worker) — handler chạy yt-dlp của venv (P7.1) với **đúng** cờ
   của Studio (`--ignore-config --no-cookies`, ≤ 480p, JS runtime là Node của worker), đẩy file lên khoá ra rồi xoá bản
   trên máy. Máy có yt-dlp thì tự nhận loại job này (P7.3).
3. `feat(engine): reference videos come through the farm` — `style_watch`: có máy farm nhận `studio.reference_fetch` thì
   tải qua farm (ghi `project_farm_jobs`, hiện máy đang tải), không có thì yt-dlp trên máy Studio như cũ; tải bản từ
   bucket về thư mục nháp, đo, rồi **xoá cả object trên bucket lẫn file nháp** trong `finally`. Video bị chặn trên farm
   cũng báo mã như P2.1. ADR-0001 thêm một mục (video mẫu đi qua bucket tạm, xoá trong cùng job; vẫn không cookie, không
   đăng nhập).

## Triển khai

1. Studio P1–P5: như thường (merge `dev-duc` → `dev` → `main`, `deploy.sh`).
2. Farm hub P6–P9 lên trước (migration qua `deploy.sh`).
3. Phát hành render 0.9.0 + scan 0.4.0 (`release.mjs --publish --upload`); mỗi máy farm chạy lệnh cập nhật **một lần
   cuối**; từ đó máy tự cập nhật, tự cài.
4. Studio phần P9 sau cùng.

## Để sau

- Job claim xong mà máy hết slot (`no_slot`) trả về hàng đợi **không tốn lượt thử** (Studio chỉ cho 2 lượt); long-poll
  thay cho poll 1 s; claim nhiều job một lần. (Đổi SDK — có thể gộp vào đợt phát hành P7 nếu anh muốn.)
- Hub tránh giao việc cho máy sắp đầy ổ / RAM quá tải (dựa trên số đo P8); tình trạng máy trên màn Hàng đợi của Studio.
- ag-go: endpoint chỉ kiểm quyền (không ký URL, không HEAD R2) để lần kiểm đầu của tab Xem trước nhẹ hơn.
- Dán link audio làm giọng/nhạc (engine đã có `fetchAudioUrl`), giọng thiết kế (`design`) cho dự án.
- Trang "Tất cả dự án" cho admin (đã chốt: chưa cần).
