# Runbook: chạy AG Studio trên một máy (máy dev Windows)

Studio không chạy một mình: nó cần **ag-go** (footage), **Account API** (quyền, tên người dùng), **ag-farm** (hàng
đợi render) cùng một **render worker**, và Auth0 + R2 dùng chung với môi trường dev. Trên máy dev hiện tại, tất cả
chạy local: dịch vụ trong Docker Desktop, hai worker chạy thẳng trên Windows từ `E:\ag-local`.

> Mọi giá trị bí mật nằm trong `E:\ag-local\secrets.json`, `E:\ag-local\secrets.env`,
> `E:\ag-local\setup\account_api_key.txt` và các file `.env` được sinh ra. **Không in, không dán vào chat, không
> commit.** Lệnh kiểm chỉ in tên khoá hoặc `ok`.

## 1. Thành phần và cổng

| Thành phần | Chạy ở đâu | Cổng / URL |
|---|---|---|
| Postgres 16, Redis, MariaDB, RabbitMQ | Docker (`postgres16`, `redis`, `mariadb_db`, `rabbitmq`) | 5432, 6379, 3306, 5672 |
| Account API + client | Docker (`ag-account-server-dev`, `ag-account-client-dev`) | 8080, 3000 |
| ag-go-api (api, worker-io, worker-media) | Docker, `E:\CODE\ag-go-v2\ag-go-api\docker-compose.yml` | `http://localhost:3737/api` |
| ag-go-web | `yarn dev` trong `E:\CODE\ag-go-v2\ag-go-web` | 5173 |
| ag-farm hub (api, web) | Docker, `E:\CODE\ag-farm\docker-compose.yml` | 3010 (api), 3011 (web) |
| **AG Studio** (api, worker, web) | Docker, `E:\CODE\ag-studio\docker-compose.yml` | `http://localhost:3100` |
| Render worker `local-render` | Windows, `E:\ag-local\ag-render-worker-0.1.0` | gọi hub `localhost:3010` |
| Scan worker `local-scan` | Windows, `E:\ag-local\ag-scan-worker-0.1.0` | gọi hub `localhost:3010` |
| Ollama (mô tả AI khi quét) | Windows | 11434 |

Từ trong container, các dịch vụ khác được gọi qua `host.docker.internal` (ví dụ Studio gọi ag-go ở
`http://host.docker.internal:3737/api`, farm ở `http://host.docker.internal:3010`).

## 2. Sinh cấu hình (một lần, hoặc khi đổi khoá)

Script nằm **ngoài repo**, ở `E:\ag-local\setup` (vì chứa đường dẫn và bí mật riêng của máy):

```bash
node E:/ag-local/setup/config-local.cjs farm
```
```bash
node E:/ag-local/setup/config-local.cjs go
```
```bash
node E:/ag-local/setup/config-local.cjs studio
```
```bash
node E:/ag-local/setup/workers-local.cjs
```

- `farm`: sinh cặp khoá vé và `E:\CODE\ag-farm\.env`.
- `go`: cập nhật `ag-go-api/.env` (owner key của farm cho ag-go, `CORS_EXTRA_ORIGINS=http://localhost:3100`).
- `studio`: chép `.env.example` thành `E:\CODE\ag-studio\.env` rồi điền Auth0 (tenant `auth0.ant-group.net`),
  Account API, ag-go, farm, R2 (dùng chung bucket với ag-go), Claude token. Giữ nguyên chế độ Claude đang đặt.
- `workers-local.cjs`: tạo hai node `local-scan`, `local-render` trên hub và viết `config.yaml` cho hai worker,
  `E:\ag-local\machine.yaml` (`cpu_slots: 2`, `gpu_slots: 1`).

**Chế độ Claude:**

```bash
node E:/ag-local/setup/config-local.cjs claude fake
```

`fake` dùng `fixtures/fake-studio-claude.mjs` (không tốn hạn mức); `real` gọi `claude` thật bằng
`CLAUDE_CODE_OAUTH_TOKEN`. Sau khi đổi, tạo lại container api và worker:

