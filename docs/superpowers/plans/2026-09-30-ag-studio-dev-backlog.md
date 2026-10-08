# Plan: các việc còn dở của hệ thống dựng video AG trên máy dev (từ 2026-09-30)

## Context

Luồng quét đã chạy thật trên máy dev (project Test: 6 file, 18/18 đoạn có mô tả). Studio chưa chạy production thật lần nào. Plan này xếp 8 nhóm việc user nêu theo thứ tự nên làm. Mỗi việc có mục tiêu, repo/file, cách kiểm, rủi ro và chỗ user cần quyết. **Chưa sửa code, chưa chạy lệnh có tác dụng phụ cho tới khi user duyệt.**

### Trạng thái lúc lập plan (chỉ đọc, 11:30 ngày 30/09)

- **Docker:**
  - ag-go: api 3737, worker-io, worker-media; image build 09:04 từ `3aa9548`. ag-go-web 5173.
  - Account API local 8080, client 3000.
  - farm: api 3010, web 3011.
  - Studio: api (healthy), worker, web 3100.
  - Hạ tầng: postgres16, redis (có mật khẩu), mariadb.
- **Worker:**
  - `local-scan` và `local-render` online (heartbeat 11:29). Log dừng ở 10:48, lúc farm api bị recreate; worker vẫn claim bình thường.
  - `lan-scan` chưa heartbeat lần nào.
  - `sign_url` của 2 owner đã là `192.168.1.2`.
  - Có một tiến trình `e2e-worker` (hub `127.0.0.1:3978`), có thể của chat kia. **Không đụng.**
- **Farm:** `scan.extract` 13 completed, 10 failed (từ các lỗi đã sửa); `scan.ai` 9 completed.
- **Giọng:** chưa có `E:\ag-local\voice.wav`, `voice.txt`. `.env` Studio chưa có `STUDIO_DEFAULT_VOICE_*`.
- **Git:**
  - ag-farm `main` ahead 3 (`c13913d`, `7df9f8b`, `3f93086`). `.gitignore` có dòng `.history` của user, không commit.
  - ag-studio `main` ahead 2 (`8388ec3`, `f3d90ad`).
  - Đã khớp origin: ag-scan-worker, ag-render-worker, ag-go-api `feat/footage` `3aa9548` và `feat/media-analysis` `458d619`, ag-go-web `feat/footage` `8f08497`, ag-account-server `feat/user-access` `64b346f`.
- **Dữ liệu ag-go local:** 6 project, 86 asset. Ngoài Test chỉ có 5 project "Phố cổ Hoa Lư" (78 file, chưa quét). **Không có footage Ẩm thực ở local.**
- **Doc tổng hợp:** không tìm thấy comment nào. Đã kiểm cả 3 tab bằng docs tools (theo tab và theo body) và kiểm comment cấp artifact. → Nhờ user kiểm lại comment đã được lưu chưa.

### Lỗi mới phát hiện khi đọc code (chưa có trong memory)

1. **Một lần quét lại hỏng thay mất bản quét tốt.** Chunk `scan.ai` lỗi toàn bộ đoạn vẫn báo `completed`. ag-go `finalizeIfDone` tắt `is_current` của bản cũ rồi bật bản mới không có mô tả nào.
   - `ag-scan-worker/src/scan-ai.ts:268-293`
   - `ag-go-api/src/modules/analysis/farm-result-poller.service.ts:282, 360-416`
2. **Worker quét không dùng Ollama ở máy khác được.** `extra.ollama_url` không có tác dụng (`scan-ai.ts:170`, `main.ts:34-41`), dù README ghi là có.
3. **Trình chấm golden set hỏng.** `src/eval/run_golden.ts` vẫn gửi ảnh kiểu OpenAI nên Ollama trả 400. Prompt cũng khác bản chạy thật.
4. **Sửa `kinds` của node trên web farm không có tác dụng.** Heartbeat ghi đè bằng `config.kinds`; claim không đối chiếu `node.kinds` (`worker.service.ts:70, 108`).
5. **ag-go không gửi `requirements.ollama_models`.** Node không có model vẫn nhận `scan.ai`. Model cũng không nằm trong phiên bản analysis: đổi `ANALYSIS_MODEL` không làm quét lại.
6. **Ai đăng nhập cũng xem được thành viên của mọi team.** `GET /api/teams/:teamId/members` của Studio thiếu `@Roles` (`apps/api/src/teams/teams.controller.ts:39-42`).
7. **Mezz cache của render-worker có lỗi ẩn.** `max_bytes` được truyền vào chỗ cần `maxBytes` (`render-handler.ts:45-48`) nên cache bị xoá sạch sau mỗi lần render. Hiện chưa gây hại vì thư mục cache theo job.
8. **Regex nhận biết hết hạn mức Claude bỏ sót mẫu câu.** Không khớp "You’ve" (dấu nháy cong) và "usage limit reached" (`cli-agent-runtime.ts:54`).

---

## Quy tắc thực hiện (áp dụng mọi bước)

- Bí mật chỉ dùng qua script trong `E:\ag-local\setup` hoặc qua env sẵn trong container. Không in token, secret hay nội dung `.env`/`secrets.json`; lệnh kiểm chỉ in tên khoá hoặc `ok`.
- Không nhập mật khẩu vào Auth0. User tự đăng nhập trong browser pane.
- Phải hỏi trước khi push, mở PR, merge, SSH/deploy VPS, đổi hạ tầng dùng chung (Redis, Auth0, R2) và đổi hợp đồng hoặc hành vi của ag-farm.
- Không đụng node `lan-scan`, `E:\ag-local\lan-scan`, `farm_owners.sign_url` và worker quét của chat kia.
- ag-go-api, ag-go-web, ag-account-server: chỉ sửa đúng các mục user duyệt trong plan này.
- Đầu mỗi phiên làm việc:
  - `git log` ag-studio `main`, vì phiên khác có thể commit song song;
  - kiểm cổng 3978, 3979, 55433 còn trống trước khi chạy E2E quét, để không đụng E2E của chat kia.
