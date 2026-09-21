# Sub-project 5A: Studio Media — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Studio dựng được tập từ một buổi quay nhiều clip với dữ liệu media thật: dò cảnh + transcript có mốc từng từ (WhisperX), giọng đọc nhân từ clip mẫu của kênh (OmniVoice), và EDL tự khớp theo lời — không lệnh người ngoài `worker`.

**Architecture:** Cổng `MediaEngine` (`PythonMediaEngine` spawn `engines/python/{transcribe,tts}.py` qua file JSON; `FakeMediaEngine` cho CI); core thuần TypeScript trong `packages/core/src/media/` (`scene`, `index`, `transcribe`, `sentences`, `tts`, `fit-edl`, `timeline`); bốn stage built-in `media-index|media-transcribe|media-tts|media-fit-edl` đăng ký như `watch-*`; hồ sơ giọng trong kho `voices/<voice_id>/` do vai channel ghi; workflow `library-production@1.2.0` (15 stage) và profile `studio` revision 3; auto-accept chọn cả collection.

**Tech Stack:** Node 22 (`node:sqlite`), pnpm workspaces, TypeScript strict ESM NodeNext (`.js` import, `exactOptionalPropertyTypes`), Zod 3 + `pnpm gen:schemas`, Vitest (`vitest.shared.ts`; test spawn CLI nạp `dist/` → `pnpm build` trước), ffmpeg/ffprobe; Python 3.11 + torch 2.8 + `omnivoice` + `whisperx` chỉ cho chạy thật (Task 11), không cho CI.

**Spec:** `docs/superpowers/specs/2026-09-21-sub-project-5a-studio-media-design.md` ("spec"). Đọc §1–§2 trước Task 1–3, §3 trước Task 4–5, §4 trước Task 6–8.

## Global Constraints

- Core thuần TypeScript; Python chỉ là tiến trình con, vào/ra bằng file JSON trong workspace; `core` không import adapter; composition root (`packages/cli/src/composition.ts`) là nơi duy nhất chọn engine theo `adapters.media: python|fake` (mặc định `fake`).
- Không gate người; `media-fit-edl` không bao giờ fail vì thiếu hình (ghi `fit-report.json`, để `library-review` loại → replan của SP4).
- `library-production@1.0.0`, `@1.1.0`, `style-study@*`, `channel-*` byte-identical; mọi test SP1–3B xanh nguyên trạng (chỉ được sửa test khẳng định đếm chính xác — bảng, prefix id — và ghi rõ trong report).
- Tiến trình Python nhận env lọc: chỉ `PATH`, `SystemRoot`, `TEMP`, `TMP`, `CUDA_*`, `HF_HOME`, `HF_HUB_OFFLINE`, `PYTHONUTF8=1`; không bao giờ `HARNESS_SECRET_*` (chặn prefix không phân biệt hoa thường); log qua Redactor; stderr giữ 2000 ký tự cuối.
- Mọi khối config mới `.strict().default({...})` để `project.yaml`/`channel.yaml` cũ parse nguyên; schema mới `.strict()`.
- Hằng số `fit-edl`: đệm đầu 0,3 s; đệm cuối 0,4 s; cửa sổ bắt biên ±0,4 s; khoảng lặng tối thiểu 0,15 s; mép 0,08 s; bỏ entry < 0,2 s; ngưỡng `kept` 0,5 s.
- `pnpm gen:schemas` sau mọi đổi schema; `pnpm build && pnpm typecheck && pnpm test` xanh sau **mỗi** task (họ flake đã biết: `library-pipeline` rejected-review, `06-stale-scope`, `16-secret-e2e`, `07-thumbnail`, footage gpu-serialization, worker lease, `26-reconcile-not-found` — chạy lại riêng file và báo cả hai kết quả).
- Không media/data/mô hình/venv commit vào repo; `engines/python/` chỉ chứa mã và `requirements.txt`.
- Harness không dành cho nội dung hoạt hình: không thêm, không đề xuất gì liên quan.
- Commit `feat(...)`/`fix(...)`/`test:`/`docs:`; dòng cuối đúng `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` — không thay tên model; kiểm bằng `git log -1 --format='%(trailers:key=Co-Authored-By,valueonly)'`.
- Bug hiển nhiên trong plan: sửa và ghi report; hỏi chỉ khi là trade-off thiết kế.

## Bản đồ file

| File | Trách nhiệm | Task |
|---|---|---|
| `packages/contracts/src/media-engine.ts`, `config.ts`, `library.ts`, `ids.ts`, `interfaces.ts`, `index.ts`, `scripts/gen-json-schema.ts`; `migrations/0006_media.sql`; `packages/core/src/state/sqlite-store.ts` | schema media + cổng `MediaEngine` + config + bảng `voice_profile` | 1 |
| `engines/python/{_io,transcribe,tts}.py`, `requirements.txt`, `README.md`; `packages/adapters/media-python/`; `packages/adapters/fake/src/fake-media-engine.ts`; `packages/cli/src/composition.ts` | engine thật + giả + chọn engine | 2 |
| `packages/core/src/media/{scene,index,transcribe}.ts`, `watch.ts`; `packages/core/src/verification/library-checkers.ts` | dò cảnh, index nhiều nguồn, transcript, watch nhiều nguồn, `survey-valid` | 3 |
| `packages/core/src/library/{files,sync,requests,voices}.ts`; `packages/cli/src/commands/{library,library-stage,publish-stage}.ts`; `packages/core/src/doctor/doctor.ts` | hồ sơ giọng, `voice_id` trên request/brief, doctor giọng | 4 |
| `packages/core/src/media/{sentences,tts}.ts`; `packages/core/src/verification/media-checkers.ts` | chia câu, cache, tổng hợp lời, `tts-valid`, `edl-valid` mở rộng | 5 |
| `packages/core/src/media/{fit-edl,timeline}.ts` | khớp hình theo lời, timeline | 6 |
| `packages/core/src/library/auto-accept.ts`; `packages/core/src/source-catalog/catalog.ts`; `packages/cli/src/commands/{source,worker}.ts` | chọn collection, ingest thư mục | 7 |
| `packages/cli/src/commands/media.ts`; `workflows/library-production@1.2.0/`; `production-profiles/studio/profile.yaml`; `skills/{source-survey,edit-plan,library-review}/SKILL.md`; `fixtures/fake-agent-cli.mjs`; `fixtures/ops-project-footage/executors/wrappers/assemble.mjs`; `fixtures/ops-project-studio/` | bốn stage built-in, workflow, skill, agent giả, assemble mẫu | 8 |
| `packages/core/src/doctor/doctor.ts`, `packages/core/src/dashboard/snapshot.ts`, `packages/cli/src/composition.ts` | doctor `media:*`, event, dashboard | 9 |
| `tests/integration/{library-helpers,studio-media.test}.ts`, `tests/acceptance/41..46` | tích hợp + acceptance | 10 |
| `docs/runbooks/studio-media.md`, ADR, AGENTS, README, deferred, template, `go-live.md` | chạy thật trên GPU + tài liệu | 11 |

---

### Task 1: Contracts, config, migration `0006_media.sql`, store

**Files:**
- Create: `packages/contracts/src/media-engine.ts`, `migrations/0006_media.sql`
- Modify: `packages/contracts/src/config.ts`, `library.ts`, `ids.ts` (`voice_profile: "voice"`), `interfaces.ts` (`StateStore` thêm 3 method), `index.ts`, `scripts/gen-json-schema.ts`; `packages/core/src/state/sqlite-store.ts`
- Test: `packages/contracts/test/media-engine.test.ts`, `packages/core/test/state/voice-store.test.ts`

**Interfaces (Produces):**

