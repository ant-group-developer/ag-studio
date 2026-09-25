# Sub-project 5C: Học cách dựng — dấu vân tay sản xuất, đường cong giữ chân, chuẩn sản xuất của kênh trả về studio

**Ngày:** 2026-09-25
**Trạng thái:** Đã duyệt thiết kế qua brainstorming, chờ implementation plan
**Tiền đề:** Sub-project 1 → 5B đã merge vào `main` (`f5cfe77`). Spec này chỉ mô tả phần thêm vào; mọi thứ không nhắc tới giữ nguyên như spec 3B (`2026-09-15-sub-project-3b-channel-learning-design.md` — vòng học tiêu đề/angle/thumbnail), spec 4 (autopilot), 5A/5B (studio media + dựng hình).
**Tham khảo:** `packages/core/src/learning/{metrics,learned,hypotheses,planning,brief,auto-pick}.ts`; `ChannelLearnedSchema`, `ChannelBriefSchema`, `VideoMetricsSchema` (`packages/contracts/src/learning.ts`), `HypothesisSchema` (`distribution.ts`), `EditStyleSchema.params`, `ContentRequestSchema`, `libraryBriefSchema`, `LibraryItemSchema` (`library.ts`); `StatsCollector` port (`interfaces.ts:192`) với `PlaywrightStatsCollector`/`FakeStatsCollector`; artifact `brief.json`, `composition.json`, `render-report.json`, `edit-plan.json` của `library-production@1.3.0`.
**Phạm vi nội dung:** harness **không** dành cho nội dung hoạt hình (ADR 116).

---

## 0. Quyết định đã chốt trong brainstorming

| Chủ đề | Quyết định |
|---|---|
| Vấn đề gốc | Tập lên kênh không mang theo cách nó được dựng: `brief`/`composition`/`render-report` bị bỏ sau `library-review`; `learned.ts` chỉ nhìn được mẫu tiêu đề, `angle`, số dòng chữ thumbnail. Vòng học 3B không thể chạm tới studio. |
| Chiều được học | **Cả bốn nhóm**: thời lượng + mở đầu; chữ trên hình + phụ đề; giọng đọc + tốc độ (**chỉ đề xuất**, không tự đổi); nhịp cắt + chuyển cảnh + nhạc. |
| Mức tự động | **Tự áp, mỗi tập đổi một biến**: chuẩn sản xuất của kênh tự cập nhật; mỗi tập mới giữ chuẩn và thử đúng một chiều (giả thuyết sản xuất, cùng khung 3B). Tắt được từng chiều trong `channel.yaml`. |
| Tín hiệu | **Thêm đường cong giữ chân** đọc từ YouTube Studio bằng Playwright; hỏng thì lùi về `avg_view_pct`, không làm hỏng lần thu; có đường nhập tay. |
| Kiến trúc | **Cách 1 — chuẩn sản xuất đè lên edit-style**: style từ style-study vẫn là nền dùng chung; mỗi kênh có tầng `production` trong `channel_learned`; studio nhận qua `brief.production`. Đã loại: tự sinh revision `edit_style` (style là của studio, dùng chung; mất khung một-biến); chỉ đề xuất cho agent (không đo được). |

---

## 1. Cấu trúc thêm vào

```
packages/contracts/src/learning.ts           # ProductionFingerprintSchema, khối production của ChannelLearned, retention trong VideoMetrics, production trong ContentRequest/brief, mở rộng HypothesisSchema.expected.metric
packages/core/src/learning/fingerprint.ts    # buildFingerprint(): brief + composition + render-report + edit-plan → fingerprint, bucket hoá
packages/core/src/learning/production.ts     # learnProduction(), nextExperiment(), bucketToDuration()
packages/core/src/learning/retention.ts      # chuẩn hoá đường cong: lấy mẫu mốc cố định, at_30s/at_60s/at_half/end
packages/core/src/library/export.ts          # ghi items/<id>/production.json
packages/core/src/distribution/packages.ts   # ChannelPackage.fingerprint lúc build-package
packages/core/src/learning/{metrics,learned,brief,planning}.ts   # retention, production trong learned/brief; create-requests đọc chuẩn
packages/adapters/youtube-playwright/src/playwright-stats-collector.ts   # đọc retention chart
packages/adapters/fake/src/fake-stats-collector.ts                       # retention giả có tham số
packages/cli/src/commands/{publish-stage,library-stage,media,channel}.ts # create-requests, intake, compose, metrics import --retention-csv
packages/core/src/verification/composition-checkers.ts   # overlays-valid đọc brief.production.density
packages/core/src/doctor/doctor.ts, packages/core/src/dashboard/snapshot.ts
skills/{edit-plan,channel-plan}/SKILL.md
docs/runbooks/production-learning.md
```