- Sau mỗi agent con: tự chạy lại test/E2E của repo đó. Trước khi báo xong: chạy full suite theo phần Verification.
- Cuối cùng: cập nhật memory `ag-video-platform-open-issues` và `ag-video-platform-rollout`.

## Thứ tự đề xuất

| # | Việc | Chặn bởi | Công |
|---|---|---|---|
| **0** | **Chạy thử luồng trên web Studio: workflow ghép video (không lời dẫn) + Claude giả + sửa giao diện tối thiểu (user chốt 30/09)** | — | 0a: 1 ngày · 0b: 1,5–2 ngày |
| 1 | Giọng đọc mặc định | Để sau: user đã bỏ giọng đọc ở giai đoạn này | 1 giờ |
| 2 | Production Studio thật đầu tiên (Claude thật, 2 lượt) | Bước 0 chạy ổn; user đồng ý | 0,5 ngày (gồm sửa lỗi lộ ra) |
| 3 | Cập nhật tab "Chạy thử trên máy dev" | — (làm ngay trong lúc chờ bước 1; bổ sung kết quả bước 2) | 0,5 ngày |
| 4 | Sửa lỗi và thiếu sót mục 4 (8 việc + lỗi mới) | Một số việc cần user quyết | 9–10 ngày |
| 5 | Chọn model quét (golden set) | `lan-scan` online; 4.1 xong; user gán nhãn | 2 ngày + 0,5–1 ngày gán nhãn |
| 6 | Kiểm với hệ thống thật | Bước 1, 2, 5; tài khoản thứ hai; VPS | Theo từng mục |
| 7 | Việc chưa làm theo plan gốc (6 mốc) | Sau khi demo có phản hồi | 26–37 ngày (20–27 nếu để M-E, M-F sau) |
| 8 | Push và PR | User duyệt từng lần | — |

Sau bước 0 (trong lúc user chạy thử): làm bước 3, rồi các việc 4.1, 4.2, 4.3 (không phụ thuộc Studio).

### Thời gian dự kiến

"Ngày công" là một ngày làm việc: Claude viết code và chạy test, user xem và duyệt.

| Giai đoạn | Gồm | Ngày công | Chờ ngoài |
|---|---|---|---|
| 0. Chạy thử luồng trên web | Bước 0a + 0b | 2,5–3 (user tự chạy thử được sau 0a, khoảng 1 ngày) | User đăng nhập web Studio |
| A. Demo trên máy dev | Bước 2, 3 + 4.1–4.3 | 2–2,5 | User đồng ý chạy Claude thật và đăng nhập tài khoản demo |
| B. Hoàn thiện mục 4 | 4.4–4.8 + việc nhỏ kèm theo | 7–8 | Quyết định 4.6 (sửa Account API) |
| C. Chọn model + kiểm trên máy dev | Bước 5 + phần local của bước 6 | 3–4 | `lan-scan` online; user gán nhãn 0,5–1 ngày; tài khoản thứ hai |
| D. VPS + brief Ẩm thực | Phần VPS của bước 6 + bước 8 | Claude 1–2 | Team làm Auth0, Account, DB, R2, máy GPU (1–2 ngày); review và merge PR |
| E. Mốc plan gốc | Bước 7 | 26–37 (20–27 nếu để M-E, M-F sau) | Phản hồi sau demo |

- **Bước 0–6 (0, A–D):** khoảng 16–19 ngày công, tức 3–4 tuần lịch khi tính cả thời gian chờ.
- **Nếu làm hết cả bước 7:** thêm khoảng 5–7 tuần.
- **Riêng lần chạy production ở bước 2:** 20–40 phút máy chạy nếu không lỗi (2 lượt Claude, render trên P1000). Số giờ sửa lỗi tích hợp lộ ra là phần khó đoán nhất; lần chạy quét thật trước đó lộ 6 lỗi.

---

## 0. Chạy thử luồng trên web Studio (ưu tiên ngay)

**Mục tiêu.** User tự chạy hết luồng trên web Studio (`http://localhost:3100`), từ tạo production tới tải MP4/SRT, nhiều lần mà không tốn hạn mức Claude và không cần giọng thật.

**Những gì đã có sẵn:**
- Web đã có đủ luồng: tạo team và production (chọn folder), Chạy, danh sách stage có chạy lại và chạy lại từ bước này, 3 gate, editor, xuất file.
- Worker `local-scan` và `local-render` online.
- Folder Test 1.1 có 18 đoạn đã mô tả, đủ cho video 30 giây.
- Các việc còn mở ở bước 4, 5, 7 không chặn lần chạy thử này.

**User chốt 30/09: bỏ bước giọng đọc. Hiện chỉ cần ghép các đoạn video lại với nhau.**

- **Luồng mới:** intake → catalog → treatment → [duyệt treatment] → select-shots → [shot board] → build-timeline → [editor] → render-final → export.
- **Bỏ** `narration` và `tts`. Còn 2 lượt Claude, hoặc 0 khi dùng Claude giả.
- Luồng có lời dẫn vẫn giữ nguyên để dùng lại sau.

