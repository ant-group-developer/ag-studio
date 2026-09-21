# Sub-project 5A: Media thật cho studio — hiểu nguồn nhiều clip, giọng đọc OmniVoice, khớp hình theo lời

**Ngày:** 2026-09-21
**Trạng thái:** Đã duyệt thiết kế qua brainstorming, chờ implementation plan
**Tiền đề:** Sub-project 1, 2A, 2B, 2C, 3, 4, 3B đã merge vào `main` (`14be7be`). Spec này chỉ mô tả phần thêm vào; mọi thứ không nhắc tới giữ nguyên như spec 2C (kho), spec 4 (`2026-09-15-sub-project-4-studio-autopilot-design.md`) và spec 3B.
**Tham khảo:** `k2-fsa/OmniVoice` (Apache-2.0; `pip install omnivoice`, torch 2.8; `OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map, dtype)`, `model.generate(text, ref_audio, ref_text, num_step, speed)` → list `np.ndarray` 24 kHz; CLI `omnivoice-infer`); WhisperX (ASR + forced alignment wav2vec2, mốc thời gian từng từ); hệ cũ `D:\tai-chinh2d-k1\_tts-engine\gen.py` (chia câu ≤ 280 ký tự, lưu chunk, resume) — chỉ tham khảo, không sửa; `packages/core/src/media/watch.ts` (bộ lọc `scene` của ffmpeg đã dùng).
**Phạm vi nội dung:** harness **không** dành cho nội dung hoạt hình; đường sản xuất duy nhất là dựng từ source quay.

---

## 0. Quyết định đã chốt trong brainstorming

| Chủ đề | Quyết định |
|---|---|
| Kiểu video | **Cả hai tuỳ tập**, theo `request.voice`: `tts` (hình quay + giọng đọc mới), `original` (giữ tiếng gốc, cắt theo lời), `none` (hình + nhạc). Phải làm đủ TTS lẫn transcript. |
| Engine | **Gọi thẳng thư viện Python, chạy trên GPU của máy**: `omnivoice` (mô hình `k2-fsa/OmniVoice`) cho TTS, WhisperX cho transcript và căn chỉnh từ. Không gọi app OmniVoice Studio, không dịch vụ đám mây, không secret. |
| Chia việc | **5A = hiểu nguồn + giọng đọc** (spec này). **5B = dựng hình** (chữ, nhạc + ducking, phụ đề, chuyển cảnh, tỉ lệ khung) dựa trên `timeline.json` của 5A. Thumbnail thật sau 5B. |
| Giọng | **Mỗi kênh một giọng cố định**, nhân từ clip mẫu: hồ sơ giọng nằm trong kho `voices/<voice_id>/`, `channel.yaml` khai `voice_id`, request tự mang theo. |
| Ngôn ngữ | **Theo từng kênh, nhiều ngôn ngữ**: lấy từ `request.language`; không giả định ngôn ngữ nào; test với `vi` và `en`. |
| Khớp nhịp | **Hình theo lời**: TTS đọc tự nhiên; stage `media-fit-edl` chỉnh EDL cho vừa lời; thiếu hình thì không fail mà ghi báo cáo để `library-review` loại và replan. |
| Số nguồn | **Nhiều clip mỗi tập**: một buổi quay = một `collection`; index/transcribe/watch chạy trên mọi source của content; `shots.json`/`survey.json` mang `source_id` + `shot_id`. |
| Kiến trúc | **Phương án A**: engine Python đi kèm repo (`engines/python/`), bốn stage built-in `media-index|media-transcribe|media-tts|media-fit-edl` (khuôn `watch`), cổng chọn qua `adapters.media: python|fake`. Đã loại: B (wrapper trong từng ops project — không test tập trung); C (dịch vụ Python thường trực — phải quản tiến trình sống lâu). |
| Nguyên tắc | Core thuần TypeScript, Python chỉ là tiến trình con giao tiếp bằng file JSON; không gate người; mọi test hiện có xanh nguyên trạng; `library-production@1.1.0` byte-identical. |
| Tự chốt (người dùng không phản đối) | Dò cảnh bằng bộ lọc `scene` của ffmpeg (không thêm phụ thuộc); với `original`, điểm cắt bắt về ranh giới từ. |

