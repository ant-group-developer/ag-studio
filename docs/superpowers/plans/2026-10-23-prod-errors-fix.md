# Sửa các lỗi chính tìm thấy trong dữ liệu prod (2026-10-23)

Nguồn: snapshot prod ngày 2026-10-23 (`E:\prod-snapshot`, DB `ag_studio_prod` / `ag_farm_prod` trong `postgres16`), dữ
liệu 11/10–23/10. Chưa sửa code. Mỗi phase một hoặc vài commit trên `dev-duc`, **không push** cho tới khi người dùng bảo.

Bản cập nhật 2026-10-23 (lần 2): đã rà các session từ 19/10 và git log 4 repo; gộp lỗi của session "Kiểm tra lỗi" (P3);
thêm nguyên nhân tự cập nhật vào phần lease (P5). Lần 3: đọc lại logic hiển thị project và quyền tải bản gốc ở ag-go (main
và dev) và Studio; thiết kế lại P3 theo các điểm người dùng đã chốt (chọn theo quyền tải bản gốc, project thêm vào là đóng
góp).

## Tiến độ (2026-10-23, trên `dev-duc`, chưa push)

| Phase | Commit | Kiểm |
|---|---|---|
| P1 | ag-studio `624a465` | engine 367 test |
| P2 | ag-studio `db86e3f` | engine 369 test |
| P3a | ag-studio `caf3271` | web `InputsPanel` 17 test, i18n; chưa thử trên trình duyệt (local stack tắt) |
| P6 | ag-studio `3c64cb8` (core), ag-render-worker `1fef30f` | core render 45 test, worker 164 test |
| P5b, P5d | ag-farm `11f28d9`, `c1780a2` | worker-sdk 94 test |
| P4 | ag-studio `f5d2a8e` (migration `0003`, đã chạy thử trên bản sao DB prod rồi rollback) | engine, web chat 27 test, API 162 test |
| P3b, P3c | chưa làm | |
| P5a, P5c | việc của người dùng (ffmpeg 8.1 trên 7 máy, log AG-186) | |

Phát hành: render worker và scan worker cần bản mới có worker-sdk P5b/P5d (render worker thêm P6); chưa nâng version, chưa
build.

## Trạng thái: các session khác đã sửa gì

Từ 19/10, git log 4 repo (ag-studio, ag-farm, ag-render-worker, ag-scan-worker, kể cả nhánh và worktree) **không có commit
nào sửa 5 lỗi chính**. Những gì đã sửa và đã lên prod (Studio, farm, worker cập nhật 22/10 khoảng 14:10 giờ VN; worker 0.14.4
ngày 23/10):

| Lỗi trên prod | Sửa ở đâu | Đã lên prod | Dữ liệu sau khi lên |
|---|---|---|---|
| "Error initializing complex filters" (18 lần): clip lấy từ video không có tiếng | session "Fix render failing at mezzanine 0": ag-studio `bf5c7c7`, `96be120`; worker `d93445e` (0.14.1) | có | lần cuối 22/10 01:59 UTC, trước khi lên |
| Xin ký quá 100 thao tác (`ops` too_big, 4 lần) | cùng session: ag-farm `e656397` (worker-sdk chia lô) | có (worker ≥ 0.14.1) | lần cuối 22/10 01:52 UTC |
| Thanh tiến độ đứng ở 95% lúc upload, người dùng bấm dừng tưởng treo (job `63077732`) | session "Tìm chỗ nghẽn…": worker `ceb9078` (0.14.3) | có | — |
| Hết RAM ở lần encode cuối (ffmpeg 6.1 đỉnh ~29 GB) | render-speed: 0.14.4 chia theo đầu vào; ffmpeg 8.1 chỉ mới cài trên AG-189 | một phần | AG-189: 14–16 GB, 573 s |

Các lỗi trong plan này **chưa ai sửa**: P1 (hỏi farm lỗi một lần là hỏng job), P2 (survey), P3 (chủ dự án không thấy
video: session "Kiểm tra lỗi" dừng ở câu hỏi chọn hướng, chưa sửa gì), P4 (lượt agent hết giờ), P5b (tự cập nhật khi đang
giữ job: session "Tìm chỗ nghẽn…" ghi nhận nhưng "chưa đào tiếp"), P5d (thư mục `locks`), P6 (CPU retry khi hết giờ).

