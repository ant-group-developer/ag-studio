---
name: edit-plan
description: Viết kế hoạch dựng của một video — thứ tự shot, đoạn lấy trong mỗi shot, lời dẫn, chữ trên hình, chuyển cảnh, tắt tiếng gốc — vào videos/<id>/edit-plan.md và edit-plan.json, rồi dựng timeline. Dùng sau khi đã chọn cảnh (survey.json).
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
      "transition": "cut", "section_title": "Mở đầu", "note": "thuyền vào hang", "source_audio": "keep" },
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
- `transition`: `cut` hoặc `dissolve` (sang shot sau). `source_audio: "mute"` khi tiếng gốc làm phiền (thông báo, nhạc,
  người lạ nói).
- `texts`: `kind` title | callout | lower_third; tối đa 64 ký tự; `at_order` là shot neo, `offset_s` tính từ đầu shot đó,
  `duration` 0.5–20 giây; `position` top_left | top_center | top_right | center | bottom_left | bottom_center | bottom_right.
- `music_mood`: tâm trạng nhạc khi dự án chưa có nhạc riêng (xem `music_list`).
- `target_seconds` theo brief (10–3600).

## `edit-plan.md` — cho người đọc
Frontmatter `status: draft`. Thân: cấu trúc từng phần, lời dẫn đầy đủ, lý do chọn cảnh, chữ trên hình, nhạc.

## Sau khi ghi
1. `validate_file` cho `videos/<id>/edit-plan.json`; sửa đến khi hết lỗi.
2. Khi người dùng đồng ý: `status: done` trong edit-plan.md, rồi `timeline_from_edit_plan`. Lời dẫn tts cần giọng của
   dự án (xem `project_info`); chưa có thì nhờ người dùng chọn file giọng mẫu ở tab Đầu vào.
3. Đọc lại bằng `timeline_get`, sửa nhỏ bằng `timeline_apply_ops`; rồi `render_preview`.
