# Kế hoạch: sửa theo phản hồi dùng thật trên VPS (chat 11–15/10)

Duyệt ngày 2026-10-15.

## Context

Đã đọc 16 luồng chat của 10 dự án trên VPS (bản `main`, SQLite) trong `E:\ag-local\vps-export`. Có 4 nhóm vấn đề:
- **A. Render và âm thanh:** video bị cắt, mất nhạc, lỗi `ENAMETOOLONG`, lệch phiên bản giữa Studio và farm.
- **B. Hạ tầng:** ag-go trả 503, ngập thông báo, `youtube_top_channels` lỗi 404, thiếu `transcribe.py`.
- **C. Công cụ dựng còn thiếu:** chữ, âm lượng từng clip, đường âm lượng nhạc, font, màu, dựng lại bị mất phần đã sửa.
- **D. Cách agent làm việc:** câu trả lời rỗng hoặc lặp, không xem được bản render, `timeline_get` trả quá to, tự chọn độ dài.

Mục tiêu: video render ra đúng như timeline, agent tự phát hiện lỗi của bản render, người dùng không phải sửa tay hay xuất Premiere cho những việc phổ biến.

Thay đổi trải trên 3 repo: `ag-studio`, `ag-render-worker`, `ag-farm` (chỉ phần protocol và hub). Mỗi repo làm trên `dev-duc`, mỗi task một commit. Thứ tự deploy giữ như cũ: farm → render worker → Studio.

## Nguyên nhân đã tìm được trong code

| Vấn đề | Nguyên nhân | Chỗ |
|---|---|---|
| Seoul "nhiều chỗ chưa có nhạc" | Khi `voice: original`, `audioGraph` luôn chạy `sidechaincompress` (ratio 6, ngưỡng 0.031), bỏ qua `ducking: false` và `duck.windows`. Nhạc -30 dB bị nén mất ở mọi cảnh phố ồn. | `packages/core/src/media/render/audio-graph.ts:118-121` |
| `spawn ENAMETOOLONG` khi có 73 clip | Toàn bộ filter graph và hàng trăm `-i` (body và tail) đi qua dòng lệnh, vượt giới hạn 32K ký tự của Windows | `packages/core/src/media/render/final-graph.ts:226` |
| Kiyomizu: timeline 17:27 nhưng render ra 13:23, đứng hình từ 13:21 | Chưa chắc. Giả thuyết chính: worker kẹp `seg.out` về độ dài đã đo (`render-handler.ts:273-288`) nhưng không đổi `start/end`. Khi đó body mezzanine (`mezzanine.ts:71`, `-t out-in`) ngắn hơn `segLen`, `xfade offset=accLen` (`final-graph.ts:201`) vượt độ dài luồng bên trái và xfade dừng. | cần tái hiện |
| Lỗi `text_style` unrecognized | Studio gửi trường mới cho máy render bản cũ (`CompositionSchema` strict). Farm không có cách chọn máy theo phiên bản render. | `ag-farm/packages/protocol/src/capabilities.ts` |
| Bản xem trước 13 phút nặng 1,58 GB (khoảng 16 Mbit/s) | Tier `preview` đã giới hạn 6 Mbit/s (`encoder.ts:40-52`), nên máy render trên prod đang chạy bản cũ | vận hành |
| Chữ Anh–Nhật đè nhau | Mọi chữ dùng `\an\pos` cố định theo vị trí (`ass.ts:86-105,171-175`). Hai chữ cùng vị trí, cùng lúc thì trùng toạ độ. Cỡ `callout` là 160 px ở 4K, tức 80 px ở 1080p, quá to. | `packages/core/src/media/ass.ts`, `core/src/studio/overlay.ts:36-41` |
| Dựng lại mất phần đã sửa | `edit-plan`: tối đa 30 chữ, chỉ cut/dissolve, không có trường nhạc hay tắt tiếng. `fit` lấy nhạc qua `musicForVideo` với mặc định -18 dB và bật ducking. | `contracts/src/studio.ts:942-976`, `studio-engine/src/workspace/fit.ts:210-221` |
| Agent nói "thư viện nhạc trống" | `music_list` chỉ liệt kê thư viện chung, không có nhạc của dự án hay video, không có `context/audio/`. Cũng không có tool gán nhạc cho video. | `agent/timeline-tools.ts:157-165` |
| 160 thông báo "Đã chuẩn bị…", agent bị đánh thức liên tục | Mỗi việc `prepare_asset` có `continueAgent: true` và tự gửi tin (`tellThread`) | `agent/input-tools.ts:157`, `workspace/job-runner.ts:249-259` |
| ag-go 503 | Số việc chạy cùng lúc tăng theo số máy farm rảnh, mỗi việc tải 8 ảnh song song, không có thử lại | `workspace/lanes.ts`, `workspace/prepare.ts:127` |
| `youtube_top_channels` lỗi 404 | `apiPlaylistIds` không bắt lỗi `playlistNotFound` | `workspace/youtube-crawl.ts:162-163,213` |
| 24 câu trả lời rỗng, một số câu lặp | Model chỉ viết câu "Bạn chọn…" hoặc viết lại sau `suggest_replies`. Runner ghép đủ chữ (`stream-json.ts:143`), nên không phải lỗi mất chữ. | `agent/tools.ts:133-137`, `agent/prompt.ts:31-32` |
| Thông báo `loudnorm_not_linear` ở mọi bản | Lượt chuẩn hoá thứ hai rơi về chế độ `dynamic` khi đỉnh vượt -1 dBTP | `core/src/media/render/run.ts:507-516` |

