# Sub-project 2C: Kho nội dung — phần 1 (studio) dựng video từ kho source, phần 2 (channel) lấy dùng

**Ngày:** 2026-09-14
**Trạng thái:** Đã duyệt thiết kế qua brainstorming, chờ implementation plan
**Tiền đề:** Sub-project 1, 2A, 2B đã merge vào `main` (2026-09-13). Spec này chỉ mô tả phần thêm vào; mọi thứ không nhắc tới giữ nguyên như hai spec trước (`2026-09-11-harness-structure-and-control-plane-design.md`, `2026-09-12-sub-project-2-footage-production-design.md`).
**Tham khảo:** blueprint mục 3 (lineage), 5 (operations project), 8 (source), 12 (invalidation); tài liệu pipeline theo dạng nội dung của hệ thống cũ (`06-THIET-KE-PIPELINE-THEO-DANG-NOI-DUNG.md`, chỉ để đối chiếu bước).

---

## 0. Quyết định đã chốt trong brainstorming

| Chủ đề | Quyết định |
|---|---|
| Hình dạng hệ thống | Hai phần trên cùng harness: **phần 1 "studio"** dựng video từ kho source thành **kho nội dung**; **phần 2 "channel"** lấy mục kho để xây và phát triển kênh. Hai phần là hai ops project, thường trên hai máy. |
| Đơn vị kho | **Video hoàn chỉnh** (`LibraryItem`): mp4 + khung hình thumbnail ứng viên (không chữ) + captions + edit plan + manifest. Phần 2 chỉ đóng gói bao bì theo kênh và đăng. |
| Phản hồi 2 → 1 | **Hàng đợi yêu cầu** (`ContentRequest`) ghi vào kho; phần 1 nhận, sản xuất, trả `item_id` kèm tham chiếu yêu cầu. |
| Học mẫu edit | Ra **hồ sơ style tái dùng** (`EditStyle`, có revision) qua workflow `style-study`; nhiều tập dùng chung một style; yêu cầu có thể chỉ định style. |
| Bố trí máy | Khác máy; **kho là folder chia sẻ** (NAS/ổ mạng/Drive) mà cả hai đọc được. State SQLite riêng từng máy; trao đổi **thuần bằng file**, không DB chung, không khóa phân tán. |
| Duyệt | Phần 1 **tự dựng, người duyệt sau**: mục vào kho ở `pending_review`; phần 2 chỉ thấy mục `approved`. |
| Cách chọn kiến trúc | Phương án A (hai ops project + module `library` trong core + giao thức file). Đã loại: một workflow xuyên suốt một project (không tách máy được); harness riêng cho phần 1 (dựng lại control plane). |
| Watch / AI vision | Là công cụ của người hoặc agent trong gate; harness không gọi yt-dlp/trình duyệt. Sub-project 4 đổi các gate này thành `agent`. |

---

## 1. Cấu trúc thêm vào

### 1.1 Harness (repo này)

```text
packages/contracts/src/library.ts          EditStyleSchema, ContentRequestSchema, LibraryItemSchema, LibraryClaimSchema
packages/core/src/library/
  files.ts                                 đường dẫn trong kho, ghi nguyên tử (temp + rename), checksum, đọc + validate
  sync.ts                                  đối chiếu kho ↔ DB máy mình (nhập mới, báo hỏng, báo mất)
  export.ts                                exportItem(): artifact → items/<item_id>/ (copy + manifest)
  requests.ts                              vòng đời ContentRequest (open → claimed → fulfilled | rejected → open)
migrations/0003_library.sql                bảng edit_style, content_request, library_item (document table)
packages/cli/src/commands/library.ts       harness library sync|list|request|review|pick|styles
workflows/style-study/workflow.yaml        3 stage
workflows/library-production/workflow.yaml 10 stage
production-profiles/studio/profile.yaml    profile cho máy dựng
fixtures/ops-project-studio/               ops project giả vai studio (wrapper giả, dùng lại wrapper footage)
fixtures/ops-project-channel/              ops project giả vai channel (không stage sản xuất)
docs/runbooks/content-library.md           vận hành kho hai máy
```

### 1.2 Operations project

`project.yaml` thêm:

```yaml
library:
  root: //nas/youtube-library          # hoặc E:/youtube-library; đường dẫn theo máy, không hard-code trong harness
  role: studio                          # studio | channel
```