```ts
// media-engine.ts
const word = z.object({ word: z.string().min(1), start: z.number().min(0), end: z.number().min(0), score: z.number().min(0).max(1).optional() }).strict();
export const ShotsIndexSchema = z.object({ schema_version: schemaVersion("shots", 2),   // "harness.shots/v2" — nếu schemaVersion() không nhận version, thêm tham số thứ hai mặc định 1
  sources: z.array(z.object({ source_id: idSchema("source_item"), index: z.number().int().min(0), file_name: z.string(), duration_seconds: z.number().min(0), has_audio: z.boolean(), error: z.string().optional(),
    shots: z.array(z.object({ shot_id: z.string().regex(/^s\d{3}-\d{3}$/), in: z.number().min(0), out: z.number().positive() }).strict()) }).strict()).min(1) }).strict();
export const TranscriptSchema = z.object({ schema_version: schemaVersion("transcript"), engine: z.string().min(1),
  sources: z.array(z.object({ source_id: idSchema("source_item"), language: z.string().nullable(), alignment: z.enum(["word", "segment"]),
    segments: z.array(z.object({ start: z.number().min(0), end: z.number().min(0), text: z.string(), words: z.array(word).default([]) }).strict()) }).strict()) }).strict();
export const NarrationSchema = z.object({ schema_version: schemaVersion("narration"), language: z.string().min(1),
  lines: z.array(z.object({ line_id: z.string().regex(/^L\d{3}$/), edl_order: z.number().int().min(0), text: z.string().min(1).max(1200) }).strict()) }).strict();
export const NarrationTimingSchema = z.object({ schema_version: schemaVersion("narration-timing"), voice_id: idSchema("voice_profile").nullable(), voice_revision: revisionSchema.nullable(), total_seconds: z.number().min(0),
  lines: z.array(z.object({ line_id: z.string(), edl_order: z.number().int().min(0), text: z.string(), wav: z.string(), duration_seconds: z.number().positive(),
    chunks: z.array(z.object({ text: z.string(), start: z.number().min(0), end: z.number().min(0) }).strict()), words: z.array(word).default([]), alignment: z.enum(["word", "chunk"]), cached: z.boolean() }).strict()) }).strict();
export const FIT_ACTIONS = ["kept", "trimmed", "extended", "appended", "reused", "snapped", "dropped"] as const;
export const FitReportSchema = z.object({ schema_version: schemaVersion("fit-report"), voice: z.enum(["none", "tts", "original"]),
  entries: z.array(z.object({ order: z.number().int().min(0), source_id: idSchema("source_item"), before: z.object({ in: z.number(), out: z.number() }).strict().nullable(), after: z.object({ in: z.number(), out: z.number() }).strict(), action: z.enum(FIT_ACTIONS) }).strict()),
  shortfalls: z.array(z.object({ line_ids: z.array(z.string()), missing_seconds: z.number().positive() }).strict()), reused_seconds: z.number().min(0), warnings: z.array(z.string()),
  total_seconds: z.number().min(0), target_duration_seconds: durationTuple.optional(), within_target: z.boolean() }).strict();
export const TimelineSchema = z.object({ schema_version: schemaVersion("timeline"), voice: z.enum(["none", "tts", "original"]), language: z.string(), total_seconds: z.number().min(0),
  video: z.array(z.object({ order: z.number().int().min(0), source_id: idSchema("source_item"), in: z.number(), out: z.number(), start: z.number(), end: z.number() }).strict()),
  narration: z.array(z.object({ line_id: z.string(), wav: z.string(), start: z.number(), end: z.number(), words: z.array(word).default([]) }).strict()),
  speech: z.array(z.object({ source_id: idSchema("source_item"), start: z.number(), end: z.number(), text: z.string(), words: z.array(word).default([]) }).strict()) }).strict();
export const voiceParamsSchema = z.object({ speed: z.number().min(0.5).max(2).default(1), num_step: z.number().int().min(4).max(128).default(32) }).strict();
export const VoiceProfileSchema = z.object({ schema_version: schemaVersion("voice"), voice_id: idSchema("voice_profile"), display_name: z.string().min(1), language: z.string().min(1),
  origin: z.enum(["synthetic", "own", "licensed"]), origin_note: z.string().default(""),
  ref_audio: z.object({ path: z.literal("ref.wav"), checksum: checksumSchema, duration_seconds: z.number().min(3).max(30) }).strict(), ref_text: z.string().min(1),
  params: voiceParamsSchema.default({}), revision: revisionSchema, status: z.enum(["active", "retired"]), created_at: timestampSchema, updated_at: timestampSchema }).strict();
// cổng (spec §1.2) — TranscribeJob, TtsJob, TtsRaw, EngineOutcome<T>, MediaEngine, MediaEngineProbe: chép đúng chữ ký trong spec §1.2;
//   TtsRaw = { lines: { line_id; wav_path; duration_seconds; chunks: {text,start,end}[]; words: Word[] | null; alignment: "word" | "chunk" }[] }
// library.ts: surveyIndexSchemaV2 (schema_version "harness.survey-index/v2"; shots[]: source_id, shot_id, in, out, score 0–5, tags, usable, note, speech: "none"|"talking"|"ambient"); AnySurveyIndexSchema = z.union([surveyIndexSchema, surveyIndexSchemaV2])
//   ContentRequestSchema + libraryBriefSchema thêm voice_id: idSchema("voice_profile").optional(); libraryBriefSchema thêm voice_revision: revisionSchema.optional(), voice_checksum: checksumSchema.optional()
// config.ts ProjectConfigSchema: adapters.media: z.enum(["python","fake"]).default("fake");
//   media: { python?: string; device: /^(cuda:\d+|cpu)$/ default "cuda:0";
//            transcribe: { engine: "whisperx"; model default "large-v3"; compute_type default "float16"; batch_size int≥1 default 8; python?: string };
//            tts: { engine: "omnivoice"; model default "k2-fsa/OmniVoice"; dtype default "float16"; num_step default 32; max_chars int 80–600 default 280; pause_seconds default 0.25; loudness_lufs default -16; python?: string };
//            scene: { threshold 0–1 default 0.30; min_shot_seconds default 1.0; max_shot_seconds default 20; proxy_height int default 540 };
//            watch: { max_sheets int≥1 default 24 } } .default({})
//   library.auto_accept: source_collections: z.array(z.string().regex(/^[a-z][a-z0-9*-]*$/)).optional(), max_sources: int≥1 default 40  (source_collection giữ nguyên; helper `autoAcceptPatterns(cfg) = cfg.source_collections ?? [cfg.source_collection]`)
// config.ts ChannelConfigSchema: voice: z.object({ voice_id: idSchema("voice_profile") }).strict().optional()
// StateStore: upsertVoiceProfile(v: VoiceProfile): void; getVoiceProfile(id: string): VoiceProfile | undefined; listVoiceProfiles(filter?: { status?: "active" | "retired" }): VoiceProfile[]
```

```sql
-- migrations/0006_media.sql
-- Mirror of <kho>/voices/<voice_id>/voice.json (channel role writes the kho; both roles mirror it on sync). Not control-plane state.
CREATE TABLE voice_profile (id TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL);
```

