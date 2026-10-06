# Kế hoạch: Studio làm series nhiều tập từ nguyên video, quét cả video, gỡ tắc render, cài worker một lệnh, làm lại UI

## Bối cảnh

Rà soát ngày 30/09 cho thấy hệ thống lệch thiết kế:
- **Quét:** đang chia video thành đoạn (segment) rồi tả từng đoạn. User muốn hiểu nội dung **cả video gốc**.
- **Studio:** đang ghép các đoạn thành **một** video. User muốn:
  - mỗi production thành **nhiều tập**, ghép từ **nguyên video**;
  - theo dõi tiến độ từng tập;
  - bước cuối có thumbnail và thông tin đăng YouTube;
  - tuỳ chọn xuất project Adobe Premiere;
  - đầu vào là link kênh YouTube và từ khoá để nghiên cứu thị trường.
- **Render "treo"** (đã kiểm chứng):
  - Worker chết lúc 17:03 và không tự chạy lại.
  - Scan và render tranh CPU trên cùng máy.
  - Cắt 4K bằng libx264 `-preset slow`, mỗi clip bị encode 3 lần.
  - Worker-sdk nuốt các cập nhật tiến độ (đứng ở 2%).
  - Studio gửi `max_attempts: 1`, và lệnh huỷ không dừng được bước ghép.
- **Treatment kém:** Studio dev đang chạy Claude giả, brief rỗng, catalog nghèo.
- **Bổ sung của user:**
  - cài worker bằng một lệnh;
  - tạm dừng / chạy tiếp / huỷ từng job và cả đợt quét;
  - bảng dùng page/pageSize, sort kiểu ag-go, icon lucide;
  - admin Studio thấy mọi production, sửa và xoá được.

## Quyết định đã chốt

| # | Quyết định |
|---|---|
| 1 | Ghép **nguyên cả video** (clip = cả asset, không trim) |
| 2 | Production = **series nhiều tập**. **Claude đề xuất số tập**; người dùng thêm, bớt, sửa khi duyệt |
| 3 | **Được dùng lại** một video ở nhiều tập; trong cùng một tập thì không trùng |
| 4 | **Duyệt kế hoạch tập một lần**, sau đó các tập tự dựng và render. Muốn sửa tập nào thì mở editor rồi render lại tập đó |
| 5 | Thời lượng mỗi tập là mục tiêu mềm ±20%: lệch thì cảnh báo, vẫn cho duyệt |
| 6 | Dữ liệu thị trường lấy từ **YouTube Data API v3**: kênh qua `channels` / `playlistItems` / `videos`, từ khoá qua `search.list` (100 đơn vị mỗi lượt, cache 24 h). Claude phân tích **không dùng tool**. yt-dlp và phụ đề để sau |
| 7 | Project Premiere: xuất **FCP7 XML** (Premiere mở được). **Chọn loại media khi xuất**: mặc định proxy 720p; bản gốc chỉ cho người có quyền tải gốc |
| 8 | Render cùng máy với quét nhưng **được ưu tiên** |
| 9 | Admin Studio là `user_type = ADMIN` từ Account API |
| 10 | **Bỏ hẳn segment**. `/footage` của ag-go-web thành tìm theo video |
| 11 | Chưa chuyển lời nói thành chữ. Chỉ có cờ `has_audio` / `has_speech` |
| 12 | Mỗi màn có 1 nút chính icon + chữ. Mọi nút khác chỉ icon + Tooltip + `aria-label`; nhóm thao tác gom vào `Dropdown trigger={['click']}` |
| 13 | Đổi hợp đồng ag-farm (schema quét v2, input `asset:`, trạng thái `paused`, enrollment) được duyệt qua kế hoạch này |

**Git:**
- ag-farm, ag-studio, ag-scan-worker, ag-render-worker: commit local trên `main`.
- ag-go-api và ag-go-web: nhánh `feat/asset-analysis` tách từ `dev-duc`.
- Không push khi chưa hỏi.
- ag-go-api `dev-duc` có thay đổi chưa commit:
  - Phần footage theo cây folder là của mình: commit riêng trước khi tách nhánh.
  - WIP `analysis-log` của phiên khác: **không đụng**.