- `studio`: được ghi `styles/`, `items/` (kể cả đổi `status` sau duyệt), đọc `requests/` và chỉ đổi `status` của request (`claimed`, `fulfilled`, `rejected`).
- `channel`: được ghi `requests/` (tạo mới) và `items/<id>/claims/<channel_id>.json`; đọc mọi thứ khác.
- Không có `library` → mọi lệnh `library` và stage `library-export` báo `CONFIG_INVALID`; workflow `footage-production` cũ không bị ảnh hưởng.

### 1.3 Kho (folder chia sẻ)

```text
<library.root>/
├── styles/<style_id>/style.json                # EditStyle
├── styles/<style_id>/evidence/*.png|*.md       # bằng chứng học mẫu
├── requests/<request_id>.json                  # ContentRequest
├── items/<item_id>/manifest.json               # LibraryItem
├── items/<item_id>/episode.mp4
├── items/<item_id>/thumbnail-01.png … 03.png   # khung hình ứng viên, không chữ
├── items/<item_id>/captions.json               # nếu có
├── items/<item_id>/edit-plan.json              # EDL + tham số style đã dùng
├── items/<item_id>/claims/<channel_id>.json    # LibraryClaim, do channel ghi
└── index.json                                  # sinh bởi `library sync` vai studio, chỉ để đọc nhanh; nguồn sự thật là từng file
```

Không xóa file trong kho; mục bỏ đi đổi `status: withdrawn`.

---

## 2. Mô hình dữ liệu

### 2.1 Entity mới (contracts, `.strict()`, `schema_version` `harness.<tên>/v1`)

**EditStyle** (`style_<ULID>`): `style_id`, `revision` (≥1, tăng khi học lại), `name`, `status: draft|active|retired`, `learned_from: [{ url|label, notes }]`, `params` gồm: `cut_rhythm` (`fast|medium|slow`), `shot_seconds: [min, max]`, `transitions: string[]`, `text_overlay: { style, density }`, `subtitles: burn-in|karaoke|none`, `music: { mood, ducking }`, `opening: { seconds, structure }`, `aspect_ratio`, `pace_notes: string`; `evidence: [{ path, note }]`; `created_at`, `updated_at`.

**ContentRequest** (`req_<ULID>`): `request_id`, `requested_by: { portfolio_id, channel_id? }`, `topic` (hoặc `brief` tự do), `style_id?`, `style_revision?`, `target_duration_seconds?: [min, max]`, `voice: none|tts|original`, `language`, `count` (số tập, mặc định 1), `due_at?`, `status: open|claimed|fulfilled|rejected`, `claimed_by_run?: { project_id, run_id }`, `item_ids: string[]`, `notes`, `created_at`, `updated_at`.

**LibraryItem** (`item_<ULID>`): `item_id`, `status: pending_review|approved|rejected|withdrawn`, `title_hint`, `summary`, `style: { style_id, revision }`, `request_id?`, `duration_seconds`, `media: { width, height, fps, has_audio }`, `files: [{ path, checksum, size_bytes, mime_type }]` (mọi file trong thư mục trừ `claims/`), `lineage: { project_id, run_id, content_id, source_ids[] }`, `review: { by?, note?, at? }`, `created_at`, `updated_at`.

**LibraryClaim** (file `claims/<channel_id>.json`): `item_id`, `channel_id`, `portfolio_id`, `claimed_at`, `note?`.

### 2.2 Bảng mới (migration `0003_library.sql`)

`edit_style`, `content_request`, `library_item` theo mẫu document (`id`, `state`, `data`, `created_at`, `updated_at`), index theo `state`. Đây là **bản sao cục bộ** của kho trên máy đó, được `library sync` cập nhật; nguồn sự thật là file trong kho. Cột `state` của ba bảng này **không** đi qua `transition()` (không phải state machine của control plane), mà qua `sync` ghi lại từ file; quy tắc "chỉ transition()/claim() UPDATE state" chỉ áp cho bảng control plane, ghi rõ trong ADR.

### 2.3 Quy tắc ghi file

- Mỗi file có đúng một chủ ghi (theo vai trò ở 1.2). `manifest.json` chỉ studio ghi; channel ghi claim bằng file riêng, không sửa manifest.
- Ghi nguyên tử: ghi `<file>.tmp-<ulid>` cùng thư mục rồi `rename`; checksum của các file dữ liệu nằm trong manifest; `sync` bỏ qua `.tmp-*`.
- Đổi trạng thái là ghi lại toàn bộ file JSON với `updated_at` mới; máy đọc so `updated_at` để nhận bản mới.
- `index.json` chỉ là cache, mất hay lệch không sao; `sync` sinh lại.

