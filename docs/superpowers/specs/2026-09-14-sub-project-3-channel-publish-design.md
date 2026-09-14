# Sub-project 3: Phát hành kênh — máy channel lấy mục kho đã duyệt, đóng gói và đưa lên YouTube; dashboard theo file

**Ngày:** 2026-09-14
**Trạng thái:** Đã duyệt thiết kế qua brainstorming, chờ implementation plan
**Tiền đề:** Sub-project 1, 2A, 2B, 2C đã merge vào `main` (2026-09-14, `558005a`). Spec này chỉ mô tả phần thêm vào; mọi thứ không nhắc tới giữ nguyên như các spec trước (`2026-09-11-harness-structure-and-control-plane-design.md`, `2026-09-12-sub-project-2-footage-production-design.md`, `2026-09-14-sub-project-2c-content-library-design.md`).
**Tham khảo:** blueprint mục 5 (data root `publications/`), 8.3 (đóng gói và xuất bản), 9 (máy trạng thái Publication), 11 (external effect), 13 (`channel.yaml` mẫu), giai đoạn 3; spec 2C §5 (chỗ nối với phần 2); script phát hành của hệ thống cũ trên `D:\<kênh>\scripts\` (`upload-youtube-playwright.mjs`, `publish-video-playwright.mjs`, `arm-publish.mjs`, `reconcile-queue.mjs`, `publish-window.mjs`, `lib/youtube-limits.mjs`); tài liệu bàn giao dashboard `huong-dan-dung-fleet-dashboard.md` (chỉ để lấy bố cục và các bẫy đã dính).

---

## 0. Quyết định đã chốt trong brainstorming

| Chủ đề | Quyết định |
|---|---|
| Sub-project 3 là gì | "Phần 2" của hệ thống: ops project vai `channel` lấy `LibraryItem` đã `approved` (qua `library pick` có sẵn), đóng gói theo kênh và đưa lên YouTube; cộng một dashboard đọc trạng thái toàn máy kênh từ file. |
| Đường upload | **Bọc script Playwright cũ** của repo kênh (`upload-youtube-playwright.mjs` upload PRIVATE qua Chrome profile `.upload-profile` đã đăng nhập; `publish-video-playwright.mjs --schedule` đặt lịch native trên YouTube). Không dùng YouTube Data API. Harness không bao giờ gõ mật khẩu/2FA; đăng nhập lần đầu là việc của người. |
| Phạm vi | Phát hành + reconcile: `fetch-library-item → package → build-package → upload → schedule` và sweep `verify`. Thu số liệu, đánh giá giả thuyết, tự sinh `ContentRequest` để **sub-project 3B**. |
| Số kênh | **Nhiều kênh một ops project** (một máy = một state); mỗi kênh một `channels/<id>/channel.yaml` trỏ tới repo kênh cũ. |
| Người duyệt | **Không có gate nào.** Từ `pick` tới hẹn lịch chạy tự động; `package` là stage `agent`. |
| Package | Stage `agent` (skill `channel-package`): đọc hướng SEO của kênh + mục kho + dữ liệu thị trường (được tìm web), đề xuất phương án, **ghi giả thuyết bắt buộc** (`hypothesis`) cùng metadata; checker tự động chặn gói lỗi. |
| Agent runtime | **Kéo `@harness/adapter-agent-cli` vào SP3**: hiện thực `AgentRuntime` bằng cách spawn CLI của máy (`claude -p` / `codex exec`) headless trong workspace. Năm gate của kho (2C) vẫn là gate cho tới SP4. |
| Dùng chung kho | **Cho phép**: một mục kho phát được trên nhiều kênh, mỗi kênh gói riêng theo hướng SEO của kênh (cùng hướng hoặc khác hướng). Không có cờ cấm. |
| Đo giả thuyết | **Giữa các tập** (mỗi tập một phương án, so số liệu sau vài tập; không sửa video đã lên). SP3 ghi + liệt kê; SP3B đo. |
| Kiến trúc | **Phương án B**: module `distribution` trong core, bảng `channel_package` + `publication_job` với máy trạng thái riêng, stage built-in chạy qua CLI con (khuôn 2C), cổng `Publisher` với hai implementation (`playwright`, `fake`). Đã loại: A (wrapper trong từng ops project, 10 kênh 10 bộ wrapper, job không có bảng); C (viết lại upload Playwright trong harness, mất kinh nghiệm chống lỗi của script cũ). |
| Ghi vào repo kênh cũ | Harness được ghi **chỉ dưới** `outputs/<legacy_project_id>/episodes/episode-NN/`, `outputs/<legacy_project_id>/publish-queue.json` (script cũ tự ghi) và `work/`. Không sửa `scripts/`, `channel.config.json`, `.upload-profile/`. |
| Run và job | Run `channel-publish` SUCCEEDED nghĩa là "đã hẹn lịch trên YouTube". Video lên public đúng giờ hay không do sweep `verify` theo dõi trên `PublicationJob`; không giữ run mở chờ giờ phát. |
| Dashboard | Mặt đồng hồ **chỉ đọc**, một server file lõi Node + một `hub.html`, dữ liệu là **ảnh chụp** `snapshot.json` do harness sinh (không phải `config.json` ghi hai chiều như tài liệu bàn giao). Không `POST`, không `_rev` ở SP3. |

---

## 1. Cấu trúc thêm vào

### 1.1 Harness (repo này)

```
workflows/channel-publish/workflow.yaml          # 5 stage, §3
production-profiles/channel/profile.yaml         # profile_id `channel` (mở rộng enum)
skills/channel-package/SKILL.md                  # skill đầu tiên của harness
packages/core/src/distribution/                  # channels, packages, publication, verify, reconcile, checkers  §4.1
packages/core/src/dashboard/snapshot.ts          # dựng snapshot từ store  §6
packages/adapters/youtube-playwright/            # Publisher thật + scripts/lookup.mjs  §4.2
packages/adapters/agent-cli/                     # AgentRuntime thật  §4.3
packages/adapters/fake/src/fake-publisher.ts     # Publisher giả cho test
packages/dashboard/{src/server.ts,public/hub.html}   # §6
packages/cli/src/commands/{channel,publish,publish-stage,dashboard}.ts
migrations/0004_distribution.sql
fixtures/ops-project-channel/                    # mở rộng: channels/, repo kênh giả  §7
fixtures/legacy-channel-repo/                    # repo kênh giả (script giả ghi publish-queue.json)
docs/runbooks/channel-publish.md
```

### 1.2 Operations project vai `channel`

```
ops-project-channel/
  project.yaml            # library { root, role: channel }, workflows: [channel-publish@1.0.0],
                          # resources { browser: 1 }, adapters { publisher, agent }, dashboard { port, refresh_seconds }
  channels/
    cham-soc-cha-me/channel.yaml
    thu-nhap-sau-60/channel.yaml
  source-catalog/sources.yaml   # rỗng: kênh không có source