Không bảng mới, không migration: `video_metrics.data`, `channel_learned.data`, `channel_package.data` là JSON và schema mở rộng bằng trường optional/nullable với default, nên bản ghi cũ parse nguyên.

### 1.1 `channel.yaml` thêm (optional, có default)

```yaml
learning:
  production:
    enabled: true                 # false = chỉ ghi fingerprint + thống kê, không đổi request
    dimensions: [duration, opening, text, subtitles, cuts, transitions, music]   # bỏ chiều nào thì chiều đó chỉ thống kê
    experiment_every: 2           # cứ N tập thì 1 tập mang thí nghiệm
    min_samples: 3
    retention: true               # false = không đọc retention; mọi chiều dùng avg_view_pct
```

`voice` không có trong `dimensions` — giọng chỉ đề xuất, không bao giờ tự đổi (§3.4).

---

## 2. Dấu vân tay sản xuất (`harness.production-fingerprint/v1`)

### 2.1 Nội dung

```json
{ "schema_version": "harness.production-fingerprint/v1", "item_id": "item_…", "run_id": "run_…", "created_at": "…",
  "style": { "style_id": "style_…", "revision": 3 },
  "duration_seconds": 612.4, "opening_seconds": 22.0,
  "voice": { "mode": "tts", "voice_id": "voice_…", "speed": 1.0, "language": "vi" },
  "text": { "density": "medium", "events": 9, "titles": 3, "callouts": 5, "lower_thirds": 1 },
  "subtitles": { "mode": "karaoke", "cues": 148 },
  "cuts": { "segments": 41, "median_shot_seconds": 12.6, "cut_rhythm": "medium" },
  "transitions": { "kind": "dissolve", "applied": 12, "downgraded": 2 },
  "music": { "track_id": "calm-01", "mood": "calm", "duck_db": -12 },
  "loudness": { "integrated_lufs": -14.1 },
  "buckets": { "duration": "8-12", "opening": "15-30", "density": "medium", "subtitles": "karaoke", "voice": "tts",
               "cut_rhythm": "medium", "transitions": "dissolve", "music_mood": "calm" },
  "experiment": { "dimension": "duration", "value": "5-8" } }
```

Mọi khối ngoài `schema_version|item_id|run_id|created_at|style|duration_seconds|buckets` là `nullable` (tập không nhạc → `music: null`; run 1.2.0 không có `composition` → `text/subtitles/cuts/transitions/music/loudness: null`, `buckets` chỉ có `duration`/`voice`).

### 2.2 Nguồn và cách tính (`fingerprint.ts`, thuần)

| Trường | Nguồn |
|---|---|
| `style`, `voice.mode/voice_id/language`, `experiment` | `brief.json` (`style_id/style_revision`, `voice`, `voice_id`, `language`, `production.experiment`) |
| `voice.speed` | hồ sơ giọng `params.speed` (qua store) hoặc `null` |
| `duration_seconds` | `composition.total_seconds`, không có thì probe `episode.mp4` (đã có trong `exportItem`) |
| `opening_seconds` | `edit-plan.json.opening_seconds` nếu agent ghi (skill `edit-plan` thêm trường này: mốc kết thúc phần mở đầu, giây chương trình); không có → `end` của đoạn đầu trong `composition.segments` |
| `text.*` | `composition.text_events` đếm theo `kind`; `density` = `brief.production.density` nếu có, không thì `edit-style.params.text_overlay.density`, không thì bucket theo `events / (total_seconds / 60)` (`0` → none, `< 1/phút` → low, `< 2.5` → medium, còn lại high) |
| `subtitles` | `composition.captions.mode`, `cues.length` |
| `cuts` | `composition.segments`: số đoạn, median `(end − start)`; `cut_rhythm` = style nếu có, không thì bucket median (`< 6 s` fast, `< 14` medium, còn lại slow) |
| `transitions` | `composition.transitions.requested/applied/downgraded`; `kind` = kiểu xuất hiện nhiều nhất trong `segments[].transition_out` khác `cut`, không có → `cut` |
| `music` | `composition.music` + `music.duck.gain_db`; mood = `track.mood[0]` (qua store) hoặc `overlays.music.mood` |
| `loudness` | `render-report.loudness.integrated_lufs` |