---

## 1. Cấu trúc thêm vào

### 1.1 Harness (repo này)

```
engines/python/
  requirements.txt           # omnivoice, whisperx, soundfile, numpy (torch cài riêng theo CUDA — README)
  transcribe.py              # WhisperX: lô audio → segments + words
  tts.py                     # OmniVoice: lô dòng lời → wav từng dòng; rồi căn chỉnh từ bằng WhisperX align
  _io.py                     # đọc job JSON, ghi result JSON nguyên tử, log dòng JSON ra stderr
  README.md                  # dựng venv trên Windows + CUDA, tải trước mô hình, kiểm tay
packages/contracts/src/media-engine.ts     # schema: shots v2, transcript, narration, narration-timing, fit-report, timeline, voice; cổng MediaEngine
packages/core/src/media/{scene,index,transcribe,tts,fit-edl,timeline,sentences}.ts
packages/adapters/media-python/            # PythonMediaEngine: spawn python, env đã lọc, timeout, parse result
packages/adapters/fake/src/fake-media-engine.ts
packages/cli/src/commands/media.ts         # thêm `media index|transcribe|tts|fit-edl` cạnh `watch`
packages/cli/src/commands/library.ts       # thêm `library voices add|list|retire`
workflows/library-production@1.2.0/workflow.yaml
production-profiles/studio/profile.yaml    # revision 3 → library-production@1.2.0
skills/{source-survey,edit-plan,library-review}/SKILL.md   # sửa
fixtures/ops-project-studio/, fixtures/ops-project-footage/executors/wrappers/assemble.mjs, fixtures/fake-agent-cli.mjs
docs/runbooks/studio-media.md
```

Quy tắc phụ thuộc giữ nguyên: `contracts` → `core` → adapter → `cli`. `core` không import Python hay adapter; nó nhận `MediaEngine` qua deps. Composition root là nơi duy nhất chọn `PythonMediaEngine` hay `FakeMediaEngine`.

### 1.2 Cổng `MediaEngine` (contracts)

```ts
export interface TranscribeJob { items: { source_id: string; audio_path: string; language: string | null }[]; out_dir: string }
export interface TtsJob { lines: { line_id: string; text: string; out_path: string }[]; language: string; voice: { ref_audio: string; ref_text: string; params: VoiceParams }; align: boolean }
export type EngineOutcome<T> = { kind: "ok"; result: T } | { kind: "contract"; reason: string } | { kind: "transient"; reason: string };
export interface MediaEngine {
  readonly name: string;
  transcribe(job: TranscribeJob, o: { timeout_seconds: number; log?: (l: string) => void }): Promise<EngineOutcome<TranscriptFile>>;
  synthesize(job: TtsJob, o: { timeout_seconds: number; log?: (l: string) => void }): Promise<EngineOutcome<TtsRaw>>;
  probe(): Promise<{ python: string | null; packages: Record<string, string | null>; cuda: boolean; gpu?: string; vram_free_mb?: number; models_cached: Record<string, boolean> }>;
}
```

`TtsRaw` = mỗi dòng `{ line_id, wav_path, duration_seconds, chunks[], words[] | null, alignment: "word" | "chunk" }`. Chia câu, cache, chuẩn hoá âm lượng, dựng `narration-timing.json` là việc của core, không của engine.

### 1.3 `project.yaml` thêm (mọi khối optional có default để project cũ parse)

```yaml
adapters: { media: fake }                        # python | fake (mặc định fake)
media:
  python: D:/harness-venv/Scripts/python.exe     # bắt buộc khi adapters.media: python
  device: cuda:0                                 # cuda:N | cpu
  transcribe: { engine: whisperx, model: large-v3, compute_type: float16, batch_size: 8 }
  tts: { engine: omnivoice, model: k2-fsa/OmniVoice, dtype: float16, num_step: 32, max_chars: 280, pause_seconds: 0.25, loudness_lufs: -16 }
  scene: { threshold: 0.30, min_shot_seconds: 1.0, max_shot_seconds: 20, proxy_height: 540 }
  watch: { max_sheets: 24 }
library.auto_accept:
  source_collections: ["shoot-*"]                # glob theo tên collection; thay cho source_collection (vẫn đọc được, coi như một mẫu)
  max_sources: 40
```