## Tổng quan

| Phase | Lỗi | Số lần trên prod | Repo | Deploy |
|---|---|---|---|---|
| P1 | Studio bỏ job khi một lần hỏi farm bị timeout | 5 job (20/10), 1 bản cuối render xong bị bỏ | ag-studio | Studio |
| P2 | `timeline_from_edit_plan` chạy trước khi có `survey.json` | 14 job fit | ag-studio | Studio |
| P3 | Thêm project ag-go: "Chủ dự án không thấy video"; chọn theo quyền tải bản gốc, nguồn là đóng góp | **653 lần**, 101 project ag-go | ag-studio + ag-go (api, web) | P3a: Studio; P3b: ag-go; P3c: Studio sau ag-go |
| P4 | Lượt agent hết 20 phút giữa chừng | 7 lượt (+6 chạm 40 bước) | ag-studio | Studio |
| P5 | render_final mất lease / hết RAM | 6 hết RAM, 4 hết lease | máy farm, ag-farm worker-sdk | release worker |
| P6 | CPU retry khi đã hết thời gian render ("timed out after 1s") | 3 job | ag-studio core + ag-render-worker | release worker |

Gộp deploy: **đợt Studio 1** = P1 + P2 + P3a + P4. **Đợt worker** = P5b + P5d + P6 (render worker 0.14.5 và scan worker
0.5.1, theo thứ tự farm → worker → Studio). **Đợt ag-go** = P3b (cùng lúc bản dev lên prod). **Đợt Studio 2** = P3c + script
chuyển dữ liệu, sau đợt ag-go. P5a là cấu hình máy, làm ngay được.

Thứ tự làm: P1 → P2 → P3a → P6 → P5b/P5d → P4 → P3b → P3c. P5c chờ log máy.

---

## P1 — Studio không bỏ job farm vì một lần hỏi lỗi

**Bằng chứng.** 20/10 06:29:39–41 UTC năm job (4 render_final, 1 render_preview) cùng hỏng với "The operation was aborted
due to timeout". Trên farm: bản render_final `a8b4e866` vẫn chạy xong (08:04) nhưng Studio đã bỏ; 3 bản khác chạy tiếp vô ích
khoảng 1 giờ. Session "Tìm chỗ nghẽn…" xác nhận: Studio chỉ huỷ job farm đang chạy khi có người bấm dừng, nên các job này
không bị huỷ trên farm.

**Nguyên nhân.** `runFarmStep` (`packages/studio-engine/src/workspace/farm.ts:173`) gọi `d.farm.getJob()` không bắt lỗi;
owner-client của farm hết chờ sau 10 s (`AbortSignal.timeout`, `ag-farm/packages/owner-client/src/client.ts:81`) là ném ra,
job Studio hỏng ngay.

**Sửa.**
- Trong vòng chờ, lỗi tạm (mạng, timeout, HTTP 5xx/429) của `getJob` không làm hỏng job: thử lại với giãn cách tăng dần
  (3 s → 30 s); phase hiện "Mất liên lạc với farm, đang thử lại".
- Mất liên lạc liên tục quá 15 phút mới hỏng, lỗi nói rõ ("không hỏi được farm trong 15 phút: …"), và huỷ việc trên farm
  (best effort) để máy không render vô ích.
- Lỗi 4xx thật (404 job không còn, 401 khoá sai) vẫn hỏng ngay. Dừng (Stop) vẫn được kiểm mỗi vòng.

**Test.** farm giả: `getJob` ném timeout 2 lần rồi trả `completed` → job xong; ném liên tục quá giới hạn (đồng hồ giả) →
job hỏng với lỗi mới và `cancelJob` được gọi; 404 → hỏng ngay.

## P2 — Kiểm survey trước khi dựng timeline

**Bằng chứng.** 14/14 job `fit` hỏng vì "survey.json thiếu hoặc sai" (3 lần ngày 23/10) đều được tạo 1–14 phút **trước**
phiên bản đầu tiên của `survey.json` (`project_file_versions`); sau đó agent viết survey và chạy lại được. 40/40 survey trên
prod hiện hợp lệ.

