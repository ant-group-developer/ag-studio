# Plan pha 4: xuất Premiere cho cả hai kiểu dựng

Spec: `docs/superpowers/specs/2026-10-06-ag-studio-local-chat-design.md` (mục 3.5; bảng pha, dòng 4).
Nhánh: `feat/local-phase-4-premiere`, tách từ `dev-duc`. Mỗi task một commit, test viết trước. Số dành riêng: ADR-0001
mục `171`–`172` (pha 6 giữ `161`–`166`, optional-audio dùng tới `170`). Không có migration.

**Xong khi** (bảng pha): mở được trong Premiere, đúng tiếng, nhạc đúng mức. Plan này thêm: tập cắt theo shot mở đúng
điểm in/out, chuyển cảnh, lời dẫn trên A3, phụ đề nhập được từ `captions.srt`.

## Hiện trạng (đã kiểm, 2026-10-07)

**Render worker đã xong phần của nó** (`E:\CODE\ag-render-worker`, nhánh `dev-duc`, 9 commit **chưa lên `main`**):
- `08c1344`, `09894e6`, `d0132f1` (0.5.4): A1 trống khi composition tắt tiếng gốc; A2 lấy `cues[0].gain_db` và fade của
  nhạc; A1 −12 dB khi `voice: none`. Đây là hai "lỗi đã biết" trong `deferred-items.md`, **đã sửa** nhưng tài liệu chưa
  cập nhật.
- `e882a6c`: đọc timeline v4. V1/A1 phát `[in, out)` của file; dissolve có đuôi thành Cross Dissolve, `dip_black` thành
  Dip to Color; `voice: tts` thì lời dẫn lên A3 (tải `stage:voice/<line_id>.wav`); duck window thành keyframe A2;
  phụ đề vào zip dạng `captions.srt`. Commit ghi rõ: *Studio vẫn trả 422 và chưa gửi WAV lời dẫn kèm job*.

**Studio còn chặn:**
- `premiereCanExport` (`packages/studio-engine/src/editor.ts:84`): timeline v4 có trim, chuyển cảnh hoặc lời dẫn thì
  `startPremiereExport` (`editor.ts:192`) ném `premiere_needs_phase_4` → API 422 (ADR mục 159).
- `startPremiereExport` chỉ đẩy `composition.json`; **không đẩy WAV lời dẫn**. Render preview đã làm việc này qua
  `narrationUploads` (`packages/studio-engine/src/payloads.ts:20`, hàm nội bộ): đọc từ kho giọng `EditorDeps.voiceDir`,
  thiếu WAV thì ném `CONFIG_INVALID`.
- Web ẩn xuất Premiere của tập `cut` ở ba chỗ: `modules/production/EpisodesPanel.tsx:222`,
  `modules/production/EpisodeDrawer.tsx:299`, `modules/chat/ResultPane.tsx:162`.
- Test đang khẳng định việc chặn: `packages/studio-engine/test/cut-render.test.ts:47`,
  `apps/api/src/studio/timeline.spec.ts:126`, `apps/web/src/modules/chat/ResultPane.spec.tsx:124`.
- Tài liệu: ADR mục 159, `docs/runbooks/studio-production.md:46` và `:69`, `deferred-items.md` (mục "Lỗi đã biết" và
  dòng "Premiere/CapCut đọc `in`/`out`…" của pha 5).

**Hợp đồng không đổi:** `StudioExportPremierePayloadSchema` (`ag-farm/packages/protocol/src/jobs/studio.ts:150`) đã đủ;
WAV đi theo cùng cơ chế `stage:` như composition (đẩy vào `stageInputPrefix(…, "editor-premiere", id)`).

**Bẫy:** farm không ghim phiên bản worker. Nếu job rơi vào một máy còn chạy render worker cũ, máy đó đọc v4 bằng
`CompositionSchema` của bản `@ag-studio/render` nó được build cùng. Bản cũ có thể từ chối composition (lỗi rõ ràng) hoặc
bỏ qua `in`/`out` (project sai mà không báo). T0 kiểm xem là trường hợp nào.

## Câu hỏi cần chốt

