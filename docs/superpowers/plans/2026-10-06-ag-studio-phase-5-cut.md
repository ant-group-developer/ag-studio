# Plan pha 5: kiểu dựng "cắt theo shot"

Spec: `docs/superpowers/specs/2026-10-06-ag-studio-local-chat-design.md` (mục 3.3; bảng pha, dòng 5).
Mockup: https://claude.ai/artifact/N6YHc1yrBvqc1Fv6ab8xZL, màn 8 (Chọn cảnh) và màn 9 (Kế hoạch dựng).
Nhánh: `feat/local-phase-5-cut`, tách từ `feat/local-phase-3-render`. Mỗi task một commit, test viết trước.
Số dành riêng: migration `0022`–`0027`, ADR-0001 mục `151`–`160`.

**Xong khi** (bảng pha): một tập kiểu Arashiyama dựng từ footage ag-go, có chat ở bước chọn cảnh và kế hoạch dựng,
render 4K.

"Kiểu Arashiyama" trong plan này là: một tập du lịch đi bộ (footage quay dài, không người dẫn trên hình), cắt thành
nhiều shot ngắn, có lời dẫn đọc bằng giọng tổng hợp, chữ địa danh, nhạc nền, chuyển cảnh dissolve, 3840×2160. "Kiểu"
là cách dựng, không phải địa điểm: footage kiểm là folder **phố cổ Hoa Lư** trên ag-go local
(`01a0d146-a73c-767f-b934-9e18671f31bc`, xem Q12).

## Hiện trạng (đã kiểm trong code)

**Timeline v3 và những chỗ đọc nó:**
- `TimelineV3Schema` (`packages/contracts/src/studio.ts:477`) là strict, `schema_version` là literal
  `studio.timeline/v3`. Clip chỉ có `{clip_id, asset_id, section_title}`: không in/out, không chuyển cảnh, không lời
  dẫn. **Không chỗ nào rẽ nhánh theo `schema_version`.**
- v3 nằm trên đĩa ở ba chỗ: `episode_revisions.data`, file gate `timeline.json` (artifact `timeline_v3`), và
  `exports/<run>/timeline.json` trên R2 (`thumbnail-actions.ts:69` đọc lại bằng `TimelineV3Schema`).
- `layout.ts` (`packages/core/src/studio/layout.ts`): `layoutTimeline` xếp clip nối tiếp theo `assets[].duration_s`;
  `timelineIssues` có lỗi `duplicate_asset` (không trùng trong tập) và cảnh báo ±20 %. Web dùng chung qua alias
  `@studio/timeline` trỏ thẳng vào file này, nên file chỉ được import kiểu từ `@harness/contracts`.
- `build-timeline.ts` tự tính lại vị trí clip (trùng với `layoutTimeline`).
- `timelineToComposition` (`core/src/studio/render-plan.ts:26`) ghi `in: 0, out: duration`, `transition_out: cut`,
  `voice: "none"`, `captions: none`, `narration: []`. Cờ `music.ducking` bị bỏ qua.
- `CompositionSchema` (`contracts/src/composition.ts:155`) **đã có đủ** những gì v4 cần: `segments[].in/out`,
  `transition_out {cut|dissolve|dip_black, seconds, tail_available}`, `narration[] {line_id, wav, start, end}`,
  `captions {mode, cues}`, `voice: none|tts|original`.
- `renderComposition` đã dựng đuôi dissolve (ADR mục 118), đọc `narration[].wav`, mezzanine khoá theo in/out.
- Render worker (`E:\CODE\ag-render-worker`):
  - đã gom input `stage:` của `narration[].wav` (`composition-utils.ts:103`);
  - đã kẹp `seg.out` về thời lượng thật;
  - vẽ phụ đề bằng `studioOverlayAss`, có `burn-in` và `karaoke`.
  - Nên **bản cuối có trim, dissolve, lời dẫn không cần sửa render worker**.
- Xuất Premiere thì chưa đúng với trim: `premiere-xml.ts:111` luôn ghi `in=0`. Đó là việc pha 4.
- Bẫy so sánh: `renderRestartFrom` (`run-control.ts:320`) so revision đã parse với file đã duyệt bằng
  `isDeepStrictEqual`. Nếu lúc đọc nâng v3 lên v4 trong bộ nhớ thì hai bên không bao giờ bằng nhau.
- Web editor:
  - `TimelineView.tsx` vẽ độ rộng clip theo `duration`, vị trí theo thứ tự flex;
  - `Player.tsx:148` seek bằng `t - clip.start`, chưa cộng `in`;
  - chưa có UI trim.

**Workflow, kế hoạch tập:**
- `STUDIO_WORKFLOW_IDS = ["ag-studio-series-plan", "ag-studio-episode"]` (`core.ts:92`) khớp đúng id.
  `ag-studio-episode-cut` chưa nằm trong `studioWorkflowRefs`, nên:
  - `cancelLegacyRuns` sẽ huỷ run của nó lúc worker khởi động;
  - `workflow-wiring.test.ts` không kiểm nó.
- Chọn workflow tập chỉ theo phiên bản plan: `episodeWorkflowForPlan(planVersion)` (`run-control.ts:72`), không theo
  từng tập. `PlannedEpisodeSchema` là strict, chưa có trường kiểu dựng.
- Run tập không nhận input hay option; `episode-intake` đọc `episodes.plan` (JSON `studio.episode/v1`).
- Các hằng `render-final`, `freeze-timeline`, `approve-timeline`, `approve-youtube-kit`, `export` gắn cứng trong
  `run-control.ts:58-63` và được nhiều chỗ dùng. Workflow mới **giữ đúng các key này** để mọi thứ đó chạy nguyên.
- `studioResources()` chỉ có `claude`, `farm`, `cpu`. Stage khai tài nguyên lạ thì không bao giờ được claim.

**Pipeline media của harness:**
- Mọi hàm lõi còn trong `@harness/core` và đã export:
  - `indexSources`, `watchVideos`, `transcribeSources`;
  - `fitEdl`, `buildTimeline`, `buildCaptionCues`, `assignTransitions`, `buildComposition`, `renderComposition`.
- Lệnh built-in `harness media …` thì **không** dùng lại được. Chúng chạy như tiến trình con của CLI harness, cần
  `project.yaml` của ops project và kho (brand/nhạc/giọng), và worker Studio không đăng ký chúng.
- Muốn dùng lại thì gọi hàm lõi từ `InProcessStage` mới.
- `indexSources` luôn encode lại một proxy. `transcribeSources`/`synthesizeNarration` cần một `MediaEngine`
  (`PythonMediaEngine` ở `packages/adapters/media-python`).
- Checker `edl-valid`/`survey-valid` đọc `request.source_items`. Run Studio không có content nên `source_items = []`,
  tức dùng nguyên thì luôn fail: cần bản Studio.
- Skill `source-survey`/`edit-plan` của harness là **file mode** (agent đọc ảnh contact sheet bằng tool, ghi nhiều
  file). Studio chỉ chạy structured (`--tools ""`, `--no-session-persistence`).
  - `CliAgentRuntime` vẫn có file mode.
  - Không chỗ nào dùng `--resume`.
- Image Docker của Studio có ffmpeg/ffprobe, không có Python, không GPU. Máy dev không có ffmpeg trên PATH
  (`STUDIO_FFMPEG_PATH` trỏ ffmpeg-static của render worker); không có `STUDIO_FFPROBE_PATH`.

**ag-farm, ag-go, render worker** (chỉ đọc):
- Registry farm đóng ở ba lớp: enum `JOB_TYPES`, `allowed_types` của owner trong DB, schema payload. Không có job
  nhận dạng giọng nói.
- `studio.tts` đã có. Payload là `voice{reference, reference_text, speed}`, `lines[{line_id L\d{3}, text}]` và
  `align_words`; manifest `tts.json` có `words[]`. Base requirements `{gpu, python}`.
