# Sub-project 2: Source catalog, profile footage và bọc script sản xuất

**Ngày:** 2026-09-12
**Trạng thái:** Đã duyệt thiết kế qua brainstorming, chờ implementation plan
**Tiền đề:** Sub-project 1 (control plane tối thiểu) đã merge vào `main` ngày 2026-09-12. Spec này chỉ mô tả phần thêm vào; mọi thứ không nhắc tới giữ nguyên như spec `2026-09-11-harness-structure-and-control-plane-design.md`.
**Tham khảo:** blueprint mục 3 (lineage), 8.1–8.2 (ingest, fan-out), 10.1 (giới hạn đồng thời), 12 (invalidation/cache), 18.3 mục 6, 7, 9, 12.

---

## 0. Quyết định đã chốt trong brainstorming

| Chủ đề | Quyết định |
|---|---|
| Profile đầu tiên | `footage`: dựng video chủ yếu từ video source do người vận hành cung cấp. Voice-over TTS và nhân vật avatar là tùy chọn theo từng chủ đề. `cartoon` và `avatar` thuần là sub-project sau. |
| Các repo kênh trên ổ D: của máy này | Không phải mục tiêu. Chỉ dùng inventory của chúng làm ví dụ về hình dạng một pipeline thật. Harness không chứa đường dẫn hay tên script của bất kỳ kênh nào. |
| Stage cần LLM (đề tài, kịch bản, kế hoạch dựng, QC thumbnail) | Executor loại `gate`: harness dừng ở `WAITING_HUMAN`, người hoặc phiên Claude/Codex nộp kết quả bằng `harness stage submit`. Sub-project 4 chỉ đổi executor của các stage này thành `agent`. |
| Bọc script ngoài | Operations project khai báo lệnh trong `executors/scripts.yaml` và sở hữu wrapper. Harness cấp giao thức file và gói `@harness/script-sdk`. Không sửa script của repo kênh. |
| Tài nguyên dùng chung | Tối thiểu: resource có capacity, stage khai `requires_resources`, `claim()` bỏ qua stage khi hết slot. Không fair-queue, không ưu tiên. |
| Mô hình pipeline | Mỗi bước sản xuất là một stage (10 stage), artifact và retry riêng từng bước, invalidation theo graph. |

---

## 1. Cấu trúc thêm vào

### 1.1 Harness (repo này)

```text
packages/
├── script-sdk/                       # @harness/script-sdk: helper cho wrapper ngoài. Chỉ phụ thuộc node builtins.
├── core/src/
│   ├── source-catalog/               # ingest, fingerprint, dedupe, rights; bảng source_item, content_item, content_variant
│   ├── resources/                    # named resource + capacity; đếm lease đang giữ; dùng trong claim()
│   ├── orchestration/                # planner: `when`, depends_on_optional, cache_key/reuse; controller: invalidation STALE
│   └── verification/checkers/        # media-probe, duration-range, audio-integrity, clip-set-complete
├── executors/src/
│   ├── gate-executor.ts              # stage gate: ghi request + brief.md, trả outcome deferred
│   └── script-executor.ts            # (có sẵn) + registry đọc từ scripts.yaml, env từ secret ref, timeout theo stage
└── adapters/ffprobe/                 # @harness/adapter-ffprobe: MediaProber bọc ffprobe
workflows/footage-production/workflow.yaml
production-profiles/footage/profile.yaml
project-template/
├── executors/scripts.yaml            # mẫu ánh xạ stage → lệnh
├── executors/wrappers/*.mjs          # wrapper mẫu dùng script-sdk (giả, chạy được)
└── source-catalog/sources.yaml
fixtures/ops-project-footage/         # ops project test: scripts.yaml + wrapper giả cho cả 10 stage + source video 5 giây sinh lúc test
docs/runbooks/wrap-a-channel.md
```

### 1.2 Operations project (theo máy) sở hữu