### 2.4 Lineage

```text
SourceItem ─▶ ContentItem ─▶ ContentVariant ─▶ Run (studio) ─▶ artifact episode_video ─export─▶ LibraryItem
LibraryItem ─pick─▶ ContentItem (channel, source_ids = [] , library_item_id) ─▶ Run channel-publish (sub-project 3)
```

`ContentItem` thêm trường tùy chọn `library_item_id` để máy kênh biết content này đến từ kho; `Run.effective_config_snapshot` không đổi.

---

## 3. Workflow phần 1 (máy studio, profile `studio`)

### 3.1 `style-study@1.0.0`

| # | stage_key | executor | depends_on | output |
|---|---|---|---|---|
| 1 | `collect-samples` | script | – | `samples/` (directory: khung hình theo mốc, transcript nếu có, `samples.json` liệt kê nguồn) |
| 2 | `analyze-style` | gate | collect-samples | `style.json` (EditStyle nháp), `evidence/` (directory) |
| 3 | `style-review` | gate | analyze-style | `style.json` đã sửa, `status: active` |
| 4 | `style-export` | script | style-review | ghi `styles/<style_id>/` vào kho; output `export-receipt.json` |

Đầu vào của `collect-samples` là một source văn bản: người đặt file `samples.txt` (mỗi dòng một link hoặc đường dẫn video mẫu, có thể kèm ghi chú của người điều khiển) vào ops project, ingest như một `SourceItem` (`text/plain`), tạo `ContentItem` từ nó và `plan --workflow style-study@1.0.0 --profile studio --content …`. Nhờ vậy style có lineage về danh sách mẫu đã học, và `plan` không cần cơ chế truyền config tùy ý cho stage.

### 3.2 `library-production@1.0.0`

| # | stage_key | executor | depends_on | when | resources | output |
|---|---|---|---|---|---|---|
| 1 | `intake` | script | – | – | – | `brief.json` (request chuẩn hóa + snapshot style `style_id@revision`); fail `contract` nếu request không `open` hoặc style không `active` |
| 2 | `index-source` | script | – | – | cpu | `shots.json`, `proxy.mp4` (như 2B) |
| 3 | `survey-source` | gate | index-source, intake | – | – | `survey.md` (AI vision chấm shot theo brief) |
| 4 | `plan-edit` | gate | survey-source | – | – | `edl.json` (EdlSchema), `edit-plan.json` (chữ, nhạc, mở bài theo style), `narration.txt` nếu `voice=tts` |
| 5 | `tts` | script | plan-edit | `options.voice == "tts"` | gpu | `narration.wav`, `captions.json` |
| 6 | `cut` | script | plan-edit | – | cpu | `cuts/` |
| 7 | `assemble` | script | cut (optional: tts) | – | cpu | `full-episode.mp4` (phụ đề/chữ theo `edit-plan.json`) |
| 8 | `thumbnail-candidates` | script | cut | – | – | `thumbnails/` (directory, 3 png không chữ) |
| 9 | `library-export` | script | assemble, thumbnail-candidates, plan-edit | – | – | `export-receipt.json` (item_id, đường dẫn kho, checksum); ghi `items/<item_id>/` với `status: pending_review` |
| 10 | `library-review` | gate | library-export | – | – | `review.json` `{ decision: approved\|rejected, note }`; stage này không ghi kho |
| 11 | `library-apply-review` | script | library-review | – | – | đọc `review.json`, ghi `manifest.status` và `review` vào kho, cập nhật request (`fulfilled` khi approved, `open` kèm ghi chú khi rejected); output `apply-receipt.json` |

`intake` là stage duy nhất đổi request sang `claimed`. Khi `rejected`, run vẫn kết thúc SUCCEEDED (mục kho ở `rejected`); người `retry --stage plan-edit` (artifact downstream STALE theo graph, chạy lại từ đó) hoặc plan run mới. Người duyệt ngoài workspace có thể dùng `harness library review` thay cho gate; khi đó `library-review` vẫn phải được nộp (`review.json` ghi cùng quyết định) để run đóng.

Option của profile `studio`: `voice: [none, tts, original]`, `subtitles: ["true","false"]`. Không có `avatar` (kho không cần host; kênh cần avatar là workflow khác sau này).