- **Q1. Chặn worker cũ thế nào?**
  - (a) **Mặc định:** không đổi hợp đồng. Deploy render worker trước Studio, ghi thứ tự vào runbook. Nếu T0 cho thấy bản
    cũ từ chối composition v4 thì như vậy là đủ an toàn.
  - (b) Thêm trường vào payload (ví dụ `reads: "timeline_v4"`, schema `strictObject` nên worker cũ từ chối job). Đây là
    **đổi hợp đồng ag-farm, phải hỏi**. Chỉ cần khi T0 cho thấy bản cũ âm thầm bỏ trim.
- **Q2. Merge và deploy `ag-render-worker` `dev-duc` → `main`:** việc ra ngoài repo này, hỏi trước khi làm (nhóm E).

## Quyết định đề xuất (mặc định nếu không ai phản đối)

- **D1. Thiếu WAV lời dẫn thì báo lỗi ngay**, trước khi tạo `episode_jobs`: 422 `narration_missing` kèm `line_id`,
  không tạo job hỏng. Cùng điều kiện với render preview.
- **D2. Bỏ hẳn `premiereCanExport`** và mã `premiere_needs_phase_4`. Không giữ cờ bật/tắt (giống D6 của plan pha 6).
- **D3. Phụ đề:** giữ `captions.srt` như worker đã làm (chỉ có khi `captions.mode` khác `none`). SRT là chữ thường nên
  karaoke mất hiệu ứng; worker không ghi cảnh báo riêng cho việc này. Web hiện mọi cảnh báo có trong
  `premiere.json.warnings` (A4).

## Nhóm T: kiểm trước (không commit trong repo này)

- **T0.** Trong `ag-render-worker` (`dev-duc`): `pnpm test` xanh. Xác nhận `@ag-studio/render` đang link tới checkout nào
  (`node_modules/@ag-studio/render` → `../ag-studio/packages/render`, phải là `dev-duc`). Lấy một composition v4 (fixture
  của `cut-render.test.ts`) chạy qua `CompositionSchema` của bản render worker **đang chạy trên farm**: từ chối hay bỏ
  qua `in`/`out`? Ghi kết quả vào plan này, chốt Q1.

  **Kết quả (2026-10-07):** link `@ag-studio/render` → `E:/CODE/ag-studio/packages/render` (checkout chính). Composition
  của tập cắt **cùng schema** `harness.composition/v1` (`packages/contracts/src/composition.ts` không đổi từ 2026-09-29):
  `segments[].in/out`, `transitions`, `narration` đã có từ trước. Worker cũ nhận job, **âm thầm** bỏ in-point, chuyển
  cảnh và lời dẫn. Q1 tạm theo (a), thứ tự deploy ghi ở runbook và ADR mục 171. Phương án (b) vẫn chờ người dùng.

## Nhóm A: Studio

- **A1. engine: đẩy WAV lời dẫn kèm job Premiere.**
  Test trước (`packages/studio-engine/test/cut-render.test.ts`, thay test "Premiere does not yet take…"): tập cắt có
  trim + dissolve + 2 dòng lời dẫn đã đọc → `farm.submitJob` được gọi một lần với `studio.export_premiere`; bucket có
  `…/editor-premiere/<id>/in/composition.json` và `…/in/voice/<line_id>.wav` cho từng dòng; composition có `in`/`out`
  và `transition_out` đúng. Thêm test: một dòng mất WAV → `StudioRunError` `invalid`, `details.code = "narration_missing"`,
  không có hàng `episode_jobs`, không gửi job. Thêm test: `voice: none` → không đẩy WAV nào.
  Code: export `narrationUploads` từ `payloads.ts` (đổi tên `narrationFiles`), gọi trong `startPremiereExport` **trước**
  `insertEpisodeJob` (D1), đổi `HarnessError` thành `StudioRunError`. Bỏ `premiereCanExport` (D2).
  Commit: `feat(engine): Premiere takes a shot-cut episode — its trims, transitions and narration`.
- **A2. api: bỏ 422 `premiere_needs_phase_4`.**
  Test trước (`apps/api/src/studio/timeline.spec.ts:126`): cùng timeline cắt → controller trả job, `submitted` có một
  job, payload đúng schema của `@ag-farm/protocol`. Thêm test: 422 `narration_missing` được map đúng (xem cách controller
  map `StudioRunError` hiện có).
  Commit: `feat(api): export a shot-cut episode to Premiere`.
