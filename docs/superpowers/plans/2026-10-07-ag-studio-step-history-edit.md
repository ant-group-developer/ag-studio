# AG Studio — xem lại bước cũ, sửa trực tiếp mọi tài liệu (2026-10-07)

## Vì sao
Cột kết quả chỉ hiện tài liệu của bước đang ở (`thread.current`): bước đã duyệt thì không xem lại được. Sửa tay chỉ có
cho R&D/branding/kế hoạch tập lúc chờ duyệt, trong drawer. Người dùng muốn bấm vào một bước cũ để xem tài liệu của nó,
và sửa trực tiếp mọi tài liệu (nghiên cứu, R&D, branding, kế hoạch tập, YouTube kit, chọn cảnh, kế hoạch dựng,
timeline) ngay trong cột phải.

## Quyết định (người dùng chọn)
- Sửa ngay trong cột phải (nút **Sửa** → form tại chỗ, Lưu/Hủy), dùng chung cho bước đang chờ và bước cũ.
- Sửa bước **đã duyệt**: lưu, rồi hỏi có chạy lại không — nói rõ bước nào chạy lại và mất gì.
  - **Chỉ lưu** (bản đang dùng, các bước chưa chạy dùng bản mới): nghiên cứu (`productions.trend_report`, tập mới
    đọc), R&D/branding (`productions.rnd|branding`, `editProductionDocument`), YouTube kit (`episodes.youtube`,
    render/thumbnail/xuất đọc khi chạy). Kế hoạch tập, chọn cảnh, kế hoạch dựng **không có** bản đang dùng nào được đọc
    về sau: chỉ có "mở lại bước".
  - **Mở lại bước**: chạy lại từ gate đó (`resumeRunFrom`; run đang đỗ ở gate sau mà không gì đang chạy thì huỷ trước,
    như `rerunEpisodeFrom`), bản sửa thành bản đang hiện ở gate (một lượt "Sửa tay" trên scope của run mới); người bấm
    **Duyệt** thì các bước sau chạy tiếp. Mở lại một bước của kế hoạch series chạy lại `spawn-episodes` sau khi duyệt
    kế hoạch tập: **thay toàn bộ tập** — hộp xác nhận nói rõ.
- Timeline: xem bản mới nhất; Sửa = mở editor (đã có). Render lại như cũ.

## Task
1. **engine `step-docs.ts`** — `stepDocument(core, db, {productionId, episodeId?, kind})` → `{kind, gate, state:
   'not_yet'|'waiting'|'approved', document, inUse, edit: {inPlace, reopen: {allowed, code?, replacesEpisodes,
   reruns[]}}}`; `editStepDocument(core, db, {…, document, reopen, userId})`. Bản đã duyệt đọc từ gate
   (`readStageDocument(run, gate, STUDIO_GATES[gate])`), đè bằng bản đang dùng. Test trước.
2. **engine `saveManualEdit`** nhận đủ mọi gate: chọn cảnh lưu `{ops: [], survey}` (sửa lỗi lưu `{ops}`), kiểm schema
   tài liệu của gate thay cho schema đề xuất chat.
3. **API** `GET|PUT /productions/:id/steps/:kind`, `GET|PUT /productions/:id/episodes/:eid/steps/:kind` (xem: viewer;
   sửa kit tại chỗ: editor; còn lại: producer). Doc `studio-api-v3.md`.
4. **web: xem lại** — chip bước bấm được (bước đã qua, bước đang ở); cột phải hiện tài liệu bước đó + "Về bước hiện
   tại"; thanh phân bước trong chat có "xem tài liệu".
5. **web: sửa tại chỗ** — `DocEditor` dựng từ `DOC_SPECS` (text/list/chips/number/seconds/pairs/palette/episodes),
   `SurveyEditor`, `EditPlanEditor`; bước đang chờ lưu qua `saveManualEdit`, bước đã duyệt qua `PUT steps` với hộp
   hỏi Chỉ lưu / Mở lại bước. Bỏ drawer Sửa tay.
6. Test web, typecheck, kiểm trên trình duyệt; AGENTS.md.
