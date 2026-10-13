---
name: youtube-kit
description: Viết gói YouTube của một video videos/<id>/youtube-kit.md — 3 tiêu đề, mô tả, tags, hashtag, 3 ý tưởng thumbnail, playlist. Dùng khi video đã có timeline hoặc người dùng muốn tiêu đề, mô tả, thumbnail để đăng.
---

# Gói YouTube → `videos/<id>/youtube-kit.md`

Căn cứ: `videos/<id>/brief.md`, kế hoạch dựng/timeline của video (cảnh thật có trong video), `channel/branding.md` (công
thức tiêu đề, từ cấm, hashtag của kênh, quy tắc thumbnail), `research/report.md` (mẫu tiêu đề đang chạy tốt).
**Chỉ hứa điều video thật sự có**: tiêu đề và thumbnail không được nói cảnh mà timeline không có.
Kênh chưa có `channel/branding.md` (hoặc còn nháp, có lỗi): vẫn viết được — theo `CLAUDE.md` và `research/report.md`; nói
rõ trong chat là kênh chưa có branding nên tiêu đề/thumbnail chưa theo công thức của kênh, và gợi ý làm Branding ở luồng
Kênh. Đừng tự viết branding trong luồng video.

## Frontmatter — Studio đọc trực tiếp
```yaml
---
status: draft
titles:                        # đúng 3 tiêu đề khác nhau, ≤ 100 ký tự (theo title_max_chars của branding)
  - "Hội An lúc lên đèn — 6 phút đi bộ không lời"
  - "..."
  - "..."
tags: [hoi an, pho co, di bo]  # tổng ≤ 500 ký tự
hashtags: ["#HoiAn", "#DiBoCham"]   # gồm hashtag của kênh trong branding
thumbnails:                    # 3 ý tưởng: chữ trên ảnh (theo max_words, text_case của branding) và khoảnh khắc nên lấy
  - { text: "LÊN ĐÈN", at_seconds: 95 }
  - { text: "..." }
  - { text: "..." }
playlist: "Đi bộ chậm"
---
```
## Thân file = mô tả video
- 2 dòng đầu (hiện trước "Xem thêm") theo kiểu mở đầu của branding, chứa từ khoá chính.
- Nội dung video, địa điểm, lời kêu gọi cuối. Studio tự thêm chương (chapters) khi xuất bản từ timeline cuối.

Sau khi ghi: kiểm bằng `validate_file` (nếu có), sửa hết lỗi; đưa người dùng chọn tiêu đề ưng ý nhất.