Bucket: `duration` ∈ `<5 | 5-8 | 8-12 | 12-20 | >20` (phút); `opening` ∈ `<15 | 15-30 | >30` (giây); `density` ∈ `none|low|medium|high`; `subtitles` ∈ `burn-in|karaoke|none`; `voice` ∈ `none|tts|original`; `cut_rhythm` ∈ `fast|medium|slow`; `transitions` ∈ `cut|dissolve|dip_black`; `music_mood` chuỗi tự do (hoặc `none`).

### 2.3 Đường đi

- `library-export` (studio) ghi `items/<item_id>/production.json` cùng lúc `manifest.json`; `LibraryItem.files[]` liệt kê nó; `LibraryItemSchema` thêm `fingerprint: ProductionFingerprint | null` (mirror, để kênh đọc không cần mở file).
- `build-package` (kênh) chép vào `ChannelPackage.fingerprint` (nullable). `learned.ts` đọc từ package, không join ngược.
- Item cũ / run 1.1.0–1.2.0 → `fingerprint` thiếu khối, `null` khi hoàn toàn không có; các thống kê sản xuất bỏ qua tập đó, thống kê tiêu đề/angle của 3B không đổi.

---

## 3. Đường cong giữ chân và học chuẩn sản xuất

### 3.1 `VideoMetrics` thêm `retention`

```json
"retention": { "source": "studio-dom" | "manual", "points": [ { "t": 0, "pct": 100 }, { "t": 30, "pct": 71.2 }, … ],
               "at_30s": 71.2, "at_60s": 58.0, "at_half": 33.1, "end": 12.0 }
```
`retention: null` + `retention_error: string | null` khi không đọc được. Trường cũ `retention30_pct` giữ nguyên và **được suy từ** `retention.at_30s` khi có (ưu tiên giá trị mới). Mốc lấy mẫu cố định: `0, 15, 30, 60, 120, 300, 600, 900` s + `duration/2` + cuối; `retention.ts` nội suy tuyến tính từ điểm thô về các mốc này.

- `PlaywrightStatsCollector`: sau khi lấy views/CTR như nay, mở Analytics → Engagement của video, đọc dữ liệu chart "Audience retention" từ DOM/JSON của trang (không đọc ảnh); thời gian thêm ≤ 30 s mỗi video (`timeout_seconds` cộng thêm). Lỗi → `retention: null`, `retention_error`, lần thu **vẫn `ok`**.
- `FakeStatsCollector`: tham số `retention: { at_30s, at_half, end }` hoặc hàm theo `video_id`; mặc định đường cong giảm mũ có nhiễu nhỏ.
- Chỉ đọc retention khi `age_hours ≥ 72`; đánh giá dùng mốc gần `168` nhất.
- `harness channel metrics import <jsonl>` nhận trường `retention`; thêm `--retention-csv <file> --job <publication_job_id>` để nhập CSV xuất từ Studio (cột `Video position (%)`/`Watch ratio` hoặc tương đương — parser chịu hai định dạng phổ biến, ghi rõ trong runbook).
- Hai chỉ số mới cho giả thuyết: `retention_30s`, `retention_half`. `HypothesisSchema.expected.metric` mở rộng enum; `ChannelLearnedSchema.metric` giữ nguyên (chỉ tính cho giả thuyết tiêu đề).

### 3.2 Khối `production` trong `channel_learned`

```json
"production": {
  "sample_size": 14, "updated_at": "…",
  "standard": { "duration": "8-12", "opening": "15-30", "density": "medium", "subtitles": "karaoke",
                "cut_rhythm": "medium", "transitions": "dissolve", "music_mood": "calm" },
  "voice_suggestion": { "mode": "tts", "n": 4, "lift": 0.21, "note": "tts hơn original 3/4 mẫu; chưa đủ min_samples để chắc" } | null,
  "evidence": { "duration": { "metric": "retention_half", "fallback": false,
                              "groups": { "8-12": { "n": 6, "median": 34.0, "lift": 0.18 }, "12-20": { "n": 5, "median": 28.8, "lift": 0 } } }, … },
  "next_experiment": { "dimension": "opening", "value": "<15", "why": "chưa có mẫu" } | null,
  "history": [ { "at": "…", "standard": { … } } ] }
```

