# Plan: giọng đọc và nhạc nền là tuỳ chọn, người dùng tự đưa audio (2026-10-07)

Nhánh: `dev-duc`. Mỗi task một commit (Conventional Commits), test viết trước.
Số dành riêng: ADR-0001 mục `167`–`170` (pha 6 giữ `161`–`166`). Không cần migration: `productions.voice` (0010) và
`productions.music` đã có. Nếu cần thì dùng `0030`.

**Xong khi:**
- Một tập có lời dẫn không bao giờ còn hiện "đang chạy" khi production thiếu giọng.
- Người dùng đưa giọng mẫu hoặc nhạc nền bằng link hay tải file lên, hoặc bấm **Bỏ lời dẫn**. Tập chạy tiếp tới
  `approve-timeline`.
- Tập 2 "Ga Ninh Bình" của "Vlog du lịch Ninh Bình" chạy tiếp được.
- `pnpm -r typecheck` sạch, `pnpm test` pass.

## Vì sao

Tập 2 "Ga Ninh Bình" (run `run_01M4A2204X0N01XMH7A91SQ4DA`, tập cắt theo shot, `narration: tts`) đứng ở bước `tts` từ
06:20:44.
- Payload builder `studio-cut-tts` ném `CONFIG_INVALID` "production chưa có giọng đọc…". Lỗi contract không retry, nên
  stage đỗ ở `WAITING_HUMAN` và run ở `WAITING`. Không job farm nào được gửi.
- Không production nào có giọng: cột `productions.voice` không code nào ghi, và `STUDIO_DEFAULT_VOICE_REFERENCE` không
  có trong `apps/api/.env`.
- Web hiện "Kế hoạch dựng · đang chạy", ô chat bị khoá. Nguyên nhân là `chatScopeFor` (`chat-context.ts:111`) chỉ coi
  stage `agent` hỏng là bước hỏng; stage farm/script hỏng rơi xuống nhánh `busy`. Cột trái thì đúng ("cần xử lý") vì
  `run-control.ts:109` có xét `WAITING_HUMAN` không phải gate.
- Mọi tập cắt có `narration: tts` (5 tập còn lại của series này, 6 tập "Series vlog du lịch"…) sẽ tắc y hệt.

## Đã chốt (người dùng chọn, 2026-10-07)

- Giọng đọc và nhạc nền là **tuỳ chọn**; hệ thống được hỏi người dùng đưa audio.
- Tập có lời dẫn mà production chưa có giọng: **dừng ở bước `tts` và hỏi trong cột kết quả**. Người dùng đưa giọng mẫu
  rồi chạy tiếp, hoặc bấm **Bỏ lời dẫn**.
- Nguồn audio: **link file**, **tải file lên từ web**, **file audio trong folder ag-go**.
- Áp dụng cho **cả nhạc nền**.

## Hiện trạng (đã kiểm trong code)

**Lời dẫn từ đầu tới render:**
- `PlannedEpisodeSchema.narration` (`contracts/src/studio.ts:247`) là tuỳ chọn, vắng thì `tts`
  (`stages.ts:226`, `cut-stages.ts:36`). Claude chọn ở plan-episodes theo brief; không có thiết lập cấp production nào.
- `studio-cut-tts` (`cut-stages.ts:340`) đã `skip` (không gửi job, ghi `tts.json` rỗng) khi `narration !== "tts"`
  hoặc không có dòng nào. Chỉ khi cần đọc mới gọi `narrationVoice` (`cut-stages.ts:309`), và hàm này ném lỗi khi
  `reference` rỗng.
- `studio-cut-fit` (`cut-stages.ts:231`) cũng gọi `narrationVoice` khi `tts`. `cut-fit.ts:48` bỏ hết dòng lời khi
  không `tts`; phụ đề `burn-in` khi có lời, `none` khi không (`cut-fit.ts:119`).
- `render-plan.ts:47` trả narration rỗng khi `voice !== "tts"`; audio graph khi không lời phát tiếng gốc −12 dB dưới
  nhạc (`audio-graph.ts:70-91`). Tức là **đường "không lời dẫn" đã chạy được tới render**.
