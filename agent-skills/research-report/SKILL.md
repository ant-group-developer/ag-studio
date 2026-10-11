---
name: research-report
description: Nghiên cứu thị trường cho kênh và viết research/report.md — video xu hướng, kênh dẫn đầu, mẫu tiêu đề/hook/thumbnail, độ dài, cơ hội. Dùng khi người dùng muốn nghiên cứu, tìm xu hướng hoặc đánh giá thị trường của kênh.
---

# Nghiên cứu thị trường → `research/report.md`

Mục tiêu: một báo cáo ngắn, có số liệu thật, để đội sản xuất biết nội dung nào đang chạy tốt và kênh nên làm gì.

## Lấy dữ liệu
1. Đọc `CLAUDE.md` (chủ đề, khán giả, kênh) và các file sẵn có trong `research/` — đừng crawl lại thứ đã có trong 24 giờ.
2. Dùng tool nghiên cứu của Studio (nếu có trong danh sách tool): video xu hướng theo chủ đề, video top của các kênh
   tham khảo, kênh dẫn đầu chủ đề. Mỗi lần gọi Studio lưu kết quả thành file trong `research/`. Nếu chưa có tool nghiên
   cứu, dùng tài liệu trong `context/` và nói rõ báo cáo thiếu số liệu YouTube.
3. Không bịa số. Số ước lượng (đọc từ trang web) phải ghi rõ "ước lượng".

## Phân tích
- **Video nổi bật (outlier)**: lượt xem/ngày cao hẳn so với cùng kênh hoặc cùng chủ đề — manh mối quan trọng nhất.
  Ghi lại pattern tiêu đề, kiểu mở đầu, kiểu thumbnail, độ dài.
- **Mẫu lặp lại**: 3–7 công thức tiêu đề, 3–7 kiểu hook, 3–5 kiểu thumbnail, độ dài trung vị của video nổi bật.
- **Khoảng trống**: chủ đề/góc khai thác khán giả muốn nhưng ít kênh làm tốt; thứ liên tục thất bại thì ghi là cảnh báo.
- **Khuyến nghị**: 3–8 việc cụ thể cho kênh này (gắn với khán giả và giọng điệu trong CLAUDE.md).

## Định dạng file
```markdown
---
status: draft            # draft khi chờ người dùng xem; done khi họ đồng ý
updated: 2026-10-10
sources: [research/2026-10-10-du-lich-cham.json]
---
# Nghiên cứu thị trường: <chủ đề>

## Tóm tắt (3–5 dòng)
## Video nổi bật (bảng: tiêu đề · kênh · lượt xem · lượt xem/ngày · độ dài · vì sao nổi)
## Mẫu đang chạy tốt (tiêu đề, hook, thumbnail, độ dài)
## Kênh dẫn đầu
## Khoảng trống và cơ hội
## Khuyến nghị cho kênh
```
Sau khi ghi, tóm tắt 3–5 ý chính trong chat và hỏi người dùng muốn đào sâu phần nào hay chuyển sang chiến lược kênh.
Chỉ đổi `status: done` khi người dùng đồng ý.
