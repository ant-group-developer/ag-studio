# Runbook: chạy AG Studio trên một máy (máy dev Windows)

Studio không chạy một mình: nó cần **ag-go** (footage), **Account API** (quyền, tên người dùng), **ag-farm** (hàng
đợi render) cùng **render worker**, và Auth0 + R2 dùng chung với môi trường dev. Trên máy dev, hạ tầng (Postgres,
Redis, MariaDB, RabbitMQ, Account API) chạy trong Docker Desktop; **mọi thứ còn lại chạy trực tiếp trên Windows**.

> Mọi giá trị bí mật nằm trong các file `.env` và `E:\ag-local\secrets.*`. **Không in, không dán vào chat, không
> commit.** Lệnh kiểm chỉ in tên khoá hoặc `ok`.

## 1. Thành phần và cổng

| Thành phần | Chạy ở đâu | Địa chỉ | `.env` dùng |
|---|---|---|---|
| Postgres 16, Redis, MariaDB, RabbitMQ | Docker (`postgres16`, `redis`, `mariadb_db`, `rabbitmq`) | 5432, 6379, 3306, 5672 | |
| Account API + client | Docker (`ag-account-server-dev`, `ag-account-client-dev`) | 8080, 3000 | |
| ag-go-api | `E:\CODE\ag-go-v2\ag-go-api` | `http://localhost:3738/api` | `ag-go-api/.env` |
| ag-go worker (quét, outbox) | cùng thư mục, `yarn worker` | | `ag-go-api/.env` |
| ag-go-web (tuỳ chọn) | `E:\CODE\ag-go-v2\ag-go-web` | `http://localhost:5173` | `ag-go-web/.env` |
| ag-farm hub | `E:\CODE\ag-farm\apps\api` | `http://localhost:3010` | `apps/api/.env` |
| ag-farm web (tuỳ chọn) | `E:\CODE\ag-farm\apps\web` | `http://localhost:3011` | `apps/web/.env` |
| **Studio API** | `E:\CODE\ag-studio\apps\api`, `PORT=3101` | `http://localhost:3101/api` | `apps/api/.env` |
| **Studio worker** | `E:\CODE\ag-studio`, `node --env-file=apps/api/.env` | | `apps/api/.env` |
| **Studio web** | `E:\CODE\ag-studio\apps\web`, vite cổng 3100 | **`http://localhost:3100`** | `apps/web/.env` |
| Render worker `local-render` | `E:\CODE\ag-render-worker` | gọi hub 3010 | `E:\ag-local\dev-run\render.yaml` |
| Scan worker `local-scan` | `E:\CODE\ag-scan-worker` | gọi hub 3010 | `E:\ag-local\dev-run\scan.yaml` |
| Ollama (mô tả AI khi quét) | Windows | 11434 | |

Studio web chạy ở **3100** vì đó là origin Auth0 cho phép và nằm trong `CORS_EXTRA_ORIGINS` của ag-go; API của
Studio dời sang **3101** (`apps/web/.env` → `VITE_STUDIO_API_URL`).

## 2. Bật và tắt

**Một lệnh** (từ `E:\CODE\ag-studio`, cần `node` ≥ 22.13):

```bash
node scripts/local-stack.mjs up
```

- Bật theo thứ tự ag-go-api → farm hub → Studio API → Studio worker → render worker → scan worker → Studio web, đợi
  từng dịch vụ có cổng trả 200 rồi mới sang dịch vụ sau. Dịch vụ đang chạy sẵn thì bỏ qua.
- `up all` bật thêm ag-go worker, farm web, ag-go web; `up studio-web go-web` chỉ bật đúng các dịch vụ nêu tên.
- Log từng dịch vụ: `E:\ag-local\dev-run\<tên>.log`; pid lưu ở `E:\ag-local\dev-run\local-stack.json`.

```bash
node scripts/local-stack.mjs status
```

```bash
node scripts/local-stack.mjs down
```

`down` chỉ tắt tiến trình do script bật, không đụng tiến trình bạn tự bật ở terminal khác và không đụng Docker.
Đường dẫn các repo mặc định nằm cạnh `ag-studio`; đổi bằng `AG_GO_DIR`, `AG_FARM_DIR`, `AG_RENDER_WORKER_DIR`,
`AG_SCAN_WORKER_DIR`, `AG_LOCAL_DIR`.

**Tự chạy từng dịch vụ** (mỗi lệnh một tab terminal, đúng thứ tự trên):