- Kho giọng khoá theo `{text, language, voice}` (`voice-store.ts:17`). Đổi giọng thì mọi dòng cũ thành "chưa đọc".

**TTS ở render worker** (`E:\CODE\ag-render-worker`, chỉ đọc):
- `engines/python/tts.py:148` từ chối khi không có `ref_audio`. **Không có giọng mặc định**: phải có file mẫu.
- `tts-handler.ts:131` gửi `ref_text: reference_text ?? ''`. OmniVoice chỉ tự nhận dạng lời của file mẫu khi
  `ref_text is None` (`omnivoice/models/omnivoice.py:809`). Chuỗi rỗng thì không nhận dạng, chất lượng clone kém hơn.
- OmniVoice còn có chế độ **voice design** (`instruct`: giới tính, tuổi, cao độ) không cần file mẫu
  (`omnivoice.py:613`). Hợp đồng `studio.tts` (`ag-farm/packages/protocol/src/jobs/studio.ts:18`) chưa có trường này.

**Nhạc nền:**
- `productions.music` là JSON `{track: "library:…", gain_db, ducking}` (`StudioMusicSchema`, `studio.ts:37`). Web nhập
  tay chuỗi `library:…` (`ProductionForm.tsx:450`, editor `PropertiesPanel.tsx:254`). Không có danh sách hay chỗ chọn.
- Nhạc được đóng băng hai lần: `seed.json` lúc chạy plan (`stages.ts:346`) và `brief.json` lúc `episode-intake`
  (`stages.ts:418`). `studio-cut-fit` lấy `brief.music` (`cut-stages.ts:253`). Đặt nhạc sau `episode-intake` thì tập đó
  **không** nhận được.
- Ký `library:<p>` → R2 `library/<p>` (`farm.controller.ts:135`), không kiểm quyền theo team.

**Upload, tải link, ffmpeg:**
- Upload duy nhất: multipart qua API cho thumbnail (`thumbnails.controller.ts:229`, `FileInterceptor`, 10 MB).
- `StudioBucket.put/putFile` (`bucket.ts:11`) ghi được mọi key; không có presigned PUT.
- `httpDownload` (`cut-media.ts:7`) không giới hạn cỡ, không chặn SSRF. Cả repo không có guard SSRF nào.
- `runTool`, `probeMedia` (`cut-ffmpeg.ts:17,61`) dùng lại được; chưa có hàm chuyển audio sang WAV 24 kHz (bản đồng bộ
  ở `core/src/library/voices.ts:60` dùng `spawnSync`, không dùng được trong worker pool).

**ag-go không có audio** (`E:\CODE\ag-go-v2`, `E:\CODE\ag-scan-worker`, chỉ đọc):
- `assetType` chỉ `'image' | 'video'` (`ag-go-api/src/database/entities/asset.entity.ts:8`), có CHECK trong DB
  (`migrations/1720000000000-project-media.ts:19`). DTO upload, import Google Drive và web ag-go đều chỉ nhận ảnh/video.
- Scan worker ném `No video stream found` với file chỉ có tiếng (`ag-scan-worker/src/ffmpeg-utils.ts:86`).
- Danh sách footage chỉ trả asset đã phân tích (có mô tả AI), toàn video.
- → Chọn audio từ ag-go cần sửa hai repo ngoài phạm vi ag-studio. Tách thành **pha B**.

**Chat, run-control:**
- `ChatThreadView.blocked` (`chat-actions.ts:205`) chỉ có `{code, stage}`. Web: `ResultPane.tsx:129,172` hiện "đang
  chạy" khi `busy`.
- Đã có endpoint chạy lại stage hỏng: `POST /episodes/:id/stages/:stage/retry` (`episodes.controller.ts:408`) và
  `POST …/runs/stages/:stage/retry` (`studio-run.controller.ts:154`), đều gọi `retryStage` (`run-control.ts:436`).

**Quy định sẵn có:** ADR mục 105 (`docs/adr/0001-control-plane-baseline.md:686`): thiếu giọng thì hạ về
`voice: none`, không làm hỏng ("một kênh chưa có giọng vẫn phải sản xuất được"); `origin` của giọng
(`synthetic|own|licensed`) bắt buộc khai, hệ thống không xác minh được.