- `executors/scripts.yaml` và `executors/wrappers/*.mjs`: bọc script của repo kênh trên máy đó.
- `source-catalog/sources.yaml`: sổ đăng ký source có review trong Git.
- `project.yaml` thêm `resources: { cpu: 4, gpu: 1, image-gen: 2, heygen: 1 }` (tên tự do, số nguyên ≥ 0).

### 1.3 Runtime data thêm

```text
<data-root>/sources/normalized/<source_id>/source.json    # uri gốc, checksum, mime, duration, width/height, language
<data-root>/sources/normalized/<source_id>/<basename>     # hardlink tới file gốc nếu cùng ổ, copy nếu khác ổ, hoặc chỉ tham chiếu (cấu hình `source.materialize: link|copy|reference`)
<data-root>/artifacts/<content_id>/<variant_id>/<artifact_id>/
```

### 1.4 CLI thêm

```text
harness source ingest <path> [--collection main] [--rights cleared|unknown|restricted] [--language vi] [--json]
harness source list [--json] · harness source verify · harness source sync
harness content create --source src_… [--source src_…]... --title "…" [--json]
harness plan --content content_… --profile footage [--option voice=tts] [--option avatar=heygen] [--option subtitles=true]
harness stage submit <stage_run_id> [--from <dir>]        # nộp output cho stage gate
harness resources status
harness doctor                                            # kiểm scripts.yaml khớp workflow, wrapper tồn tại, ffprobe có, resource hợp lệ
```

### 1.5 Ranh giới giữ nguyên

`core` không import adapter; wrapper chỉ nói chuyện với harness qua `stage-request.json`/`stage-result.json`; secret vào wrapper qua biến môi trường do executor resolve từ `secret://`, và giá trị đó vào Redactor.

---

## 2. Mô hình dữ liệu

### 2.1 Lineage

```text
SourceItem (src_…) ──ingest──▶ ContentItem (content_…) ──plan──▶ ContentVariant (variant_… , profile footage@N, options) ──▶ Run
```

- **SourceItem**: `harness source ingest` tính sha256, đọc metadata bằng ffprobe (nếu là media), ghi `source.json`, chèn bảng `source_item`. Trùng checksum → trả về source cũ, không tạo mới. `rights_status` mặc định `unknown`; profile có thể yêu cầu `cleared`.
- **Sổ đăng ký vs chỉ mục**: `source-catalog/sources.yaml` trong ops project là bản có review; bảng `source_item` là chỉ mục máy đọc. `harness source sync` thêm vào DB những source có trong yaml mà chưa có trong DB (theo checksum) và báo source có trong DB mà không có trong yaml.
- **ContentItem**: `harness content create` gom một hoặc nhiều source; `revision` tăng khi danh sách source đổi.
- **ContentVariant**: sinh khi `harness plan --content --profile`; khóa duy nhất `(content_id, profile_id, profile_revision, options_digest)`. Plan lại cùng khóa → run mới cho variant cũ (re-run). `options` là JSON: `{ voice: "none"|"tts"|"original", avatar: "none"|"heygen", subtitles: boolean }`, validate bằng schema trong profile.
- `Run` có thêm `content_id`, `variant_id` (đã có trường optional từ sub-project 1).

### 2.2 Bảng mới trong state store (migration `0002_catalog.sql`)

`source_item`, `content_item`, `content_variant` theo mẫu document (`id`, `data` JSON, cột index: `checksum` cho source, `content_id`+`profile_id` cho variant). Bảng `lease` thêm cột `resources TEXT` (JSON mảng tên resource) để `claim()` đếm.

---

## 3. Workflow `footage-production@1.0.0`