`media.transcribe.python` và `media.tts.python` là khoá optional ghi đè `media.python` cho từng engine (phương án lùi hai venv, xem §10). `media-transcribe` và `media-tts` khai `requires_resources: [gpu]`; `resources: { gpu: 1 }` đảm bảo hai mô hình không cùng nằm trong VRAM.

### 1.4 `channel.yaml` thêm

```yaml
voice: { voice_id: voice_01H… }                  # optional; bắt buộc khi kênh tạo request voice: tts
```

### 1.5 Kho thêm

```
<kho>/voices/<voice_id>/voice.json               # harness.voice/v1
<kho>/voices/<voice_id>/ref.wav
```

`LibraryFs.assertWritable`: vai **channel** được ghi `voices/**`; vai studio chỉ đọc. `library sync` mirror `voices/` vào bảng mới `voice_profile` (migration `0006_media.sql`: `voice_profile(id, data, status, updated_at)`). Không bảng nào khác: transcript, timing, timeline là artifact của run.

---

## 2. Hiểu nguồn

### 2.1 Buổi quay là collection

- `harness source ingest <path>` nhận thêm **thư mục**: nạp mọi file video trong đó (không đệ quy trừ khi `--recursive`), cùng `--collection`, `--rights`, `--language`. In danh sách `source_id`.
- `pickSources(store, { request, patterns, maxSources, busyCollections })` thay `pickSource`: (1) `source_hint.source_ids` → đúng các source đó (bỏ `restricted`); (2) `source_hint.collection` → mọi source không `restricted` của collection; (3) không hint → collection mới nhất (theo `ingested_at` lớn nhất của các source trong nó) khớp `source_collections`, chưa có run `library-production` nào SUCCEEDED dùng source của nó, và không bận. Trả tối đa `max_sources` source, sắp theo tên file gốc rồi `ingested_at`.
- "Bận" tính theo collection: một collection có run chưa terminal thì không được chọn cho request khác. Skip reason `no-source` giữ nguyên tên.
- `ContentItem.source_ids` đã là mảng; không đổi schema.

### 2.2 `media-index` (thay wrapper `index-source`; `requires_resources: [cpu]`)

Với từng source của content:
- thời lượng và `has_audio` từ ffprobe;
- dò cảnh: `ffmpeg -vf "select='gt(scene,T)',showinfo"` đọc `pts_time`; biên = `[0, …cuts, duration]`; gộp shot < `min_shot_seconds` vào shot trước; chia đều shot > `max_shot_seconds`;
- `shot_id` = `s<NNN>-<MMM>` (chỉ số source 3 chữ số theo thứ tự trong content, chỉ số shot 3 chữ số), ổn định khi chạy lại cùng đầu vào;
- proxy `proxy/<source_id>.mp4` cao `proxy_height`.

Output: `shots.json` (type `shots`, `harness.shots/v2`) và thư mục `proxy` (type `proxy_set`).

```json
{ "schema_version": "harness.shots/v2",
  "sources": [ { "source_id": "src_…", "index": 0, "file_name": "C0012.MP4", "duration_seconds": 312.4, "has_audio": true,
                 "shots": [ { "shot_id": "s000-007", "in": 41.2, "out": 47.9 } ] } ] }
```

ffmpeg thiếu → `contract`. Một source hỏng không đọc được → ghi `error` cho source đó, `shots: []`, stage vẫn SUCCEEDED nếu còn ít nhất một source có shot; không còn source nào → `contract`.

### 2.3 `media-transcribe` (stage mới; `requires_resources: [gpu]`; `depends_on: [media-index]`)

- bỏ qua source `has_audio: false`; tách audio 16 kHz mono bằng ffmpeg vào workspace;
- một lần gọi `engine.transcribe` cho cả lô; `language` = `source.language` nếu có, không thì `null` (engine tự nhận diện và trả lại mã);
- timeout = `max(600, tổng_thời_lượng_audio × 1.5)` giây;
- output `transcript.json` (type `transcript`, `harness.transcript/v1`):

