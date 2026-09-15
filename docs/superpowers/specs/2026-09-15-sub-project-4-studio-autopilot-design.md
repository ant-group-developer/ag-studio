# Sub-project 4: Studio tự vận hành — năm gate của kho thành stage agent, stage `watch`, worker tự nhận request

**Ngày:** 2026-09-15
**Trạng thái:** Đã duyệt thiết kế qua brainstorming, chờ implementation plan
**Tiền đề:** Sub-project 1, 2A, 2B, 2C, 3 đã merge vào `main` (2026-09-15, `aab798e`). Spec này chỉ mô tả phần thêm vào; mọi thứ không nhắc tới giữ nguyên như các spec trước (đặc biệt `2026-09-14-sub-project-2c-content-library-design.md` §3 và `2026-09-14-sub-project-3-channel-publish-design.md` §4.3 runtime agent-cli).
**Tham khảo:** spec 2C §3.3 ("Gate hôm nay, agent ngày mai"); skill `skills/channel-package/SKILL.md` (khuôn skill của harness); `@harness/adapter-agent-cli`; cách hệ cũ "xem" video bằng skill `/watch` (`D:\<kênh>\scripts\research\watch-competitor.mjs`, `review-episode.mjs`: tải + trích frame + transcript, agent tự nhìn frame); blueprint giai đoạn 4 (repo skills).

---

## 0. Quyết định đã chốt trong brainstorming

| Chủ đề | Quyết định |
|---|---|
| Sub-project 4 là gì | Studio chạy không cần người: 5 gate của kho (`analyze-style`, `style-review`, `survey-source`, `plan-edit`, `library-review`) thành stage `agent` với 5 skill; harness tự "xem" video cho agent bằng stage `watch`; worker studio tự nhận request, tự plan, tự plan lại khi review từ chối. |
| Số gate chuyển | **Cả 5, không còn gate người** trong hai workflow mới. Review do agent làm với bảng kiểm cố định; checker vẫn chặn lỗi cứng. Điểm dừng cần người chỉ còn: stage agent FAILED sau retry (WAITING_HUMAN), `style-review` giữ draft, request từ chối tới trần. |
| Cách agent xem video | **Stage built-in `watch`** (ffmpeg trích khung theo scene-change + mốc đều, contact sheet, transcript qua hook `transcribe` nếu ops project khai). Agent đọc PNG bằng `Read`. Không phụ thuộc skill `/watch` ngoài. |
| Nguồn video mẫu cho style-study | `samples.txt` nhận cả URL YouTube lẫn đường dẫn cục bộ; URL do **wrapper `collect-samples` của ops project** tải bằng yt-dlp (harness lõi không gọi yt-dlp). |
| Tự vận hành | **Có, trong SP4**: worker studio `maybeAutoAccept` — request `open` có style active → chọn source theo quy tắc → accept + plan + enqueue; review từ chối → plan lại tối đa `max_replans`. Cờ `library.auto_accept.enabled` để tắt. |
| Kiến trúc | **Phương án A**: nâng version hai workflow (`style-study@1.1.0`, `library-production@1.1.0`, bản 1.0.0 giữ nguyên cho gate người), loader hỗ trợ nhiều version song song; skill trong `skills/` của harness; stage `watch` built-in. Đã loại: B (sửa executor tại chỗ 1.0.0 — phá digest/cache/test/đường lùi); C (một agent thay survey + plan-edit — mất checker giữa hai bước). |
| Phía kênh | Không đổi. `pick` vẫn tay; tự sinh request và thu số liệu là SP3B. |

---

## 1. Cấu trúc thêm vào

### 1.1 Harness (repo này)