- **Hiện không máy nào nhận được job `studio.tts`:**
  - render worker không bật `detectPythonTorch` (`ag-render-worker/src/main.ts:54`), nên `engines.python = null` và
    hub từ chối claim;
  - phép dò của worker-sdk chạy `python` trên PATH, không theo `extra.python_bin`;
  - `E:\ag-local\dev-run\render.yaml` không khai `studio.tts`.
- Venv `E:\ag-local\venv` của máy dev có torch 2.8 cu126, whisperx 3.7.4, omnivoice 0.2.1.
- ag-go `POST /footage/assets/resolve`:
  - `purpose=preview` cho proxy 720p do scan worker làm khi người dùng được xem gốc, không thì bản preview có watermark;
  - `final` cho file gốc.
  - ag-go không lưu shot, segment hay transcript. Chỉ có mô tả AI cả video và cờ `has_speech`, suy từ tỉ lệ im lặng.
- Render worker link `@harness/core`, `@ag-studio/render` tới `E:\CODE\ag-studio` (checkout chính), **không** tới
  worktree này.

## Quyết định cần bạn duyệt

Plan viết theo cột "Đề xuất". Q1 và Q13 bạn đã chốt (2026-10-06): **Q1 = (a)**, **Q13 = cho phép cả ba**.

| # | Vấn đề | Đề xuất | Lý do |
|---|---|---|---|
| Q1 | Nhận dạng giọng nói | **Đã chốt: (a) job farm mới `studio.transcribe`** (đổi hợp đồng ag-farm, bạn đã cho phép). Hai phương án ở mục ngay sau bảng; việc ngoài repo ở nhóm T. | |
| Q2 | v3 trên đĩa | **Không bao giờ ghi lại v3 thành v4.** Đọc thì luôn ra v4 (`readTimeline`), ghi thì giữ phiên bản gốc của tập: tập 1.2.0/1.3.0 vẫn lưu v3 (hạ v4→v3, ném lỗi nếu mất dữ liệu), tập cắt theo shot lưu v4. | Artifact `timeline_v3`, checker, digest của run cũ giữ nguyên byte. Bẫy `isDeepStrictEqual` được tránh bằng cách so JSON thô với JSON thô. |
| Q3 | Kiểu dựng theo tập | Thêm vào `PlannedEpisodeSchema` hai trường tuỳ chọn: `edit_style: whole \| cut` (vắng = `whole`) và `narration: none \| tts \| original`. Plan mới `ag-studio-series-plan@3.1.0` chỉ khác 3.0.0 ở `spawn-episodes` (`studio-spawn-episodes-v2`). Tập `cut` chạy `ag-studio-episode-cut@1.0.0`; tập `whole` vẫn `ag-studio-episode@1.3.0`. | Khoá vắng mặt giữ hợp lệ cho plan cũ (ADR mục 126). Plan 3.0.0 vẫn sinh mọi tập 1.3.0, kể cả khi Claude có ghi `cut`. |
| Q4 | Shot lưu ở đâu | Studio tự dò shot cho từng tập trên proxy 720p, lưu trong artifact của run. **Không ghi về ag-go**, không đổi hợp đồng ag-go. | Đảo D10 chỉ trong Studio. ag-go vẫn theo video. |
| Q5 | Stage chọn cảnh | `source-survey` chạy **file mode** (đọc contact sheet), lưu session. Chat ở gate `approve-survey` chạy `claude --resume <session> --fork-session` trong workspace của stage. Mất session thì lùi về chat structured chỉ có chữ. | Spec mục 3.1, dòng cuối. Claude cần nhớ các khung đã xem để trả lời "loại các shot có xe máy". |
| Q6 | Stage kế hoạch dựng | `plan-edit` chạy **structured**, như mọi stage Studio khác. Đầu vào là bản chọn cảnh đã duyệt (điểm, tag, ghi chú từng shot), shot, transcript, mô tả AI. Không xem ảnh. Chat ở `approve-edit-plan` đi đúng đường gate sẵn có. | Thông tin hình đã nằm trong bản chọn cảnh. Không cần file mode thứ hai. |
| Q7 | Xem trước 720p có giọng ở màn 9 | **Không làm ở gate kế hoạch dựng.** Cột phải hiện bảng shot (vào–ra, dài), lời dẫn, chữ; đổi so với bản trước tô màu. Xem trước có giọng có ở gate `approve-timeline` kế tiếp (xem trước 720p sẵn có). | Có giọng tức phải chạy TTS + khớp hình + render mỗi lần sửa. Ghi deferred. |
| Q8 | Bước compose | Không có stage `media-compose`. `timelineToComposition(v4)` tự sinh `narration[]`, phụ đề (`buildCaptionCues`), chuyển cảnh (đuôi dissolve, hạ cấp) từ timeline v4. | Người còn sửa timeline sau khi khớp hình. Composition phải luôn suy từ revision, như bây giờ. |
| Q9 | Tiếng gốc khi có lời dẫn | Giữ hành vi của `renderComposition`: `voice: tts` tắt tiếng gốc, chỉ còn lời + nhạc. `voice: none` giữ tiếng gốc −12 dB. | Muốn tiếng môi trường dưới lời dẫn thì phải đổi `audio-graph.ts`, tức đổi code render worker đang dùng. Ghi deferred. |
| Q10 | Giọng đọc | `productionVoice` sẵn có: giọng của production, không có thì `STUDIO_DEFAULT_VOICE_REFERENCE`/`_TEXT` (file `library:voices/…` trên R2). Chỉ dùng giọng tổng hợp hoặc có quyền (ADR mục 105). | Đã có; không thêm hồ sơ giọng. |
| Q11 | Xuất Premiere với tập cắt theo shot | Tắt cho đến pha 4. Có clip `in ≠ 0`, `out ≠ null` hoặc có lời dẫn thì `POST …/exports/premiere` trả 422 `premiere_needs_phase_4`, menu ⋯ ẩn mục này. | `premiere-xml.ts` bỏ qua in-point và không có track lời dẫn. |
| Q12 | Kiểm "Xong khi" | Trên stack local, Claude thật, footage folder phố cổ Hoa Lư (`01a0d146-a73c-767f-b934-9e18671f31bc`), tập 3–5 phút. Cần **chuyển checkout chính `E:\CODE\ag-studio` sang nhánh này** (render worker link vào đó): hỏi bạn trước bước E3. | Render 4K bằng CPU trên Quadro P1000 với footage thật chậm. 10 phút có thể mất hàng giờ. |
| Q13 | TTS trên máy dev | Sửa để render worker nhận được `studio.tts`. Ba việc ngoài repo này: (1) `ag-render-worker/src/main.ts` bật `capabilitiesOptions.detectPythonTorch` và truyền `python_bin`; (2) worker-sdk của ag-farm dò Python theo đường dẫn được truyền (đổi **code** ag-farm, không đổi giao thức); (3) `render.yaml` local thêm `studio.tts` + `python_bin`. **Đã cho phép** (nhóm T). | Không có thì không tập nào có lời dẫn. Việc này cần với cả hai phương án Q1. |
| Q14 | Phụ đề | Mặc định `burn-in` khi có lời dẫn, `none` khi không. Đổi qua chat timeline (`setCaptions`). | `studioOverlayAss` đã vẽ được `burn-in`/`karaoke`. Font Arial hệ thống như hiện nay. |

## Nhận dạng giọng nói: hai phương án (chọn ở Q1)

Transcript dùng cho ba việc:
- bản chọn cảnh biết shot nào có người nói (`speech: talking|ambient|none`);
- `fitEdl` hít điểm cắt về ranh giới câu khi `narration = original`, và không cắt giữa câu khi `none`;
- kế hoạch dựng tránh đặt lời dẫn đè lên tiếng nói.

Footage không có tiếng nói (`has_audio = false` hoặc `has_speech = false` từ ag-go) thì bỏ qua. Stage nào cũng ghi
`harness.transcript/v1` với `segments: []`.

### (a) Job farm mới `studio.transcribe`: đổi hợp đồng ag-farm