```json
{ "schema_version": "harness.transcript/v1", "engine": "whisperx:large-v3",
  "sources": [ { "source_id": "src_…", "language": "vi", "alignment": "word",
                 "segments": [ { "start": 41.3, "end": 45.0, "text": "…",
                                 "words": [ { "start": 41.3, "end": 41.6, "word": "Hôm", "score": 0.93 } ] } ] } ] }
```

Source im lặng → `segments: []`. Ngôn ngữ không có mô hình căn chỉnh → `alignment: "segment"`, `words: []`, không lỗi.

### 2.4 `watch-source` trên nhiều nguồn

`harness media watch --mode source` chạy trên mọi source (nhãn thư mục = `source.index` 3 chữ số). Khi có input `transcript`, `watch.json` lấy transcript từ đó và **không** gọi hook `transcribe` của `scripts.yaml`; không có input thì hành vi SP4 giữ nguyên. Tổng contact sheet ≤ `media.watch.max_sheets`, chia theo tỉ lệ thời lượng, mỗi source ít nhất một tấm; khung tại mốc `shots[].in` vẫn được ưu tiên.

### 2.5 `survey.json` v2

`surveyIndexSchema` thêm nhánh `harness.survey-index/v2`: mỗi shot có `source_id`, `shot_id`, `in`, `out`, `score`, `tags`, `usable`, `note`, và `speech: "none" | "talking" | "ambient"` (agent suy từ transcript). Checker `survey-valid` (mới, trong `libraryCheckers`): mọi `shot_id` tồn tại trong `shots.json`, `in/out` khớp ±0,05 s. v1 vẫn parse (workflow 1.1.0).

---

## 3. Giọng đọc

### 3.1 Hồ sơ giọng (`harness.voice/v1`)

```json
{ "schema_version": "harness.voice/v1", "voice_id": "voice_…", "display_name": "Kênh A — nữ trung niên",
  "language": "en", "origin": "synthetic", "origin_note": "sinh bằng voice design, không phải người thật",
  "ref_audio": { "path": "ref.wav", "checksum": "sha256:…", "duration_seconds": 12.4 },
  "ref_text": "lời của clip mẫu, đúng từng chữ",
  "params": { "speed": 1.0, "num_step": 32 },
  "revision": 1, "status": "active", "created_at": "…", "updated_at": "…" }
```

- `origin: synthetic | own | licensed` **bắt buộc**. Harness không kiểm được nguồn gốc giọng; trường này là dấu vết, và tài liệu nhắc quy tắc của hệ cũ: không nhân giọng người thật khi không có quyền.
- `library voices add --id? --name --ref <wav> --ref-text <file|chuỗi> --language <code> --origin <…> [--origin-note]`: kiểm clip 3–30 s, mono hoặc stereo, chuyển về wav 24 kHz mono, tính checksum, ghi kho (vai channel). `voices list [--json]`, `voices retire <id>`. Sửa clip mẫu = `add --id <id>` lại → `revision + 1`.
- id prefix mới `voice_`.

### 3.2 Request và brief

- `ContentRequestSchema` và `libraryBriefSchema` thêm `voice_id?: idSchema("voice_profile")`.
- `createRequest` với `voice: "tts"`: `voice_id` = tham số → `channel.yaml.voice.voice_id`; thiếu hoặc hồ sơ không `active` → `CONFIG_INVALID` ngay lúc tạo (CLI `library request create --voice-id`, và stage `create-requests` của 3B lấy từ config kênh).
- `intake` chụp vào brief: `voice_id`, `voice_revision`, `voice_checksum`. Studio chưa mirror được hồ sơ → `contract` tại `intake`.

### 3.3 Lời đọc có cấu trúc (`harness.narration/v1`)

`plan-edit` viết `narration.json` thay `narration.txt`:

```json
{ "schema_version": "harness.narration/v1", "language": "en",
  "lines": [ { "line_id": "L001", "edl_order": 0, "text": "…" } ] }
```