- [ ] **Step 1: Test thất bại** — contracts: mẫu hợp lệ của 8 schema; `shot_id "s1-2"` bị từ chối; `VoiceProfileSchema` thiếu `origin` bị từ chối, `ref_audio.duration_seconds 2` bị từ chối; `ProjectConfigSchema` cũ → `adapters.media "fake"`, `media.device "cuda:0"`, `media.tts.max_chars 280`, `media.watch.max_sheets 24`, `auto_accept.max_sources 40`; `autoAcceptPatterns` (chỉ `source_collection: main` → `["main"]`; có `source_collections` → dùng nó); `ChannelConfigSchema` cũ parse, có `voice` parse; request/brief với `voice_id`; survey v1 và v2 cùng parse qua `AnySurveyIndexSchema`. Store: upsert/get/list theo status; upsert lại cùng id → thay; bảng `voice_profile` tồn tại sau migrate.
- [ ] **Step 2–4:** triển khai; thêm 8 schema vào `gen-json-schema.ts` (`shots`, `transcript`, `narration`, `narration-timing`, `fit-report`, `timeline`, `voice`, `survey-index-v2`); `pnpm gen:schemas`; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(contracts): media engine port, shots/transcript/narration/timing/fit-report/timeline/voice schemas, media config, voice_profile table`.

---

### Task 2: Engine Python, `PythonMediaEngine`, `FakeMediaEngine`, composition

**Files:**
- Create: `engines/python/_io.py`, `transcribe.py`, `tts.py`, `requirements.txt`, `README.md`; `packages/adapters/media-python/{package.json,tsconfig.json,src/index.ts,src/python-media-engine.ts,src/child-env.ts}`; `packages/adapters/fake/src/fake-media-engine.ts`
- Modify: `packages/adapters/fake/src/index.ts`, `packages/cli/package.json` (+dep), `packages/cli/src/composition.ts` (`AppContext.media: MediaEngine`, `AppContext.mediaConfig`), `vitest.shared.ts` (alias `@harness/adapter-media-python`), `pnpm-workspace.yaml` nếu glob chưa phủ
- Test: `packages/adapters/media-python/test/{python-media-engine,child-env,python-scripts}.test.ts`, `packages/adapters/fake/test/fake-media-engine.test.ts`

**Giao thức job/result (file JSON, UTF-8):** `python <script> --job <job.json> --result <result.json> [--dry-run]`.
- `transcribe.py` job: `{ device, model, compute_type, batch_size, items: [{ source_id, audio_path, language|null }] }` → result `{ ok: true, engine: "whisperx:<model>", sources: [{ source_id, language, alignment, segments: [{ start, end, text, words }] }] }`.
- `tts.py` job: `{ device, model, dtype, num_step, speed, language, ref_audio, ref_text, align: bool, lines: [{ line_id, chunks: [string], out_path, pause_seconds }] }` → result `{ ok: true, lines: [{ line_id, wav_path, duration_seconds, chunks: [{text,start,end}], words: [...]|null, alignment }] }`.
- Lỗi: result `{ ok: false, kind: "contract" | "transient", reason }` và exit 0; exit ≠ 0 hoặc thiếu/hỏng result → engine TS trả `transient` kèm stderr tail. `ImportError`, thiếu CUDA khi `device` là `cuda:*`, thiếu file `ref_audio` → `contract`; OOM, lỗi tải mô hình → `transient`.
- `--dry-run`: không import torch/whisperx/omnivoice; validate job, ghi result giả (segment rỗng / wav im lặng 0,1 s qua module `wave`), dùng cho test.
- `tts.py` thật: `OmniVoice.from_pretrained(model, device_map=device, dtype=getattr(torch, dtype))`; mỗi chunk `model.generate(text=…, ref_audio=…, ref_text=…, num_step=…, speed=…)[0]` (24 kHz); chunk có độ dài 0 hoặc `nan` → đọc lại tối đa 2 lần; nối chunk bằng khoảng lặng `pause_seconds`; ghi `soundfile.write(out_path, audio, 24000)`; nếu `align`: `whisperx.load_align_model(language_code=language, device=device)` rồi `whisperx.align([{text, start: 0, end: dur}], …)`; không có mô hình căn chỉnh → `words: null`, `alignment: "chunk"`. Giải phóng mô hình TTS (`del model; torch.cuda.empty_cache()`) trước khi nạp mô hình căn chỉnh.
- `transcribe.py` thật: `whisperx.load_model(model, device, compute_type=…)`; mỗi item `model.transcribe(audio, batch_size=…, language=language)`; căn chỉnh theo `result["language"]`; cache mô hình căn chỉnh theo mã ngôn ngữ trong tiến trình.
- `_io.py`: `read_job`, `write_result` (ghi file tạm rồi `os.replace`), `log(level, msg, **data)` in một dòng JSON ra stderr; ép stdout/stderr UTF-8 (`reconfigure`).

**Interfaces (Produces):**

```ts
// python-media-engine.ts
export interface PythonMediaEngineOptions { python: string; transcribePython?: string; ttsPython?: string; enginesDir: string /* <harnessRoot>/engines/python */; device: string; transcribe: MediaConfig["transcribe"]; tts: MediaConfig["tts"]; redact?: (s: string) => string; dryRun?: boolean /* test-only */ }
export class PythonMediaEngine implements MediaEngine { readonly name = "python"; /* transcribe, synthesize, probe */ }
// child-env.ts
export function mediaChildEnv(env: NodeJS.ProcessEnv): Record<string, string>   // allow-list của Global Constraints; PYTHONUTF8=1 luôn set
// fake-media-engine.ts
export class FakeMediaEngine implements MediaEngine { readonly name = "fake"; constructor(o?: { ffmpeg?: string; charsPerSecond?: number /* 15 */ }); calls: { kind: "transcribe" | "synthesize"; n: number }[] }
//  transcribe: mỗi source → segment mỗi 2 s trong [0, thời lượng audio đo bằng ffprobe), text "w1 w2 w3", words chia đều, alignment "word", language = job language ?? "en"
//  synthesize: mỗi dòng → wav sine 24 kHz dài max(0.4, Σchars/charsPerSecond) giây (ffmpeg lavfi), chunks theo tỉ lệ ký tự, words chia đều theo khoảng trắng, alignment "word"
// composition.ts
//  media = project.adapters.media === "python" ? new PythonMediaEngine({ python: requireMediaPython(project), … , enginesDir: join(harnessRoot, "engines", "python"), redact }) : new FakeMediaEngine()
//  requireMediaPython: thiếu media.python khi adapters.media === "python" → HarnessError CONFIG_INVALID
```

Engine TS spawn bằng `spawn` (không `spawnSync`, để worker còn heartbeat), timeout `timeout_seconds × 1000` với `SIGKILL`, gom stderr (giữ 2000 ký tự cuối, redact), chuyển từng dòng JSON stderr cho `log`. `probe()` chạy `python -c` in JSON `{ version, packages: {torch, omnivoice, whisperx}, cuda, gpu, vram_free_mb }` (mỗi import bọc try) và kiểm cache HF (`HF_HOME` hoặc `~/.cache/huggingface/hub`) có thư mục `models--k2-fsa--OmniVoice` và mô hình whisper tương ứng.

- [ ] **Step 1: Test thất bại** — `child-env`: `HARNESS_SECRET_X`, `harness_secret_y`, `OPENAI_API_KEY` bị loại; `PATH`, `CUDA_VISIBLE_DEVICES`, `HF_HOME` giữ; `PYTHONUTF8 === "1"`. `python-media-engine` với **script giả `.mjs`** thay python (option `python: process.execPath`, `enginesDir` trỏ thư mục temp chứa `transcribe.py`/`tts.py` giả là file JS — engine gọi `[python, join(enginesDir, "transcribe.py"), …]` nên Node chạy được file `.py` chứa JS): result ok → `kind: "ok"`; `{ ok:false, kind:"contract" }` → contract; exit 3 không result → transient có stderr tail ≤ 2000; result JSON hỏng → transient; treo 5 s với timeout 1 s → transient "timed out"; script giả in tên env có prefix `HARNESS_SECRET_` → rỗng. `python-scripts` (`skipIf` không có `python` trên PATH): `py_compile` ba file; `--dry-run` của cả hai script ghi result parse được bằng schema TS. `fake-media-engine` (`skipIf(!hasFfmpeg())`): thời lượng wav ≈ chars/15 ±0,1; transcript phủ thời lượng; `calls` ghi đúng.
- [ ] **Step 2–4:** triển khai; `requirements.txt` (`omnivoice`, `whisperx`, `soundfile`, `numpy`) + README (venv, `pip install torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu126`, `pip install -r requirements.txt`, tải trước mô hình, kiểm bằng `--dry-run` rồi chạy thật một câu); `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(adapter): python media engine (WhisperX transcribe, OmniVoice tts) with filtered child env; fake media engine`.

---

### Task 3: Core hiểu nguồn — `scene`, `index`, `transcribe`, watch nhiều nguồn, `survey-valid`

**Files:**
- Create: `packages/core/src/media/scene.ts`, `index.ts`, `transcribe.ts`
- Modify: `packages/core/src/media/watch.ts` (transcript từ input, `max_sheets`), `packages/core/src/verification/library-checkers.ts` (`survey-valid`), `packages/core/src/index.ts`
- Test: `packages/core/test/media/{scene,index,transcribe,watch-multi}.test.ts`, `packages/core/test/verification/survey-valid.test.ts`

**Interfaces (Produces):**

```ts
// scene.ts (thuần)
export function buildShots(cuts: number[], duration: number, o: { min_shot_seconds: number; max_shot_seconds: number }): { in: number; out: number }[]
//  biên = [0, ...cuts trong (0,duration) tăng dần, duration]; shot < min gộp vào shot TRƯỚC (shot đầu gộp vào shot sau); shot > max chia đều thành ceil(len/max) phần; làm tròn 3 chữ số; duration ≤ 0 → []
export function shotId(sourceIndex: number, shotIndex: number): string   // `s${pad3}-${pad3}`
// index.ts
export interface IndexDeps { ffmpeg: string; probe: (path: string) => { duration_seconds: number | null; has_audio: boolean } | null; detect?: typeof detectSceneChanges; log?: WatchLogFn }
export function indexSources(d: IndexDeps, p: { sources: { source_id: string; path: string; file_name: string }[]; scene: MediaConfig["scene"]; proxyDir: string }): ShotsIndex
//  mỗi source: probe null hoặc ném → { error, shots: [] } và tiếp tục; proxy `${proxyDir}/${source_id}.mp4` (scale=-2:proxy_height, libx264 ultrafast, aac); không source nào có shot → HarnessError CONFIG_INVALID "no usable source"
// transcribe.ts
export async function transcribeSources(d: { engine: MediaEngine; ffmpeg: string; log?: WatchLogFn }, p: { shots: ShotsIndex; sources: { source_id: string; path: string; language: string | null }[]; workDir: string; deadlineSeconds: number }): Promise<Transcript>
//  bỏ source has_audio false hoặc có error; tách audio `-vn -ac 1 -ar 16000 -c:a pcm_s16le`; timeout = min(deadlineSeconds, max(600, Σduration × 1.5)); engine contract/transient → ném HarnessError CONFIG_INVALID / IO_ERROR tương ứng;
//  source bị bỏ vẫn có mục { segments: [], alignment: "segment", language }; không source nào có audio → không gọi engine
// watch.ts: WatchOptions thêm max_sheets?: number; watchVideos phân bổ sheet theo tỉ lệ thời lượng, mỗi video ≥ 1, tổng ≤ max_sheets;
//           thêm tham số transcriptBySource?: Record<string, WatchTranscript> — có thì dùng, KHÔNG gọi hook transcribe
// library-checkers.ts: checker "survey-valid" 1.0.0 — output type "survey": parse AnySurveyIndexSchema; v2 → mỗi shot_id phải có trong input type "shots" (ShotsIndexSchema), in/out lệch ≤ 0.05, source_id khớp; v1 → pass (hành vi 1.1.0); thiếu input shots với v2 → fail { reason: "no shots input" }
```

- [ ] **Step 1: Test thất bại** — `buildShots`: `cuts []`, dur 10, max 4 → 3 shot bằng nhau; cuts `[0.4, 5]`, min 1 → shot đầu gộp vào sau → `[0,5],[5,10]`; shot cuối ngắn gộp vào trước; cuts ngoài khoảng bị bỏ; dur 0 → `[]`. `indexSources` (`skipIf(!hasFfmpeg())`): video tự sinh 3 cảnh màu (`color=red:d=2`, `blue`, `green` nối bằng concat) → ≥ 3 shot, `shot_id` dạng `s000-00N`, proxy tồn tại và cao 540; một source hỏng (file text) + một tốt → source hỏng có `error`, stage vẫn trả; cả hai hỏng → ném `CONFIG_INVALID`. `transcribeSources` với `FakeMediaEngine`: source không audio → segments rỗng, engine chỉ được gọi với source có audio; engine trả contract → `CONFIG_INVALID`. `watch-multi`: 3 video, `max_sheets 4` → tổng sheet ≤ 4, mỗi video ≥ 1; có `transcriptBySource` → hook transcribe không bị gọi (spy). `survey-valid`: v2 hợp lệ pass; `shot_id` lạ fail; in lệch 0.2 fail; v1 pass.
- [ ] **Step 2–4:** triển khai; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(core): scene-based multi-source index, transcript stage core, multi-source watch with sheet budget, survey-valid checker`.

