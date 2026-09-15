# Sub-project 3B: Vòng học của kênh — thu số liệu, đánh giá giả thuyết, chuẩn kênh, tự sinh request, tự pick

**Ngày:** 2026-09-15
**Trạng thái:** Đã duyệt thiết kế qua brainstorming, chờ implementation plan
**Tiền đề:** Sub-project 1, 2A, 2B, 2C, 3, 4 đã merge vào `main` (2026-09-15, `58b43f9`). Spec này chỉ mô tả phần thêm vào; mọi thứ không nhắc tới giữ nguyên như spec 3 (`2026-09-14-sub-project-3-channel-publish-design.md`) và spec 4 (`2026-09-15-sub-project-4-studio-autopilot-design.md`).
**Tham khảo:** hệ cũ `D:\<kênh>\scripts\collect-metrics-playwright.mjs` (đọc Studio Analytics sau 72 h), `lib/metrics-parse.mjs` (`buildRow`, `parseCount/Percent/Duration`), `lib/hypothesis.mjs` (`evaluateHypothesis`, `MIN_IMPRESSIONS 50`, `MIN_VIEWS 10`, `MIN_SAMPLES 2`), `lib/learning-gate.mjs` (cổng học — **không** áp dụng); spec 3 §2.2 (`Hypothesis`), §10 (phần để lại cho 3B).

---

## 0. Quyết định đã chốt trong brainstorming

| Chủ đề | Quyết định |
|---|---|
| Phạm vi | **Cả bốn mảnh**: thu số liệu (collect-stats), đánh giá giả thuyết + chuẩn kênh, tự sinh `ContentRequest`, kênh tự pick + plan. Đóng vòng: kênh rỗng → request → studio dựng (SP4) → kênh pick/phát → thu số → học → request tiếp. |
| Chủ đề của request tự sinh | **Agent đề xuất từ số liệu + thị trường** (skill `channel-plan`, được web) trong workflow `channel-planning@1.0.0`; harness tạo request từ đề xuất. |
| Ai viết "chuẩn kênh" | **Quy tắc cố định trong harness** (hàm thuần, test được): giả thuyết `supported` cộng điểm cho `angle`/mẫu tiêu đề/thumbnail; đủ mẫu và vượt trung vị kênh thì thành chuẩn; ghi bảng `channel_learned`. |
| Cổng học | **Không chặn, chỉ ưu tiên**: kênh vẫn phát đều; giả thuyết chưa đánh giá chỉ làm chuẩn kênh chậm cập nhật; dashboard báo. |
| Kiến trúc | **Phương án A**: cổng `StatsCollector` (adapter `youtube-playwright` với script Playwright chỉ đọc do harness sở hữu) + bảng `video_metrics`/`channel_learned` + hàm học thuần + stage built-in `channel-brief` (vá lỗ hổng SP3: stage `package` chưa nhận `seo` của kênh) + workflow `channel-planning@1.0.0` + ba sweep worker kênh (`collect`, `plan`, `auto-pick`). Đã loại: B (một agent quyết định tất cả — không kiểm/test được); C (chỉ thu số). |
| Nguyên tắc | Mọi việc agent làm đều là run (workspace, ngân sách, log); phần học là code thuần; sweep không ném; không lệnh người ở hai máy ngoài `worker`. |

---

## 1. Cấu trúc thêm vào

### 1.1 Harness (repo này)