Chiều → chỉ số quyết định (cố định trong code, ghi runbook):

| Chiều | Chỉ số | Lùi khi thiếu retention |
|---|---|---|
| `duration`, `cut_rhythm` | `retention_half` | `avg_view_pct` |
| `opening` | `retention_30s` | `avg_view_pct` |
| `density`, `subtitles`, `transitions`, `music_mood` | `avg_view_pct` | — |
| `voice` (chỉ đề xuất) | `avg_view_pct` | — |

`learnProduction(p: { packages (committed, có fingerprint), metricsByJob, config, prior })`:
1. Với mỗi chiều đang bật: nhóm tập theo bucket; giá trị chỉ số của tập = mốc gần `horizon_hours` (168 h) nhất, thiếu → tập không tính; nhóm cần `n ≥ min_samples`.
2. `lift` của nhóm = `median(nhóm) / median(toàn kênh) − 1`. Nhóm thắng = lift cao nhất; thay chuẩn đương nhiệm chỉ khi `median(thắng) ≥ 1.10 × median(đương nhiệm)` (hoặc chưa có đương nhiệm). Chuẩn khởi đầu (chưa đủ mẫu) = bucket của `edit-style` đang active và của `channel.yaml` (voice) — ghi `source: "style"`.
3. `evidence.fallback = true` khi phải dùng `avg_view_pct` thay retention.
4. `history` giữ 20 bản; sự kiện `learning.production_learned { channel_id, changed: [dimension] }` khi chuẩn đổi.
5. Chạy ở cùng chỗ `learnChannelStandard` được gọi (sau `collect`/`evaluate`), vai kênh, thuần.

### 3.3 Mỗi tập một biến — `nextExperiment`

- Gọi lúc `create-requests`. Điều kiện: `enabled`, `sample_size ≥ min_samples`, và tập này là "lượt thí nghiệm" (`đếm request do planning tạo` mod `experiment_every === 0`); không thì `experiment: null` (tập đối chứng).
- Chọn chiều: chiều đang bật có **ít mẫu nhất** ở giá trị chưa thử (ưu tiên giá trị kề chuẩn: bucket liền kề với `duration`/`opening`, giá trị enum chưa xuất hiện với các chiều khác); hoà → theo thứ tự `duration, opening, density, subtitles, cut_rhythm, transitions, music_mood`. Không còn giá trị nào chưa thử với ≥ `min_samples` → chọn chiều có lift thấp nhất tin cậy (`n` nhỏ nhất) để lấy thêm mẫu.
- Request mang `production.experiment = { dimension, value, expected: { metric, target: median(chuẩn) } }`; các chiều khác = chuẩn. Sự kiện `learning.experiment_assigned { request_id, dimension, value }`.
- Đánh giá: khi tập có metric ở mốc 168 h, so `metric` với `target` (đạt = `≥ target × 1.05`), ghi vào `evidence` như một mẫu của bucket đó — không cần trạng thái riêng, vì mẫu tự chảy vào `learnProduction`. Giả thuyết tiêu đề của 3B chạy song song, độc lập.

### 3.4 Giọng đọc

`voice_suggestion` tính như một chiều nhưng **không bao giờ** vào `standard`/`experiment`; hiện ở dashboard và `channel-brief`. Đổi giọng = người sửa `channel.yaml`.

---

## 4. Trả về studio

### 4.1 `ContentRequest.production` (optional)

```json
"production": { "standard": { "duration": "8-12", "opening": "15-30", "density": "medium", "subtitles": "karaoke", "cut_rhythm": "medium", "transitions": "dissolve", "music_mood": "calm" },
                "experiment": { "dimension": "duration", "value": "5-8", "expected": { "metric": "retention_half", "target": 34.0 } } | null,
                "opening_seconds": 30, "learned_at": "…" }
```
- `create-requests` (kênh): khi `learning.production.enabled` và có `channel_learned.production` → điền `production` với chuẩn + thí nghiệm (giá trị thí nghiệm **ghi đè** chuẩn ở đúng chiều đó); `target_duration_seconds` = `bucketToDuration(duration)` (`<5 → [180,300]`, `5-8 → [300,480]`, `8-12 → [480,720]`, `12-20 → [720,1200]`, `>20 → [1200,1800]`); `opening_seconds` = biên trên của bucket `opening` (`<15 → 15`, `15-30 → 30`, `>30 → 45`). Chuẩn chưa có (kênh mới) → không `production`, hành vi hôm nay.
- Request tạo tay không có `production` → studio dựng theo style như nay. Có thể thêm `--production-standard` để `library request create` lấy chuẩn hiện tại (tuỳ chọn, cho thử tay).

