---
name: video-brief
description: Viết brief của một video videos/<id>/brief.md — video kể gì, cho ai, dài bao lâu, footage nào, có lời dẫn không, cấu trúc. Dùng khi bắt đầu một video mới hoặc khi người dùng đổi ý tưởng video.
---

# Brief video → `videos/<id>/brief.md`

Video của luồng chat được ghi trong `<studio_context>` (id và thư mục). Căn cứ: lời người dùng, `CLAUDE.md`,
`channel/strategy.md`, `channel/branding.md`, `channel/style.md`, đầu vào đã gắn cho video/dự án (tool `inputs_list` nếu có).
Thiếu điều quan trọng (video về gì, dùng footage nào) thì hỏi lại — một câu mỗi lần, kèm `suggest_replies`.

## Frontmatter — Studio đọc trực tiếp
```yaml
---
status: draft            # done khi người dùng đồng ý brief
title: "Hội An lúc lên đèn"   # bắt buộc, ≤ 120 ký tự; Studio dùng làm tên video
target_seconds: 360      # độ dài mục tiêu
narration: none          # tts (đọc lời dẫn bằng giọng máy) | original (giữ tiếng gốc có lời nói) | none
edit_style: cut          # cut (cắt theo shot) | whole (ghép nguyên clip)
aspect: "16:9"           # nếu khác dự án
---
```

## Thân file
1. **Một câu**: video này cho người xem điều gì.
2. **Khán giả và cảm xúc** muốn để lại.
3. **Cấu trúc**: mở đầu (≤ 5 giây đầu giữ người xem thế nào) → các phần → kết.
4. **Footage**: nguồn nào (project ag-go, asset), cảnh bắt buộc có, cảnh tránh.
5. **Chữ, lời dẫn, nhạc**: theo branding/style; ghi điều riêng của video này.
6. **Tiêu đề tạm** (2–3 ý, theo công thức branding).

Khi người dùng đồng ý brief: đặt `status: done`, đổi tên video bằng tool `video_update` cho khớp `title`, rồi gợi ý bước
tiếp theo (chuẩn bị đầu vào).