```
workflows/channel-publish@1.1.0/workflow.yaml        # thêm stage channel-brief trước package  §3.3
workflows/channel-planning@1.0.0/workflow.yaml       # channel-brief → propose-topics (agent) → create-requests  §4.2
production-profiles/channel/profile.yaml             # revision 2 → channel-publish@1.1.0
production-profiles/channel-planning/profile.yaml    # profile_id enum thêm `channel-planning`
skills/channel-plan/SKILL.md                         # đề xuất chủ đề  §4.2
skills/channel-package/SKILL.md                      # sửa: đọc channel-brief.json, ưu tiên learned.standard  §3.3
packages/contracts/src/learning.ts                   # VideoMetricsSchema, ChannelLearnedSchema, ChannelBriefSchema, TopicProposalSchema, StatsCollector port, StatsOutcome
packages/contracts/src/{config,distribution}.ts      # channel.yaml learning/planning/auto_pick; project.yaml learning; Hypothesis.evaluated?
migrations/0005_learning.sql                         # video_metrics, channel_learned
packages/core/src/learning/{metrics,hypotheses,learned,planning,auto-pick}.ts   # §2, §3, §4
packages/core/src/learning/checkers.ts               # topics-valid
packages/adapters/youtube-playwright/{src/playwright-stats-collector.ts,scripts/collect-stats.mjs,src/metrics-parse.ts}
packages/adapters/fake/src/fake-stats-collector.ts
packages/cli/src/commands/{channel.ts (stats|learned|demand|collect|plan-requests|pick-next|metrics import), publish-stage.ts (channel-brief, create-requests)}
packages/worker/src/worker.ts                        # maybeCollectStats, maybePlanRequests, maybeAutoPick
packages/core/src/dashboard/snapshot.ts              # learning block, alerts stats_blocked|stats_failing
fixtures/{fake-agent-cli.mjs (topic_proposal; channel_brief-aware draft), ops-project-channel (learning/planning/auto_pick)}
docs/runbooks/channel-learning.md
```

### 1.2 `channel.yaml` thêm (`ChannelConfigSchema`, mọi khối optional có default)

```yaml
learning:
  horizon_hours: 72            # thu số lần đầu sau mốc này kể từ published_at
  recollect_hours: [168, 720]  # ảnh chụp thêm (7 ngày, 30 ngày); [] để tắt
  min_impressions: 50          # dưới sàn → giả thuyết `void`
  min_samples: 2               # số giả thuyết supported tối thiểu để một nhóm thành chuẩn
planning:
  enabled: true
  lookahead_slots: 3           # số khung phát tới cần có item sẵn
  topics_per_run: 3            # số chủ đề agent đề xuất tối đa mỗi run
  max_open_requests: 3         # trần request open của kênh
  check_seconds: 3600          # cadence sweep maybePlanRequests (tối thiểu 60)
auto_pick:
  enabled: true
  max_concurrent_runs: 1       # run channel-publish đang chạy tối đa do auto-pick tạo
```

`project.yaml` thêm `learning: { collect_seconds: 1800 (tối thiểu 60), collect_batch: 5 }` và `adapters.stats: playwright | fake` (mặc định `fake`).

### 1.3 Bảng mới (`migrations/0005_learning.sql`)

- `video_metrics` (id ULID `metric_`, `publication_job_id`, `channel_id`, `video_id`, `collected_at`, `age_hours REAL`, `source TEXT` (`studio|manual`), `data TEXT` JSON `VideoMetrics`); chỉ mục `(publication_job_id, age_hours)`, `(channel_id, collected_at)`. Append-only.
- `channel_learned` (`channel_id PRIMARY KEY`, `data TEXT` JSON `ChannelLearned`, `updated_at`). Upsert.
- `hypothesis.status` và `hypothesis.evaluated` cập nhật tại chỗ trong `channel_package.data` (mirror-kiểu, không qua `transition()`).

---

## 2. Số liệu và cổng thu

### 2.1 Cổng `StatsCollector` (contracts)

```ts
export type StatsOutcome =
  | { kind: "ok"; views: number; impressions?: number; ctr_pct?: number; avg_view_sec?: number; retention30_pct?: number; note?: string }
  | { kind: "no-views" }                       // Studio nói "chưa có lượt xem"
  | { kind: "blocked"; reason: string }        // tường đăng nhập / verify-it's-you
  | { kind: "error"; reason: string };         // DOM đổi, timeout, JSON hỏng
export interface StatsCollector { readonly name: string; collect(p: { channel: PublisherChannel; video_id: string; timeout_seconds: number }): Promise<StatsOutcome> }
```