| # | stage_key | executor | depends_on | depends_on_optional | when | requires_resources | output chính |
|---|---|---|---|---|---|---|---|
| 1 | `index-source` | script | – | – | – | `cpu` | `shots.json` (phân cảnh, transcript nếu có tiếng), `proxy.mp4` |
| 2 | `select-topic` | gate | index-source | – | – | – | `topic.md` |
| 3 | `write-script` | gate | select-topic | – | – | – | `narration.txt`, `script.md` |
| 4 | `edit-plan` | gate | write-script, index-source | – | – | – | `edl.json` |
| 5 | `tts` | script | write-script | – | `options.voice == "tts"` | `gpu` | `narration.wav`, `captions.json` |
| 6 | `avatar` | script | write-script, edit-plan | – | `options.avatar == "heygen"` | `heygen` | `avatar-clips/` (`clip_set`) |
| 7 | `cut` | script | edit-plan | – | – | `cpu` | `cuts/` (`clip_set`) |
| 8 | `assemble` | script | cut | tts, avatar | – | `cpu` | `full-episode.mp4` |
| 9 | `thumbnail-render` | script | cut, write-script | – | – | – | `thumbnail.png` |
| 10 | `thumbnail-qc` | gate | thumbnail-render | – | – | – | `qc-checklist.json` |

Quy tắc:
- **`when`**: biểu thức đơn giản `options.<key> == "<value>"` hoặc `!=`. Planner đánh giá lúc `plan`; stage sai điều kiện **không được tạo** trong run. Dependency của stage khác trỏ tới stage bị bỏ được thay bằng dependency của stage bị bỏ (nối xuyên). Workflow schema từ chối `when` tham chiếu key không có trong `profile.options_schema`.
- **`depends_on_optional`**: chỉ giữ nếu stage đó tồn tại trong run; nếu có thì phải SUCCEEDED trước khi release.
- `assemble` đọc `edl.json`, ghép `cuts/` + voice-over (nếu có `tts`) + avatar (nếu có) + phụ đề (nếu `options.subtitles`); `voice == original` giữ tiếng gốc trong cut.
- `edl.json` là hợp đồng giữa gate và script: mảng `{ source_id, in, out, order, overlay?: "avatar" | null, note }`; schema trong `contracts` (`EdlSchema`), checker `edl-valid` xác thực trước khi `cut` chạy.

### 3.1 Artifact tập hợp

`StageOutput` và `StageInput` thêm `kind: "file" | "directory"` (mặc định `file`). Với `directory`, registry chuyển cả thư mục, `manifest.json` liệt kê từng file với checksum và kích thước, `checksum` của artifact = digest canonical của danh sách đó. Kiểu artifact: `clip_set`, `image_set`. `materializeInputs` hardlink/copy cả cây vào `input/<artifact_id>/`.

### 3.2 Invalidation

Khi một stage có artifact ACCEPTED mới (re-run gate hoặc script) trong cùng variant, controller đánh dấu `STALE` mọi artifact ACCEPTED của các stage **phụ thuộc bắc cầu** trong graph của run trước (đọc `depends_on` + `depends_on_optional`). Quy tắc suy ra từ graph, không hard-code: đổi `edl.json` → cut/assemble/thumbnail stale, `tts` không; đổi script → tts/avatar/assemble/thumbnail stale, cut không nếu EDL không đổi (cut phụ thuộc edit-plan, không phụ thuộc write-script). Nâng checker version không làm stale (chỉ cần re-verify, ngoài phạm vi).

### 3.3 Cache/tái sử dụng

`cache_key = sha256(canonical({ stage_definition_digest, input_artifact_checksums, effective_config_digest, options_digest, executor_version }))`. Khi plan run mới cho variant đã có artifact ACCEPTED (không STALE) với `cache_key` khớp và profile `reuse: allow`, planner tạo stage đó ở `SUCCEEDED` ngay, liên kết artifact cũ (bảng `artifact_link` hoặc trường `reused_from`), event `stage.reused`. `reuse: never` bỏ qua. Gate không cache (luôn tạo lại để người quyết định) trừ khi `--reuse-gates`.

