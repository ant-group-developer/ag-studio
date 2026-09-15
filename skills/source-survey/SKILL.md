# Skill: source-survey

## Mục tiêu

Xem toàn bộ nguồn thô của một tập (qua stage `watch`) và chấm điểm khả dụng từng đoạn (`shot`) trong
`shots.json`, để `edit-plan` chỉ chọn những đoạn dùng được khi dựng.

## Input (đọc trong workspace, không sửa)

- `watch/watch.json` (`mode: "source"`) + `watch/<label>/sheet-NN.png`, `watch/<label>/frames/` —
  khung đã trích từ nguồn, có thêm khung tại mỗi mốc `shots[].in`.
- `shots.json` (trong input `shots`) — `{ source_id, duration_seconds, shots: [{ in, out }], transcript }`.
- `brief.json` (trong input `brief`) — `topic`, `style_id`, `target_duration_seconds?`, `request_notes?`.
- `stage-request.json` — nguồn sự thật cho `expected_outputs`, `inputs`, `options`.

## Ngân sách khung

- Đọc `sheet-NN.png` trước để có cái nhìn tổng quan toàn nguồn.
- Với mỗi `shot` trong `shots.json`, chỉ mở thêm khung đơn tại `in`/`out`/giữa đoạn khi contact sheet
  không đủ rõ để chấm điểm (nghi có chữ/logo/mặt người/rung/đen). Tổng khung đơn mở ≤20.
- Nhiều shot ngắn liền kề có thể chấm chung từ một khung nếu contact sheet đã đủ rõ ràng.

## Quy trình 6 bước

1. Đọc `shots.json`, liệt kê mọi `shot` theo thứ tự (`in`, `out`).
2. Đọc `brief.json` để biết chủ đề (`topic`) — dùng để đánh giá đoạn nào liên quan nội dung.
3. Với mỗi `shot`, xem khung tương ứng trên `watch/<label>/sheet-*.png` (và khung đơn nếu cần):
   - Đánh dấu tag nếu thấy: `text` (có chữ/overlay sẵn trong nguồn), `logo` (logo kênh khác), `face`
     (mặt người rõ có thể cần che/xin phép), `shaky` (rung mạnh), `black` (khung đen/mất hình).
   - Có bất kỳ tag nào ở trên (trừ khi chủ đề yêu cầu đúng cảnh đó và không thể thay) → `usable: false`.
   - Chấm `score` 0–5: 5 = rõ nét, đúng chủ đề, không lỗi; giảm dần theo mức độ lỗi/liên quan kém;
     0 = không dùng được (kèm `usable: false`).
4. Ghi một dòng `note` ngắn cho mỗi shot giải thích điểm/tag (ví dụ lý do `usable: false`).
5. Ghi `output/survey.md` (bảng tổng hợp, dễ đọc cho người) và `output/survey.json` (dữ liệu máy đọc).
6. Tự kiểm trước khi kết thúc.

## Cấu trúc `output/survey.json`

```json
{
  "schema_version": "harness.survey-index/v1",
  "shots": [
    { "in": 0, "out": 3.2, "score": 5, "tags": [], "usable": true, "note": "cảnh mở rõ nét, đúng chủ đề" },
    { "in": 3.2, "out": 6.0, "score": 1, "tags": ["shaky", "text"], "usable": false, "note": "rung mạnh, có chữ overlay sẵn từ nguồn gốc" }
  ]
}
```

Số phần tử trong `shots` phải bằng đúng số phần tử trong `shots.json.shots`, theo đúng thứ tự.

## Cấu trúc `output/survey.md`

```
# Khảo sát nguồn <source_id>

| # | in | out | score | tags | usable | note |
|---|---|---|---|---|---|---|
| 0 | 0.0 | 3.2 | 5 | - | có | cảnh mở rõ nét, đúng chủ đề |
| 1 | 3.2 | 6.0 | 1 | shaky, text | không | rung mạnh, có chữ overlay sẵn |

Tổng: 2 shot, 1 usable.
```

## Tiêu chí tự kiểm trước khi kết thúc

- [ ] `output/survey.json` là JSON hợp lệ đúng `harness.survey-index/v1`.
- [ ] Mọi `shot` trong `shots.json` có đúng một mục tương ứng trong `survey.json.shots`, cùng thứ tự.
- [ ] Ít nhất 1 shot có `usable: true` (nếu nguồn thật sự không dùng được shot nào, ghi rõ trong
      `survey.md` để người xem lại — nhưng cố hết sức tránh trường hợp này).
- [ ] Mọi shot có chữ/logo/mặt người/rung/đen quan sát được đều có tag tương ứng trong `tags`.
- [ ] `output/survey.md` liệt kê đủ số shot bằng `shots.json`, khớp dữ liệu với `survey.json`.
- [ ] Mỗi `note` giải thích ngắn gọn vì sao có điểm/tag đó — không để trống khi `usable: false`.

## Điều cấm

- Không tự thêm hay bớt shot so với `shots.json` — chỉ chấm điểm, không sửa ranh giới `in`/`out`.
- Không gọi mạng (`WebSearch`/`WebFetch`) — skill này chỉ xem nguồn đã có trong workspace.
- Không đọc hay ghi bất kỳ giá trị `secret://` hay biến `HARNESS_SECRET_*` nào.
- Không ghi file ngoài `output/`; không sửa `shots.json`, `brief.json`, `watch/`, hay input nào khác.
- Không rời khỏi thư mục workspace hiện tại (không `cd`, không đọc đường dẫn tuyệt đối khác).