`PlaywrightStatsCollector` (adapter `youtube-playwright`): spawn `scripts/collect-stats.mjs --profile <repo>/.upload-profile --video <id>` (Playwright chỉ đọc, `chromium.launchPersistentContext`, headless): `tab-overview/period-since_publish` → Views (nhận "hasn't gotten any views"/"chưa có lượt xem" → `no-views`); `tab-reach` → Thumbnail impressions, Thumbnail click-through rate; `tab-engagement` → Average view duration; in JSON một dòng; exit 0 ok/no-views, 2 blocked, 3 error. Timeout 120 s (`spawnSync` + `killSignal`), env sạch không `HARNESS_SECRET_*`, log qua Redactor. Phần parse `parseCount` (`1.2K`, `1,234`, `1,2 N`), `parsePercent`, `parseDuration` (`m:ss`, `h:mm:ss`) chép từ `lib/metrics-parse.mjs` của hệ cũ thành `src/metrics-parse.ts` thuần có test cùng vector. `FakeStatsCollector`: map `video_id → StatsOutcome` hoặc file `HARNESS_FAKE_STATS_FILE` (JSON `{ "<video_id>": StatsOutcome }`) cho test CLI; mặc định `{ kind: "ok", views: 100, impressions: 500, ctr_pct: 5, avg_view_sec: 60 }`.

### 2.2 `VideoMetrics` (contracts, `harness.video-metrics/v1`)

`{ schema_version, metric_id, publication_job_id, channel_id, video_id, collected_at, age_hours, source: "studio"|"manual", views: int, impressions: int|null, ctr_pct: number|null (0–100), avg_view_sec: number|null, retention30_pct: number|null }`.
Chỉ số dẫn xuất tính khi cần: `avg_view_pct = avg_view_sec / duration_seconds × 100` (duration từ `LibraryItem` của gói qua `content.library_item_id`, fallback probe `episode_video` artifact); `views_72h` = `views` của ảnh chụp có `age_hours` gần 72 nhất trong [60, 96].

### 2.3 Khi nào thu — `collectDue(store, channel, now): { job, target_age_hours }[]` (thuần)

Với mỗi `PublicationJob` `PUBLISHED` của kênh có `published_at`: mốc = `horizon_hours` và từng `recollect_hours`; đến hạn khi `now ≥ published_at + mốc` và chưa có ảnh chụp `source: studio` với `age_hours ≥ mốc − 6`. Sắp xếp mốc cũ nhất trước; cắt `collect_batch`.

### 2.4 Sweep `maybeCollectStats()` (worker kênh, mỗi `learning.collect_seconds`, sau `maybeVerifyPublications`)

Với mỗi mục đến hạn: `collector.collect` → `ok` → insert `video_metrics` (`age_hours` tính từ `published_at`); `no-views` → insert với `views 0`, còn lại null; `blocked` → không ghi, event `stats.blocked { channel_id, reason }` dedup theo `listEvents({ event_type })`, bỏ qua kênh đó tới lượt sau; `error` → không ghi, log warn, `job.receipt.collect_failures += 1` (reset về 0 khi ok), ≥3 → event `stats.failing { job_id }` dedup. Sau khi thu xong một kênh → `evaluateHypotheses` + `learnChannelStandard` (§3). Sweep không ném; một video lỗi không chặn video khác.

### 2.5 CLI và doctor

`harness channel stats <id> [--json]` (ảnh chụp mới nhất mỗi tập); `harness channel collect [--channel <id>] [--job <id>] [--force] [--json]` (một lượt sweep; `--force` bỏ điều kiện đến hạn); `harness channel metrics import <channel_id> <jsonl>` (nhập sổ `channel-metrics.jsonl` cũ: khớp `videoId` với `PublicationJob.youtube_video_id`, `source: manual`, bỏ dòng không có job và báo số bỏ). Doctor `channel:<id>:stats` (`playwright`: script tồn tại + `.upload-profile/Default`; `fake`: ok).

---

## 3. Đánh giá giả thuyết, chuẩn kênh, `channel-brief`

### 3.1 `evaluateHypotheses(store, channel, now): EvaluationReport` (thuần)

