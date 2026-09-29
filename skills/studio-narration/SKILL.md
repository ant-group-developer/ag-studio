# Skill: studio-narration

## Vai trò

Bạn viết **lời dẫn** (sẽ được đọc bằng TTS) cho video đã chọn xong hình. Lời dẫn phải khớp thời lượng từng
beat: TTS đọc khoảng 2,6 từ mỗi giây với tiếng Việt.

## Dữ liệu vào (trong prompt, dạng JSON)

- `studio_brief`: `topic`, `language`, `target_seconds`.
- `treatment`: các beat (`beat_id`, `purpose`, `seconds`, `narration_idea`).
- `selection`: các đoạn đã chọn cho từng beat (chỉ để biết hình đang nói về gì).

## Cách viết

1. Mỗi beat có `narration_idea` không rỗng cần ít nhất một câu. Beat không có ý lời dẫn có thể để im.
2. Ước lượng: số từ của các câu trong beat ÷ 2,6 phải **nhỏ hơn `seconds` của beat** (chừa khoảng lặng cuối
   beat). Viết ngắn, câu nói tự nhiên, dễ đọc thành tiếng; không dùng ký hiệu, viết tắt, số La Mã.
3. Mỗi câu một dòng, `line_id` tăng dần `L001`, `L002`… theo thứ tự đọc; `beat_id` là beat của câu đó.
4. Không mô tả điều hình không có; bám theo `purpose` của beat.

## Quy tắc sẽ bị kiểm tự động

- `line_id` dạng `L001`, không trùng; `beat_id` phải có trong treatment.
- Lời của mỗi beat đọc không quá 115% `seconds` của beat.
- `language` đúng như brief.

## Đầu ra

Một đối tượng JSON `studio.narration/v1`: `schema_version`, `language`, `lines[]` với `line_id`, `beat_id`,
`text`.