```
workflows/style-study@1.1.0/workflow.yaml          # §3.1
workflows/library-production@1.1.0/workflow.yaml   # §3.2
production-profiles/studio/profile.yaml            # revision 2, workflow_release library-production@1.1.0, max_cost 8
skills/{style-analyze,style-review,source-survey,edit-plan,library-review}/SKILL.md   # §4
packages/core/src/media/watch.ts                   # trích khung, contact sheet, transcript hook  §2
packages/core/src/library/auto-accept.ts           # vòng tự nhận request  §5
packages/core/src/orchestration/registry.ts        # loadWorkflow: workflows/<id>@<version>/ rồi fallback workflows/<id>/
packages/contracts/src/library.ts                  # ContentRequest.source_hint, reviewSchema (checks[]), surveyIndexSchema
packages/contracts/src/media.ts                    # watchIndexSchema (harness.watch/v1)
packages/cli/src/commands/media.ts                 # harness media watch (built-in stage)  §2
packages/cli/src/commands/library.ts               # styles activate; request create --source-hint/--source-id
fixtures/ops-project-studio/executors/wrappers/{collect-samples.mjs (URL qua yt-dlp giả), transcribe.mjs}
fixtures/fake-agent-cli.mjs                        # mode theo expected_outputs type  §6
docs/runbooks/studio-autopilot.md
```

### 1.2 Loader workflow nhiều version

`loadWorkflow(harnessRoot, "id@x.y.z")`: nếu `workflows/<id>@<x.y.z>/workflow.yaml` tồn tại → dùng; ngược lại `workflows/<id>/workflow.yaml` (phải có đúng `version`). `harness doctor` quét cả hai dạng thư mục. Digest workflow tính như cũ.

### 1.3 `project.yaml` (studio)

```yaml
library:
  root: ../kho
  role: studio
  sync_seconds: 300
  auto_accept:                       # §5; vắng → tắt
    enabled: true
    source_collection: main          # collection chọn source khi request không có source_hint
    max_replans: 2                   # số lần plan lại sau khi review từ chối
    max_concurrent_runs: 1           # run studio đang chạy tối đa do auto-accept tạo
adapters: { agent: cli }             # đã có từ SP3; stage agent cần cli (fake chỉ để test)
```

Schema: `library.auto_accept` optional `.strict()`, mặc định khi có: `enabled true`, `source_collection "main"`, `max_replans 2`, `max_concurrent_runs 1`.

### 1.4 `scripts.yaml` (studio) — hook tùy chọn

```yaml
scripts:
  transcribe: { argv: [node, executors/wrappers/transcribe.mjs], timeout_seconds: 900 }   # nhận --in <media> --out <json>
```
Không khai → `watch` ghi `transcript: null`. Wrapper thật trên máy studio gọi faster-whisper trong `D:\tools\python311`; harness không biết whisper.

---

## 2. Stage `watch` (built-in)

Lệnh `harness media watch --mode samples|source|episode`, đăng ký script built-in `watch-samples`, `watch-source`, `watch-episode` (khuôn `builtinLibraryCommands`). Chạy trong workspace do `ScriptExecutor` cấp; cần ffmpeg/ffprobe (thiếu → `fail contract`).

### 2.1 Output `output/watch/` (đăng ký `{ type: watch, kind: directory, name: watch }`)

```
output/watch/watch.json                # harness.watch/v1
output/watch/<label>/frames/f-<sss.s>.png   # khung đơn, rộng 640 px
output/watch/<label>/sheet-NN.png      # contact sheet 4×4, mỗi ô có nhãn thời gian
output/watch/<label>/transcript.json   # khi có hook transcribe
```

```ts
// harness.watch/v1
{ schema_version, mode: "samples"|"source"|"episode",
  videos: [{ label, source_path, duration_seconds, media: MediaInfo|null,
             frames: [{ t: number, file: string, kind: "scene"|"interval" }],
             sheets: string[],
             transcript: { segments: [{ start, end, text }] } | null,
             transcript_error?: string }] }
```

### 2.2 Cách lấy khung

