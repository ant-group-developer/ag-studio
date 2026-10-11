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

## `survey.json` — Studio đọc, đúng một dòng cho mỗi cảnh của `sources/index.json`
```json
{
  "schema_version": "harness.survey-index/v2",
  "shots": [
    { "source_id": "src_…", "shot_id": "s000-000", "in": 0, "out": 4.2, "score": 4, "tags": ["thuyền", "sông"],
      "usable": true, "note": "Thuyền trôi chậm, ánh sáng đẹp", "speech": "none" }
  ]
}
```
- `source_id`, `shot_id`, `in`, `out`: chép đúng từ `sources/index.json`.
- `score` 0–5 (5 = cảnh đẹp nhất, đúng ý brief); `usable: false` cho cảnh rung, mờ, lộ người lạ, logo, chữ, quá ngắn.
- `speech`: `talking` (có người nói rõ), `ambient` (tiếng nền có ích), `none`.
- `note` ngắn, nói vì sao. `tags` vài từ tiếng Việt về nội dung.

## `scenes.md` — cho người đọc
Frontmatter `status: draft` (đổi `done` khi người dùng đồng ý). Thân: các cảnh tốt nhất theo phần của brief (mở đầu,
thân, kết), cảnh nên tránh và vì sao, ghi chú về tiếng gốc.

Sau khi ghi: gọi `validate_file` cho `videos/<id>/survey.json`, sửa đến khi hết lỗi; cảnh báo "chưa chấm" nghĩa là còn
thiếu dòng. Rồi gợi ý bước kế hoạch dựng.
