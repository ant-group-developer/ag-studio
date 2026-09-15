# Runbook: vòng học của kênh (channel learning loop, sub-project 3B)

Đích: đóng vòng kênh **rỗng → tự sinh request → studio tự dựng (SP4) → kênh tự pick/phát (SP3) → thu số liệu
Studio → đánh giá giả thuyết → chuẩn kênh → request tiếp theo theo chuẩn đó** — không có lệnh người nào ở
hai máy ngoài `harness worker`, trừ đăng nhập Chrome một lần (`channel login`, SP3) và (tuỳ chọn) `library
styles activate`/xử lý `WAITING_HUMAN` phía studio (SP4).

Đọc code trước khi tin tài liệu này lệch: `packages/core/src/learning/{metrics,hypotheses,learned,planning,
auto-pick,checkers}.ts`, `packages/adapters/youtube-playwright/{src/playwright-stats-collector.ts,scripts/
collect-stats.mjs}`, `packages/adapters/fake/src/fake-stats-collector.ts`, `packages/cli/src/commands/
{channel,publish-stage,worker,doctor}.ts`, `packages/worker/src/worker.ts`, `packages/core/src/dashboard/
snapshot.ts`, `workflows/{channel-publish@1.1.0,channel-planning@1.0.0}/workflow.yaml`, `skills/{channel-plan,
channel-package}/SKILL.md`. Spec: `docs/superpowers/specs/2026-09-15-sub-project-3b-channel-learning-design.md`.
Tiền đề: đã đọc `docs/runbooks/channel-publish.md` (sub-project 3: kênh, `Publisher`, `channel-package`) và
`docs/runbooks/studio-autopilot.md` (sub-project 4: studio tự dựng) — runbook này chỉ nói phần **thêm vào**.

---

## 1. Điều kiện

- **Thu số thật cần Chrome đã đăng nhập trên máy kênh** (`adapters.stats: playwright` trong `project.yaml`):
  cùng `.upload-profile/<repo_dir>` mà `channel login <id>` (SP3) đã đăng nhập cho upload/schedule — thu số
  dùng lại đúng profile đó, chỉ đọc (`scripts/collect-stats.mjs`, mục 6). Không đăng nhập lại riêng cho thu
  số; nếu upload/schedule đã chạy được trên máy đó thì thu số cũng sẵn sàng về mặt đăng nhập.
- **`adapters.stats: fake`** (mặc định) dùng `FakeStatsCollector` — không cần Chrome, không đụng mạng; đủ để
  tập luyện toàn bộ vòng lặp và chạy test/CI. Đổi sang `playwright` chỉ khi đã kiểm `channel:<id>:stats` xanh
  ở `harness doctor` (mục 3 dưới) **và** đã có DoD #4 (mục 9) chạy được ít nhất một lần trên máy đó.
- `planning.enabled: true` cần agent thật (`adapters.agent: cli`, `claude`/`codex` trên PATH) để
  `propose-topics` sinh chủ đề có ý nghĩa — `harness doctor`'s `channel:<id>:planning` FAIL nếu
  `adapters.agent` là `fake` trong khi `planning.enabled: true` (mục 3).
- Không có gì mới cần `ffmpeg`/`ffprobe` riêng cho sub-project 3B — `channel-brief`/`demand`/`create-requests`
  đều là script built-in đọc/ghi JSON, không đụng media. Điều kiện `ffprobe` của `fetch-library-item` (SP3)
  vẫn áp dụng y hệt khi kênh thật sự phát một tập.

## 2. Bật `learning`/`planning`/`auto_pick` và cadence

Ba khối mới trong `channels/<channel_id>/channel.yaml` (mọi trường optional, có default — xem
`project-template/channels/example/channel.yaml` cho comment đầy đủ từng trường):