- **ag-farm:**
  - `packages/protocol`:
    - thêm `studio.transcribe` vào `JOB_TYPES`;
    - `StudioTranscribePayloadSchema { production_id, model, language|null, sources[{ source_id, audio: InputName }] }`,
      audio là wav 16 kHz mono do Studio tách sẵn (`stage:audio/<id>.wav`), nhẹ hơn nhiều so với để máy farm tải file
      gốc 4K;
    - `TranscribeManifestSchema` `ag.studio.transcribe/v1`, file `transcript.json` theo đúng `harness.transcript/v1`;
    - entry registry: slot `gpu`, lane `interactive`, base `{ gpu: true, python: true }`.
  - `apps/api`: migration thêm loại job vào `farm_owners.allowed_types` của owner `studio`.
  - `apps/web`: danh sách loại job và nhãn i18n.
  - `enroll.ts` `ROLE_KINDS.render`, `docs/protocol.md`.
- **ag-render-worker:** `transcribe-handler.ts` và bản sao `engines/python/transcribe.py` của Studio (chạy trong venv
  sẵn có, đúng giao thức job/result của ADR mục 102); khai kind trong config.
- **Studio:**
  - `FarmExecutor` thêm nhánh kiểm payload và tải `transcript.json`;
  - payload builder `studio-cut-transcribe` tách wav trong worker Studio rồi gửi `extraUploads`;
  - test hợp đồng: payload qua `StudioTranscribePayloadSchema` của `@ag-farm/protocol`.
- **Được:**
  - đúng spec 3.3 và 3.4 ("mọi bước GPU đi qua farm");
  - image Studio vẫn gọn;
  - chạy được ở dev/prod như render;
  - chọn máy GPU theo requirements sẵn có.
- **Mất:**
  - ba repo, một migration hub, deploy lại farm dev/prod;
  - test E2E farm phải cập nhật;
  - ag-go không bị ảnh hưởng.

### (b) Chạy trong worker Studio: không đổi hợp đồng nào

- **Studio:**
  - stage in-process `studio-cut-transcribe` gọi `transcribeSources` với `PythonMediaEngine`
    (`@harness/adapter-media-python`);
  - đường Python lấy từ env mới `STUDIO_MEDIA_PYTHON`, model/thiết bị từ `STUDIO_TRANSCRIBE_MODEL` (mặc định
    `medium`), `STUDIO_TRANSCRIBE_DEVICE` (`cuda:0` nếu có, không thì `cpu` + `int8`);
  - tài nguyên mới `asr: 1` trong `studioResources()`.
- **Thiếu Python** (image Docker hiện nay): stage ghi transcript rỗng kèm `warnings: ["transcribe_unavailable"]`,
  tập vẫn dựng. Cắt mù tiếng nói, giống hệt khi footage không có tiếng.
- **Được:**
  - không đụng ag-farm hay render worker;
  - làm nhanh;
  - máy dev có sẵn venv.
- **Mất:**
  - máy chạy worker Studio phải có Python + torch (~7 GB) và GPU mới nhanh; prod chạy trong Docker không GPU nên
    thực tế là không có transcript, hoặc whisper CPU rất chậm;
  - đi ngược spec 3.4;
  - Quadro P1000 (4 GB) chạy `large-v3` float16 sát giới hạn VRAM.

**Đã chọn (a).** Lý do:
- Đường GPU của Studio đã là farm (render, TTS).
- Q13 đằng nào cũng phải sửa phép dò Python của worker. Sửa xong thì transcribe trên farm chỉ thêm một handler và một
  loại job.

Phương án (b) giữ lại ở đây để ADR mục 154 ghi lý do bị loại.

---

## Nhóm T: việc ngoài repo này (đã được cho phép)

Mỗi repo một nhánh `feat/studio-phase-5-cut` tách từ nhánh đang dùng, mỗi task một commit, **không push**. Không in
giá trị `.env`.

### T1. ag-farm: loại job `studio.transcribe` (đổi hợp đồng)

- `packages/protocol`:
  - `common.ts` thêm vào `JOB_TYPES`;
  - `jobs/studio.ts` thêm `StudioTranscribePayloadSchema`, `TranscribeManifestSchema` (mục (a) ở trên);
  - `registry.ts` thêm entry (slot `gpu`, lane `interactive`, base `{ gpu: true, python: true }`);
  - `enroll.ts` `ROLE_KINDS.render` thêm `studio.transcribe` và `studio.export_premiere` (đang thiếu).
- `apps/api`: migration thêm `studio.transcribe` vào `farm_owners.allowed_types` của owner `studio`, theo mẫu
  `1400000000000-studio-export-premiere.ts`.
- `apps/web`: `types/api.ts` và nhãn i18n.
- `docs/protocol.md`: bảng loại job (thêm cả `export_premiere`).

**Test:** schema nhận payload mẫu, từ chối `source_id` sai dạng; registry đủ entry (lỗi biên dịch nếu thiếu);
migration chạy được trên Postgres test của e2e.

### T2. ag-farm worker-sdk: dò Python theo đường dẫn

- `detectCapabilities({ detectPythonTorch, pythonBin })`: có `pythonBin` thì chạy đúng file đó `-c "import torch"`,
  không có thì như cũ (`python`/`python3` trên PATH).
- Không đổi `CapabilitiesSchema`.

**Test:** `pythonBin` trỏ file không tồn tại → `python: null`; spawn giả trả version → `engines.python` có giá trị.

### T3. ag-render-worker: nhận TTS và transcribe

- `src/main.ts` truyền `capabilitiesOptions: { detectPythonTorch: true, pythonBin: extra.python_bin }`.
- `src/transcribe-handler.ts`: tải wav (`stage:`), chạy `engines/python/transcribe.py` (bản sao từ Studio, giữ giao
  thức job/result của ADR mục 102), tải lên `transcript.json`. Lỗi `contract` của engine thành job `failed` không
  retry.
- `deploy/config.example.yaml`: thêm `studio.transcribe`, `studio.export_premiere`.
- Rebuild link tới ag-farm (`yarn build`).

**Test:** handler với engine giả (python-runner mock), manifest qua `TranscribeManifestSchema`; capability có
`python` khi `python_bin` hợp lệ.

### T4. Cấu hình máy dev

- `E:\ag-local\dev-run\render.yaml`: thêm kind `studio.tts`, `studio.transcribe`, `extra.python_bin` trỏ
  `E:\ag-local\venv\Scripts\python.exe`.
- Chạy migration hub (lệnh tay ở `studio-local.md` mục 3). Kiểm trên web farm 3011: node khai `python`.
- Không có test tự động. Ghi vào runbook.

---

## Hợp đồng timeline v4 (ghi vào `packages/contracts/src/studio.ts` và ADR mục 151)

```ts
TimelineV4Schema = z.object({
  schema_version: "studio.timeline/v4",
  production_id, episode_id, canvas, fps, language,          // như v3
  edit_style: z.enum(["whole", "cut"]),
  clips: z.array(z.object({
    clip_id,  asset_id,  section_title,                      // như v3
    in: z.number().min(0),                                   // giây trên asset
    out: z.number().positive().nullable(),                   // null = tới hết asset
    shot_id: z.string().regex(/^s\d{3}-\d{3}$/).nullable(),  // shot trong bản chọn cảnh, để truy lại
    line_id: z.string().regex(/^L\d{3}$/).nullable(),        // dòng lời dẫn BẮT ĐẦU ở clip này
    transition_out: z.object({ kind: z.enum(["cut", "dissolve", "dip_black"]), seconds: z.number().min(0).max(1) }).strict(),
  }).strict()),
  texts,                                                     // như v3 (start tuyệt đối trên trục)
  narration: z.object({
    voice: z.enum(["none", "tts", "original"]),
    lead_seconds: z.number().min(0).max(2),                  // lời bắt đầu sau đầu clip neo (mặc định 0.3)
    lines: z.array(z.object({
      line_id, text: z.string().min(1).max(1200),
      audio: z.object({ key: sha256hex, duration_s, words: [{ word, start, end }] }).strict().nullable(),
    }).strict()),
  }).strict(),
  captions: z.object({ mode: z.enum(["none", "burn-in", "karaoke"]) }).strict(),
  music, source_audio, assets, alternates,                   // như v3
}).strict();
```