---

### Task 4: Hồ sơ giọng trong kho, `voice_id` trên request và brief

**Files:**
- Create: `packages/core/src/library/voices.ts`
- Modify: `packages/core/src/library/files.ts` (paths `voicesDir`, `voiceDir(id)`, `voiceFile(id)`, `voiceRef(id)`; `assertWritable`: channel được ghi `voices/**`), `sync.ts` (mirror `voices/` → `upsertVoiceProfile`; `SyncReport.imported/updated.voices`), `requests.ts` (`createRequest` nhận `voice_id`, quy tắc `tts`), `packages/cli/src/commands/library.ts` (`voices add|list|retire`, `request create --voice-id`), `library-stage.ts` (`intake` chụp `voice_id/voice_revision/voice_checksum`), `publish-stage.ts` (`create-requests` truyền `voice_id` của kênh), `packages/core/src/doctor/doctor.ts` (`library:voices`, `channel:<id>:voice`), `packages/core/src/index.ts`
- Test: `packages/core/test/library/{voices,files-voices,requests-voice}.test.ts`, `packages/cli/test/library-voices.test.ts`, `packages/core/test/doctor/doctor.test.ts` (thêm)

**Interfaces (Produces):**

```ts
// voices.ts
export async function addVoice(d: { fs: LibraryFs; store: StateStore; clock: Clock; ffmpeg: string; probeDuration: (p: string) => number | null }, p: { voice_id?: string; display_name: string; ref_path: string; ref_text: string; language: string; origin: "synthetic" | "own" | "licensed"; origin_note?: string; params?: Partial<VoiceParams> }): Promise<VoiceProfile>
//  chuyển clip → wav 24 kHz mono trong temp (`-ac 1 -ar 24000 -c:a pcm_s16le`); thời lượng ngoài [3,30] → CONFIG_INVALID; ghi ref.wav qua fs.copyFileWithChecksum rồi voice.json qua fs.writeJsonAtomic;
//  voice_id đã tồn tại → revision + 1, giữ created_at; mới → newId("voice_profile"), revision 1; upsertVoiceProfile
export function retireVoice(d: { fs; store; clock }, voiceId: string): VoiceProfile          // status "retired"; không tồn tại → NOT_FOUND
export function requireActiveVoice(store: StateStore, voiceId: string | undefined): VoiceProfile   // undefined | không có | retired → CONFIG_INVALID nêu rõ lý do
// requests.ts createRequest: voice === "tts" → voice_id = p.voice_id ?? p.channelVoiceId; requireActiveVoice; ghi vào request. voice khác "tts" → bỏ qua voice_id (không ghi)
// intake: brief.voice === "tts" → profile = requireActiveVoice(store, request.voice_id) (mirror của studio); verify sha256 của <kho>/voices/<id>/ref.wav === ref_audio.checksum, lệch → CONFIG_INVALID; brief thêm voice_id, voice_revision, voice_checksum
```

- [ ] **Step 1: Test thất bại** — `files-voices`: vai channel ghi được `voices/v/voice.json` và `voices/v/ref.wav`; vai studio bị `CONFIG_INVALID`. `voices` (`skipIf(!hasFfmpeg())`): clip sine 5 s → hồ sơ `revision 1`, `ref.wav` 24 kHz mono, checksum khớp file; add lại cùng id → `revision 2`; clip 2 s → từ chối; retire → `status retired`; `requireActiveVoice` ba nhánh lỗi. `sync`: hồ sơ ghi tay trong kho được mirror ở vai studio. `requests-voice`: `tts` không `voice_id` → `CONFIG_INVALID`; `tts` với `channelVoiceId` → request có `voice_id`; `none` kèm `voice_id` → request không có trường đó. CLI spawn: `voices add … --json` rồi `voices list --json`; `request create --voice tts` thiếu giọng → exit ≠ 0 và message có "voice". Doctor: `library:voices` fail khi thiếu thư mục; `channel:<id>:voice` ok / fail khi retired / fail khi checksum lệch; kênh không khai `voice` → không hàng.
- [ ] **Step 2–4:** triển khai; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(library): channel-owned voice profiles in the kho, voice_id on requests and briefs, doctor voice rows`.

---

### Task 5: Core giọng đọc — `sentences`, cache, `synthesizeNarration`, `tts-valid`, `edl-valid` mở rộng

**Files:**
- Create: `packages/core/src/media/sentences.ts`, `tts.ts`
- Modify: `packages/core/src/verification/media-checkers.ts` (`tts-valid`; `edl-valid` đọc thêm output type `narration`), `packages/core/src/index.ts`
- Test: `packages/core/test/media/{sentences,tts}.test.ts`, `packages/core/test/verification/{tts-valid,edl-valid-narration}.test.ts`

**Interfaces (Produces):**

```ts
// sentences.ts (thuần)
export function splitSentences(text: string, language: string, maxChars: number): string[]
//  1) chuẩn hoá khoảng trắng; 2) tách sau [.!?…;:] + khoảng trắng hoặc xuống dòng, KHÔNG tách khi dấu chấm nằm giữa hai chữ số (3.5) hoặc ngay sau từ viết tắt (en: Mr Mrs Ms Dr Prof St vs etc e.g i.e U.S; vi: TP Th.S TS PGS GS ThS Q P); ngôn ngữ khác: chỉ quy tắc số;
//  3) gộp câu liền nhau khi tổng ≤ maxChars; 4) câu > maxChars: tách ở dấu phẩy gần giữa nhất, vẫn dài → ở khoảng trắng gần maxChars nhất; không bao giờ trả chuỗi rỗng; nối lại các chunk bằng " " phải bằng text đã chuẩn hoá
// tts.ts
export function ttsCacheKey(p: { text: string; voice_checksum: string; params: VoiceParams; model: string; language: string }): string   // sha256 hex của JSON có khoá sắp xếp
export interface TtsDeps { engine: MediaEngine; ffmpeg: string; probeDuration: (p: string) => number | null; cacheDir: string; log?: WatchLogFn }
export async function synthesizeNarration(d: TtsDeps, p: { narration: Narration; voiceMode: "none" | "tts" | "original"; voice?: { profile: VoiceProfile; ref_audio_path: string }; cfg: MediaConfig["tts"]; outDir: string; deadlineSeconds: number }): Promise<NarrationTiming>
//  voiceMode ≠ "tts" hoặc lines rỗng → timing rỗng (voice_id null), không gọi engine, outDir vẫn được tạo
//  mỗi dòng: key → trúng cache (`<key>.wav` + `<key>.json`) → copy vào outDir, cached true; trượt → vào job với chunks = splitSentences(text, language, cfg.max_chars)
//  timeout = min(deadlineSeconds, max(900, Σchars × 0.6)); engine contract/transient → HarnessError CONFIG_INVALID / IO_ERROR
//  sau engine: loudnorm tuyến tính (`loudnorm=I=${lufs}:TP=-1.5:LRA=11:linear=true`, `-ar 24000 -ac 1`) vào outDir/<line_id>.wav; đo lại thời lượng, lệch > 0.010 s so với engine → IO_ERROR; ghi cache nguyên tử (tmp + rename) SAU khi dòng hợp lệ (duration > 0)
//  total_seconds = Σ duration; wav = `voice/<line_id>.wav` (đường tương đối từ output/)
// media-checkers.ts: "tts-valid" 1.0.0 — output type "narration_timing": parse; mỗi dòng wav tồn tại trong output dir type "voice_set"; duration > 0; 5 ≤ chars/duration ≤ 30; đỉnh < 0 dBFS (ffmpeg volumedetect max_volume < 0); lines rỗng → pass
//  "edl-valid" → version 1.1.0: nếu result có output type "narration" và mime application/json → parse NarrationSchema; mọi edl_order ∈ orders của EDL; line_id duy nhất; mime text/plain (workflow 1.1.0) → bỏ qua như cũ
```

- [ ] **Step 1: Test thất bại** — `sentences`: `"Giá là 3.5 triệu. Xong."` → 2 câu, `3.5` không bị tách; `"Dr. Smith came. He left."` (en) → 2; `"TP. Hồ Chí Minh đẹp. Thật."` (vi) → 2; câu 600 ký tự có phẩy, max 280 → mọi chunk ≤ 280 và nối lại bằng đầu vào; không phẩy không khoảng trắng → chunk cắt cứng ≤ 280; chuỗi toàn khoảng trắng → `[]`. `ttsCacheKey`: đổi `speed` → khoá đổi; thứ tự khoá JSON không ảnh hưởng. `synthesizeNarration` với `FakeMediaEngine` (`skipIf(!hasFfmpeg())`): 3 dòng → 3 wav, timing parse, `cached false`; chạy lại → engine không bị gọi (`calls` không tăng), `cached true`; sửa 1 dòng → engine nhận đúng 1 dòng; `voiceMode "original"` → rỗng, không gọi engine; engine contract → `CONFIG_INVALID`. `tts-valid`: pass; thiếu wav fail; tốc độ 100 ký tự/giây fail. `edl-valid`: `edl_order` lạ fail; `line_id` trùng fail; narration text/plain vẫn pass.
- [ ] **Step 2–4:** triển khai; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(core): sentence splitting, content-addressed tts cache, narration synthesis with loudness normalisation, tts-valid and narration-aware edl-valid`.