```yaml
learning:
  horizon_hours: 72            # thu số lần đầu sau mốc này kể từ published_at
  recollect_hours: [168, 720]  # ảnh chụp thêm (7 ngày, 30 ngày); [] để tắt tái thu
  min_impressions: 50          # dưới sàn -> giả thuyết ctr thành "void" thay vì supported/refuted
  min_samples: 2               # số giả thuyết supported tối thiểu cùng nhóm để thành chuẩn kênh
planning:
  enabled: true                # bật sweep maybePlanRequests + workflow channel-planning@1.0.0
  lookahead_slots: 3           # số khung phát tới cần có item sẵn (channelDemand)
  topics_per_run: 3            # trần chủ đề agent đề xuất mỗi run channel-planning
  max_open_requests: 3         # trần request open của kênh trong kho cùng lúc
  check_seconds: 3600          # cadence sweep (tối thiểu 60; cùng khuôn library.sync_seconds)
auto_pick:
  enabled: true                # bật sweep maybeAutoPick (tự claim item approved + phát)
  max_concurrent_runs: 1       # số run channel-publish đang chạy tối đa do auto-pick tự tạo
```

Và trong `project.yaml` (mức project, không theo từng kênh):

```yaml
adapters: { stats: fake }         # playwright | fake, mặc định fake — xem mục 1
learning: { collect_seconds: 1800, collect_batch: 5 }   # cadence + batch sweep maybeCollectStats
```

`harness worker` (chạy liên tục) tự làm bốn việc mới khi rảnh, theo đúng thứ tự cố định trong
`packages/worker/src/worker.ts`: đồng bộ kho + `maybeAutoAccept`/`maybeAutoPick` (chỉ khi vừa sync xong) →
`maybeVerifyPublications` (SP3) → **`maybeCollectStats`** (mỗi `learning.collect_seconds`) →
**`maybePlanRequests`** (mỗi kênh, mỗi `planning.check_seconds` của chính kênh đó). Cả bốn sweep không bao giờ
ném — lỗi chỉ log + event, worker không dừng (cùng nguyên tắc `maybeSyncLibrary`/`maybeVerifyPublications` của
SP2C/SP3).

Muốn chạy tay một lượt, bỏ qua cadence: `harness channel collect [--channel <id>] [--force] --json`,
`harness channel plan-requests <id> --json`, `harness channel pick-next <id> --json`.

## 3. Vòng kín: kênh rỗng → request → studio → pick → phát → thu số → học

```
kênh rỗng (0 job PROCESSING/SCHEDULED, 0 request open/claimed của kênh)
  │  worker kênh: maybePlanRequests (needed>0, chưa đủ max_open_requests, không cooldown 24h)
  ▼
run channel-planning@1.0.0: channel-brief → demand → propose-topics (agent, skill channel-plan) → create-requests
  │  tạo tối đa min(needed, max_open_requests - open_requests, topics_per_run) ContentRequest "open" trong kho
  ▼
studio (SP4, máy khác): worker studio tự nhận request (library.auto_accept) → style-study/library-production
  │  → item "approved" trong kho, request "fulfilled"
  ▼
kênh: worker: maybeAutoPick (item của request kênh mình, ưu tiên; xem mục dưới) → claim + plan + enqueue
  ▼
run channel-publish@1.1.0: fetch-library-item → channel-brief → package (agent) → build-package → upload → schedule
  │  → PublicationJob SCHEDULED
  ▼
(thời gian trôi qua, video lên public thật)  →  sweep verify (SP3): SCHEDULED → PUBLISHED
  │  worker kênh: maybeCollectStats, đến hạn theo learning.horizon_hours/recollect_hours
  ▼
video_metrics (source: studio) → evaluateHypotheses (open → supported/refuted/void) → learnChannelStandard
  │  → channel_learned.standard cập nhật nếu đủ mẫu + lift đủ tốt (mục 5)
  ▼
lần channel-planning kế tiếp: channel-brief mang learned.standard → agent channel-plan ưu tiên đề xuất theo đó
  → gói kế tiếp (channel-package) dẫn basis "channel" theo chuẩn — vòng khép kín
```

Theo dõi từng bước bằng CLI đọc, không lệnh nào sửa gì ngoài các lệnh trên:

```sh
harness --project <channel-dir> channel demand <id> --json     # needed, slots, covered, open_requests
harness --project <channel-dir> channel stats <id> --json      # ảnh chụp video_metrics mới nhất mỗi tập
harness --project <channel-dir> channel learned <id> --json    # chuẩn kênh hiện tại + top nhóm + history
harness --project <channel-dir> dashboard snapshot --json      # khối learning (mục 3 dưới) + ba alert mới
```

`dashboard snapshot`'s mỗi kênh có thêm khối `learning`:

```json
"learning": {
  "hypotheses": { "open": 1, "supported": 2, "refuted": 1, "void": 0 },
  "last_collect_at": "2026-09-20T08:00:00.000Z",
  "standard": { "angle": "chợ nổi", "note": "" },
  "metric": "views_72h",
  "demand": { "needed": 1, "open_requests": 0 }
}
```

và ba alert mới: `stats_blocked { channel_id }` (Studio chặn đăng nhập khi thu số), `stats_failing
{ job_id }` (≥3 lần lỗi liên tiếp một video), `planning_failed { channel_id }` (run `channel-planning` gần
nhất FAILED trong 24h qua) — cả ba cạnh `reconcile`/`run_failed`/`gate_overdue`/`doctor`/`library_unmounted`/
`missing_today`/`request_stuck`/`stage_waiting_human` đã có từ SP3/SP4.

**`maybeAutoPick` chọn item theo thứ tự** (spec §4.4, `packages/core/src/learning/auto-pick.ts`): (a) item
`approved` gắn `request_id` của một request do **chính kênh này** tạo, sắp theo `created_at` của request (cũ
trước); rồi mới tới (b) item chung không có `request_id`, và chỉ khi `demand.needed + demand.covered.items >
0`, tức còn khung phát chưa được job/run/request che phủ — cố ý không tính chính các item chung vào phần "đã
che phủ" ở phép so này (chúng vẫn được `channelDemand` gộp vào `covered.items` như đã che phủ trên giấy, nên
nếu gate chỉ so `needed > 0`, một item chung đang tồn tại sẽ tự kéo `needed` về 0 và vĩnh viễn tự chặn chính
nó khỏi được pick) — bỏ qua item đã có run `channel-publish` `FAILED`/`WAITING_HUMAN` của chính kênh này
(tránh lặp lại thất bại vô hạn). Hai kênh cùng pick một item chung là hợp lệ (mỗi kênh một claim riêng, xem
`docs/runbooks/content-library.md`); item có `request_id` của kênh khác thì kênh này không bao giờ pick.

## 4. Nhập sổ cũ (`metrics import`)

Kênh đã vận hành trước khi có harness có thể đã giữ một sổ `channel-metrics.jsonl` (định dạng hệ cũ, mỗi dòng
một JSON `{ videoId, views, publishedAt?, collectedAt? }`, dòng có `$schema` bị bỏ qua). Nhập vào harness làm
số liệu `source: "manual"` (không tính vào `collectDue` — không chặn thu số thật sau này cho cùng video):

```sh
harness --project <channel-dir> channel metrics import <channel_id> <path/to/channel-metrics.jsonl> --json
# { "imported": 12, "skipped": [{ "videoId": "…", "why": "no matching publication job" }] }
```

Mỗi dòng khớp `videoId` với `PublicationJob.youtube_video_id` của đúng kênh — dòng không khớp bị bỏ, in ra lý
do (`no matching publication job`, `no views`, `no published_at`, `negative age`, `invalid JSON`), không làm
dừng cả lượt nhập. `publishedAt` của chính dòng jsonl được dùng khi job chưa có `published_at` riêng (job
chưa qua sweep `verify` của SP3) — không bắt buộc job đã `PUBLISHED` mới nhập được, chỉ cần đã có
`youtube_video_id` (gán từ lúc `upload`, trước cả `schedule`). Dòng đã nhập xuất hiện trong `channel stats`
với `source: "manual"` (mục 3) và được `evaluateHypotheses`/`learnChannelStandard` dùng y hệt số liệu thật.