## Quyết định cần bạn duyệt

Plan viết theo cột "Đề xuất".

| # | Vấn đề | Đề xuất | Lý do / phương án khác |
|---|---|---|---|
| Q1 | "Bỏ lời dẫn" áp cho đâu | **Cả production**: `productions.voice = {mode: "none"}`. Mọi tập đang đứng ở `tts` chạy tiếp không lời; tập sau đó cũng không lời. Muốn có lời lại thì đưa giọng mẫu. | Thiếu giọng là chuyện của production, không của một tập; hỏi lại ở từng tập thì phiền. Khác: bỏ theo từng tập (cần cột mới `episodes.narration_override`, migration `0030`). |
| Q2 | Lời dẫn đã viết trong kế hoạch dựng khi bỏ | **Bỏ hẳn**: `fit-timeline` dựng như `narration: none`, thời lượng clip giữ theo kế hoạch. | Biến lời thành phụ đề cần thời điểm từng câu (hiện lấy từ WAV đã đọc); không có WAV thì phải ước lượng. Ghi deferred. |
| Q3 | Production chưa có giọng (`null`) lúc lên kế hoạch tập | Plan-episodes vẫn được chọn `tts`, có ghi chú "chưa có giọng, sẽ hỏi trước khi đọc". Production đã chọn **Bỏ lời dẫn** thì validator chặn `tts` (`narration_needs_voice`). | Người dùng có thể đưa giọng sau. Khác: khi chưa có giọng thì chỉ cho `none/original` (không bao giờ dừng, nhưng không bao giờ có lời dẫn nếu quên đưa giọng từ đầu). |
| Q4 | Giọng mẫu: định dạng | Chấp nhận mọi file ffprobe đọc được có luồng âm thanh, ≥ 3 s, ≤ 20 MB. Chuẩn hoá WAV mono 24 kHz `pcm_s16le`, **cắt còn 20 s đầu**. | Như `library/voices.ts` của harness. File mẫu dài làm TTS chậm, không làm giọng tốt hơn. |
| Q5 | Lời nói trong file mẫu (`reference_text`) | Ô nhập **tuỳ chọn**. Để trống thì gửi `null` và **sửa một dòng ở render worker** (`tts-handler.ts:131`: `reference_text ?? None` thay vì `''`, và `tts.py` truyền `None`) để OmniVoice tự nhận dạng. | Sửa code render worker (repo khác), **không đổi hợp đồng** farm (`reference_text` vốn nullable). Không sửa thì người dùng phải gõ đúng lời trong file mẫu. |
| Q6 | Quyền dùng giọng (ADR mục 105) | Bắt buộc chọn nguồn gốc `synthetic` (giọng máy) / `own` (giọng của chính mình) / `licensed` (có giấy phép) và tick "Tôi có quyền dùng giọng này". Lưu `origin`, `confirmed_by`, `confirmed_at` trong `productions.voice`. | Không xác minh được; chỉ ghi lời khai như ADR 105. |
| Q7 | Nơi lưu file | R2 `library/studio/<production_id>/<voice\|music>/<sha256>.<ext>`, input `library:studio/…`. | Đường ký `library:` sẵn có, render worker không phải sửa. Key toàn cục như nhạc hiện nay (farm ký không kiểm team). |
| Q8 | Tải link | Server tải: chỉ `http(s)`, phân giải DNS rồi **chặn IP nội bộ/loopback/link-local** (bỏ chặn bằng `STUDIO_AUDIO_ALLOW_PRIVATE_URLS=1` cho stack local), timeout 60 s, dừng khi quá cỡ, kiểm bằng ffprobe chứ không tin `Content-Type`. Link chia sẻ Google Drive (`/file/d/<id>/view`) đổi sang link tải. | Link do người dùng dán: không chặn thì API thành công cụ đọc mạng nội bộ. |
| Q9 | Tải file lên | Multipart qua API như thumbnail, `diskStorage` vào thư mục tạm (không giữ trong RAM). Giới hạn: giọng 20 MB, nhạc 100 MB. | Không cần presigned PUT; cùng một đường cho cả link và file. |
| Q10 | Nhạc đặt sau khi tập đã qua `episode-intake` | `studio-cut-fit` lấy nhạc **hiện tại của production** nếu có, không có thì `brief.music`. | Nhạc đưa vào lúc tập đang chờ giọng (cùng màn hỏi) phải có tác dụng ngay. Tập đã có timeline giữ nhạc cũ; muốn đổi thì sửa timeline. |
| Q11 | Đổi giọng khi đã đọc xong | Không tự đọc lại. Tập đã qua `tts` giữ giọng cũ; muốn đọc lại thì chạy lại từ `plan-edit` (đã có menu). | Đọc lại tốn GPU và làm lệch timeline đã duyệt. |
| Q12 | Bước farm/script/in-process khác bị hỏng | Cột kết quả hiện **"Bước X hỏng"**, lỗi lấy từ event `attempt.failed` gần nhất, nút **Chạy lại** gọi endpoint retry sẵn có. Ô chat khoá kèm lời giải thích (Claude không sửa được bước máy). | Sửa đúng lỗi "đang chạy" giả. Không mở chat vì không có skill nào cho các bước này. |
| Q13 | Hỏi ở intake | Hai dòng **tuỳ chọn** "Giọng đọc", "Nhạc nền" ở cột kết quả intake, có nút đưa audio (production đã tồn tại từ intake). Skill `studio-intake` hỏi một câu (tuỳ chọn) khi series hợp lời dẫn. Link người dán trong chat được Claude ghi vào `audio_links` của bản nháp; cột phải hiện "Dùng link này" (vẫn phải chọn nguồn gốc giọng, Q6). | Đúng ý "hỏi người dùng cung cấp link". Claude không tự tải gì; người bấm mới tải. |
| Q14 | Giọng máy không cần file mẫu | **Không làm trong plan này** (pha C, hỏi sau). OmniVoice voice design (`instruct`) cần thêm trường vào payload `studio.tts` (đổi hợp đồng ag-farm) và sửa `tts.py`. Giọng có thể lệch giữa các câu: nên sinh một câu mẫu bằng voice design rồi clone từ đó. | Đáng làm vì bỏ được bước đi tìm file mẫu, nhưng đổi hợp đồng farm. |
| Q15 | Audio từ folder ag-go | **Pha B, hỏi trước khi làm** (hai repo khác, đổi hợp đồng ag-go). Pha A chừa chỗ: `source.kind = "ag-go"` có trong schema, `AudioPicker` chưa hiện nguồn này. | Xem mục "Pha B". |
| Q16 | `STUDIO_DEFAULT_VOICE_REFERENCE` | Giữ làm giọng dự phòng khi production chưa có giọng (`null`); `{mode: "none"}` thắng nó. Ghi vào `.env.example`. | Hành vi sẵn có, chỉ chưa được ghi lại. |