---

### Task 6: Core khớp hình theo lời — `fit-edl`, `timeline`

**Files:**
- Create: `packages/core/src/media/fit-edl.ts`, `timeline.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/media/{fit-edl,timeline}.test.ts`

**Interfaces (Produces):**

```ts
// fit-edl.ts (thuần, không I/O)
export const FIT = { lead: 0.3, tail: 0.4, keepSlack: 0.5, snapWindow: 0.4, minGap: 0.15, handle: 0.08, minEntry: 0.2 } as const;
export function fitEdl(p: { edl: Edl; timing: NarrationTiming; shots: ShotsIndex; survey: SurveyIndexV2 | null; transcript: Transcript | null; voice: "none" | "tts" | "original"; target_duration_seconds?: [number, number] }): { edl: Edl; report: FitReport }
//  tts — theo thứ tự order; need(order) = Σ duration các dòng có edl_order === order + lead + tail; entry không có dòng → kept
//    1 dur ≥ need: dur − need < keepSlack → kept; ngược lại out = in + need → trimmed
//    2 dur < need: shot = shot chứa [in,out] trong shots (theo source_id; không tìm thấy → coi shot = [in,out]); out = min(shot.out, in + need); còn thiếu → in = max(shot.in, out − need) → extended
//    3 còn thiếu: lặp shot kề sau CÙNG source (shot_id kế tiếp) nếu survey.usable !== false và chưa có trong tập "đã dùng" → entry mới ngay sau, lấy min(len shot, thiếu) → appended
//    4 còn thiếu: shot usable chưa dùng, score cao nhất (tie → source index, in tăng) từ mọi source → appended
//    5 còn thiếu: shot ĐÃ dùng score cao nhất → reused; shortfalls.push({ line_ids, missing_seconds: phần phủ bằng reused }); reused_seconds += phần đó; không có shot nào để reuse → shortfalls với phần còn thiếu, không thêm entry
//    "đã dùng" = mọi khoảng [in,out] của EDL gốc và các entry đã thêm (so bằng shot_id của shot chứa nó); survey null → mọi shot coi là usable score 0
//  original — mỗi điểm in/out: words của source đó (transcript, alignment "word"); điểm nằm trong một từ (start < t < end) → tìm khoảng lặng ≥ minGap giữa hai từ liên tiếp (và trước từ đầu/sau từ cuối) có tâm trong ±snapWindow; ưu tiên hướng MỞ RỘNG đoạn (in lùi, out tiến); đặt t tại mép khoảng lặng phía ngoài đoạn ∓ handle (không vượt tâm khoảng lặng) → snapped; alignment "segment" → bắt về start/end segment gần nhất trong cửa sổ; không có → giữ, warnings.push
//  none — kept
//  mọi chế độ: kẹp [0, source.duration_seconds]; out − in < minEntry → bỏ, action "dropped", warnings; đánh lại order 0..n−1 liên tiếp; note entry thêm = "fit: appended|reused for <line_ids>"; EDL kết quả phải EdlSchema.parse được (≥ 1 entry, nếu rỗng → giữ entry đầu của EDL gốc và warnings)
//  report.total_seconds = Σ(out − in); within_target = !target || (total ≥ target[0] && total ≤ target[1])
// timeline.ts (thuần)
export function buildTimeline(p: { edl: Edl; timing: NarrationTiming; transcript: Transcript | null; voice: "none" | "tts" | "original"; language: string; orderMap: Map<number, number[]> /* edl_order gốc → các order mới theo thứ tự */ }): Timeline
//  video[i].start = Σ độ dài các entry trước; narration: dòng đầu của một edl_order bắt đầu tại start(entry đầu của nhóm) + FIT.lead, các dòng sau nối tiếp ngay; words dời +start dòng; end = start + duration
//  speech (chỉ voice original): mỗi segment transcript giao với [in,out] của entry → cắt theo giao, dời về thời gian chương trình (t − in + start), words ngoài giao bị bỏ
// fitEdl trả thêm orderMap trong kết quả: { edl, report, orderMap }
```

- [ ] **Step 1: Test thất bại** — dựng fixture thuần (1–2 source, 6 shot 5 s, survey v2). `tts`: lời 3,0 s trên entry 8 s → trimmed còn 3,7; lời 4,0 s trên entry 4,5 s (chênh 0,2 < 0,5) → kept; lời 6 s trên entry 3 s nằm trong shot 5 s → extended hết shot rồi appended shot kề; shot kề `usable false` → nhảy sang quy tắc 4 lấy shot score cao nhất source khác; hết shot chưa dùng → reused + `shortfalls[0].missing_seconds` đúng; không còn shot nào → shortfall, không thêm entry; entry không lời giữ nguyên; `order` liên tiếp; `orderMap` đúng; kết quả qua `EdlSchema.parse`. `original`: `in` rơi giữa từ, khoảng lặng 0,3 s phía trước trong cửa sổ → `in` lùi về mép khoảng lặng − 0,08 (không vượt tâm); `out` giữa từ → tiến; không có khoảng lặng ≥ 0,15 trong ±0,4 → giữ + warning; alignment `segment` → bắt về biên segment. `none` → y nguyên. Kẹp biên source; entry < 0,2 s → dropped. `within_target` false khi tổng ngoài khoảng. `buildTimeline`: `start` cộng dồn; dòng thứ hai của cùng `edl_order` bắt đầu đúng lúc dòng một kết thúc; `words` dời đúng; `speech` cắt theo giao và dời đúng.
- [ ] **Step 2–4:** triển khai; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(core): fit-edl (picture follows voice, word-boundary snapping) and programme timeline`.

---

### Task 7: Auto-accept chọn collection, `source ingest` thư mục

**Files:**
- Modify: `packages/core/src/library/auto-accept.ts` (`pickSources` thay `pickSource`; bận theo collection), `packages/core/src/source-catalog/catalog.ts` (`ingestDirectory`), `packages/cli/src/commands/source.ts` (`ingest <path>` nhận thư mục, `--recursive`), `packages/cli/src/commands/worker.ts` (`autoAcceptDepsFor` truyền `patterns`, `maxSources`)
- Test: `packages/core/test/library/auto-accept-collections.test.ts`, `packages/core/test/source-catalog/ingest-directory.test.ts`, `packages/cli/test/source-ingest-dir.test.ts`; test `auto-accept` hiện có giữ xanh

**Interfaces (Produces):**

```ts
export function matchCollection(name: string, pattern: string): boolean     // glob chỉ có `*` (→ `[a-z0-9-]*`), neo hai đầu
export function pickSources(store: StateStore, p: { request: ContentRequest; patterns: string[]; maxSources: number; busyCollections: Set<string>; usedCollections: Set<string> }): SourceItem[]
//  1 hint.source_ids → các source tồn tại và không restricted, giữ thứ tự hint; 2 hint.collection → mọi source không restricted của collection (bất kể bận/used);
//  3 không hint → các collection khớp patterns, không ∈ busy, không ∈ used, có ≥ 1 source không restricted; chọn collection có max(ingested_at) lớn nhất
//  sắp theo basename(original_uri) rồi ingested_at; slice(maxSources); [] → caller skip "no-source"
//  busyCollections: collection của mọi source thuộc content có run library-production chưa terminal; usedCollections: … có run SUCCEEDED
// autoAccept: createContent({ source_ids: picked.map(s => s.source_id), … }); phần còn lại giữ nguyên (startPlannedRun, một transaction)
// catalog.ts
async ingestDirectory(p: { dir: string; recursive: boolean; collection?: string; rights_status?: …; language?: string }): Promise<{ ingested: { source: SourceItem; created: boolean }[]; skipped: { path: string; why: string }[] }>
//  phần mở rộng video: .mp4 .mov .mkv .m4v .avi .webm (không phân biệt hoa thường); sắp theo tên; file lỗi → skipped, không dừng
```

- [ ] **Step 1: Test thất bại** — `matchCollection`: `shoot-*` khớp `shoot-2026-09-21`, không khớp `main`; `main` khớp đúng `main`. `pickSources`: hint ids (bỏ restricted, giữ thứ tự); hint collection; không hint → collection mới nhất khớp mẫu; collection bận bị bỏ; collection đã có run SUCCEEDED bị bỏ; `maxSources 2` cắt; sắp theo tên file; không gì khớp → `[]`. `autoAccept`: content tạo ra có đủ `source_ids` của collection; cấu hình cũ chỉ có `source_collection: main` vẫn chạy (test `auto-accept` cũ xanh, không sửa kỳ vọng ngoài số source nếu fixture chỉ có 1 source). `ingestDirectory` (`skipIf(!hasFfmpeg())`): thư mục 2 mp4 + 1 txt → 2 ingested, txt không nằm trong skipped (không phải video, bỏ im lặng); file mp4 hỏng → skipped; `--recursive` lấy thư mục con. CLI: `source ingest <dir> --collection shoot-a --rights cleared --json` in 2 source.
- [ ] **Step 2–4:** triển khai; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(library): auto-accept picks a whole shoot collection; source ingest accepts a directory`.