```bash
cd E:/CODE/ag-go-v2/ag-go-api; yarn start:dev
```
```bash
cd E:/CODE/ag-farm/apps/api; node dist/main.js
```
```bash
cd E:/CODE/ag-studio/apps/api; node -e "process.env.PORT='3101'; require('./dist/main.js')"
```
```bash
cd E:/CODE/ag-studio; node --env-file=apps/api/.env apps/worker/dist/main.js
```
```bash
cd E:/CODE/ag-render-worker; node dist/main.js --config E:/ag-local/dev-run/render.yaml
```
```bash
cd E:/CODE/ag-scan-worker; node dist/main.js --config E:/ag-local/dev-run/scan.yaml
```
```bash
cd E:/CODE/ag-studio/apps/web; corepack pnpm exec vite --port 3100 --strictPort
```

**Kiểm nhanh:** `http://localhost:3738/api/health`, `http://localhost:3010/health`, `http://localhost:3101/api/health`
trả `ok`; web farm (3011) thấy `local-render`, `local-scan` Online; mở `http://localhost:3100` (giao diện chat), đăng
nhập Auth0, gõ một câu và `@` trong ô chat: danh sách folder ag-go phải hiện các folder đã quét. Màn cũ ở
`http://localhost:3100/productions`.

## 3. Build lại khi code đổi

Studio API, worker, farm hub và hai render/scan worker chạy từ `dist/`; ag-go-api chạy chế độ watch nên tự build.

```bash
cd E:/CODE/ag-studio; corepack pnpm -r run build
```
```bash
cd E:/CODE/ag-farm; yarn build
```
```bash
cd E:/CODE/ag-render-worker; yarn build
```

Không dùng `corepack pnpm build` ở gốc ag-studio: script đó gọi `pnpm` trần, không có trên PATH của máy này.

Migration: Studio API tự migrate `studio.db` khi khởi động. ag-go: `yarn migration:run` trong `ag-go-api`. ag-farm:
script `migration:run` trỏ sai chỗ typeorm, chạy tay trong `ag-farm/apps/api`:

```bash
node --require ts-node/register ../../node_modules/typeorm/cli.js migration:run -d src/database/data-source.ts
```

## 4. Cấu hình

- Các file `.env` cho chạy trực tiếp đã có sẵn trên máy dev (bảng mục 1); chúng trỏ `localhost`, khác bộ `.env` cho
  Docker (`E:\CODE\ag-studio\.env`, `E:\CODE\ag-farm\.env`, trỏ `host.docker.internal`) do
  `E:\ag-local\setup\config-local.cjs` sinh. Dữ liệu Studio: `E:\ag-local\studio-data` (`studio.db`, `harness/`).
- **Claude giả hay thật:** `STUDIO_CLAUDE_ARGV` trong `apps/api/.env` trỏ `fixtures/fake-studio-claude.mjs` (không tốn
  hạn mức). Bỏ dòng đó để dùng `claude` thật bằng `CLAUDE_CODE_OAUTH_TOKEN` (hoặc đăng nhập `claude` → `/login`).
  Trên Windows, `claude.cmd` của npm được tự dò ra `claude.exe` (`resolveCommand`).
- **Số lượt Claude cùng lúc:** admin Studio chỉnh trên web (màn Hàng đợi, cột phải; lưu vào
  `studio_settings`, worker áp dụng ngay). Chưa ai lưu thì dùng `STUDIO_CLAUDE_MAX_CONCURRENT` (1–100, mặc định 20).
  Worker chạy số vòng bằng `claude + 8 (farm) + 2 (cpu)` và tự thêm/bớt khi số này đổi; tin nhắn chat dùng chung số
  lượt đó và được xếp trước các bước tự chạy. Nhiều lượt hơn thì hạn mức gói hết nhanh hơn, mỗi lượt một tiến trình
  `claude`.
- **Kiểu máy render bản cuối:** chọn trên thẻ duyệt YouTube kit hoặc ⋯ → Render bản cuối…: bất kỳ máy nào, máy có
  NVENC, máy có GPU (requirements của ag-farm). Xem máy `local-render` khai gì (số GPU, `nvenc`) ở web farm 3011 trước khi
  chọn: không máy nào khớp thì job nằm chờ mãi. `nvenc` của node chỉ nói ffmpeg của nó có encoder NVENC; máy dev
  (driver < 610) vẫn có thể nhận job "máy có NVENC" rồi render bằng CPU.
