# Review đợt 1–4 của kế hoạch feedback-vps (2026-10-16)

Kế hoạch được review: `docs/superpowers/plans/2026-10-15-ag-studio-feedback-vps.md`. Mọi thay đổi nằm trên `dev-duc`,
**chưa push**.

## Phạm vi đã review

| Repo | Khoảng commit | Số commit |
|---|---|---|
| ag-studio | `06c0efb..2aa48ba` (từ sau commit Postgres tới hết đợt 4) | 26 |
| ag-render-worker | `70802e5..41c72de` (0.9.1 → 0.13.0, mọi commit ngày 2026-10-15) | 9 |
| ag-farm | `45cdfbf..0db87cd` (mọi commit ngày 2026-10-15) | 3 |

Các commit sửa trong lần review này nằm trên đầu `dev-duc` của ag-studio (`2aa48ba..HEAD`). ag-render-worker và
ag-farm không có commit sửa nào.

## Kết quả chạy lại

| Kiểm tra | Kết quả |
|---|---|
| ag-studio `pnpm install`, `pnpm build`, `pnpm -r typecheck` | sạch |
| ag-studio `pnpm gen:schemas` | không có diff |
| ag-studio `pnpm test` (trước khi sửa) | 290 file, 2110 pass, 17 skip (E2E) |
| ag-studio `pnpm -r typecheck` + `pnpm test` (sau khi sửa) | sạch; 290 file, 2117 pass, 17 skip |
| ag-render-worker `yarn test`, `yarn typecheck` | 150/150, sạch |
| ag-farm `yarn test`, `yarn typecheck` | protocol 106, owner-client 17, worker-sdk 89, api 80, web 91; typecheck sạch. Hai test hỏng khi máy bận (`releases.spec.ts` ECONNRESET, `nodes-page.test.tsx` timeout 5 s), chạy lại riêng thì pass. Cả hai file nằm ngoài phạm vi review. |
| `E2E=1 pnpm vitest run tests/e2e` (hub, API, render worker thật) | 10/10 sau khi sửa test (`50de8ca`). Trước đó 9/10: test xuất Premiere gọi `zipEntries`, hàm bị xoá ở `6b7466b` (trước phạm vi review). |
| `scripts/repro-render.mjs` Kiyomizu (145 đoạn, 5 dissolve) | video 1050 / audio 1050 / timeline 1049,98 s, không đứng hình, không vấn đề |
| `scripts/repro-render.mjs` Seoul (93 đoạn, `voice: original`, nhạc −30 dB không ducking) | 997,6 / 997,6 / 997,6 s, không đứng hình. Dải nhạc 220 Hz đo theo cửa sổ 10 s: −46…−48 dB suốt 100 cửa sổ, không bị nén mất. Lượt kiểm báo nhầm 2 clip tắt tiếng là "nhỏ hơn 30 dB": đã sửa (`ea1ce69`). |
| Seoul lại, sau khi sửa, bằng **ffmpeg 6.1.1 của render worker** (`ffmpeg-static`, đường `-filter_complex_script`) | 997,6 / 997,6 / 997,6 s, không vấn đề nào, 5 tờ ghép (trước khi sửa: 499) |

### Thử thật trên local stack

Farm hub, Studio API/worker và render worker 0.13.0 (khai `studio_render` 6) khởi động lại từ code đã sửa. Claude thật,
dự án "Du lịch Ninh Bình".

- **`music_set` từ `context/audio`**, −20 dB, tắt ducking: timeline bản mới phát nhạc. Job `music_beats` → farm
  `studio.beats` đo ≈ 96 BPM.
- **Chữ song ngữ** "Bến thuyền Tràng An" (m) và "Trang An boat pier" (s), cùng `bottom_left`, cùng 3–8 s: render xem
  trước 150 s khớp timeline. Lượt kiểm không thấy vấn đề, 1 tờ ghép. Tin báo xong có link tab Xem trước.
- **`render_frames`** ở 5 s và 60 s: khung 5 s cho thấy hai chữ xếp chồng, không đè. Agent tự mở ảnh và trả lời có
  tóm tắt đủ bốn bước.