---

## Giai đoạn 0: Gỡ tắc render và cài worker một lệnh

### 0.1 Worker-sdk (`ag-farm/packages/worker-sdk/src/{worker,machine,hub-client}.ts`)
- **Tiến độ trailing:** giữ `percent` / `stage` mới nhất và gửi kèm lần gia hạn lease 30 s kế tiếp.
- **Sửa lỗi crash:** unhandled rejection của `LeaseLostError` trong `void doProgress()`.
- **Timeout `fetch`.**
- **Cờ interactive cấp máy** (`locks/interactive-<pid>-<jobId>.lock`, dùng lại cách kiểm pid của `isLocked`):
  - Bật khi đang chạy, hoặc đang `waitForSlot`, một job interactive.
  - Khi cờ bật, vòng claim bỏ qua lane batch.
  - Handler có thêm `ctx.shouldYield()`.
  - Gửi `cached_affinity`.
- **Hub:** xoá tiến độ khi claim và khi retry. `lease_expired` được thử lại nếu còn lượt.

### 0.2 Scan-worker
- `os.setPriority(PRIORITY_BELOW_NORMAL)` cho cả tiến trình; ffmpeg con thừa hưởng.
- `scan.ai` kiểm `shouldYield` giữa các lần gọi Ollama. Nếu có việc render thì chờ, trong lúc đó gửi tiến độ `waiting_for_render`.
- Đọc `ollama_url` từ `config.extra`, như render-worker ở `src/config.ts:27`.

### 0.3 Render-worker và Studio
- Truyền `AbortSignal` vào `renderComposition` (`ag-studio/packages/core/src/media/render/run.ts`) và `python-runner.ts`.
- Báo tiến độ encode bằng `-progress pipe:1`.
- Sửa lỗi `max_bytes` → `maxBytes`. Mezz cache nằm trong `config.cache.dir`.
- Tạm cho bước cắt dùng NVENC hoặc `veryfast`; giai đoạn 2 bỏ hẳn bước cắt.
- `farm-executor.ts`: `max_attempts: 2`.

### 0.4 Cài worker bằng một lệnh (Windows)

**Mã cài đặt (farm)**
- Bảng `farm_enrollments`: mã dùng một lần, hết hạn sau 24 h, gồm tên máy và vai trò scan / render.
- `POST /v1/admin/enrollments`: tạo mã.
- `POST /v1/enroll`: tạo node và trả token cho mỗi vai trò.

**Farm phục vụ tĩnh `releases/`:** `/dist/install.ps1`, `/dist/ag-{scan,render}-worker-<ver>.zip`, `/dist/latest.json`. `deploy.sh` của worker chép zip mới vào đây.

**Bundle tự đủ** (`scripts/release.mjs`): `node.exe` portable, `nssm.exe`, `node_modules` gồm ffmpeg-static win-x64.

