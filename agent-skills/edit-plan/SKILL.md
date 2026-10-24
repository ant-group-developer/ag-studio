---
name: edit-plan
description: Viết kế hoạch dựng của một video — thứ tự shot, đoạn lấy trong mỗi shot, lời dẫn, chữ trên hình, chuyển cảnh, tắt tiếng gốc, cắt theo nhịp nhạc — vào videos/<id>/edit-plan.md và edit-plan.json, rồi dựng timeline. Dùng sau khi đã chọn cảnh (survey.json).
---

# Kế hoạch dựng → `videos/<id>/edit-plan.md` + `videos/<id>/edit-plan.json`

## Đọc gì
`videos/<id>/brief.md`, `scenes.md`, `survey.json`, `sources/index.json`, lời thoại `inputs/<asset>/transcript.md`,
`channel/branding.md` (giọng văn, `music_mood`), `channel/style.md` nếu có. Dùng cảnh `usable: true`, điểm cao.

## `edit-plan.json` — Studio đọc khi dựng timeline
```json
{
  "schema_version": "studio.edit-plan/v1",
  "narration": "tts",
  "language": "vi",
  "target_seconds": 90,
  "shots": [
    { "order": 1, "shot_id": "s000-003", "source_id": "src_…", "in": 31.0, "out": 36.5, "line_id": "L001",
      "transition": "cut", "section_title": "Mở đầu", "note": "thuyền vào hang", "source_audio": "keep", "snap": "bar" },
    { "order": 2, "shot_id": "s001-000", "source_id": "src_…", "in": 0.5, "out": 6.0, "line_id": null,
      "transition": "dissolve", "section_title": null, "note": "", "source_audio": "mute" }
  ],
  "lines": [ { "line_id": "L001", "text": "Tràng An buổi sáng, nước lặng như gương." } ],
  "texts": [ { "text_id": "T001", "kind": "title", "text": "Tràng An", "at_order": 1, "offset_s": 0.5, "duration": 3, "position": "top_left" } ],
  "music_mood": "nhẹ nhàng"
}
```
- `shots` chạy theo `order` (1, 2, 3… không trùng). `shot_id`/`source_id` từ `sources/index.json`; `[in, out)` nằm trong
  cảnh đó (giây của video gốc), out > in. Một shot có thể dùng nhiều lần với đoạn khác nhau.
- `narration`: `tts` (Studio đọc `lines` bằng giọng của dự án), `original` (giữ tiếng nói gốc), `none`.
  Mỗi câu `L001`, `L002`… gắn vào shot nó bắt đầu (`line_id`); câu không gắn shot thì không được đọc. Studio kéo dài hình
  cho vừa lời ("hình theo lời"), nên đừng cố khớp giây.
- `transition`: `cut`, `dissolve` hoặc `dip_black` (tối dần rồi sáng lại) sang shot sau; `transition_s` (0.2–1, tuỳ chọn;
  mặc định dissolve 0.4, dip_black 0.6). `source_audio: "mute"` khi tiếng gốc làm phiền (thông báo, nhạc, người lạ nói);
  `source_muted: true` (cấp kế hoạch) tắt tiếng gốc của mọi clip.
- Âm lượng (tuỳ chọn): `gain_db` của shot (-30..20 dB) cho tiếng gốc to/nhỏ hơn (người nói nhỏ: +6; phố ồn: -8);
  `source_even: true` để máy render đo tiếng gốc từng clip và kéo về cùng một mức (bù tối đa ±12 dB, trước `gain_db`);
  `music_envelope`: đường âm lượng nhạc, mỗi điểm `{ "at_order", "offset_s", "gain_db" (-60..0) }` neo vào shot như chữ —
  nhạc đi theo đường thẳng nối các điểm (trước điểm đầu giữ mức điểm đầu, sau điểm cuối giữ mức điểm cuối). Ví dụ nhạc nhỏ
  khi có người nói ở shot 5 rồi lên lại ở shot 9:
  `[{"at_order":5,"offset_s":0,"gain_db":-18},{"at_order":5,"offset_s":0.5,"gain_db":-32},{"at_order":9,"offset_s":0,"gain_db":-32},{"at_order":9,"offset_s":1,"gain_db":-18}]`.