- **Màn Hàng đợi** (`http://localhost:3100/queue`, hoặc bấm chip "Claude"/"Render" ở header): lượt Claude, job farm
  chưa xong kèm kiểu máy, việc chờ duyệt; admin chỉnh số lượt Claude ở cột phải. Không có danh sách máy (owner API của
  farm không trả node).
- Auth0: client SPA phải cho phép `http://localhost:3100` (callback, logout, web origin); client id nằm trong
  `AUTH0_ALLOWED_CLIENT_IDS` của Studio, ag-go và farm.
- Thumbnail và kiểm loudness dùng ffmpeg ở `STUDIO_FFMPEG_PATH` (máy dev trỏ tới `ffmpeg-static` của
  ag-render-worker vì ffmpeg không có trên PATH).

## 5. Chạy bằng Docker (cách cũ)

`E:\CODE\ag-studio\docker-compose.yml` + `deploy.sh` (api → worker → web, cổng 3100, cần `../ag-farm` cạnh repo),
ag-go và ag-farm có `docker-compose.yml` riêng; cấu hình sinh bằng `node E:/ag-local/setup/config-local.cjs
farm|go|studio`, đổi Claude giả/thật bằng `config-local.cjs claude fake|real` rồi tạo lại container api và worker.
Không chạy song song với chế độ trực tiếp: hai bên dùng chung cổng.

## 6. Sự cố thường gặp

| Hiện tượng | Nguyên nhân hay gặp | Cách xử lý |
|---|---|---|
| Studio API không khởi động, lỗi zod về biến môi trường | `.env` thiếu khoá (Auth0, Account, ag-go, farm, R2 đều bắt buộc) | So `apps/api/.env` với `.env.example` |
| Worker thoát ngay với `STUDIO_CLAUDE_MAX_CONCURRENT must be…` | Giá trị không phải số nguyên 1–100 | Sửa hoặc bỏ khoá (mặc định 20) |
| Đăng nhập Auth0 báo callback không hợp lệ | Web không chạy ở `localhost:3100` hoặc tenant chưa cho phép | Chạy web đúng cổng 3100 |
| Cây folder trống, lỗi CORS khi web gọi ag-go | `CORS_EXTRA_ORIGINS` của ag-go thiếu `http://localhost:3100` | Sửa `ag-go-api/.env`, bật lại ag-go-api |
| Account API không với tới | Container account dừng | Vẫn vào được, nhưng không ai là admin và tên hiện thiếu |
| `render-final` treo tới hết deadline | Farm hub hoặc `local-render` không chạy | `local-stack.mjs status`, web farm 3011 |
| Stage Claude chờ lâu, log có `RATE_LIMITED` | Hết hạn mức gói | Đợi; tự thử lại 5→60 phút, không tính là lỗi |
| Stage Claude lỗi `agent CLI failed to start` | Không tìm thấy `claude` / `claude.exe` | Cài Claude Code, hoặc đặt lại `STUDIO_CLAUDE_ARGV` về Claude giả |
| `up` báo "chưa lên sau 180 s" | Dịch vụ lỗi khi khởi động | Xem `E:\ag-local\dev-run\<tên>.log` |
| Chat hiện "Claude đang trả lời…" mãi | Worker không chạy (vòng chat nằm trong worker) | `local-stack.mjs status`, log `studio-worker` |
| Chat hiện "Đang chờ lượt" lâu | Đủ số lượt Claude cùng lúc | Chờ, hoặc admin tăng số lượt ở màn Hàng đợi |
| Render bản cuối "Đang chờ máy phù hợp" mãi | Không node nào khớp kiểu máy đã chọn (vd chọn GPU, máy không có) | Web farm 3011 xem khả năng node; huỷ tập rồi Render lại với "Bất kỳ máy nào" |
| `render-final` hỏng, job farm `failed` ở `download_composition` với `fetch failed` | `sign_url` của chủ job `studio` trong DB farm còn trỏ cổng 3100 (chế độ Docker); chạy trực tiếp thì 3100 là web, API ở 3101 | `docker exec postgres16 psql -U postgres -d ag_farm -c "UPDATE farm_owners SET sign_url = 'http://<IP máy>:3101/api/farm/sign' WHERE id = 'studio'"`; chuyển lại Docker thì đặt về `:3100` |
| Màn Hàng đợi "Không đọc được hàng đợi farm" | Farm hub không chạy, hoặc `FARM_OWNER_KEY` sai | `local-stack.mjs status`; log `studio-api` |
| Kiểm trong khung trình duyệt của app desktop, số liệu không tự cập nhật | Khung đó báo trang luôn ẩn nên không polling | Tải lại trang sau mỗi bước |