**Quy tắc:**
- **Độ dài clip** = `(out ?? assets[asset_id].duration_s) − in`. Clip nối tiếp, `start` của clip sau = `end` của
  clip trước.
- **Chuyển cảnh không bao giờ dời mốc** (ADR mục 118):
  - `dissolve` lấy đuôi `out → out + seconds` của chính asset đó;
  - không có đuôi, hoặc clip sau ngắn hơn `2 × seconds`, thì composition hạ về `cut` và ghi vào
    `transitions.downgraded`.
- **Lời dẫn:**
  - `line_id` xuất hiện ở tối đa một clip;
  - lời bắt đầu ở `clip.start + lead_seconds`, dài `audio.duration_s`;
  - `words[].start/end` tính từ đầu dòng;
  - wav nằm ở kho nội dung `<STUDIO_DATA_ROOT>/voice/<key>.wav`; render gửi lên farm là `stage:voice/<line_id>.wav`.

**v3 đọc thành v4** (`upgradeTimelineV3`, thuần, trong contracts):
- `edit_style: "whole"`;
- mỗi clip `in: 0, out: null, shot_id: null, line_id: null, transition_out: { kind: "cut", seconds: 0 }`;
- `narration: { voice: "none", lead_seconds: 0.3, lines: [] }`, `captions: { mode: "none" }`.

**v4 ghi lại thành v3** (`downgradeTimelineV4`) chỉ khi không mất gì. Mất gì thì ném `TimelineOpError("not_v3")`.

**Hợp đồng cho pha 4 và pha 6:** cả hai đọc `harness.composition/v1` do `timelineToComposition(v4)` sinh ra:
- `segments[].in/out` là giây trên **file nguồn**;
- `transition_out` đã giải `tail_available`;
- `narration[].wav` là input `stage:voice/<line_id>.wav` với `start/end` trên trục;
- `captions.cues` và `text_events` đã có mốc.

Comment đầu `TimelineV4Schema` ghi đúng các dòng này.

---

## Nhóm A: timeline v4

### A1. Schema v4, nâng và hạ phiên bản

- `packages/contracts/src/studio.ts`:
  - `TimelineV4Schema` và kiểu `TimelineV4`, `TimelineClipV4`;
  - `AnyTimelineSchema = union(V3, V4)`, `readTimeline(raw): TimelineV4`, `upgradeTimelineV3`, `downgradeTimelineV4`,
    `timelineVersion(raw)`;
  - `TimelineClip`/`TimelineText` cũ giữ nguyên tên cho code v3.
- `pnpm gen:schemas`: thêm `studio-timeline-v4`.
- Xoá bốn file schema cũ không còn nguồn: `studio-timeline-v2.json`, `studio-narration.json`, `studio-selection.json`,
  `studio-treatment.json`.

**Test:**
- v3 hợp lệ nâng lên v4 rồi hạ lại ra đúng từng byte;
- v4 có trim, dissolve hoặc lời dẫn thì hạ phiên bản ném `not_v3`;
- schema từ chối `line_id` sai dạng, `out ≤ in`, `seconds > 1`;
- JSON schema sinh ra khớp.

### A2. `layout.ts` theo v4

- `layoutTimeline(t: TimelineV4)`:
  - độ dài clip theo quy tắc trên, `LaidClip` thêm `in`, `out` (đã giải);
  - thêm `lines: LaidLine[] { line_id, start, end, clip_id }`.
- `timelineIssues`:
  - kiểu `whole` giữ đúng luật v3, gồm `duplicate_asset`;
  - kiểu `cut`, lỗi:
    - `bad_range` (`in ≥ out` hoặc `out > duration + 0.05`);
    - `clip_too_short` (< 0.5 s);
    - `unknown_line`, `duplicate_line`;
    - `line_without_audio` (khi `voice = tts`);
  - kiểu `cut`, cảnh báo:
    - `overlapping_range` (cùng asset, hai khoảng chồng nhau);
    - `narration_overrun` (dòng kéo qua đầu dòng sau hoặc quá cuối tập);
    - `transition_no_tail`;
  - ±20 % như cũ.
- Thao tác mới:
  - `trimClip(t, clip_id, in, out)`;
  - `setTransition(t, clip_id, kind, seconds)`;
  - `setCaptions(t, mode)`.
- Thao tác cũ:
  - `addClip` (`in 0, out null`);
  - `replaceClipAsset` (kiểu `cut`: giữ độ dài cũ, `in = 0`, `out = min(độ dài cũ, duration)`, bỏ `shot_id`);
  - `removeClip` (bỏ `line_id` đi kèm, dòng lời chuyển sang clip kế tiếp nếu clip đó chưa neo dòng nào, không thì cảnh
    báo).
- `applyTimelineOps` nhận v4.
- `TimelineOp` (`studio-chat.ts`) thêm `trimClip`, `setTransition`, `setCaptions`.
- `build-timeline.ts` dùng `layoutTimeline` thay cho con trỏ tự tính.

**Test:**
- mọi test hiện có của `timeline.test.ts`/`timeline-ops.test.ts` chạy qua `readTimeline` ra đúng kết quả cũ;
- mỗi lỗi/cảnh báo mới có một test;
- trim làm dời `start` các clip sau;
- `removeClip` chuyển `line_id`.

### A3. `timelineToComposition` theo v4

- `segments[].in/out` từ clip; `out` null thì lấy `duration_s` (như v3).
- Chuyển cảnh:
  - giải `tail_available` theo `assets[].duration_s`;
  - hạ cấp ghi `transitions.downgraded` (`no_tail` / `next_too_short`);
  - clip cuối luôn `cut`.
- `voice` = `narration.voice`;
- `narration[]` từ `layout.lines`, `wav: "stage:voice/<line_id>.wav"`.
- `captions` từ `buildCaptionCues` (`core/src/media/captions.ts`) với từ đã đổi sang mốc tuyệt đối, 42 ký tự × 2 dòng.
- Nhạc:
  - `music.ducking = true` và có lời dẫn thì `duck.windows` theo `duckWindows`;
  - không thì như cũ.

**Test (quan trọng nhất của nhóm):**
- snapshot: mọi timeline v3 trong fixture cho composition **giống từng byte** trước và sau khi đổi;
- v4: dissolve có đuôi, hạ cấp khi sát mép, mốc `start/end` không đổi khi đổi `cut`↔`dissolve`;
- narration và cue đúng mốc;
- composition qua `CompositionSchema`;
- `studioOverlayAss` sinh đúng số `Dialogue:`.

### A4. Những chỗ đọc timeline

Tất cả đọc bằng `readTimeline`; nơi ghi giữ phiên bản gốc (Q2):
- `studio-db.ts`:
  - `latestEpisodeRevision`/`getEpisodeRevision` trả `{ data: TimelineV4, stored: "v3" | "v4" }`;
  - `saveEpisodeRevision(…, v4)` ghi theo phiên bản của revision 1 của tập.
- Checker:
  - `timeline-schema-valid`, `timeline-valid` nhận cả hai;
  - `studio-render-valid` dùng layout v4.
  - Id checker không đổi nên digest stage cũ không đổi.
- `studio-freeze-timeline-v2`, `studio-episode-thumbnails`, `studio-episode-export-v2`, `thumbnail-actions.ts`,
  `editor.ts`, `llm-log.ts`, `chapters.ts`, `thumbnails.ts`:
  - đọc input `timeline_v3` **hoặc** `timeline_v4`;
  - đầu ra với input v3 không đổi (test snapshot), nên giữ tên script (ADR mục 141).
- `renderRestartFrom` so JSON thô của revision mới nhất với JSON thô của file gate.
- `chat-context.ts` `timelineContext`: prompt có `in/out/line_id/transition_out` khi `edit_style = cut`; dòng đầu
  "Clip ghép nguyên video, không cắt" chỉ còn cho kiểu `whole`.
- `skills/studio-timeline/SKILL.md` thêm phần kiểu cắt theo shot và ba thao tác mới.

