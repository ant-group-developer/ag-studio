---
name: scene-selection
description: Chọn cảnh cho một video — xem tờ ghép và khung hình của các video nguồn đã chuẩn bị, chấm điểm từng cảnh, ghi videos/<id>/scenes.md và survey.json. Dùng sau khi đầu vào của video đã chuẩn bị xong, trước kế hoạch dựng.
---

# Chọn cảnh → `videos/<id>/scenes.md` + `videos/<id>/survey.json`

## Đọc gì
- `videos/<id>/brief.md` (video kể gì, dài bao lâu), `channel/style.md` nếu có.
- `videos/<id>/sources/index.json`: các nguồn của video theo thứ tự, mỗi nguồn có `source_id` và danh sách cảnh
  `shot_id` (`s000-003` = nguồn 0, cảnh 3), `in`/`out` (giây trong video gốc), `frame` (khung giữa cảnh).
  Nguồn `status` khác `ready` chưa dùng được: gọi `inputs_prepare` hoặc báo người dùng.
- Mỗi nguồn: `inputs/<asset>/README.md`, tờ ghép `inputs/<asset>/sheets/NN.jpg` (16 cảnh, theo thứ tự trong README),
  khung `inputs/<asset>/frames/NNN.jpg` (NNN = số cảnh của nguồn, bắt đầu 001 ứng với `s…-000`), lời thoại
  `inputs/<asset>/transcript.md`. Mở ảnh bằng Read để xem. Xem tờ ghép trước, mở khung riêng khi cần nhìn kỹ.

## Làm từng nguồn, ghi dần
Một lượt có giới hạn thời gian; video nhiều nguồn rất dễ hết giờ giữa chừng. Vì vậy:
- Trước khi xem: đọc `survey.json` nếu đã có. Nguồn đã có đủ dòng thì bỏ qua, làm tiếp nguồn chưa chấm.
- Chấm theo tờ ghép (16 cảnh một tờ). Chỉ mở khung riêng cho cảnh còn phân vân, không mở lần lượt từng khung.
- Xem xong **mỗi nguồn** thì ghi ngay các dòng của nguồn đó vào `survey.json` (giữ các dòng đã có), rồi mới sang nguồn
  sau. Lượt bị cắt thì lượt sau không phải xem lại từ đầu.

## `survey.json` — Studio đọc, đúng một dòng cho mỗi cảnh của `sources/index.json`
```json
{
  "schema_version": "harness.survey-index/v2",
  "shots": [
    { "source_id": "src_…", "shot_id": "s000-000", "in": 0, "out": 4.2, "score": 4, "tags": ["thuyền", "sông", "establishing"],
      "usable": true, "note": "Thuyền trôi chậm, ánh sáng đẹp", "speech": "none",
      "size": "wide", "motion": "pan_right", "direction": "left_to_right" }
  ]
}
```
- `source_id`, `shot_id`, `in`, `out`: chép đúng từ `sources/index.json`.
- `score` 0–5 (5 = cảnh đẹp nhất, đúng ý brief); `usable: false` cho cảnh rung, mờ, lộ người lạ, logo, chữ, quá ngắn.
- `speech`: `talking` (có người nói rõ), `ambient` (tiếng nền có ích), `none`.
- `note` ngắn, nói vì sao. `tags` vài từ tiếng Việt về nội dung.
- Mỗi cảnh dùng được ghi thêm shot đó là gì, để kế hoạch dựng cắt cho đúng (xem "Ngữ pháp dựng" của skill edit-plan);
  Studio đọc ba khoá này khi kiểm kế hoạch dựng và khi dựng (bước lấp chỗ trống tránh cắt giữa hai shot cùng cỡ):
  - `size`: `wide` (toàn: thấy cả nơi chốn), `medium` (trung: người từ gối/hông lên, một nhóm việc), `close` (cận: mặt,
    tay, một vật), `detail` (chi tiết rất gần: hoa văn, giọt nước). Chấm theo khung giữa; cảnh đổi cỡ giữa chừng thì
    ghi cỡ của phần dài nhất.
  - `motion` (máy quay): `static`, `pan_left`/`pan_right` (lia), `tilt_up`/`tilt_down`, `push_in`/`pull_out` (tiến
    vào, lùi ra hay zoom), `tracking` (máy đi theo), `handheld` (cầm tay, rung nhẹ). Khung giữa không cho thấy chuyển
    động thì so với khung của cảnh trước, cảnh sau trên tờ ghép; còn phân vân thì bỏ trống.
  - `direction` (hướng của vật chuyển động trong khung, nếu có): `left_to_right`, `right_to_left`, `toward` (tiến về
    máy), `away`. Không có gì chuyển động rõ thì bỏ trống.
- Ghi thêm vào `tags`: `establishing` cho shot mở cảnh tốt (rộng, rõ nơi chốn, đứng yên hoặc lia chậm), `cutaway` cho
  chi tiết ngắn chèn được ở bất cứ đâu (tay, biển hiệu, đồ ăn, mặt nước).

## `scenes.md` — cho người đọc
Frontmatter `status: draft` (đổi `done` khi người dùng đồng ý). Thân: các cảnh tốt nhất theo phần của brief (mở đầu,
thân, kết), mỗi phần có shot nào để mở (toàn/establishing) và có đủ trung, cận, cutaway chưa; cảnh nên tránh và vì sao,
ghi chú về tiếng gốc.

Sau khi ghi: gọi `validate_file` cho `videos/<id>/survey.json`, sửa đến khi hết lỗi; cảnh báo "chưa chấm" nghĩa là còn
thiếu dòng. Rồi gợi ý bước kế hoạch dựng.