- **Chuẩn bị theo lô**: agent tạo video mới, thêm 6 video ag-go chưa chuẩn bị. Có 6 job cùng một `batch_id`, chạy tối
  đa 3 cùng lúc (`STUDIO_PREPARE_LANES`). Luồng chỉ nhận **một** tin "Đã chuẩn bị 6/6." và đúng một lượt agent.
- **Snap bar**: "Dựng lại từ kế hoạch" của video "Thử cắt theo nhịp: intro 30 s" đọc nhịp đã lưu, không gửi farm lại.
  8 điểm cắt về đầu ô nhịp, giống kết quả đợt 4.

Video thử: "Thử chuẩn bị loạt" (`ea1b26ef-…`). Hai chữ thử nằm trong timeline bản 3 của "Lần đầu đến Tràng An". Có
thể xoá hoặc lùi bản.

## Đã sửa trong lần review này (ag-studio, mỗi lỗi một commit có test)

| Commit | Mức | Lỗi | Tái hiện trước khi sửa |
|---|---|---|---|
| `b4c5181` | **chặn** | Lượt kiểm render ghi tờ ghép với `-fps_mode` mặc định (cfr), nên muxer ảnh lặp lại tờ cuối cho mỗi khung phân tích. Video 17,5 phút ra **599** `sheet-NN.jpg` thay vì 6. Máy render upload hết số ảnh đó, Studio chép hết vào `videos/<id>/renders/<ghi chú>/`. Bị cả ffmpeg 6.1.1 của worker lẫn ffmpeg 9. Sửa ở `packages/core/src/media/render/inspect.ts:68` (`-fps_mode passthrough`). | `repro-render.mjs` Kiyomizu → `sheets: 599`. Video dưới 200 s chỉ có 1 tờ nên trước đây không lộ. |
| `ea1ce69` | nên sửa | `clip_loudness` so cả clip đã `muted` (chỉ còn nhạc) và clip có `gain_db` cố ý với trung vị, nên ghi chú render và tin báo nói "clip … nhỏ hơn 30 dB". Agent dễ "sửa" ngược lại thao tác của người dùng. Nay clip tắt tiếng không đem so, clip có gain so với mức mà gain đó đặt ra, trung vị chỉ tính các clip giữ nguyên tiếng (`inspect.ts`, `inspectionIssues(f, intent)`). | Seoul: đoạn 50–51 (`muted`) báo −30,2 và −24,6 dB. |
| `88536dd` | nên sửa | Lô chuẩn bị không báo tin tổng khi job cuối của lô kết thúc ngoài runner: bị dừng lúc còn trong hàng (`requestJobCancel`) hoặc bị `requeueStaleJobs` đánh failed. Các job xong trước đều thấy "lô còn chạy" nên im, agent cũng không được đánh thức. Nay vòng `pass` của runner quét các lô đã hết mà chưa báo (`tellEndedBatches`, `job-runner.ts`). Lô mà không job nào chạy thì im. | Lô 2 job, A xong, B bị dừng khi còn queued → luồng 0 tin. |
| `945f35b` | nên sửa | `timeline_get view:"texts"` phân trang theo thứ tự thêm chữ, không theo thời điểm phát, nên `next_from_s` có thể chỉ ngược về trang đã đọc và agent lặp mãi một trang (`timeline-tools.ts:80`). | 130 chữ, chữ thứ 121 ở giây 5 → trang 2 lại trả `next_from_s: 5`. |
| `b8f8fe2` | nên sửa | Hai lỗi của `render_frames`. Một: cắt lại cùng một giây, hoặc hai giây quá cuối video (cùng bị kẹp về khung cuối), làm job hỏng vì file đã có (`baseSha256: null`). Hai: cả file render, có thể là bản cuối nhiều GB, bị đọc vào RAM (`bucket.get`). Nay khử trùng sau khi kẹp, ghi đè khung cũ, tải bằng `getFile` (stream ra đĩa). Thumbnail dùng chung đường tải này. | `render_frames [10]` hai lần → lần 2 failed. |
| `10beea0` | nên sửa | `fit` có `snap` gửi `studio.beats` với timeout hàng đợi của render (`STUDIO_FARM_QUEUE_TIMEOUT_MINUTES`, mặc định 120). Không máy nào chạy beats thì fit giữ một lane 2 giờ. Nay chờ tối đa 5 phút (`FIT_BEATS_QUEUE_TIMEOUT_MS`) rồi giữ nguyên điểm cắt. | Farm không nhận job → fit treo. |
| `2a9d3cd` | nên sửa | `music_set` với `gain_db` khi timeline đã có `music.envelope`: render bỏ qua `gain_db` (`audio-graph.ts:163`) nhưng tool vẫn báo đã phát nhạc mới. Nay kết quả có `warning` chỉ sang `setMusicEnvelope`, mô tả tool cũng nói rõ. | Test music_set có sẵn với timeline có envelope. |
| `5ddd15c` | nên sửa | Render chờ máy đạt mức render (`studio_render_min`) quá hạn thì báo "máy có thể đang tắt". Khi Studio lên trước render worker, đây là thông báo sai cho mọi bản render. Nay câu báo có thêm "hoặc chưa máy nào lên bản render worker đạt mức render ≥ N". | `runFarmStep` với `requirements.studio_render_min: 6`. |
| `50de8ca` | (test) | E2E Premiere gọi hàm `zipEntries` đã bị xoá. | `E2E=1` → ReferenceError. |