---

## 4. Giao thức wrapper và script-sdk

### 4.1 `executors/scripts.yaml` (ops project)

```yaml
schema_version: harness.scripts/v1
scripts:
  index-source:     { argv: ["node", "executors/wrappers/index-source.mjs"], cwd: ".", requires_resources: [cpu], timeout_seconds: 1800 }
  tts:              { argv: ["node", "executors/wrappers/tts.mjs"], cwd: ".", env_refs: {}, requires_resources: [gpu], timeout_seconds: 3600 }
  avatar:           { argv: ["node", "executors/wrappers/avatar.mjs"], env_refs: { HEYGEN_API_KEY: "secret://heygen/main" }, requires_resources: [heygen], timeout_seconds: 3600 }
  cut:              { argv: ["node", "executors/wrappers/cut.mjs"], requires_resources: [cpu] }
  assemble:         { argv: ["node", "executors/wrappers/assemble.mjs"], requires_resources: [cpu], timeout_seconds: 3600 }
  thumbnail-render: { argv: ["node", "executors/wrappers/thumbnail-render.mjs"] }
```

- `cwd` tương đối với thư mục ops project; argv chạy với `cwd` đó, còn đường dẫn workspace đi trong `stage-request.json` (`workspace_uri` tuyệt đối). Điều này cho phép wrapper gọi script của repo kênh theo đường dẫn riêng của máy.
- `requires_resources` ở scripts.yaml **ghi đè** giá trị trong workflow (máy biết mình có gì). `timeout_seconds` giới hạn trên của deadline stage.
- Composition root nạp registry này thay cho `fakeScriptCommands()`; `harness doctor` báo stage script nào chưa có lệnh, wrapper nào không tồn tại, secret ref nào không resolve được.

### 4.2 `stage-request.json` mở rộng

- `inputs[]`: thêm `kind`.
- `options`: JSON options của variant.
- `source_items[]`: `{ source_id, uri, checksum, mime_type, duration_seconds }` với `uri` là bản chuẩn hóa; wrapper đọc trực tiếp (video lớn không copy vào workspace).
- `resources[]`: tên resource stage đang giữ (để wrapper biết nó có GPU).
- Secret **không** nằm trong request; đi qua env của tiến trình con.

### 4.3 `@harness/script-sdk`

Gói ESM JS + `.d.ts`, không phụ thuộc gì ngoài node builtins, publish được như npm package:

```js
import { start } from "@harness/script-sdk";
const ctx = await start();                 // đọc stage-request.json ở cwd hiện tại hoặc HARNESS_WORKSPACE
ctx.request                                // StageRequest
ctx.input("narration.txt")                 // đường dẫn tuyệt đối của input theo type hoặc path
ctx.source(0)                              // source_items[0]
await ctx.out.file("output/narration.wav", { type: "voice_track", mime: "audio/wav" });   // tính checksum
await ctx.out.dir("output/cuts", { type: "clip_set" });
ctx.heartbeat({ percent: 40 });            // ghi progress.json trong workspace
ctx.log.info("…")                          // stdout dạng JSON một dòng, executor chuyển vào logger có redaction
await ctx.done({ cost_usd: 0, wall_seconds });         // ghi stage-result.json, exit 0
await ctx.fail("transient" | "result" | "contract", "message", details);   // ghi result outcome failed, exit 0
await ctx.op.intent({ provider, kind, target, payload })   // external effect có phí: ghi INTENT_RECORDED qua CLI con `harness op intent`
await ctx.op.confirm(operation_id, { provider_ref, receipt })
ctx.out.clear()                            // dọn output dở khi attempt chạy lại
```

`ctx.op.*` gọi `harness op intent|confirm|lost` bằng child process (CLI đã có journal); cách này giữ wrapper không phụ thuộc `core`. Executor script tạo `HARNESS_WORKSPACE`, `HARNESS_PROJECT`, `HARNESS_ATTEMPT_ID`, `HARNESS_FENCING_TOKEN` trong env để CLI con ghi đúng attempt.