```

Không có `executors/`: mọi stage của `channel-publish` là built-in. Ops project vẫn có thể ghi đè một stage bằng `executors/scripts.yaml` cùng tên script (cơ chế 2C).

`project.yaml` thêm (schema `ProjectConfigSchema`, `.strict()`):

```yaml
adapters:
  publisher: playwright | fake     # mặc định fake
  agent: cli | fake                # mặc định fake
publication:
  verify_seconds: 900              # sweep verify của worker, tối thiểu 60
  verify_grace_hours: 2            # SCHEDULED quá scheduled_at + grace mà chưa public → NEEDS_RECONCILIATION
dashboard:
  port: 5200
  refresh_seconds: 60              # worker làm mới snapshot khi rảnh, tối thiểu 10
```

### 1.3 `channels/<channel_id>/channel.yaml` (schema `harness.channel/v1`, Zod + JSON schema sinh, `.strict()`)

```yaml
schema_version: harness.channel/v1
channel_id: cham-soc-cha-me            # ^[a-z0-9][a-z0-9-]*$, phải bằng tên thư mục
display_name: Caring For Mom And Dad
portfolio_id: portfolio-channel        # phải có trong project.yaml.portfolios
color: "#5f4838"                       # dashboard
repo_dir: D:/cham-soc-cha-me           # gạch xuôi; repo kênh cũ
legacy_project_id: project-01          # outputs/<legacy_project_id>/episodes/...
youtube:
  expected_channel_id: UCh1kFa0ON1PNNQS5Roqdjhw
  account_email_ref: secret://youtube/cham-soc-cha-me/email   # env HARNESS_SECRET_YOUTUBE_CHAM-SOC-CHA-ME_EMAIL
publication:
  timezone: America/New_York
  publish_times: ["13:00"]             # HH:mm theo timezone, ≥1
  max_daily_uploads: 1
  min_gap_hours: 20
  visibility_default: private          # chỉ private; public do lịch native
seo:
  niche: "..."
  audience: "..."
  angle: "..."                         # hướng SEO của kênh, đầu vào chính của skill channel-package
  language: en
  market: US
  keywords: [...]
  title_rules: "..."                   # văn bản tự do đưa vào brief
  description_template: |              # văn bản có {chapters}, {playlist_url}, {channel_name}
    ...
episode:
  start: 15                            # số tập đầu tiên harness cấp
  dir_pattern: "episode-{nn}"          # {nn} = 2 chữ số tối thiểu
overlay:
  enabled: true                        # có gọi gen-thumb-overlay.mjs không
  side: right
