/**
 * Trang Hướng dẫn (`/guide`, plan 2026-10-13 P5): viết cho người dùng cuối, theo `docs/runbooks/studio-project.md`. Gộp
 * vào `ws.guide`. Mỗi mục: `title` và `body` — đoạn cách nhau một dòng trống, dòng bắt đầu bằng "- " là gạch đầu dòng,
 * "1. " là danh sách đánh số, **đậm**. Tên kho footage là {{site}}, tên AI là {{ai}}.
 */
export const guideVi = {
  title: "Hướng dẫn",
  lead: "Làm video trên Studio: từ nhóm và dự án, thêm footage, tới bản cuối.",
  toc: "Trên trang này",
  replayTour: "Xem lại hướng dẫn nhanh",
  showChecklist: "Hiện lại danh sách Bắt đầu",
  sections: {
    teams: {
      title: "Nhóm và vai",
      body: `Mọi thứ trong Studio nằm trong một **nhóm**: dự án, thành viên, quy chuẩn và skill dùng chung. Chọn nhóm ở ô đầu tiên trên thanh trên cùng; ở đó cũng có **Tạo nhóm mới** và **Quản lý nhóm**.

Chưa ở nhóm nào thì tạo một nhóm (bạn là chủ sở hữu và mời người khác sau), hoặc nhờ chủ sở hữu một nhóm thêm bạn.

Vai trong nhóm, từ thấp tới cao:
- **Người xem**: xem dự án, các cuộc chat và bản render.
- **Biên tập viên**: chat với {{ai}}, thêm footage, tạo video, sửa file, chọn nhạc nền.
- **Nhà sản xuất**: thêm việc tạo dự án, chọn giọng đọc, xác nhận render bản cuối và xuất Premiere.
- **Chủ sở hữu**: thêm việc quản lý thành viên, quy chuẩn và skill của nhóm.`,
    },
    projects: {
      title: "Dự án và video là gì",
      body: `Một **dự án** là một kênh YouTube. Mỗi dự án có một thư mục làm việc riêng: tài liệu về kênh, nghiên cứu, chiến lược, branding và từng video. {{ai}} đọc và viết trong thư mục đó; bạn mở và sửa mọi file ở tab **Tệp**.

Tạo dự án: trang danh sách dự án của nhóm, bấm **Dự án mới**, nhập tên, link kênh (nếu có), ngôn ngữ và khung hình (16:9 hoặc 9:16). Cần vai nhà sản xuất.

Mỗi dự án có chat **Kênh** cho việc chung (nghiên cứu thị trường, chiến lược kênh, phong cách dựng, branding) và thêm chat tự do khi cần. Mỗi **video** là một chat riêng với {{ai}}, có các bước gợi ý từ ý tưởng tới bản cuối.

Mẹo: sửa file **CLAUDE.md** ở tab Tài liệu để nói về kênh, khán giả, giọng văn và những điều không được làm. Mọi chat của dự án đều đọc file này.`,
    },
    footage: {
      title: "Thêm footage từ {{site}}",
      body: `Footage của video chỉ đến từ {{site}}. Mở tab **Nguồn** ở cột phải của dự án:
- **Thêm project**: chọn một hay nhiều project {{site}}. {{ai}} tìm video trong đó khi làm từng video.
- Trong một video: chọn đúng các video {{site}} muốn dùng (dạng bảng hoặc lưới, lọc và tìm như trên {{site}}).

Chỉ thêm được project mà **bạn tải được bản gốc** trên {{site}} (project chỉ xem được bản watermark thì mở xem chi tiết được, không thêm được). Thêm xong, cả dự án dùng footage của project đó: {{ai}}, chuẩn bị và render, ai trong dự án cũng như nhau.

**Chuẩn bị đầu vào.** Trước khi chọn cảnh, mỗi video cần được chuẩn bị: cảnh đã cắt, khung hình, tờ ghép và lời thoại. {{site}} làm sẵn việc này khi footage được tải lên, nên Studio chỉ chép về, thường mất vài giây. Video nào {{site}} chưa chuẩn bị thì Studio nhờ {{site}} làm ngay và chờ; thẻ việc hiện trạng thái (đang chờ máy, đang cắt cảnh, đang đọc lời thoại), tiến độ và nút Dừng.

Dòng tóm tắt ở đầu tab cho biết bao nhiêu video sẵn sàng, đang chuẩn bị hay bị lỗi (bấm vào để lọc). Nút **Chuẩn bị các video chưa chuẩn bị** và **Thử lại các video lỗi** làm cả loạt một lần.

Tài liệu (PDF, markdown, CSV…), ảnh và audio: **Tải lên** ở mục Tài liệu, ảnh, audio. File Word thì lưu thành PDF trước. Video mẫu để {{ai}} học phong cách dựng cũng tải lên ở đây.`,
    },
    audio: {
      title: "Giọng đọc và nhạc nền",
      body: `Thẻ đầu tiên của tab **Nguồn**. Giọng và nhạc không bao giờ lấy từ {{site}}.

**Giọng đọc** (vai nhà sản xuất):
- **Tải giọng mẫu** (3–20 giây) hoặc **Chọn file đã tải**, rồi khai nguồn gốc giọng (giọng máy, giọng của tôi, có bản quyền). Chỉ dùng giọng bạn có quyền dùng.
- **Không lời dẫn**: lời thành phụ đề trên hình.

**Nhạc nền** (vai biên tập viên):
- **Tải nhạc** (tối đa 300 MB): dùng ngay.
- **Chọn file đã tải**: hộp chọn hai cột. Bên trái tìm, nghe thử và tích các bài; bên phải là thứ tự phát, kéo thả (bằng chuột hoặc bàn phím) để đổi. Tổng thời lượng đã trừ đoạn chuyển mờ giữa các bài.
- **Chọn từ kho nhạc**: nghe thử rồi chọn một bài trong kho nhạc chung.
- **Tự chọn theo mood**: bỏ nhạc riêng; khi dựng timeline, Studio lấy nhạc trong kho theo mood của kế hoạch dựng và branding.

Một video có thể có nhạc riêng, khác nhạc của dự án. Nút nào không dùng được thì mờ đi và nói lý do (thiếu vai, máy chưa sẵn sàng).`,
    },
    video: {
      title: "Làm một video từ brief tới bản cuối",
      body: `1. **Video mới** (cột trái): nói video kể gì, chọn có học từ chat cũ không (bài học chung của dự án hoặc vài chat cụ thể).
2. **Ý tưởng & brief**: {{ai}} viết video kể gì, cho ai, dài bao lâu, dùng footage nào, có lời dẫn không.
3. **Chuẩn bị đầu vào**: thêm video {{site}} và chuẩn bị (xem mục Thêm footage).
4. **Chọn cảnh**: {{ai}} xem khung hình, chấm điểm và chọn cảnh dùng được.
5. **Kế hoạch dựng**: thứ tự shot, đoạn lấy, lời dẫn, chữ trên hình.
6. **Timeline** và **Xem trước**: {{ai}} dựng timeline và render bản xem trước; xem ở tab **Xem trước**.
7. **Gói YouTube** và **Thumbnail**: tiêu đề, mô tả, thẻ, ảnh bìa.
8. **Bản cuối**: {{ai}} đề xuất thẻ "Render bản cuối"; người có vai nhà sản xuất bấm Xác nhận.

Thanh bước trên chat cho biết bước nào xong, bước nào nên làm tiếp. Bấm một bước để xem file của nó, nhờ {{ai}} làm hoặc làm lại. Thứ tự chỉ là gợi ý: muốn làm bước nào, quay lại bước nào cũng được.`,
    },
    chat: {
      title: "Sửa bằng chat",
      body: `Muốn đổi gì thì nói với {{ai}} trong chat của video, càng cụ thể càng tốt:
- "Bỏ cảnh 3, mở đầu bằng cảnh thuyền trên sông."
- "Chữ trên hình to hơn, màu trắng."
- "Mở đầu nhanh hơn, cả video còn khoảng 60 giây."
- "Đổi nhạc nền sang bài vui hơn."

{{ai}} sửa file rồi dựng lại. Dưới câu trả lời có thẻ **file đã đổi** (Mở, Xem thay đổi). Bạn cũng có thể tự sửa file ở tab Tài liệu rồi bảo {{ai}} dựng lại.

Gợi ý:
- Ở tab Tài liệu, nút **Đưa vào tin nhắn** gắn một file vào tin nhắn đang soạn.
- Việc nặng (render, chuẩn bị footage) chạy nền. Nút **Đang chạy** trên thanh trên cùng cho biết ai đang làm gì, bao lâu, và dừng được.
- Khi {{ai}} đề xuất một bài học, bấm **Lưu vào bài học dự án** để các video sau làm đúng ngay từ đầu.
- Việc có tác dụng thật (render bản cuối, xuất Premiere, xoá video) luôn chờ người có vai bấm xác nhận; {{ai}} không tự làm.`,
    },
    renders: {
      title: "Xem trước, bản cuối và Premiere",
      body: `- **Bản xem trước**: nhẹ, để duyệt nhanh. Xem ở tab **Xem trước** của video. Ai trong dự án cũng xem được.
- **Bản cuối**: chất lượng đầy đủ, render trên máy farm. {{ai}} đề xuất thẻ "Render bản cuối", người có vai nhà sản xuất bấm Xác nhận (hoặc tự bấm ở tab Xem trước). Ai trong dự án cũng xem và tải file mp4 được.
- **Xuất Premiere**: file zip để dựng tiếp trong Premiere, kèm footage và lời dẫn. Chỉ tải được khi quyền {{site}} của chính bạn phủ mọi footage trong bản đó.

Timeline đổi sau khi có thẻ đề xuất thì thẻ hết hiệu lực; nhờ {{ai}} đề xuất lại.`,
    },
    problems: {
      title: "Lỗi thường gặp",
      body: `- **Việc nền đứng ở "đang chờ máy"**: chưa có máy farm nào nhận loại việc này (máy tắt hoặc đang bận). Sau một lúc việc tự dừng và báo vào chat; thử lại sau hoặc báo quản trị.
- **Footage không chuẩn bị được**: bấm **Thử lại các video lỗi** ở tab Nguồn. Vẫn lỗi thì xem video đó còn trên {{site}} và còn thuộc một project {{site}} của dự án không.
- **Không thêm được project {{site}}**: thẻ project nói lý do (chỉ xem bản watermark, chưa có video đã phân tích). Cần quyền tải bản gốc của project đó trên {{site}}.
- **Tin nhắn báo hết hạn mức**: {{ai}} chờ hạn mức gói rồi tự chạy lại tới giờ hẹn. Muốn thôi thì bấm Dừng.
- **Thẻ xác nhận "hết hiệu lực"**: timeline đã đổi hoặc đã quá 24 giờ. Nhờ {{ai}} đề xuất lại.
- **File Premiere báo chưa có quyền xem footage**: quyền {{site}} của bạn không phủ footage trong file đó; chia sẻ dự án không mở rộng quyền footage. Bản xem trước và bản cuối vẫn xem được.
- **Nút bị mờ**: đưa chuột lên nút để xem lý do, thường là thiếu vai.`,
    },
  },
};
