# Skill: style-review

## Mục tiêu

Đối chiếu bản nháp `style.json` (`status: draft`) do `style-analyze` viết ra với chính các khung
video mẫu, độc lập với bằng chứng agent trước đã ghi. Đạt thì kích hoạt (`status: active`); lệch
nhiều thì giữ nguyên `draft` và ghi rõ lý do để người xử lý tay.

## Input (đọc trong workspace, không sửa)

- `style.json` (trong input `style`, `status: draft`) — bản nháp cần đối chiếu.
- `evidence/` (trong input `style_evidence`) — `notes.md` + khung ảnh mà `style-analyze` đã dẫn chứng.
- `watch/watch.json` + `watch/<label>/frames/`, `watch/<label>/sheet-NN.png` — toàn bộ khung đã trích
  từ video mẫu (nguồn sự thật độc lập, không chỉ những khung `style-analyze` đã chọn).
- `stage-request.json` — nguồn sự thật cho `expected_outputs`, `inputs`, `options`.

## Ngân sách khung

- Đọc `evidence/notes.md` trước để biết `style-analyze` đã khẳng định gì.
- Chọn ngẫu nhiên ≥5 khung từ `watch.json` để đối chiếu độc lập — cách chọn: với mỗi video mẫu, lấy
  2 khung cách đều nhau trong khoảng thời lượng video đó (ví dụ 1/3 và 2/3 thời lượng); nếu có nhiều
  video, dừng khi đã đủ ≥5 khung. Không dùng lại nguyên khung `style-analyze` đã chép vào `evidence/`.
- Tổng khung đơn mở trong stage ≤20 (bao gồm cả khung trong `evidence/`).

## Quy trình 7 bước

1. Đọc `style.json` draft, liệt kê từng trường trong `params`.
2. Đọc `evidence/notes.md`, ghi nhận bằng chứng đã có cho từng trường.
3. Từ `watch.json`, chọn ≥5 khung theo cách nêu ở "Ngân sách khung" (2 khung/video, cách đều).
4. Với mỗi trường `params.*`, so khung mới chọn với giá trị đã ghi trong draft: khớp → "đạt"; không
   khớp (nhịp cắt khác, không thấy overlay như mô tả, phụ đề sai kiểu, …) → "lệch", ghi lý do ngắn.
5. Đếm số mục "lệch". ≤1 mục lệch → sửa lại đúng giá trị quan sát được (nếu cần) rồi đặt
   `status: "active"`. ≥2 mục lệch → giữ `status: "draft"`, không sửa `params`, chỉ ghi lý do.
6. Ghi `output/review-notes.md`: bảng `mục | đạt/lệch | khung dẫn chứng` cho mọi trường `params`.
7. Ghi `output/style.json` (giữ nguyên `style_id`/`revision`/`learned_from`, chỉ đổi `status` và
   `updated_at`, và `params` nếu bước 5 có sửa), rồi tự kiểm.

## Cấu trúc `output/style.json`

Giữ nguyên khuôn `harness.edit-style/v1` như `style-analyze` (xem `skills/style-analyze/SKILL.md`),
chỉ đổi `status` thành `"active"` (đạt) hoặc giữ `"draft"` (không đạt), và cập nhật `updated_at`.

## Cấu trúc `output/review-notes.md`

```
# Đối chiếu style_<id>

| mục | đạt/lệch | khung dẫn chứng |
|---|---|---|
| cut_rhythm | đạt | s0 t=1.7s, s0 t=3.3s |
| shot_seconds | đạt | s0 t=1.7s, s1 t=2.5s |
| text_overlay | lệch: không thấy overlay đậm như draft ghi | s1 t=1.3s |
| subtitles | đạt | s0 t=1.7s |
| music | đạt | s1 t=2.5s |
| opening | đạt | s0 t=1.7s |
| aspect_ratio | đạt | s0 t=1.7s |
| transitions | đạt | s1 t=1.3s |
| pace_notes | đạt | s0 t=3.3s |

Kết luận: 1 mục lệch → status: active.
```

## Tiêu chí tự kiểm trước khi kết thúc

- [ ] `output/style.json` là JSON hợp lệ đúng `harness.edit-style/v1`.
- [ ] Đã đối chiếu ≥5 khung được chọn theo đúng cách "2 khung/video, cách đều" — không chỉ dùng lại
      khung trong `evidence/` cũ.
- [ ] `output/review-notes.md` có một dòng cho mọi trường trong `params` (đạt hay lệch, kèm khung
      dẫn chứng).
- [ ] ≥2 mục lệch → `status` phải là `"draft"`, không được đặt `"active"`.
- [ ] ≤1 mục lệch → `status` là `"active"`, và nếu sửa `params` thì giá trị mới khớp khung vừa xem.
- [ ] `style_id`, `revision`, `learned_from` giữ nguyên như draft đầu vào — không đổi.

## Điều cấm

- Không đặt `status: "active"` khi có ≥2 mục lệch — kể cả khi tin phong cách vẫn "đủ tốt".
- Không tự thêm khung mới ngoài `watch/` (không tải video, không gọi mạng — skill này không có quyền
  `WebSearch`/`WebFetch`).
- Không đọc hay ghi bất kỳ giá trị `secret://` hay biến `HARNESS_SECRET_*` nào.
- Không ghi file ngoài `output/`; không sửa `evidence/`, `watch/`, hay `style.json` gốc trong input.
- Không rời khỏi thư mục workspace hiện tại (không `cd`, không đọc đường dẫn tuyệt đối khác).
