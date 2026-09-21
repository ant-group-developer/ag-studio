# Skill: source-survey

## Mục tiêu

Xem toàn bộ nguồn thô của một tập — có thể nhiều clip từ cùng một buổi quay (`shots.json` v2, nhiều
`source_id`) — qua stage `watch` và `transcript.json`, rồi chấm điểm khả dụng từng đoạn (`shot`) để
`edit-plan` chỉ chọn những đoạn dùng được khi dựng.

## Input (đọc trong workspace, không sửa)

- `watch/watch.json` (`mode: "source"`) + `watch/<nnn>/sheet-NN.png`, `watch/<nnn>/frames/` — khung đã
  trích từ mỗi nguồn (thư mục đặt tên theo `source.index` 3 chữ số), có thêm khung tại mỗi mốc
  `shots[].in`.
- `shots.json` (trong input `shots`, `harness.shots/v2`) — `{ sources: [{ source_id, index, file_name,
  duration_seconds, has_audio, shots: [{ shot_id, in, out }] }] }`, một phần tử `sources` cho mỗi clip.
- `transcript.json` (trong input `transcript`, `harness.transcript/v1`) — `{ sources: [{ source_id,
  language, alignment, segments: [{ start, end, text, words }] }] }` — lời nói (nếu có) của từng nguồn;
  dùng để suy `speech` cho mỗi shot mà không cần nghe lại.
- `brief.json` (trong input `brief`) — `topic`, `style_id`, `target_duration_seconds?`, `request_notes?`.
- `stage-request.json` — nguồn sự thật cho `expected_outputs`, `inputs`, `options`.

## Ngân sách khung

- Đọc `sheet-NN.png` của từng nguồn trước để có cái nhìn tổng quan — tổng số tấm trong toàn bộ
  `watch/` không vượt `stage-request.json.stage_config`/`media.watch.max_sheets` (giá trị này đã được
  stage `watch` áp khi trích khung, không phải việc của skill).
- Với mỗi `shot`, chỉ mở thêm khung đơn tại `in`/`out`/giữa đoạn khi contact sheet không đủ rõ để chấm
  điểm (nghi có chữ/logo/mặt người/rung/đen). Tổng khung đơn mở ≤20 cho toàn bộ tập (không phải riêng
  từng nguồn).
- Nhiều shot ngắn liền kề của cùng một nguồn có thể chấm chung từ một khung nếu contact sheet đã đủ rõ.
- Ưu tiên đọc `transcript.json` trước khi mở thêm khung: một đoạn có lời nói rõ ràng trong transcript
  thường không cần xem lại khung để biết `speech`.

## Quy trình 6 bước

1. Đọc `shots.json`, liệt kê mọi `shot` của mọi `source_id` theo thứ tự (`source_id`, `in`, `out`).
2. Đọc `transcript.json`, với mỗi `source_id` gom các `segments` — một `shot` có đoạn transcript giao
   với khoảng `[in, out)` của nó (dù chỉ một phần) thì có lời nói.
3. Đọc `brief.json` để biết chủ đề (`topic`) — dùng để đánh giá đoạn nào liên quan nội dung.
4. Với mỗi `shot` (theo `shot_id`), xem khung tương ứng trên `watch/<nnn>/sheet-*.png` (và khung đơn
   nếu cần):
   - Đánh dấu tag nếu thấy: `text` (có chữ/overlay sẵn trong nguồn), `logo` (logo kênh khác), `face`
     (mặt người rõ có thể cần che/xin phép), `shaky` (rung mạnh), `black` (khung đen/mất hình).
   - Có bất kỳ tag nào ở trên (trừ khi chủ đề yêu cầu đúng cảnh đó và không thể thay) → `usable: false`.
   - Chấm `score` 0–5: 5 = rõ nét, đúng chủ đề, không lỗi; giảm dần theo mức độ lỗi/liên quan kém;
     0 = không dùng được (kèm `usable: false`).
   - Ghi `speech`: `"talking"` nếu bước 2 tìm thấy lời nói giao với shot đó và nghe có người nói (không
     chỉ tiếng nền); `"ambient"` nếu có âm thanh môi trường/nhạc nhưng không có lời; `"none"` nếu im
     lặng hoặc nguồn không có audio (`has_audio: false`).