## Lỗi chặn còn lại

Không còn, với điều kiện deploy đúng thứ tự farm hub → render worker (build sau các commit sửa ở trên) → Studio.

Hai điều kiện để bản sửa tờ ghép (`b4c5181`) thật sự lên máy render:
- Gói render worker 0.13.0 phải đóng từ ag-studio **sau** commit này, vì worker dùng `@harness/core` qua `link:` và
  esbuild gói từ `dist`.
- Phải chạy `pnpm build` ở ag-studio trước `release.mjs`.

0.13.0 chưa phát hành nên chưa cần tăng phiên bản.

## Nên sửa (chưa làm: cần quyết định hoặc việc lớn hơn)

Về pipeline render (`final-graph`, `audio-graph`, `ass`, `mezzanine`, `run`), không thấy lỗi nào ngoài hai lỗi lượt
kiểm đã sửa ở trên:
- Repro chạy được trên cả ffmpeg 9.0.1 (đường `-/filter_complex`) lẫn 6.1.1 của worker (đường
  `-filter_complex_script`).
- `compositionFeatureLevel` phủ đủ mọi trường mới của `CompositionSchema`: `duck.enabled`, `size`, `shadow`, `font`,
  `gain_db`, `source_even`, `envelope`, `look`.
- `timelineToComposition` chỉ thêm khoá khi có dùng (ducking bật, `look: none`, không gain), nên composition không dùng
  tính năng mới chỉ cần mức 2.
- Lượt review riêng phần này bằng agent phụ không trả kết quả trong 2 giờ nên đã dừng. ASS xếp chồng và `beats.py` mới
  được kiểm qua chạy thật (khung hình, snap), chưa đọc kỹ từng dòng.

1. **Lệch phiên bản giữa 3 repo làm hỏng hàng loạt.**
   - **Hub cũ + worker 0.13.0:** heartbeat bị từ chối vì `engines.studio_render` vấp `strictObject` và `kinds` có
     `studio.beats` vấp enum. Máy rớt khỏi farm. Nếu phát hành 0.13.0 lên hub cũ, mọi máy tự cập nhật xong sẽ offline.
   - **Hub cũ + Studio mới:** submit bị từ chối.
   - **Studio mới + worker cũ:** mọi bản xem trước và bản cuối có `studio_render_min ≥ 2` (vì luôn có `inspect: true`),
     nên chờ tới timeout. Từ `5ddd15c`, thông báo lúc đó đã nói đúng lý do.
   - Đề xuất: `release.mjs --publish` hỏi phiên bản hoặc schema của hub trước khi đẩy. Trước mắt, giữ đúng thứ tự deploy.