**Sửa.**
- Tool `timeline_from_edit_plan` (`agent/timeline-tools.ts:142`) kiểm `videos/<id>/survey.json` (có, đọc được,
  `StudioSurveySchema`) và `edit-plan.json` (có) **trước** khi tạo job; thiếu/sai thì trả `isError` ngay cho agent, kèm tối
  đa 3 lỗi zod (đường dẫn + thông báo) và "chạy skill scene-selection / validate_file trước". Không tạo job hỏng.
- `fit.ts:227` (nút bấm trên web vẫn đi qua đây): lỗi kèm 3 lỗi zod đầu thay vì chỉ "thiếu hoặc sai".
- Mô tả tool thêm: "chỉ gọi khi survey.json và edit-plan.json đã qua validate_file".

**Test.** Tool: không survey → isError, không có job; survey sai → isError có đường dẫn lỗi; đủ → job như cũ. fit: lỗi có
chi tiết zod.

## P3 — Chọn project ag-go theo quyền tải bản gốc, project thêm vào là "đóng góp" (gộp từ session "Kiểm tra lỗi")

**Bằng chứng.**
- `audit_log` prod: `InputsController.add` (kind `ag_go_project`) hỏng **653 lần** từ 16/10 tới 23/10 (thành công 846 lần),
  trên 101 project ag-go; 30 project chưa lần nào thêm được. Ví dụ "testtl" 252 lần, "Ninh bình" 128 lần (thêm cả loạt 40
  project một lần).
- Ở cả 653 lần, người bấm **chính là chủ dự án Studio** (trên prod, 837/837 lần thêm project ag-go và 431/439 tin nhắn là
  của chủ dự án). Vậy lỗi chính nằm ở chỗ hai API của ag-go tính quyền khác nhau.
- Session "Kiểm tra lỗi" (20–21/10) đã xác minh trên DB ag-go prod với 6 project thư mục `PHƯƠNG LY / … / khu myongdong`:
  video đều đã phân tích và dùng được; chủ dự án chỉ có quyền danh mục "Khám phá", không có quyền thư mục nào.
- Thông báo hiện tại ("Chủ dự án không thấy video nào trong project ANT Go này") không nói lý do, không nói phải làm gì,
  nên người dùng bấm lại nhiều lần.

### Logic hiện tại (đọc code 2026-10-23)

ag-go có hai bản: **prod** = `origin/main` (19/10, `folder_access_grants` + `category_access_grants`) và **dev** =
`origin/dev` (22/10, sắp lên prod: `access_grants` thư mục × danh mục, `original_access_bundles`, quyền `go.project.read_all`).
Plan này nhắm bản **dev**.

| Bước | Hỏi bằng ai | ag-go prod (main) | ag-go dev |
|---|---|---|---|
| Picker liệt kê project (`GET /projects?scope=evaluated`, web gọi thẳng ag-go) | **người mở picker** | project đã đánh giá + (admin, hoặc **quyền danh mục**, hoặc quyền thư mục) | project đã đánh giá + (`read_all`, hoặc **chủ project ag-go**, hoặc **bundle**, hoặc quyền làm việc ≥ viewer); mỗi project kèm `canSeeOriginals` |
| Thêm, tìm footage, chuẩn bị, render (`/footage/search`, `/facets`, `/assets/resolve`, `/assets/prep`) | **chủ dự án Studio** (service key + `X-Act-As-User`; ag-go nạp `user_type` + quyền từ Account API) | admin, hoặc **quyền thư mục** | admin, hoặc **quyền làm việc ≥ viewer**. `read_all`, bundle, chủ project ag-go **không** được tính |
| Bản cuối dùng file gốc hay bản xem trước (`resolveAssets`, `footage.service.ts:529`) | chủ dự án Studio | gốc khi admin / `go.project.evaluate` / `go.project.download_original` (không xét project) | như prod |
| Nút "Tải bản gốc" của ag-go (`downloads.service.ts:71`, `:326`) | người bấm | — | admin hoặc `go.project.download_original`, **và** `canSeeOriginals` (chủ project, bundle khi đã đánh giá, hoặc quyền làm việc ≥ viewer) |
| Link tải bản xuất Premiere của Studio (`video-media.controller.ts:169`) | người bấm | quyền footage của chính người bấm phủ mọi video | như prod |