```

Quy tắc secret như 2B: `account_email_ref` chỉ là ref; giá trị đọc từ env `HARNESS_SECRET_<SCOPE>_<NAME>`. Script cũ tự đọc `youtube.accountEmail` từ `channel.config.json` của repo kênh để làm cổng chặn nhầm kênh; harness **không** truyền email cho script. Giá trị ref chỉ dùng ở checker `channel-identity` và doctor `channel:<id>:identity` để đối chiếu với `channel.config.json.youtube.accountEmail` (lệch hoặc thiếu → fail), và Redactor xóa nó khỏi mọi log. Tiến trình agent **không** nhận `HARNESS_SECRET_*`.

`config_revision` của kênh = sha256 canonical của `channel.yaml`; lưu vào `ChannelPackage.channel_config_revision`.

### 1.4 Data root máy kênh

Thêm `publications/<channel_id>/<publication_job_id>/` (`package-manifest.json`, `upload-receipt.json`, `schedule-receipt.json`, ảnh chụp Studio do script cũ trả nếu có) và `dashboard/{snapshot.json,thumbnails/<pkg_id>.png}`.

### 1.5 Repo kênh cũ (chỉ đọc + hai chỗ ghi)

Harness đọc: `scripts/upload-youtube-playwright.mjs`, `scripts/publish-video-playwright.mjs`, `scripts/gen-thumb-overlay.mjs` (tùy chọn), `scripts/open-channel-chrome.mjs` (tùy chọn), `channel.config.json` (chỉ `youtube.channelId`, `projectId`), `.upload-profile/` (tồn tại hay không).
Harness ghi: `outputs/<legacy_project_id>/episodes/episode-NN/{full-episode/episode-NN-full-episode.mp4, thumbnails/*.png, publish/episode-NN-upload-manifest.json}`; script cũ tự ghi `publish-queue.json`, `publish/upload-debug/`, `work/research/upload-blocked.json`.

---

## 2. Mô hình dữ liệu

### 2.1 `ChannelConfig` (contracts, mới)

Schema §1.3. Nạp bởi `ChannelRegistry` (§4.1), không có bảng: cấu hình là file như `project.yaml`.

### 2.2 `Hypothesis` (contracts, mới; `harness.hypothesis/v1`, `.strict()`)

```
{ schema_version, hypothesis_id: "hyp_…",
  basis:    [{ kind: market | channel | manual, note: string, evidence_ref?: string }]  (≥1),
  chosen:   { title, thumbnail_candidate: string (tên file trong thumbnail_set), overlay_text: string[] (0–3 dòng), angle },
  rejected: [{ title, angle, why }]  (≥1),
  expected: { metric: ctr | views_72h | avg_view_pct, target: number, horizon_hours: int ≥ 24 },
  status: open | supported | refuted | void,     # SP3 chỉ ghi `open`
  created_at }
```

### 2.3 `ChannelPackage` (mở rộng schema hiện có, `pkg_`, `.strict()`)

Giữ: `package_id`, `channel_id`, `variant_id`, `manifest_digest`, `video_artifact_id`, `thumbnail_artifact_id`, `metadata_revision`, `channel_config_revision`, `created_at`.
Thêm: `content_id`, `library_item_id`, `run_id`, `episode_no: int`, `episode_dir: string` (tuyệt đối, gạch xuôi), `metadata { title, description, tags[], playlists[], hashtags[], pinned_comment, category_id?, language }`, `hypothesis: Hypothesis`, `video_checksum`, `thumbnail_checksum`, `status: draft | committed`.
`manifest_digest` = sha256 canonical của `upload-manifest.json` đã ghi vào repo kênh. `metadata_revision` = 1 ở SP3 (sửa metadata sau khi lên là ngoài phạm vi).

### 2.4 `PublicationJob` (mở rộng schema hiện có, `pub_`, `.strict()`)

Giữ: `publication_job_id`, `package_id`, `idempotency_key`, `state`, `youtube_video_id`, `receipt`, `created_at`, `updated_at`.
Thêm: `channel_id`, `library_item_id`, `run_id`, `operation_id: string | null` (ExternalOperation của upload), `scheduled_at: timestamp | null`, `published_at: timestamp | null`, `last_verified_at: timestamp | null`, `note: string | null`.
`idempotency_key = sha256(channel_id + ":" + video_checksum + ":" + manifest_digest)`.

### 2.5 Bảng mới (migration `0004_distribution.sql`)

`channel_package` (json + cột `channel_id`, `run_id`, `library_item_id`, `status`, `episode_no`), `publication_job` (json + cột `channel_id`, `state`, `scheduled_at`, `library_item_id`, `idempotency_key` UNIQUE), `channel_sequence(channel_id PRIMARY KEY, next_episode_no)`, `dashboard_snapshot(id = 1, generated_at)` (chỉ mốc thời gian; nội dung là file). Cột `state` của `publication_job` chỉ đổi qua `transitionPublication()`.

### 2.6 Máy trạng thái `PublicationJob`

```
DRAFT → READY                       build-package commit gói và mọi checker pass (job tạo sẵn ở READY)
READY → UPLOADING                   stage upload ghi ExternalOperation intent
UPLOADING → PROCESSING              script trả videoId; op CONFIRMED
UPLOADING → NEEDS_RECONCILIATION    op lost: script thoát mà không đọc được videoId, hoặc timeout
PROCESSING → SCHEDULED              stage schedule đặt lịch native thành công; scheduled_at
SCHEDULED → PUBLISHED               sweep verify thấy public sau scheduled_at
SCHEDULED → NEEDS_RECONCILIATION    quá scheduled_at + verify_grace_hours mà chưa public / không đọc được
NEEDS_RECONCILIATION → PROCESSING   reconcile tìm thấy video (chưa có lịch)
NEEDS_RECONCILIATION → SCHEDULED    reconcile thấy lịch còn (video private có publish_at tương lai)
NEEDS_RECONCILIATION → PUBLISHED    reconcile thấy public
NEEDS_RECONCILIATION → READY        reconcile không thấy video: op FAILED, cho phép upload lại
READY | PROCESSING | SCHEDULED → FAILED      người `publish cancel` (không đụng video trên YouTube)
```

Enum `PUBLICATION_STATES` hiện có đủ. Mỗi chuyển ghi `Event` (`publication.<to lowercase>`), `entity_type: "publication_job"`.

### 2.7 Lineage

```
LibraryItem ─pick─▶ ContentItem { library_item_id, library_channel_id } ─plan─▶ Run channel-publish
  ─build-package─▶ ChannelPackage { content_id, library_item_id, run_id, episode_no }
  ─upload─▶ PublicationJob { package_id, operation_id } ─▶ ExternalOperation { kind: youtube-upload }
```

Hai kênh cùng mục kho: hai `ContentItem`, hai run, hai gói, hai job, hai `idempotency_key` khác nhau (khác `channel_id`).

---

## 3. Workflow `channel-publish@1.0.0` (profile `channel`)

| # | Stage | Executor | Input | Output | Checker |
|---|---|---|---|---|---|
| 1 | `fetch-library-item` | script built-in `publish-fetch` | `ContentItem` của run | `episode_video` (episode.mp4), `thumbnail_set` (dir), `library_brief` (brief.json = manifest + `title_hint`, notes, style), `captions?` | `schema-valid`, `output-exists`, `checksum-match`, `media-probe` |
| 2 | `package` | `agent`, skill `channel-package` | inputs của 1 + brief dựng từ `channel.yaml.seo`, số tập kế tiếp (chỉ để tham khảo), danh sách ứng viên thumbnail | `channel_package_draft` (package.json: `metadata` + `hypothesis`) | `schema-valid`, `youtube-limits`, `hypothesis-complete` |
| 3 | `build-package` | script built-in `publish-build-package` | 1 + 2 | `channel_package` (package-receipt.json) | `package-integrity`, `channel-identity`, `duplicate-upload` |
| 4 | `upload` | script built-in `publish-upload` | 3 | `upload_receipt` (upload-receipt.json: job_id, video_id, operation_id) | `schema-valid` |
| 5 | `schedule` | script built-in `publish-schedule` | 4 | `publication_receipt` (schedule-receipt.json: scheduled_at) | `schema-valid` |

`depends_on` tuyến tính 1→2→3→4→5. `requires_resources`: stage 4 và 5 `[browser]`; `project.yaml.resources.browser: 1` (một Chrome một lúc trên máy). Không `depends_on_optional`, không `when`.

Hành vi từng stage:

**1 `fetch-library-item`.** Đọc `content.library_item_id` + `library_channel_id` (thiếu → `contract`). Đọc manifest **từ file kho** (`LibraryFs.readJson`), không tin bảng mirror; `status !== "approved"` → `contract` ("item <id> is <status>"); `claims/<channel>.json` thiếu → `contract`. Chép từng file theo `manifest.files` bằng `copyFileWithChecksum` vào `output/`; lệch checksum → `transient` (kho đang ghi dở hoặc lỗi mạng). Ghi `output/brief.json`. Kho không mount → `transient` (`IO_ERROR`).

**2 `package`.** Brief (tiếng Việt, ghi vào `brief.md` của workspace như gate 2B): mô tả kênh (`seo.*` nguyên văn), `title_hint` + notes + `duration_seconds` + `style` của mục kho, đường dẫn thumbnail ứng viên, `description_template`, giới hạn YouTube, yêu cầu **ghi giả thuyết** theo §2.2 và ghi `output/package.json` `{ schema_version: "harness.channel-package-draft/v1", metadata, hypothesis }`. Agent được tìm web (dữ liệu thị trường) và đọc workspace; không có secret. Timeout theo `timeout_seconds` của stage (mặc định 1200). Skill `skills/channel-package/SKILL.md` quy định: cấu trúc mô tả (hashtag đầu, hook, chapters từ `edit-plan.json`, CTA, playlist, disclaimer), quy tắc tiêu đề của kênh, chọn ứng viên thumbnail + `overlay_text` ≤ 3 dòng, cách ghi `basis`/`rejected`/`expected`.

**3 `build-package`.** Trong một transaction: cấp `episode_no` từ `channel_sequence` (khởi tạo bằng `episode.start`), tạo `ChannelPackage` `draft`. Ngoài transaction: `episode_dir = repo_dir/outputs/<legacy_project_id>/episodes/<dir_pattern>`; thư mục đã tồn tại → `contract` (không đè; người sửa `episode.start` hoặc dọn tay), `repo_dir` không có → `transient`. Tạo `full-episode/`, `thumbnails/`, `publish/`; chép video (`copyFileWithChecksum`); thumbnail: nếu `overlay.enabled` và có `scripts/gen-thumb-overlay.mjs` → spawn `node scripts/gen-thumb-overlay.mjs --bg <ứng viên> --out thumbnails/opt1.png --line1 … --line2 … [--line3 …] --side <side> --ep NN` (cwd `repo_dir`, timeout 300 s; exit ≠ 0 → `transient`), ngược lại chép ứng viên thô; ghi `publish/episode-NN-upload-manifest.json` theo template cũ (`videoPath`, `thumbnailPath` tuyệt đối gạch xuôi, `visibility: "private"`, `title`, `description`, `playlists`, `tags`, `pinnedComment`, `hashtags`); cập nhật gói `committed` với `manifest_digest`, checksum; tạo `PublicationJob` `READY` với `idempotency_key`; ghi `output/package-receipt.json` `{ package_id, publication_job_id, episode_no, episode_dir, manifest_path, video_checksum, thumbnail_checksum, manifest_digest }`; chép manifest + thumbnail vào `publications/<channel>/<job>/` và `dashboard/thumbnails/<pkg_id>.png`. Attempt chạy lại cùng stage: đọc gói `draft` của `run_id` nếu có, không cấp số tập mới.

**4 `upload`.** Đọc receipt; job phải `READY` (khác → `contract`). Trong transaction: `READY → UPLOADING`, ghi `ExternalOperation` `INTENT_RECORDED` `{ kind: "youtube-upload", target: channel_id, payload: { idempotency_key, episode_no, manifest_digest } }`, `job.operation_id`. Gọi `Publisher.upload({ channel, episode_no, episode_dir, intent_at })`. Kết quả: `{ video_id }` → op `CONFIRMED` (`provider_ref = video_id`, receipt), `UPLOADING → PROCESSING`, `job.youtube_video_id`; `{ unknown: true }` → op `NEEDS_RECONCILIATION`, `UPLOADING → NEEDS_RECONCILIATION`, stage result `outcome: unknown` (stage `NEEDS_RECONCILIATION` như sub-project 1, không retry tự động); `{ refused: true, reason }` (exit 3 của script cũ: sai tài khoản, `upload-blocked.json`, quá giới hạn) → job về `READY`, op `FAILED`, stage fail `contract`; `{ busy: true }` (profile bị khóa, `EXIT_BUSY` = 4) → job về `READY`, op `FAILED`, stage fail `transient`. Attempt chạy lại khi job đã `PROCESSING` (op confirmed nhưng attempt chết trước khi ghi output) → không upload lại, chỉ ghi output.

**5 `schedule`.** Job phải `PROCESSING` (đã `SCHEDULED` → ghi output từ job, idempotent). `scheduled_at = nextSlot(channel.publication, jobs SCHEDULED|PUBLISHED của kênh, now)` — khung `publish_times` gần nhất trong tương lai sao cho: chưa có job cùng khung, số job trong ngày (theo timezone) < `max_daily_uploads`, cách job gần nhất ≥ `min_gap_hours`; đẩy ngày tới khi cần, tối đa 60 ngày (quá → `contract`). Gọi `Publisher.schedule({ channel, video_id, at })`; thành công → `PROCESSING → SCHEDULED`; `busy` → `transient`; `refused` → `contract`; lỗi không rõ (script chết giữa chừng) → `transient` và lần sau `lookup` trước: nếu YouTube đã có lịch thì chỉ ghi nhận.

Profile `production-profiles/channel/profile.yaml`: `profile_id: channel`, `workflow_release: channel-publish@1.0.0`, `options_schema: { overlay: [auto, none] }`, defaults `overlay: auto`, `limits: { max_cost_usd_per_variant: 3, max_concurrency: 1 }`, `content: {}`.

---

## 4. Core, adapter, CLI

### 4.1 Core `packages/core/src/distribution/`

- `channels.ts`: `loadChannels(projectDir): ChannelConfig[]` (đọc `channels/*/channel.yaml`; yaml lỗi/`channel_id` khác tên thư mục/trùng → `CONFIG_INVALID`; `portfolio_id` không có trong project → `CONFIG_INVALID`); `ChannelRegistry { get(id), list(), revisionOf(id) }`.
- `packages.ts`: `allocateEpisode(store, channel)`, `createDraftPackage`, `commitPackage`, `findDraftForRun(runId)`, `youtubeLimits()` (`title 100`, `description 5000`, `tags tổng 500 ký tự`, `tag đơn 100`, `playlist 150`), `buildUploadManifest(pkg, channel): object` (thuần), `manifestDigest`.
- `publication.ts`: `PUBLICATION_TRANSITIONS`, `transitionPublication(store, jobId, from, to, event)` (sai → `INVALID_TRANSITION`), `createJob`, `idempotencyKeyFor`, `nextSlot(publication, existing: { scheduled_at }[], now, tz): string` (thuần, dùng `Intl.DateTimeFormat` với `timeZone`, không thư viện ngoài).
- `verify.ts`: `verifyScheduled({ store, publisher, clock, graceHours }): VerifyReport` — mỗi job `SCHEDULED` có `scheduled_at + grace ≤ now`: `publisher.lookup({ video_id })` → `public` → `PUBLISHED` (`published_at` từ lookup hoặc now); `private`/`scheduled` với `publish_at` tương lai → giữ, cập nhật `scheduled_at` nếu lệch; `not_found`/`private` không lịch/lỗi mạng hai lần liên tiếp → `NEEDS_RECONCILIATION` với `note`. Job `PROCESSING` quá 24 h không lịch → chỉ cảnh báo (`alerts`). Cập nhật `last_verified_at`.
- `reconcile.ts`: `reconcilePublication({ store, publisher, planner, clock }, jobId)` cho job `NEEDS_RECONCILIATION`: có `youtube_video_id` → `lookup({ video_id })`; không có → `lookup({ channel, title: pkg.metadata.title, since: op.created_at })` (Studio, đọc danh sách video mới nhất, khớp tiêu đề và thời điểm). Tìm thấy → sửa job (`video_id`, trạng thái theo §2.6), op → `CONFIRMED`, rồi nếu stage `upload` của run đang `NEEDS_RECONCILIATION` → gọi `reconcileOperation` có sẵn (stage về READY, planner đi tiếp; stage `upload` attempt mới thấy job `PROCESSING` thì chỉ ghi output). Không thấy → op `FAILED`, job `READY`, stage về READY như trên (attempt mới upload lại — đây là lần duy nhất upload lặp, sau khi đã hỏi YouTube).
- `checkers.ts` (`distributionCheckers(deps)`): `youtube-limits` (output `channel_package_draft`), `hypothesis-complete` (`basis ≥1`, `rejected ≥1`, `chosen.thumbnail_candidate` có trong `thumbnail_set`, `expected.target > 0`), `package-integrity` (output `channel_package`: video/thumbnail tại `episode_dir` khớp checksum receipt; manifest parse được, digest khớp), `channel-identity` (`channel.config.json.youtube.channelId === expected_channel_id`, `projectId === legacy_project_id`, `youtube.accountEmail` bằng giá trị resolve của `account_email_ref`), `duplicate-upload` (không job khác `FAILED` cùng `idempotency_key`; không job `PROCESSING|SCHEDULED|PUBLISHED` cùng `library_item_id + channel_id`).

### 4.2 Cổng `Publisher` (contracts) và adapter

```ts
export interface PublisherChannel { channel_id: string; repo_dir: string; legacy_project_id: string; expected_channel_id: string; account_email?: string }
export type UploadOutcome = { video_id: string; receipt: Record<string, unknown> } | { unknown: true; reason: string } | { refused: true; reason: string } | { busy: true; reason: string };
export type LookupOutcome = { found: true; video_id: string; visibility: "public" | "private" | "unlisted" | "scheduled"; publish_at?: string; title?: string } | { found: false; reason?: string };
export interface Publisher {
  readonly name: string;
  upload(p: { channel: PublisherChannel; episode_no: number; episode_dir: string; intent_at: string; timeout_seconds: number }): Promise<UploadOutcome>;
  schedule(p: { channel: PublisherChannel; video_id: string; at: string; timeout_seconds: number }): Promise<{ ok: true } | { refused: true; reason: string } | { busy: true; reason: string }>;
  lookup(p: { channel: PublisherChannel; video_id?: string; title?: string; since?: string }): Promise<LookupOutcome>;
}
```

`@harness/adapter-youtube-playwright` (`PlaywrightPublisher`):
- `upload`: spawn `node scripts/upload-youtube-playwright.mjs episode-NN` (cwd `repo_dir`, env con = env sạch + `YT_ACCOUNT_EMAIL` nếu có, timeout mặc định 2700 s). Sau khi thoát đọc `outputs/<legacy_project_id>/publish-queue.json`: dòng `ep === NN`, `addedAt ≥ intent_at`, `videoId` → `{ video_id }` bất kể exit code; không có dòng: exit 0 → `unknown`; exit 3 → `refused` (đuôi log làm reason); exit 4 (`EXIT_BUSY` của `lib/episode-lock.mjs`) → `busy`; exit khác / timeout → `unknown` (video có thể đã tạo). Stdout/stderr qua Redactor, ghi vào log attempt và `publications/<channel>/<job>/upload.log`.
- `schedule`: spawn `node scripts/publish-video-playwright.mjs <video_id> --schedule <ISO>`; exit 0 → ok; 3 → refused; busy → busy; khác → ném `HarnessError("PROVIDER_ERROR")` (stage `transient`).
- `lookup`: có `video_id` → `fetch("https://www.youtube.com/oembed?url=…")`: 200 → `public` (oEmbed chỉ trả cho public/unlisted); 401/403/404 → cần Studio: spawn `scripts/lookup.mjs` **của adapter** (`packages/adapters/youtube-playwright/scripts/lookup.mjs`, Playwright dùng `.upload-profile` của kênh, **chỉ đọc**: mở Studio content list, lọc theo `video_id` hoặc tiêu đề + ngày, đọc visibility và lịch, in JSON một dòng, không bấm gì). Không có `video_id` và không có `title` → `found: false`.
- Không bao giờ truyền mật khẩu; profile chưa đăng nhập → script cũ dừng exit 3 → `refused` với reason "chưa đăng nhập", runbook chỉ `harness channel login`.

`FakePublisher` (`adapter-fake`): ghi `publish-queue.json` giả đúng dạng vào `episode_dir` cha; nút `lostAfterUpload` (ghi queue rồi trả `unknown`), `refuse`, `busy`, `lookupResult`; đếm `uploadCount`.

### 4.3 `@harness/adapter-agent-cli` (`CliAgentRuntime implements AgentRuntime`)

- Chọn theo `project.yaml.runtime`: `claude` → `claude -p <prompt> --output-format json --permission-mode acceptEdits --allowedTools "Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Bash(ffprobe:*)"`; `codex` → `codex exec --full-auto --json <prompt>`. Lệnh và cờ nằm trong một bảng `RUNTIME_COMMANDS` để sửa một chỗ; ops project ghi đè bằng `project.yaml.adapters.agent_argv` (tùy chọn).
- `cwd` = workspace; env con = env sạch (PATH, HOME/USERPROFILE, TEMP, biến mà CLI cần) **không** `HARNESS_SECRET_*`, không `HARNESS_*` ngoài `HARNESS_WORKSPACE`; prompt = nội dung `skills/<skill>/SKILL.md` + `brief.md` + "đọc `stage-request.json`, ghi output theo skill, không chạm ngoài workspace"; timeout = `timeout_seconds` của stage; stdout ghi log (Redactor); nếu JSON cuối có `total_cost_usd` → `usage.cost_usd`.
- Kết quả: exit 0 và mọi output khai trong stage tồn tại → `succeeded` với outputs; thiếu output → `failed contract`; exit ≠ 0/timeout → `failed transient`; CLI không có trên PATH → `failed contract` (doctor đã báo trước).
- Test: runtime giả là `fixtures/fake-agent-cli.mjs` (đọc prompt từ argv, ghi `output/package.json` mẫu) qua `agent_argv`; test thật `skipIf` không có `claude`/`codex`.

### 4.4 CLI

- `harness channel list [--json]` · `show <id>` · `hypotheses <id> [--json]` (từ `channel_package`) · `login <id>` (spawn `scripts/open-channel-chrome.mjs` của repo, hoặc mở Chrome với `--user-data-dir=.upload-profile` nếu repo không có script; in hướng dẫn, chờ tiến trình đóng).
- `harness publish list [--channel] [--state] [--json]` · `show <job> [--json]` · `slots <channel> [--days 7]` (in các `scheduled_at` sẽ được cấp) · `verify [--json]` (chạy `verifyScheduled` một lần) · `reconcile <job> [--json]` · `cancel <job> --note`.
- `harness reconcile` hiện có thêm `--publication <job>` (gọi `reconcilePublication`).
- `harness publish stage fetch|build-package|upload|schedule` (built-in, chạy trong workspace như `library stage`, đăng ký `publish-fetch|publish-build-package|publish-upload|publish-schedule` vào `builtinCommands`).
- `harness dashboard snapshot [--json]` · `serve [--port]` (§6).
- Doctor: `agent:runtime` (CLI của `runtime` có trên PATH, `--version` chạy được, không gọi model), `publisher` (adapter được chọn), theo kênh `channel:<id>:config`, `:repo` (`repo_dir` tồn tại), `:scripts` (`upload-youtube-playwright.mjs`, `publish-video-playwright.mjs`), `:profile` (`.upload-profile/Default/` tồn tại; không kiểm đăng nhập thật), `:identity` (`channel.config.json.youtube.channelId`), `:secrets` (`account_email_ref` resolve được). Không có `channels/` → không hàng.
- Worker: nhánh idle sau `maybeSyncLibrary`: `maybeVerifyPublications()` mỗi `publication.verify_seconds`, rồi `maybeRefreshDashboard()` mỗi `dashboard.refresh_seconds`; lỗi log, không ném.
- Composition: `AppContext` thêm `channels: ChannelRegistry`, `publisher: Publisher`, `agentRuntime: AgentRuntime` chọn theo `project.yaml.adapters`; `AgentExecutor` nhận runtime này thay `FakeAgentRuntime` cứng.

---

## 5. Skill `channel-package`

`skills/channel-package/SKILL.md` (tiếng Việt, đồng bộ sang `.claude/skills` và `.agents/skills` của ops project bằng `harness skills sync` — lệnh mới, chỉ copy). Nội dung tối thiểu: (1) đọc `brief.md`, `brief.json`, `edit-plan.json`, xem ứng viên thumbnail; (2) tìm web 3–5 video cùng ngách gần đây để lấy mẫu tiêu đề/từ khóa, ghi vào `basis` kind `market`; (3) đề xuất ≥3 tiêu đề, chọn 1, phần còn lại vào `rejected` kèm `why`; (4) mô tả theo `description_template`, chapters từ `edit-plan.json` (mốc giây → `m:ss`), 3 hashtag đầu mô tả, ≤14 tags trong giới hạn; (5) chọn ứng viên thumbnail và `overlay_text` (≤3 dòng, ≤4 từ mỗi dòng); (6) `expected` theo `metric` mặc định `views_72h`, `target` từ trung vị kênh nếu brief có, ngược lại từ đối thủ; (7) ghi `output/package.json`, tự kiểm giới hạn trước khi kết thúc. Không có secret, không upload, không sửa file ngoài `output/`.

---

## 6. Dashboard theo file

### 6.1 Snapshot (`harness.dashboard-snapshot/v1`)

`packages/core/src/dashboard/snapshot.ts`: `buildSnapshot({ store, channels, library?, doctor?, clock }): Snapshot`; CLI/worker ghi `<data_root>/dashboard/snapshot.json` nguyên tử (tmp + rename), đường dẫn trong file luôn gạch xuôi.

```
{ schema_version, project_id, generated_at,
  library: { root, mounted: bool, styles_active: n, requests_open: n, items: { pending_review, approved, rejected, withdrawn } } | null,
  channels: [{ channel_id, display_name, color, publish_times, timezone, language,
               today: { published: n, target: max_daily_uploads },
               login: { profile_dir_exists: bool, last_upload_ok_at: ts | null },
               latest: { episode_no, state, stage_key, run_id } | null,
               episodes_count: n, doctor: [{ row, status: ok | warn | fail, message }] }],
  episodes: [{ job_id, channel_id, episode_no, state, scheduled_at, published_at, video_id, run_id, current_stage,
               package: { title, description, tags, hashtags, playlists, pinned_comment, thumbnail: "thumbnails/<pkg_id>.png" },
               hypothesis: { angle, metric, target } }],
  runs_active: [{ run_id, channel_id, stage_key, state, since }],
  alerts: [{ kind: reconcile | run_failed | gate_overdue | doctor | library_unmounted | missing_today, channel_id?, ref, message, since }],
  market: {} }
```

`today.published` = job `PUBLISHED` hoặc `SCHEDULED` có `scheduled_at` trong ngày theo timezone kênh. `missing_today` khi đã qua khung `publish_times` cuối của ngày mà `published < target`.

### 6.2 Server (`packages/dashboard`)

`src/server.ts` chỉ dùng `node:http`, `node:fs`, `node:path`; không dependency. Route: `GET /hub` (và `/`) → `public/hub.html`; `GET /api/snapshot` → nội dung file (404 kèm `{ error: "no snapshot" }` nếu chưa có); `GET /thumbnails/<file>` → `<data_root>/dashboard/thumbnails/` với `path.basename` từng đoạn; mọi route khác 404. Cổng: `HARNESS_DASHBOARD_PORT` → `project.yaml.dashboard.port` → 5200; bind `127.0.0.1`. `harness dashboard serve` spawn hoặc gọi thẳng `startServer({ dataRoot, port })`; không đọc SQLite. `Cache-Control: no-store` cho `/api/snapshot`; thumbnail có `?v=<generated_at>`.

### 6.3 `public/hub.html`

Một file HTML+CSS+JS, không build, không thư viện. Token và bố cục theo tài liệu bàn giao §8: nền tối ba mức, header (tên project, `generated_at`, nút làm mới), 4 chip (kênh · tập · mục kho đã duyệt · request mở), dải kho (root, mounted, đếm theo trạng thái), tiêu đề "KÊNH (n)", lưới `repeat(auto-fill, minmax(285px, 1fr))` thẻ kênh (viền trên `--c` từ `color`; đầu thẻ: tên + badge; ba ô số: `đăng hôm nay a/b` · `tập` · `tập mới nhất` = nhãn tiếng Việt của `state`/`stage_key`), panel "CẢNH BÁO" (thay panel thị trường; `market` trống thì ẩn panel thị trường), modal kênh: 4 ô số, cài đặt (SEO language, giờ đăng, mục tiêu/ngày, timezone), panel tài khoản (profile có/không, lần upload ok gần nhất, dòng lệnh `harness channel login <id>` để chép), gói đăng tải từng tập (thumbnail 168×94, dòng `nhãn | giá trị | chép` cho tiêu đề, mô tả, tags, hashtag, playlist, lịch; đếm ký tự tiêu đề `.over` khi > 100; chép có phản hồi 1,2 s và fallback `execCommand`; hashtag regex `/#[\p{L}\d_]+/gu`).
Badge: `⚠ reconcile` (job kẹt), `⏳ đang chạy` (run active), `🔑 có profile` / `🔑 chưa profile`, `AUTO` (luôn). Mọi giá trị qua `esc()` trước `innerHTML`. Polling 30 s chỉ khi `runs_active` khác rỗng hoặc có job `UPLOADING`; tắt khi rảnh. Bảng nhãn `STATE_LABEL` và `STAGE_LABEL` trong file. Co được tới 720 px.

### 6.4 Không làm ở SP3

Ghi từ giao diện (`POST`, `_rev`), tình báo thị trường, branding, kiểm đăng nhập thật (headless), dropdown nhiều kho, tài khoản web.

---

## 7. Xử lý lỗi

| Tình huống | Hành vi |
|---|---|
| Mục kho không còn `approved` sau `pick` | `fetch-library-item` fail `contract`; người `cancel` run; `sync` máy kênh báo trạng thái mới |
| Kho không mount | `fetch-library-item` `transient` (backoff); doctor `library:root` fail |
| `repo_dir` không có / không ghi được | `build-package` `transient`; doctor `channel:<id>:repo` fail |
| `episode-NN` đã tồn tại | `build-package` `contract`; sửa `episode.start` hoặc dọn thư mục, `retry --stage build-package` |
| Script cũ exit 3 (sai tài khoản, chưa đăng nhập, `upload-blocked.json`, quá giới hạn) | `upload`/`schedule` `contract`, job về `READY`; runbook: `harness channel login`, xóa `upload-blocked.json` sau khi xử lý |
| Profile bị khóa (`EXIT_BUSY`, cửa sổ `channel login` đang mở) | `transient`, retry theo backoff |
| Script thoát không có videoId | job + op + stage `NEEDS_RECONCILIATION`; `harness publish reconcile <job>` hỏi YouTube trước khi cho upload lại |
| Mất kết nối sau khi video đã tạo | như trên; reconcile tìm thấy → `PROCESSING`, run đi tiếp `schedule`; **không** có video thứ hai |
| Quá giờ hẹn mà chưa public | sweep `verify` → `NEEDS_RECONCILIATION`, alert; người `reconcile` hoặc xử lý trên Studio rồi `reconcile` |
| Agent CLI thiếu / timeout / không ghi output | `contract` / `transient` / `contract`; doctor `agent:runtime` |
| `package.json` vượt giới hạn hoặc thiếu giả thuyết | checker fail → stage `package` FAILED, `retry` chạy agent lại |
| Hết khung trong 60 ngày | `schedule` `contract` (kênh cần nới `max_daily_uploads`) |
| Snapshot lỗi (store bận) | worker log, giữ file cũ; dashboard hiện `generated_at` cũ |

Mọi lỗi từ tiến trình con đi qua Redactor; log của agent và script không bao giờ chứa giá trị secret.

---

## 8. Kiểm thử

- **Unit core**: `nextSlot` (timezone, DST, `max_daily_uploads`, `min_gap_hours`, đẩy ngày, quá 60 ngày); `PUBLICATION_TRANSITIONS` + `transitionPublication` (chuyển sai → `INVALID_TRANSITION`, Event ghi đúng); `allocateEpisode` (hai gói cùng kênh → hai số; khởi tạo từ `episode.start`); `buildUploadManifest` + `manifestDigest` ổn định; năm checker; `loadChannels` (lỗi yaml, trùng id, id khác thư mục, portfolio lạ); `verifyScheduled` và `reconcilePublication` với `FakePublisher` (mọi nhánh §2.6); `buildSnapshot` (đếm, `today`, alert, đường dẫn gạch xuôi).
- **Adapter**: `youtube-playwright` — đọc `publish-queue.json` (dòng cũ bị bỏ, dòng mới nhận), ánh xạ exit code, Redactor trên log, `lookup` oEmbed với `fetch` giả; `lookup.mjs` không test tự động. `agent-cli` — với runtime giả (`fake-agent-cli.mjs`): thành công, thiếu output, timeout, env con không có `HARNESS_SECRET_*` (spy env); test thật `describe.skipIf(!hasCli(runtime))`.
- **Dashboard**: server phục vụ `/hub`, `/api/snapshot` (200/404), chặn `../` ở `/thumbnails`, 404 route lạ; `hub.html` không test tự động (nghiệm thu tay §10).
- **Tích hợp** `tests/integration/publish-pipeline.test.ts` (không cần Chrome, không cần ffmpeg nếu dùng video giả + prober giả; `skipIf` ffmpeg cho phần `media-probe`): thế giới kho từ `library-helpers` với một mục `approved` (ghi tay manifest + file), project kênh với hai `channel.yaml` trỏ tới hai bản `fixtures/legacy-channel-repo` chép vào temp (script giả `upload-youtube-playwright.mjs` ghi `publish-queue.json`, `publish-video-playwright.mjs` ghi `schedule.json`, `channel.config.json` giả), `adapters { publisher: playwright, agent: cli }` với `agent_argv` trỏ `fake-agent-cli.mjs`; `library pick` cho hai kênh → `plan --workflow channel-publish@1.0.0 --profile channel` × 2 → `enqueue` → `drain` → cả hai run SUCCEEDED, hai job `SCHEDULED` với `scheduled_at` khác nhau (browser = 1 nên tuần tự), `episode-15/` trong mỗi repo giả có video + manifest đúng template, `ChannelPackage.hypothesis` đầy đủ, `publish list --json` đúng, `dashboard snapshot` có 2 kênh 2 tập; `publish verify` với lookup giả public → `PUBLISHED`.
- **Acceptance**: **21** upload mất kết nối sau khi tạo video (`lostAfterUpload`) → `NEEDS_RECONCILIATION` → `publish reconcile` tìm thấy → `PROCESSING` → `drain` → `SCHEDULED`; `uploadCount === 1`. **22** `channel.config.json.youtube.channelId` lệch → `channel-identity` chặn ở `build-package`, không có job, không gọi upload. **23** mục kho `withdrawn` sau `pick` → `fetch-library-item` FAILED `contract`. **24** sweep verify: lookup `public` → `PUBLISHED`; `private` không lịch quá grace → `NEEDS_RECONCILIATION` + alert trong snapshot. **25** env của tiến trình agent và log upload không chứa giá trị secret (grep giá trị `HARNESS_SECRET_…`). **26** reconcile không tìm thấy → job `READY`, attempt mới upload lại đúng một lần.

---

## 9. Definition of Done sub-project 3

1. Từ `library pick` tới `PublicationJob` `SCHEDULED` không cần lệnh người nào ngoài `plan`/`enqueue` với worker chạy (test tích hợp).
2. Retry sau lỗi mạng không tạo video thứ hai (acceptance 21, 26).
3. Hai kênh cùng một mục kho phát hành độc lập, gói và số tập riêng.
4. `harness publish list`/`slots` trả lời "kênh nào có gì lên khi nào" từ state; `dashboard snapshot` + `serve` hiện cùng dữ liệu trên `/hub`.
5. Doctor báo đủ: repo kênh, script, profile, identity, secret, agent CLI, publisher.
6. Skill `channel-package` sinh `package.json` qua checker trên máy có `claude` hoặc `codex` (kiểm tay, ghi kết quả vào runbook).
7. Runbook `docs/runbooks/channel-publish.md`: khai kênh, đăng nhập lần đầu, chu trình pick → plan → enqueue, xử lý `NEEDS_RECONCILIATION`, đổi giờ phát, dừng kênh, chạy dashboard, checklist nghiệm thu dashboard.
8. `pnpm build && pnpm typecheck && pnpm test` xanh; không media/data/secret trong repo; ADR ghi mục mới; `deferred-items.md` cập nhật.

---

## 10. Ngoài phạm vi (SP3B / SP4)

Thu số liệu (`collect-metrics-playwright`), đánh giá giả thuyết và "phương án thắng thành chuẩn kênh", tự sinh `ContentRequest` từ lịch/số liệu, sửa metadata video đã lên, YouTube Test & Compare, skill cho 5 gate của kho, kiểm đăng nhập thật cho dashboard, ghi từ dashboard, quota tài khoản mức portfolio, tình báo thị trường trong snapshot.

---

## 11. Rủi ro và điểm mở

- **DOM YouTube Studio đổi** làm script cũ hỏng: harness thấy `transient`/`unknown`, doctor không phát hiện được; runbook ghi cách nhận biết (log `upload-debug/`).
- **Agent headless không xác định, tốn phí**: chặn bằng `timeout_seconds`, `max_cost_usd_per_variant` (nếu CLI trả chi phí), checker; kết quả kém thì `retry` chạy lại, không có người sửa tay ở SP3 (chấp nhận theo quyết định "không gate").
- **Script cũ khác nhau giữa 10 repo**: adapter chỉ hứa giao diện argv, exit code và `publish-queue.json`; kênh lệch phải chuẩn hóa tay (ghi trong runbook, không sửa repo tự động).
- **`nextSlot` không biết lịch đặt tay trên Studio**: chỉ tính theo job trong state; lịch đặt ngoài harness có thể trùng khung (chấp nhận; SP3B đọc Studio sẽ bù).
- **Chrome ≥127 App-Bound Encryption**: không copy `.upload-profile`; mỗi máy đăng nhập riêng.
- **Phiên đăng nhập hết hạn âm thầm**: chỉ phát hiện khi upload `refused`; dashboard không có cờ "đã login" thật.