2. **Build phụ thuộc `dist` của repo bên cạnh mà không kiểm.**
   - ag-studio dùng `@ag-farm/protocol` qua `link:`. ag-render-worker dùng `link:` tới ag-farm và tới
     ag-studio (`render`, `core`, `contracts`).
   - Nếu `dist` của core mới (mức 6) nhưng `dist` của contracts cũ, máy khai mức 6 mà vẫn từ chối `look`.
   - Đề xuất: `release.mjs` kiểm mtime giữa `src` và `dist` của các gói link, hoặc tự build trước khi đóng gói.
3. **Mức render là một con số tuyến tính** (`ag-render-worker/src/self-check.ts`).
   - Máy thiếu font khai mức 3, nên cũng không nhận composition mức 5/6 (gain, đều tiếng, envelope, look), dù các
     composition đó không cần font.
   - `look` lấy từ branding nên dễ thành mặc định của cả kênh.
   - Rủi ro thấp, vì `release.mjs` không đóng được gói thiếu font.
   - Đề xuất lâu dài: thay con số bằng một tập tính năng, hoặc thêm cờ `engines.studio_fonts` riêng.
4. **`studio.beats` đòi `python: true`, tức là máy import được torch** (`ag-farm/packages/protocol/src/jobs/registry.ts:98`).
   - Installer chỉ cài venv và requirements trên máy có GPU. Vậy máy chỉ có CPU không bao giờ nhận beats, dù librosa
     không cần GPU.
   - Prod cần ít nhất một máy GPU online thì `music_beats` và snap mới chạy. Không có thì fit chờ 5 phút rồi giữ điểm
     cắt (sau `10beea0`).
5. **Retry khi gọi ag-go** (`packages/studio-engine/src/workspace/prepare.ts`).
   - Không đọc header `Retry-After`.
   - 8 luồng tải ảnh retry cùng nhịp 2/5/15 s, không có jitter.
   - POST `preps.run` bị gửi lại khi gặp 502/504: cần xác nhận phía ag-go xử lý idempotent.
   - Lỗi mạng (ECONNRESET) không được retry.
6. **`timeline_get view:"overview"` không giới hạn `issues` và `sections`.**
   - Timeline 400 clip có dùng lại đoạn sinh khoảng 1.800 cảnh báo "dùng chung một đoạn" (số cặp tăng theo bình
     phương), nên overview nặng khoảng 142 KB.
   - JSON của tool in kèm thụt dòng: thêm chừng 50% token.
   - Đề xuất: chặn khoảng 30 issue kèm số đếm theo mã, in JSON gọn.
7. **`setMusic` với track `library:…` lạ được lưu bền thành nhạc riêng của video** (`keepVideoMusicLevels`,
   `project-audio.ts`).
   - Agent có thể trỏ tới `library:studio/projects/<dự án khác>/music/<sha>.m4a`, và máy render sẽ đọc file đó.
   - Cần biết sha nên rủi ro thấp.
   - Đề xuất: chỉ nhận track của thư viện, của dự án hoặc của video hiện tại.

## Gợi ý

- `music_set` dùng `statSync`, tức đi theo symlink trong `context/audio/` (`project-audio.ts:58`), trong khi API dùng
  `resolveInside`. Agent không tạo được symlink, nhưng workspace đồng bộ từ ngoài thì có thể có.
- `fit` tính `seconds` và cảnh báo lệch >20% bằng tổng `out−in`, không trừ phần chồng của dissolve (`fit.ts:294`). Chỉ
  lệch đáng kể khi có rất nhiều dissolve dài.
- `queueMusicBeats` đọc rồi ghi ngoài `db.tx`, nên hai lần chọn nhạc cùng lúc có thể tạo hai job.
- `musicBeatsStatus` không truyền `sha256`: bài thư viện bị thay nội dung mà giữ tên thì vẫn báo BPM cũ.
- `videos/<id>/renders/frames/` không bao giờ được dọn.
- `beats-handler.ts:96` (ag-render-worker) để `engine.version: null`, phiên bản nằm trong `name`.
- `youtube-crawl.ts`: 404 đã xử lý. 403 `playlistItemsNotAccessible` hay 5xx của một kênh vẫn làm hỏng cả
  `top_channels`.