- Scene-change: `ffmpeg -i <in> -vf "select='gt(scene,0.3)',showinfo" -f null -` đọc `pts_time` từ stderr.
- Mốc đều: `interval_seconds` (samples 8, source 10, episode 15). Hợp hai danh sách, khử trùng trong 1 s, cắt theo `max_frames` (samples 60/video, source 120, episode 80) bằng cách thưa mốc đều trước, giữ scene.
- Khung: `ffmpeg -ss <t> -i <in> -frames:v 1 -vf scale=640:-2`. Contact sheet: `ffmpeg` `tile=4x4` + `drawtext` nhãn `t` (thiếu font drawtext → bỏ nhãn, ghi cảnh báo).
- `samples`: đọc `samples.json` trong input `sample_set` (wrapper ghi `[{ label, path, url? }]`); nếu wrapper chỉ để lại ảnh (fixture 2C) → mỗi thư mục con là một `label`, dùng ảnh sẵn làm `frames`, không trích thêm.
- `source`: input `proxy_video` + `shots` (`shots.json`): thêm khung tại mỗi `shots[].in`.
- `episode`: input `episode_video`.
- Transcript: `scriptCommandNames` có `transcribe` → spawn `argv --in <media> --out <workspace>/output/watch/<label>/transcript.json` (cwd theo scripts.yaml, timeout 900 s, env qua Redactor); exit ≠ 0/timeout/JSON sai → `transcript: null`, `transcript_error`, stage vẫn `succeeded`.

### 2.3 Hợp đồng agent (chung cho 5 skill)

Agent chỉ đọc `brief.md`, `stage-request.json`, các input theo `inputs[].path`; ghi `output/<name>` đúng `expected_outputs`; xem ảnh bằng `Read`; được `Bash(ffprobe:*)`; **không mạng** trừ `style-analyze` (`WebSearch`/`WebFetch` để xác nhận kênh mẫu). Ngân sách khung: đọc contact sheet trước, tối đa 20 khung đơn. `timeout_seconds` mỗi stage agent 1800; `retry { max_attempts: 2, backoff_seconds: [60], retry_on: [transient, abandoned] }`. Runtime: `@harness/adapter-agent-cli` như SP3 (`allowedTools` của claude thêm `Read` ảnh — đã có `Read`).

---

## 3. Workflow

### 3.1 `style-study@1.1.0`

| # | key | executor | depends_on | output |
|---|---|---|---|---|
| 1 | `collect-samples` | script `collect-samples` (wrapper: URL → yt-dlp, cục bộ → copy; ghi `samples.json`) | – | `sample_set` (dir) |
| 2 | `watch-samples` | script built-in `watch-samples` | 1 | `watch` (dir) |
| 3 | `analyze-style` | agent `style-analyze` | 2, 1 | `style` (style.json draft), `style_evidence` (dir) |
| 4 | `style-review` | agent `style-review` | 3, 2 | `style` (style.json active hoặc draft), `review_notes` (review-notes.md) |
| 5 | `style-export` | script built-in `library-style-export` (không đổi: chọn style `active` trong inputs; không có → `contract`) | 4, 3 | `export_receipt` |

### 3.2 `library-production@1.1.0`

| # | key | executor | depends_on | when | output |
|---|---|---|---|---|---|
| 1 | `intake` | built-in (thêm: chép `request.notes` vào `brief.json.request_notes`) | – | – | `brief` |
| 2 | `index-source` | script | – | – | `shots`, `proxy_video` |
| 3 | `watch-source` | built-in `watch-source` | 2 | – | `watch` |
| 4 | `survey-source` | agent `source-survey` | 3, 2, 1 | – | `survey` (survey.md), `survey_index` (survey.json) |
| 5 | `plan-edit` | agent `edit-plan` | 4, 3, 1 | – | `edl`, `edit_plan`, `narration` (+ `edl-valid`) |
| 6 | `tts` | script | 5 | `options.voice == "tts"` | `narration_audio`, `captions` |
| 7 | `cut` | script | 5 | – | `clip_set` |
| 8 | `assemble` | script | 7 (opt 6) | – | `episode_video` (+ `brief-duration`) |
| 9 | `watch-episode` | built-in `watch-episode` | 8 | – | `watch` |
| 10 | `thumbnail-candidates` | script | 7 | – | `thumbnail_set` |
| 11 | `library-export` | built-in | 8, 10, 5, 1 (opt 6) | – | `export_receipt` |
| 12 | `library-review` | agent `library-review` | 9, 11, 5, 1 | – | `review` (review.json với `checks[]`) |
| 13 | `library-apply-review` | built-in (đọc `decision/note` như cũ) | 12, 11 | – | `apply_receipt` |

Hai output cùng type `watch` (stage 3 và 9) trong một run: stage 12 chỉ phụ thuộc 9 nên input `watch` của nó là của `watch-episode`; stage 4/5 chỉ thấy của `watch-source`. Checker không đổi. Profile `studio` revision 2: `workflow_release: library-production@1.1.0`, `limits.max_cost_usd_per_variant: 8`.