**Test:**
- tập 1.3.0 sửa qua chat vẫn lưu `studio.timeline/v3`;
- tập v4 lưu v4;
- `rerender` với timeline v3 không đổi vẫn ra `from = render-final` (bẫy so sánh);
- export và thumbnail của tập v3 không đổi so với snapshot;
- `series-flow.e2e` vẫn thấy v3.

---

## Nhóm B: media trong worker Studio

Mọi stage dưới đây là `InProcessStage` trong `packages/studio-engine/src/cut-stages.ts`, gọi hàm lõi của
`@harness/core`. ffmpeg/ffprobe theo `STUDIO_FFMPEG_PATH` và env mới `STUDIO_FFPROBE_PATH` (mặc định cạnh ffmpeg),
truyền xuống bằng tham số, không qua `FFMPEG_PATH`.

### B1. `studio-cut-intake`

- Đầu ra như `studio-episode-intake-v2`: `brief.json`, `episode.json`, `branding.json?`, `trend-report.json`.
- Thêm `sources.json` (`studio.cut-sources/v1`). Mỗi asset của tập:
  - `asset_id`, `source_id = src_<stableUlid(asset)>`;
  - `title`, `duration_s`, `has_audio`, `has_speech`;
  - `hints`: mô tả AI của ag-go, gồm `summaryVi`, `subjects`, `places`, `visibleText`, `peopleCount`, `hasWatermark`.
- Lấy từ `episode.assets[].hints` do `studio-spawn-episodes-v2` chụp (C3).

**Test:** đúng id nguồn; asset thiếu mô tả vẫn có dòng, `hints: null`.

### B2. `studio-cut-proxies` (tải proxy 720p)

- `resolveAssets(owner, { assetIds, purpose: "preview" })` rồi tải từng file vào `output/proxies/<source_id>.mp4`
  (artifact thư mục `proxy_set`), tối đa 3 file song song.
- Asset nằm trong `missing` thì là lỗi `contract`, nêu tên asset.
- `requires_resources: [cpu]`, retry 3.
- `packages/ag-go-client`: kiểu trả về của `resolveAssets` thêm `durationMs`, `missing`.
- Xoá luôn `getSegmentMedia`/`resolveSegments` (nợ dọn dẹp).

**Test:** client ag-go giả; file tải đủ; `missing` → lỗi `contract`; URL hết hạn (403) → `transient`.

### B3. Shot và transcript

**`studio-media-index`:**
- `indexSources` trên proxy với `scene` mặc định của harness (0.30, 1–20 s);
- thêm tuỳ chọn `encodeProxy: false` vào `indexSources` (core): proxy đã là 720p nên không encode lại;
- đầu ra `shots.json` (`harness.shots/v2`).

**`transcribe`** (Q1 = (a)): stage farm `studio.transcribe`, payload builder `studio-cut-transcribe`:
- tách wav 16 kHz mono trong worker Studio cho nguồn `has_audio && has_speech !== false`, gửi bằng `extraUploads`;
- không còn nguồn nào thì builder trả `skip` (B5) với transcript rỗng;
- `FarmExecutor` thêm nhánh kiểm payload (`StudioTranscribePayloadSchema`) và tải `transcript.json`.

**Test:**
- clip tổng hợp bằng ffmpeg (lavfi, ba cảnh màu) cho đúng ba shot;
- không encode proxy lần hai;
- payload qua schema farm của `@ag-farm/protocol`; nguồn không có tiếng không được gửi; `fakeFarm` trả transcript;
- test cần ffmpeg thì tìm theo `STUDIO_FFMPEG_PATH` rồi PATH, không có thì skip như test media hiện có.

### B4. `studio-watch-source`

- `watchVideos` mode `source` có `shot_marks` từ shots, `max_sheets` 24.
- Đầu ra thư mục `watch` (ảnh + `watch.json`).
- Mỗi shot một khung giữa shot, đẩy lên R2 `productions/<p>/episodes/<e>/shots/<shot_id>.png` cho lưới shot trên web.
  Chỉ trả URL cho người qua `FootageAccessService.coversProduction`.

**Test:** số khung bằng số shot; key R2 đúng; sheet được tạo khi không có font (nhánh không nhãn sẵn có).

### B5. `FarmExecutor` bỏ qua job khi không có gì để gửi

- Payload builder được trả `{ skip: { files: Record<name, Buffer> } }`.
- Executor ghi các file đó vào `output/` rồi trả thành công, không gửi job.
- `version` lên `0.5.0`.
- Dùng cho TTS (hết dòng cần đọc) và transcribe (a).

**Test:** `skip` không gọi farm; output đủ; các builder cũ không đổi.

---

## Nhóm C: Claude

### C1. Agent file mode có session

- `StudioAgentExecutor` nhận thêm `fileSkills: Set<StudioFileSkill>`. Skill trong tập này chạy
  `CliAgentRuntime` file mode:
  - tool `Read,Write,Glob,Grep`, không Bash, không mạng;
  - `--max-turns 40`, **không** `--no-session-persistence`;
  - `cwd` là workspace của attempt.
- `session_id` lấy từ JSON đầu ra, lưu vào bảng mới.
- Output (`output/survey.json`) kiểm bằng validator của skill. Sai thì **một** vòng sửa bằng `--resume <session>`,
  vẫn sai thì `contract`.
- Hết hạn mức xử lý như structured. Ghi `llm_calls` như cũ, payload là prompt + câu trả lời cuối.
- Migration `0022_agent_sessions.sql`:
  - bảng `studio_agent_sessions(run_id, stage_key, attempt_id, session_id, cwd, created_at, PRIMARY KEY (run_id,
    stage_key))`, ghi đè ở lần chạy lại;
  - `stage_chat_turns` thêm cột `session_id`.
- Env con giữ danh sách trắng; `CLAUDE_CONFIG_DIR` có sẵn nên session nằm cạnh cấu hình Claude của worker.

**Test (Claude giả):**
- `fixtures/fake-studio-claude.mjs` thêm file mode: đọc `agent-prompt.md`, ghi `output/survey.json`, in `session_id`;
  thêm `--resume`: ghi nhận session id vào log;
- session được lưu;
- vòng sửa đi qua `--resume`;
- env con không có `HARNESS_SECRET_*`;
- danh sách tool đúng.

### C2. Skill và validator

**`skills/studio-source-survey/SKILL.md`** (từ `skills/source-survey`, viết lại cho Studio):
- đọc `watch/`, `shots.json`, `transcript.json`, `sources.json` (mô tả AI là **gợi ý**, ag-go không có dữ liệu theo
  shot);
- mỗi shot đúng một dòng `{source_id, shot_id, in, out, score 0–5, tags, usable, note, speech}`;
- lý do loại theo mockup màn 8: mặt người lạ rõ, rung, chữ quảng cáo, quá tối, trùng;
- ngân sách ảnh: tối đa 20 khung lẻ, sheet theo `max_sheets`.
- Đầu ra `survey.json` = `harness.survey-index/v2`.

**`validateStudioSurvey(raw, { shots, sources })`:**
- đúng một dòng mỗi shot;
- `in/out` khớp shot ±0.05 s;
- `source_id` có trong `sources.json`;
- ít nhất một shot `usable`.
- Checker `studio-survey-valid`.

**`skills/studio-edit-plan/SKILL.md`** (từ `skills/edit-plan`): đầu ra một tài liệu `studio.edit-plan/v1`:

```ts
{ schema_version, episode_id, narration: "none"|"tts"|"original", language, target_seconds,
  shots: [{ order, shot_id, source_id, in, out, line_id|null, transition: "cut"|"dissolve", section_title|null, note }],
  lines: [{ line_id, text }],
  texts: [{ text_id, kind, text, at_order, offset_s, duration, position }],
  music_mood: string|null }
```