### 4.4 Gate executor và `harness stage submit`

- Executor `gate`: tạo workspace, ghi `stage-request.json` và `brief.md` (mô tả stage, input, output mong đợi lấy từ stage definition `outputs[]`), trả `outcome: deferred` → controller đưa stage sang `WAITING_HUMAN` (đường có sẵn). Attempt kết thúc, lease được trả, không heartbeat.
- `harness stage submit <stage_run_id> [--from <dir>]`: kiểm stage ở `WAITING_HUMAN`; lấy workspace của attempt cuối (hoặc copy từ `--from` vào `output/`); tính checksum từng file theo `outputs[]` khai báo; dựng `StageResult`; chuyển stage `WAITING_HUMAN → READY → CLAIMED → RUNNING` trong một attempt "submit" do CLI sở hữu (owner `cli-submit`), rồi chạy verifier và `Controller.commit` như worker. Fail check → in danh sách thiếu, stage về `WAITING_HUMAN`, không đếm `result_failures`.
- `gate_deadline_seconds` trong stage definition: quá hạn → event `stage.gate_overdue` mỗi lần `harness status` hoặc worker reap; không tự hủy.

### 4.5 Tài nguyên trong claim

- `project.yaml.resources` → snapshot vào `harness.yaml` runtime; `claim()` trước khi chọn stage đếm `SELECT resources FROM lease` và tính slot còn lại cho từng tên; stage cần resource hết slot bị bỏ qua (không lỗi). Lease ghi `resources` khi tạo; lease hết hạn/giải phóng trả slot. Resource không khai báo trong `project.yaml` được coi là capacity 0 và `harness doctor` báo lỗi.
- Event `stage.waiting_resource` khi một stage READY bị bỏ qua vì resource liên tục quá `resource_wait_warn_seconds` (mặc định 600).

---

## 5. Kiểm chứng media

`MediaProber` interface trong contracts: `probe(path) → { container, duration_seconds, video?: { codec, width, height, fps }, audio?: { codec, channels, sample_rate }, silence_ratio? }`. `@harness/adapter-ffprobe` triển khai bằng `ffprobe -show_streams -show_format` và `ffmpeg -af silencedetect` cho `silence_ratio` (tùy chọn).

Checker mới (`core/verification/checkers/`), nhận `MediaProber` qua constructor:

| check_id | Áp dụng | Fail khi |
|---|---|---|
| `media-probe` | mọi output video/audio | không đọc được container/stream |
| `duration-range` | `full-episode.mp4` | ngoài `profile.content.target_duration_seconds` |
| `audio-integrity` | `narration.wav`, `full-episode.mp4` | không có stream audio, hoặc `silence_ratio` > ngưỡng profile |
| `clip-set-complete` | `cuts/` | thiếu clip cho một entry EDL, hoặc thời lượng clip lệch quá 0.5 s so với `out - in` |
| `edl-valid` | `edl.json` | sai schema, `in >= out`, source_id không thuộc content |

Profile `footage` khai `required_checks` cho từng stage qua `verification.required_checks_by_stage`.

---

## 6. Xử lý lỗi