Khe hở: (K1) ag-go tự lệch: picker rộng hơn tìm footage, cả ở prod lẫn dev, nên lên bản dev không hết lỗi; (K2) Studio lệch
người: picker theo người mở, mọi việc sau đó theo chủ dự án; (K3) file gốc khi render chỉ xét quyền vai trò, không xét
project, và Studio không báo trước khi bản cuối ra từ bản xem trước; (K4) Studio chỉ kiểm "có ≥ 1 video", project chưa phân
tích và project không có quyền ra cùng một lỗi.

### Đã chốt với người dùng (2026-10-23)

1. ag-go bản dev sắp lên prod: sửa ag-go làm trên `dev-duc` của ag-go-api / ag-go-web, không vá main.
2. Picker chỉ cho **tick project mà người mở picker có quyền tải bản gốc**; project không có quyền thì vẫn hiện, **mờ, kèm lý
   do**.
3. Project thêm vào là **đóng góp** của người thêm (như đóng góp file vào thư mục chung trên Drive): việc tìm cảnh, chuẩn bị,
   render của dự án dùng quyền của lần đóng góp đó, không dùng quyền chủ dự án. **Người thêm rời team hoặc mất quyền thì các
   project đã thêm vẫn dùng được.**
4. Luật chung của ag-go: footage tìm được = project được xem bản gốc (áp cho mọi người, cả trang tìm footage của ag-go).
5. Nguồn đã thêm từ trước mà không có bản gốc: **giữ, gắn nhãn**; bản cuối: **báo trước** khi render từ bản xem trước.

### Thiết kế

"Có quyền tải bản gốc" = luật nút "Tải bản gốc" của ag-go: admin hoặc `go.project.download_original`, và `canSeeOriginals`
của project. Vì quyền của người thêm có thể mất sau này, ag-go **ghi lại lần đóng góp** và dựa vào bản ghi đó, không hỏi lại
quyền của người thêm mỗi lần. ag-go vẫn là nơi giữ sự thật: Studio không tự cho mình quyền.

**P3a — Studio, làm ngay (không chờ ag-go).**
- Nút Thêm khoá trong lúc đang thêm; thêm nhiều project một lần thì một hộp liệt kê các project hỏng, không lặp thông báo.
- Thông báo lỗi nói rõ: quyền tìm footage cho Studio cần quyền **thư mục** (prod) / quyền làm việc (dev) trên ANT Go, quyền
  danh mục hay "xem tất cả" không đủ; project chưa có video đã phân tích cũng ra lỗi này
  (`inputs.controller.ts:170`, `AgGoProjectDrawer.tsx:104`, `ws.vi.ts` / `ws.en.ts`).

**P3b — ag-go (`dev-duc` của ag-go-api, ag-go-web).**
- Bảng `studio_contributions`: `studio_project_id`, `project_id` (project ag-go) hoặc `asset_id`, `contributed_by`,
  `originals` (bool), `created_at`, `revoked_at` / `revoked_by`. Duy nhất theo (dự án Studio, project) và (dự án Studio, asset).
- `POST /footage/contributions` (service key, `X-Act-As-User` = người thêm): với mỗi project / asset, kiểm người thêm có quyền
  tải bản gốc (luật trên; asset theo các project chứa nó) → ghi lần đóng góp `originals = true`, trả số video đã phân tích.
  Không đủ quyền thì từ chối kèm lý do (`no_originals_role`, `no_project_access`, `not_evaluated`, `no_analysed_videos`).
  Cờ `legacy` cho bước chuyển dữ liệu cũ: ghi cả khi không có quyền gốc (`originals = false`).