**`install.ps1`** (ag-farm `packages/worker-installer/`)
- Một lệnh do trang Máy hiện sẵn: `iwr https://<farm>/dist/install.ps1 -UseB | iex; Install-AgWorker -Hub … -Code …`
- Các bước:
  1. Kiểm quyền admin, dung lượng đĩa, driver NVIDIA.
  2. Đổi mã lấy token.
  3. Tải và giải nén vào `C:\ag-farm\`.
  4. Tự tính `machine.yaml` theo số nhân CPU và VRAM; máy chạy cả hai vai trò thì dành 1 CPU và 1 GPU cho render.
  5. Vai trò scan: cài Ollama im lặng nếu thiếu, rồi pull model theo VRAM (≥ 12 GB → `7b`, nhỏ hơn → `3b`).
  6. Vai trò render: kiểm font Arial; `-WithTts` mới cài Python.
  7. Cài dịch vụ NSSM tự chạy lại khi chết.
  8. Chờ heartbeat trên hub rồi in "Online".
- Chạy lại cùng lệnh để **cập nhật** mà vẫn giữ config. Có thêm `uninstall.ps1`.

**Web farm, trang Máy:** dropdown "Thêm máy" → lệnh cài kèm mã, sao chép được. Cột phiên bản, cảnh báo khi máy chạy bản cũ.

**Máy dev:** cài lại cả 2 worker bằng bộ cài này. Đây là phép thử nghiệm thu.

---

## Giai đoạn 1: Quét cả video, tạm dừng và huỷ đợt quét

### 1.1 Giao thức (`ag-farm/packages/protocol/src/jobs/scan.ts`, `extract_version: 'x2'`)
**`ExtractManifestV2`** gồm:
- `media`, `proxy`
- `keyframes[]`: tối đa 24 khung, cạnh dài 640 px, có dHash
- `scenes[]`: `{start_ms, end_ms}`
- `technical` cho cả video: `black_ratio`, `frozen_ratio`, `blur`, `silence_ratio`, `has_speech_hint`, `dead`
- `contact_sheet`: tối đa 24 ô

**`AssetDescriptionSchema`** gồm:
- `title_vi`, `summary_vi` (≤ 120 từ), `summary_en`
- `genre`, `topics[]`, `subjects[]`, `places[]`, `actions[]`, `keywords_vi[]`, `tags[]`
- `mood`, `setting`, `time_of_day`, `people_count`, `shot_variety[]`
- `visible_text`, `has_watermark`, `usable`, `usable_reason`, `quality`

**`ScanAiPayloadV2`:** mỗi video một job.

Đồng bộ bản chép tay ở `ag-go-api/src/modules/analysis/farm/scan.ts`.

### 1.2 Scan-worker
- **`scan-extract.ts`:**
  - Chọn 1 keyframe mỗi cảnh, bỏ khung gần giống theo dHash, rải đều nếu quá 24.
  - Đo chỉ số kỹ thuật một lượt cho cả video.
  - Sửa lỗi timeout phát hiện cảnh, và giới hạn số ffmpeg chạy song song.
- **`scan-ai.ts`, mô tả 2 bước:** ghi chú cho mỗi nhóm 4 khung, rồi tổng hợp thành `AssetDescription`. Kiểm `shouldYield`.
- **Test:** cập nhật spec. `scripts/e2e/run.sh` thêm `scan.ai` với Ollama giả, có assert.

### 1.3 ag-go-api
- **Migration:**
  - `asset_analyses` thêm `description`, `described_at`, `usable`, `quality`, `duration_ms`, `orientation`, `has_audio`, `has_speech`, `search_vector`, `batch_id`.
  - Trigger dùng `immutable_unaccent`, cộng index GIN và trigram.
  - **Drop `media_segments`.**
- **Poller:** xong extract thì nộp một job `scan.ai`; xong AI thì ghi mô tả; `finalizeIfDone` bật `is_current`.
- **`analysis-sign`:** `scan.ai` chỉ được ghi `ai.json`.
- **Footage theo video** (giữ `FootageScopeService`):
  - `GET /footage/folders`
  - `POST /footage/catalog`: mỗi dòng một video, có `DISTINCT`, phân trang offset.
  - `GET /footage/assets/:id/media`
  - `POST /footage/assets/resolve`: dùng lại logic chọn nguồn của `resolveSegments`, trả `durationMs` và `cacheKey`.
  - `search`, `facets`
  - `assertAssetsInScope`
- **Module analysis:** trả mô tả video, bỏ `assets/:id/segments`, thống kê theo video.
- Sinh lại `openapi.yaml`. Viết lại các db-spec footage / poller / analysis.

### 1.4 ag-go-web
- **`/footage`:** thẻ video (thumbnail, thời lượng, tóm tắt, tag, sao). Drawer có player cả file và mô tả. Bỏ `RangePlayer`.
- **`project-review-drawer`:** thẻ mô tả video thay cho `SegmentList`.
- **`project-media-panel`, `analysis-panel`:** hiện theo video.
- Cập nhật i18n và test.

### 1.5 Tạm dừng, chạy tiếp, huỷ

**Farm**
- Trạng thái `paused` và cột `group_key` (duy nhất theo owner).
  - `queued` ↔ `paused`.
  - Job đang chạy (`leased`) bị tạm dừng: worker nhận 409 `job_paused`, dừng lại, job về `paused`. **Không tính là một lần thử.**
- API owner và admin: `pause` / `resume` / `cancel` theo `ids[]`, `group_key`, hoặc bộ lọc (chỉ admin).
- Worker-sdk xử lý `job_paused`.

**ag-go**
- Bảng `analysis_batches` gồm:
  - `name`, `mode`, `scope`, `priority`, `created_by`
  - `status`: running / paused / cancelled / completed
  - bộ đếm tiến độ
- Mỗi lần backfill tạo một batch. Quét tự động sau render thuộc batch hệ thống "Tự động".
- `group_key = batch:<id>`.
- Tạm dừng: outbox ngừng gửi và farm pause. Chạy tiếp: resume và gửi nốt. Huỷ: cancel, analysis → `cancelled`.
- API: `GET /analysis/batches` (phân trang, sort), `POST /analysis/batches/:id/{pause|resume|cancel}`, cùng các thao tác đó cho từng video.

**ag-go-web** (`/system/logs` tab Analysis): bảng đợt quét có thanh tiến độ và nút icon tạm dừng / chạy tiếp / huỷ. Form backfill thêm ô "Tên đợt".

### 1.6 Dữ liệu cũ
Tạo đợt quét `outdated` x2 để quét lại toàn bộ video trên máy dev. Dùng đợt này để thử tạm dừng, chạy tiếp và huỷ.

---

## Giai đoạn 2: Studio làm series nhiều tập

### 2.1 Mô hình dữ liệu (migration `0011_series`)
- **`productions` thêm:**
  - `youtube_channels[]`, `keywords[]` (dùng ở giai đoạn 5)
  - `goal`, `audience`, `tone`, `notes`
  - `episode_target_seconds`, `max_episodes` (trần cho Claude, mặc định 10)
  - `plan_run_id`
- **Bảng mới `episodes`:**
  - `id`, `production_id`, `idx`, `title`, `hook`
  - `status`: planned / producing / ready / failed / cancelled
  - `run_id`
  - `sequence` (json), `youtube` (json)
  - `selected_thumbnail`, `render_progress`
  - timestamps
- `timeline_revisions` và `studio_editor_jobs` gắn thêm `episode_id`.

### 2.2 Contracts (`packages/contracts/src/studio.ts`)
- `CatalogAssetSchema` và `studio.catalog/v2`.
- **`studio.series-plan/v1`:**
  - `{series_title, rationale, episodes[{idx, title, hook, logline, target_seconds, items[{asset_id, reason, section_title?}], alternates[], texts_suggested[]}]}`
  - Validator: không trùng trong một tập; được trùng giữa các tập.
- **`studio.timeline/v3`:**
  - `assets` map, `clips[{clip_id, asset_id}]`
  - `texts` với thời điểm tuyệt đối
  - `music`, `source_audio`
- **`studio.youtube-kit/v1`:**
  - `titles[3]` (≤ 100 ký tự)
  - `description` (≤ 5000)
  - `chapters[]`: tính từ `section_title` và điểm bắt đầu clip; đúng luật YouTube (bắt đầu 0:00, ≥ 3 chương, mỗi chương ≥ 10 s)
  - `tags[]` (tổng ≤ 500 ký tự), `hashtags[]`
  - `thumbnail_texts[3]`, `thumbnail_picks[3 {asset_id, offset_s}]`
  - `playlist`

### 2.3 Workflow
**Run kế hoạch, `ag-studio-series-plan@1.0.0`** (run cấp production):
1. intake
2. research (script; giai đoạn 5 mới lấy dữ liệu thật, hiện ghi dữ liệu rỗng)
3. trend-report (Claude; dữ liệu rỗng thì bỏ qua, không gọi Claude)
4. catalog
5. **plan-episodes** (Claude)
6. **approve-plan** (người duyệt)
7. **spawn-episodes** (script tạo các bản ghi `episodes` và khởi động run của từng tập)

**Run tập, `ag-studio-episode@1.0.0`** (mỗi tập một run):
1. build-timeline
2. **youtube-kit** (Claude, Sonnet)
3. render-final (farm): video + 3 thumbnail
4. export: mp4, thumbnail, `youtube.json`, phụ đề nếu có, zip "gói đăng YouTube"

**Sửa một tập:** mở editor theo tập. Lưu xong bấm "Render lại" → resume run tập từ `youtube-kit` (dùng tính năng chạy lại từ một bước đã có ở `run-control.ts`).

**Đăng ký:**
- `STUDIO_FLOWS`
- `STUDIO_GATES` (`approve-plan`)
- vai trò ở controller
- kiểu gate cho web, i18n

**Luồng cũ:** bỏ 2 luồng theo segment. Production cũ trên máy dev đánh dấu lưu trữ.

### 2.4 Core (`packages/core/src/studio/*`)
- **`catalog.ts`:** theo video. Lọc trước tối đa 300 video.
- **`validate.ts`:**
  - `validateSeriesPlan`: id có trong catalog, dùng được, đúng hướng khung, không trùng trong một tập, mỗi tập ±20% chỉ cảnh báo, tối đa `max_episodes`.
  - `validateYoutubeKit`.
- **`build-timeline.ts`:** kế hoạch của tập → timeline v3, cộng chữ đề mục.
- **`render-plan.ts`:** `asset:<id>`, `in = 0`, `out = duration`.
- **`layout.ts`:** các thao tác v3 (thêm, xoá, đổi chỗ clip; chữ; nhạc; tiếng gốc).
- **Checkers:** `series-plan-valid`, `youtube-kit-valid`, `timeline-valid`.

### 2.5 Skills (viết mới, mỗi skill khoảng 100–150 dòng, có ví dụ)
- **`studio-plan-episodes`:**
  - Đề xuất số tập (1 tới `max_episodes`) theo lượng video và xu hướng.
  - Mỗi tập có tiêu đề, hook 5 giây đầu, mạch chuyện, video đa dạng, tổng thời lượng ±20%.
  - Chỉ dùng lại video giữa các tập khi hợp chủ đề.
- **`studio-youtube-kit`:**
  - Tiêu đề theo mẫu đang hiệu quả trong báo cáo xu hướng.
  - Mô tả có chương, tag và hashtag tiếng Việt.
  - Chữ và khung hình cho thumbnail.
- **`studio-trend-report`** (giai đoạn 5).
- Đăng ký trong `STUDIO_SKILL_OUTPUTS` và `VALIDATORS`, thêm nhánh cho Claude giả.
- Model theo từng skill: `STUDIO_CLAUDE_MODEL_<SKILL>`; plan dùng Opus, còn lại dùng Sonnet.

### 2.6 Render mức video và thumbnail
- **Studio `farm.controller.ts`:** nhánh `asset:` gọi `POST /footage/assets/resolve`. Cập nhật `ag-go-client`.
- **Render-worker `render-handler.ts`:**
  - Tải `asset:` qua cache của SDK theo `cache_key`. **Bỏ bước cắt đoạn.**
  - Kẹp `out` theo thời lượng đo được.
  - Preview dùng proxy, final dùng bản gốc.
  - Ký URL ngay trước khi tải.
- **Thumbnail (trong job `studio.render_final`):**
  - Payload thêm `thumbnails[{t_s, text}]`.
  - Sau khi render: lấy khung hình ở `t_s` của video final, scale 1280×720, vẽ chữ bằng ASS (Arial, viền dày) → `thumb-1..3.jpg`.
  - Ghi vào `render.json`.
  - Người dùng chọn 1 trong 3 trên web.

### 2.7 Editor theo tập (`apps/web/src/modules/editor/*`, route `/productions/:id/episodes/:idx/editor`)
- **Timeline:**
  - Hàng video kéo-thả bằng `@dnd-kit/sortable`, thêm và xoá clip.
  - Hàng chữ.
  - Nhạc và tiếng gốc trong panel thuộc tính.
- **Panel video:** tìm trong catalog của production.
- **Player:**
  - Phát tuần tự các file preview, `preload="auto"` cho slot kế tiếp.
  - Đồng hồ lấy theo video đang phát (`requestVideoFrameCallback`, `waiting` / `stalled`).
  - Playhead để trong một store riêng (`useSyncExternalStore`). `React.memo` các panel.
- **Sửa lỗi:**
  - Hiện lỗi thao tác.
  - Render preview dùng revision sau khi lưu.
  - Lưu khi rời trang, thêm `beforeunload`.
  - Dừng các vòng hỏi trạng thái.
  - Ctrl/Cmd+Z không bắt khi đang gõ.

---

## Giai đoạn 3: UI Studio

### 3.1 Nền tảng
- Thêm `lucide-react` và `nuqs`, bỏ `@ant-design/icons`. Thêm CSS `.ant-btn-icon`.
- Chép `sort-dropdown`, `compare-sort-values`, `table-refresh-button`, `use-debounced-value` từ ag-go-web.
- QueryClient `staleTime 30s`, `retry 1`. Route lazy, trang 404. Lỗi hiện bằng `App.useApp().message`. Link dùng `<Link>`.

### 3.2 API
- **Admin:** `getUserProfile` cache 5 phút → `isAdmin`. Guard cho ADMIN qua. `GET /api/me`.
- **Danh sách** productions, teams, members: `page`, `pageSize`, `sortBy`, `sortOrder`, `q`, trả `{items, total, page, pageSize}`. Admin thấy tất cả.
- `GET /api/productions/:id/episodes`: phân trang, sort, kèm tiến độ.
- `PATCH` / `DELETE` teams. Chặn xoá owner cuối cùng.
- **Tạo production nguyên tử.** Trạng thái production tính từ các tập. Không tồn tại → 404.
- Kiểm độ dài brief và số folder ngay ở DTO.

### 3.3 Bảng
- `ProTable` phân trang phía server, page/pageSize trên URL (nuqs), `SortDropdown` trên toolbar, nút làm mới.
- Cỡ chữ mặc định. Cột có `width` và `ellipsis` kèm Tooltip.
- Cột thao tác cố định bên phải: nút icon, hoặc dropdown bấm để mở.
- Menu admin "Tất cả production". Sửa production bằng drawer.

### 3.4 Trang `/productions/:id`
- **Steps cấp production:** Thông tin → Nghiên cứu thị trường → Kế hoạch tập → Duyệt → Sản xuất các tập. Bấm bước đã xong để xem đầu ra.
- **Thông tin:**
  - Form sửa được: tiêu đề, mô tả, mục tiêu, khán giả, giọng điệu, ghi chú, thời lượng mỗi tập, số tập tối đa, khung hình, ngôn ngữ, folder nguồn, link kênh YouTube, từ khoá.
  - Đã chạy thì "Lưu & lập lại kế hoạch" kèm hỏi xác nhận.
- **Nghiên cứu thị trường:** báo cáo xu hướng, bảng video nổi bật (giai đoạn 5).
- **Kế hoạch tập / Duyệt:**
  - Mỗi tập một thẻ: tiêu đề, hook, danh sách video (kéo-thả, đổi sang phương án thay thế, thêm bớt), thời lượng so với mục tiêu.
  - Thêm, xoá, gộp tập.
  - Nút chính "Duyệt & tạo tập".
- **Sản xuất các tập:**
  - Bảng tập: #, thumbnail, tiêu đề, thời lượng, bước hiện tại, thanh tiến độ render %, trạng thái.
  - Thao tác: icon mở editor, render lại, tải video; dropdown "Xuất" gồm gói YouTube và Premiere (proxy / gốc).
  - Chỉ hỏi trạng thái khi có tập đang chạy.
- **Drawer chi tiết tập:**
  - Steps của tập.
  - Gói YouTube: chọn tiêu đề, sửa mô tả, tag, chương; sao chép từng phần.
  - Chọn 1 trong 3 thumbnail.
  - Xem video, tải xuống, xem `cost_usd`.
- Nút hiện theo vai trò người dùng.

---

## Giai đoạn 4: Farm web và API

- **API danh sách** jobs, nodes, owners: `page`, `pageSize`, `sortBy`, `sortOrder`, bộ lọc (status, type, owner, node, `q`), trả `total`. Thêm index. Bỏ cursor. Mới nhất lên đầu.
- **Web:**
  - Bảng theo chuẩn 3.3, thanh `Progress`, cột node hiện tên, tự làm mới khi có job chạy hoặc chờ.
  - Thao tác từng job: tạm dừng / chạy tiếp / huỷ / thử lại.
  - Chọn nhiều dòng rồi dùng dropdown thao tác hàng loạt. "Tạm dừng tất cả theo bộ lọc".
  - Trang Máy: bật / tắt nhận việc, lịch nghỉ, "Thêm máy" (0.4).
- **Drawer job:** hiện payload (sửa `getJob`), `requirements`, `not_before`, `lease_expires_at`.
- **Loại job của node:** `allowed_kinds` (admin đặt) tách khỏi `reported_kinds` (heartbeat); khi giao job lấy giao của hai tập. Không cho xoá node đang giữ job.
- Dùng lucide hoàn toàn, i18n đủ. Payload sai trả 400. Dùng hoặc bỏ `default_lane`.

---

## Giai đoạn 5: Nghiên cứu thị trường (kênh + từ khoá)

- **Script `research`** (in-process, `YOUTUBE_API_KEY` trong env của Studio worker):
  - **Kênh:** chuẩn hoá link (`@handle` qua `forHandle`, `/channel/UC…`, link video → kênh). Lấy 50 video gần nhất qua playlist uploads, chi tiết bằng `videos.list` (50 video mỗi lần).
  - **Từ khoá:** `search.list` với `q`, `type=video`, `regionCode=VN`, `relevanceLanguage=vi`, `publishedAfter` 90 ngày, `order=viewCount` và `relevance`. Mỗi từ khoá 1 trang (100 đơn vị). Cache theo từ khoá 24 h trong DB Studio. Báo trước số đơn vị hạn mức sẽ tốn.
  - **Chỉ số:** view/ngày, trung vị, video vượt trội (≥ 2× trung vị), phân bố thời lượng (Shorts < 60 s), nhịp đăng, cụm từ tiêu đề và tag hay gặp, kênh xuất hiện nhiều trong kết quả từ khoá.
  - Ghi ra `research.json`.
- **Skill `studio-trend-report`** (Sonnet): chủ đề và góc đang hiệu quả, mẫu tiêu đề / hook / thumbnail, độ dài nên làm, lịch đăng, đề xuất cho series này.
- **UI:** hiện ở bước Nghiên cứu thị trường. Báo cáo được đưa vào `plan-episodes` và `youtube-kit`.

## Giai đoạn 6: Xuất project Adobe Premiere

- **Thao tác theo yêu cầu** (không nằm trong run): dropdown "Xuất" → "Premiere (proxy 720p)" hoặc "Premiere (bản gốc)". Bản gốc cần quyền tải gốc, kiểm ở Studio API và ag-go resolve `purpose`.
- **Job farm mới `studio.export_premiere`** (render-worker, lane interactive, slot cpu):
  - Tải media qua cache.
  - Sinh **FCP7 XML (xmeml v5)**:
    - sequence đúng canvas / fps
    - V1: các video nối nhau, `pathurl` tương đối `media/<tên>`
    - V2: chữ trên hình dạng PNG trong suốt (vẽ bằng ASS)
    - A1: tiếng gốc
    - A2: nhạc
    - chương thành marker
  - Đóng zip `project.xml + media/ + overlays/ + README.txt` (hướng dẫn relink sang bản gốc), upload multipart vào bucket Studio.
  - Có tiến độ, tạm dừng / huỷ được.
- **Studio:** bảng `studio_editor_jobs` dùng lại với kiểu mới. Web hiện trạng thái và link tải.
- **Kiểm:** unit test sinh XML (xmllint theo cấu trúc xmeml), mở thử trong Premiere (user kiểm).

---

## Chi phí Claude

Ước tính theo giá API chính thức (Opus 5.5: 4 / 20 USD, Sonnet 5.5: 2 / 10 USD mỗi triệu token vào / ra):

| Bước | Token vào / ra | Chi phí |
|---|---|---|
| trend-report (Sonnet) | khoảng 30k / 3k | khoảng 0,1 USD |
| plan-episodes (Opus, catalog ≤ 300 video) | khoảng 150k / 15k | khoảng 0,9 USD |
| youtube-kit (Sonnet), mỗi tập | khoảng 10k / 2k | khoảng 0,04 USD |

- Series 10 tập: khoảng 1,4 USD quy theo giá API.
- Gói Max 5x (100 USD/tháng) có hạn mức 5 giờ và hạn mức tuần, không công bố bằng token, dùng chung với Claude Code của cùng tài khoản. **Nên dùng tài khoản riêng cho Studio.**
- `cost_usd` và số token hiện trên từng run.

## Việc cần user làm

1. Chạy lệnh cài worker một dòng trên máy dev và `lan-scan` (lệnh lấy ở trang Máy của farm).
2. Tạo YouTube Data API key (trước giai đoạn 5).
3. Cho phép bật Claude thật trên máy dev (nên dùng tài khoản riêng) khi nghiệm thu giai đoạn 2.
4. Đăng nhập Auth0 trong Browser pane để mình kiểm UI.
5. Mở thử file XML xuất ra trong Premiere (giai đoạn 6).

## Kiểm thử

- **Mỗi giai đoạn:** unit test và typecheck repo liên quan.
  - ag-farm: `yarn test`, DB 55433.
  - ag-go-api: `yarn test`, `test:db` (55434), `openapi:validate`.
  - Các web: vitest + build.
  - ag-studio: full suite, cả khi có ffmpeg trên PATH.
  - Hai worker: `yarn test`.
- **Giai đoạn 0:**
  - Test worker-sdk (tiến độ trailing, cờ interactive, không crash).
  - Chạy quét và render cùng lúc trên máy dev: render được nhận ngay, tiến độ tăng dần.
  - **Bộ cài:** gỡ worker cũ → tạo mã → chạy lệnh một dòng. Hai node Online, kill tiến trình thì tự chạy lại, khởi động lại máy vẫn chạy, chạy lại lệnh thì cập nhật mà giữ config.
- **Giai đoạn 1:**
  - E2E quét (extract + ai giả, có assert).
  - Đợt quét lại trên máy dev: tạm dừng giữa chừng → không còn job mới → chạy tiếp → xong đủ; huỷ thì analysis `cancelled`.
  - `/footage` hiện thẻ video có mô tả tiếng Việt.
- **Giai đoạn 2:**
  - Viết lại E2E ag-studio: kế hoạch → 2 tập → mỗi tập render xong, có 3 thumbnail và `youtube.json` hợp lệ. Dùng Claude giả, farm thật và render-worker thật.
  - Sau đó chạy 1 series thật bằng Claude thật (khi user cho phép).
- **Giai đoạn 3–6:** kiểm UI trên Browser pane: bảng, sort, URL, admin, Steps, tiến độ tập, editor phát mượt, gói YouTube, xuất Premiere.
- Tự chạy lại test sau mỗi agent con, không tin báo cáo "xanh" khi chưa tự kiểm.

## Rủi ro

- **Drop `media_segments` không quay lại được.** Chấp nhận vì mới ở máy dev.
- **`search.list` tốn 100 đơn vị mỗi lượt,** nên 10k/ngày chỉ khoảng 100 lượt. Có cache, và UI báo trước số đơn vị sẽ tốn.
- **Premiere không đọc được chữ dạng generator trong XML,** nên dùng PNG. Chữ không sửa được trong Premiere (ghi rõ trong README).
- **Tải bản gốc 4K nặng.** Có cache theo `cache_key`; zip Premiere bản gốc có thể hàng chục GB.
- **Nhiều tập render cùng lúc xếp hàng ở farm.** Tiến độ từng tập hiện rõ, và tập được render theo thứ tự.