5. Ghi một dòng `note` ngắn cho mỗi shot giải thích điểm/tag/speech (ví dụ lý do `usable: false`).
6. Ghi `output/survey.md` (bảng tổng hợp, dễ đọc cho người, nhóm theo `source_id`) và
   `output/survey.json` (dữ liệu máy đọc, `harness.survey-index/v2`), rồi tự kiểm.

## Cấu trúc `output/survey.json`

```json
{
  "schema_version": "harness.survey-index/v2",
  "shots": [
    { "source_id": "src_01H...", "shot_id": "s000-000", "in": 0, "out": 3.2, "score": 5, "tags": [],
      "usable": true, "note": "cảnh mở rõ nét, đúng chủ đề", "speech": "talking" },
    { "source_id": "src_01H...", "shot_id": "s000-001", "in": 3.2, "out": 6.0, "score": 1,
      "tags": ["shaky", "text"], "usable": false, "note": "rung mạnh, có chữ overlay sẵn từ nguồn gốc",
      "speech": "none" }
  ]
}
```

Số phần tử trong `shots` phải bằng đúng tổng số phần tử trong mọi `shots.json.sources[].shots`, mỗi
phần tử khớp đúng `source_id`/`shot_id`/`in`/`out` của shot tương ứng trong `shots.json` (checker
`survey-valid` cross-check ±0,05s).

## Cấu trúc `output/survey.md`

```
# Khảo sát nguồn (nhiều clip)

## src_01H... (C0001.MP4)

| shot_id | in | out | score | tags | usable | speech | note |
|---|---|---|---|---|---|---|---|
| s000-000 | 0.0 | 3.2 | 5 | - | có | talking | cảnh mở rõ nét, đúng chủ đề |
| s000-001 | 3.2 | 6.0 | 1 | shaky, text | không | none | rung mạnh, có chữ overlay sẵn |

Tổng: 2 shot, 1 usable.
```

Một mục (`##`) cho mỗi `source_id`, theo đúng thứ tự `shots.json.sources[].index`.

## Tiêu chí tự kiểm trước khi kết thúc

- [ ] `output/survey.json` là JSON hợp lệ đúng `harness.survey-index/v2`.
- [ ] Mọi `shot` trong mọi `sources[]` của `shots.json` có đúng một mục tương ứng trong
      `survey.json.shots` (khớp `source_id`+`shot_id`), không thiếu không thừa.
- [ ] Mỗi shot có `speech` hợp lệ (`none`/`talking`/`ambient`), suy từ `transcript.json` chứ không đoán.
- [ ] Ít nhất 1 shot có `usable: true` (nếu nguồn thật sự không dùng được shot nào, ghi rõ trong
      `survey.md` để người xem lại — nhưng cố hết sức tránh trường hợp này).
- [ ] Mọi shot có chữ/logo/mặt người/rung/đen quan sát được đều có tag tương ứng trong `tags`.
- [ ] `output/survey.md` liệt kê đủ số shot của mọi nguồn, khớp dữ liệu với `survey.json`.
- [ ] Mỗi `note` giải thích ngắn gọn vì sao có điểm/tag đó — không để trống khi `usable: false`.

## Điều cấm

- Không tự thêm hay bớt shot so với `shots.json` — chỉ chấm điểm, không sửa ranh giới `in`/`out`.
- Không gọi mạng (`WebSearch`/`WebFetch`) — skill này chỉ xem nguồn đã có trong workspace.
- Không đọc hay ghi bất kỳ giá trị `secret://` hay biến `HARNESS_SECRET_*` nào.
- Không ghi file ngoài `output/`; không sửa `shots.json`, `transcript.json`, `brief.json`, `watch/`,
  hay input nào khác.
- Không rời khỏi thư mục workspace hiện tại (không `cd`, không đọc đường dẫn tuyệt đối khác).