**`validateEditPlan(raw, { survey, shots, transcript, episode })`:**
- Lỗi:
  - shot phải `usable` trong bản chọn cảnh **đã duyệt**;
  - `in/out` nằm trong shot đó, `out − in ≥ 0.5`;
  - `order` 1..n;
  - `line_id` duy nhất, mỗi dòng neo tối đa một shot;
  - `at_order` tồn tại; ≤ 1 `title` mỗi shot;
  - ngân sách chữ `overlayDensityLimit`.
- Cảnh báo:
  - dòng dài hơn hình từ shot neo tới dòng sau (14 ký tự/s tiếng Việt, 15 tiếng Anh);
  - tổng `max(Σ(out − in), lời / cps)` lệch mục tiêu > 20 %.
- Checker `edit-plan-valid`.
- `STUDIO_SKILL_OUTPUTS`, `STUDIO_SKILL_STEP`, `TEAM_SKILL_STEPS`, `VALIDATORS`, `models.ts`:
  - `studio-edit-plan` (Opus, vì là bước quyết định nhịp dựng);
  - `studio-source-survey` (Sonnet, xem ảnh).
- `fake-studio-claude.mjs`: hai skill mới sinh dữ liệu hợp lệ từ input, và một nhánh "bad" cho vòng sửa.

**Test:** mỗi luật validator một test; fake Claude qua validator; JSON schema cho Claude không có `record`.

### C3. Kế hoạch tập chọn kiểu dựng

- `PlannedEpisodeSchema` thêm `edit_style?` và `narration?` (khoá vắng mặt). `StudioEpisodeSchema` thêm
  `assets[].hints?`.
- `validateSeriesPlan`, tập `cut`:
  - bỏ cảnh báo ±20 % theo tổng `duration_s`;
  - thay bằng cảnh báo `pool_too_short` khi tổng nguồn < 1.5 × mục tiêu;
  - `items ≤ 40`;
  - `narration` mặc định `tts`.
  - Tập `whole` như cũ.
- `skills/studio-plan-episodes/SKILL.md`:
  - **khi nào chọn `cut`**: nguồn là video dài quay liên tục (trung bình > 60 s), hoặc brief/góp ý xin "cắt theo
    shot", "có lời dẫn";
  - **khi nào giữ `whole`**: nguồn là clip ngắn đã hoàn chỉnh;
  - sửa luôn chỗ lệch schema đã biết: mẫu thiếu `reason`, `texts_suggested` có `position`.
- `studio-spawn-episodes-v2`:
  - như v1, thêm `edit_style`, `narration`, `hints` vào snapshot tập;
  - ghi `episodes.edit_style`; migration `0023_episode_edit_style.sql`, `CHECK (edit_style IN ('whole','cut'))`,
    mặc định `whole`;
  - gọi `episodeWorkflowFor(planVersion, episode)`.
- `episodeWorkflowFor`:
  - plan ≥ 3.1 và `cut` → `ag-studio-episode-cut@1.0.0`;
  - còn lại theo `episodeWorkflowForPlan` cũ.
- Workflow `ag-studio-series-plan@3.1.0`: bản sao 3.0.0, chỉ đổi script của `spawn-episodes` và brief của
  `plan-episodes`. `STUDIO_WORKFLOWS.plan` lên 3.1.0.

**Test:**
- plan cũ (không có trường mới) vẫn hợp lệ;
- plan 3.0.0 có tập `cut` vẫn sinh 1.3.0;
- plan 3.1.0 sinh đúng workflow từng tập;
- `episodes.edit_style` đúng;
- `plan-v3.test.ts` cập nhật phiên bản.

---

## Nhóm D: lời dẫn, khớp hình, timeline v4 đầu tiên

### D1. TTS qua farm, kho giọng theo nội dung

- Stage farm `tts` (`studio.tts`), payload builder `studio-cut-tts`:
  - đọc kế hoạch dựng đã duyệt;
  - mỗi dòng có khoá `sha256(text, language, voice.reference, voice.reference_text, voice.speed, engine)`;
  - dòng đã có trong kho giọng thì không gửi;
  - không còn dòng nào, hoặc `narration ≠ tts`, thì `skip`;
  - `align_words: true`.
- `FarmExecutor` đã tải `tts/<line_id>.wav` + `tts.json`. Stage kế tiếp chép wav vào kho.
- Migration `0024_voice_lines.sql`: bảng `studio_voice_lines(key PRIMARY KEY, duration_s, words, language,
  created_at, last_used_at)`.
- Wav ở `<STUDIO_DATA_ROOT>/voice/<key>.wav`; API và worker dùng chung thư mục này (AGENTS.md, Tiến trình).
- `voice.ts` hết là phần sót: `productionVoice` được dùng ở đây.

**Test:**
- dòng đã có không gửi lại; sửa một dòng chỉ gửi dòng đó;
- `skip` khi không có lời;
- payload qua `StudioTtsPayloadSchema` của `@ag-farm/protocol`;
- `fakeFarm` trả wav tổng hợp và `words`.

### D2. `studio-cut-fit`: khớp hình, sinh timeline v4

- Kế hoạch dựng → `harness.edl/v1` + `harness.narration/v1`. Mốc lời từ kho giọng → `harness.narration-timing/v1`.
- Chạy `fitEdl` (bản chọn cảnh, shot, transcript, `voice`, mục tiêu), rồi `buildTimeline`.
- Đổi kết quả thành **`TimelineV4`**:
  - mỗi đoạn `video[]` là một clip `{in, out, shot_id, line_id, transition_out}`;
  - chữ từ `texts` theo `orderMap` (neo `at_order + offset_s`);
  - nhạc và tiếng gốc như kiểu `whole` (`buildEpisodeTimeline`);
  - `captions` theo Q14.
- Lưu revision 1 (author `system`), như `build-timeline`.
- Đầu ra `timeline.json` (type `timeline_v4`) + `fit-report.json`.

**Test:**
- kế hoạch có shot dài hơn lời bị `trimmed`, ngắn hơn được `extended`;
- `fit-report` có `shortfalls` khi thiếu hình;
- timeline qua `TimelineV4Schema` và không có lỗi `timelineIssues`;
- tổng thời lượng bằng `timeline.total_seconds` của harness ±1 ms.

### D3. Render tập cắt theo shot

- `studio-freeze-timeline-v4`: như v2, cho `timeline_v4`; chặn khi có lỗi, gồm `line_without_audio`.
- Payload builder `studio-episode-render-v4`: như v2, thêm `extraUploads` `voice/<line_id>.wav` từ kho giọng. Dùng
  chung cho xem trước 720p trong editor (`startEpisodePreview` chọn builder theo phiên bản revision).
- Xem trước 720p dùng `asset:` purpose `preview` như hiện nay.
- Bản cuối dùng file gốc (`final`), 3840×2160 theo `canvas` của production.
- `startPremiereExport` từ chối theo Q11.

**Test:**
- composition gửi đi có `voice: tts`, `narration` trỏ `stage:voice/…`, đủ file upload;
- thiếu wav trong kho là lỗi `contract` có tên dòng;
- xem trước của revision v4 mang wav;
- Premiere 422.

---

## Nhóm E: workflow `ag-studio-episode-cut@1.0.0`

### E1. Định nghĩa

```
episode-intake (studio-cut-intake)
 → fetch-proxies (studio-cut-proxies, cpu)
 → media-index (studio-media-index, cpu)
 → transcribe (farm studio.transcribe, payload_builder studio-cut-transcribe)
 → watch-source (studio-watch-source, cpu)
 → source-survey (agent file mode, studio-source-survey, claude)      check studio-survey-valid
 → [approve-survey]                                                   check studio-survey-valid
 → plan-edit (agent, studio-edit-plan, claude)                        check edit-plan-valid
 → [approve-edit-plan]                                                check edit-plan-valid
 → tts (farm studio.tts, payload_builder studio-cut-tts)
 → fit-timeline (studio-cut-fit)                                      check timeline-schema-valid
 → [approve-timeline] → youtube-kit → [approve-youtube-kit]
 → freeze-timeline (studio-freeze-timeline-v4) → render-final (farm, studio-episode-render-v4)
 → thumbnails → export
```