Checker: như 2B cho media (`media-probe`, `duration-range` theo profile, `edl-valid`, `clip-set-complete`, `audio-integrity`) cộng hai checker mới: `brief-duration` (so thời lượng `full-episode.mp4` với `target_duration_seconds` trong `brief.json`, vì khoảng của request có thể hẹp hơn profile; skip khi brief không khai) và `library-export-valid` (mọi file trong `export-receipt.json` tồn tại trong kho với đúng checksum).

### 3.3 Gate hôm nay, agent ngày mai

`analyze-style`, `survey-source`, `plan-edit`, `style-review`, `library-review` là gate: `brief.md` mô tả việc, người mở phiên Claude/Codex trong workspace, dùng `watch`/AI vision, ghi output, `stage submit`. Sub-project 4 đổi `executor` sang `agent` với skill tương ứng; workflow và checker không đổi.

---

## 4. Module `library` trong core và CLI

### 4.1 Core (`packages/core/src/library/`)

- `LibraryFs` (files.ts): `paths(root)`, `readJson<T>(path, schema)`, `writeJsonAtomic(path, value)`, `copyFileWithChecksum(src, dest)`, `listItems()`, `listRequests()`, `listStyles()`. Từ chối ghi ngoài thư mục được phép theo `role` (`CONFIG_INVALID`).
- `syncLibrary({ store, fs, role, clock })` → `SyncReport { imported: {...}, updated: {...}, corrupt: [{ path, reason }], missing: [{ kind, id }] }`: đọc mọi file, validate schema, so `updated_at` với bản trong DB, nhập/cập nhật; file hỏng schema hay lệch checksum → `corrupt`, không nhập; mục trong DB không còn file → `missing` (không xóa DB). Vai studio ghi lại `index.json`.
- `exportItem({ store, fs, run, artifacts, brief, clock })` → `LibraryItem`: tạo `item_id`, copy `episode.mp4`, `thumbnails/*.png`, `captions.json`, `edit-plan.json` với checksum, ghi `manifest.json` (`pending_review`), trả receipt. Idempotent theo `run_id` (chạy lại thì ghi đè cùng `item_id` lấy từ receipt cũ trong workspace hoặc từ DB).
- `requests.ts`: `claimRequest(id, run)`, `fulfillRequest(id, item_id)`, `rejectRequest(id, note)`, `reopenRequest(id, note)`; mỗi hàm đọc file, kiểm trạng thái hợp lệ, ghi nguyên tử.
- `applyReview({ fs, item_id, decision, note, by })`: đổi `manifest.status`, `review`, rồi gọi `fulfillRequest`/`reopenRequest`.
- `claimItem({ fs, item_id, channel_id, portfolio_id })` (vai channel): ghi `claims/<channel_id>.json`; tạo `ContentItem` cục bộ với `library_item_id`.

### 4.2 CLI `harness library …`

| Lệnh | Vai | Việc |
|---|---|---|
| `library sync [--json]` | cả hai | `syncLibrary`; exit 1 nếu có `corrupt` |
| `library list items|requests|styles [--status s] [--json]` | cả hai | liệt kê từ DB cục bộ (sau sync) |
| `library request create --portfolio p [--channel c] --topic "…" [--style style_… ] [--duration min,max] [--voice tts] [--language vi] [--count 1] [--due 2026-10-01] [--json]` | channel | tạo request `open` |
| `library review <item_id> --approve|--reject [--note "…"]` | studio | `applyReview` không qua workflow (khi người duyệt bằng mắt ngoài gate) |
| `library pick <item_id> --channel c [--json]` | channel | `claimItem`; in `content_id` để `plan --content` |
| `library styles show <style_id>` | cả hai | in style |
| `doctor` | cả hai | thêm hàng `library:root` (tồn tại, đọc được), `library:write` (ghi thử vào thư mục theo vai rồi xóa), `library:index` (parse được nếu có) |

Worker: khi `project.yaml.library` có, mỗi lượt `runOnce` rảnh gọi `syncLibrary` (giới hạn một lần mỗi `library.sync_seconds`, mặc định 300) để request mới tự vào DB; không tự plan run.

### 4.3 Bảo mật và ranh giới

- Kho không chứa secret; manifest không chứa đường dẫn máy khác ngoài `lineage` (id, không path).
- `core` không import adapter; kho là filesystem thuần.
- Đường dẫn `library.root` nằm trong `project.yaml` của máy, không trong harness.

