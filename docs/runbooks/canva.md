# Canva: mở thumbnail trong Canva và lấy bản đã sửa về

Mỗi người dùng Studio kết nối **tài khoản Canva của chính họ** (menu người dùng → "Kết nối Canva"). Trong tập phim,
"Mở trong Canva" tạo một thiết kế trong Canva của người đó:

- Ảnh có chữ (gợi ý, ảnh đã thêm chữ): Studio dựng PDF 1 trang — ảnh sạch làm nền, chữ là **chữ thật** (font đậm
  nhúng sẵn, đúng vị trí như ảnh JPEG) — rồi nhập vào Canva, nên chữ vẫn sửa được. Canva có thể đổi font khi nhập.
- Ảnh không chữ, hoặc khi Canva không nhập được PDF: ảnh phẳng trên một thiết kế cùng kích thước.

Sửa xong trong Canva, quay lại tab Studio và bấm "Lấy bản từ Canva": Studio xuất thiết kế ra JPEG đúng kích thước
thumbnail và thêm thành một ảnh mới ở tab "Của tôi". Canva không tự đưa người dùng về Studio (return navigation
chưa làm).

Footage: ảnh thumbnail có hình footage, nên chỉ người có quyền xem footage của production mới mở được trong Canva
(như tải video).

## Cài đặt (một lần)

Công ty không có Canva Enterprise, nên dùng **integration public** của Canva Connect.

1. Đăng nhập [Canva Developer Portal](https://www.canva.com/developers/integrations/connect-api) bằng tài khoản
   Canva của công ty; bật **MFA** cho tài khoản đó (Canva bắt buộc).
2. Tạo integration mới, loại **Public**.
3. **Scopes** — chọn đúng 5 quyền:
   - `asset:write` — tải ảnh thumbnail lên Canva của người dùng
   - `design:content:write` — tạo thiết kế / nhập PDF thành thiết kế
   - `design:content:read` — xuất thiết kế ra JPEG để lấy về Studio
   - `design:meta:read` — lấy lại link sửa của thiết kế đã mở trước đó
   - `profile:read` — hiện tên tài khoản Canva đã kết nối trong menu
4. **Authorized redirects** — thêm cả dev và prod:
   - `https://<domain-dev-của-studio>/api/canva/oauth/callback`
   - `https://<domain-prod-của-studio>/api/canva/oauth/callback`
   - (máy dev: `http://127.0.0.1:3100/api/canva/oauth/callback` nếu cần thử cục bộ)
5. Lấy **Client ID** và tạo **Client secret**.
6. Trong `.env` của từng môi trường:

   ```
   CANVA_CLIENT_ID=...
   CANVA_CLIENT_SECRET=...
   CANVA_REDIRECT_URI=https://<domain-studio>/api/canva/oauth/callback
   CANVA_TOKEN_KEY=<64 ký tự hex ngẫu nhiên>
   STUDIO_WEB_URL=https://<domain-studio>
   ```

   Tạo `CANVA_TOKEN_KEY` bằng `openssl rand -hex 32`. Khoá này mã hoá token Canva trong `studio.db`: đổi khoá thì mọi
   người phải kết nối lại Canva. Thiếu một trong bốn biến `CANVA_*` thì web ẩn mọi nút Canva.
7. Deploy lại api (`bash deploy.sh`). Image đã có ffmpeg và font Liberation Sans (chữ thumbnail).

## Cho cả nhóm dùng

Integration public **chưa được duyệt** chỉ dùng được trong phạm vi hẹp (người tạo và team Canva của họ — kiểm lại
trong Developer Portal). Để mọi người dùng được: trong Developer Portal bấm **Submit for review** (làm theo
submission checklist của Canva). Mô tả gợi ý:

> AG Studio is our internal video production tool. Editors open an episode's YouTube thumbnail in Canva to refine
> its text and design, then bring the edited image back into AG Studio. We upload the thumbnail (asset:write),
> import it as a design with editable text or create a design with it (design:content:write), export the edited
> design as JPEG (design:content:read), read the design's edit link to reopen it (design:meta:read), and show the
> connected account's name (profile:read). Tokens are stored encrypted (AES-256-GCM) and never sent to browsers.

Canva chỉ duyệt integration dùng API đã GA — Studio chỉ dùng các API GA (OAuth, asset uploads, design imports,
designs, exports, user profile).

## Sự cố

| Hiện tượng | Nguyên nhân / cách xử lý |
|---|---|
| Không thấy nút Canva | Thiếu biến `CANVA_*` trên api, hoặc `CANVA_TOKEN_KEY` sai định dạng (api không khởi động được) |
| Quay về Studio với "Kết nối Canva lỗi: state_invalid" | Quá 10 phút từ lúc bấm kết nối, hoặc bấm lại link cũ: kết nối lại |
| "Kết nối Canva đã hết hạn, hãy kết nối lại Canva" | Canva từ chối refresh token (người dùng gỡ quyền, hoặc token đã dùng): kết nối lại |
| "Canva đang giới hạn số lần gọi" | Giới hạn 20–30 lần/phút mỗi người dùng của Canva: chờ một phút |
| Chữ trong Canva khác font | Canva thay font khi nhập PDF; chữ vẫn sửa được |