- Mọi stage chỉ nhận artifact từ stage nó phụ thuộc trực tiếp, mỗi kiểu một nguồn (wiring test kiểm).
- Kiểu mới trong `STUDIO_TYPES`: `cut_sources`, `proxy_set`, `shots`, `transcript`, `watch`, `survey_index`,
  `studio_edit_plan`, `voice_set`, `fit_report`, `timeline_v4`.
- `STUDIO_GATES`: `approve-survey` → `survey.json`, `approve-edit-plan` → `edit-plan.json`.
- `STUDIO_WORKFLOWS.episodeCut`; `STUDIO_WORKFLOW_IDS` thêm `ag-studio-episode-cut`.
- `rerenderEpisode`/`renderRestartFrom` nhận diện "run có `approve-timeline`" thay vì "run 1.3.0".
- Deadline: profile 4 giờ cho mọi stage, đủ cho render 4K tập 3–5 phút. Tập dài hơn ghi ở runbook.

**Test:**
- `workflow-wiring.test.ts` phủ workflow mới;
- `cancelLegacyRuns` không huỷ run của nó;
- `episodeStatusOf` ra `waiting_approval` ở hai gate mới;
- Render lại tập cắt theo shot theo đúng bảng A5 của pha 3.

### E2. Luồng tập trong engine (Claude giả, farm giả, ffmpeg tổng hợp)

`episode-cut.test.ts`: plan 3.1.0 có một tập `cut`, rồi lần lượt:
1. tới `approve-survey`;
2. nộp bản chọn cảnh đã sửa;
3. tới `approve-edit-plan`, nộp;
4. TTS (farm giả);
5. timeline v4 revision 1;
6. duyệt timeline, duyệt kit;
7. `render-final` gửi composition có trim, dissolve, lời dẫn;
8. thumbnails, export.

Một tập `whole` trong cùng plan đi 1.3.0 như cũ. Bước 1–7 phải ra đúng như trên.

---

## Nhóm F: chat ở chọn cảnh và kế hoạch dựng

### F1. Chat `approve-survey`

- `GATE_SOURCES["approve-survey"] = { stage: "source-survey", skill: "studio-survey", file: "survey.json" }`.
- Skill chỉ có ở chat `studio-survey` (`STUDIO_CHAT_SKILLS`), đề xuất thao tác:
  - `SurveyOp = keep{shot_id, note} | reject{shot_id, reason} | setScore{shot_id, score} | setNote{shot_id, note}`,
    tối đa 100;
  - proposal là `{ ops, survey }`, survey là bản sau khi áp, kiểm bằng `validateStudioSurvey`.
- `runChatTurn`:
  - scope có dòng `studio_agent_sessions` và `cwd` còn tồn tại thì chạy `claude -p --resume <session> --fork-session
    --json-schema <chatReplySchema> --allowedTools Read,Glob --max-turns 20` trong `cwd` đó;
  - session mới của lượt ghi vào `stage_chat_turns.session_id`;
  - lượt sau resume từ session của lượt áp dụng gần nhất.
- Không có session thì structured như mọi gate: prompt có bản chọn cảnh, `sources.json`, danh sách sheet. Câu trả lời
  có dòng "Mình không xem lại được khung hình…" (thêm vào `chatBrief`).
- Slot `claude`, ưu tiên, một scope một lượt: như ADR mục 144.
- Duyệt (`approveChatScope`) nộp `survey` của lượt đang hiện qua `submitStudioGate`, ghi `human_edits` kind `survey`.

**Test:**
- lượt chat dùng `--resume` khi có session, structured khi không;
- `keep` đổi `usable` và ghi chú;
- thao tác vào shot lạ bị validator chặn, giữ `reply`;
- bản cũ hơn bị 409 `stale_version`;
- migration `0019` không cần đổi: scope vẫn là `gate`.

### F2. Chat `approve-edit-plan`

- `GATE_SOURCES["approve-edit-plan"] = { stage: "plan-edit", skill: "studio-edit-plan", file: "edit-plan.json" }`.
  Đường gate sẵn có: head prompt giống từng byte stage, proposal là cả tài liệu, validator `edit-plan-valid`.
- Đổi lời của một dòng chỉ đổi khoá của dòng đó: D1 chỉ đọc lại dòng đó.

**Test:**
- góp ý "mở đầu nhanh hơn" (fake) cho bản mới hợp lệ;
- duyệt đi tiếp tới `tts`;
- head prompt chat bằng head prompt stage (snapshot).

### F3. Chat timeline v4

- `timelineContext` cho tập `cut` liệt kê clip có `in/out/line_id/transition_out` và lời dẫn.
- Thao tác `trimClip`, `setTransition`, `setCaptions` qua `applyTimelineOps`.
- Lời dẫn không sửa ở đây: skill bảo người dùng "Chạy lại từ kế hoạch dựng" (menu ⋯, `resumeRunFrom
  approve-edit-plan`).

**Test:** trim qua chat lưu revision v4; tập 1.3.0 không nhận được `trimClip` (lỗi `not_v3` từ validator, giữ
`reply`).

---

## Nhóm G: API (`apps/api`)

| Route | Vai | Thay đổi |
|---|---|---|
| `GET productions/:id/episodes/:episodeId` | viewer | thêm `editStyle`, `workflow` (id@version của run) |
| `GET productions/:id/episodes/:episodeId/shots` | viewer | **mới**: bản chọn cảnh hiện tại (gate hoặc đã duyệt), mỗi shot kèm URL khung ký có hạn; người không qua `coversProduction` nhận 403 |
| `POST productions/:id/episodes/:episodeId/rerun-from` | producer | **mới**: `{ stage: "approve-survey" \| "approve-edit-plan" }`, chạy lại từ gate đó (`resumeRunFrom`); chỉ cho run đã xong hoặc dừng ở gate sau |
| `POST …/timeline/revisions` | editor | nhận v3 hoặc v4; ghi theo Q2; v4 mất dữ liệu trên tập v3 → 422 `not_v3` |
| `POST …/exports/premiere` | producer | 422 `premiere_needs_phase_4` theo Q11 |

`docs/studio-api-v3.md` cập nhật các mục trên và hợp đồng v4.

**Test:** `realStudio()` + controller dựng tay; 403 cho khung shot; 422 hai trường hợp; `rerun-from` sai stage → 400.

## Nhóm H: web (`apps/web`)

Mọi chuỗi vào `i18n/locales/*` hoặc `chat.*.ts`.

### H1. Bước theo workflow

- `steps.ts`: `stepsFor(workflowId)`.
- Tập cắt theo shot (mockup màn 8–9): Chuẩn bị footage (`episode-intake` → `watch-source`) · Chọn cảnh
  (`source-survey`, `approve-survey`) · Kế hoạch dựng (`plan-edit`, `approve-edit-plan`, `tts`, `fit-timeline`) ·
  Timeline · YouTube kit · Render (gồm thumbnails, export).
- Tập `whole` giữ `EPISODE_STEPS` cũ.
- Header tập: "cắt theo shot · 8–12 phút · có lời dẫn".
- Vạch ngăn bước 1 trong chat: "tự động · 24 video, 112 shot", số lấy từ `shots`.

### H2. Cột phải "Chọn cảnh"

- `views/SurveyResult.tsx`:
  - lọc Dùng được / Bị loại / Tất cả;
  - lưới shot: khung, mã shot, mô tả ngắn · độ dài, "điểm/5 · dùng được" hoặc lý do loại;
  - shot đổi so với bản trước tô màu như mockup.
- Bấm shot mở đoạn 720p: web gọi ag-go `getAssetMedia` bằng bearer người dùng, phát `#t=in,out`, kèm mô tả AI.
- Nút Duyệt + ⋯.

### H3. Cột phải "Kế hoạch dựng"

- `views/EditPlanResult.tsx`:
  - bảng `# · Shot · Vào–ra · Dài`, đổi so với bản trước gạch/tô;
  - lời dẫn theo dòng (gạch bản cũ, tô bản mới);
  - chữ trên hình kèm mốc ước tính;
  - tổng thời lượng.
- Không có video xem trước (Q7).

