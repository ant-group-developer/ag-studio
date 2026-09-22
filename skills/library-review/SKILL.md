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
- `fit-report.json` (trong input `fit_report`, `harness.fit-report/v1`) — cách `media-fit-edl` đã chỉnh
  hình cho vừa lời: `entries[]`, `shortfalls[] { line_ids, missing_seconds, reused_seconds,
  uncovered_seconds }`, `reused_seconds`, `within_target`. Đây là mục kiểm thứ 7, riêng của sub-project
  5A — không có trong `library-production@1.1.0` (thiếu input này thì bỏ qua bước 7, giữ 6 mục cũ).
- **`timeline.json` và `edl.json` NẰM CÙNG THƯ MỤC với `fit-report.json`** (`media-fit-edl`) — đây là bản
  dựng thật: `timeline.json` (`harness.timeline/v1`: `video[]`, `narration[]`, `speech[]`,
  `total_seconds`) và `edl.json` **đã khớp hình theo lời**. Mọi phép đối chiếu với tập đã dựng dùng ba file
  này.
- `edl.json` **nằm cạnh `edit-plan.json`** (`plan-edit`) là bản **trước khi khớp** — dự định của agent
  dựng, chỉ để tham khảo. `library-production@1.2.0` đưa **hai** input `edl` vào stage này; không bao giờ
  chấm bản dựng theo bản pre-fit đó. Cách phân biệt chắc chắn: bản nào cùng thư mục với `fit-report.json`
  thì là bản đã khớp.
- `composition.json` (trong input `composition`, `harness.composition/v1`) và `render-report.json` (trong
  input `render_report`, `harness.render-report/v1`) — bản dựng đã lên lịch và bản dựng đã render thật.
  Đây là mục kiểm thứ 9, riêng của sub-project 5B (`library-production@1.3.0`); thiếu hai input này thì bỏ
  qua bước 0b. **Phải đọc CẢ HAI**: `render-report.json` không gộp `composition.json.warnings`, và
  `text_dropped` chỉ đầy đủ ở `composition.json`.
- `stage-request.json` — nguồn sự thật cho `expected_outputs`, `inputs`, `options`, `policy`.

## Ngân sách khung

- Đọc `sheet-NN.png` trước — đủ để chấm phần lớn 6 mục kiểm.
- Mở khung đơn tại các mốc nghi vấn (mở đầu, các mốc có `text_overlays`, gần cuối video) khi sheet
  không đủ rõ. Tổng khung đơn mở ≤20.

## Quy trình 8 bước (thêm bước 0 khi có `fit-report.json`, bước 0b khi có `render-report.json`)

0. Nếu có input `fit_report`: đọc `fit-report.json`. Có input này và bất kỳ điều nào sau đây đúng thì
   quyết định thẳng `"rejected"` (bỏ qua bước 8 tính `decision` từ `checks`, nhưng vẫn chấm đủ 6 mục ở
   dưới để `note` đầy đủ thông tin):
   - `shortfalls` không rỗng (lời không đủ hình che phủ);
   - `reused_seconds > 5` (dùng lại cùng một đoạn hình quá 5 giây để lấp chỗ trống);
   - `within_target === false` (tổng thời lượng sau khi khớp hình lệch khỏi khoảng đích).
   `note` phải nêu rõ từng `line_id` trong `shortfalls[].line_ids` và số giây thiếu
   (`shortfalls[].missing_seconds`), để lượt dựng lại (`edit-plan`) biết đúng dòng lời cần viết lại
   hoặc rút ngắn.
0b. Nếu có input `render_report`: đọc **cả** `render-report.json` **và** `composition.json`. Bất kỳ điều
   nào sau đây đúng thì quyết định thẳng `"rejected"` (vẫn chấm đủ 6 mục để `note` đầy đủ):
   - `render-report.json.transitions.downgraded.length > 0.3 × transitions.requested` — chuyển cảnh gãy
     nhiều, thường do EDL cắt sát mép source;
   - `text_events.dropped` không rỗng (đối chiếu `composition.json.text_dropped` để có đủ `id` + `reason`)
     — chữ đã bị bỏ vì va chạm không giải được;
   - `music.track_id === null` mà brand có nhạc, tức `music.reason` KHÔNG phải `no_brand` hay
     `brand_no_tracks`;
   - `composition.json.warnings` có `word_interpolated` cho hơn 10 % số từ (phụ đề phải nội suy mốc thời
     gian vì thiếu word timing);
   - `render-report.json.loudness.integrated_lufs` nằm ngoài `[−16, −12]`.
   `note` phải nêu rõ `id` của từng overlay bị bỏ và `before_order` của từng mối nối bị hạ cấp, để lượt
   dựng lại (`edit-plan`) sửa đúng chỗ — không nói chung chung "chữ bị lỗi".
   **Không** từ chối vì những cảnh báo chỉ mang tính thông tin trong `render-report.json.warnings`:
   `encoder_cpu` (máy không có NVENC), `loudnorm_not_linear` (ffmpeg phải chuẩn hoá độ to theo chế độ
   dynamic vì hệ số đỉnh của bản trộn quá lớn). Chúng chỉ đáng nhắc trong `note` **khi** `loudness` đã nằm
   ngoài khoảng — lúc đó `loudnorm_not_linear` chính là lời giải thích.
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
- [ ] Có input `fit_report`: đã đọc và, nếu bước 0 buộc `"rejected"`, `note` nêu đủ `line_id` +
      số giây thiếu của từng dòng trong `shortfalls`, không chỉ nói chung chung "thiếu hình".
- [ ] Có hai input `edl`: đã đọc bản **cùng thư mục với `fit-report.json`** (bản đã khớp), không phải bản
      cạnh `edit-plan.json` (bản pre-fit).
- [ ] Có input `render_report`: đã đọc **cả hai** `render-report.json` và `composition.json` (không suy ra
      `text_dropped`/`warnings` từ một file), và nếu bước 0b buộc `"rejected"`, `note` nêu đủ `id` của
      overlay bị bỏ và `before_order` của mối nối bị hạ cấp.

## Điều cấm

- Không thêm/bớt mục kiểm ngoài 6 id cố định.
- Không gọi mạng — skill này chỉ dùng dữ liệu đã có trong workspace.
- Không đọc hay ghi bất kỳ giá trị `secret://` hay biến `HARNESS_SECRET_*` nào.
- Không ghi file ngoài `output/`; không sửa `edit-plan.json`, `brief.json`, `watch/`,
  `export-receipt.json`, `fit-report.json`, `composition.json`, `render-report.json`, hay `thumbnail_set`.
- Không rời khỏi thư mục workspace hiện tại (không `cd`, không đọc đường dẫn tuyệt đối khác).