`voice` khác `tts` → `lines: []`. Checker `edl-valid` mở rộng: mọi `edl_order` tồn tại trong EDL; `line_id` duy nhất; `text` không rỗng, ≤ 1200 ký tự.

### 3.4 `media-tts` (`requires_resources: [gpu]`; `depends_on: [plan-edit]`)

- `voice` ∈ {`none`, `original`} hoặc `lines: []`: ghi `narration-timing.json` rỗng và thư mục `voice/` rỗng, không gọi engine.
- Chia câu (`sentences.ts`, thuần): tách theo `. ! ? … ; :` và xuống dòng, giữ dấu; câu dài hơn `max_chars` tách tiếp ở dấu phẩy rồi ở khoảng trắng; không tách giữa số thập phân (`3.5`, `1,200`) hay viết tắt trong danh sách nhỏ theo ngôn ngữ (`en`: Mr., Dr., U.S.…; `vi`: TP., Th.S.…); ngôn ngữ lạ dùng bộ quy tắc chung.
- **Cache theo nội dung**: `data_root/cache/tts/<sha256(text ‖ voice_checksum ‖ params ‖ model ‖ language)>.{wav,json}`. Dòng trúng cache không vào job. Ghi cache nguyên tử sau khi dòng qua kiểm chất lượng.
- Một lần gọi `engine.synthesize` cho các dòng còn lại (nạp mô hình một lần). Engine đọc từng chunk với `ref_audio` + `ref_text`, nối với `pause_seconds`, đọc lại chunk hỏng tối đa 2 lần, rồi (nếu `align`) căn chỉnh từ bằng WhisperX align trên wav với lời đã biết.
- Core chuẩn hoá âm lượng về `loudness_lufs` bằng `ffmpeg loudnorm` (chế độ tuyến tính, không đổi độ dài); đo lại thời lượng và kiểm lệch ≤ 10 ms so với engine, lệch hơn → `transient`.
- Timeout = `max(900, tổng_ký_tự × 0.6)` giây.
- Output: thư mục `voice/` (type `voice_set`, `<line_id>.wav`) và `narration-timing.json` (type `narration_timing`, `harness.narration-timing/v1`): `lines[] { line_id, edl_order, text, wav, duration_seconds, chunks[{text,start,end}], words[{word,start,end}] | [], alignment, cached }`, `total_seconds`, `voice_id`, `voice_revision`.

Checker `tts-valid`: mỗi dòng của `narration.json` có wav tồn tại; `duration_seconds > 0`; tốc độ đọc 5–30 ký tự/giây; đỉnh < 0 dBFS.

---

## 4. Khớp hình theo lời

### 4.1 `media-fit-edl` (thuần TypeScript; `requires_resources: [cpu]`; `depends_on: [plan-edit, media-tts, survey-source, media-index, media-transcribe]`)

Input: `edl` (của agent), `narration_timing`, `shots`, `survey`, `transcript`, `brief`. Output: `edl.json` (type `edl`, đã khớp), `fit-report.json` (type `fit_report`), `timeline.json` (type `timeline`). `cut` đổi `depends_on` thành `[media-fit-edl]` nên chỉ nhận EDL đã khớp; wrapper `cut` không đổi.

Hằng số: đệm đầu 0,3 s, đệm cuối 0,4 s, cửa sổ bắt biên từ ±0,4 s, khoảng lặng tối thiểu 0,15 s, mép 0,08 s.

**`voice: tts`** — với mỗi entry có dòng lời (`edl_order`): `need = Σ duration + 0,3 + 0,4`.
1. `dur ≥ need` → cắt `out = in + need` (`trimmed`), trừ khi chênh < 0,5 s (`kept`).
2. `dur < need` → kéo `out` tới hết shot chứa nó; chưa đủ thì kéo `in` về đầu shot (`extended`).
3. vẫn thiếu → thêm entry mới ngay sau: shot kề sau cùng source nếu `usable` và chưa dùng (`appended`), lặp tới khi đủ hoặc hết.
4. vẫn thiếu → shot `usable` chưa dùng điểm cao nhất từ bất kỳ source nào (`appended`).
5. vẫn thiếu → dùng lại shot đã dùng có điểm cao nhất (`reused`), ghi `shortfalls[] { line_ids, missing_seconds }`.
Entry không có lời giữ nguyên. `order` đánh lại liên tiếp; entry thêm vào mang `note: "fit: …"`.