**Vì sao làm được mà không phải viết lại phần dựng.**
- `buildStudioTimeline` đã lấy `tb.seconds` của treatment khi beat không có câu lời dẫn nào (`packages/core/src/studio/build-timeline.ts:25-60`). Chỉ cần đưa vào lời dẫn rỗng và danh sách audio rỗng.
- Cần đổi: stage `studio-build-timeline` (`packages/studio-engine/src/stages.ts:~96-120`) đang bắt buộc có input `studio_narration`, `tts_manifest` và `voice_set`.
- Cần kiểm thêm khi chạy:
  - `studio-export` dựng SRT/VTT từ cue của timeline; không có lời dẫn thì file rỗng. Kiểm checker `export-valid` có chấp nhận không.
  - render-final không có track lời dẫn. Kiểm checker `studio-render-valid` và bước đo loudness khi chỉ có tiếng gốc.

### 0a. Workflow "ghép video" + Claude giả (khoảng 1 ngày, repo ag-studio + script local)

1. **Workflow mới `workflows/ag-studio-montage@1.0.0/workflow.yaml`.**
   - Chép từ `ag-studio-production@1.0.0`, bỏ `narration` và `tts`.
   - `build-timeline` chỉ phụ thuộc `shot-board`, `approve-treatment`, `catalog`, `intake`.
   - `edit`, `render-final`, `export` giữ nguyên.
2. **`studio-build-timeline`:** thiếu input lời dẫn thì dùng `{ lines: [] }` và danh sách audio rỗng, không báo lỗi.
3. **Chọn workflow.**
   - Hiện `run-control.ts` dùng một hằng `STUDIO_WORKFLOW` ở 2 chỗ (`:39` bắt đầu run, `:195` chạy lại từ bước này).
   - Thêm env `STUDIO_WORKFLOW` (mặc định vẫn là bản có lời dẫn). Máy dev đặt `ag-studio-montage@1.0.0`.
   - Chạy lại từ bước này phải dùng workflow của chính run cũ, không dùng env hiện tại.
   - Đề xuất chọn theo env (toàn bộ Studio), chưa chọn theo từng production, cho nhanh. Chọn theo production (cột DB + ô chọn trên form) để sau, khi cần lời dẫn trở lại.
4. **Editor và các chỗ đọc lời dẫn:**
   - editor phải chạy được khi timeline không có câu lời dẫn (panel lời dẫn trống, không lỗi);
   - `render-plan` không có audio lời dẫn thì bỏ ducking nhạc;
   - SRT rỗng thì trang xuất file ẩn SRT/VTT hoặc ghi "không có phụ đề".
5. **Chế độ Claude giả.** Thêm bước `claude fake|real` vào `E:\ag-local\setup\config-local.cjs`.
   - `fake` đặt `STUDIO_CLAUDE_ARGV=["node","/src/ag-studio/fixtures/fake-studio-claude.mjs"]`. File fixture đã nằm trong image nhờ `COPY . .`.
   - `real` xoá dòng đó.
   - Sau đó recreate api và worker.
   - Cùng bước đó đặt `STUDIO_WORKFLOW=ag-studio-montage@1.0.0`.
6. **Test.**
   - studio-engine: workflow montage chạy hết với Claude giả + farm giả, ra MP4 (thêm case vào E2E GĐ4 hoặc test mới cạnh `tests/e2e/production.e2e.test.ts`).
   - build-timeline không có lời dẫn: độ dài clip theo `seconds` của beat.
   - Chạy lại từ bước này giữ đúng workflow cũ.
   - E2E có lời dẫn cũ vẫn xanh.
7. **Chạy khói trên web.**
   - Build lại container Studio.
   - User đăng nhập trong browser pane.
   - Claude tạo team "Chạy thử", production 30 giây, 16:9, folder Test 1.1, rồi chạy tới MP4.
   - Lỗi thì sửa, kèm test.
   - Chạy được thì báo user tự chạy.

### 0b. Sửa giao diện tối thiểu (1,5–2 ngày, repo ag-studio)

| # | Việc | File | Kiểm |
|---|---|---|---|
| 0b.1 | `GET /api/config` (cần đăng nhập) trả `{ claudeMode: 'fake'|'real', workflow: 'montage'|'narrated' }`, đọc từ env của api | `apps/api/src/` (module nhỏ mới) | Test API |
| 0b.2 | Nhãn "Claude giả (chạy thử)" và "Ghép video, không lời dẫn" trên header và trên `RunPanel` | `apps/web/src/App.tsx`, `modules/production/RunPanel.tsx` | Test web + `playground.html` |
| 0b.3 | Sửa production trước khi chạy: nút Sửa trên trang chi tiết (tiêu đề, brief, thời lượng, khung hình, ngôn ngữ, folder nguồn bằng TreeSelect như form tạo); thêm `updateProduction` vào client (API PATCH đã có); hiện tên folder thay id. Ghi chú: đổi sau khi đã chạy chỉ áp dụng ở lần chạy mới | `pages/ProductionDetailPage.tsx`, `api/studio-client.ts`, dùng lại `helpers/folder-tree.ts` | Test web |
| 0b.4 | Kiểm điều kiện trước nút Chạy (có folder nguồn, có thời lượng); thiếu thì khoá nút và nêu lý do | `RunPanel.tsx` | Test web |
| 0b.5 | Nút "Huỷ run" có hỏi xác nhận, dùng `cancelRun` (client đã có) | `RunPanel.tsx` | Test web |
| 0b.6 | Tên stage tiếng Việt/Anh kèm mô tả một dòng; giữ key làm chữ phụ | `RunPanel.tsx`, `i18n` | Test web |

- **Kiểm sau khi làm:**
  - full suite ag-studio (có và không có ffmpeg), typecheck, web test và build;
  - E2E GĐ3 và GĐ4 (có lời dẫn) + E2E ghép video;
  - build lại container Studio web, api, worker;
  - chạy lại một production trên web tới MP4.