---

## 4. Năm skill (`skills/<tên>/SKILL.md`, tiếng Việt, khuôn `channel-package`)

| Skill | Input | Output | Tiêu chí tự kiểm (checker chặn phần cứng) |
|---|---|---|---|
| `style-analyze` | `watch/` mẫu, `samples.json`, brief; web để xác nhận kênh mẫu | `style.json` (`harness.edit-style/v1`, `status: draft`), `evidence/` (khung tiêu biểu chép từ `watch/` + `notes.md` dẫn chứng từng `params.*`) | mỗi `params.*` có ≥1 dòng dẫn chứng nêu video + mốc giây; `learned_from` đúng danh sách mẫu; không bịa transition/nhạc không thấy |
| `style-review` | `style.json` draft, `evidence/`, `watch/` | `style.json` (`active` nếu đạt, giữ `draft` nếu không) + `review-notes.md` | đối chiếu ≥5 khung ngẫu nhiên với `params`; lệch ≥2 mục → giữ draft, ghi lý do; giữ draft → `style-export` fail `contract` → run FAILED, người xem `review-notes.md` |
| `source-survey` | `watch/` source, `shots.json`, `brief.json` | `survey.md`, `survey.json` `{ schema_version: harness.survey-index/v1, shots: [{ in, out, score: 0..5, tags: [], usable: bool, note }] }` | mọi shot có điểm; ≥1 `usable`; đánh dấu shot có chữ/logo/mặt người/rung |
| `edit-plan` | `survey.json`, `survey.md`, `brief.json` (style snapshot, `target_duration_seconds`, `request_notes`), `shots.json`, `watch/` | `edl.json`, `edit-plan.json`, `narration.txt` (rỗng khi `voice=none`) | tổng `out-in` trong khoảng đích; chỉ shot `usable`; `shot_seconds`/`cut_rhythm` theo style; nếu `request_notes` có lý do từ chối trước đó thì nêu cách khắc phục trong `edit-plan.json.notes` |
| `library-review` | `watch/` bản dựng, `edit-plan.json`, `brief.json`, `export-receipt.json`, `thumbnail_set` | `review.json` `{ decision, note, checks: [{ id, pass, note }] }` | bảng kiểm cố định `duration_in_range`, `no_black_or_frozen_over_2s`, `opening_matches_style`, `text_not_clipped`, `audio_present`, `thumbnails_textless`; ≥1 fail → `rejected`, note nêu mốc giây |

Quy tắc chung: mục "Ngân sách khung"; mục "Tự kiểm" validate JSON theo schema trước khi kết thúc; không sửa ngoài `output/`; không secret; dữ liệu thiếu (transcript null, watch rỗng) → vẫn ra output, ghi hạn chế trong note, không thất bại.

Contracts mới: `reviewSchema` (`harness.review/v1`: `decision`, `note`, `checks[]` default `[]`), `surveyIndexSchema`, `watchIndexSchema`; JSON schema sinh. `library-apply-review` parse `reviewSchema` (tương thích review.json cũ chỉ có `decision/note`).

---

## 5. Vòng tự vận hành studio (`packages/core/src/library/auto-accept.ts`)

`autoAccept(d: { store, fs, catalog, planner, clock, project, profile, workflows, logger })` gọi từ worker studio ở nhánh idle, sau `maybeSyncLibrary`, mỗi `library.sync_seconds`, khi `auto_accept.enabled`:

1. Request `open` theo `created_at` tăng dần. Bỏ qua khi: không có `style_id` hoặc style không `active` trong DB; đã có `ContentItem` với `library_brief.request_id` = request mà run của nó chưa kết thúc; số run đã kết thúc cho request ≥ `max_replans + 1`; số run studio do auto-accept tạo đang RUNNING/READY/WAITING ≥ `max_concurrent_runs`.
2. Chọn source: `request.source_hint.source_ids` nếu có (phải tồn tại) → `source_hint.collection` → `auto_accept.source_collection`; trong collection lấy source `rights_status ≠ restricted` mới nhất (`ingested_at`) chưa gắn với `ContentItem` nào có `library_brief.request_id` đang `open|claimed`. Không có → event `request.auto_accept_skipped { reason: "no source" }` một lần mỗi request (đánh dấu trong `notes` bằng `auto-skip:no-source`), không lỗi.
3. Một transaction: `createContent({ source_ids: [src], title: topic, library_brief })` (như `library accept`), tạo run `library-production@<profile.workflow_release>` profile `studio`, options `{ voice: request.voice }`, enqueue; event `request.auto_accepted { request_id, run_id, replan_no }`. `intake` claim request như cũ; `intake` chép `request.notes` vào `brief.json.request_notes`.
4. Plan lại: `library-apply-review` mở lại request khi `rejected` (đã có). Vòng sau thấy `open` → `replan_no` = số run kết thúc của request; `< max_replans + 1` → plan mới cùng source; đạt trần → event `request.auto_accept_exhausted`, snapshot dashboard alert `request_stuck`.
5. Planner lỗi (workflow/profile thiếu) → log error, event `request.auto_accept_failed`, đánh dấu `notes` `auto-fail:<mã>` để không lặp mỗi lần sync.

Contracts: `ContentRequestSchema.source_hint?: { source_ids?: string[]; collection?: string }` (optional, file cũ vẫn parse). CLI: `library request create --source-hint <collection>` / `--source-id <id>` (lặp); `library styles activate <style_id>` (studio, ghi `status: active`, `revision + 1`, `updated_at`; dùng khi `style-review` giữ draft và người đồng ý bằng tay). Doctor `library:auto_accept` (bật/tắt; `source_collection` có trong sources; `adapters.agent` không phải `fake` khi enabled). Snapshot: `library.requests_open`, alert `request_stuck { request_id }`.

---

## 6. Xử lý lỗi

| Tình huống | Hành vi |
|---|---|
| ffmpeg thiếu ở `watch` | `contract`, không retry (doctor `ffprobe` đã báo) |
| Hook `transcribe` lỗi/timeout/JSON sai | cảnh báo, `transcript: null` + `transcript_error`, stage `succeeded` |
| Agent không ghi output / JSON sai schema / checker fail | `contract` hoặc FAILED → retry theo `retry` (2 attempt) → WAITING_HUMAN; request không bị plan đôi (run chưa kết thúc) |
| Agent vượt deadline / chi phí vượt profile | `transient` / `run.budget_exceeded` (2B) |
| `style-review` giữ draft | `style-export` fail `contract` "no active style" → run FAILED; người đọc `review-notes.md`, sửa tay `style.json` trong kho hoặc `library styles activate`, hoặc chạy lại `style-study` với mẫu khác |
| Review từ chối tới trần | request `open` + alert `request_stuck`; người sửa request/source hoặc nới `max_replans` |
| Planner lỗi trong auto-accept | log, event, đánh dấu notes, bỏ qua request tới khi người sửa |
| Run 1.0.0 còn dở | không ảnh hưởng; hai version song song |
| yt-dlp lỗi trong wrapper `collect-samples` | wrapper fail `transient` (retry) hoặc `contract` (URL sai) — do wrapper quyết; harness không biết yt-dlp |

---

## 7. Kiểm thử