**`voice: original`** — không khớp độ dài. Mỗi điểm `in`/`out` rơi vào giữa một từ (theo `words[]` của source đó) được dời tới khoảng lặng ≥ 0,15 s gần nhất trong ±0,4 s, ưu tiên mở rộng hơn thu hẹp, cộng mép 0,08 s (`snapped`). Không có `words` (alignment `segment`) → bắt về biên segment. Không tìm được khoảng lặng → giữ nguyên, ghi `warnings[]`.

**`voice: none`** — giữ nguyên.

Mọi chế độ: kẹp `in/out` vào `[0, duration]` của source; entry sau kẹp có `out − in < 0,2 s` bị bỏ và ghi `warnings[]`.

Stage **không fail vì thiếu hình**. `fit-report.json` (`harness.fit-report/v1`): `entries[] { order, source_id, before{in,out}, after{in,out}, action }`, `shortfalls[]`, `reused_seconds`, `warnings[]`, `total_seconds`, `target_duration_seconds?`, `within_target: boolean`.

### 4.2 `timeline.json` (`harness.timeline/v1`) — hợp đồng cho 5B

```json
{ "schema_version": "harness.timeline/v1", "voice": "tts", "language": "en", "total_seconds": 431.6,
  "video": [ { "order": 0, "source_id": "src_…", "in": 41.2, "out": 50.3, "start": 0.0, "end": 9.1 } ],
  "narration": [ { "line_id": "L001", "wav": "voice/L001.wav", "start": 0.3, "end": 8.7,
                   "words": [ { "word": "Every", "start": 0.3, "end": 0.55 } ] } ],
  "speech": [ { "source_id": "src_…", "start": 12.0, "end": 15.4, "text": "…", "words": [ … ] } ] }
```

`narration` đặt mỗi dòng tại `start của entry đầu tiên mang edl_order đó + 0,3`, các dòng cùng entry nối tiếp. `speech` chỉ có khi `voice: original`: các segment transcript nằm trong từng đoạn cắt, mốc đã dời về thời gian chương trình.

### 4.3 Workflow `library-production@1.2.0` (15 stage, không gate)

`intake → media-index → media-transcribe → watch-source → survey-source → plan-edit → media-tts → media-fit-edl → cut → assemble → watch-episode → thumbnail-candidates → library-export → library-review → library-apply-review`

- `survey-source`: inputs thêm `transcript`; required_checks thêm `survey-valid`.
- `plan-edit`: outputs `edl`, `edit_plan`, `narration` (json); inputs thêm `transcript`.
- `assemble`: `depends_on: [cut, media-tts, media-fit-edl]`; inputs `clip_set`, `voice_set`, `timeline`.
- `library-review`: inputs thêm `fit_report`.
- Profile `studio` revision 3 → `library-production@1.2.0`. `1.0.0` và `1.1.0` giữ nguyên, vẫn chọn được bằng `--workflow`.

### 4.4 `assemble` trong 5A

Vẫn là wrapper của ops project. Bản mẫu `fixtures/ops-project-footage/executors/wrappers/assemble.mjs` nâng tối thiểu: nối clip theo thứ tự; `tts` → tắt tiếng gốc, đặt từng wav tại `narration[].start` (`adelay` + `amix`); `original` → giữ tiếng gốc; `none` → giữ tiếng gốc ở −12 dB. Không chữ, nhạc, phụ đề, chuyển cảnh (5B).

### 4.5 Skill