---

## 5. Chỗ nối với phần 2 (sub-project 3)

- Ops project vai `channel` không chạy stage sản xuất; `library pick` tạo `ContentItem` trỏ vào mục kho; workflow `channel-publish` (sub-project 3) có stage đầu `fetch-library-item` (script: copy `episode.mp4` + thumbnail vào workspace theo checksum, fail `contract` nếu mục không còn `approved`), rồi `package` (gate/agent: tiêu đề, mô tả, tags, thumbnail có chữ theo brand), `package-qc` (gate), `upload` (adapter YouTube, idempotent), `schedule`, `collect-stats`.
- Một mục kho có thể được nhiều kênh `pick`; `claims/` cho thấy ai đã lấy; policy kênh (sub-project 3) quyết định có cho trùng không.
- Phần 2 tạo request khi lịch thiếu tập, khi số liệu chỉ ra đề tài thắng, hoặc do người gõ tay. Spec này chỉ cung cấp `library request create`; logic tự sinh request là sub-project 3.

---

## 6. Xử lý lỗi

| Tình huống | Hành vi |
|---|---|
| `library.root` không mount / không ghi được | `doctor` báo; `library-export`, `library-apply-review`, `style-export` fail `transient` → retry theo backoff; stage khác vẫn chạy |
| File trong kho hỏng schema/checksum | `sync` liệt kê `corrupt`, không nhập; mục coi như chưa tồn tại tới khi chủ ghi lại |
| Hai máy cùng sửa một file | Không xảy ra theo 1.2/2.3; claim là file riêng theo kênh |
| Hai run `intake` nhận cùng request | `claimRequest` đọc file ngay trước khi ghi; request đã `claimed` bởi run khác → `intake` fail `contract` (chờ người); người hủy một run |
| Style `retired` giữa chừng | Run dùng snapshot `style_id@revision` trong `brief.json` |
| Mục `rejected` | Run vẫn SUCCEEDED; request về `open` kèm ghi chú; `retry --stage plan-edit` (artifact downstream STALE theo graph) hoặc plan run mới |
| Mục `withdrawn` sau khi kênh đã `pick` | `sync` máy kênh báo `withdrawn`; `fetch-library-item` fail `contract`; người `cancel` run phát hành |
| `sync` gặp `.tmp-*` | bỏ qua |

---

## 7. Kiểm thử

1. **Unit**: schema ba entity + claim; `writeJsonAtomic` (không để lại file dở khi lỗi giữa chừng); `syncLibrary` với kho giả trong temp dir (thêm, cập nhật theo `updated_at`, hỏng checksum, mất file, `.tmp-*`); vòng đời request; `exportItem` idempotent; quyền ghi theo `role`.
2. **Integration** (`fixtures/ops-project-studio`, `fixtures/ops-project-channel`, kho trong temp dir): channel `request create` → studio `sync` → `plan library-production` với wrapper giả (tái dùng `_media.mjs`, `cut`, `assemble` của fixture footage; `intake`, `thumbnail-candidates`, `library-export`, `library-apply-review` là wrapper mới) → gate `survey-source`, `plan-edit` nộp qua `stage submit` → export → `library review --approve` → channel `sync`, `pick` → `ContentItem` có `library_item_id` và file mp4 đọc được từ kho. `style-study` với sample sinh bằng ffmpeg: `collect-samples` chụp 3 khung, gate `analyze-style` nộp `style.json`, `style-export` ghi kho, channel `sync` thấy style.
3. **Acceptance mới**: (17) mục `pending_review`/`rejected`/`withdrawn` không bao giờ được `pick`; (18) một file hỏng trong kho không làm `sync` bỏ các mục khác; (19) request bị hai run tranh thì chỉ một run đi tiếp.

---

## 8. Definition of Done sub-project 2C

- Hai fixture project dùng chung một kho temp: request → dựng → export → duyệt → pick, chạy hết bằng CLI với wrapper giả; `doctor` xanh ở cả hai vai.
- `style-study` ra một `EditStyle` `active` trong kho và một request chỉ định style đó được `intake` chấp nhận.
- Acceptance 17, 18, 19 pass; `pnpm test` xanh.
- Runbook `content-library.md`: mount kho, khai `library` trong `project.yaml`, chu trình hằng ngày ở mỗi máy, xử lý sự cố.
- ADR ghi: kho là file, mỗi file một chủ ghi, ba bảng `library` là bản sao không qua `transition()`.