- `DELETE /footage/contributions` khi Studio gỡ nguồn.
- Các endpoint footage Studio dùng (`search`, `facets`, `assets/resolve`, `assets/prep`, `assets/prep/run`,
  `assets/:id/media`) nhận header `X-Studio-Project`: phạm vi = các project / asset đã đóng góp cho dự án đó, chưa thu hồi,
  không xét quyền người dùng; `X-Act-As-User` vẫn gửi để ghi nhật ký ai làm. `resolveAssets`: lần đóng góp `originals =
  true` → file gốc (bản cuối) / proxy (xem trước); `false` → bản xem trước tốt nhất, như hiện nay.
- Luật chung (đã chốt mục 4): `buildVisibleProjectsCte` (`footage-scope.service.ts:64`) dùng chủ project ag-go hoặc
  `originalsReachProjectSql` (bundle khi đã đánh giá, hoặc quyền làm việc ≥ viewer) thay cho chỉ quyền làm việc.
- `GET /projects` thêm `canDownloadOriginals` cho mỗi project (quyền vai trò và `canSeeOriginals` của người gọi), để Studio
  không tự ghép luật.
- Test: đóng góp được / bị từ chối theo từng lý do; người thêm mất quyền sau đó → `search` / `resolve` với
  `X-Studio-Project` vẫn chạy; thu hồi → hết; `originals = false` → bản xem trước.

