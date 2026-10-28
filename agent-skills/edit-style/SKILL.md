---
name: edit-style
description: Viết phong cách dựng của kênh channel/style.md — nhịp cắt, độ dài shot, mở đầu, chuyển cảnh, chữ, màu — từ video mẫu (người dùng tải lên hoặc tải từ YouTube khi được) hay từ lời người dùng tả. Dùng khi người dùng muốn học phong cách của một kênh/video tham khảo hoặc sửa phong cách dựng.
---

# Phong cách dựng → `channel/style.md`

Chọn cảnh, kế hoạch dựng và timeline đọc file này, nên mỗi quy tắc phải cụ thể và kiểm được (con số, không tính từ chung
chung). Căn cứ: `channel/strategy.md`, `CLAUDE.md`, và **một** trong ba nguồn dưới đây.

## Lấy số đo từ đâu
1. **Video mẫu người dùng tải lên** (tab Nguồn, mục Video tham khảo → `context/references/`; xem bằng `inputs_list`): gọi
   `style_from_files {paths, purpose}` — chạy nền, không cần thẻ xác nhận, không đổi hay xoá file của họ.
2. **Video YouTube**: `propose_action` kind `reference_download {video_ids (≤5), purpose}`; người dùng bấm xác nhận thì
   Studio tải ≤480p, đo rồi xoá. Nếu `<studio_context>` báo **YouTube đang chặn tải từ máy chủ Studio**, đừng đề xuất
   (thẻ chắc chắn hỏng, tool sẽ từ chối): nói rõ với người dùng và mời họ tải video mẫu lên (cách 1) hoặc tả bằng lời
   (cách 3). Studio không dùng cookie hay đăng nhập để lách.
3. **Lời người dùng tả** (không có video mẫu): hỏi từng câu ngắn, có gợi ý bấm (`suggest_replies`): nhịp nhanh/chậm,
   shot dài khoảng bao nhiêu giây, mở đầu thế nào, chữ trên hình, chuyển cảnh, màu. Ghi rõ là ước lượng theo lời tả.

Cách 1–2 xong thì Studio báo vào luồng; đọc `research/style-<ngày>-<n>/README.md` (bảng số đo: cắt/phút, shot trung vị,
shot mở đầu) và mở các tờ ghép `*-sheet-*.jpg` bằng Read. Dòng có `lỗi` nói vì sao video đó không đo được (mã như
`youtube_blocked`, `private`, `too_long`) — nói lại cho người dùng bằng lời thường.

## Nội dung `channel/style.md`
- **Nhịp**: số lần cắt/phút, shot dài trung vị và khoảng 25–75% (giây); khác nhau giữa đoạn mở, thân, kết nếu thấy.
- **Mở đầu**: shot đầu dài bao lâu, 15 giây đầu làm gì (cảnh đẹp nhất, câu hỏi, chữ tiêu đề…).
- **Chuyển cảnh**: cắt thẳng hay mờ chéo, khi nào dùng.
- **Chữ trên hình**: có/không, vị trí, khi nào hiện (địa danh, chương…) — kiểu chữ cụ thể thuộc `channel/branding.md`.
- **Màu và ánh sáng**: tông chung thấy trên tờ ghép.
- **Nên / không nên**: 3–6 gạch đầu dòng ngắn.
- **Nguồn**: video mẫu nào (đường dẫn file hoặc link YouTube), hay lời tả của ai, ngày nào.

Nếu viết thêm `channel/style.json`, gọi `validate_file` ngay sau khi ghi và sửa đến khi hết lỗi.