---

## Phase 1: Render đúng (nhóm A)

**1.1 Tái hiện lỗi bị cắt.**
- Viết script `scripts/repro-render.mjs`:
  - Đọc một `timeline.json` và `sources/index.json` từ bản export.
  - Tạo nguồn giả bằng lavfi `testsrc2` + `sine`, đúng độ dài từng asset.
  - Dùng `timelineToComposition` (`core/src/studio/render-plan.ts:89`) rồi `renderComposition` ở 640×360.
  - In độ dài từng luồng hình và tiếng của file ra.
- Chạy với Kiyomizu (`06075c28…/2eff9bda…/timeline.json`) và Seoul.
- Xác nhận hoặc bác giả thuyết `seg.out` bị kẹp. Script giữ lại để làm test hồi quy.

**1.2 Độ dài luôn khớp timeline.**
- Studio: `applyTimelineOps` và `fit` kẹp `clip.out` theo độ dài nguồn đã biết (shots.json của bước chuẩn bị) và báo cảnh báo `clip_out_clamped`. Nhờ vậy composition luôn khớp với file thật.
- `final-graph.ts`: mỗi body được đưa về đúng `segLen` bằng `tpad=stop_mode=clone` + `trim=duration`, để offset của xfade không bao giờ lệch.
- Worker (`render-handler.ts`): sau khi render, đo riêng độ dài luồng hình và luồng tiếng. Lệch hơn 0,5 giây so với `total_seconds` thì ghi cảnh báo `duration_mismatch:<mong đợi>:<thực tế>`. Studio coi cảnh báo này là lỗi: ghi rõ trong render note và trong tin nhắn báo xong.

**1.3 Ducking đúng cờ.**
- `render-plan.ts:127-132` ghi `duck.enabled = t.music.ducking`.
- `audio-graph.ts` chỉ chạy `sidechaincompress` khi `duck.enabled`.
- Hợp đồng `composition.ts` thêm trường tuỳ chọn, mặc định là `true` để giữ cách cũ. Test `audio-graph.test.ts`: ducking tắt thì không có `sidechaincompress` trong graph.

**1.4 Hết `ENAMETOOLONG`.**
- `run.ts` ghi filter graph ra file `graph.txt` trong thư mục làm việc rồi gọi:
  - `-filter_complex_script` với ffmpeg 7.x;
  - `-/filter_complex` với ffmpeg 8.x (đọc phiên bản đã dò).