| Tình huống | Hành vi |
|---|---|
| Source hỏng/mất (checksum lệch, file không còn) | `index-source`/`cut` fail loại `contract` → `WAITING_HUMAN`; `harness source verify` liệt kê source hỏng |
| Hết slot tài nguyên | Không phải lỗi; stage nằm READY, event `stage.waiting_resource` sau ngưỡng |
| Wrapper chết giữa job dài | Lease hết → reaper → attempt mới, workspace mới; wrapper dùng `out.clear()`/idempotent |
| External effect có phí trong wrapper (HeyGen) | Wrapper ghi intent qua `ctx.op.intent` trước khi gọi API; mất kết nối → `ctx.op.lost` → stage `NEEDS_RECONCILIATION` như sub-project 1; `harness reconcile` dùng adapter provider (HeyGen adapter thật là sub-project 3, ở đây provider giả) |
| Gate quá hạn | Event cảnh báo, run vẫn WAITING |
| Submit thiếu output/sai check | In checklist, stage giữ `WAITING_HUMAN`, không tạo attempt lỗi |
| Vượt `max_cost_usd_per_variant` | Controller cộng cost; khi vượt, stage kế tiếp không được release (run `WAITING`, event `run.budget_exceeded`); `harness retry --raise-budget` để mở lại (acceptance 9) |

---

## 7. Kiểm thử

1. **Unit**: `when` và nối xuyên dependency; `depends_on_optional`; resource counting trong `claim()`; `cache_key` và reuse; invalidation bắc cầu; `EdlSchema`; checker media với fixture 2 giây sinh bằng ffmpeg lúc test (git-ignored, bỏ qua test nếu không có ffmpeg).
2. **Integration** (`fixtures/ops-project-footage/`): wrapper giả dùng script-sdk cho cả 10 stage; source video 5 giây; chạy trọn workflow với hai variant khác `options` song song; re-run tái sử dụng cache; đổi `edl.json` làm stale đúng phạm vi; gate qua `harness stage submit`.
3. **Acceptance** (blueprint 18.3): mục 6, 7, 9, 12; cộng **secret e2e**: wrapper `avatar` giả nhận `HEYGEN_API_KEY` giả qua env và cố tình in nó ra stdout; log/event ra ngoài phải bị che.

---

## 8. Definition of Done sub-project 2

- Ingest một source video, tạo content, plan hai variant (`voice=tts,avatar=heygen` và `voice=original`), cả hai chạy tới `full-episode.mp4` ACCEPTED với lineage về đúng source, trên fixture ops project với wrapper giả.
- Gate hoạt động qua `harness stage submit`, không cần SDK agent.
- Capacity `gpu: 1` chứng minh được: hai stage `tts` không chạy đồng thời.
- Acceptance 6, 7, 9, 12 và secret e2e pass; `pnpm test` xanh; `harness doctor` xanh trên fixture.
- `@harness/script-sdk` có README và ví dụ wrapper; `docs/runbooks/wrap-a-channel.md` hướng dẫn nối một repo kênh thật (dùng inventory ổ D: làm ví dụ minh họa, không bắt buộc).
- Các mục ★ trong `docs/operations/deferred-items.md` được xử lý ở đầu sub-project: validation `lease_seconds > heartbeat_seconds`, `retry` từ chối `CANCEL_REQUESTED`, worker gọi `advance` sau reap, quét artifact mồ côi (`harness artifacts sweep`).

---

## 9. Ngoài phạm vi

- Adapter HeyGen, TTS, YouTube thật (sub-project 3); ở đây mọi wrapper trong fixture là giả nhưng đúng giao thức.
- Stock footage bổ sung, profile `cartoon`/`avatar` thuần.
- Agent runtime (sub-project 4): gate thay bằng agent.
- Fair-queue, ưu tiên, reservation (blueprint giai đoạn 6).
- Re-verify khi checker lên version.

## 10. Rủi ro và điểm mở

- **Artifact thư mục lớn** (cuts, clip_set): hardlink giữ chi phí thấp cùng ổ; khác ổ thì copy, cần theo dõi dung lượng và retention.
- **`when` chỉ so sánh bằng/khác**: đủ cho voice/avatar/subtitles; mở rộng sau nếu cần.
- **Submit qua CLI tạo attempt "cli-submit"**: cần đảm bảo fencing như worker; CLI giữ lease trong lúc verify+commit.
- **ffprobe là phụ thuộc hệ thống**: `harness doctor` kiểm; test media bỏ qua có thông báo khi thiếu.