- AGENTS.md còn nhắc migration `0030`–`0041` của đời SQLite. Từ commit Postgres chỉ còn `0001_baseline`, `0002_…`.
- Tin "Đã phân tích nhịp nhạc nền …" của job `music_beats` vẫn được đăng vào luồng (không đánh thức agent). Nếu thấy
  nhiễu thì bỏ.

Đã kiểm, không có lỗi:
- Ví dụ JSON trong skill `edit-plan` đều parse được bằng schema thật.
- Tool mới có trong `agentTools()` và có nhãn `ws.tool.*` ở cả vi lẫn en.
- `music_set`, `render_frames`, `timeline_get` đều kiểm video thuộc dự án. `music_set` cần vai editor.
- Allowlist `projectAudioFiles` chặn `..`, đường tuyệt đối, `.studio/` và file của dự án khác. Tham số ffmpeg truyền
  dạng mảng, chỉ có số và đường đã qua allowlist.
- Link `javascript:` trong Markdown không bấm được.
- Hai lane xong cùng lúc chỉ ra đúng một tin tổng.
- `partStarts` an toàn, vì `prepareMusicMix` buộc crossfade ngắn hơn nửa mỗi bài.
- Migration Studio `0002`: chạy trên PGlite. Ràng buộc `project_jobs_kind_check` là tên Postgres tự đặt, nên
  `DROP IF EXISTS`/`ADD` đúng.
- Migration ag-farm `2400`: đánh số nối tiếp, đăng ký ở cả `app.module.ts` lẫn `data-source.ts`, có up/down.
- `meetsRequirements` coi máy không khai `studio_render` là mức 0, nên máy cũ không nhận job mới.

## Tài liệu deploy

Đã có:
- `.env.example`: `STUDIO_PREPARE_LANES`, biến mới duy nhất (tuỳ chọn, mặc định 3).
- README của ag-render-worker:
  - mục "Phát hành bản mới": font, `fetch-fonts.mjs --pin`, release tự tải và kiểm sha256;
  - mục "Kiểm các máy sau mỗi lần phát hành": `studio_render`, python, kinds;
  - mục tự kiểm khi khởi động.
- `docs/runbooks/studio-local.md`: migration và script chép SQLite.
- `docs/superpowers/plans/2026-10-14-ag-studio-postgres.md`: mục "Cắt chuyển trên VPS".

Còn thiếu:
- Repo chưa có một chỗ ghi thứ tự deploy của đợt này. Thứ tự nằm trong ghi chú các phiên và trong lệnh dưới đây.
- `fonts.json` đã ghim sha256 (`c576eb5`). Không cần chạy `fetch-fonts.mjs --pin` nữa: `release.mjs` tự tải và kiểm.

### Thứ tự và lệnh (người dùng tự chạy)

Prod hiện chạy `main` + SQLite. Studio từ `dev-duc` **đổi sang Postgres** (`06c0efb`), nên bước 3 gồm cả cắt chuyển dữ
liệu. Bước 3 chỉ làm khi bước 2 đã xong trên mọi máy render.

1. **ag-farm hub**: merge `dev-duc` vào `main`, rồi trên VPS chạy `deploy.sh`. Script này chạy migration
   `2400000000000-studio-beats` trước khi thay api.
2. **Render worker 0.13.0**, trên máy build Windows. Build ag-farm và ag-studio trước, vì worker gói `dist` của chúng.
   Khoảng 20 phút sau khi phát hành, kiểm các máy theo README: `agent_version` 0.13.0, `studio_render` 6, máy GPU có
   `python` và `studio.beats` trong `kinds`.
3. **Studio**: tạo database và user trên Postgres có sẵn, điền `DATABASE_URL` (và `DATABASE_SCHEMA` nếu cần) vào `.env`
   của VPS. Dừng api và worker, sao lưu `studio.db`, merge `dev-duc` vào `main`, chạy `deploy.sh`. API tự migrate
   `0001`, `0002`. Sau đó chép dữ liệu bằng `migrate-sqlite-to-pg.mjs` trong container rồi kiểm. Checkout `../ag-farm`
   trên VPS phải là bản của bước 1, vì Studio build kèm `@ag-farm/protocol`.

Lệnh cụ thể ở tóm tắt cuối của phiên review (PowerShell không có `&&`).
