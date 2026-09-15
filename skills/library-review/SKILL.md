# Skill: library-review

## Mục tiêu

Kiểm tra bản dựng hoàn chỉnh của một tập (đã xuất ra kho, `pending_review`) so với brief và style,
chấm đúng 6 mục cố định, rồi quyết định `approved`/`rejected`. Đây là lưới an toàn cuối cùng trước
khi tập vào kho — checker cứng đã chặn lỗi kỹ thuật; skill này xét lỗi cần "xem" mới thấy.

## Input (đọc trong workspace, không sửa)

- `watch/watch.json` (`mode: "episode"`) + `watch/<label>/sheet-NN.png`, `watch/<label>/frames/` —
  khung đã trích từ tập đã dựng xong (`episode.mp4`).
- `edit-plan.json` (trong input `edit_plan`) — kế hoạch dựng: `opening`, `text_overlays`, `music`.
- `brief.json` (trong input `brief`) — `topic`, `style_snapshot`, `target_duration_seconds?`.
- `export-receipt.json` (trong input `export_receipt`) — `{ item_id, item_dir, files, manifest_checksum }`.
- `thumbnail_set` (thư mục) — các ảnh thumbnail ứng viên đã render.
- `stage-request.json` — nguồn sự thật cho `expected_outputs`, `inputs`, `options`, `policy`.

## Ngân sách khung

- Đọc `sheet-NN.png` trước — đủ để chấm phần lớn 6 mục kiểm.
- Mở khung đơn tại các mốc nghi vấn (mở đầu, các mốc có `text_overlays`, gần cuối video) khi sheet
  không đủ rõ. Tổng khung đơn mở ≤20.

## Quy trình 8 bước

1. Đọc `brief.json` để biết `target_duration_seconds` (khoảng đích) và `style_snapshot`.
2. Đọc `watch.json`, lấy `duration_seconds` của tập — so với khoảng đích ⇒ `duration_in_range`.
3. Lướt toàn bộ `sheet-*.png` tìm khung đen liên tục hoặc khung đứng hình (hai khung liền kề giống
   hệt nhau) kéo dài >2 giây ⇒ `no_black_or_frozen_over_2s`.
4. Xem khung mở đầu (0–`style_snapshot.opening.seconds` giây) so với `style_snapshot.opening.structure`
   ⇒ `opening_matches_style`.
5. Xem khung tại mỗi mốc `edit-plan.json.text_overlays[].at`, kiểm chữ không bị cắt mép khung hình
   ⇒ `text_not_clipped` (không có overlay nào thì mặc định đạt).
6. Xác nhận tập có tiếng (không phải toàn bộ im lặng — xem waveform/metadata nếu có, hoặc dựa vào
   `watch.json` media info `has_audio`) ⇒ `audio_present`.
7. Mở từng ảnh trong `thumbnail_set`, xác nhận không có chữ chồng sẵn trong ảnh (chữ sẽ do kênh thêm
   sau) ⇒ `thumbnails_textless`.
8. Ghi `output/review.json`: `decision: "rejected"` nếu có ≥1 check `pass: false`, ngược lại
   `"approved"`; `note` tổng hợp nêu rõ mốc giây của từng lỗi (nếu có), rồi tự kiểm.

## Cấu trúc `output/review.json`

```json
{
  "schema_version": "harness.review/v1",
  "decision": "rejected",
  "note": "duration_in_range: 182.4s vượt khoảng đích [60,180] tại t=180.0s",
  "checks": [
    { "id": "duration_in_range", "pass": false, "note": "182.4s, khoảng đích [60,180]" },
    { "id": "no_black_or_frozen_over_2s", "pass": true, "note": "" },
    { "id": "opening_matches_style", "pass": true, "note": "hook 2s khớp style_snapshot" },
    { "id": "text_not_clipped", "pass": true, "note": "" },
    { "id": "audio_present", "pass": true, "note": "có tiếng suốt video theo watch.json" },
    { "id": "thumbnails_textless", "pass": true, "note": "3 ảnh, không ảnh nào có chữ" }
  ]
}
```

`checks` luôn đủ và đúng thứ tự 6 id: `duration_in_range`, `no_black_or_frozen_over_2s`,
`opening_matches_style`, `text_not_clipped`, `audio_present`, `thumbnails_textless`. `decision` phải
nhất quán với `checks` (≥1 `pass: false` ⇒ `"rejected"`).

## Tiêu chí tự kiểm trước khi kết thúc

- [ ] `output/review.json` là JSON hợp lệ đúng `harness.review/v1`.
- [ ] `checks` có đúng 6 mục, đúng 6 id cố định ở trên, không thiếu không thừa.
- [ ] `decision` khớp `checks`: có ≥1 `pass: false` ⇒ `"rejected"`; toàn bộ `pass: true` ⇒ `"approved"`.
- [ ] Mọi `note` của mục `pass: false` nêu rõ mốc giây (hoặc khoảng giây) cụ thể của lỗi, không chỉ
      nói chung chung.
- [ ] Đã xem `thumbnail_set` và khung mở đầu thật, không suy đoán từ `edit-plan.json` một mình.

## Điều cấm

- Không thêm/bớt mục kiểm ngoài 6 id cố định.
- Không gọi mạng — skill này chỉ dùng dữ liệu đã có trong workspace.
- Không đọc hay ghi bất kỳ giá trị `secret://` hay biến `HARNESS_SECRET_*` nào.
- Không ghi file ngoài `output/`; không sửa `edit-plan.json`, `brief.json`, `watch/`,
  `export-receipt.json`, hay `thumbnail_set`.
- Không rời khỏi thư mục workspace hiện tại (không `cd`, không đọc đường dẫn tuyệt đối khác).