## 5. Đọc `channel learned` và cách chuẩn đổi

```sh
harness --project <channel-dir> channel learned <id> --json
```

`standard` chỉ có giá trị ở một trong ba nhánh (`angle`/`title_pattern`/`overlay_lines`) khi nhóm giả thuyết
tương ứng đạt **cả ba** điều kiện: `supported ≥ learning.min_samples`, `lift > 1` (trung bình `metric_value`
của nhóm chia cho `medians[metric]` của kênh), và `supported > refuted`. Nhóm tiêu đề dùng ba nhãn cố định kết
hợp bằng `+` (`titlePattern`, `packages/core/src/learning/learned.ts`): `number|plain` (có chữ số hay
không) `+` `question|statement` (kết thúc `?` hay không) `+` `long|short` (>60 ký tự hay không) — ví dụ
`number+question+short`. Nhóm overlay dùng số dòng chữ đè: `"0"`, `"1-2"`, `"3"`.

**Một chuẩn không bao giờ hình thành chỉ từ hai tập, kể cả khi cả hai `supported` cùng nhóm.** `lift` so với
**trung vị của kênh** (`medians[metric]`), và trung vị của đúng hai mẫu chính là trung bình cộng của chúng —
nghĩa là `lift` của nhóm hai-mẫu-đó luôn đúng bằng 1.0, không bao giờ `> 1`. Cần có **ít nhất một mẫu khác**
(một tập khác, dù `refuted` hoặc nhóm khác) để kéo trung vị kênh xuống dưới nhóm đang xét thì `lift` mới có cơ
hội vượt 1 — test tích hợp `tests/integration/channel-learning.test.ts` minh hoạ đúng điều này: hai tập cùng
góc "chợ nổi" (`supported`) chỉ thành chuẩn sau khi một tập thứ ba, góc khác và yếu hơn (`refuted`), được
publish trước đó để kéo trung vị xuống.

Một chuẩn đang đứng (`standard.angle`/`title_pattern`/`overlay_lines` đã có giá trị) chỉ bị thay khi nhóm mới
có `lift ≥ lift cũ × 1.10` (ngưỡng 10%, `decideDimension`) — một nhóm mới nhỉnh hơn một chút không đủ để lật
chuẩn, tránh chuẩn kênh nhảy qua lại theo nhiễu mẫu nhỏ. Mỗi lần chuẩn thực sự đổi (không phải mỗi lần
`learnChannelStandard` chạy), một dòng được đẩy vào `history` (`{ at, standard }`, tối đa 20 dòng, dòng cũ
nhất bị cắt) và event `channel.learned_updated` được ghi — `history` là chỗ soát lại chuẩn đã đổi khi nào,
theo nhóm nào, không phải log của mọi lần chạy `learnChannelStandard`. Chưa nhóm nào đạt đủ điều kiện thì
`standard.note` ghi rõ `"cần ≥N giả thuyết supported cùng nhóm; hiện có M đã đánh giá"` thay vì để trống ba
trường im lặng.

## 6. Sự cố