- **A3. web: hiện xuất Premiere cho tập cắt.**
  Test trước: `ResultPane.spec.tsx:124` đổi thành "⋯ của tập cắt có Xuất project Premiere"; thêm case cho
  `EpisodesPanel` và `EpisodeDrawer` (hoặc `premiere-exports.spec.tsx`) với `editStyle: "cut"`.
  Code: bỏ điều kiện `editStyle !== "cut"` ở ba chỗ và các comment "phase 4".
  Commit: `feat(web): Premiere export for shot-cut episodes in the chat and the old screen`.
- **A4. web: hiện cảnh báo của bản xuất.**
  `pollEpisodeJob` đã đọc `premiere.json`; kiểm tra `result.warnings` có tới web không. Nếu có cảnh báo, hiện chúng dưới
  dòng job trong `PremiereExports.tsx` (vi/en): karaoke thành chữ thường, file nào không probe được.
  Đã kiểm: `result.warnings` được lưu nhưng web không hiện, nên task này cần làm.
  Commit: `feat(web): show what a Premiere export could not carry over`.

## Nhóm B: test tích hợp

- **B1. e2e farm** (`tests/e2e/farm-render.e2e.test.ts`, chạy khi `E2E=1`, `AG_RENDER_DIR` trỏ render worker có
  `e882a6c`): dựa vào case "renders three trimmed pieces with a dissolve and narration" có sẵn, thêm một case xuất
  Premiere của cùng timeline qua hub thật. Mở zip và kiểm tra:
  - `project.xml` có `<in>` khác 0 ở clip đầu, có `Cross Dissolve`, track A3 có đủ số dòng lời dẫn, A1 không có clip;
  - có `media/voice-*.wav` (`captions.srt` chỉ có khi timeline có phụ đề; case dùng lại timeline `captions: none`);
  - `premiere.json` hợp lệ với `PremiereManifestSchema`.
  Commit: `test(e2e): a shot-cut episode exports to Premiere through the real hub`.

## Nhóm C: kiểm bằng tay (người dùng, trên máy có Premiere)

- **C1.** Bật stack local (`node scripts/local-stack.mjs up`), dùng production có footage Hoa Lư. Xuất Premiere:
  1. một tập `whole` có nhạc, không lời dẫn (kiểm lại hai lỗi đã sửa: tiếng gốc −12 dB, nhạc đúng mức, có fade);
  2. một tập `cut` có lời dẫn và dissolve: proxy, rồi bản gốc.
  Mở trong Premiere và so với `final.mp4`: thứ tự clip, điểm cắt, chuyển cảnh, A1 trống, A3 lời dẫn khớp, ducking nhạc,
  marker chapter, nhập được `captions.srt`. Ghi kết quả (và ảnh chụp nếu lệch) vào cuối plan này.

## Nhóm D: tài liệu (một commit)

- ADR-0001 mục **171** "Premiere đọc timeline v4 (pha 4)", thay mục 159; ghi D1–D3 và cách chốt Q1. Mục **172** chỉ viết
  nếu Q1 chọn (b).
- `deferred-items.md`: đóng hai lỗi Premiere (✅, ghi commit render worker); bỏ phần Premiere khỏi dòng "Premiere/CapCut
  đọc `in`/`out`…" của pha 5, chỉ giữ CapCut (pha 6); thêm mục "Sau pha 4" cho việc còn lại (karaoke trong Premiere,
  hạn chế của XML FCP7).
- `docs/runbooks/studio-production.md:46`, `:69`: bỏ câu "không xuất Premiere cho tập cắt"; ghi thứ tự deploy (render
  worker trước Studio) và cách nhập `captions.srt`.
- `AGENTS.md` và `skills/README.md`: chỉ sửa nếu có nhắc pha 4.
- Commit: `docs: phase 4 — Premiere reads shot-cut episodes; ADR-0001 item 171, runbook, deferred items`.

## Nhóm E: merge và deploy (hỏi trước, Q2)

1. `ag-render-worker`: `dev-duc` → `main`, deploy lên các máy farm, xác nhận phiên bản trên từng node.
2. `ag-studio`: merge `feat/local-phase-4-premiere` vào `dev-duc` (rồi `dev`), deploy Studio sau bước 1.

## Kết thúc pha

`corepack pnpm -r run build`, `pnpm -r typecheck` sạch; `vitest run` không fail mới (hai test chập chờn đã biết thì
chạy riêng để xác nhận); `E2E=1` case B1 pass; C1 đạt. Cập nhật bảng pha trong spec: dòng 4 xong.
