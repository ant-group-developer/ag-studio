# Thiết kế: AG Studio làm việc bằng chat, hai kiểu dựng, chọn máy render, xuất Premiere/CapCut

**Ngày:** 2026-10-06 · **Trạng thái:** đã duyệt (kế hoạch tổng), chi tiết từng pha viết trong plan riêng.
Mockup 14 màn: https://claude.ai/artifact/N6YHc1yrBvqc1Fv6ab8xZL

## 1. Bối cảnh và mục tiêu

AG Studio đã có luồng series (R&D → branding → kế hoạch tập → tập tự render) nhưng người dùng phải sửa từng bước
bằng form nhiều ô, chỉ ba bước có người duyệt, chỉ có kiểu "ghép nguyên clip", và Claude mỗi worker chỉ chạy một
lượt một lúc. Mục tiêu:

1. **Chat là chính.** Mỗi video (production) có một luồng chat với Claude; ở mọi bước có Claude hoặc cần người duyệt,
   người dùng chat để sửa/góp ý rồi bấm **Duyệt**. Không có form nhiều ô trên đường đi chính.
2. **Nhiều video cùng lúc.** Số lượt Claude chạy song song chỉnh được, **mặc định 20**; tin nhắn của người dùng được
   xếp trước các bước chạy tự động khi đầy.
3. **Hai kiểu dựng** trong cùng một mô hình timeline: ghép nguyên clip (hiện có) và **cắt theo shot** (EDL có in/out,
   lời dẫn, chữ trên hình — pipeline của harness).
4. **Render qua farm, chọn máy theo từng job.** Không viết đường render riêng trong Studio.
5. **Xuất project** Premiere (FCP7 XML, đã có, sửa lỗi) và CapCut (mới).

**Không làm:** chế độ chạy không cần Auth0/R2/farm. Máy dev đã chạy đủ stack local bằng Docker
(`docs/runbooks/studio-local.md`); Studio tiếp tục dùng Auth0 (để đọc ag-go bằng tài khoản người dùng), R2 và farm.

## 2. Nguyên tắc giao diện

1. Đầu vào chỉ có **ô chat** và gắn folder footage bằng `@`. Không form nhiều ô.
2. Thiếu thông tin bắt buộc thì Claude hỏi lại trong chat, mỗi lần một câu; phần còn lại Claude tự đề xuất.
3. Kết quả mỗi bước hiện **dạng đọc được** (tài liệu, danh sách tập, video xem trước 720p), thay đổi so với bản trước
   tô màu.
4. Mỗi bước **một nút chính: Duyệt**. Thao tác khác (làm lại, render, xuất file, sửa tay) nằm trong menu `⋯`.
5. **Duyệt luôn phải bấm.** Gõ "ok" chỉ làm Claude hiện thẻ xác nhận trong chat. Hành động có tác dụng thật (duyệt,
   render bản cuối, xuất file gốc) luôn qua thẻ xác nhận.
6. Bố cục 3 cột: danh sách video (cây series → tập, trạng thái) · luồng chat có vạch ngăn theo bước · kết quả bước
   hiện tại. Các editor hiện có (`RndEditor`, `BrandingEditor`, `PlanEditor`, editor timeline) giữ lại sau `⋯ → Sửa tay`.

## 3. Thiết kế kỹ thuật

### 3.1 Chat theo production
- Bảng `stage_chat_turns` (migration `0019`): `production_id`, `episode_id?`, `run_id`, `stage_key`, `turn`, `role`
  (`user|assistant|system`), `text`, `proposal` (JSON tài liệu đề xuất, nếu có), `action`, `llm_call_id`, `created_at`.
- Mỗi tin nhắn đi qua một lượt Claude **structured** (như `StudioAgentExecutor`): prompt = phần đầu cố định
  `studioPrompt(...)` của stage đang chờ (để dùng prompt cache) + `# Bản hiện tại` + `# Góp ý` (lịch sử + tin mới).
  Kết quả: `{ reply, action, proposal? }` với `action ∈ answer | revise | suggest_approve | render | export | retry`.
  `proposal` được kiểm bằng **đúng** `VALIDATORS` của skill đó, có một vòng sửa. Đề xuất chỉ được lưu, **không ghi
  đè** gì cho tới khi người bấm Áp dụng/Duyệt.