- Đường dẫn mezzanine truyền dạng tương đối, đặt `cwd` là thư mục cache.
- Test: composition 400 đoạn có argv dưới 8.000 ký tự.

**1.5 Máy render bản cũ không nhận việc mới.**
- `@ag-studio/render` export `RENDER_FEATURE_LEVEL`, một số nguyên tăng mỗi lần composition có trường mới.
- `ag-farm` protocol:
  - Capabilities thêm `engines.studio_render` (tuỳ chọn).
  - Requirements thêm `studio_render_min`.
  - `meetsRequirements` kiểm điều kiện này. Hub phải lên trước, vì hub dùng `strictObject`.
- Render worker gửi level của mình trong heartbeat.
- Studio (`workspace/renders.ts`) đặt `studio_render_min` theo trường mà composition dùng.

**1.6 Bớt nhiễu `loudnorm_not_linear`.**
- Thêm `alimiter` trước loudnorm để lượt linear chạy được.
- Cảnh báo vẫn ghi trong `render.json`, nhưng không đưa vào tin nhắn hay render note nữa (`renders.ts:187,200`).

## Phase 2: Agent "xem" được bản render (nhóm D, phần chính)

**2.1 Worker tự kiểm bản render.**
- Sau khi upload, chạy một lượt ffmpeg trên bản đã thu nhỏ: `freezedetect`, `blackdetect`, `silencedetect`, và `ebur128` theo cửa sổ từng đoạn của composition.
- Tạo tờ ghép khung hình: một khung mỗi 10 giây, lưới 5×4, rộng 320 px.
- Upload `inspect.json` và `sheet-NN.jpg` cạnh `render.json`, khai trong manifest (`RenderManifestSchema` của ag-farm protocol, trường tuỳ chọn).

**2.2 Studio lưu và tóm tắt kết quả kiểm.**
- Job render tải các file đó về `videos/<id>/renders/<ngày>-<loại>-r<rev>/`.
- Render note và tin báo xong liệt kê vấn đề, ví dụ "đứng hình từ 13:21", "im lặng 12:00–12:40", "ngắn hơn timeline 244 giây", "clip C012 nhỏ hơn trung bình 9 dB".

**2.3 Tool `render_frames {video_id, at_seconds[≤12]}`.**
- Dùng lại job thumbnail (`queueThumbnails` trong `workspace/thumbnails.ts`) nhưng không vẽ chữ.
- Ghi ảnh vào `videos/<id>/renders/frames/` để agent mở bằng Read.
- Agent không cần mượn `thumbnail_make` với chữ "CHECK A" nữa.

## Phase 3: Sửa tool, prompt và job (nhóm D còn lại và nhóm B)

**3.1 Câu trả lời cuối lượt.**
- Kết quả của `suggest_replies` (`tools.ts:136`) đổi thành lời nhắc: "Nếu chưa tóm tắt lượt này (đã làm gì, file nào, kết quả, còn gì dở) thì viết ngay; nếu đã viết thì kết thúc, đừng viết lại."
- `prompt.ts` thêm quy tắc: câu trả lời cuối phải tự đủ nghĩa, và `suggest_replies` là việc cuối cùng của lượt.
- Ghi số lượt có câu trả lời mỏng (dưới 120 ký tự mà lượt có ghi file hoặc chạy job) vào audit log để theo dõi.

**3.2 `timeline_get` gọn hơn.**
- Mặc định `view: "overview"`: độ dài, số clip, các phần (khoảng clip, mốc giờ), nhạc, tiếng gốc, số chữ, lỗi.
- `view: "clips" | "texts"` có thêm `from_s/to_s` để đọc từng khúc.
- `view: "full"` khi thật cần.
- Hàm `timelineSummary` (`timeline-tools.ts:35`) tách thành các khung nhìn trên.