## Hợp đồng (ghi vào `packages/contracts/src/studio.ts`, ADR mục 167)

```ts
export const VOICE_ORIGINS = ["synthetic", "own", "licensed"] as const;

export const AudioSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("link"), url: z.string().url().max(2000) }),
  z.object({ kind: z.literal("upload"), filename: z.string().max(255) }),
  z.object({ kind: z.literal("ag-go"), asset_id: z.string() }),          // pha B
]);

/** productions.voice. null = chưa hỏi (dùng STUDIO_DEFAULT_VOICE_REFERENCE nếu có). */
export const ProductionVoiceSchema = z.union([
  z.object({ mode: z.literal("none"), decided_by: z.string(), decided_at: z.string() }),
  z.object({
    mode: z.literal("clone"),
    reference: LibraryInputSchema,                 // library:studio/<prod>/voice/<sha>.wav
    reference_text: z.string().max(2000).nullable(),
    speed: z.number().min(0.5).max(2).default(1),
    origin: z.enum(VOICE_ORIGINS),
    source: AudioSourceSchema, sha256: z.string(), duration_s: z.number(),
    confirmed_by: z.string(), confirmed_at: z.string(),
  }),
  // bản cũ (chỉ có trong test, ghi bằng SQL): đọc như clone
  z.object({ reference: z.string().nullable(), reference_text: z.string().nullable(), speed: z.number() }),
]);
```