- Unit core: `watch` (scene + interval, khử trùng, `max_frames` thưa đúng, contact sheet tồn tại và kích thước, `samples` với `samples.json` và với thư mục ảnh sẵn, `transcribe` thiếu/giả/lỗi/timeout); loader `workflows/<id>@<version>/` + fallback + doctor quét; `reviewSchema` tương thích cũ; `surveyIndexSchema`, `watchIndexSchema`; `ContentRequest.source_hint`; `autoAccept` với store temp + planner thật (chọn source theo ba đường; bỏ qua request không style/không active/đang chạy/đạt trần/vượt concurrent; đánh dấu notes; event).
- Fixture: `fake-agent-cli.mjs` ghi output hợp lệ theo `expected_outputs[].type` (`style` draft/active theo mode, `style_evidence`, `review_notes`, `survey`, `survey_index` từ `shots.json`, `edl` từ shot usable, `edit_plan`, `narration`, `review` theo env `FAKE_REVIEW_MODE=approve|reject-once|reject-always`: `reject-once` → `rejected` khi `brief.json.request_notes` rỗng (run đầu), `approved` khi đã có ghi chú từ chối (run plan lại)); wrapper `collect-samples.mjs` nhận URL: nếu `FAKE_YTDLP=1` thì tạo video giả bằng ffmpeg thay vì tải; `transcribe.mjs` ghi transcript từ `<video>.txt` cạnh nếu có.
- Tích hợp `tests/integration/studio-autopilot.test.ts` (`skipIf(!hasFfmpeg())`): kho + studio (`auto_accept.enabled`, `adapters.agent: cli`, `agent_argv` → fake) + channel; (1) `style-study@1.1.0` từ `samples.txt` (1 file cục bộ + 1 URL giả) → style `active`; (2) channel `request create --source-hint main`; studio `worker --once` lặp → auto-accept → 13 stage → item `approved`, request `fulfilled`; channel `pick` ok; không lệnh người nào ở studio ngoài `worker`; (3) `watch/` của source và episode có `watch.json` hợp lệ, `frames ≤ max_frames`.
- Acceptance: **27** `reject-once` → hai run, request `fulfilled`, event `request.auto_accepted` với `replan_no` 0 và 1; **28** `reject-always`, `max_replans: 1` → đúng hai run, alert `request_stuck`, không run thứ ba; **29** `FAKE_AGENT_MODE=no-output` ở `survey-source` → stage FAILED sau 2 attempt → WAITING_HUMAN; auto-accept không tạo run thứ hai; **30** `watch` với ffmpeg: số khung ≤ `max_frames`, có scene frame khi video có cắt cảnh (dùng `makeVideo` hai màu), transcript null không hook, có hook giả → segments; **31** không secret trong env/prompt/log của 4 stage agent (như acceptance 25); **32** workflow 1.0.0 + fixture 2C vẫn chạy (test 2C hiện có là bằng chứng).

---

## 8. Definition of Done sub-project 4

1. Từ `library request create` (channel) tới item `approved` và `pick` được, studio không cần lệnh người nào ngoài `worker` (test tích hợp).
2. `style-study@1.1.0` ra style `active` từ danh sách mẫu (file cục bộ hoặc URL qua wrapper) không cần người.
3. Bốn stage agent của `library-production@1.1.0` chạy với agent-cli thật ít nhất một tập trên máy có `claude`/`codex` (kiểm tay, ghi runbook; máy build không có CLI thì ghi rõ chưa đạt, như DoD #6 SP3).
4. Workflow 1.0.0, fixture và test 2C/3 vẫn xanh.
5. Runbook `docs/runbooks/studio-autopilot.md` (bật auto-accept, hook transcribe/yt-dlp, xử lý `request_stuck`, `style-review` giữ draft, WAITING_HUMAN của stage agent, chi phí); ADR; deferred; `pnpm build && pnpm typecheck && pnpm test` xanh.

---

## 9. Ngoài phạm vi (SP3B / sau)

Tự sinh request và thu số liệu (SP3B); agent chọn source (chỉ quy tắc); nhiều source cho một tập; whisper built-in (chỉ hook); tự kích hoạt style khi review giữ draft; `pick` tự động phía kênh; giới hạn chi phí agent theo ngày/portfolio.

---

## 10. Rủi ro và điểm mở

- **Chất lượng agent không kiểm chứng được bằng test** (fake agent luôn hợp lệ): DoD #3 là kiểm tay; checker và bảng kiểm review là lưới an toàn duy nhất trước khi mục vào kho `approved`.
- **Chi phí**: 4 stage agent × ảnh; contact sheet giảm 10×; `max_cost_usd_per_variant: 8` chặn ở mức run, chưa có trần theo ngày.
- **Scene-change ngưỡng 0.3** phù hợp footage thường; video nhiều chuyển cảnh mềm có thể ít scene frame — mốc đều bù.
- **Hai stage cùng output type `watch`** dựa vào `depends_on` để tách input; nếu sau này một stage phụ thuộc cả hai thì phải đặt tên type khác.
- **Review từ chối liên tiếp cùng source**: plan lại giữ source; nếu source là nguyên nhân thì tới trần mới có người biết — chấp nhận, `max_replans` nhỏ.