- `source-survey`: đọc `shots.json` v2 + `transcript.json`; chấm theo `shot_id`; điền `speech`; ngân sách khung ≤ `max_sheets` tấm + 20 khung đơn; ưu tiên transcript trước hình.
- `edit-plan`: chọn shot xuyên source; viết `narration.json`; ước lượng 15 ký tự/giây (en) hoặc 14 (vi) để lời vừa hình ngay lần đầu; `original` → cắt theo câu trọn vẹn trong transcript, không viết lời; đọc `request_notes` có ghi chú thiếu hụt của lần trước.
- `library-review`: đọc `fit-report.json`; **từ chối** khi `shortfalls` không rỗng, `reused_seconds > 5`, hoặc `within_target: false`; `note` nêu `line_id` và số giây thiếu để replan sửa đúng chỗ.
- `fixtures/fake-agent-cli.mjs`: sinh survey v2, `narration.json`, và review đọc `fit_report` (env `FAKE_NARRATION_CHARS` để test lời dài hơn hình).

---

## 5. Doctor, sự kiện, dashboard

Doctor (chỉ khi `adapters.media: python`): `media:python` (file tồn tại, `--version`), `media:packages` (`torch`, `omnivoice`, `whisperx` + phiên bản), `media:device` (CUDA, tên GPU, VRAM trống), `media:models` (đã cache hay sẽ tải). Mọi vai có kho: `library:voices` (thư mục tồn tại; vai channel ghi được). Vai channel: `channel:<id>:voice` khi `channel.yaml.voice` có — hồ sơ tồn tại, `active`, checksum `ref.wav` khớp.

Sự kiện: `media.transcribed { run_id, sources, seconds }`, `media.tts_done { run_id, lines, cached, seconds }`, `media.fit_shortfall { run_id, missing_seconds }`. Dashboard: khối studio thêm `media { engine, last_tts_at, cache_hit_ratio }`; alert `media_engine_unavailable` khi doctor `media:*` fail.

---

## 6. Xử lý lỗi

| Tình huống | Phân loại | Hệ quả |
|---|---|---|
| `media.python` thiếu, import lỗi, không CUDA khi `device: cuda:*` | `contract` | Dừng ngay, thông báo nêu thứ thiếu; doctor bắt trước. |
| Hết VRAM, tiến trình bị kill, timeout, tải mô hình lỗi mạng | `transient` | Retry theo workflow (`max_attempts: 2`); cache TTS và proxy dùng lại. |
| Source không audio / transcript rỗng | không lỗi | `segments: []`. `original` mà mọi source rỗng → `library-review` loại. |
| Hồ sơ giọng `retired`, thiếu `ref.wav`, checksum lệch | `contract` | Đã chặn lúc tạo request và tại `intake`. |
| Ngôn ngữ không có mô hình căn chỉnh | cảnh báo | `alignment: "chunk"`/`"segment"`. |
| Thiếu hình cho lời | không fail | `fit-report.json` → review loại → replan. |
| Collection rỗng hoặc toàn `restricted` | bỏ qua | Skip `no-source`. |
| result JSON của Python hỏng/thiếu | `transient` | Kèm 2000 ký tự cuối stderr đã redact. |

Tiến trình Python nhận env lọc: chỉ `PATH`, `SystemRoot`, `TEMP`/`TMP`, `CUDA_*`, `HF_HOME`, `HF_HUB_OFFLINE`, `PYTHONUTF8=1`; không bao giờ `HARNESS_SECRET_*`. Log qua Redactor.

---

## 7. Kiểm thử

- **Unit (không GPU):** schema mới; `scene.ts` trên video ffmpeg tự sinh ba cảnh màu; gộp/chia shot; `sentences.ts` cho `vi`/`en` (số thập phân, viết tắt, câu quá dài); khoá cache TTS; `fit-edl` từng quy tắc 1–5 + `original` (bắt biên, không khoảng lặng, alignment segment) + `none`; `timeline.ts`; `pickSources` (hint ids, hint collection, glob, bận theo collection, `max_sources`); `voices add|retire`; `createRequest` thiếu `voice_id`.
- **Engine giả:** `FakeMediaEngine` — transcript xác định từ tên file (mỗi 2 s một segment 3 từ), wav sine dài `ký_tự / 15` giây, `words[]` chia đều. Test tích hợp `tests/integration/studio-media.test.ts` chạy `library-production@1.2.0` với 3 clip ffmpeg tự sinh, `voice: tts`, tới item `approved`.
- **Python:** `python -m py_compile` cả ba file; `--dry-run` (không nạp mô hình) đọc job, ghi result đúng schema — chạy khi `python` có trên PATH, `skipIf` khi không.
- **Acceptance 41–46:** (41) nhiều clip một tập, EDL dùng ≥ 2 `source_id`; (42) lời dài hơn hình → review loại → replan → chỉ dòng sửa không `cached`; (43) `original` không cắt giữa chữ; (44) request `tts` thiếu `voice_id` bị từ chối lúc tạo; (45) không `HARNESS_SECRET_`/giá trị secret trong env, log, result của tiến trình media; (46) `library-production@1.1.0` vẫn chạy nguyên trạng với fixture cũ.
- Mọi test SP1–3B giữ xanh, không sửa.