### H4. Timeline v4 trong editor và cột phải

- `TimelineView`: độ rộng theo độ dài đã trim; đánh dấu dissolve giữa hai clip; dải lời dẫn dưới track hình.
- `Player`: seek `t − clip.start + clip.in`.
- `PropertiesPanel` (tập `cut`): ô vào/ra (bước 0.1 s, kẹp trong asset), kiểu chuyển cảnh, `line_id` chỉ đọc.
- Reducer thêm `trimClip`, `setTransition`, `setCaptions`.
- Tập `whole` không thấy các ô này.
- `TimelineResult`: cột vào–ra cho tập `cut`.
- Menu ⋯ của tập:
  - "Chạy lại từ chọn cảnh…" / "Chạy lại từ kế hoạch dựng…" (`rerun-from`, thẻ xác nhận);
  - ẩn "Xuất Premiere" theo Q11.

**Test** (mỗi task H một commit, test với client giả):
- bước đúng theo workflow;
- lọc shot; thẻ duyệt hai gate mới;
- bảng kế hoạch tô thay đổi;
- trim cập nhật độ rộng và gửi revision v4;
- player seek có `in`;
- tập `whole` không có ô trim.

---

## Nhóm I: kiểm thử tổng và tài liệu

### I1. Tích hợp với Claude và farm giả

`tests/integration/cut-episode.test.ts`: engine, worker pool, controller dựng tay; ffmpeg tổng hợp ba nguồn có cảnh
màu và tiếng. Một production đi các bước:
1. plan 3.1.0;
2. chat ở `approve-survey`:
   - "giữ shot s001-002" → Áp dụng → Duyệt;
3. chat ở `approve-edit-plan`:
   - "câu L002 ngắn lại" → Duyệt;
4. TTS chỉ đọc dòng mới;
5. timeline v4, trim một clip qua chat, duyệt;
6. kit với `nvenc`;
7. job `studio.render_final` có composition 3840×2160, segment có `in > 0`, một dissolve, `narration` 3 dòng, cue phụ
   đề; `studio_farm_jobs.requirements = { nvenc: true }`.

### I2. E2E với hub farm thật (`E2E=1`)

- `tests/e2e/farm-render.e2e.test.ts` thêm:
  - gửi `studio.tts` với payload từ `studio-cut-tts`;
  - gửi `studio.transcribe` với payload từ `studio-cut-transcribe` (cần hub đã có migration của T1);
  - hub nhận (schema strict), rồi huỷ.
- Render worker thật dựng một composition v4 nhỏ (720p, 3 segment có trim, một dissolve, lời dẫn wav tổng hợp) và ra
  file đúng thời lượng.

### I3. Kiểm tay trên stack local (Q12)

**Hỏi bạn trước** khi chuyển checkout chính `E:\CODE\ag-studio` sang nhánh này và build lại render worker.
1. Nhóm T đã làm; web farm 3011 thấy `local-render` khai `python`, nhận `studio.tts` và `studio.transcribe`.
2. `node scripts/local-stack.mjs up`, Claude thật.
3. Kiểm trước: folder `01a0d146-a73c-767f-b934-9e18671f31bc` (phố cổ Hoa Lư) hiện trong danh sách `@` của ô chat,
   các video đã quét có mô tả AI và proxy 720p (`resolve purpose=preview` trả `sourceKind` proxy hoặc preview).
4. Tạo video bằng chat với `@` folder đó: "phố cổ Hoa Lư về đêm, cắt theo shot kiểu đi bộ du lịch, có lời dẫn, 3–5
   phút". Duyệt R&D, branding, kế hoạch tập (ít nhất một tập là `cut`).
5. Chọn cảnh: chat ít nhất một lần (giữ/loại shot), Áp dụng, Duyệt.
6. Kế hoạch dựng: chat ít nhất một lần, Duyệt.
7. Timeline: xem trước 720p có giọng, chat trim một clip, Duyệt; YouTube kit: Duyệt và render.
8. Bản cuối: `ffprobe` ra 3840×2160, có lời, có dissolve. Xem bằng mắt ba khung (chữ địa danh, phụ đề tiếng Việt,
   một chuyển cảnh).
9. Chụp màn hình từng bước. Khung trình duyệt nhúng không polling, nên tải lại trang sau mỗi bước.
10. Ghi thời gian từng stage (media-index, transcribe, survey, TTS, render 4K CPU) vào runbook.

### I4. Tài liệu cuối pha

- **`AGENTS.md`:**
  - mục Workflow: plan 3.1.0, tập cắt theo shot;
  - mục Timeline: v4, quy tắc đọc/ghi;
  - mục Claude: file mode có session, chat `--resume`;
  - mục Pipeline media: "Studio dùng phần này qua `cut-stages.ts`";
  - bảng migration tới `0024`.
- **ADR-0001:**
  - **151**: Timeline v4, hợp đồng cho pha 4/6, v3 đọc như v4, không ghi lại phiên bản cũ;
  - **152**: hai kiểu dựng theo tập, chọn ở `plan-episodes`, plan 3.1.0. **Đảo D1**;
  - **153**: shot dò trong Studio trên proxy 720p, lưu theo run, không về ag-go. **Đảo D10** trong Studio;
  - **154**: nhận dạng giọng nói là job farm `studio.transcribe` (đổi hợp đồng ag-farm, đã duyệt), Studio gửi wav
    16 kHz đã tách; phương án chạy trong worker Studio bị loại và vì sao. **Đảo D11**;
  - **155**: agent file mode có session cho bước xem hình; chat `--resume --fork-session`; lùi về structured;
  - **156**: TTS qua farm, kho giọng theo nội dung, `skip` không gửi job; sửa phép dò Python (Q13);
  - **157**: không có stage compose, composition luôn suy từ revision v4; tiếng gốc khi có lời dẫn (Q9);
  - **158**: `ag-studio-episode-cut@1.0.0` giữ các key gate/render của 1.3.0 để run-control dùng chung;
  - **159**: Premiere tắt cho tập cắt theo shot tới pha 4;
  - **160**: số đo thật của lần chạy I3.
- **Runbook:**
  - `docs/runbooks/studio-local.md`: TTS/transcribe trên farm local, kho giọng, thời gian render 4K CPU;
  - `docs/runbooks/studio-production.md`: tập cắt theo shot, hai gate mới, chạy lại từ một gate;
  - `studio-media.md`/`studio-composition.md`: ghi chú Studio dùng hàm lõi nào.
- **`deferred-items.md`, mục "Sau pha 5":**
  - xem trước có giọng ở gate kế hoạch dựng (Q7);
  - tiếng gốc dưới lời dẫn (Q9);
  - Premiere/CapCut đọc in/out + lời dẫn (pha 4/6);
  - session Claude không dọn;
  - kho giọng và `cache/mezz` không dọn;
  - `has_speech` của ag-go chỉ là gợi ý;
  - nhãn ảnh contact sheet không font khi thiếu font.
- **`skills/README.md`:** ba skill mới.

## Thứ tự và phụ thuộc

T1 → T2 → T3 → A1 → A2 → A3 → A4 → B5 → B1 → B2 → B3 → B4 → C1 → C2 → C3 → D1 → D2 → D3 → E1 → E2 → F1 → F2 → F3 →
G → H1 → H2 → H3 → H4 → I1 → I2 → T4 → I3 → I4.

- B3 cần `@ag-farm/protocol` đã có `studio.transcribe` (T1, link tới `../ag-farm`, build lại).
- T4 và I3 là bước trên máy dev; I3 hỏi bạn trước khi chuyển checkout chính.
- H chỉ cần hợp đồng của G (test dùng client giả).
- I1 cần A–G.

## Kiểm tra cuối pha

- `corepack pnpm -r run build && corepack pnpm -r typecheck && corepack pnpm test`, so với baseline trong
  `deferred-items.md` (1532 pass cuối pha 3).
- `E2E=1 corepack pnpm vitest run tests/e2e/farm-render.e2e.test.ts`.
- Kịch bản I3 trên stack local, kèm ảnh chụp và số đo.