### 4.2 `intake` → `brief.production`

`libraryBriefSchema` thêm `production` (cùng shape, optional). `intake` chép nguyên. Skill `edit-plan`: đọc `brief.production` **trước** `style_snapshot`; câu bắt buộc trong SKILL.md: "`brief.production` là chuẩn kênh đã đo, ghi đè style; `opening_seconds` là giới hạn trên của phần mở đầu; `cut_rhythm` quyết `shot_seconds`; `density` là số chữ tối đa; `transitions` là kiểu mặc định khi bạn không ghi đè; ghi `opening_seconds` thực tế vào `edit-plan.json`". Skill `channel-plan`: đọc `channel-brief.production` để không đề xuất `target_duration_seconds` trái chuẩn.

### 4.3 `media-compose` và checker

- `subtitlesOverride` = `brief.production.subtitles` khi có (ưu tiên trên `brand.subtitles.mode`, dưới `sdk.options.subtitles` của request tay).
- `music.mood` = `overlays.music.mood ?? brief.production.music_mood`.
- `transitions` mặc định = `brief.production.transitions` (trên `brand.transition.kind`, dưới `overlays.transitions[]` của agent).
- `overlays-valid`: `density` = `brief.production.density ?? edit_style?.density ?? "medium"` (đóng mục hoãn 5B "không có `edit_style` ở plan-edit").
- `brief-duration`/`library-review` kiểm `target_duration_seconds` như nay → tập lệch chuẩn bị loại → replan.

---

## 5. Doctor, dashboard, sự kiện

- Doctor (vai kênh): `channel:<id>:production` — trong 30 ngày gần nhất ≥ 80 % package committed có `fingerprint` (ok:false detail "fingerprint missing on N/M" — cảnh báo, không alert); `channel:<id>:retention` — lần thu gần nhất (age ≥ 72 h) có `retention` (3 lần liền lỗi → ok:false).
- Dashboard kênh: `production { standard, sample_size, next_experiment, voice_suggestion, last_learned_at, retention_ok }`; alert `retention_blocked` (3 lần liền `retention_error`), `production_experiment_stale` (request mang thí nghiệm đã đăng > `horizon_hours × 2` mà chưa có metric ở 168 h).
- Sự kiện: `learning.production_learned`, `learning.experiment_assigned`, `stats.retention_failed { job_id, reason }`.

---

## 6. Xử lý lỗi

| Tình huống | Hành vi |
|---|---|
| Thiếu `composition`/`render-report` lúc export (run 1.2.0) | fingerprint một phần, không fail export |
| Retention không đọc được | `retention: null`, lần thu vẫn `ok`, chiều dùng `avg_view_pct` (`fallback: true`) |
| Retention có nhưng < 3 điểm hoặc không giảm dần hợp lý (điểm sau > điểm trước + 5) | coi như hỏng, `retention_error: "implausible"` |
| Kênh < `min_samples` tập có fingerprint | không thí nghiệm, chuẩn = style, `source: "style"` |
| Tập thí nghiệm bị review loại → replan | run mới giữ nguyên `production` của request (thí nghiệm không đổi) |
| Chiều bị tắt giữa chừng | mẫu vẫn thống kê, không vào `standard`/`experiment`; request đang mở giữ nguyên |
| `channel_learned.production` hỏng/parse lỗi | học lại từ đầu, warning, không chặn |

---

## 7. Kiểm thử

