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
   `music` (mood/ducking theo `style_snapshot.music`). Nếu `expected_outputs` có `overlays` thì viết
   `output/overlays.json` theo mục "Cấu trúc `output/overlays.json`" bên dưới — đây là bản chữ trên hình
   thật sự được dựng, `edit-plan.json.text_overlays` chỉ là ghi chú kế hoạch.
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

## Cấu trúc `output/overlays.json`

Chỉ viết khi `stage-request.json.expected_outputs` có mục `type: "overlays"` (workflow
`library-production@1.3.0` trở lên). Đây là output **không bắt buộc**: một tập không cần chữ trên hình thì
bỏ hẳn file, stage vẫn đạt.

```json
{
  "schema_version": "harness.overlays/v1",
  "items": [
    { "id": "OV01", "kind": "title", "text": "Chợ nổi 5 giờ sáng", "anchor": { "line_id": "L001" }, "seconds": 4 },
    { "id": "OV02", "kind": "callout", "text": "30 nghìn/kg", "anchor": { "edl_order": 3 }, "seconds": 3 },
    { "id": "OV03", "kind": "lower_third", "text": "Cô Bảy — 20 năm bán trái cây", "anchor": { "line_id": "L004", "word_index": 2 } }
  ],
  "transitions": [{ "before_order": 5, "kind": "dissolve" }],
  "music": { "mood": "calm" }
}
```

- `id`: `OV01`…`OV999`, duy nhất. `kind`: `title` | `callout` | `lower_third`.
- **Giới hạn ký tự** (checker `overlays-valid` chặn cứng): `title` ≤ 48, `callout` ≤ 24,
  `lower_third` ≤ 64. Chữ dài hơn thì rút gọn, đừng cắt cụt giữa từ.
- **Quy tắc neo** (`anchor`, chọn đúng một trong ba dạng):
  - `{ "line_id": "L003", "word_index": 2 }` — neo vào một dòng trong `narration.json` (chỉ khi
    `voice === "tts"`); `word_index` tuỳ chọn, trỏ vào từ thứ mấy của dòng đó.
  - `{ "edl_order": 3 }` — neo vào một `order` có thật trong `edl.json.entries`; dùng khi `voice` là
    `none`/`original`, hoặc khi chữ gắn với hình chứ không với lời.
  - `{ "speech_index": 1 }` — neo vào đoạn lời thứ mấy trong `transcript.json` (chỉ khi
    `voice === "original"`).
  Neo trỏ vào `line_id`/`edl_order`/`speech_index` không tồn tại ⇒ `overlays-valid` fail ⇒ dựng lại.
- `seconds` (tuỳ chọn) trong khoảng `[1, 10]`; thiếu thì lấy mặc định của brand theo `kind`.
- **≤ 1 `title` cho mỗi đoạn** (mỗi `edl_order` sau khi giải neo) — hai title chồng nhau là lỗi.
- **Không lặp lại nguyên câu lời đọc**: chữ trên hình là rút gọn/nhấn mạnh, không phải phụ đề (phụ đề đã
  do `media-compose` sinh riêng từ `timeline.json`).
- **Mật độ** — `overlays-valid` đếm **tổng số `items`**, không đo khoảng cách giữa chúng. Ngân sách là
  `max(1, floor(seconds / spacing))`, trong đó `spacing` = 5 s (`density: high`), 8 s (`medium`, mặc định),
  15 s (`low`) theo `style_snapshot.text_overlay.density`, còn `seconds` là **cái lớn hơn** của (a) tổng ký
  tự lời bình chia cho 15 (`en`) hoặc 14 (`vi`) và (b) tổng `out - in` của `edl.json`. `none` ⇒ `items: []`.
  Nhiều hơn ngân sách ⇒ `overlays-valid` fail. Ngân sách **luôn ≥ 1**, nên một tập ngắn vẫn được phép có
  đúng một `title` mở đầu — nhưng cũng **chỉ** một: một tập 10 giây ở mật độ `medium` có ngân sách 1, dù hai
  overlay cách nhau 8 giây vẫn là quá dày.
- `transitions[]` **chỉ dùng ở chỗ đổi chủ đề** (ghi đè `brand.transition` cho đúng một mối nối):
  `before_order` là `order` của đoạn ĐỨNG SAU mối nối (≥ 1, có thật trong `edl.json`), `kind` là `cut` |
  `dissolve` | `dip_black`. Không liệt kê mọi mối nối — mặc định của brand đã đủ.
- `music.mood`: một từ khoá tâm trạng lấy từ brief (`style_snapshot.music.mood`) hoặc từ nội dung tập;
  `media-compose` dùng nó để chọn nhạc nền trong kho. Không có ứng viên khớp thì tập vẫn dựng, không nhạc.

## Tiêu chí tự kiểm trước khi kết thúc

- [ ] `output/edl.json` là JSON hợp lệ đúng `harness.edl/v1`; mọi `source_id` khớp một nguồn trong `shots.json`.
- [ ] Chỉ có shot `usable: true` trong `edl.json`; không đưa shot bị `survey.json` đánh dấu không dùng.
- [ ] `voice !== "original"`: tổng `out - in` nằm trong khoảng đích xác định ở bước 3 (hoặc bằng hết nguồn nếu ngắn hơn).
- [ ] Độ dài từng đoạn tham chiếu `style_snapshot.shot_seconds`/`cut_rhythm` khi có thể chọn được.
- [ ] `request_notes` có nội dung → `edit-plan.json.notes` nêu cách khắc phục (kèm `line_id`/`edl_order` nếu nói về lời thiếu hình).
- [ ] `output/narration.json` đúng `harness.narration/v1`; `lines: []` khi `voice` là `"none"`/`"original"`; mọi `edl_order` tồn tại trong `edl.json`.
- [ ] Có `expected_outputs.overlays` → `output/overlays.json` đúng `harness.overlays/v1`: mọi `anchor` trỏ
      vào `line_id`/`edl_order`/`speech_index` có thật, ≤ 1 `title` mỗi đoạn, độ dài chữ trong giới hạn
      48/24/64, **số** overlay không vượt ngân sách mật độ ở trên, `transitions[].before_order` có thật. Không cần chữ thì
      bỏ hẳn file (output không bắt buộc), đừng ghi file rỗng.

## Điều cấm

- Không đưa shot `usable: false` vào `edl.json`.
- Không gọi mạng — skill này chỉ dùng dữ liệu đã có trong workspace.
- Không đọc hay ghi bất kỳ giá trị `secret://` hay biến `HARNESS_SECRET_*` nào.
- Không ghi file ngoài `output/`; không sửa `survey.json`, `brief.json`, `shots.json`,
  `transcript.json`, `watch/`.
- Không rời khỏi thư mục workspace hiện tại (không `cd`, không đọc đường dẫn tuyệt đối khác).