---

### Task 8: Bốn stage built-in, workflow `library-production@1.2.0`, profile, skill, agent giả, assemble mẫu

**Files:**
- Create: `workflows/library-production@1.2.0/workflow.yaml`
- Modify: `packages/cli/src/commands/media.ts` (4 lệnh + `builtinMediaCommands` thêm `media-index|media-transcribe|media-tts|media-fit-edl`), `production-profiles/studio/profile.yaml` (rev 3), `skills/{source-survey,edit-plan,library-review}/SKILL.md`, `fixtures/fake-agent-cli.mjs`, `fixtures/ops-project-footage/executors/wrappers/assemble.mjs`, `fixtures/ops-project-studio/{project.yaml,executors/scripts.yaml}`, `packages/adapters/agent-cli/src/cli-agent-runtime.ts` (`FAKE_NARRATION_CHARS` vào `FAKE_AGENT_TEST_ENV`)
- Test: `packages/cli/test/media-stages.test.ts`, `packages/core/test/orchestration/library-production-1-2.test.ts`, `packages/adapters/agent-cli/test/fake-agent-outputs.test.ts` (thêm)

**Stage built-in (`harness media <cmd>`, khuôn `watchStage`/`runStage` trong `media.ts`; lỗi map y hệt: `CONFIG_INVALID|NOT_FOUND|INVALID_TRANSITION` → `contract`, `IO_ERROR` và còn lại → `transient`):**
- `index`: sources = `sdk.sources` (đường dẫn từ `uri` file URL; `file_name` = basename của `original_uri` lấy qua `app.store.getSourceItem`); `indexSources` → `output/shots.json` (type `shots`), `output/proxy/` (type `proxy_set`, `sdk.out.dir`).
- `transcribe`: input `shots`; `language` từng source từ store; `transcribeSources({ engine: app.media, … deadlineSeconds: giây còn lại tới request.limits.deadline_at − 30 })` → `output/transcript.json` (type `transcript`); event `media.transcribed`.
- `tts`: input `narration`, `brief`; `voiceMode` = `brief.voice`; `tts` → `profile = requireActiveVoice(store, brief.voice_id)`, `ref_audio_path = lib.fs.paths.voiceRef(id)`, kiểm checksum = `brief.voice_checksum` (lệch → `CONFIG_INVALID`); `cacheDir = join(dataRoot, "cache", "tts")` → `output/voice/` (type `voice_set`), `output/narration-timing.json` (type `narration_timing`); event `media.tts_done { lines, cached }`.
- `fit-edl`: input `edl`, `narration_timing`, `shots`, `survey` (optional → null), `transcript` (optional → null), `brief`; → `output/edl.json` (type `edl`), `output/fit-report.json` (type `fit_report`), `output/timeline.json` (type `timeline`); `shortfalls` không rỗng → event `media.fit_shortfall`; **không fail**.
- `watch --mode source`: khi có input `transcript` → truyền `transcriptBySource`; `max_sheets` từ `app.mediaConfig.watch.max_sheets`; chạy trên mọi `sdk.sources`.

**`workflows/library-production@1.2.0/workflow.yaml`:** chép nguyên `library-production@1.1.0/workflow.yaml`, `version: 1.2.0`, rồi áp đúng các thay đổi sau (mọi thứ khác giữ nguyên từng ký tự):

```yaml
  # thay stage index-source bằng:
  - key: media-index
    executor: { type: script, script: media-index }
    depends_on: [intake]
    requires_resources: [cpu]
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: shots, mime_type: application/json, name: shots.json }
      - { type: proxy_set, mime_type: application/x-directory, kind: directory, name: proxy }
  # thêm ngay sau:
  - key: media-transcribe
    executor: { type: script, script: media-transcribe }
    depends_on: [media-index]
    requires_resources: [gpu]
    retry: { max_attempts: 2, backoff_seconds: [60], retry_on: [transient, abandoned] }
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: transcript, mime_type: application/json, name: transcript.json }
  # watch-source: depends_on: [media-index, media-transcribe]
  # survey-source: depends_on thay index-source → media-index, thêm media-transcribe; required_checks thêm survey-valid; brief thêm câu: "Đọc shots.json (harness.shots/v2, nhiều source) và transcript.json; chấm theo shot_id, ghi survey.json harness.survey-index/v2."
  # plan-edit: depends_on thay index-source → media-index, thêm media-transcribe; output narration đổi thành { type: narration, mime_type: application/json, name: narration.json }; brief thêm câu: "Viết output/narration.json (harness.narration/v1) với edl_order cho từng dòng; voice original thì lines rỗng và cắt theo câu trọn trong transcript."
  # thay stage tts bằng (KHÔNG có `when`):
  - key: media-tts
    executor: { type: script, script: media-tts }
    depends_on: [plan-edit, intake]
    requires_resources: [gpu]
    retry: { max_attempts: 2, backoff_seconds: [60], retry_on: [transient, abandoned] }
    required_checks: [schema-valid, output-exists, checksum-match, tts-valid]
    outputs:
      - { type: voice_set, mime_type: application/x-directory, kind: directory, name: voice }
      - { type: narration_timing, mime_type: application/json, name: narration-timing.json }
  - key: media-fit-edl
    executor: { type: script, script: media-fit-edl }
    depends_on: [plan-edit, media-tts, survey-source, media-index, media-transcribe, intake]
    requires_resources: [cpu]
    required_checks: [schema-valid, output-exists, checksum-match, edl-valid]
    outputs:
      - { type: edl, mime_type: application/json, name: edl.json }
      - { type: fit_report, mime_type: application/json, name: fit-report.json }
      - { type: timeline, mime_type: application/json, name: timeline.json }
  # cut: depends_on: [media-fit-edl]
  # assemble: depends_on: [cut, intake, media-tts, media-fit-edl]; bỏ depends_on_optional
  # library-review: depends_on thêm media-fit-edl
```

`production-profiles/studio/profile.yaml`: `revision: 3`, `workflow_release: library-production@1.2.0`, `overrides: { default_deadline_seconds: 14400 }` (các stage GPU dài; khoá này nằm trong `allowed_override_keys` mặc định), phần còn lại giữ nguyên. Nếu artifact type là enum đóng trong contracts, thêm `proxy_set`, `transcript`, `voice_set`, `narration_timing`, `fit_report`, `timeline` và `pnpm gen:schemas`.

**`assemble.mjs` mẫu:** vẫn nối clip theo tên; nếu có input `timeline`: `voice === "tts"` → tắt tiếng clip (`-an` ở bước nối) rồi mix các wav `narration[]` bằng `adelay=<start×1000>|<start×1000>` + `amix=inputs=N:normalize=0`, `apad` tới `total_seconds`; `original` → giữ tiếng clip; `none` → `volume=-12dB`. Không có input `timeline` (workflow 1.1.0) → hành vi cũ nguyên vẹn.