**P3c — Studio, sau khi ag-go P3b lên.**
- Picker (`AgGoProjectDrawer`): tick được khi `canDownloadOriginals`; project khác hiện mờ, không tick được, kèm lý do ("Bạn
  không có quyền tải bản gốc project này trên ANT Go"); hiện số video đã phân tích.
- Thêm project / video (`inputs.controller.ts` `add`, picker video `AgGoPickers`): gọi `POST /footage/contributions` bằng
  quyền **người thêm**; lưu nguồn như cũ (`added_by`). Gỡ nguồn → `DELETE`.
- Mọi chỗ đang gọi ag-go bằng quyền chủ dự án (`projectActAs`) chuyển sang `X-Studio-Project` + người đang làm:
  `agent/input-tools.ts` (footage_search, inputs_add), `inputs.controller.ts` (`nameUnnamed`), `workspace/prepare.ts`,
  `media-deps.ts` / `farm/farm.controller.ts` (ký link render), `project-footage.service.ts`, `apps/worker/src/main.ts`.
- Nhãn: nguồn có lần đóng góp `originals = false` hiện "Không có bản gốc, bản cuối render từ bản xem trước" ở tab Đầu vào;
  hộp Render bản cuối báo trước khi timeline dùng nguồn như vậy (vẫn cho render).
- Chuyển dữ liệu cũ: script gọi `POST /footage/contributions` (`legacy`) cho mọi nguồn `ag_go_project` / `ag_go_asset` hiện có
  (prod: 837 + 3141), người đóng góp = `added_by`; ghi lại project nào ra `originals = false`.
- Không đổi: link tải bản xuất Premiere (file footage thô) vẫn cần quyền của chính người bấm.
- Test: picker mờ / tick theo cờ; thêm bằng thành viên không phải chủ → nguồn dùng được; người thêm bị xoá khỏi team → agent
  vẫn tìm và render được; nhãn và cảnh báo bản cuối; script chuyển dữ liệu chạy lại không tạo trùng.

**Deploy:** P3a theo đợt Studio. P3b: ag-go (dev → main → prod) trước. P3c + chạy script chuyển dữ liệu: deploy Studio sau
khi ag-go có P3b.

**Còn để ngỏ (có mặc định, đổi được khi review):** ai thu hồi được một lần đóng góp (mặc định: admin ag-go qua API, chưa có
giao diện); bản ghi đóng góp có hiện ở ag-go không (mặc định: chưa).

## P4 — Lượt agent hết giờ

**Bằng chứng.** 7 lượt hỏng "timeout" (đủ 20 phút) trong 22–23/10, thêm 6 lượt chạm 40 bước (`max_turns`). Cả 7 lượt làm cả
quy trình một video trong một lượt: tìm footage → thêm/chuẩn bị đầu vào → đọc trung bình ~32 tờ ghép
(`inputs/<asset>/sheets/NN.jpg`) và ~9 khung → survey → edit-plan → timeline. Hết giờ thì lượt bị đánh `failed`, việc dở
không ai làm tiếp cho tới khi người dùng nhắn. Không session nào khác đụng tới phần này.

**Sửa.**
- **a. Hết giờ thì tự làm tiếp** (`agent/runner.ts`): lượt hết giờ vẫn giữ phần đã làm (file đã ghi được quét như hiện nay),
  tin nhắn hiện "Hết 20 phút, đang làm tiếp" thay vì lỗi. Nếu dự án bật `auto_continue` và chưa quá `AUTO_TURNS_IN_A_ROW`
  lượt tự chạy liên tiếp, xếp một lượt mới tiếp tục **cùng session Claude**, với lời nhắn hệ thống "Lượt trước hết giờ giữa
  chừng; các file đã ghi vẫn còn; làm tiếp từ chỗ dừng, đừng làm lại phần đã xong". Cần thêm giá trị `trigger` mới
  (`timeout`), nên có migration `0003` mở rộng CHECK của `agent_messages.trigger`.
- **b. Skill scene-selection** (`agent-skills/scene-selection/SKILL.md`): ghi `scenes.md` / `survey.json` dần sau mỗi nguồn
  (không đợi xem hết mới ghi), để lượt bị cắt không mất phần đã xem; video nhiều nguồn thì xem tờ ghép trước, chỉ mở khung
  khi phân vân.
- **c. (Tuỳ chọn, chỉ cấu hình)** `STUDIO_AGENT_TURN_MINUTES=30` trong `.env` prod.

**Test.** runner với CLI giả (`@fake` timeout): lượt hết giờ → lượt tiếp theo `trigger = timeout` được xếp, cùng session;
tắt `auto_continue` hoặc đã đủ số lượt tự chạy → không xếp. Migration: PGlite chấp nhận `timeout`.

## P5 — render_final mất lease / hết RAM trên máy farm

**Bằng chứng.**
- Từ 20/10: 6 lần hết RAM khi encode lần cuối trên máy 32 GB ("Cannot allocate memory", "malloc failed", "get_buffer()
  failed"); 4 lần "Lease expired, no more retries".
- 22/10 (session "Fix render failing…"): lần thử 2 của `44882d6d` trên AG-186 hết lease **đúng lúc máy tự cập nhật lên
  0.14.2 trong khi đang giữ job**. Code: bộ cập nhật (`ag-farm/packages/worker-sdk/src/self-update.ts:185–191`) ngừng nhận
  việc rồi chờ việc đang chạy tối đa `update_drain_minutes` (mặc định 30 phút), hết 30 phút thì cập nhật luôn dù job còn
  chạy. Một bản cuối 4K chạy 40–60 phút nên chắc chắn bị cắt.
- 23/10 (session "Tìm chỗ nghẽn…"): bản đo `15915af4` trên AG-186 hết lease cả 2 lần thử khi đang tải nguồn chỉ ~2,9 MB/s,
  CPU 9–10%. Không trùng lúc cập nhật (máy lên 0.14.4 lúc 03:03 UTC). Chưa rõ nguyên nhân, cần log.

**Làm.**
- **a. Cấu hình (người dùng làm, tôi đưa lệnh):** đặt `FFMPEG_PATH` → ffmpeg 8.1 trên cả 7 máy render như AG-189, khởi động
  lại worker. Không đổi code.
- **b. Không tự cập nhật khi đang render** (ag-farm worker-sdk): khi đang có job, chờ tới khi xong; giới hạn chờ lấy theo
  thời hạn của job đang chạy (hoặc mặc định 4 giờ thay vì 30 phút). Nếu buộc phải cập nhật, báo `fail` job với lỗi
  `retryable` ("máy cập nhật") để hub giao lại ngay, thay vì để lease hết hạn.
- **c. Chẩn đoán lần 23/10:** cần `C:\ag-farm\render\logs\worker.log` của AG-186 quanh 23/10 10:15–12:00 giờ VN (03:15–05:00
  UTC). Chỉ viết code khi đã rõ nguyên nhân (gửi tiến độ lỗi vì mạng, vòng lặp bị chặn, hay hai lần thử chồng nhau vì job ghim
  vào AG-186).
- **d. (Đi kèm, nhỏ) Thư mục `locks` của cache bị xoá:** 23/10 15:16–15:28 giờ VN, 11 job scan trên AG-193-scan và
  AG-198-scan hỏng "ENOENT … cache\scan\locks\….lock". worker-sdk chỉ tạo `locks` lúc khởi động
  (`worker-sdk/src/cache.ts:33`), dọn cache mà xoá luôn thư mục thì mọi lần tải lỗi tới khi khởi động lại (session scan-worker
  13/10 đã cảnh báo điều này). Sửa: tạo lại thư mục trước khi mở file lock (`cache.ts:75`). Cần release scan worker 0.5.1
  và render worker.

**Test.** worker-sdk: đang có job → không cập nhật dù quá 30 phút; buộc cập nhật → job được `fail` retryable; cache: xoá
`locks` giữa chừng → lần tải sau vẫn chạy.

## P6 — Ngân sách thời gian render và CPU retry

**Bằng chứng.** "final encode (cpu retry): ffmpeg timed out after 1s and was killed" (20/10, 2 job), "…after 610 s" và
"…after 1550 s": các job này đều kết thúc ở phút 60–62. Không session nào khác sửa phần này.

**Nguyên nhân.** Worker đưa `ffmpeg_timeout_s` (mặc định 3600) làm **ngân sách cả lần render** (`timeoutSeconds` →
`deadlineMs`, `packages/core/src/media/render/run.ts:414`). Encode cuối bằng NVENC hết giờ thì bị coi là "NVENC hỏng", chạy
lại bằng CPU với phần còn lại `Math.max(1, …)` = 1 s, rồi báo một lỗi gây hiểu nhầm. Từ 0.14.4, các đoạn chia theo đầu vào
cũng dùng `remaining()` nên vẫn dính.

**Sửa.**
- `run.ts`: không chạy lại bằng CPU (encode cuối, từng đoạn và mezzanine) khi lỗi NVENC là hết giờ, hoặc khi ngân sách còn
  dưới 5 phút. Lỗi khi đó nói thẳng: "hết thời gian render (60 phút) ở bước final encode".
- ag-render-worker: tách ngân sách cả lần render (`render_budget_s`, mặc định 3 giờ cho render_final, 1 giờ cho preview)
  khỏi `ffmpeg_timeout_s`; ghi vào README và `deploy/config.example.yaml`.

**Test.** `run.test.ts`: spawn giả hết giờ ở NVENC → không có lần chạy CPU, lỗi nói "hết thời gian"; NVENC lỗi thật khi còn
nhiều thời gian → vẫn chạy lại bằng CPU như cũ. Worker: ngân sách theo loại job.

---

## Cần người dùng quyết

1. **P3:** các điểm chính đã chốt (mục "Đã chốt với người dùng"). Còn: ai thu hồi được một lần đóng góp và có hiện danh
   sách đóng góp ở ag-go không (mặc định: admin ag-go qua API, chưa có giao diện).
2. **P4a:** hết giờ thì agent tự làm tiếp (cùng session, tính vào giới hạn 3 lượt tự chạy liên tiếp)? Có tăng lên 30 phút
   (P4c) không?
3. **P5a:** đưa ffmpeg 8.1 lên cả 7 máy render ngay? **P5c:** lấy được log worker của AG-186 không?
4. **P5b / P6:** chờ job xong mới cập nhật tối đa 4 giờ, và ngân sách render_final mặc định 3 giờ, có ổn không?

## Kiểm tra sau cùng

`pnpm build`, `pnpm -r typecheck`, `pnpm test` ở ag-studio; `yarn test`, `yarn typecheck` ở ag-render-worker và ag-farm
(P5b, P5d, P6); test và typecheck của ag-go-api, ag-go-web (P3b), thử P3c trên local stack với một thành viên không phải
chủ dự án; `scripts/repro-render.mjs` một video prod (đã chạy được với `04e9473f/b5c409f5`) sau P6. Sau deploy: truy
vấn lại `project_jobs`, `farm_jobs`, `audit_log` trên prod để xem các lỗi trên còn xuất hiện không.