```bash
docker compose -f E:/CODE/ag-studio/docker-compose.yml up -d --force-recreate --no-deps api worker
```

Auth0: client SPA phải cho phép `http://localhost:3100` (callback, logout, web origin), và client id phải nằm
trong `AUTH0_ALLOWED_CLIENT_IDS` của cả Studio lẫn ag-go.

## 3. Bật hằng ngày

Theo thứ tự (dịch vụ nào cũng đợi dịch vụ trước healthy):

1. Docker Desktop: các container hạ tầng và Account API tự chạy lại (`restart: unless-stopped`).
2. ag-go: `docker compose up -d` trong `E:\CODE\ag-go-v2\ag-go-api`.
3. ag-farm: `docker compose up -d` trong `E:\CODE\ag-farm`.
4. Studio: build image rồi chạy (cần `../ag-farm` cạnh repo vì image build `@ag-farm/*` từ đó):

```bash
bash E:/CODE/ag-studio/deploy.sh
```

   `deploy.sh` build, chạy `api` tới khi healthy, rồi `worker`, rồi `web`.
5. Hai worker trên Windows: chạy `node dist/main.js --config config.yaml` trong từng thư mục worker ở
   `E:\ag-local`; log ở `E:\ag-local\render.log`, `E:\ag-local\scan.log`.

**Kiểm nhanh:**
- `http://localhost:3100/api/health` trả `ok`.
- `http://localhost:3011` (web farm): hai node `local-render`, `local-scan` đang Online.
- Mở `http://localhost:3100`, đăng nhập Auth0, tạo production: cây folder ag-go phải hiện các folder đã quét.

## 4. Chạy không qua Docker (khi sửa code)

Từ gốc repo, sau `corepack pnpm install && corepack pnpm build`:

```bash
corepack pnpm --filter @ag-studio/api start:dev
```
```bash
corepack pnpm --filter @ag-studio/web dev
```

Worker: `corepack pnpm --filter @ag-studio/worker build`, rồi `node apps/worker/dist/main.js` với cùng biến môi
trường. Khi chạy ngoài Docker, các URL `host.docker.internal` trong `.env` phải đổi thành `localhost`.

Lưu ý trên Windows:
- `CliAgentRuntime` spawn `claude` không qua shell, nên cần `claude.exe` trên PATH; bản cài bằng npm chỉ có
  `claude.cmd` và sẽ không chạy được (ghi ở `docs/operations/deferred-items.md`). Trong Docker không có vấn đề này.
- Thumbnail và kiểm loudness cần `ffmpeg` trên PATH (`STUDIO_FFMPEG_PATH` để chỉ đường dẫn khác).

## 5. Sự cố thường gặp

| Hiện tượng | Nguyên nhân hay gặp | Cách xử lý |
|---|---|---|
| API không khởi động, lỗi zod về biến môi trường | `.env` thiếu khoá (Auth0, Account, ag-go, farm, R2 đều bắt buộc) | Chạy lại `config-local.cjs studio` |
| Đăng nhập Auth0 báo callback không hợp lệ | Client SPA chưa cho phép `localhost:3100` | Thêm vào Auth0 (việc của người quản trị tenant) |
| Cây folder trống, hoặc lỗi CORS khi web gọi ag-go | `CORS_EXTRA_ORIGINS` của ag-go thiếu `http://localhost:3100` | `config-local.cjs go` rồi tạo lại container ag-go |
| Account API không với tới | Container account dừng | Người dùng vẫn vào được, nhưng không ai là admin và tên hiện thiếu |
| Stage `render-final` treo tới hết deadline | Farm hub hoặc `local-render` không chạy | Kiểm web farm 3011, chạy lại worker |
| Stage Claude đỗ chờ lâu với `RATE_LIMITED` | Hết hạn mức gói | Đợi; executor tự thử lại 5→60 phút, không tính là lỗi |
| Stage Claude lỗi ngay | `claude` không có (chạy ngoài Docker trên Windows) hoặc token hết hạn | Xem mục 4; đổi `CLAUDE_CODE_OAUTH_TOKEN` |
