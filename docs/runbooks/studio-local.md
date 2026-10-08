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
- **Dọn dữ liệu cũ:** worker tự dọn mỗi `STUDIO_CLEANUP_HOURS` giờ (mặc định 6; `0` = tắt), lần đầu sau 1 phút:
  workspace của run đã kết thúc (`STUDIO_RETENTION_WORKSPACE_DAYS`, 14), kho giọng (`_VOICE_DAYS`, 90), audio
  production không còn dùng (`_AUDIO_DAYS`, 7). Log `cleanup swept` ghi số đã xoá từng loại.
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

## 4a. Lời dẫn và nhận dạng lời nói trên farm local (tập cắt theo shot)

- `local-render` nhận `studio.tts` và `studio.transcribe` khi `E:\ag-local\dev-run\render.yaml` có hai kind đó và
  `extra.python_bin: 'E:/ag-local/venv/Scripts/python.exe'` (venv có OmniVoice + WhisperX, `engines/python/README.md`),
  và render worker từ 0.6.0 (có handler transcribe; worker-sdk dò Python theo `python_bin`). Kiểm ở web farm 3011: node
  khai `python` và hai kind mới. DB farm cần migration `1600000000000-studio-transcribe` (mục 3: chạy migration hub).
- **Kho giọng:** `E:\ag-local\studio-data\voice\<sha256>.wav` + bảng `studio_voice_lines`; một câu (cùng chữ, giọng,
  tốc độ) chỉ đọc một lần cho mọi tập. Không có gì dọn kho này (deferred).
- **Contact sheet thiếu nhãn:** khung vẫn được cắt; nhãn `s000-001` trên ảnh cần font (`STUDIO_FONTS_DIR`).
- Thời gian từng bước đo trên máy dev ghi ở ADR-0001 mục 160 (lần kiểm tay I3 của pha 5).

## 6. Sự cố thường gặp