Với mỗi `ChannelPackage` `committed` có `hypothesis.status: "open"` và job `PUBLISHED`: ảnh chụp đầu tiên `age_hours ≥ expected.horizon_hours` (không có → giữ `open`); giá trị theo `expected.metric`: `ctr` → `ctr_pct` (null hoặc `impressions < min_impressions` → `void`); `views_72h` → `views` (`impressions` null vẫn đánh giá được); `avg_view_pct` → `avg_view_sec / duration × 100` (thiếu một trong hai → `void`); `≥ target` → `supported`, ngược lại `refuted`. Ghi `hypothesis.status` + `hypothesis.evaluated { at, metric_value, metric_id }` (trường mới optional trong `HypothesisSchema`, `updateChannelPackage`); event `hypothesis.evaluated { hypothesis_id, status, metric_value }`. Idempotent (đã khác `open` → bỏ qua).

### 3.2 `learnChannelStandard(store, channel): ChannelLearned` (thuần) — `harness.channel-learned/v1`

```
{ schema_version, channel_id, updated_at, sample_size,
  medians: { views_72h: number|null, ctr_pct: number|null, avg_view_pct: number|null },
  winners: { angles: [{ value, supported, refuted, lift }], title_patterns: [...], overlay: [...] },
  standard: { angle?: string, title_pattern?: string, overlay_lines?: 0|1|2|3, note: string },
  history: [{ at, standard }] }   // tối đa 20
```
Nhóm giả thuyết đã đánh giá (`supported|refuted`) theo: `chosen.angle` (nguyên văn, trim, lowercase); mẫu tiêu đề với ba nhãn cố định `has_number` (có chữ số), `is_question` (kết thúc `?`), `long` (>60 ký tự) → chuỗi như `number+question+short`; `overlay` = `overlay_text.length` (0, 1–2 → `"1-2"`, 3). `lift` nhóm = trung bình `metric_value`/`medians[metric]` (chỉ gộp giả thuyết cùng `metric`; nhóm theo metric phổ biến nhất của kênh). Nhóm thành `standard` khi `supported ≥ min_samples` và `lift > 1` và `supported > refuted`; nhiều nhóm → lift cao nhất; chuẩn cũ chỉ bị thay khi nhóm mới `lift ≥ cũ × 1.10`; không nhóm nào đạt → `standard: { note: "cần ≥N giả thuyết supported cùng nhóm; hiện có …" }`. Upsert `channel_learned`; event `channel.learned_updated` khi `standard` đổi; `history` đẩy khi đổi.

### 3.3 Stage built-in `channel-brief` và `ChannelBrief` (`harness.channel-brief/v1`)

Chạy trong `channel-publish@1.1.0` (sau `fetch-library-item`, trước `package`) và trong `channel-planning@1.0.0` (đầu). Ghi `output/channel-brief.json` type `channel_brief`:
```
{ schema_version, generated_at,
  channel: { channel_id, display_name, seo, publication: { timezone, publish_times } },
  learned: ChannelLearned | null,
  hypotheses: [{ hypothesis_id, episode_no, chosen: { title, angle, overlay_text }, expected, status, metric_value? }],   // 10 gần nhất
  recent_metrics: [{ episode_no, title, views, impressions, ctr_pct, avg_view_sec, age_hours }],                          // 10 tập gần nhất, ảnh chụp mới nhất
  open_requests: [{ request_id, topic, status }],                                                                         // request của kênh open|claimed
  item: { item_id, title_hint, summary, duration_seconds } | null }                                                        // null trong planning
```
`channel-publish@1.1.0`: `package` `depends_on: [fetch-library-item, channel-brief]`, input thêm `channel_brief`. Skill `channel-package` sửa: input chính là `channel-brief.json`; bước tìm web bổ sung chứ không thay; khi `learned.standard` có `angle`/`title_pattern`/`overlay_lines` thì phải theo và ghi `basis` kind `channel` "theo chuẩn kênh: …"; `expected.target = medians[metric] × 1.1` khi có trung vị, không thì như cũ; `expected.metric` mặc định theo metric của chuẩn kênh nếu có. CLI `harness channel learned <id> [--json]`; `harness channel hypotheses` thêm `metric_value`.

---

## 4. Lập kế hoạch tự sinh request và tự pick

### 4.1 `channelDemand(store, channel, lib, now): Demand` (thuần)

