# Plan pha 6: xuất CapCut

Spec: `docs/superpowers/specs/2026-10-06-ag-studio-local-chat-design.md` (mục 3.5; bảng pha, dòng 6).
Nhánh: `feat/local-phase-6-capcut`, tách từ `feat/local-phase-5-cut` (pha 5 **chưa merge**, đang kiểm cuối). Mỗi task một
commit, test viết trước. Số dành riêng: migration `0028`–`0029`, ADR-0001 mục `161`–`166` (pha 5 giữ `0025`–`0027` và
mục `160`).

**Xong khi** (bảng pha): mở draft trong CapCut thấy đúng clip, thứ tự, chữ, nhạc. Plan này thêm: đúng điểm in/out của
clip cắt theo shot, lời dẫn, tiếng gốc tắt/bật đúng như bản render.

**Ràng buộc trong lúc pha 5 còn mở:**
- Không dùng stack local (`scripts/local-stack.mjs`, cổng 3738/3010/3100/3101) tới khi người dùng báo. Chỉ unit test và
  test tích hợp trong tiến trình (Claude giả, farm giả, bucket giả).
- Pha 5 còn đổi v4 thì phải rebase: **chỉ một file đọc composition** (`capcut/plan.ts`, nhóm A); phần ghi định dạng
  CapCut, installer, API, web không import `Composition` hay timeline.
- `E:\CODE\ag-farm` (nhánh `feat/studio-phase-5-cut`, có file đang sửa) và `E:\CODE\ag-render-worker*` đang thuộc phiên
  pha 4/5: việc ở đó (nhóm T) làm trong worktree riêng, xem T0.

## Hiện trạng (đã kiểm, 2026-10-07)