- Duyệt đi qua `submitStudioGate` (core `submitGate`), nên checker, `human_edits` và dataset LLM giữ nguyên.
- **Mọi stage agent có gate đi sau:** workflow mới `ag-studio-series-plan@3.0.0` (thêm `approve-trend-report`, intake
  qua chat) và `ag-studio-episode@1.3.0` (thêm `approve-youtube-kit`, `approve-timeline` trước `freeze-timeline`).
  Phiên bản cũ giữ nguyên cho run cũ.
- Skill mới `studio-intake`: câu nói tự do + `@folder` → `StudioSeed` + danh sách câu hỏi còn thiếu. Danh sách folder
  ag-go của người dùng được đưa vào prompt.
- Chat trên timeline đề xuất thao tác (`addClip`, `moveClip`, `replaceClipAsset`, `addText`, `setMusic`…) từ
  `core/src/studio/layout.ts`, kiểm bằng `timelineIssues`.
- Ở kiểu cắt theo shot, các stage file-mode (xem khung hình) chat bằng `claude --resume <session>` trong workspace của
  stage, để Claude nhớ các khung đã xem.

### 3.2 Số lượt Claude
- Cấu hình `claude.max_concurrent` (mặc định 20): pha 1 đọc từ env `STUDIO_CLAUDE_MAX_CONCURRENT`, pha 2 chỉnh được
  trên web (bảng cài đặt trong `studio.db`). Thay hằng `STUDIO_RESOURCES.claude`.
- Một semaphore trong engine dùng chung cho stage của worker và lượt chat; chat ưu tiên khi đầy. Chat không đi qua
  `claim` của worker.
- Lỗi hết hạn mức (`RATE_LIMITED`): giữ cơ chế chờ 5→60 phút; sửa regex để nhận cả dấu nháy cong và
  "usage limit reached".

### 3.3 Hai kiểu dựng, một timeline
- **Timeline v4** (`packages/contracts/src/studio.ts`): clip có thêm `in`/`out` (tuỳ chọn), `transition_out`, tham
  chiếu dòng lời dẫn; v3 đọc như `in = 0`, `out = hết asset`. `layout.ts`, `render-plan.ts`, editor cập nhật theo.
- **Workflow `ag-studio-episode-cut@1.0.0`:** intake → tải proxy 720p (ag-go `resolve purpose=preview`) →
  `media-index` (dò cảnh trên proxy, `core/src/media/{index,scene}.ts`, chạy trong worker Studio — image có ffmpeg) →
  transcribe (job farm) → watch → `source-survey` (agent + chat) → `plan-edit` (agent + chat) → TTS (job farm
  `studio.tts`, tuỳ chọn) → fit-edl → compose → `approve-timeline` → render (farm, bản cuối dùng file gốc) → thumbnail
  → export.
- `plan-episodes` chọn kiểu dựng cho từng tập. Skill `source-survey`/`edit-plan` dùng mô tả AI cả video của ag-go
  làm gợi ý (ag-go không có dữ liệu theo shot).
- Đảo các quyết định D1 (chỉ ghép nguyên video), D10 (bỏ segment), D11 (chưa chuyển lời nói thành chữ) của kế hoạch
  series — ghi ADR khi làm pha 5.

### 3.4 Render: chọn máy trong farm
- Mọi render (xem trước, bản cuối) và mọi bước GPU đi qua farm như hiện nay.
- Mỗi lần render bản cuối, thẻ xác nhận cho chọn **kiểu máy** bằng `requirements` sẵn có của ag-farm:
  "bất kỳ máy nào" (`{}`), "máy có NVENC" (`{ nvenc: true }`), "máy có GPU" (`{ gpu: true }`). Không đổi hợp đồng
  ag-farm.