- `texts` (tối đa 200): `kind` title | callout | lower_third; tối đa 120 ký tự (dài quá chiều ngang thì tự xuống dòng);
  `at_order` là shot neo, `offset_s` tính từ đầu shot đó, `duration` 0.5–600 giây (chữ có thể nằm suốt một đoạn dài);
  `position` top_left | top_center | top_right | center | bottom_left | bottom_center | bottom_right; `size` s | m | l
  (tuỳ chọn, cỡ riêng của chữ đó so với cỡ của loại chữ). Hai chữ cùng vị trí, cùng lúc (song ngữ Anh–Nhật, tên địa danh
  và chú thích) **tự xếp chồng**, không đè nhau: chữ bắt đầu trước nằm sát mép, chữ sau đẩy lên (vị trí dưới) hoặc đẩy
  xuống (vị trí trên, giữa). Muốn hai dòng của một chữ thì viết `\n` trong `text`.
- `music_mood`: tâm trạng nhạc khi video và dự án chưa có nhạc riêng (xem `music_list`). Nhạc riêng: người dùng chọn ở
  tab Đầu vào, hoặc bạn đặt bằng `music_set` (file trong `context/audio/`, ghép nhiều bài) — `music_list` cho biết nhạc
  đang gán. `music` (tuỳ chọn): `{ "gain_db": -24, "ducking": false }` = nhạc đó phát ở mức này, có/không nhỏ lại khi có
  lời; `"music": null` = video không có nhạc.
- Cắt theo nhịp nhạc (tuỳ chọn): `snap: "bar"` (đầu ô nhịp) hoặc `"beat"` (phách) trên shot — Studio dời điểm cắt **cuối**
  shot đó về phách/đầu ô nhịp gần nhất của nhạc video đang phát khi dựng (không ngắn hơn 0,5 s, không vượt quá cảnh
  gốc, không làm lời dẫn đè nhau; chỗ không dời được thì giữ và báo trong kết quả dựng). Hợp với intro, montage, đoạn
  không lời; đoạn có lời dẫn dài thì để trống. `music_list` cho biết BPM và độ dài ô nhịp (ví dụ 120 BPM: ô nhịp 2 s,
  nên shot dài khoảng bội số của 2 s); nhạc chưa phân tích thì Studio tự phân tích lúc dựng. Đừng tự chỉnh `out` cho
  khớp giây của phách.
- `look` (tuỳ chọn): màu hình của video này thay cho `look` của branding — none | natural | vivid | warm | cinematic.
- `text_look` (tuỳ chọn): kiểu chữ riêng của video thay cho `text_look` của branding (cùng các khoá: màu, `size`,
  `shadow`, `font`).
- `target_seconds` theo brief (10–3600).

## `edit-plan.md` — cho người đọc
Frontmatter `status: draft`. Thân: cấu trúc từng phần, lời dẫn đầy đủ, lý do chọn cảnh, chữ trên hình, nhạc.

## Sau khi ghi
1. `validate_file` cho `videos/<id>/edit-plan.json` và `survey.json` (chưa có survey thì chạy skill scene-selection
   trước); sửa đến khi hết lỗi.
2. Khi người dùng đồng ý: `status: done` trong edit-plan.md, rồi `timeline_from_edit_plan` (thiếu hay sai một trong hai
   file thì tool báo ngay, không tạo việc). Lời dẫn tts cần giọng của
   dự án (xem `project_info`); chưa có thì nhờ người dùng chọn file giọng mẫu ở tab Đầu vào.
3. **Dựng lại từ kế hoạch thay toàn bộ timeline.** Mỗi lần sửa timeline bằng `timeline_apply_ops` mà muốn giữ khi dựng lại
   (chuyển cảnh, âm lượng clip, đường âm lượng nhạc, tắt tiếng, chữ, cỡ chữ, màu), ghi luôn thay đổi đó vào
   `edit-plan.json`. Riêng mức nhạc của `setMusic` Studio tự nhớ vào nhạc của video.
4. Đọc lại bằng `timeline_get` (mặc định là tổng quan; `view: "clips"` hoặc `"texts"` với `from_s`/`to_s` để đọc từng
   khúc), sửa nhỏ bằng `timeline_apply_ops`; rồi `render_preview`.