- Thuần: `buildFingerprint` (đủ/thiếu artifact, bucket biên: 300 s → `5-8`, 480 s → `8-12`; density theo events/phút; transitions kiểu nhiều nhất); `retention.ts` (nội suy, `at_half`, implausible); `learnProduction` (nhóm thắng, ngưỡng 10 %, `min_samples`, fallback metric, chuẩn khởi đầu từ style, history); `nextExperiment` (ít mẫu nhất, giá trị kề, `experiment_every`, chiều tắt không được chọn, hết giá trị → chiều `n` nhỏ nhất); `bucketToDuration`; `overlays-valid` với `brief.production.density`; schema cũ parse nguyên.
- Adapter: `FakeStatsCollector` retention có tham số; `PlaywrightStatsCollector` với trang HTML cố định (fixture) cho parser retention; lỗi DOM → `retention: null` + thu vẫn `ok`.
- Tích hợp (`tests/integration/production-learning.test.ts`, world 1.3.0 + kênh, engine giả, agent giả, ffmpeg thật): 4 tập với `FAKE_NARRATION_TEXT`/thời lượng khác nhau đăng giả, stats giả trả retention có chủ ý → `channel_learned.production.standard.duration` = nhóm thắng → request thứ 5 (planning) có `production` + `experiment` đúng một chiều → brief của run có `production` → `composition.captions.mode` theo chuẩn → `production.json` trong item và `ChannelPackage.fingerprint`; tắt `enabled` → request không có `production`; item 1.2.0 (world `workflow_release` cũ) không phá học.
- Acceptance 54–58: (54) fingerprint đi theo item và package; (55) retention lỗi không làm hỏng thu số và học lùi về `avg_view_pct`; (56) mỗi tập thí nghiệm chỉ khác chuẩn đúng một chiều; (57) chiều tắt không bao giờ vào request; (58) kênh dưới `min_samples` không thí nghiệm, chuẩn từ style.
- Chạy thật: cần một kênh đã có ≥ 3 video công khai ≥ 72 h; `channel collect` bằng Playwright thật đọc retention, so bằng mắt với biểu đồ Studio; ghi `docs/runbooks/production-learning.md`.

---

## 8. Definition of Done sub-project 5C

1. Vòng kín tích hợp §7 xanh: 4 tập giả → chuẩn sản xuất → request thứ 5 mang đúng một thí nghiệm → studio dựng theo chuẩn → fingerprint về kênh.
2. Retention thật đọc được từ YouTube Studio cho ≥ 3 video của một kênh thật (hoặc, nếu chưa có kênh đủ điều kiện, nhập CSV tay và ghi rõ trong runbook là đường Playwright chưa chạy thật).
3. Anh xem `channel_learned.production` và `next_experiment` của kênh thử, xác nhận chuẩn "đọc hiểu được" (evidence có `n`, median, lift).
4. Runbook `production-learning.md`, ADR (mục 127+), `deferred-items` ("Sau sub-project 5C"), `channel-learning.md` cập nhật, template `channel.yaml`, `agent-bootstrap.md` §9 thêm bật `learning.production`.
5. `pnpm build && pnpm typecheck && pnpm test` xanh; `pnpm gen:schemas` không drift; workflow 1.x và `channel-*` byte-identical (chỉ contracts/core/cli/adapters/skills đổi).

---

## 9. Ngoài phạm vi

Tự đổi giọng; sửa `edit-style` gốc theo số của một kênh; học thumbnail hình ảnh; A/B nhiều biến cùng lúc; retention theo từng đoạn cắt (khớp `composition.segments` với đường cong — vòng sau); YouTube Analytics API (vẫn Playwright + nhập tay); học chéo kênh.

---

## 10. Rủi ro và điểm mở

- **DOM của Studio Analytics đổi** → retention hỏng hàng loạt; đường lùi là `avg_view_pct` + CSV tay; alert `retention_blocked` để người biết sớm.
- **Ít mẫu**: kênh đăng 2–3 tập/tuần cần 4–6 tuần mới đủ `min_samples` cho vài bucket; giữ `experiment_every: 2` để không kéo chất lượng xuống vì thử quá nhiều.
- **Nhiễu do đề tài**: cùng thời lượng nhưng đề tài khác nhau; giảm bằng median và ngưỡng 10 %, chấp nhận là sai số của vòng đầu; ghi `angle` cạnh mỗi mẫu trong `evidence` để người đọc tự thấy.
- **Thí nghiệm gặp replan**: request giữ `production`, nhưng agent có thể không đạt `opening_seconds` — `brief-duration` chỉ kiểm tổng thời lượng; kiểm mở đầu để `library-review` (skill) đọc `edit-plan.opening_seconds` so với brief; nếu thiếu tin cậy, thêm checker nhỏ ở vòng sau.
- **`opening_seconds` do agent tự ghi** → có thể sai; fingerprint lấy `end` đoạn đầu làm đường lùi; ghi `source` trong fingerprint.
