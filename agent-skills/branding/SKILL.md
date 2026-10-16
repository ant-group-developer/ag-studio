---
name: branding
description: Viết branding của kênh channel/branding.md — giọng văn, công thức tiêu đề, mô tả, thumbnail, kiểu chữ trên video (text_look), mood nhạc. Dùng khi người dùng muốn làm hoặc sửa nhận diện, tiêu đề mẫu, kiểu chữ, màu sắc.
---

# Branding → `channel/branding.md`

Mọi bước sau (gói YouTube, thumbnail, chữ trên video, nhạc) **làm theo từng dòng** của file này, nên mỗi quy tắc phải cụ
thể và kiểm tra được. Căn cứ: `channel/strategy.md`, `research/report.md`, `channel/style.md` (nếu có), `CLAUDE.md`.

## Frontmatter — Studio đọc trực tiếp, sai là bị báo lỗi
```yaml
---
status: draft                  # done khi người dùng đồng ý
series_name: "Đi Bộ Chậm"
title_max_chars: 60            # 20–100; tiêu đề dài hơn bị cảnh báo
hashtags: ["#DiBoCham"]        # 1–5, chỉ chữ/số/_ sau dấu #
banned_words: ["sốc", "không thể tin nổi"]
music_mood: [calm, warm]       # 1–5 mood; Studio chọn nhạc trong kho theo mood
look: natural                  # màu hình của mọi video: none | natural | vivid | warm | cinematic (tuỳ chọn)
text_look:                     # chữ trên video vẽ đúng như vậy
  text_color: "#FFFFFF"
  outline_color: "#1A1A1A"     # viền chữ
  box_color: null              # hộp sau tiêu đề/địa danh; null = không hộp
  size: m                      # s | m | l
  shadow: true                 # bóng mờ dưới chữ và phụ đề (tuỳ chọn), dễ đọc trên nền sáng
  font: "Be Vietnam Pro"       # tuỳ chọn, một trong danh sách dưới; không ghi = Arial
thumbnail:
  max_words: 3                 # 1–8
  text_case: upper             # upper | sentence
  position: bottom             # top | center | bottom | left | right
---
```
Độ tương phản chữ/hộp (hoặc chữ/viền khi không có hộp) phải ≥ 3:1, nếu không Studio báo `text_look_no_contrast`.

Font chữ trên video (`text_look.font`) chỉ chọn trong danh sách máy render có sẵn — viết đúng tên:
- `Arial` (mặc định): trung tính, dễ đọc.
- `Be Vietnam Pro`: sans hiện đại, dấu tiếng Việt đẹp — hợp kênh tiếng Việt.
- `Noto Sans JP`, `Noto Sans KR`: sans cho kênh tiếng Nhật / Hàn.
- `Noto Serif`: có chân, trang trọng, đủ dấu tiếng Việt.
- `Playfair Display`: có chân, tương phản cao, hợp tiêu đề sang trọng (du lịch, ẩm thực cao cấp).
Chữ Nhật và chữ Hàn luôn được vẽ bằng Noto Sans JP / KR dù font của kênh là gì, nên chữ song ngữ không bị ô vuông.
Font khác (không có trong danh sách) không dùng được.

Màu hình (`look`) áp cho mọi clip khi render: `none` giữ nguyên như quay; `natural` tăng nhẹ tương phản và màu (an toàn cho
mọi kênh); `vivid` màu rực (ẩm thực, lễ hội); `warm` ấm, vàng nhẹ (du lịch chậm, hoàng hôn); `cinematic` tương phản mềm,
bóng xanh, sáng ấm (phim tài liệu, cảm xúc). Một video có thể đổi riêng bằng `look` trong kế hoạch dựng.

## Thân file
- **Giọng văn**: 2–6 tính từ; nên/không nên viết thế nào (xưng hô, độ dài câu); câu cửa miệng.
- **Tiêu đề**: 1–8 công thức có chỗ trống (lấy cảm hứng từ mẫu đang chạy tốt), quy tắc kiểm tra được, 3–5 ví dụ đúng công thức.
- **Mô tả**: kiểu 2 dòng mở đầu (hiện trước "Xem thêm"), lời kêu gọi cuối.
- **Thumbnail**: khung hình nên chọn, cảm xúc, bảng màu (chữ, viền, nhấn), điều nên/không nên.
- **Chữ trên video**: khi nào hiện (tên địa danh, tiêu đề phần…), tối đa bao nhiêu ký tự một dòng.

Sau khi ghi: kiểm file bằng tool `validate_file` (nếu có) rồi sửa đến khi hết lỗi; tóm tắt cho người dùng và đưa 3 tiêu đề
mẫu để họ cảm nhận.