**3.3 Độ dài video.**
- Skill `video-brief` và prompt: người dùng chưa nói độ dài thì hỏi trước khi viết brief.
- `fit` báo độ dài thật so với `target_seconds`, lệch hơn 20% thì cảnh báo.

**3.4 Prompt đúng sự thật.**
- Nhạc ngắn hơn video sẽ tự lặp (`render-plan.ts:123 loop: true`), đừng bảo người dùng "nghe xem có im không".
- Cách mở bản xem trước, kèm link.
- Không giải thích cảnh báo kỹ thuật.

**3.5 Gộp thông báo chuẩn bị.**
- `queuePrepare` gắn `batch_id` vào `request` của từng job. Trường này là jsonb nên không cần migration.
- `tellThread`: còn job cùng batch đang chạy thì không gửi gì. Job cuối cùng gửi một tin tổng ("Đã chuẩn bị 14/14 · 2 lỗi: …") và là job duy nhất đánh thức agent.
- Giao diện vẫn gộp như hiện có (`MessageItem.tsx:116`).

**3.6 ag-go 503.**
- `prepare.ts` thử lại tối đa 3 lần (chờ 2, 5, 15 giây) khi gặp HTTP 429/502/503/504.
- `job-runner.ts` thêm giới hạn theo loại việc (`kindLimits`), `prepare_asset` mặc định 3, đặt bằng biến `STUDIO_PREPARE_LANES`.

**3.7 `youtube_top_channels`.** `apiPlaylistIds` bắt lỗi 404 `playlistNotFound` và trả mảng rỗng. Kênh đó vẫn có trong bảng, không có video.

**3.8 Tìm bản xem trước.**
- Tin báo render xong kèm link `/p/<pid>/v/<vid>?tab=preview` (route có ở `ProjectPage.tsx:65`).
- Component `Markdown` mở link nội bộ bằng router.
- Tab Xem trước báo rõ khi bản render đang chạy hoặc bị lỗi.

## Phase 4: Công cụ dựng (nhóm C)

**4.1 Chữ.**
- Nới giới hạn: chữ 64 → 120 ký tự, thời lượng 20 → 600 giây, `edit-plan.texts` 30 → 200. Sửa ở `contracts/src/studio.ts:334,613-615,968-973` và `studio-chat.ts:111-113`, rồi chạy `pnpm gen:schemas`.
- `buildAss` tự xếp chồng các chữ cùng vị trí trùng thời gian theo "slot". Slot sau đẩy lên (vị trí dưới) hoặc đẩy xuống (vị trí trên) một khoảng bằng chiều cao dòng nhân số dòng. Cách xếp cố định, có test.
- Mỗi chữ có thể có `size: s|m|l` riêng.
- `text_look` thêm `shadow`.
- Giảm cỡ mặc định của `callout`.
- Tăng `RENDER_FEATURE_LEVEL`.

**4.2 Font.**
- `text_look.font` chọn trong danh sách cố định: Arial (mặc định) và các font OFL đóng kèm bản phát hành của render worker: Be Vietnam Pro, Noto Sans JP, Noto Sans KR, Noto Serif, Playfair Display.
- `fonts.ts` của worker chuẩn bị `fontsdir`.
- Skill branding liệt kê các font này.
- Việc này cũng sửa lỗi chữ Nhật/Hàn hiển thị nhờ font dự phòng.

**4.3 Âm thanh.**
- **Âm lượng từng clip:** clip có `gain_db`, thêm op `setClipGain` và `shots[].gain_db` trong edit-plan, xuống composition thành `segment.gain_db`, áp `volume` theo đoạn trong `audio-graph.ts:80`.
- **Đều tiếng gốc:** `source_audio.even: true`. Worker đo độ to từng mezzanine (`ebur128`, lưu cache cạnh mezz) và bù về một mức chung, giới hạn ±12 dB.
- **Đường âm lượng nhạc:** `music.envelope: [{at, gain_db}]`, op `setMusicEnvelope`, và `music_envelope` trong edit-plan neo theo `at_order/offset_s`. Render bằng `volume=eval=frame` nội suy tuyến tính.