| Hiện tượng | Nguyên nhân hay gặp | Cách xử lý |
|---|---|---|
| Studio API không khởi động, lỗi zod về biến môi trường | `.env` thiếu khoá (Auth0, Account, ag-go, farm, R2 đều bắt buộc) | So `apps/api/.env` với `.env.example` |
| Báo cáo xu hướng bị bỏ qua, ghi "Không có dữ liệu nghiên cứu: Chưa cấu hình YOUTUBE_API_KEY cho Studio worker" (báo cáo cũ hơn chỉ ghi "Không có dữ liệu nghiên cứu YouTube…"); worker log `warn` "YOUTUBE_API_KEY is not set" lúc khởi động | Khoá chỉ nằm ở `.env` gốc (bộ Docker); worker chạy trực tiếp đọc `apps/api/.env` | Thêm `YOUTUBE_API_KEY` vào `apps/api/.env`, bật lại worker, rồi chạy lại series từ bước `research` (kết quả "bỏ qua" cũ không tự làm lại) |
| Worker thoát ngay với `STUDIO_CLAUDE_MAX_CONCURRENT must be…` | Giá trị không phải số nguyên 1–100 | Sửa hoặc bỏ khoá (mặc định 20) |
| Đăng nhập Auth0 báo callback không hợp lệ | Web không chạy ở `localhost:3100` hoặc tenant chưa cho phép | Chạy web đúng cổng 3100 |
| Cây folder trống, lỗi CORS khi web gọi ag-go | `CORS_EXTRA_ORIGINS` của ag-go thiếu `http://localhost:3100` | Sửa `ag-go-api/.env`, bật lại ag-go-api |
| Account API không với tới | Container account dừng | Vẫn vào được, nhưng không ai là admin và tên hiện thiếu |
| `render-final` treo tới hết deadline | Farm hub hoặc `local-render` không chạy | `local-stack.mjs status`, web farm 3011 |
| Tập cắt dừng ở lời dẫn, "cần giọng đọc" | Production chưa có giọng mẫu, không có `STUDIO_DEFAULT_VOICE_REFERENCE` | Đưa giọng ở cột phải (link/tải lên) hoặc Bỏ lời dẫn. Link tới máy local (`http://localhost…`) cần `STUDIO_AUDIO_ALLOW_PRIVATE_URLS=true` trong `apps/api/.env` |
| Đưa audio báo 503 `audio_disabled` | API thiếu `STUDIO_FFMPEG_PATH` hoặc `STUDIO_FFPROBE_PATH` | Đặt cả hai trong `apps/api/.env` (máy dev: ffmpeg-static/ffprobe-static của ag-render-worker) rồi bật lại API |
| Stage Claude chờ lâu, log có `RATE_LIMITED` | Hết hạn mức gói | Đợi; tự thử lại 5→60 phút, không tính là lỗi |
| Stage Claude lỗi `agent CLI failed to start` | Không tìm thấy `claude` / `claude.exe` | Cài Claude Code, hoặc đặt lại `STUDIO_CLAUDE_ARGV` về Claude giả |
| `up` báo "chưa lên sau 180 s" | Dịch vụ lỗi khi khởi động | Xem `E:\ag-local\dev-run\<tên>.log` |
| Chat hiện "Claude đang trả lời…" mãi | Worker không chạy (vòng chat nằm trong worker) | `local-stack.mjs status`, log `studio-worker` |
| Chat hiện "Đang chờ lượt" lâu | Đủ số lượt Claude cùng lúc | Chờ, hoặc admin tăng số lượt ở màn Hàng đợi |
| Render bản cuối "Đang chờ máy phù hợp" mãi | Không node nào khớp kiểu máy đã chọn (vd chọn GPU, máy không có) | Web farm 3011 xem khả năng node; huỷ tập rồi Render lại với "Bất kỳ máy nào" |
| `render-final` hỏng, job farm `failed` ở `download_composition` với `fetch failed` | `sign_url` của chủ job `studio` trong DB farm trỏ sai: IP máy đã đổi (DHCP), hoặc còn cổng 3100 (chế độ Docker; chạy trực tiếp thì 3100 là web, API ở 3101). `node scripts/local-stack.mjs status` báo khi lệch, `up` tự sửa theo IP LAN hiện tại | `docker exec postgres16 psql -U postgres -d ag_farm -c "UPDATE farm_owners SET sign_url = 'http://<IP máy>:3101/api/farm/sign' WHERE id = 'studio'"`; chuyển lại Docker thì đặt về `:3100` |
| Quét video trên ag-go hỏng hàng loạt, job farm `scan.extract` `failed` ở `download` với `fetch failed` | `sign_url` của chủ job `ag-go` trong DB farm còn trỏ cổng 3737 (chế độ Docker); chạy trực tiếp thì ag-go-api ở 3738 | `docker exec postgres16 psql -U postgres -d ag_farm -c "UPDATE farm_owners SET sign_url = 'http://<IP máy>:3738/api/analysis/farm/sign' WHERE id = 'ag-go'"`, rồi quét lại các video hỏng (backfill "Chỉ chưa phân tích") |
| Màn Hàng đợi "Không đọc được hàng đợi farm" | Farm hub không chạy, hoặc `FARM_OWNER_KEY` sai | `local-stack.mjs status`; log `studio-api` |
| Kiểm trong khung trình duyệt của app desktop, số liệu không tự cập nhật | Khung đó báo trang luôn ẩn nên không polling | Tải lại trang sau mỗi bước |
| Tập cắt theo shot treo ở `tts` hoặc `transcribe` | `local-render` không khai `python` hoặc thiếu kind `studio.tts`/`studio.transcribe` | Mục 4a; web farm 3011 xem khả năng node |
| Job `studio.transcribe` bị hub từ chối "not allowed for owner studio" | DB farm chưa chạy migration `studio-transcribe` | Chạy migration hub (mục 3) |