---

## 9. Ngoài phạm vi

- Tải video mẫu từ YouTube, gọi yt-dlp hay trình duyệt (việc của người/agent trong gate với skill `watch`).
- Workflow phát hành, adapter YouTube, tự sinh request từ số liệu (sub-project 3).
- Agent runtime (sub-project 4).
- Đồng bộ real-time, nhiều kho, khóa phân tán, dọn kho tự động.
- Thumbnail có chữ, bao bì theo brand (phần 2).

## 10. Rủi ro và điểm mở

- **NAS/Drive chậm hoặc rename không nguyên tử** (một số mount SMB/Drive sync client): ghi nguyên tử dựa vào rename cùng thư mục; nếu mount không đảm bảo, `sync` vẫn an toàn nhờ checksum, chỉ có thể thấy mục muộn. Ghi rõ trong runbook mount nào đã thử.
- **`updated_at` phụ thuộc đồng hồ hai máy**: chỉ dùng để nhận bản mới hơn của cùng một file do cùng một chủ ghi, nên lệch đồng hồ không gây mất dữ liệu, chỉ có thể trì hoãn nhận bản mới; `sync` so thêm checksum nội dung.
- **Kho lớn**: `sync` đọc mọi manifest mỗi lần; đủ cho vài nghìn mục; `index.json` giúp `list` nhanh; cursor/phân trang để sau.
- **Gate nhiều**: phần 1 hôm nay có 5 gate cần người; đây là chi phí tạm tới sub-project 4.

## Ghi chú sau khi triển khai

§3.2 và §6 nhắc `retry --stage plan-edit` như một cách làm lại sau khi `library-review` từ chối. Đường đó
không tồn tại: `harness retry --stage <key>` chỉ đưa một stage đang `FAILED`/`WAITING_HUMAN` về `READY`
(`packages/cli/src/commands/retry.ts`), còn một run bị `rejected` kết thúc **SUCCEEDED** với **mọi** stage
`SUCCEEDED` — từ chối là một kết quả bình thường của workflow (`library-apply-review` vẫn `SUCCEEDED`), không
phải lỗi khiến stage nào đó rớt trạng thái. `retry --stage plan-edit` trên một run như vậy không tìm thấy
stage nào để chuyển và in `nothing to retry`, không chạy lại gì cả (xác nhận bằng test tích hợp
`tests/integration/library-pipeline.test.ts`, kịch bản "a rejected review reopens the request").

Hành vi thật sự đã triển khai: `library-apply-review` gọi `reopenRequest` đưa request về `open` kèm ghi chú
duyệt; người vận hành `harness library accept --request <cùng id>` lại (build một `library_brief`/
`ContentItem` mới) rồi `harness plan` một **run mới** cho request đó — không phải retry run cũ. Xem
`docs/runbooks/content-library.md` mục 3b và ADR-0001 mục 60.

### `count` của một content request ghim ở 1

Spec để `count` mở ("bao nhiêu tập cho một yêu cầu"). Bản triển khai ghim `ContentRequestSchema.count =
z.literal(1)`: `intake` là nơi duy nhất chuyển `open → claimed` và không có đường nào cho một run thứ hai
claim lại một request đang `claimed`, nên `count > 1` sẽ để request kẹt `claimed` vĩnh viễn sau tập đầu
tiên (`fulfillRequest` chỉ đóng request khi `item_ids.length >= count`, còn `reopenRequest` thì mất luôn
tập đã duyệt khỏi vòng). Cần nhiều tập cho cùng một chủ đề thì tạo nhiều request. Mở lại giới hạn này cần
một cơ chế re-claim (request `claimed` cho phép một run mới nhận phần còn thiếu) — chưa làm ở 2C.

### Chi phí của `library sync`

`syncLibrary` chỉ hash lại file dữ liệu của item **mới hoặc đã đổi** (so manifest đọc từ kho với hàng mirror
trước khi verify), vì worker tự sync mỗi `sync_seconds` và bản đầu tiên đọc lại toàn bộ byte của kho qua
mount ở mỗi lần rảnh việc. Hệ quả có chủ ý: một file dữ liệu bị sửa **sau** khi item đã import không lộ ra ở
sync thường — `harness library sync --verify` (`syncLibrary(d, { verify: true })`) là đường audit đọc lại tất
cả. Ghi trong runbook `content-library.md` mục 7.
