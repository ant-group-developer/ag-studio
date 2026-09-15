# Skill: style-analyze

## Mục tiêu

Xem các video mẫu của một kênh (đã được stage `watch` trích khung sẵn) và suy ra phong cách dựng
thành một bản nháp `style.json` (`status: draft`) kèm bằng chứng cho từng tham số, để `style-review`
đối chiếu lại trước khi kích hoạt.

## Input (đọc trong workspace, không sửa)

- `watch/watch.json` (`harness.watch/v1`, `mode: "samples"`) — mỗi video mẫu có `label`,
  `duration_seconds`, `frames[]` (khung đơn `{ t, file, kind }`), `sheets[]` (contact sheet).
- `watch/<label>/sheet-NN.png`, `watch/<label>/frames/f-<t>.png` — ảnh thật để `Read`.
- `samples.json` (trong input `sample_set`) — danh sách video mẫu gốc: `{ index, label, path, url?, frames }`.
- `brief.md` — hướng dẫn tự do cho tập này (không phải brief một tập cụ thể — đây là style-study).
- `stage-request.json` — nguồn sự thật cho `expected_outputs`, `inputs`, `options`.

## Ngân sách khung

- Đọc `sheet-NN.png` (contact sheet) của từng video mẫu trước — mỗi sheet cho cái nhìn tổng quan
  nhiều khung một lúc, rẻ hơn nhiều lần `Read` riêng lẻ.
- Chỉ mở thêm khung đơn (`frames/f-*.png`) khi cần nhìn rõ chi tiết (chữ, logo, nhịp cắt) không thấy
  rõ trên sheet. Tổng số khung đơn mở trong cả stage ≤20.
- Được dùng `WebSearch`/`WebFetch` để xác nhận đây đúng kênh mẫu (kênh chính chủ, không nhầm kênh
  reup) — skill duy nhất trong 5 skill này được phép ra mạng.

## Quy trình 8 bước

1. Đọc `watch.json`, liệt kê mọi video mẫu (label, thời lượng, số khung/sheet có sẵn).
2. Đọc `samples.json` để biết nguồn từng video (`path`/`url`) — dùng cho `learned_from`.
3. Mở từng `sheet-NN.png` theo thứ tự video; ghi nhận nhịp cắt (khoảng cách giữa các khung trong
   sheet), có chữ/overlay không, có phụ đề không, tông màu, kết cấu mở đầu.
4. Nếu cần xác nhận kênh mẫu, tìm web 1–2 lần (`WebSearch`); không tìm được thì bỏ qua, không bịa.
5. Với mỗi trường trong `params` (xem danh sách bên dưới), xác định giá trị và ghi ngay một dòng
   bằng chứng vào `evidence/notes.md`: `"video <label>, t=<giây>s: <mô tả ngắn>"`.
6. Chép ≤8 khung tiêu biểu nhất (đại diện cho các bằng chứng ở bước 5) từ `watch/<label>/frames/`
   hoặc `watch/<label>/sheet-*.png` vào `output/evidence/`.
7. Với mỗi video trong `samples.json`, thêm một mục `learned_from` (`label`, `url` nếu có, `notes`
   ngắn gọn) — danh sách phải khớp đúng `samples.json`, không thêm/bớt.
8. Ghi `output/style.json` (`status: "draft"`) và `output/evidence/notes.md`, rồi tự kiểm trước khi
   kết thúc.

## Cấu trúc `output/style.json`

```json
{
  "schema_version": "harness.edit-style/v1",
  "style_id": "style_<ulid>",
  "revision": 1,
  "name": "Tên phong cách ngắn gọn",
  "status": "draft",
  "learned_from": [
    { "label": "s0", "url": "https://...", "notes": "video mở đầu bằng hook 2s" }
  ],
  "params": {
    "cut_rhythm": "fast",
    "shot_seconds": [1, 3],
    "transitions": ["cut"],
    "text_overlay": { "style": "bold", "density": "medium" },
    "subtitles": "burn-in",
    "music": { "mood": "upbeat", "ducking": true },
    "opening": { "seconds": 2, "structure": "hook" },
    "aspect_ratio": "16:9",
    "pace_notes": "giữ nhịp nhanh ở 10 giây đầu"
  },
  "evidence": [{ "path": "evidence/s0-1.0.png", "note": "khung minh hoạ text_overlay" }],
  "created_at": "<ISO 8601>",
  "updated_at": "<ISO 8601>"
}
```

`params` phải đủ 9 trường trên, đúng kiểu (`cut_rhythm` một trong `fast|medium|slow`; `shot_seconds`
là khoảng `[min, max]` giây quan sát được; `subtitles` một trong `burn-in|karaoke|none`; `aspect_ratio`
dạng `"W:H"`). Ba trường định danh bạn **tự sinh, không được để trống** — harness không điền hộ, thiếu
hoặc sai định dạng là fail checker `schema-valid` ngay: `style_id` = `style_` + 26 ký tự Crockford
base32 (`0-9A-HJKMNP-TV-Z`, ví dụ `style_01JBQ7YF3K8ZC4M6N9PRTVWXYZ`); `created_at`/`updated_at` =
thời điểm ghi file, ISO 8601 UTC có hậu tố `Z` (ví dụ `2026-09-15T08:30:00.000Z`).

## `output/evidence/notes.md` — mẫu

```
- cut_rhythm: video s0, t=4.0s: cắt mỗi ~1.5s trong đoạn mở
- shot_seconds: video s0, t=4.0–7.0s: các đoạn dài 1–3s
- text_overlay: video s1, t=12.0s: chữ đậm, viền trắng, giữa khung
- subtitles: video s0, t=0.0s: phụ đề burn-in suốt video
- music: video s1, t=0.0s: nhạc nền sôi động, giảm âm khi có thoại
- opening: video s0, t=0.0–2.0s: hook trực tiếp câu hỏi
- aspect_ratio: video s0: khung dọc, đo bằng media info
- pace_notes: video s1, t=0–10s: nhịp nhanh, chậm dần giữa clip
- transitions: video s1, t=9.0s: cắt cứng, không hiệu ứng
```

Mỗi `params.*` phải có ≥1 dòng riêng theo mẫu trên (video nào, mốc giây nào, quan sát gì).

## Tiêu chí tự kiểm trước khi kết thúc

- [ ] `output/style.json` là JSON hợp lệ đúng `harness.edit-style/v1`, `status` = `"draft"`.
- [ ] Mỗi trường trong `params` có ≥1 dòng dẫn chứng trong `evidence/notes.md` nêu rõ video + mốc giây.
- [ ] `learned_from` khớp đúng danh sách video trong `samples.json` — không thêm/bớt video không có.
- [ ] Mọi giá trị trong `params` đều dựa trên khung/sheet đã xem — không suy đoán transition, nhạc,
      hay phụ đề nếu không thấy hoặc nghe được bằng chứng trong khung.
- [ ] `output/evidence/` có ≤8 ảnh, mỗi ảnh khớp một dòng trong `evidence.path` của `style.json`.

## Điều cấm

- Không ghi `status: "active"` — chỉ `style-review` được quyền kích hoạt style.
- Không tải video hay gọi API kênh nào ngoài `WebSearch`/`WebFetch` để xác nhận kênh mẫu.
- Không đọc hay ghi bất kỳ giá trị `secret://` hay biến `HARNESS_SECRET_*` nào.
- Không ghi file ngoài `output/`; không sửa `watch/`, `samples.json`, hay bất kỳ input nào khác.
- Không rời khỏi thư mục workspace hiện tại (không `cd`, không đọc đường dẫn tuyệt đối khác).