| Alert / dấu hiệu | Nguyên nhân | Xử lý |
|---|---|---|
| `stats_blocked { channel_id }` | Studio chặn đăng nhập khi thu số (`kind: "blocked"` từ `StatsCollector`, ví dụ tường "verify it's you") | `harness --project <channel-dir> channel login <channel_id>` (đăng nhập lại trong Chrome đã mở, xem `channel-publish.md` mục 2); kênh vẫn phát bình thường trong lúc chờ — thu số không chặn phát hành (spec §0 "cổng học: không chặn"). |
| `stats_failing { job_id }` | ≥3 lần lỗi liên tiếp (`kind: "error"`) thu số cho **một video** — Studio đổi DOM, timeout | Đọc log lỗi của `collect-stats.mjs` (chạy tay `node scripts/collect-stats.mjs --profile <repo>/.upload-profile --video <video_id>` để xem dòng lỗi trực tiếp); sửa selector/label trong `packages/adapters/youtube-playwright/scripts/collect-stats.mjs` nếu Studio đã đổi giao diện (script chỉ có ba khối cần sửa: nhãn Views ở tab Overview, nhãn Thumbnail impressions/CTR ở tab Reach, nhãn Average view duration ở tab Engagement — xem comment đầu file). Video khác của cùng kênh vẫn thu bình thường; sửa xong, `job.receipt.collect_failures` tự reset về 0 ở lần thu thành công kế tiếp. |
| `planning_failed { channel_id }` | Run `channel-planning@1.0.0` gần nhất FAILED (agent `propose-topics` đỗ `WAITING_HUMAN` vì `topics-valid` fail, hoặc `create-requests` `contract` vì kho không có style active) | `harness --project <channel-dir> status <run_id> --json` tìm stage FAILED/WAITING_HUMAN; đọc `topics.json`/`logs/agent-stdout.log` trong workspace của attempt (`stages[].attempts[-1].workspace_uri`) để biết agent đề xuất gì sai (trùng chủ đề đã có, thiếu `why`, ít hơn 8 ký tự…); sửa `skills/channel-plan/SKILL.md` nếu vấn đề là hướng dẫn agent chưa đủ rõ, hoặc thêm style active vào kho (`library styles activate`) nếu lỗi là "no active edit style". Không plan lại tự động trong 24h kể từ lần fail (cooldown `channel.planning_failed`, `recentlyEmitted`) — chạy tay `harness channel plan-requests <id> --json` để thử lại ngay sau khi sửa, không cần đợi hết cooldown. |
| Request kênh mở mà không ai làm | Studio autopilot tắt (`library.auto_accept.enabled: false`/`role != studio`), hoặc studio chưa chạy `worker` | Xem `docs/runbooks/studio-autopilot.md` mục 2/3 — vòng 3B **phụ thuộc** vòng SP4 để request thành item; nếu studio cố tình vận hành tay (không autopilot), request vẫn nằm `open` chờ `harness library accept` tay như 2C, không phải lỗi của 3B. |
| `channel demand` báo `needed > 0` mãi không giảm | `max_open_requests` đã đầy (`open_requests ≥ max_open_requests`) nên `planningNeeded` false, không plan thêm — event `channel.planning_skipped { reason: "open-cap" }` (dedupe theo ngày) | Nới `max_open_requests`, hoặc đợi request đang mở được studio xử lý xong (chuyển `fulfilled`/`open` giải phóng chỗ). |

## 7. Chi phí

`production-profiles/channel-planning/profile.yaml`'s `limits.max_cost_usd_per_variant: 3` chặn dispatch mới
khi tổng chi phí của một variant (content `planning <channel_id> <YYYY-MM-DD>` + profile + options) chạm mức
đó — `harness retry --raise-budget <usd>` nâng lên khi cần, như mọi profile khác. Một run `channel-planning`
chỉ có **một** stage agent (`propose-topics`, được web qua `WebSearch`/`WebFetch`) trong bốn stage của
workflow — ba stage còn lại (`channel-brief`, `demand`, `create-requests`) là script built-in, không gọi
model, không tốn gì. Thu số liệu (`collectStats`, cả `playwright` lẫn `fake`) **không tốn token** — không
phải một run, không đi qua ngân sách variant, chỉ là sweep worker spawn Playwright chỉ đọc (hoặc đọc file
JSON với `fake`).

## 8. Quay về thủ công

Tắt từng cờ độc lập trong `channel.yaml`, không có phụ thuộc chéo bắt buộc tắt cùng lúc:

- `planning.enabled: false` (hoặc bỏ hẳn khối `planning`, cùng default) — worker không còn tự tạo request;
  `harness library request create --channel <id> --topic "…" --style <style_id> …` (tay, như 2C/SP4) vẫn dùng
  được bình thường, kênh vẫn `auto_pick` được các item sinh ra từ request tay đó nếu `auto_pick.enabled` còn
  bật.
