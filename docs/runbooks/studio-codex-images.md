# Ảnh AI bằng ChatGPT (Codex): thumbnail AI và ảnh kênh

Plan 2026-11-03 codex-imagegen. Agent làm thumbnail AI (`thumbnail_make` có `prompt`) và ảnh kênh (`channel_art_make`:
logo, banner, avatar) qua job `image`. Worker gọi Codex CLI, tool `$imagegen` (gpt-image-2), trên hạn mức của **một
tài khoản ChatGPT** (Plus, Pro, Business). Không dùng API key, không tính tiền theo ảnh.

- Mỗi ảnh mất 1–4 phút. Mỗi ảnh ăn hạn mức Codex của tài khoản nhiều gấp 3–5 lần một lượt chat chữ. Hết hạn mức thì job
  báo "tài khoản ChatGPT đã hết hạn mức tạo ảnh, thử lại sau".
- Worker chỉ chạy **một ảnh một lúc** (Codex làm mới token trong `auth.json` mỗi lần chạy). Chỉ **một** worker đặt
  `STUDIO_CODEX_HOME`.
- `STUDIO_CODEX_HOME/auth.json` là thông tin đăng nhập: không commit, không chép đi nơi khác, không gửi qua chat. Bản sao
  lưu volume `/data` cũng chứa file này.
- Nên dùng một tài khoản ChatGPT riêng cho Studio, không dùng tài khoản cá nhân đang code bằng Codex: hai nơi dùng chung
  hạn mức, và đăng xuất ở một nơi có thể làm nơi kia mất đăng nhập.

## 1. Trước khi đăng nhập (một lần, trên trình duyệt)

Bật đăng nhập bằng mã thiết bị cho Codex:

- Tài khoản cá nhân: ChatGPT → Settings → Security, bật device code login cho Codex.
- Workspace Business/Enterprise: admin bật ở quyền của workspace.

Không bật được thì làm theo mục 4: đăng nhập trên máy có trình duyệt rồi chép `auth.json` lên.

## 2. VPS (Docker)

Image đã cài Codex (`CODEX_VERSION` trong `Dockerfile`) và đặt sẵn `STUDIO_CODEX_HOME=/data/harness/codex`, nằm trong
volume nên deploy lại không mất đăng nhập. Sau khi deploy bản có job `image` (migration `0011`):

```bash
cd /www/code/ag-harness-agent/ag-studio
docker compose exec -e CODEX_HOME=/data/harness/codex worker codex login --device-auth
```

Mở link Codex in ra, đăng nhập đúng tài khoản ChatGPT của Studio, nhập mã. Kiểm lại:

```bash
docker compose exec -e CODEX_HOME=/data/harness/codex worker codex login status
```

Phải ra `Logged in using ChatGPT`. Không cần restart worker: Codex kiểm đăng nhập trước mỗi ảnh. Log lúc worker khởi
động có `codex_login` (`chatgpt` | `api_key` | `none`).

Thử: trong luồng của một video đã có bản render, nhờ agent "làm 1 thumbnail AI, ánh hoàng hôn". Job "Thumbnail AI: …"
hiện trong hoạt động của dự án; xong thì ảnh nằm ở `videos/<id>/thumbnails/` và README ghi prompt đã dùng.

Đổi tài khoản:

```bash
docker compose exec -e CODEX_HOME=/data/harness/codex worker codex logout
```

Rồi đăng nhập lại như trên.

## 3. Máy dev (chế độ trực tiếp, `scripts/local-stack.mjs`)

Trong `.env` của Studio đặt `STUDIO_CODEX_HOME` là một thư mục **riêng**, không phải `~/.codex` của người dùng, rồi
đăng nhập vào đó (PowerShell):

```powershell
$env:CODEX_HOME = 'E:\ag-local\studio-data\codex'; codex login --device-auth
```

Test Codex thật (tốn một ảnh hạn mức):

```powershell
$env:HARNESS_REAL_CODEX_TEST = '1'; $env:STUDIO_CODEX_HOME = 'E:\ag-local\studio-data\codex'; corepack pnpm vitest run packages/studio-engine/test/codex-image.test.ts -t "real Codex"
```

## 4. Không có device code: chép `auth.json`

Trên máy có trình duyệt, đăng nhập vào một thư mục tạm rồi chép file đó lên VPS (thay `<vps>`):

```powershell
$env:CODEX_HOME = "$env:TEMP\studio-codex"; codex login
```

```bash
scp "$TEMP/studio-codex/auth.json" <vps>:/tmp/studio-codex-auth.json
```

Trên VPS:

```bash
cd /www/code/ag-harness-agent/ag-studio
docker compose cp /tmp/studio-codex-auth.json worker:/data/harness/codex/auth.json
rm /tmp/studio-codex-auth.json
```

Xoá thư mục tạm trên máy có trình duyệt, và **không** dùng tiếp login đó ở máy kia: Codex làm mới token, hai nơi cùng
dùng một login thì một nơi sẽ bị đăng xuất.

## 5. Lỗi thường gặp (lời job báo)

| Job báo | Làm gì |
|---|---|
| chưa đăng nhập tài khoản ChatGPT | Mục 2 (hoặc mục 4). Token hết hạn cũng báo câu này: đăng nhập lại |
| đang đăng nhập bằng API key | `codex logout` rồi đăng nhập bằng ChatGPT; Studio không tạo ảnh tính tiền API |
| hết hạn mức tạo ảnh | Chờ hạn mức của gói hồi lại, hoặc đổi sang tài khoản gói cao hơn |
| bị từ chối vì chính sách nội dung | Sửa prompt (bớt người thật, thương hiệu, nội dung nhạy cảm) |
| không nối được ChatGPT | Container ra được `https://chatgpt.com` không; image phải có `ca-certificates` |
| Codex trả lời nhưng không tạo ảnh | Thử lại; lặp lại thì xem `CODEX_VERSION` có đổi không (Studio dựa vào `--json` và `generated_images/`) |
| worker này không có Codex của Studio | Worker đó không đặt `STUDIO_CODEX_HOME`; job `image` chỉ chạy ở worker có |

## 6. Nâng phiên bản Codex

Đổi `ARG CODEX_VERSION` trong `Dockerfile`. Trước khi deploy, chạy test Codex thật (mục 3) với cùng phiên bản trên máy
dev: Studio dựa vào `thread.started.thread_id` trong `--json` và ảnh nằm ở `$CODEX_HOME/generated_images/<thread>/`.

Trong Docker, sandbox của Codex (`bwrap`) không tạo được namespace, nên tool không đọc được file qua
`referenced_image_paths` (model vẫn trả "DONE", không có ảnh). Vì thế Studio gắn ảnh tham chiếu bằng `-i` và bảo tool
dùng `num_last_images_to_include`, sandbox vẫn read-only. Đừng đổi lại sang đường dẫn file, và đừng tắt sandbox.