- Ghim một máy cụ thể (theo tên node) **cần thêm trường mới vào giao thức ag-farm** — chỉ làm khi cần, và phải hỏi
  trước (đổi hợp đồng ag-farm).
- Màn Hàng đợi đọc trạng thái job từ farm qua owner API (`@ag-farm/owner-client`). Owner API có trả danh sách node
  hay không cần kiểm ở plan pha 3; nếu không, chỉ hiện job, không hiện máy rảnh.

### 3.5 Xuất project
- **Premiere:** giữ job farm `studio.export_premiere`; sửa `ag-render-worker/src/premiere-handler.ts` để đọc
  `source_audio.muted` và gain/fade nhạc từ composition; đọc `in/out` và dissolve khi có timeline v4.
- **CapCut:** sinh thư mục draft (`draft_content.json`, `draft_meta_info.json`, media trỏ tới file đã tải) từ
  composition, ghim theo CapCut 9.5.0 (bản trên máy dev, file draft là JSON thường). Studio chạy trong Docker nên
  trả về **zip** để người dùng giải nén vào thư mục draft của CapCut; kèm hướng dẫn. Định dạng không có tài liệu và
  có thể đổi khi CapCut cập nhật — ghi ADR.

## 4. Các pha

| Pha | Nội dung | Xong khi |
|---|---|---|
| D | Đồng bộ tài liệu (AGENTS.md, ADR 127–142, runbook, skills README, deferred-items, README, spec này) | Mọi lệnh/đường dẫn nêu trong AGENTS.md tồn tại |
| 0 | Build + test chạy được trên Windows; spawn `claude.cmd`; ghi baseline test đỏ | `pnpm build`, typecheck sạch; test xanh hoặc có danh sách đỏ kèm lý do |
| 1 | `STUDIO_CLAUDE_MAX_CONCURRENT` (mặc định 20) thay `STUDIO_RESOURCES.claude`; regex hết hạn mức; script bật/tắt cả stack local một lệnh | Hai production chạy song song trên stack local, cả hai tới gate `approve-rnd` không xếp hàng |
| 2 | Giao diện chat là chính (mục 2, 3.1, 3.2) | Tạo video bằng một câu chat → chat sửa R&D → duyệt → branding tự chạy; chat sửa timeline một tập; e2e với Claude giả; thử tải 20 lượt song song |
| 3 | Chọn kiểu máy render theo job (mục 3.4), màn Hàng đợi | Cùng một tập render được với hai lựa chọn máy khác nhau |
| 4 | Sửa 2 lỗi xuất Premiere, đọc in/out + dissolve | Mở được trong Premiere, đúng tiếng, nhạc đúng mức |
| 5 | Kiểu cắt theo shot (mục 3.3) | Một tập kiểu Arashiyama dựng từ footage ag-go, có chat ở chọn cảnh và kế hoạch dựng, render 4K |
| 6 | Xuất CapCut (mục 3.5) | Mở draft trong CapCut thấy đúng clip, thứ tự, chữ, nhạc |

Thứ tự: D → 0 → 1 → 2 → 3 → 5; pha 4 làm được ngay sau pha 0; bước đọc định dạng của pha 6 làm sớm được.

## 5. Quy trình

Mỗi pha một plan trong `docs/superpowers/plans/` trước khi code; test viết trước; mỗi task một commit; cuối pha cập
nhật AGENTS.md, ADR, runbook, `deferred-items.md`. Workflow đã phát hành không sửa. Không push, không đổi hợp đồng
ag-farm/ag-go khi chưa hỏi người dùng. Test không gọi Claude thật (dùng `fixtures/fake-studio-claude.mjs`).

## 6. Rủi ro

- Hạn mức gói subscription hết nhanh khi chạy 20 lượt song song; mỗi lượt là một tiến trình `claude` (RAM).
- Pha 5 lớn nhất: đổi mô hình timeline kéo theo editor, render, xuất project.
- Định dạng CapCut có thể đổi khi CapCut cập nhật.
- Studio là sản phẩm của team (CI, deploy dev/prod): mọi thay đổi phải giữ hành vi cũ cho production đang chạy.