- `auto_pick.enabled: false` — worker không còn tự claim item; `harness library pick <item_id> --channel <id>`
  (tay, như SP3) vẫn là đường duy nhất đưa item vào kênh, `plan --workflow channel-publish@1.1.0 --profile
  channel` + `enqueue` + `worker --once` chạy tiếp như trước.
- `learning` không có cờ bật/tắt riêng — thu số **luôn chạy** khi có job `PUBLISHED` đến hạn (không phụ thuộc
  `planning`/`auto_pick`); muốn tắt hẳn, đặt `learning.recollect_hours: []` (không tái thu, chỉ còn ảnh chụp
  đầu ở `horizon_hours`) hoặc nâng `project.yaml.learning.collect_seconds` rất lớn để sweep gần như không bao
  giờ chạy (không có trường `enabled` để tắt dứt điểm — xem `docs/operations/deferred-items.md`).

`channel-publish@1.0.0` (không có stage `channel-brief`, không đọc `learned`) vẫn cài sẵn song song
`@1.1.0` — `plan --workflow channel-publish@1.0.0 --profile channel --content <id>` chạy được y hệt trước
sub-project 3B (acceptance 40); chỉ `production-profiles/channel/profile.yaml`'s `workflow_release` (dùng bởi
`maybeAutoPick`) đã trỏ `@1.1.0`, `plan` tay luôn tường minh nên không bị ảnh hưởng.

## 9. DoD #4 — thu số thật một lần trên máy có Chrome đã đăng nhập

Spec yêu cầu (§8 mục 4) xác nhận `PlaywrightStatsCollector`/`collect-stats.mjs` đọc được số liệu thật từ
YouTube Studio Analytics ít nhất một lần, trên một máy đã `channel login` (mục 1). Đây là kiểm tay — không có
cách chứng minh qua test tự động vì bản thân việc mở Studio thật là external effect phụ thuộc tài khoản, cùng
lớp với DoD #6 sub-project 3 (`channel-publish.md` mục 10) và DoD #3 sub-project 4
(`studio-autopilot.md` mục 9).

**Cách chạy:**

```sh
# project.yaml: adapters: { stats: playwright }; channel.yaml của kênh đã channel login xong (mục 1)
harness --project <channel-dir> channel collect --channel <channel_id> --job <publication_job_id> --force --json
# --force bỏ điều kiện đến hạn (horizon_hours/recollect_hours) -- thu ngay bất kể video mới lên hay chưa,
# miễn job đã PUBLISHED (collectDue chỉ xét job PUBLISHED, không xét job SCHEDULED)
harness --project <channel-dir> channel stats <channel_id> --json   # xem hàng vừa thu, source: "studio"
```

> **Trạng thái tại Task 8 (2026-09-16): chưa chạy được.** Máy build/agent thực hiện Task 8 không có Chrome
> đã đăng nhập YouTube Studio nào (`harness doctor`'s `channel:<id>:stats` row sẽ FAIL với "missing:
> .upload-profile/Default" nếu thử với `adapters.stats: playwright` trên fixture) — không có cách nào trong
> môi trường này để mở một phiên Studio thật. Toàn bộ đường ống thu số đã được kiểm bằng
> `FakeStatsCollector` (test tích hợp `channel-learning.test.ts`, acceptance 33-40) và bằng adapter thật ở
> mức "script `node --check` sạch + đúng `StatsOutcome` khi script giả trả exit 0/2/3/JSON hỏng/timeout"
> (`packages/adapters/youtube-playwright/test/`) — nhưng **chưa có lần thu nào đọc số thật từ một trang
> Analytics thật qua `chromium.launchPersistentContext`**. Người vận hành có Chrome đã đăng nhập trên máy
> kênh cần tự chạy chu trình trên rồi thêm một dòng vào bảng dưới, cùng khuôn với DoD #4/#6 các sub-project
> trước:
>
> | Ngày | Kênh | Video | Qua đủ 3 tab (Overview/Reach/Engagement)? | Ghi chú |
> | --- | --- | --- | --- | --- |
> | _(chưa có)_ | | | | |