`slots` = `lookahead_slots` khung phát tới từ `nextSlot` lặp (taken = job SCHEDULED|PUBLISHED). `covered` = job `PROCESSING|SCHEDULED` của kênh + run `channel-publish` đang chạy của kênh + item `approved` chưa có claim của kênh này mà (a) `request_id` thuộc request của kênh hoặc (b) không có `request_id` + request `open|claimed` của kênh (studio đang làm). `needed = max(0, slots.length − covered)`. `Demand = { needed, slots, covered_by: {...}, open_requests }`. Cần lập kế hoạch khi `needed > 0` và `open_requests.length < max_open_requests`.

### 4.2 Workflow `channel-planning@1.0.0` (profile `channel-planning`, `max_cost_usd_per_variant: 3`, `reuse: never`)

| # | key | executor | output |
|---|---|---|---|
| 1 | `channel-brief` | built-in `publish-channel-brief` (item null) | `channel_brief` |
| 2 | `demand` | built-in `publish-demand` (ghi `Demand`) | `demand` (demand.json) |
| 3 | `propose-topics` | agent `channel-plan` (được web; `depends_on: [1, 2]`; `retry max_attempts 2`) | `topic_proposal` (topics.json) |
| 4 | `create-requests` | built-in `publish-create-requests` (`depends_on: [3, 2]`) | `requests_receipt` |

`TopicProposalSchema` (`harness.topic-proposal/v1`): `{ topics: [{ topic (≥8 ký tự), angle, why (≥1 câu), style_id?, voice?: none|tts|original, target_duration_seconds?, source_hint?: { collection? } }] }` với `1 ≤ topics.length ≤ topics_per_run`. Checker `topics-valid` (output `topic_proposal`): schema; không trùng (chuẩn hóa lowercase/trim) với `open_requests[].topic` trong `channel-brief.json` và với tiêu đề 20 gói gần nhất của kênh; `topics.length ≤ demand.needed` không bắt buộc (cắt ở stage 4). Skill `channel-plan`: đọc `channel-brief.json` + `demand.json`; ưu tiên `learned.standard.angle`; tìm web 3–5 video cùng ngách gần đây; mỗi chủ đề nêu `why` dựa trên số liệu/giả thuyết/thị trường; không lặp lại chủ đề đã có; tự kiểm trùng.

`create-requests`: với `topics.slice(0, demand.needed)` → `createRequest({ requested_by: { portfolio_id, channel_id }, topic, style_id: topic.style_id ?? style active mới nhất trong kho (không có → contract), voice, language: seo.language, target_duration_seconds?, source_hint?, notes: "auto-plan <run_id>: <why>" })`; idempotent theo run (`notes` chứa `run_id` → bỏ qua chủ đề đã tạo); output `requests-receipt.json { request_ids }`; event `channel.requests_created { channel_id, run_id, request_ids }`.

### 4.3 Sweep `maybePlanRequests()` (worker kênh, mỗi `planning.check_seconds`, sau `maybeCollectStats`)

Kênh `planning.enabled`: `channelDemand` → cần → không có run `channel-planning` chưa kết thúc cho kênh và không có event `channel.planning_failed` trong 24 h → một transaction: `catalog.createContent({ source_ids: [], title: "planning <channel_id> <YYYY-MM-DD>" })` (content mang `library_channel_id`), `getOrCreateVariant` profile `channel-planning`, plan `channel-planning@1.0.0`, enqueue; event `channel.planning_started { channel_id, needed, run_id }`. Không cần → event `channel.planning_skipped { reason: "covered"|"open-cap" }` dedup theo ngày. Lỗi → log + event `channel.planning_failed`, không ném.

### 4.4 Sweep `maybeAutoPick()` (worker kênh, sau `maybeSyncLibrary` thành công)

Kênh `auto_pick.enabled`: ứng viên = item `approved` chưa có `claims/<channel>.json`, sắp xếp (a) `request_id` thuộc request của kênh (theo `created_at` request), rồi (b) item chung (không `request_id`) chỉ khi `channelDemand.needed > 0`; bỏ item đã có run `channel-publish` FAILED|WAITING cho kênh này (qua `ContentItem.library_item_id` + `library_channel_id`). Số run `channel-publish` đang chạy của kênh `< auto_pick.max_concurrent_runs` → một transaction: `claimItem` + `getOrCreateVariant` profile `channel` + plan `channel-publish@<profile.workflow_release>` + enqueue; event `channel.auto_picked { channel_id, item_id, run_id }`. Lỗi → log + event `channel.auto_pick_failed`, không ném.