- **Rủi ro:**
  - Claude giả và workflow ghép video áp dụng cho mọi production của bản Studio này. Trước bước 2 phải chạy `claude real`. Nhãn trên web giúp không nhầm.
  - Checker `export-valid` và `studio-render-valid` có thể đòi phụ đề hoặc lời dẫn: phát hiện ở test bước 0a.6, sửa checker cho nhận trường hợp không lời dẫn.
- **Để sau:** giọng đọc (mục 1), chọn giọng trên web (4.5), chọn workflow theo từng production.

## 1. Giọng đọc mặc định (để sau, khi bật lại luồng có lời dẫn)

**Mục tiêu.** Production không chọn giọng thì TTS dùng `library:voices/default.wav`. OmniVoice bắt buộc có giọng mẫu. User đã chốt bỏ giọng đọc ở giai đoạn này, nên mục này chỉ làm khi cần lời dẫn trở lại.

**Cách làm.** Thêm bước `voice` vào `E:\ag-local\setup\config-local.cjs`. Script này làm lần lượt:

1. Kiểm file.
   - `voice.wav` dài 8–15 s, đo bằng ffprobe trong `ag-render-worker/node_modules/ffmpeg-static`.
   - `voice.txt` không rỗng, UTF-8, một dòng.
2. Upload bằng env sẵn có trong container, không in khoá.
   - `docker compose cp` file vào container `api`.
   - `docker compose exec -w /src/ag-studio/apps/api api node -e …` chạy `PutObjectCommand` vào `STUDIO_R2_BUCKET` (local là `ant-go-dev`), key `library/voices/default.wav`.
   - `@aws-sdk/client-s3` chỉ có trong `apps/api`, nên phải chạy trong thư mục đó.
3. Ghi 2 khoá vào `E:\CODE\ag-studio\.env` bằng helper sẵn có trong script (thay dòng có sẵn, thêm dòng thiếu, `config-local.cjs:36-51`).
   - `STUDIO_DEFAULT_VOICE_REFERENCE=library:voices/default.wav`
   - `STUDIO_DEFAULT_VOICE_TEXT=<nội dung voice.txt>`
   - Không chạy lại bước `studio`, vì bước đó chép đè `.env` từ `.env.example`. Ngược lại, bước `studio` cũng phải giữ 2 khoá này.
4. `docker compose up -d --force-recreate --no-deps api worker`. `restart` không nạp lại env. Cả api (TTS lại từng câu trong editor) và worker (stage `intake`) đều đọc 2 biến.

**Kiểm.**
- `docker compose exec api node -e` với `HeadObject` in `ok` và kích thước file.
- `printenv` trong api và worker chỉ in tên 2 biến.
- Kiểm thật nằm ở bước 2 (stage `tts` ra WAV).

**Rủi ro.**
- Giọng chỉ được chốt vào `brief.json` ở stage `intake`. Khi làm mục này, nên thêm: `tts` lấy giọng mặc định lúc chạy nếu brief chưa có giọng (`payloads.ts:53-57`), để chạy lại `tts` là nhận giọng mới.
- Production lưu `voice` rỗng (`{speed:1}`) sẽ bỏ qua giọng mặc định (`packages/studio-engine/src/voice.ts:12`). Form web hiện không gửi `voice`, nên chưa gặp.

**User cung cấp.** `E:\ag-local\voice.wav` và `E:\ag-local\voice.txt`, đúng câu đọc trong file.

## 2. Production Studio thật đầu tiên (workflow ghép video, tốn 2 lượt Claude)

**Mục tiêu.** Chạy hết một production bằng Claude thật, TTS thật và render thật qua farm, ra MP4 + SRT. Sửa các lỗi tích hợp lộ ra.

**Trước khi chạy.**
- Luồng Claude giả ở bước 0 đã chạy ổn. Chạy `config-local.cjs claude real`; web không còn nhãn "Claude giả".
- Hỏi user lần cuối. Workflow ghép video tốn 2 lượt Claude (`treatment`, `select-shots`); model mặc định `claude-opus-5-5`.
- Kiểm stack, 2 worker online, Ollama đã nhả VRAM (`unload_ollama_before_tts: true`).
- Kiểm CORS của R2 `ant-go-dev` cho `localhost:3100` (việc A6 trong tab dev). Thiếu thì editor không phát được lời dẫn.

**Các bước.** Làm trong browser pane.

1. User mở `http://localhost:3100` và tự đăng nhập bằng `demo@ant-group.net`.
2. Claude thao tác trên web:
   - tạo team "Chạy thử tự động";
   - tạo production "Chạy thử tự động": 16:9, 30 giây;
   - chọn nguồn là folder "Test 1.1" (project Test, 18 đoạn);
   - bấm Chạy.