- `StudioMusicSchema` thêm `source?: AudioSourceSchema`, `sha256?`, `duration_s?` (tuỳ chọn, bản cũ vẫn hợp lệ).
- `IntakeDraftSchema` thêm `audio_links?: { voice: url|null, music: url|null }` (tuỳ chọn).
- `ChatThreadView.blocked` thêm `problems?: ChatProblem[]`; mã mới `needs_voice`, `stage_failed`.

## Nhóm A: engine

### A1. Contracts
- File: `packages/contracts/src/studio.ts`, `studio-chat.ts`; `pnpm gen:schemas`, commit JSON Schema sinh ra.
- Test (`packages/contracts/test/`): ba dạng `voice` parse đúng; bản cũ `{reference, reference_text, speed}` vẫn parse;
  `music` cũ không `source` vẫn parse; `audio_links` vắng vẫn hợp lệ.

### A2. Giọng tuỳ chọn trong stage
- `voice.ts`: `productionVoice(json, env)` trả `{ kind: "clone", voice } | { kind: "none" } | { kind: "missing" }`
  (`null` + có env → `clone` từ env; `null` + không env → `missing`).
- `cut-stages.ts`:
  - `narrationVoice` trả `voice | null` (null khi `none`); `missing` ném `CONFIG_INVALID` với
    `details.code = "needs_voice"`.
  - `studio-cut-tts`: `none` → skip như `narration !== "tts"`.
  - `studio-cut-fit`: `none` → gọi `fitCutTimeline` với `plan` đã hạ `narration: "none"`, `lines: []`; nhạc lấy theo Q10.
- Test: `cut-tts.test.ts` (none → skip, không gửi job; missing → lỗi có `needs_voice`; clone giữ hành vi cũ),
  `cut-fit-stage.test.ts` (none → timeline không lời, `captions.mode = none`; nhạc production thắng `brief.music`).

### A3. Bước hỏng không phải Claude
- `chat-context.ts` `chatScopeFor`: sau nhánh gate và nhánh agent hỏng,
  - stage `tts` ở `WAITING_HUMAN`/`FAILED` và `productionVoice` là `missing` → conflict `needs_voice`, `stage: "tts"`;
  - stage không phải gate, không phải agent, ở `WAITING_HUMAN`/`FAILED` → conflict `stage_failed`, kèm `problems` lấy
    từ `errors` của event `attempt.failed` cuối cùng của stage đó.
- `chat-actions.ts` `chatThread`: chép `problems` vào `blocked`.
- Test `chat-context.test.ts`: tập cắt, `tts` `WAITING_HUMAN`, production không giọng → `needs_voice` (không còn
  `busy`); production có giọng mà `tts` hỏng vì farm → `stage_failed` với thông báo lỗi; stage đang `RUNNING` vẫn `busy`.

### A4. Nhập audio
- File mới `packages/studio-engine/src/audio-import.ts`:
  - `fetchAudioUrl(url, dest, { maxBytes, allowPrivate, signal, lookup? })`: kiểm scheme, đổi link Drive, phân giải
    DNS và chặn dải nội bộ (IPv4 + IPv6), theo redirect tối đa 3 lần và kiểm lại từng bước, dừng khi vượt `maxBytes`.
  - `prepareVoice(ffmpeg, src, dest)`: probe (có âm thanh, ≥ 3 s), chuyển WAV mono 24 kHz, cắt 20 s (bản bất đồng bộ
    qua `runTool`).
  - `prepareMusic(ffmpeg, src)`: probe (có âm thanh, ≥ 5 s), giữ nguyên file.
  - `importProductionAudio(deps, { productionId, kind, file, source, origin?, referenceText?, userId })`: sha256,
    `bucket.putFile` vào key của Q7, ghi `productions.voice|music`, trả bản ghi.
  - `declineNarration(db, productionId, userId)`: ghi `{mode: "none"}`.
  - `resumeVoiceWaiting(core, db, productionId)`: `retryStage(tts)` cho mọi tập của production có `tts` ở
    `WAITING_HUMAN`/`FAILED`. Gọi sau `importProductionAudio(voice)` và `declineNarration`.