**Skill:** sửa theo spec §4.5 (giữ cấu trúc heading hiện có của từng file; `edit-plan` thêm mục "Cấu trúc `output/narration.json`" có JSON mẫu; `source-survey` đổi JSON mẫu sang v2; `library-review` thêm bước đọc `fit-report.json` với ba điều kiện từ chối và yêu cầu `note` nêu `line_id` + số giây thiếu).

**`fake-agent-cli.mjs`:** `survey` → nếu input `shots` là v2 thì sinh survey v2 (mọi shot `usable true`, `score 3`, `speech` = "talking" khi transcript có segment giao với shot, ngược lại "none"); `edl`/`narration` → EDL chọn shot đầu của tối đa 3 source, `narration.json` mỗi entry một dòng dài `FAKE_NARRATION_CHARS` ký tự (mặc định 40) khi `brief.voice === "tts"`, `lines: []` khi khác; khi `brief.request_notes` chứa "thiếu" → dùng 20 ký tự (mô phỏng sửa lời sau khi bị loại); `review` → nếu có input `fit_report` và (`shortfalls.length > 0` || `reused_seconds > 5` || `!within_target`) → `rejected` với `note` chứa "thiếu <n> s ở <line_ids>", bất kể `FAKE_REVIEW_MODE`.

- [ ] **Step 1: Test thất bại** — workflow test: `library-production@1.2.0` nạp được, đúng 15 stage theo thứ tự spec §4.3, `cut.depends_on === ["media-fit-edl"]`, `media-tts` không có `when`; 1.1.0 và 1.0.0 không đổi (so checksum file với `git show HEAD:`… hoặc đếm stage như test SP4); profile `studio` rev 3 + override deadline. `media-stages.test.ts` (CLI spawn, `pnpm build`, `skipIf(!hasFfmpeg())`, `adapters.media: fake`): dựng workspace tay như `packages/cli/test/learning-stages.test.ts` — `media index` với 2 source → `shots.json` v2 hai source + 2 proxy; `media transcribe` → `transcript.json` parse; `media tts` với brief `voice: tts` + hồ sơ giọng trong kho → `voice/` + timing, chạy lại → mọi dòng `cached`; brief `voice: none` → timing rỗng; checksum giọng lệch → `contract`; `media fit-edl` lời dài → `fit-report.json` có `appended`, `edl.json` qua `EdlSchema`, `timeline.json` parse, exit 0 kể cả khi có `shortfalls`. Fake agent: survey v2 hợp lệ qua `survey-valid`; `narration.json` qua `edl-valid`; review từ chối khi `fit_report` có shortfall.
- [ ] **Step 2–4:** triển khai; `fixtures/ops-project-studio/project.yaml`: `workflows` thêm `library-production@1.2.0`, `adapters.media: fake`, `library.auto_accept.source_collections: ["main", "shoot-*"]`; `scripts.yaml` giữ các wrapper cũ (1.1.0 còn dùng); `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat: media index/transcribe/tts/fit-edl stages, library-production@1.2.0, studio profile rev 3, multi-source skills and fake agent`.

---

### Task 9: Doctor `media:*`, event, dashboard

**Files:**
- Modify: `packages/core/src/doctor/doctor.ts`, `packages/cli/src/composition.ts` (`computeDoctorRows` nhận `media: { adapter, probe }`), `packages/core/src/dashboard/snapshot.ts` (khối `media`, alert `media_engine_unavailable`)
- Test: `packages/core/test/doctor/doctor.test.ts` (thêm), `packages/core/test/dashboard/snapshot.test.ts` (thêm)

**Interfaces (Produces):**

```ts
// doctor: chỉ khi adapters.media === "python"
//  media:python   — probe.python !== null (detail: phiên bản) | fail "python not runnable: <path>"
//  media:packages — torch, omnivoice, whisperx đều có phiên bản | fail liệt kê gói thiếu
//  media:device   — device "cpu" → ok "cpu"; cuda:* → probe.cuda true (detail: gpu, vram_free_mb) | fail "CUDA not available"
//  media:models   — mọi models_cached true → ok; thiếu → ok:false detail "will download on first run: <tên>" (cảnh báo, cùng khuôn ok:false như `channel:<id>:planning` với agent giả)
//  adapters.media === "fake" trên project studio có auto_accept.enabled và workflows chứa library-production@1.2.0 → hàng `media:engine` ok:false "fake media engine"
// snapshot: DashboardSnapshot.media = { engine: "python" | "fake", last_tts_at: ts | null (event media.tts_done mới nhất), cache_hit_ratio: number | null (Σcached / Σlines của 20 event media.tts_done gần nhất) }; alert kind "media_engine_unavailable" khi có hàng doctor media:* ok:false (trừ media:models)
```