**4.4 Edit-plan giữ đủ những gì timeline có.**
- `transition` thêm `dip_black` và `transition_s`.
- Thêm `music: {gain_db, ducking}` và `source_muted`, cùng các trường của 4.1 và 4.3.
- `fit` mang tất cả sang timeline. Op `setMusic` cũng lưu gain và ducking vào nhạc của video (`setVideoLibraryMusic` / `ProductionMusic`), nên dựng lại không về -18 dB nữa.

**4.5 Nhạc.**
- `music_list` trả cả nhạc đang gán cho video và dự án (`musicForVideo`, `videoMusicSummary` trong `project-audio.ts`) và các file trong `context/audio/` (`projectAudioFiles`).
- Tool mới `music_set {files[], crossfade_s, gain_db, ducking, scope: video|project}` dùng `importVideoMusic` / `importProjectMusic` (`prepareMusicMix` đã có trong `audio-import.ts:178`).

**4.6 Màu.**
- Timeline có `look: none|natural|vivid|warm|cinematic`, một preset `eq`/`curves` trong chuỗi mezzanine (`mezzanine.ts:76`).
- Khoá cache mezz tính cả `look`.
- Edit-plan và branding có `look`.

**4.7 Cắt theo nhịp nhạc (làm sau cùng).**
- Job python trên render worker (librosa) phân tích BPM và các phách khi nhạc được nhập, lưu cạnh track.
- `shots[].snap: "beat" | "bar"`. `fit` dời điểm cắt về phách gần nhất, mỗi cảnh vẫn tôn trọng độ dài tối thiểu.

## Phase 5: Vận hành (nhóm B)

- Render worker tự kiểm khi khởi động: có các file engine python (`transcribe.py`, `tts.py`) và các font. Thiếu thì ghi log lỗi và không nhận việc cần python.
- Runbook: kiểm mọi máy render đã lên bản mới (tier preview, feature level) sau mỗi lần phát hành. Lệnh sẽ đưa cho người dùng tự chạy.

---

## Thứ tự làm và phát hành

1. **Đợt 1:** Phase 1 (1.1 → 1.6), 3.1, 3.5, 3.6, 3.7. Sửa lỗi và chặn lặp lại. Phát hành: farm hub → worker → Studio.
2. **Đợt 2:** Phase 2 và các mục còn lại của Phase 3.
3. **Đợt 3:** Phase 4 (4.1 → 4.6) và Phase 5.
4. **Đợt 4:** 4.7 (tuỳ chọn).

Mỗi trường mới của composition đi kèm việc tăng `RENDER_FEATURE_LEVEL` (1.5), nên máy render cũ không bao giờ nhận job mà nó không hiểu.

## Kiểm tra

- **Unit test:**
  - `pnpm vitest run packages/core` (audio-graph, final-graph, ass, render-plan);
  - `packages/contracts` (sau `pnpm gen:schemas`);
  - `packages/studio-engine` (timeline-tools, input-tools, job-runner, youtube-crawl, fit);
  - test của `ag-render-worker` (render-handler, inspect);
  - `ag-farm` protocol (capabilities).
- **Tái hiện:** `node scripts/repro-render.mjs` với timeline Kiyomizu và Seoul trong bản export. Độ dài ra bằng `total_seconds` (±0,1 giây); `inspect.json` không có `freeze` ở cuối; Seoul có nhạc nghe được suốt video (`silencedetect` trên nhạc tách riêng).
- **E2E:** `E2E=1 pnpm vitest run tests/e2e`, chạy hub, API và render worker thật.
- **Chạy local:** `node scripts/local-stack.mjs up`, rồi chat thử trong khung xem trước:
  - chuẩn bị 14 clip: chỉ 1 tin tổng, không có 503;
  - render có chữ song ngữ: không đè nhau;
  - `music_set` từ `context/audio`;
  - `render_frames`;
  - câu trả lời có tóm tắt.
