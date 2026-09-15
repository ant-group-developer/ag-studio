# Skill: edit-plan

## Mục tiêu

Từ khảo sát nguồn (`survey.json`/`survey.md`) và phong cách kênh (`style` snapshot trong brief),
chọn ra các đoạn dùng được và sắp thành một bản dựng (`edl.json`), kèm kế hoạch mở đầu/chữ/nhạc
(`edit-plan.json`) và lời thuyết minh (`narration.txt`) nếu kênh dùng giọng đọc.

## Input (đọc trong workspace, không sửa)

- `survey.json` (`harness.survey-index/v1`) + `survey.md` — điểm khả dụng từng shot.
- `brief.json` (trong input `brief`) — `topic`, `style_id`/`style_revision`, `style_snapshot`
  (tham số style tại lúc nhận request), `target_duration_seconds?`, `voice`, `request_notes?`.
- `shots.json` (trong input `shots`) — `source_id`, `duration_seconds`, `shots: [{ in, out }]`.
- `watch/watch.json` + `watch/<label>/sheet-NN.png` — xem lại khung nếu cần quyết định thứ tự dựng.
- `stage-request.json` — nguồn sự thật cho `expected_outputs`, `inputs`, `options`, `policy`.

## Ngân sách khung

- Ưu tiên đọc `survey.md`/`survey.json` (đã có điểm số) thay vì mở lại khung.
- Chỉ mở `watch/<label>/sheet-*.png` khi cần xem lại thứ tự/bối cảnh của các shot điểm cao. Tổng
  khung đơn mở ≤20.

## Quy trình 7 bước

1. Đọc `survey.json`, lọc ra các shot có `usable: true`, sắp theo thứ tự xuất hiện trong nguồn (theo
   `in` tăng dần) trừ khi nội dung cần đảo thứ tự — nếu đảo, ghi lý do trong `edit-plan.json.notes`.
2. Đọc `brief.json.style_snapshot` để lấy `cut_rhythm` và `shot_seconds` — đây là khoảng thời lượng
   mục tiêu cho mỗi đoạn cắt; ưu tiên các shot usable có độ dài gần khoảng này.
3. Xác định khoảng thời lượng đích của tập: `brief.json.target_duration_seconds` nếu có; nếu không,
   `stage-request.json.policy.target_duration_seconds` nếu có; nếu vẫn không có, dùng mặc định
   `[60, 180]` giây.
4. Ghép các shot usable đã chọn thành các entry EDL liên tiếp (`order` tăng dần từ 0), cắt bớt đoạn
   cuối cùng (giảm `out`) hoặc bỏ bớt đoạn cuối nếu tổng vượt khoảng đích; nếu tổng các shot usable
   còn thiếu so với khoảng đích (nguồn ngắn), ghi hết những gì có và nêu rõ trong `notes`.
5. Nếu `brief.json.request_notes` không rỗng (tập này từng bị `library-review` từ chối), đọc lý do
   và điều chỉnh cách chọn/ghép shot cho phù hợp; ghi rõ cách khắc phục vào `edit-plan.json.notes`.
6. Soạn `opening` (mở đầu theo `style_snapshot.opening`), `text_overlays` (nếu `style_snapshot`
   dùng overlay mật độ > `none`) và `music` (mood/ducking theo `style_snapshot.music`).
7. Ghi `output/edl.json`, `output/edit-plan.json`, `output/narration.txt` (rỗng nếu
   `brief.json.voice === "none"`, ngược lại một dòng thuyết minh mỗi đoạn), rồi tự kiểm.

## Cấu trúc `output/edl.json`

```json
{
  "schema_version": "harness.edl/v1",
  "entries": [
    { "source_id": "src_<ulid>", "in": 0, "out": 3.2, "order": 0, "overlay": null, "note": "mở đầu" },
    { "source_id": "src_<ulid>", "in": 10.0, "out": 12.5, "order": 1, "overlay": null, "note": "" }
  ]
}
```

`source_id` phải đúng `shots.json.source_id`; `in < out`; `order` không trùng; chỉ đưa vào các shot
`usable: true`; tổng `out - in` của mọi entry nằm trong khoảng đích đã xác định ở bước 3.

## Cấu trúc `output/edit-plan.json`

```json
{
  "schema_version": "harness.edit-plan/v1",
  "opening": { "seconds": 2, "structure": "hook", "note": "câu hỏi mở đầu theo style" },
  "text_overlays": [{ "at": 0.0, "text": "Tiêu đề ngắn", "seconds": 2 }],
  "music": { "mood": "upbeat", "ducking": true },
  "notes": "Không có request_notes trước đó."
}
```

Đây là JSON tự do (không có schema chặn cứng, giống 2C) — giữ đủ 5 khoá trên; `notes` bắt buộc nêu
cách khắc phục nếu `brief.json.request_notes` có nội dung, ngược lại ghi ngắn gọn không có yêu cầu gì.

## `output/narration.txt`

Rỗng khi `brief.json.voice === "none"`. Khác `"none"` thì mỗi dòng là lời thuyết minh cho một đoạn
EDL theo đúng thứ tự `order`, khớp nội dung khung ở đoạn đó.

## Tiêu chí tự kiểm trước khi kết thúc

- [ ] `output/edl.json` là JSON hợp lệ đúng `harness.edl/v1`; mọi `source_id` khớp `shots.json`.
- [ ] Chỉ có shot `usable: true` trong `edl.json`; không đưa shot bị `survey.json` đánh dấu không dùng.
- [ ] Tổng `out - in` của mọi entry nằm trong khoảng đích xác định ở bước 3 (hoặc bằng hết nguồn nếu
      nguồn ngắn hơn khoảng đích).
- [ ] Độ dài từng đoạn tham chiếu `style_snapshot.shot_seconds`/`cut_rhythm` khi có thể chọn được.
- [ ] Nếu `brief.json.request_notes` có nội dung, `edit-plan.json.notes` nêu rõ cách khắc phục.
- [ ] `output/narration.txt` rỗng đúng khi `voice: "none"`.

## Điều cấm

- Không đưa shot `usable: false` vào `edl.json`.
- Không gọi mạng — skill này chỉ dùng dữ liệu đã có trong workspace.
- Không đọc hay ghi bất kỳ giá trị `secret://` hay biến `HARNESS_SECRET_*` nào.
- Không ghi file ngoài `output/`; không sửa `survey.json`, `brief.json`, `shots.json`, `watch/`.
- Không rời khỏi thư mục workspace hiện tại (không `cd`, không đọc đường dẫn tuyệt đối khác).