3. Qua gate `approve-treatment` và `shot-board`: Claude **duyệt nguyên trạng** và chép treatment cùng danh sách đoạn vào báo cáo cho user xem.
4. Trong editor, đổi một clip và cắt ngắn một clip, rồi bấm Render preview. Sau đó bấm Hoàn tất (gate `edit`).
5. Theo dõi tới khi render-final và export xong. Tải MP4 + SRT về `E:\ag-local\runs\<ngày>\` cho user xem.

**Nơi theo dõi.**
- API: `GET /api/productions/:id/run`.
- Log: `docker compose logs -f worker api` (ag-studio), `E:\ag-local\render.log`.
- Farm: trang Việc của web farm.

**Khi lỗi.**
- Tìm nguyên nhân gốc và sửa ở đúng repo, kèm test tái hiện lỗi.
- Build lại container hoặc bundle worker.
- Dùng "Chạy lại bước này" hoặc "Chạy lại từ bước này" để không tốn lại lượt Claude.
- Sửa ag-go-api hoặc ag-account-server thì báo user trước khi commit.

**Kiểm.**
- MP4 phát được; chữ và phụ đề tiếng Việt đúng Arial; SRT khớp lời dẫn.
- `render_final` dùng nguồn file gốc (demo là ADMIN).
- Ghi số giây mỗi stage và mức ăn hạn mức Claude.

**Rủi ro.**
- Có thể chạm hạn mức Claude. Cơ chế chờ có sẵn nhưng regex có thể bỏ sót (lỗi mới 8).
- GPU P1000 4 GB có thể hết VRAM khi TTS.
- Keyframe trên web có thể lỗi CORS hoặc 403.

**User cần.**
- Đồng ý chạy và tự đăng nhập tài khoản demo.
- Xác nhận demo còn là ADMIN của `ant-go-v2` trên Account API local.
- Đổi cách xử lý gate nếu muốn tự duyệt thay vì để Claude duyệt nguyên trạng.

## 3. Cập nhật tab "Chạy thử trên máy dev"

**Mục tiêu.** Tab mô tả đúng cách máy dev đang chạy. Hiện tab vẫn ghi `yarn start:dev` và Account API bản dev.

**Cách làm.** Dùng docs tools, thay từng phần (không viết lại cả tab trong một lần). Đọc `sinceRev` trước để không đè sửa của user.

**Nội dung mới:**
- **Bảng thành phần:**
  - ag-go api, worker-io, worker-media chạy Docker (3737); web 5173;
  - Account API local 8080 + client 3000, MariaDB `ag_account_local`, bản `feat/user-access`;
  - farm 3010/3011, Studio 3100;
  - 2 worker chạy từ `E:\ag-local`;
  - Ollama `qwen2.5vl:3b`;
  - máy quét LAN `lan-scan`.
- **Sinh cấu hình bằng script:**
  - `node config-local.cjs farm|go|studio|voice`, `workers-local.cjs`, `lan-scan.cjs`;
  - `secrets.json` và `account_api_key.txt` không bao giờ in ra;
  - bản `.env` cũ lưu ở `.env.before-studio`.
- **Bật/tắt hằng ngày:** thứ tự `docker compose`, lệnh chạy 2 worker, file log.
- **Web farm và Studio mới:** ProLayout, i18n vi/en, màn bắt đầu, menu avatar, cổng đăng nhập.
- **Máy quét LAN:**
  - chỉ ghi phụ thuộc: `sign_url` là `192.168.1.2`, nên đặt IP tĩnh;
  - hướng dẫn cài nằm ở `E:\ag-local\lan-scan\HUONG-DAN.txt`.
- **Bảng "Lỗi đã sửa khi chạy thật":** 6 lỗi tích hợp đã sửa + `CORS_EXTRA_ORIGINS` + lỗi admin API `.map` + lỗi mới từ bước 2. Mỗi dòng: ngày · repo `commit` · hiện tượng.
- **Bảng lỗi thường gặp:** cập nhật theo thực tế.

**Kiểm.** Đọc lại outline của tab. Mọi lệnh trong tab đều đã chạy trên máy này. Không có giá trị bí mật nào trong tab.

**Ngoài phạm vi.** Tab chính còn câu cũ, ví dụ "ag-account-server, ag-go-api và ag-go-web chưa push". Chỉ đề xuất sửa, không tự sửa.

## 4. Lỗi và thiếu sót (memory mục 4 + lỗi mới)

Xếp theo mức ảnh hưởng.

| # | Việc | Repo · file | Cách làm | Kiểm | Công |
|---|---|---|---|---|---|
| 4.1 | `scan.ai` lỗi hết vẫn `completed` (lỗi mới 1) | ag-scan-worker `src/scan-ai.ts`; ag-go-api `farm-result-poller.service.ts` | Worker: dừng ngay khi lỗi hạ tầng (không kết nối được, 5xx, model không có); `throw` khi 0 đoạn thành công hoặc hơn 50 % đoạn lỗi (farm tự thử lại tối đa 3 lần). ag-go: `handleAiCompleted` fail analysis nếu cụm không có mô tả nào, rồi huỷ các cụm còn lại (dùng lại vòng lặp của `handleFailed`); `finalizeIfDone` không đổi `is_current` khi không đoạn nào có mô tả; lưu lỗi từng đoạn vào `summary.aiErrors` | Sửa spec `scan-ai.spec.ts:299`, thêm test "Ollama chết → throw" và "lỗi một phần → complete"; db-spec ag-go: manifest toàn lỗi thì bản cũ vẫn là current; E2E quét | 1 ngày |
| 4.2 | Outbox báo `asset.analysis.completed` không có handler | ag-go-api `outbox-dispatcher.service.ts:134-164` | **Đề xuất A:** thêm nhánh rõ ràng, chỉ log debug, và hằng số sự kiện; giữ sự kiện cho Studio/tìm kiếm dùng sau. B: bỏ phát sự kiện | Thêm spec cho nhánh mới và nhánh loại lạ | 2 giờ |
| 4.3 | Redis cảnh báo eviction | Hạ tầng: container `redis` dùng chung | Không phải code (BullMQ tự kiểm). `CONFIG SET maxmemory-policy noeviction` rồi ghi vào cấu hình container. Cần mật khẩu Redis: user chạy, hoặc qua script nếu mật khẩu có trong `.env` ag-go | Log ag-go không còn cảnh báo. Theo dõi bộ nhớ vì job lỗi không tự xoá (`removeOnFail:false`) | 15 phút |
| 4.4 | Chờ hạn mức Claude chỉ có ở `StudioAgentExecutor` (+ lỗi mới 8) | ag-studio `packages/adapters/agent-cli/src/cli-agent-runtime.ts`, `packages/executors/src/studio-agent-executor.ts:94-117` | Chuyển vòng chờ xuống lớp runtime (bọc runtime); dùng cho cả Studio và CLI harness; bỏ vòng chờ trong executor. Nới regex (nháy cong, "usage limit"); đọc giờ reset nếu có; coi JSON `is_error:true` với exit 0 là lỗi | Thêm mode `rate-limit-once` vào `fixtures/fake-agent-cli.mjs`; test cả nhánh `AgentExecutor`; full suite | 1 ngày |
| 4.5 | Studio chưa chọn được giọng | ag-studio `bucket.ts` (thêm `list`), API `GET /api/library/voices`, web `ProductionsPage.tsx`, `ProductionDetailPage.tsx` | Liệt kê `library/voices/*.wav`, câu mẫu lấy từ file `.txt` cùng tên. Thêm Select + tốc độ ở form tạo production; trang chi tiết hiện giọng, kèm cảnh báo "đổi giọng sau intake chỉ có hiệu lực ở lần chạy mới". Dùng giọng mặc định mỗi khi `reference` rỗng (`voice.ts:12`). Upload giọng mới vẫn qua script (bước `voice` nhận tên) | Test API và web; thử trên web với 2 giọng | 1,5 ngày |
| 4.6 | Thêm thành viên chỉ bằng User ID (+ lỗi mới 6) | ag-account-server `public-users` (endpoint tra theo email trả `auth0_user_id`); ag-studio `teams`, `account-api.service.ts`, web `TeamDetailPage.tsx` | Account API: `GET /v2/public/users/lookup?email=` (x-api-key), trả `id`, `name`, `email`, `auth0_user_id`. Studio: `POST members` nhận email và tra phía server (không mở danh bạ user cho web); danh sách thành viên hiện tên và email; thêm vai `producer` vào web; thêm `@Roles` cho `GET members` | jest ở ag-account-server, test API và web ở Studio; thêm thành viên bằng email trên web | 2 ngày |
| 4.7 | Mezz cache render theo job (+ lỗi mới 7) | ag-render-worker `src/render-handler.ts:145-186, 45-48`, `src/ffmpeg-utils.ts`; ag-farm `packages/worker-sdk/src/cache.ts` | Cắt clip qua `ctx.cache.getOrDownload`. Khoá cache = sha256 của `cache_key` + `size_bytes` + loại nguồn + watermark + khoảng cắt + chất lượng + phiên bản tham số. Hardlink vào `mezzs/`; thêm `-f mp4`. Sửa `maxBytes`. Cache của worker-sdk: tên tmp riêng cho mỗi lần gọi, chờ khoá lâu hơn, gỡ khoá bỏ dở, job bị huỷ không làm hỏng job khác. Đây là thư viện nội bộ, không phải hợp đồng farm | Test khoá; 2 lần preview liên tiếp thì lần 2 không cắt lại; 2 handler song song chỉ cắt 1 lần; huỷ job A không làm fail job B; E2E GĐ4 | 2–3 ngày |
| 4.8 | `claude.cmd` trên Windows | ag-studio `cli-agent-runtime.ts:117, 186` | Thêm biến `CLAUDE_BIN` (chỉ thay `argv[0]`). Trên Windows, nếu gặp shim npm thì tự tìm `claude.exe`. Không dùng `shell:true` | Test đơn vị giả lập đường dẫn; chạy thử `--version` trên máy dev | 0,5 ngày |

**Việc nhỏ kèm theo** (làm cùng 4.1 hoặc trước bước 5):
- ag-go gửi `requirements.ollama_models: [model]` khi tạo job `scan.ai`.
- ag-go ghi `asset_analyses.models` và tính model vào điều kiện bỏ qua, để đổi model thì quét lại được.
- ag-scan-worker nối `extra.ollama_url` cho cả handler lẫn bước dò năng lực (lỗi mới 2), hoặc sửa README. Không bắt buộc cho `lan-scan`, vì máy đó chạy Ollama tại chỗ.

**Cần user quyết.**
- 4.2 chọn A hay B.
- 4.3 cho phép đổi Redis dùng chung.
- 4.6 cho sửa ag-account-server (đề xuất: nhánh mới từ `feat/user-access`, hoặc thêm commit vào nhánh đó).
- Ngưỡng fail của 4.1: đề xuất 0 đoạn thành công hoặc hơn 50 % đoạn lỗi.

**Rủi ro.**
- 4.1 fail cả analysis khi một cụm hết lượt thử lại. Đây là đúng thiết kế, nhưng quét lại cần backfill.
- 4.7 đụng thư viện dùng chung của worker quét. Chạy lại E2E quét.

## 5. Model quét: `qwen2.5vl:7b` trên máy RTX 4060 Ti, máy dev chỉ làm `scan.extract`

**Đề xuất.**
- `ANALYSIS_MODEL=qwen2.5vl:7b`.
- `lan-scan` nhận `scan.ai` (và `scan.extract` khi rảnh).
- `local-scan` chỉ nhận `scan.extract`: đổi `kinds` trong `config.yaml` qua `workers-local.cjs`. Sửa trên web farm không có tác dụng (lỗi mới 4).

| | Ưu | Nhược |
|---|---|---|
| 7b trên 4060 Ti 16 GB | Mô tả tiếng Việt và enum chính xác hơn 3b. Model 4-bit (~6 GB) vừa VRAM, còn chỗ cho ngữ cảnh. Nhanh hơn nhiều so với ~20 s/đoạn của 3b trên P1000 (cần đo). Giải phóng GPU máy dev cho TTS | Một máy gánh toàn bộ `scan.ai`: máy tắt thì job nằm chờ. Phụ thuộc mạng LAN và IP `192.168.1.2` (DHCP). Nếu máy đó sau này chạy cả TTS thì tranh VRAM |
| Giữ 3b trên P1000 | Không phụ thuộc máy khác | Chậm; mô tả kém; tranh GPU 4 GB với OmniVoice |

**Điều kiện trước.**
- `lan-scan` online (việc của chat kia).
- 4.1 xong, cùng `requirements.ollama_models`, để node thiếu 7b không nhận `scan.ai`.

**Cách đo:**
1. **Sửa trình chấm** (0,5 ngày).
   - Tách phần gọi Ollama và prompt thành module dùng chung giữa handler và `run_golden.ts`.
   - Thêm `--models a,b`, bảng khớp theo từng trường và độ trễ p50/p95.
   - Chạy bằng `yarn build && node dist/eval/run_golden.js`.
2. **Dựng golden set** (0,5 ngày code + 0,5–1 ngày user gán nhãn).
   - Chạy `scan.extract` cho 5 project Hoa Lư (78 file) trên `local-scan`, không cần AI.
   - Script xuất keyframe của khoảng 50 đoạn đa dạng: cỡ cảnh, ngày/đêm, có người, có chữ/watermark, đoạn không dùng được.
   - Ghi ra `eval/golden.json` + `eval/keyframes/`.
   - User gán nhãn trường enum/bool (`shot_size`, `camera_motion`, `time_of_day`, `setting`, `people_count`, `has_watermark`, `usable`, `quality`) và vài `tags`/`subjects`.
3. **Chạy trình chấm** với 3b trên máy dev và 7b trên máy LAN. Chạy trên máy LAN thì chép thư mục eval sang; nếu Ollama máy đó mở cổng LAN thì chạy từ máy dev (việc của chat kia).
4. **Tiêu chí đạt (≥ 85 %):**
   - JSON đúng schema ≥ 98 %;
   - khớp trường enum/bool ≥ 85 %;
   - user chấm tay `caption_vi` của 20 đoạn: ≥ 85 % đúng chủ thể và hành động.
   - Kèm số s/đoạn và VRAM đỉnh.
5. **Nếu 7b đạt:**
   - đổi `ANALYSIS_MODEL` qua `config-local.cjs go`;
   - recreate container ag-go api và worker-io;
   - quét lại Test bằng backfill `all` (hoặc tăng `ANALYSIS_PROMPT_VERSION`).

**User quyết** sau khi có số liệu. Nếu 7b không đạt, thử `qwen3-vl:8b` cùng quy trình.

## 6. Kiểm với hệ thống thật (memory mục 5)

| Mục | Làm ở đâu | Cách kiểm | Đạt khi | Phụ thuộc |
|---|---|---|---|---|
| Golden set ≥ 85 % | Máy dev + LAN | Theo bước 5 | Như tiêu chí ở bước 5 | Bước 5 |
| Nghe TTS với giọng mẫu | Máy dev | Tải WAV lời dẫn của production ở bước 2 và 3–5 câu thử (câu dài, số, tên riêng) về `E:\ag-local\listen\` | User nghe và chấp nhận | Bước 1, 2 |
| Preview khớp bản render | Máy dev | Chụp preview trên web (browser pane) ở 3–4 mốc chuyển beat. Cắt khung hình của MP4 render ở cùng mốc bằng ffmpeg. Đặt cạnh nhau | Khớp mốc chuyển cảnh (±1 khung), chữ đúng font và vị trí | Bước 2 |
| Người ngoài phạm vi chỉ thấy chữ | Máy dev | Tài khoản thứ hai: không ADMIN, không có quyền folder Test 1.1. Thêm vào team với vai viewer. User tự đăng nhập tài khoản này | Thấy treatment, lời dẫn, danh mục; keyframe và preview không hiện; gọi thẳng ag-go ra 404 | Bước 2; user cấp tài khoản |
| Brief thật 2–3 folder Ẩm thực | VPS dev (local không có Ẩm thực) | Theo Bước 6 của tab "Hướng dẫn setup demo" | Ra MP4 + SRT dùng được | Deploy VPS |
| Deploy VPS | VPS | Team làm Bước 1–3 và 5 của tab (Auth0, Account API, DB, R2, khoá, máy GPU). Claude soạn lệnh và kiểm từng mốc "Xong khi" | Mọi mốc "Xong khi" của Bước 4 và 6 đạt | Bước 8 (merge), quyền SSH |

**User quyết.**
- Ẩm thực: chạy trên VPS dev (đề xuất) hay nhập vài folder Ẩm thực vào ag-go local.
- Có cho Claude SSH vào VPS không. Nếu có thì hỏi trước mỗi lệnh.

## 7. Việc chưa làm theo plan gốc: chia mốc

Ước lượng tính cho 1 dev cùng Claude, gồm test.

| Mốc | Nội dung | Công | Khi nào |
|---|---|---|---|
| M-A Vận hành | Litestream sidecar cho `studio.db` + khôi phục khi deploy + phương án cho `/data/harness` (artifact là file). pg_dump định kỳ cho `ag_farm`. CI ag-go: khôi phục `ci.yml` (api: format, typecheck, lint, test, build, openapi:validate; job `test:db` với Postgres 55434; web: test, build) và bắt deploy chờ CI. CI cho 2 repo worker (cần checkout ag-farm và ag-studio bằng token đọc) | 4–5 ngày | Trước khi có người dùng thật trên VPS |
| M-B Preview sạch | Trang footage cho người có quyền xem preview sạch (`footage.controller.ts:59`, `footage.service.ts:304-385`). `resolve` ưu tiên bản sạch ≥ 720p trước file gốc, dùng lại `canViewUnwatermarked`. Worker quét tải preview sạch ≥ 720p thay file gốc: chọn nguồn một lần ở `handleAnalysisRequested`, lưu vào `analysis.artifacts.source`, `sign` trả đúng nguồn đó | 3 ngày | Trước backfill ~700 GB trên VPS |
| M-C Editor M2 | M2a: cắt đôi, chuyển cảnh (timeline + `render-plan.ts`), comment theo khoảng thời gian (bảng đã có), khoá mềm — 5–6 ngày. M2b: kéo thả giữa beat, reframe 9:16 có điểm lấy nét — 5–8 ngày. Đa track thật cần đổi schema, để sau | 10–14 ngày | Sau phản hồi demo |
| M-D Brand theo team | Cột brand trong `teams`, thư viện brand trên bucket, overlay và logo trong `render-plan.ts`/`overlay.ts`, cập nhật render worker | 3–5 ngày | Sau phản hồi demo |
| M-E Premiere/OTIO | Stage export thêm FCP7 XML kèm media đã cắt (khó nhất là link lại media vì URL ag-go hết hạn); OTIO thêm 1 ngày | 3–5 ngày | Tuỳ chọn |
| M-F Publish `@ag-farm/*` | GitHub Packages chỉ nhận scope `@ant-group-developer`: phải đổi tên gói và dùng alias `npm:` ở nơi dùng. Workflow publish. render-worker còn cần publish `@ag-studio/render` + `@harness/*` | 3–5 ngày | Để sau: bundle phát hành đã đủ cho máy worker |

**Cần user quyết.**
- M-B: đổi payload `scan.extract` (thêm loại nguồn) là đổi hợp đồng ag-farm, nên phải hỏi trước. Nếu giữ nguyên payload và chỉ đổi phía ag-go thì không cần.
- M-F: tên scope mới.

## 8. Push và PR (chỉ đề xuất, mỗi lần làm đều hỏi user)

**Cần push:**

| Thứ tự | Repo · nhánh | Nội dung | Ghi chú |
|---|---|---|---|
| 1 | ag-farm `main` | `c13913d`, `7df9f8b`, `3f93086` (+ 4.7 phần worker-sdk) | Không commit `.gitignore`. Push `main` kích hoạt `deploy.dev.yml` (test rồi SSH deploy VPS): lỗi nếu chưa có secret, deploy thật nếu đã có. `c13913d` đổi dạng response admin API, nhưng chỉ `apps/web` dùng |
| 2 | ag-studio `main` | `8388ec3`, `f3d90ad` + sửa từ bước 2 và mục 4 | Cũng kích hoạt deploy. Kiểm `git log` trước vì phiên khác có thể commit song song |
| 3 | ag-scan-worker, ag-render-worker `main` | Sửa 4.1, 4.7, trình chấm | Chưa có CI. Build lại bundle cho máy worker |
| 4 | ag-go-api `feat/footage` | 4.1 (ag-go), 4.2, `ollama_models`, `models` | User tự push (máy chặn Claude push repo có sẵn). Commit trên `feat/footage`, không rebase lại chồng nhánh |
| 5 | ag-account-server | Endpoint tra email (4.6) | User push |

**PR và merge:**
1. ag-account-server `feat/user-access` → `develop`. Làm trước, vì act-as trên VPS phụ thuộc endpoint `access`.
2. ag-go (api và web): PR `dev-duc` của user → `dev`, rồi `feat/media-analysis` → `dev`, rồi `feat/footage` → `dev`. Chỉ merge sau khi đã điền `.env` VPS (Bước 4 của hướng dẫn), vì merge vào `dev` tự deploy.
3. ag-farm, ag-studio và 2 repo worker vẫn đẩy thẳng `main`. Nếu muốn chuyển sang PR thì user quyết.

---

## Verification (chạy trước khi báo xong)

- **ag-studio:**
  - `corepack pnpm test` hai lần: có và không có ffmpeg trên PATH (`/c/...` trỏ tới `ag-render-worker/node_modules/ffmpeg-static`);
  - `pnpm -r typecheck`;
  - web test + build (vite qua `node apps/web/node_modules/vite/bin/vite.js apps/web`);
  - E2E GĐ3 và GĐ4 (`E2E=1 corepack pnpm exec vitest run --config tests/e2e/vitest.config.ts`) sau khi build dist của ag-farm api, ag-render-worker, Studio api và worker;
  - kiểm UI trên `playground.html`.
- **ag-farm:** `yarn test`, `yarn typecheck`, `test:db` (Postgres test 55433).
- **ag-scan-worker:** `yarn test` + `bash scripts/e2e/run.sh`.
- **ag-render-worker:** `yarn test`, rồi build lại bundle (`node scripts/release.mjs`) và giải nén vào `E:\ag-local`.
- **ag-go-api:** `yarn test` + `yarn test:db` (55434) + `yarn openapi:validate`; build lại image Docker local.
- **ag-go-web:** chỉ chạy nếu có sửa.
- **ag-account-server:** jest cho `public-users` (2 test storage hỏng sẵn từ trước).
- **Chạy thật:**
  - bước 2 ra MP4 + SRT;
  - sau 4.1: tắt Ollama giữa lúc quét thì job `scan.ai` fail, farm thử lại, và bản quét cũ vẫn là current.

## Nhắc sau demo

- Đổi token Claude (`CLAUDE_CODE_OAUTH_TOKEN`, từng lộ trong log phiên trước).
- Đổi mật khẩu tài khoản `demo@ant-group.net`.
- Đặt IP tĩnh cho máy dev (`192.168.1.2`).