### 4.5 CLI

`harness channel demand <id> [--json]`; `harness channel plan-requests <id> [--json]` (chạy §4.3 tay, bỏ cadence); `harness channel pick-next <id> [--json]` (một lượt §4.4 tay).

---

## 5. Dashboard, doctor, sự kiện

- Snapshot mỗi kênh thêm `learning { hypotheses: { open, supported, refuted, void }, last_collect_at, standard: ChannelLearned["standard"] | null, demand: { needed, open_requests } }`; alert mới `stats_blocked { channel_id }`, `stats_failing { job_id }`, `planning_failed { channel_id }`.
- Doctor: `channel:<id>:stats`, `channel:<id>:planning` (enabled → profile `channel-planning` + workflow nạp được; `adapters.agent` không `fake` khi enabled).
- Event mới: `stats.collected`, `stats.blocked`, `stats.failing`, `hypothesis.evaluated`, `channel.learned_updated`, `channel.planning_started|skipped|failed`, `channel.requests_created`, `channel.auto_picked|auto_pick_failed`.

---

## 6. Xử lý lỗi

| Tình huống | Hành vi |
|---|---|
| Studio chặn đăng nhập khi thu | `blocked` → không ghi, event dedup, alert `stats_blocked`; kênh vẫn phát; người `channel login` |
| Studio đổi DOM / timeout | `error` → không ghi; ≥3 lần liên tiếp một video → `stats_failing`; video khác vẫn thu |
| `impressions` null / dưới sàn | giả thuyết `void`; `views` vẫn vào `medians.views_72h` |
| Gói bị cancel / video xóa tay sau khi đánh giá | giữ trạng thái giả thuyết; job do verify/reconcile SP3 xử lý |
| Agent `propose-topics` ra topic trùng/sai | `topics-valid` fail → run FAILED → alert `stage_waiting_human`/`planning_failed`; không plan lại 24 h |
| Kho không có style active | `create-requests` `contract` |
| `needed > 0` nhưng đủ `max_open_requests` | không plan; event `planning_skipped { open-cap }` dedup theo ngày |
| Hai kênh cùng pick một item chung | hợp lệ (claims riêng); item có `request_id` của kênh khác không được pick |
| Item `withdrawn` sau auto-pick | `fetch-library-item` `contract` → WAITING_HUMAN + alert (SP3/SP4) |
| `metrics import` dòng không khớp job | bỏ, báo số bỏ |
| Sweep lỗi bất kỳ | log + event, không ném, không dừng worker |

---

## 7. Kiểm thử