**CapCut trên máy dev:** `%LOCALAPPDATA%\CapCut\Apps\9.5.0.4050` (còn 9.2.0.3931). Draft ở
`%LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft\<tên>\`, chỉ mục `root_meta_info.json` cạnh đó. Có ba draft:
`0820` (9.2.0), `0928` và `0929` (9.5.0).
- `draft_content.json` là **JSON thường** (không mã hoá), `version: 360000`, `new_version: "187.0.0"` (9.5.0; 9.2.0 là
  `181.0.0`), `last_modified_platform.app_version`. Thời gian bằng **micro giây** (số nguyên). `fps: 30`,
  `canvas_config {ratio:"original", width, height}`.
- `tracks[] {id, type: video|text|…, segments[], flag, attribute, name, is_default_name}`. Segment:
  `material_id`, `source_timerange {start, duration}` (trên file nguồn), `target_timerange` (trên trục), `speed`,
  `volume` (tuyến tính, 1 = 0 dB), `clip {scale, rotation, transform{x,y}, flip, alpha}` (`transform.y = -0.8` là gần đáy),
  `extra_material_refs[]` (6 id cho một clip video: speed, canvas, placeholder, sound channel mapping, material color,
  vocal separation), `render_index`, `track_render_index` và ~50 khoá khác.
- `materials.videos[]`: `path` **tuyệt đối** dạng `C:/…` (gạch chéo xuôi), `duration` µs, `width`, `height`,
  `material_name`, `local_material_id`, `has_audio`. `materials.texts[]`: `content` là chuỗi JSON
  `{text, styles:[{fill, font{path:"C:/WINDOWS/Fonts/arial.ttf"}, size, range}]}`.
- `draft_meta_info.json`: `draft_fold_path`, `draft_root_path` **tuyệt đối**, `draft_id`, `draft_name`,
  `draft_materials[{type, value[{file_Path, duration, width, height, md5, …}]}]`.
- Mỗi draft 9.5.0 còn có `Timelines/<uuid>/draft_content.json` (bản sao của `draft_content.json` gốc),
  `Timelines/project.json`, `draft_settings`, `draft_virtual_store.json`, `key_value.json`, `common_attachment/*`,
  `attachment_*.json`, `*.bak`, `template*.tmp`. Chưa rõ cái nào **bắt buộc** khi CapCut mở một draft lạ (A0).
- **Chưa có mẫu** của: track audio, nhạc có âm lượng/fade/keyframe, chuyển cảnh, clip cắt in/out, tiếng gốc tắt. Không
  draft nào dùng `##_draftpath_placeholder_…##`.

**Xuất Premiere (mẫu để làm theo):**
- API `POST productions/:id/episodes/:episodeId/exports/premiere {media: proxy|original}`
  (`apps/api/src/studio/timeline.controller.ts:173`); `original` cần `mayDownloadOriginals`, không thì 403.
- `startPremiereExport` (`packages/studio-engine/src/editor.ts:192`): lấy revision mới nhất, đẩy
  `timelineToComposition(rev.data)` lên `productions/<p>/jobs/editor-premiere/<id>/in/composition.json`, gửi job
  `studio.export_premiere`, ghi `episode_jobs` (kind `CHECK IN ('render_preview','export_premiere')`,
  `migrations/0011_series.sql:61`) và `studio_farm_jobs` (`stage_key = 'editor-premiere'`, `is_final_render` = media gốc —
  `/api/farm/sign` dùng cờ này chọn `final`/`preview`).
- `pollEpisodeJob` (`editor.ts:131`) đọc manifest `premiere.json` khi job xong; web nhận URL ký.
- Render worker `src/premiere-handler.ts`: tải từng `asset:` vào `media/NN-<slug>.mp4`, nhạc vào `media/music.<ext>`,
  ffprobe, chữ thành PNG, ghi XML, zip (yazl, zip64, không nén) gồm `project.xml`, `README.txt`, `media/`, `overlays/`.
- Protocol ở `E:\CODE\ag-farm\packages\protocol\src\jobs\studio.ts:145-199` (payload, manifest
  `ag.studio.premiere/v1`), `registry.ts:61` (lane interactive, slot cpu), `enroll.ts:15`, `common.ts:9`,
  `protocol.spec.ts:167`.
- Web: `modules/production/PremiereExports.tsx`, ẩn với tập cắt ở `EpisodesPanel.tsx:222`, `EpisodeDrawer.tsx:299`,
  `modules/chat/ResultPane.tsx:142`.
- **Bẫy:** `@ag-studio/render` của render worker link tới `../ag-studio/packages/render` (checkout chính, đang detached
  ở `555f911`), không phải worktree này. Thử handler CapCut với code pha 6 cần trỏ link sang `ag-studio-p6` (T2).

**Hợp đồng đọc:** `harness.composition/v1` (`packages/contracts/src/composition.ts:155`), chú thích hợp đồng ở
`packages/contracts/src/studio.ts:568`: `segments[].in/out` là giây trên file nguồn, `transition_out` đã giải
`tail_available`, `narration[].wav` là `stage:voice/<line_id>.wav` với `start/end` trên trục, `captions.cues` và
`text_events` có mốc tuyệt đối. Composition của Studio luôn có `brand: null`, `logo: null`; nhạc có `loop`, `fade_in`,
`fade_out`, `cues[].gain_db`, `duck.windows`.

## Quyết định đã chốt (người dùng, 2026-10-07)

- **Q1. Chạy ở farm:** loại job mới `studio.export_capcut` (đổi hợp đồng ag-farm, đã được đồng ý). Phần đọc composition
  và phần ghi JSON là hàm thuần trong repo này, export qua `@ag-studio/render`; render worker chỉ tải media, gọi hàm ghi,
  đóng zip. Zip **kèm media** (proxy hoặc gốc, như Premiere).
- **Q2. Đường dẫn tuyệt đối:** zip kèm **script cài** (`install.cmd` gọi `install.ps1`): chép draft vào thư mục draft của
  CapCut và thay token đường dẫn bằng đường dẫn thật. Không dựa vào placeholder chưa kiểm.
- **Q3. Draft mẫu:** người dùng tạo một draft `ag-ref` bằng CapCut 9.5.0 có đủ thứ còn thiếu (A0).

## Quyết định đề xuất (mặc định nếu không ai phản đối)

- **D1. Chữ là text gốc của CapCut**, không phải PNG: CapCut được chọn để sửa tiếp, chữ phải sửa được. Font Arial hệ
  thống (`C:/WINDOWS/Fonts/arial.ttf`, như thumbnail). Vị trí `TEXT_POSITIONS` → `transform {x, y}` theo bảng cố định;
  `animation` bỏ (ghi cảnh báo `text_animation_dropped` nếu khác `none`/`fade`).
- **D2. Phụ đề:** mỗi cue một text segment trên track riêng; `karaoke` ra chữ thường + cảnh báo `karaoke_as_plain`.
- **D3. Âm thanh:** tiếng gốc = `volume` của segment video (0 khi `has_audio` false hoặc `voice: tts`, như render);
  lời dẫn mỗi dòng một segment trên track audio "Lời dẫn"; nhạc một track, lặp bằng nhiều segment nối tiếp khi
  `loop`, âm lượng `10^(gain_db/20)`, fade đầu/cuối. Ducking bằng keyframe âm lượng nếu A0 cho thấy định dạng rõ, không
  thì bỏ ducking + cảnh báo `duck_dropped`.
- **D4. Chuyển cảnh:** `dissolve` và `dip_black` map sang hai hiệu ứng CapCut tương ứng lấy từ draft mẫu. CapCut tính
  chuyển cảnh **chồng lên hai clip** còn render Studio lấy đuôi của clip trước (ADR mục 118), nên trục thời gian có thể
  lệch nửa chuyển cảnh: A0 đo, A1 chọn cách bù (kéo `source_timerange` của clip trước thêm `seconds` khi
  `tail_available`). Hiệu ứng cần tải từ kho CapCut mà draft lạ không mở được thì lùi về `cut` + cảnh báo
  `transition_as_cut`.
- **D5. Chapter** (`youtubeChapters`, như Premiere) → `time_marks` nếu A0 thấy định dạng; không thì bỏ, chỉ ghi vào
  `README.txt`.
- **D6. Cả hai kiểu dựng** (`whole` và `cut`) xuất được ngay từ đầu; không có cổng kiểu `premiere_needs_phase_4`.

## Kiến trúc

```
composition.json ──► capcut/plan.ts ──► CapcutPlan ──► capcut/draft.ts ──► { path → bytes } ──► zip (render worker)
 (harness.composition/v1)  (ĐỌC, duy nhất)  (trung lập, µs)   (GHI, ghim 9.5.0)    + install.cmd/ps1 + README
```

Thư mục `packages/core/src/studio/capcut/`:
- `plan.ts`: `compositionToCapcutPlan(c: Composition, opts: { media: Record<sourcePath, MediaInfo>, markers })`
  → `CapcutPlan`. **File duy nhất import `Composition`.** Đổi giây sang µs một lần ở đây
  (`us(s) = Math.round(s * 1e6)`; độ dài = `us(end) - us(start)` để không trôi), gom cảnh báo.
- `plan-schema.ts`: zod của `CapcutPlan` (`ag.capcut-plan/v1`): `canvas`, `fps`, `duration_us`, `media[] {key, kind:
  video|audio, file (đường dẫn tương đối trong zip), duration_us, width, height, has_audio}`, `video[] {media, source_in_us,
  target_start_us, duration_us, volume, transition_out|null}`, `audio_tracks[] {name, segments[{media, source_in_us,
  target_start_us, duration_us, volume, fade_in_us, fade_out_us, keyframes[]}]}`, `text_tracks[] {name,
  segments[{text, target_start_us, duration_us, position, size}]}`, `marks[]`, `warnings[]`.
- `draft.ts`: `capcutDraftFiles(plan, { name, ids })` → `Map<string, string>` gồm `draft_content.json`,
  `draft_meta_info.json`, `Timelines/project.json`, `Timelines/<uuid>/draft_content.json` và các file phụ A0 xác định là
  bắt buộc. Mọi đường dẫn tuyệt đối là `__AG_DRAFT_DIR__/media/<file>`; id sinh từ `ids` (seed) để snapshot ổn định.
  Không import gì từ timeline/composition.
- `templates.ts`: đối tượng mặc định cho segment, material video/audio/text, các material phụ, rút từ draft mẫu và
  **đã lọc** (không đường dẫn máy dev, không id tài khoản, không `md5`).
- `installer.ts`: nội dung `install.cmd`, `install.ps1`, `README.txt` (tiếng Việt) dạng hằng chuỗi.
- `index.ts`: export ra `@harness/core` → `packages/render/src/index.ts` export tiếp `compositionToCapcutPlan`,
  `capcutDraftFiles`, `CAPCUT_INSTALLER_FILES`.

Installer (`install.ps1`, chạy qua `install.cmd` bằng `powershell -NoProfile -ExecutionPolicy Bypass -File`):
1. Tìm thư mục draft: `%LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft`; không có thì báo và dừng.
2. Báo nếu `CapCut.exe` đang chạy (CapCut ghi đè `root_meta_info.json` khi thoát) và chờ người dùng đóng.
3. Thư mục đích `<tên tập>`; đã có thì thêm hậu tố ` (2)`, ` (3)`… — **không bao giờ ghi đè**.
4. Chép `draft/` và `media/` vào đích; thay `__AG_DRAFT_DIR__` trong mọi `*.json` bằng đường dẫn đích dạng `C:/…`
   (thoát JSON đúng chuẩn, giữ UTF-8 không BOM).
5. Chỉ sửa `root_meta_info.json` nếu A0 cho thấy CapCut không tự nhận draft mới; khi đó sao lưu `.bak` trước khi thêm.

## Nhóm A: định dạng và hàm thuần (repo này, không cần pha 5 merge)

### A0. Đọc định dạng từ draft mẫu (chặn A1–A3)

Người dùng tạo `ag-ref` trong CapCut 9.5.0: 2–3 clip, trong đó một clip cắt bớt đầu/cuối và tắt tiếng; một Cross
Dissolve và một Dip to Black; một track nhạc có âm lượng khác 0 dB, fade in/out và một keyframe âm lượng; một WAV ở track
khác; một chữ; nếu được, một marker.

Việc làm (chỉ đọc thư mục draft, không sửa):
- Ghi lại cấu trúc track audio, `materials.audios`, `audio_fades`, `transitions` (khoá, `effect_id`/`resource_id`, có
  đường dẫn cache tải về không), `common_keyframes`/`keyframe_refs` cho âm lượng, `time_marks`, và cách CapCut đặt
  `target_timerange` hai clip quanh chuyển cảnh (D4).
- Thử bằng tay (người dùng mở CapCut, có hỏi trước khi ghi vào thư mục draft): (a) chép `ag-ref` sang tên khác, đổi
  `draft_id`, xem CapCut có hiện không khi `root_meta_info.json` không có dòng của nó; (b) xoá dần file phụ để biết bộ tối
  thiểu; (c) đổi `path` media sang thư mục khác xem CapCut có nhận.
- Kết quả: fixture đã lọc `packages/core/test/fixtures/capcut-9.5.0/` (`ag-ref.draft_content.json`, `ag-ref.meta.json`)
  và ADR mục 161 ghi định dạng + bộ file tối thiểu.

**Test:** chưa có (task này sinh fixture và ghi chú).

### A1. `CapcutPlan` và `compositionToCapcutPlan`

**Test** (`packages/core/test/studio/capcut-plan.test.ts`, composition dựng tay + composition sinh từ timeline v3 và v4
qua `timelineToComposition`):
- v3 một tập 3 clip nguyên video: `source_in_us = 0`, nối tiếp, tổng = `us(total_seconds)`;
- v4 có trim: `source_in_us = us(in)`, độ dài = `us(end) - us(start)`, không trôi sau 200 clip (tổng khớp tuyệt đối);
- tiếng gốc: `has_audio: false` hoặc `voice: tts` → `volume 0`;
- lời dẫn: một segment mỗi dòng, `media` = `stage:voice/<line_id>.wav`, đúng `start`;
- nhạc: `gain_db -18` → `0.1259`; `loop` với nhạc ngắn hơn tập ra nhiều segment nối tiếp, segment cuối cắt đúng tổng;
  fade chỉ ở đầu segment đầu và cuối segment cuối;
- chuyển cảnh: `tail_available: false` → không có `transition_out`; dissolve có đuôi → bù theo D4;
- chữ và phụ đề: đúng track, đúng mốc, `karaoke` → cảnh báo;
- media thiếu trong `opts.media` → lỗi rõ (`capcut_media_missing`), không ra plan nửa vời.

### A2. `capcutDraftFiles` (ghim 9.5.0)

**Test** (`capcut-draft.test.ts`):
- snapshot `draft_content.json` cho một plan nhỏ (seed cố định);
- mọi `material_id`/`extra_material_refs` đều trỏ tới material có thật; không id trùng;
- `version: 360000`, `new_version: "187.0.0"`, `app_version: "9.5.0"`;
- không chuỗi nào chứa đường dẫn tuyệt đối ngoài `__AG_DRAFT_DIR__/…` và `C:/WINDOWS/Fonts/arial.ttf`;
- cấu trúc khớp fixture `ag-ref` ở các khoá A0 đánh dấu là bắt buộc (so tập khoá, không so giá trị);
- `Timelines/<uuid>/draft_content.json` giống từng byte `draft_content.json`.

### A3. Installer và README

**Test** (`capcut-installer.test.ts`):
- thay token: đường dẫn có dấu cách, có ký tự tiếng Việt, có `'` → JSON vẫn parse, giá trị đúng;
- trên `win32`: chạy `install.ps1` thật với `-DraftRoot <thư mục tạm>` (tham số chỉ để test) — chép đúng, không ghi đè,
  thêm hậu tố; nơi khác thì skip;
- `install.cmd` dùng CRLF; `README.txt` có các bước tay khi không chạy được script.

### A4. Export qua `@ag-studio/render`

Thêm export vào `packages/render/src/index.ts`; test `packages/render` import được ba tên. `pnpm build` +
`pnpm -r typecheck` sạch.

## Nhóm T: việc ngoài repo (đổi hợp đồng ag-farm, đã được đồng ý ở Q1)

### T0. Worktree

Không đụng `E:\CODE\ag-farm` và `E:\CODE\ag-render-worker*` đang dùng cho pha 4/5. Tạo worktree mới:
`E:\CODE\ag-farm-p6` (nhánh `feat/studio-phase-6-capcut` từ `feat/studio-phase-5-cut`) và `E:\CODE\ag-render-worker-p6`
(nhánh `feat/studio-phase-6-capcut` từ `feat/studio-phase-5-cut`). Hỏi người dùng trước khi tạo.

### T1. ag-farm: loại job `studio.export_capcut`

- `packages/protocol/src/jobs/studio.ts`: `StudioExportCapcutPayloadSchema` (giống Premiere: `production_id`,
  `episode_id`, `composition`, `media`, `name`, `markers`, `media_names`, `output`), manifest `ag.studio.capcut/v1` ở
  `capcut.json` (`output`, `size_bytes`, `media`, `files[]`, `capcut_version: "9.5.0"`, `warnings[]`).
- `registry.ts` (lane interactive, slot cpu như Premiere), `common.ts`, `enroll.ts` (vai `render`),
  `protocol.spec.ts`.
- Worker cũ không khai `studio.export_capcut` thì không nhận job: Studio phải hiện lỗi rõ khi job `queued` quá lâu
  (đã có cảnh báo 10 phút ở màn Hàng đợi).

### T2. ag-render-worker: `capcut-handler.ts`

- Tách phần tải media + ffprobe của `premiere-handler.ts` thành hàm dùng chung (commit riêng, test Premiere không đổi).
- Handler: parse payload → tải composition, media (`media/NN-<slug>.<ext>`), nhạc, WAV lời dẫn (`stage:voice/…`) → probe →
  `compositionToCapcutPlan` → `capcutDraftFiles` → zip `draft/…`, `media/…`, `install.cmd`, `install.ps1`, `README.txt` →
  upload zip + `capcut.json`.
- Test: ctx giả như `premiere-handler.test.ts` (skip khi thiếu ffmpeg); zip có đủ file; manifest hợp lệ.
- Thử với code pha 6: link `@ag-studio/render` của worktree này sang `E:\CODE\ag-studio-p6\packages\render`.

## Nhóm B: Studio API và engine (repo này)

### B1. Migration `0028_episode_jobs_capcut.sql`

Nới `CHECK` của `episode_jobs.kind` thêm `export_capcut` (SQLite: dựng lại bảng, giữ dữ liệu và index).
**Test:** migrate trên DB có job cũ; insert `export_capcut` được; kind lạ vẫn bị từ chối.

### B2. `startCapcutExport` và `pollEpisodeJob`

- `editor.ts`: `startCapcutExport` giống `startPremiereExport` (lỗi `severity: error` của timeline chặn), `stage_key =
  'editor-capcut'`, output `episodes/<eid>/capcut/<id>.zip`, **không** chặn tập cắt. Tách phần chung với Premiere
  thành một hàm (commit riêng, test Premiere không đổi).
- `pollEpisodeJob` đọc `capcut.json` theo kind; `EpisodeJob.kind` (`studio-db.ts:213`) thêm `export_capcut`.
- `/api/farm/sign` nhận `stage_key = 'editor-capcut'` như `editor-premiere` (kiểm `farm.controller.ts:84`).
**Test** (engine, farm và bucket giả): tập `whole` và tập `cut` đều gửi được job; payload đúng schema T1; job xong ra
URL; manifest sai thì job `failed` có lỗi rõ; `media: original` không có quyền → 403.

### B3. Route

`POST productions/:id/episodes/:episodeId/exports/capcut {media}` (vai `editor`, 202), `JOB_KINDS` thêm
`export_capcut`. **Test:** `timeline.spec.ts` theo mẫu Premiere.

## Nhóm C: web

- `studio-client.ts`: `exportCapcut()`, `EditorJob.kind`.
- Mục "Xuất CapCut (proxy / bản gốc)" cạnh Premiere ở `EpisodesPanel`, `EpisodeDrawer`, `ResultPane` — **hiện cả với
  tập cắt**; danh sách job dùng chung với Premiere, có nhãn định dạng.
- i18n `chat.{vi,en}.ts`.
- **Test:** `ResultPane.spec.tsx`, một spec `capcut-exports.spec.tsx` theo mẫu `premiere-exports.spec.tsx`.

## Nhóm D: kiểm tổng và tài liệu

### D1. Tích hợp trong tiến trình

Timeline v4 của fixture pha 5 → composition → plan → draft files → zip trong bộ nhớ → giải nén vào thư mục tạm → chạy
installer (win32) → đọc lại `draft_content.json`: số clip, thứ tự, in/out, chữ, nhạc khớp timeline.

### D2. Kiểm tay (sau khi người dùng mở lại stack local; tiêu chí "xong khi")

Một tập `cut` của Hoa Lư và một tập `whole`: xuất CapCut proxy, chạy `install.cmd`, mở trong CapCut 9.5.0: đúng clip,
thứ tự, điểm cắt, chữ, phụ đề, nhạc (mức, fade), lời dẫn, chuyển cảnh; phát hết không báo thiếu media. Ghi kết quả vào
plan này.

### D3. Tài liệu cuối pha

AGENTS.md (mục Render, xuất), ADR mục 161–166 (định dạng 9.5.0, kiến trúc đọc/ghi tách, installer, cảnh báo khi CapCut
đổi định dạng), runbook `docs/runbooks/capcut.md` (cách cài, cách cập nhật khi CapCut lên bản mới: tạo lại `ag-ref`, so
khoá), `deferred-items.md` (karaoke, ducking nếu bỏ, macOS chưa hỗ trợ), skills README nếu có đổi.

## Thứ tự và phụ thuộc

1. **A0** (chờ draft mẫu) → A1 → A2 → A3 → A4. A1 làm được song song với A0 cho phần không phụ thuộc định dạng (µs,
   track, âm lượng).
2. B1 → B2 → B3 → C: không cần A0; B2 dùng schema T1 nên viết schema payload trong test trước, khớp lại khi T1 xong.
3. T0 → T1 → T2: cần người dùng đồng ý tạo worktree; T2 cần A4.
4. D1 sau A4 + B2. D2 sau khi người dùng mở stack local. D3 cuối.

Rebase lên pha 5: chạy lại test `capcut-plan`; nếu `CompositionSchema` hay `timelineToComposition` đổi, chỉ sửa
`capcut/plan.ts`.

## Kiểm tra cuối pha

`pnpm test`, `pnpm build`, `pnpm -r typecheck` sạch; test ag-farm protocol và ag-render-worker xanh; D2 đạt; không còn
TODO.