- Test `audio-import.test.ts`: chặn `http://127.0.0.1`, `http://10.x`, `http://[::1]`, `file:`; redirect sang IP nội bộ
  bị chặn; quá cỡ bị dừng và xoá file dở; đổi link Drive; server HTTP giả trên loopback với `allowPrivate`. Phần ffmpeg
  (WAV 24 kHz, cắt 20 s, từ chối file không có tiếng) chỉ chạy khi có `FFMPEG_PATH`. `resumeVoiceWaiting` đưa `tts` về
  `READY` và run về `RUNNING`.

### A5. Kế hoạch tập biết về giọng
- `stages.ts` (input của `studio-plan-episodes`): thêm `voice: "ready" | "none" | "missing"`.
- `skills/studio-plan-episodes/SKILL.md`: `none` → chỉ `none`/`original`; `missing` → được `tts`, giọng sẽ được hỏi trước
  khi đọc.
- `packages/core/src/studio/validate.ts`: `narration_needs_voice` (error) khi `voice = none` mà có tập `tts`.
- Test validator.

## Nhóm B: API (`apps/api`)

### B1. `production-audio.controller.ts`
- `POST /api/studio/productions/:id/audio/voice`: multipart `file` hoặc JSON `{ url }`, kèm `origin`,
  `confirm: true`, `reference_text?`. 422 `audio_invalid` (không có tiếng, quá ngắn), 413 `audio_too_large`,
  400 `url_not_allowed`, 502 `url_fetch_failed`.
- `POST …/audio/music`: như trên, kèm `gain_db?`, `ducking?`.
- `POST …/audio/voice/none` (Bỏ lời dẫn), `DELETE …/audio/voice`, `DELETE …/audio/music`.
- Quyền: `editor` trở lên trong team của production (`RolesGuard`). Ghi `human_edits`.
- `config/env.ts`: `STUDIO_AUDIO_ALLOW_PRIVATE_URLS` (boolean, mặc định false).
- `productions.service.ts`: `ProductionDto` thêm `voice` (mode, origin, source, duration_s; không trả key R2) và
  `music.source`.
- Test `production-audio.spec.ts`: upload file → production có giọng và `tts` của tập đang chờ về `READY`; link bị chặn
  → 400, không đổi gì; thiếu `confirm` → 400; viewer → 403; Bỏ lời dẫn → `mode: none` và tập chạy tiếp.

## Nhóm C: web (`apps/web`)

### C1. `AudioPicker`
- `apps/web/src/modules/common/AudioPicker.tsx`: hai tab **Dán link** / **Tải file lên**. Với giọng: chọn nguồn gốc
  (Q6), ô tick quyền, ô "Câu nói trong file (không bắt buộc)". Có nghe thử (URL ký có hạn của file đã lưu).
- `studio-client.ts`: `uploadProductionAudio`, `setProductionAudioUrl`, `declineNarration`, `removeProductionAudio`.

### C2. Cột kết quả
- `ResultPane.tsx`:
  - `blocked.code === "needs_voice"`: tiêu đề "Cần giọng đọc", giải thích tập có lời dẫn, `AudioPicker` (giọng) và
    `AudioPicker` (nhạc nền, tuỳ chọn), nút phụ **Bỏ lời dẫn** (xác nhận: áp cho cả series).
  - `blocked.code === "stage_failed"`: badge "cần xử lý", danh sách lỗi, nút **Chạy lại** (endpoint retry sẵn có).
- Ô chat: lời nhắc riêng cho hai mã này thay cho "đang làm bước này".
- i18n `chat.vi.ts`/`chat.en.ts` (dùng `{{ai}}` nơi nhắc AI).
- Test `ResultPane.spec.tsx`: `needs_voice` hiện picker và nút Bỏ lời dẫn, không còn chữ "đang làm"; `stage_failed` hiện
  lỗi và nút Chạy lại.

### C3. Intake và form production
- `views/doc-specs.ts` (intake): hai dòng tuỳ chọn "Giọng đọc", "Nhạc nền" (chưa có / tên file / "không lời dẫn"), nút
  mở `AudioPicker`; `audio_links` trong bản nháp hiện nút "Dùng link này". Không vào `intakeMissing`.