- [ ] **Step 1: Test thất bại** — doctor 6 case: fake → không hàng `media:*` (trừ case studio autopilot + 1.2.0 → `media:engine` fail); python đủ → 4 hàng ok; thiếu `whisperx` → `media:packages` fail nêu tên; `cuda false` với `cuda:0` → fail; `device: cpu` → ok; model chưa cache → `media:models` ok:false nhưng không sinh alert. Snapshot: `cache_hit_ratio` đúng từ 2 event; alert xuất hiện khi `media:python` fail.
- [ ] **Step 2–4:** triển khai; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(core): doctor rows and dashboard block for the media engine`.

---

### Task 10: Test tích hợp `studio-media`, acceptance 41–46

**Files:**
- Modify: `tests/integration/library-helpers.ts` (`freshLibraryWorld({ media1_2?: true })`: studio autopilot + `adapters.media: fake` + workflow 1.2.0; `ingestShoot(world, collection, n, { withAudio?: boolean })` sinh n clip ffmpeg 6–10 s ba cảnh màu và `source ingest <dir>`; `addVoice(world, id?)` ghi hồ sơ giọng bằng CLI vai channel; `requestCreate` thêm `voiceId`)
- Create: `tests/integration/studio-media.test.ts`, `tests/acceptance/41-multi-clip-episode.test.ts`, `42-long-narration-rejected-then-replanned.test.ts`, `43-original-voice-never-cuts-mid-word.test.ts`, `44-tts-request-without-voice-rejected.test.ts`, `45-no-secret-in-media-engine-env.test.ts`, `46-library-production-1-1-0-still-runs.test.ts`

- [ ] **Step 1: `studio-media.test.ts`** (`skipIf(!hasFfmpeg())`, 600 s): `freshLibraryWorld({ media1_2: true })`; `writeActiveStyle`; `addVoice`; `ingestShoot(world, "shoot-a", 3, { withAudio: true })`; kênh `request create --voice tts --voice-id … --duration 5,120 --source-hint shoot-a`; `studioWorkerUntil(item approved)` → run dùng `library-production@1.2.0`, 15 stage `SUCCEEDED`; artifact: `shots.json` có 3 source; `transcript.json` có segment; `narration-timing.json` số dòng = `narration.json`; `timeline.json.total_seconds` ≈ thời lượng `full-episode.mp4` ±0,5 s (ffprobe); `full-episode.mp4` có audio stream; event `media.transcribed`, `media.tts_done`.
- [ ] **Step 2: Acceptance**
  - **41**: EDL đã khớp dùng ≥ 2 `source_id` khác nhau; `fit-report.json.entries` có `appended` hoặc `extended` hoặc `trimmed` (không toàn `kept`).
  - **42**: `FAKE_NARRATION_CHARS=2000` với 1 clip 6 s → run 1: `fit-report.shortfalls` không rỗng, review `rejected`, `note` có "thiếu"; autopilot replan (SP4) → run 2 lời 20 ký tự → `approved`; ở run 2 `narration-timing` có `cached: false` cho dòng mới (nội dung đổi); chạy thêm một request y hệt lời 40 ký tự hai lần → lần hai mọi dòng `cached: true` (chứng minh cache).
  - **43**: `voice: original`, transcript giả có `words`; mọi `in/out` của EDL đã khớp không nằm trong khoảng `(word.start, word.end)` của bất kỳ từ nào của source đó (trừ entry có warning trong `fit-report`).
  - **44**: `library request create --voice tts` không `--voice-id`, kênh không khai `voice` → exit ≠ 0, không file request mới trong kho; kênh khai `voice.voice_id` đã `retired` → cũng bị từ chối.
  - **45**: `adapters.media: python` với `media.python` = Node chạy script giả ghi toàn bộ `process.env` vào result/log; env cha có `HARNESS_SECRET_X_Y=s3cret` → workspace, log, event, artifact không chứa `s3cret` hay `HARNESS_SECRET_`.
  - **46**: `plan --workflow library-production@1.1.0 --profile studio` trên fixture cũ (một source, wrapper `index-source`/`tts` cũ) vẫn chạy tới `approved`; `loadWorkflow("library-production@1.1.0")` có stage `index-source` và không có `media-fit-edl`.
- [ ] **Step 3:** `pnpm build && pnpm test`; không media/data trong repo.
- [ ] **Step 4: Commit** — `test: studio media integration (multi-clip shoot → transcript → tts → fit-edl → approved); acceptance 41-46`.

---

### Task 11: Chạy thật trên GPU của máy build, tài liệu

**Files:** Create `docs/runbooks/studio-media.md`; Modify `AGENTS.md` ("Lệnh 5A (media studio)"), `README.md` (trạng thái + quick-start 5A với engine giả), `docs/adr/0001-control-plane-baseline.md` (mục 102+), `docs/operations/deferred-items.md` ("Sau sub-project 5A"), `docs/runbooks/go-live.md` (bước 4.3: bỏ `index-source`, `tts`, `transcribe` khỏi danh sách wrapper phải viết; thêm khối `media:` và bước dựng venv), `project-template/project.yaml` (`adapters.media`, `media:`, `auto_accept.source_collections|max_sources`), `project-template/channels/example/channel.yaml` (`voice:`)

- [ ] **Step 1: Dựng venv thật (ngoài repo, ví dụ `D:\harness-venv`)** theo `engines/python/README.md`: `py -3.11 -m venv D:\harness-venv`; cài torch 2.8.0 + torchaudio 2.8.0 bản CUDA khớp driver (`nvidia-smi`), rồi `pip install -r engines/python/requirements.txt`. Xung đột phiên bản không gỡ được trong 1 venv → dựng 2 venv (`D:\harness-venv-asr`, `D:\harness-venv-tts`) và dùng `media.transcribe.python` / `media.tts.python`; ghi lại lựa chọn và lý do vào runbook. Cần mạng và ~15 GB đĩa; không commit gì từ bước này.
- [ ] **Step 2: Chạy thật**, trên một ops project temp (copy `fixtures/ops-project-studio`, `adapters.media: python`, `adapters.agent` giữ agent giả — DoD này kiểm media, không kiểm agent): `harness doctor` → 4 hàng `media:*` + `library:voices` ok. Nguồn: 3 clip tự quay hoặc tự sinh có tiếng nói thật (dùng chính TTS sinh một đoạn nói rồi ghép vào video màu để có audio tiếng người — không lấy nội dung có bản quyền). Hồ sơ giọng `origin: synthetic`: clip mẫu sinh bằng `omnivoice-infer … --instruct "female, low pitch, american accent"` (voice design, không nhân giọng người thật). Chạy ba tập: `en` + `tts`, `vi` + `tts`, `original`. Ghi vào runbook bảng: stage, thời gian, VRAM đỉnh (`nvidia-smi --query-gpu=memory.used`), số dòng, `alignment` nhận được, nhận xét nghe thử tiếng Việt (đạt / không đạt + lý do). Lỗi gặp khi chạy thật → sửa trong `engines/python/*.py` hoặc adapter, thêm test tái hiện được bằng `--dry-run`/script giả nếu có thể, commit `fix(...)` riêng.
- [ ] **Step 3: Runbook** `studio-media.md`: (1) điều kiện + dựng venv + tải trước mô hình; (2) khối `media:` và ý nghĩa từng khoá, phương án hai venv; (3) buổi quay = collection: `source ingest <dir> --collection shoot-YYYY-MM-DD`, `auto_accept.source_collections`; (4) hồ sơ giọng: `voices add|list|retire`, `origin`, quy tắc không nhân giọng người thật khi không có quyền, `channel.yaml.voice`; (5) đọc `fit-report.json`/`timeline.json`, vì sao review loại, vòng replan, cache TTS; (6) sự cố: `media:*` doctor fail, OOM, timeout (`default_deadline_seconds`), căn chỉnh lùi về `chunk`, tiếng Việt; (7) thời gian chạy và VRAM đo ở Step 2; (8) quay về 1.1.0 (`--workflow`); (9) kết luận DoD #2 và #3.
- [ ] **Step 4:** ADR 102+ (engine Python là tiến trình con qua file JSON; `adapters.media`; buổi quay = collection; giọng thuộc kênh, kho `voices/`, `origin` bắt buộc; hình theo lời và `fit-edl` không fail; `timeline.json` là hợp đồng cho 5B; cache TTS theo nội dung; harness không dành cho hoạt hình), AGENTS, README, deferred (từ ledger + spec §10: dọn `cache/tts`, dò cảnh tốt hơn, voice design, dịch transcript, `style-study` dùng engine thật, tên profile `cartoon`/`avatar` còn sót trong enum), template, `go-live.md`.
- [ ] **Step 5:** `pnpm build && pnpm typecheck && pnpm test`; dọn ops project temp và dữ liệu sinh ra (giữ venv và cache mô hình ngoài repo).
- [ ] **Step 6: Commit** — `docs: studio media runbook with real GPU run results, ADR 102+, AGENTS/README, templates and go-live for sub-project 5A`.
- [ ] **Step 7:** Báo cáo: bảng DoD spec §8 (item → bằng chứng → trạng thái), điều để lại.

---

## Tự rà soát plan 5A

**Phủ spec:** §0 → toàn bộ; §1.1 → Task 1–9, 11; §1.2 cổng → Task 1, 2; §1.3 config → Task 1 (schema), 2 (composition), 8 (fixture), 11 (template); §1.4 → Task 1, 4; §1.5 kho + bảng → Task 1, 4; §2.1 collection + ingest thư mục → Task 7; §2.2 `media-index` → Task 3 (core), 8 (stage); §2.3 → Task 2 (engine), 3 (core), 8 (stage); §2.4 watch → Task 3, 8; §2.5 survey v2 + `survey-valid` → Task 1, 3; §3.1 hồ sơ giọng → Task 1, 4; §3.2 request/brief → Task 1, 4; §3.3 narration + `edl-valid` → Task 1, 5; §3.4 `media-tts` + cache + `tts-valid` → Task 2, 5, 8; §4.1 `fit-edl` → Task 6, 8; §4.2 timeline → Task 6; §4.3 workflow + profile → Task 8; §4.4 assemble mẫu → Task 8; §4.5 skill + agent giả → Task 8; §5 doctor/event/dashboard → Task 4 (giọng), 8 (event), 9; §6 lỗi → Task 2 (contract/transient, env), 3, 5, 6 (không fail), 7 (`no-source`); §7 test → mọi task + Task 10; §8 DoD → Task 10, 11; §9/§10 → Task 11.

**Nhất quán kiểu:** `MediaEngine`/`TranscribeJob`/`TtsJob`/`TtsRaw`/`EngineOutcome` (Task 1) dùng ở 2, 3, 5, 8, 9; `ShotsIndex`/`Transcript`/`Narration`/`NarrationTiming`/`FitReport`/`Timeline`/`VoiceProfile`/`SurveyIndexV2` (1) dùng ở 3, 4, 5, 6, 8, 10; `buildShots`/`indexSources`/`transcribeSources` (3), `splitSentences`/`synthesizeNarration`/`ttsCacheKey` (5), `fitEdl`/`buildTimeline`/`FIT` (6), `pickSources`/`matchCollection`/`ingestDirectory` (7), `addVoice`/`retireVoice`/`requireActiveVoice` (4) — tên giữ nguyên ở stage (8) và test (10); artifact type `shots`, `proxy_set`, `transcript`, `narration`, `voice_set`, `narration_timing`, `edl`, `fit_report`, `timeline`, `survey` khớp giữa workflow (8), stage (8), checker (3, 5), agent giả (8); script built-in `media-index|media-transcribe|media-tts|media-fit-edl` khớp composition và workflow; env test `FAKE_NARRATION_CHARS` (8, 10) nằm trong passthrough agent-cli.

**Điểm chú ý khi thực thi:**
- `schemaVersion("shots", 2)`: kiểm chữ ký helper trong `common.ts`; nếu chỉ sinh `/v1`, mở rộng helper (tham số thứ hai mặc định 1) thay vì viết chuỗi tay.
- `PythonMediaEngine` phải dùng `spawn` bất đồng bộ: `spawnSync` chặn event loop và heartbeat của worker trong nhiều phút.
- Test engine TS chạy script giả bằng Node qua option `python: process.execPath`; Node chạy được file đuôi `.py` chứa JavaScript khi truyền đường dẫn trực tiếp. Nếu Node từ chối phần mở rộng, thêm option test-only `scriptExt` thay vì đổi tên file thật.
- `media-tts` không có `when`: stage luôn chạy và thoát sớm khi không phải `tts`, vì `media-fit-edl` cần `narration_timing` ở mọi chế độ.
- `default_deadline_seconds: 14400` trong profile rev 3: xác nhận `overrides` của profile thật sự áp vào `limits.deadline_at` của stage request (đọc planner) — nếu không, đặt deadline qua `defaults` của workflow 1.2.0 và ghi report.
- Test SP4 đang gọi `pickSource` trực tiếp (nếu có) → giữ export `pickSource` như wrapper mỏng trả `pickSources(...)[0]` để không sửa test cũ.
- Task 11 cần mạng, GPU và ~15 GB đĩa; chạy ngoài CI; nếu driver CUDA của máy không khớp bánh xe torch 2.8, ghi rõ phiên bản đã dùng trong runbook.
