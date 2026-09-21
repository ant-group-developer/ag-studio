# Skill: edit-plan

## Mục tiêu

Từ khảo sát nguồn (`survey.json`/`survey.md`, nhiều nguồn) và phong cách kênh (`style` snapshot trong
brief), chọn ra các đoạn dùng được xuyên suốt mọi nguồn và sắp thành một bản dựng (`edl.json`), kèm kế
hoạch mở đầu/chữ/nhạc (`edit-plan.json`) và lời thuyết minh có cấu trúc (`narration.json`) nếu kênh
dùng giọng đọc. Bản dựng này chưa cần khớp khít với lời — stage `media-fit-edl` (thuần máy, chạy sau)
sẽ chỉnh hình cho vừa thời lượng lời đọc thật; edit-plan chỉ cần ước lượng đủ gần.

## Input (đọc trong workspace, không sửa)

- `survey.json` (`harness.survey-index/v2`) + `survey.md` — điểm khả dụng từng shot, theo `source_id`.
- `brief.json` (trong input `brief`) — `topic`, `style_id`/`style_revision`, `style_snapshot`, `target_duration_seconds?`, `voice`, `language`, `request_notes?`.
- `shots.json` (trong input `shots`, `harness.shots/v2`) — `sources: [{ source_id, shots: [{ shot_id, in, out }] }]`.
- `transcript.json` (trong input `transcript`, `harness.transcript/v1`) — lời nói thật mỗi nguồn; bắt buộc dùng khi `voice === "original"` (không tự viết lời).
- `watch/watch.json` + `watch/<nnn>/sheet-NN.png` — xem lại khung nếu cần quyết định thứ tự dựng.
- `stage-request.json` — nguồn sự thật cho `expected_outputs`, `inputs`, `options`, `policy`.

## Ngân sách khung

- Ưu tiên đọc `survey.md`/`survey.json` (đã có điểm số) thay vì mở lại khung.
- Chỉ mở `watch/<nnn>/sheet-*.png` khi cần xem lại thứ tự/bối cảnh của các shot điểm cao. Tổng khung
  đơn mở ≤20.

## Quy trình 7 bước

1. Đọc `survey.json`, lọc ra các shot có `usable: true` trên mọi `source_id`, sắp theo thứ tự xuất
   hiện phù hợp với chủ đề (không nhất thiết theo `source_id`/`in` tăng dần — được phép xen nguồn) trừ
   khi nội dung cần một trật tự khác; ghi lý do chọn trật tự trong `edit-plan.json.notes`.
2. Đọc `brief.json.style_snapshot` để lấy `cut_rhythm` và `shot_seconds` — đây là khoảng thời lượng
   mục tiêu cho mỗi đoạn cắt; ưu tiên các shot usable có độ dài gần khoảng này.
3. Xác định khoảng thời lượng đích của tập: `brief.json.target_duration_seconds` nếu có; nếu không,
   `stage-request.json.policy.target_duration_seconds` nếu có; nếu vẫn không có, dùng mặc định
   `[60, 180]` giây.
4. Ghép các shot usable đã chọn (từ nhiều nguồn) thành các entry EDL liên tiếp (`order` tăng từ 0,
   `source_id` đúng theo shot gốc). `voice !== "original"`: cắt/bỏ bớt đoạn cuối nếu tổng vượt khoảng
   đích; thiếu so với đích (nguồn ngắn) thì ghi hết những gì có, nêu rõ trong `notes`. `voice ===
   "original"`: không cắt theo khoảng đích ở bước này (`media-fit-edl` bắt biên theo transcript sau) —
   chỉ chọn đủ shot phủ hết những đoạn có lời đáng giữ trong `transcript.json`.
5. Nếu `brief.json.request_notes` không rỗng (từng bị `library-review` từ chối, có thể nêu `line_id` +
   số giây thiếu từ lần chấm `media-fit-edl` trước), đọc lý do và điều chỉnh cách chọn/ghép shot hoặc
   lời — ví dụ `L003` thiếu 4.2s thì viết lại dài hơn hoặc thêm shot quanh `edl_order` của nó; ghi cách
   khắc phục vào `edit-plan.json.notes`.