- `ProductionForm.tsx`: khối Nhạc dùng `AudioPicker`, giữ ô nhập tay `library:…` trong mục "Nâng cao"; thêm khối Giọng
  đọc.
- Test component tương ứng.

## Nhóm D: Claude và tài liệu

### D1. Skill intake
- `skills/studio-intake/SKILL.md`: series hợp lời dẫn (du lịch, kể chuyện) thì hỏi **một** câu tuỳ chọn về giọng mẫu và
  nhạc nền, nói rằng có thể dán link vào chat hoặc tải lên ở cột phải; link người dán → `audio_links`. Không bao giờ coi
  là thông tin bắt buộc.
- Validator intake: `audio_links` phải là URL http(s).
- Test với Claude giả (`fixtures/fake-studio-claude.mjs`).

### D2. Tài liệu
- ADR-0001: mục 167 (giọng tuỳ chọn, ba trạng thái, Bỏ lời dẫn cấp production), 168 (nhập audio: link/upload, guard
  SSRF, nơi lưu), 169 (bước máy hỏng hiện là hỏng, không phải "đang chạy"), 170 (nhạc lấy lúc khớp hình).
- `AGENTS.md` (mục Studio), `docs/runbooks/studio-local.md` §4a và bảng sự cố, `docs/runbooks/studio-production.md`,
  `docs/studio-api-v3.md`, `.env.example` (`STUDIO_DEFAULT_VOICE_REFERENCE`, `_TEXT`, `STUDIO_AUDIO_ALLOW_PRIVATE_URLS`).
- `docs/operations/deferred-items.md`: sửa ghi chú cũ ở dòng 40 (`voice.ts`/`studio.tts` không còn là phần sót); thêm:
  lời dẫn bị bỏ thành phụ đề (Q2), bỏ lời dẫn theo từng tập (Q1), giọng máy không file mẫu (Q14), audio từ ag-go (pha B).

## Nhóm T: ngoài repo (cần bạn cho phép)

- **T1 (Q5).** `ag-render-worker`: `tts-handler.ts:131` gửi `null` khi không có `reference_text`; `engines/python/tts.py`
  truyền `None` cho OmniVoice để tự nhận dạng. Không đổi hợp đồng farm. Cần build lại render worker trên máy dev.

## Kiểm tay (stack local, Claude thật)

1. Mở Tập 2 "Ga Ninh Bình": cột phải hiện "Cần giọng đọc", không còn "đang chạy".
2. Bấm **Bỏ lời dẫn**: `tts` skip, `fit-timeline` chạy, tập dừng ở `approve-timeline`; xem trước 720p không lời, còn
   tiếng gốc.
3. Ở "Series vlog du lịch": dán link một file giọng mẫu `synthetic`/`own` (bạn cung cấp), kèm một link nhạc. Tập 2 của
   series đó tới `tts` thì gửi `studio.tts` lên farm, timeline có lời dẫn và nhạc.
4. Một link `http://localhost:…` bị từ chối khi không bật `STUDIO_AUDIO_ALLOW_PRIVATE_URLS`.

## Pha B: audio trên ag-go (hỏi trước, chưa làm)

- **ag-go-v2:** `assetType: 'audio'` + migration sửa CHECK; DTO upload và lọc import Google Drive nhận `audio/*`; web
  ag-go cho chọn file audio; API liệt kê audio trong folder (không cần phân tích AI); `/footage/assets/resolve` trả file
  gốc cho audio.
- **ag-scan-worker:** file chỉ có tiếng thì ghi `kind: audio`, thời lượng, không đòi luồng hình.
- **ag-studio:** nguồn `ag-go` trong `AudioPicker` (cây folder sẵn có, lọc audio), server tải qua resolve rồi đi đường A4
  (vẫn chép vào R2 Studio để kho giọng và render không phụ thuộc quyền ag-go về sau).

## Pha C: giọng máy không cần file mẫu (hỏi sau, Q14)

Thêm `voice.instruct` vào payload `studio.tts` (đổi hợp đồng ag-farm), `tts.py` hỗ trợ voice design; Studio cho chọn
"Giọng máy: nữ, trẻ, cao độ vừa…", sinh một câu mẫu một lần rồi clone từ câu đó để giọng đồng nhất giữa các câu và các tập.