---

## 8. Definition of Done sub-project 5A

1. Một collection nhiều clip chạy hết `library-production@1.2.0` với `adapters.media: fake` tới item `approved`, không lệnh người ngoài `worker`.
2. **Chạy thật trên máy build (RTX 3060 12 GB) — điều kiện merge, không để trống:** dựng venv theo `engines/python/README.md`; `harness doctor` năm hàng `media:*`/`library:voices` ok; một tập `en` và một tập `vi`, `voice: tts`, với một hồ sơ giọng `origin: synthetic|own`; một tập `voice: original`. Kết quả: `transcript.json` có `words[]`, `narration-timing.json` có wav nghe được và `alignment: "word"`, `full-episode.mp4` có lời đúng vị trí. Ghi thời gian từng stage và VRAM đỉnh vào runbook.
3. Kết luận về tiếng Việt của OmniVoice ghi trong runbook: đạt / không đạt (kèm lý do). Không đạt thì `en` là ngôn ngữ được hỗ trợ, `vi` ghi vào deferred.
4. Runbook `docs/runbooks/studio-media.md`; ADR 102+; `deferred-items.md`; `project-template/` có khối `media:`, `auto_accept.source_collections`, `voice:`; `go-live.md` bỏ `index-source`, `tts`, `transcribe` khỏi danh sách wrapper phải viết.
5. `pnpm build && pnpm typecheck && pnpm test` xanh.

---

## 9. Ngoài phạm vi

Chữ trên hình, nhạc + ducking, phụ đề, chuyển cảnh, tỉ lệ khung (5B). Thumbnail thật. Tạo giọng bằng mô tả chữ (voice design) và lệnh sinh clip mẫu. Dịch transcript giữa hai ngôn ngữ (source một tiếng, kênh tiếng khác). `style-study` dùng engine transcribe thật. Dịch vụ Python thường trực. Engine đám mây. Tách người nói (diarization). Hoạt hình.

---

## 10. Rủi ro và điểm mở

- **Xung đột phiên bản trong một venv** (torch 2.8 của OmniVoice với phụ thuộc của WhisperX trên Windows). Phương án lùi: hai venv, `media.python` thành `media.transcribe.python` và `media.tts.python`; schema cho phép ghi đè theo engine ngay từ đầu để không phải đổi lần hai.
- **OmniVoice tiếng Việt chưa kiểm.** DoD #3 bắt kiểm; không chặn merge nếu `en` đạt.
- **Thời gian chạy:** 40 clip dài làm `transcribe` tốn hàng chục phút; timeout tính theo tổng thời lượng; `lease_seconds` của profile phải ≥ timeout stage dài nhất (kiểm trong plan).
- **Dò cảnh bằng ngưỡng cố định** dễ sai với cảnh quay tay rung hoặc ánh sáng đổi; `threshold` cấu hình được, `max_shot_seconds` chặn shot quá dài; dò cảnh tốt hơn là việc sau.
- **Nhân giọng:** harness không xác minh được `origin`; trách nhiệm thuộc người khai hồ sơ; runbook ghi rõ.
- **Cache TTS lớn dần:** `artifacts sweep` chưa biết tới `cache/tts`; thêm dọn theo tuổi là việc sau, ghi deferred.
- **`reused`/`shortfalls` lặp vô hạn:** đã có `max_replans` của SP4 chặn; hết lượt → `request_stuck` như hiện tại.