- **Unit core**: `collectDue` (horizon/recollect/đã có ảnh chụp/batch/thứ tự), `evaluateHypotheses` (từng metric; `void` dưới sàn; giữ `open` trước horizon; idempotent), `learnChannelStandard` (nhóm/lift/`min_samples`/ngưỡng 10 %/history cap/nhóm theo metric), `channelDemand` (đủ item; thiếu item; request đang làm; cap; item của kênh khác không tính), `metrics-parse` (vector từ hệ cũ), `topics-valid`, `metrics import`.
- **Adapter**: `PlaywrightStatsCollector` với script giả (exit 0/2/3, JSON hỏng, timeout) → đúng `StatsOutcome`; `collect-stats.mjs` chỉ `node --check`.
- **Stage built-in**: `channel-brief` (có/không item; learned null/có; không secret trong file), `demand`, `create-requests` (idempotent theo run; cắt `needed`; thiếu style → contract).
- **Fake**: `FakeStatsCollector` theo `HARNESS_FAKE_STATS_FILE`; `fake-agent-cli.mjs` thêm `topic_proposal` (đọc `demand.json.needed`, sinh `Chủ đề N` không trùng `open_requests`) và `channel_package_draft` đọc `channel-brief.json`: dùng `learned.standard.angle` khi có và thêm `basis` kind `channel`.
- **Tích hợp** `tests/integration/channel-learning.test.ts` (`skipIf(!hasFfmpeg())`): thế giới kho + studio autopilot (SP4 fixture) + kênh (`learning`/`planning`/`auto_pick` bật, cadence tối thiểu, `adapters { stats: fake, agent: cli(fake) }`): (1) kênh rỗng, worker kênh → run `channel-planning` → 3 request trong kho; (2) studio worker dựng → item `approved` (`FAKE_REVIEW_MODE=approve`); (3) worker kênh auto-pick → `channel-publish@1.1.0` → SCHEDULED; `channel-brief.json` có `seo` và `learned: null`; (4) đẩy `published_at` lùi 80 h qua store + lookup file public → verify PUBLISHED → sweep collect với fake stats → `video_metrics` có hàng; giả thuyết `supported`/`refuted` theo file; sau 2 gói `supported` cùng `angle` → `channel_learned.standard.angle`; run publish tiếp theo có `channel-brief.json.learned.standard` và gói mới `basis` kind `channel`.
- **Acceptance**: **33** `blocked` không chặn phát (job mới SCHEDULED, alert `stats_blocked`); **34** dưới sàn impressions → `void`, chuẩn không đổi; **35** chuẩn không lật khi lift mới < +10 %; **36** demand đã đủ → không plan planning, không request mới; **37** `max_open_requests` chặn; **38** `metrics import` 3 dòng, 1 không khớp → 2 hàng `manual`; **39** không secret trong `channel-brief.json`, prompt, log của `propose-topics`; **40** workflow `channel-publish@1.0.0` + test SP3 vẫn xanh.

---

## 8. Definition of Done sub-project 3B

1. Kênh rỗng tự sinh request → studio (SP4) tự dựng → kênh tự pick, phát, thu số (fake), đánh giá, cập nhật chuẩn — không lệnh người nào ở hai máy ngoài `worker` (test tích hợp).
2. `channel-brief.json` đưa `seo` + chuẩn kênh + giả thuyết đã đánh giá vào stage `package`; gói mới dẫn chứng chuẩn kênh trong `basis` (test).
3. `harness channel stats|learned|demand|collect|plan-requests|pick-next|metrics import` chạy được; dashboard có khối `learning` và alert `stats_blocked|stats_failing|planning_failed`.
4. Thu số thật với Studio một lần trên máy có Chrome đã đăng nhập (kiểm tay, ghi runbook; máy build không có → ghi rõ chưa đạt).
5. Workflow `channel-publish@1.0.0`, test SP3/SP4 vẫn xanh; runbook `docs/runbooks/channel-learning.md`; ADR; deferred; `pnpm build && pnpm typecheck && pnpm test` xanh.

---

## 9. Ngoài phạm vi

Sửa metadata video đã lên theo kết quả; YouTube Test & Compare; học chéo kênh (`fleetLessons`); mục tiêu doanh thu/đăng ký; agent chọn source phía studio; "cổng học" chặn; tự động hóa đăng nhập Studio.

---

## 10. Rủi ro và điểm mở

- **Chuẩn kênh học từ mẫu nhỏ** (`min_samples 2`): dễ nhiễu ở kênh mới; ngưỡng đổi 10 % và `history` để người soi lại; SP sau có thể nâng theo số tập.
- **Studio Analytics đổi DOM** làm thu số dừng âm thầm: alert `stats_failing` sau 3 lần; runbook chỉ cách sửa selector trong `collect-stats.mjs`.
- **Agent đề xuất chủ đề trùng lặp theo thời gian** (ngoài 20 gói gần nhất): chấp nhận; SP sau thêm bộ nhớ chủ đề.
- **Demand tính theo item approved chưa claim** có thể trùng với kênh khác đang định pick cùng item chung: chấp nhận (item chung được nhiều kênh dùng theo SP3).
- **`hypothesis.evaluated` ghi vào `channel_package`** làm gói "committed" thay đổi sau khi publish: chỉ trường `hypothesis`, không đụng manifest/checksum.