6. Soạn `opening` (theo `style_snapshot.opening`), `text_overlays` (nếu overlay mật độ > `none`) và
   `music` (mood/ducking theo `style_snapshot.music`).
7. Ghi `output/edl.json`, `output/edit-plan.json`, `output/narration.json` rồi tự kiểm.
   `voice === "none"` hoặc `"original"` → `narration.json.lines: []` (bản `original` không viết lời
   mới, EDL đã cắt theo câu trọn ở bước 4). `voice === "tts"` → một dòng mỗi ý cần đọc, gắn đúng
   `edl_order` của entry EDL đi kèm; ước lượng 15 ký tự/giây (`en`) hoặc 14 (`vi`) để lời vừa khít hình
   ngay từ lần đầu, giảm việc `media-fit-edl` phải thêm/dùng lại shot.

## Cấu trúc `output/edl.json`

```json
{
  "schema_version": "harness.edl/v1",
  "entries": [
    { "source_id": "src_01H...", "in": 0, "out": 3.2, "order": 0, "overlay": null, "note": "mở đầu" },
    { "source_id": "src_01H...b", "in": 10.0, "out": 12.5, "order": 1, "overlay": null, "note": "" }
  ]
}
```

`source_id` phải đúng một trong các `shots.json.sources[].source_id`; `in < out`; `order` không trùng;
chỉ đưa vào các shot `usable: true`; với `voice !== "original"`, tổng `out - in` của mọi entry nằm
trong khoảng đích đã xác định ở bước 3.

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

## Cấu trúc `output/narration.json`

```json
{
  "schema_version": "harness.narration/v1",
  "language": "vi",
  "lines": [
    { "line_id": "L001", "edl_order": 0, "text": "Đây là câu mở đầu giới thiệu chủ đề." },
    { "line_id": "L002", "edl_order": 2, "text": "Ý tiếp theo, khớp với đoạn hình ở order 2." }
  ]
}
```

`language` khớp `brief.json.language`; `line_id` dạng `L001`, `L002`, ... duy nhất, theo thứ tự xuất
hiện; `edl_order` trỏ tới một `order` có thật trong `edl.json.entries` (checker `edl-valid` chặn
`edl_order` không tồn tại và `line_id` trùng); `text` không rỗng, ≤1200 ký tự, không cắt giữa câu.
Nhiều dòng có thể cùng `edl_order` (đọc nối tiếp trên cùng một đoạn hình).

## Tiêu chí tự kiểm trước khi kết thúc

- [ ] `output/edl.json` là JSON hợp lệ đúng `harness.edl/v1`; mọi `source_id` khớp một nguồn trong `shots.json`.
- [ ] Chỉ có shot `usable: true` trong `edl.json`; không đưa shot bị `survey.json` đánh dấu không dùng.
- [ ] `voice !== "original"`: tổng `out - in` nằm trong khoảng đích xác định ở bước 3 (hoặc bằng hết nguồn nếu ngắn hơn).
- [ ] Độ dài từng đoạn tham chiếu `style_snapshot.shot_seconds`/`cut_rhythm` khi có thể chọn được.
- [ ] `request_notes` có nội dung → `edit-plan.json.notes` nêu cách khắc phục (kèm `line_id`/`edl_order` nếu nói về lời thiếu hình).
- [ ] `output/narration.json` đúng `harness.narration/v1`; `lines: []` khi `voice` là `"none"`/`"original"`; mọi `edl_order` tồn tại trong `edl.json`.

## Điều cấm

- Không đưa shot `usable: false` vào `edl.json`.
- Không gọi mạng — skill này chỉ dùng dữ liệu đã có trong workspace.
- Không đọc hay ghi bất kỳ giá trị `secret://` hay biến `HARNESS_SECRET_*` nào.
- Không ghi file ngoài `output/`; không sửa `survey.json`, `brief.json`, `shots.json`,
  `transcript.json`, `watch/`.
- Không rời khỏi thư mục workspace hiện tại (không `cd`, không đọc đường dẫn tuyệt đối khác).
