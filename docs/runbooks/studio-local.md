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
trả `ok`; web farm (3011) thấy `local-render`, `local-scan` Online; mở `http://localhost:3100`, đăng nhập Auth0,
mở một dự án, tab Đầu vào → "Thêm project ag-go": danh sách project ag-go phải hiện.

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

Migration: Studio API (và worker) tự migrate database Postgres `DATABASE_URL` khi khởi động. ag-go: `yarn migration:run` trong `ag-go-api`. ag-farm:
script `migration:run` trỏ sai chỗ typeorm, chạy tay trong `ag-farm/apps/api`:

```bash
node --require ts-node/register ../../node_modules/typeorm/cli.js migration:run -d src/database/data-source.ts
```

## 4. Cấu hình

- Các file `.env` cho chạy trực tiếp đã có sẵn trên máy dev (bảng mục 1); chúng trỏ `localhost`, khác bộ `.env` cho
  Docker (`E:\CODE\ag-studio\.env`, `E:\CODE\ag-farm\.env`, trỏ `host.docker.internal`) do
  `E:\ag-local\setup\config-local.cjs` sinh. Dữ liệu Studio: database Postgres `DATABASE_URL` (schema `DATABASE_SCHEMA`, mặc định public) trong `apps/api/.env`
  (worker dùng cùng database), file ở
  `E:\ag-local\studio-data\harness`. `studio.db` cũ ở `E:\ag-local\studio-data` chỉ còn để chép sang Postgres một lần:
  `node packages/studio-engine/scripts/migrate-sqlite-to-pg.mjs <studio.db>` (cần `DATABASE_URL`, build engine trước).
- **Claude giả hay thật:** `STUDIO_AGENT_ARGV` trong `apps/api/.env` (mảng JSON, ví dụ
  `["node","E:/CODE/ag-studio/fixtures/fake-studio-agent.mjs"]`) cho agent giả, không tốn hạn mức. Bỏ dòng đó để dùng
  `claude` thật bằng `CLAUDE_CODE_OAUTH_TOKEN` (hoặc đăng nhập `claude` → `/login`). Trên Windows, `claude.cmd` của npm
  được tự dò ra `claude.exe` (`resolveCommand`). (`STUDIO_CLAUDE_ARGV` của pipeline cũ không còn ai đọc.)
- **Dọn dữ liệu cũ:** worker tự dọn mỗi `STUDIO_CLEANUP_HOURS` giờ (mặc định 6; `0` = tắt), lần đầu sau 1 phút: kho giọng
  lâu không đọc (`STUDIO_RETENTION_VOICE_DAYS`, 90), audio dự án không còn ai trỏ tới (`_AUDIO_DAYS`, 7), thư mục tạm của
  job/lượt bị bỏ dở (sau 6 giờ), `.trash` của dự án (`_WORKSPACE_DAYS`, 14). Log `cleanup swept` ghi số đã xoá từng loại.
- **Số lượt Claude cùng lúc:** admin Studio chỉnh trên web (màn Hàng đợi, cột phải; lưu vào `studio_settings`, áp dụng
  ngay). Chưa ai lưu thì dùng `STUDIO_CLAUDE_MAX_CONCURRENT` (1–100, mặc định 20). Lượt agent và tóm tắt luồng dùng chung số
  này trên mọi worker; nhiều lượt hơn thì hạn mức gói hết nhanh hơn, mỗi lượt một tiến trình `claude`.
- **Máy render bản cuối:** thẻ xác nhận `render_final` gửi job với `requirements` mặc định (máy nào cũng được), hoặc ghim
  `node_id` khi agent điền. Xem máy `local-render` khai gì (GPU, `nvenc`) ở web farm 3011: không máy nào khớp thì job chờ.
- **Màn Hàng đợi** (`http://localhost:3100/queue`): việc đang chạy của mọi dự án bạn thấy (lượt agent, tool, job kèm máy
  farm; Dừng), máy của farm; admin chỉnh số lượt Claude và tên AI ở cột phải.
- Auth0: client SPA phải cho phép `http://localhost:3100` (callback, logout, web origin); client id nằm trong
  `AUTH0_ALLOWED_CLIENT_IDS` của Studio, ag-go và farm.
- **Tải file lên đi thẳng R2**, không qua nginx và API. Studio kiểm tên, loại và dung lượng rồi ký link PUT
  (`POST /api/projects/:id/uploads`, kho nhạc `POST /api/studio/music/uploads`). Trình duyệt PUT file lên
  `uploads/<dự án|library>/<uuid>`, có % tiến độ. Sau đó route tải lên cũ được gọi với `{uploadKey, name}`: API kéo file
  từ R2 về, xử lý như trước rồi xoá bản trên R2. Bản bỏ dở bị worker dọn sau 24 giờ. Bucket **phải bật CORS** cho
  origin của web, không thì mọi lần tải lên báo "Không tải được lên kho lưu trữ (R2)". Cloudflare → R2 → bucket →
  Settings → CORS policy:

  ```json
  [
    {
      "AllowedOrigins": ["https://studio.ant-group.net", "http://localhost:3100"],
      "AllowedMethods": ["GET", "PUT"],
      "AllowedHeaders": ["Content-Type"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
  ```

  Bucket prod và bucket dev mỗi cái một policy, ghi origin của web dùng bucket đó (thêm domain dev nếu có).
  `GET` để trình duyệt phát lời dẫn và render. Multipart cũ vẫn nhận (CLI, test).
- Chuẩn bị video, timeline, thumbnail và audio người dùng đưa dùng ffmpeg ở `STUDIO_FFMPEG_PATH` (máy dev trỏ tới
  `ffmpeg-static` của ag-render-worker vì ffmpeg không có trên PATH).

## 4c. Dự án và agent (spec 2026-10-10 agent-workspace)

- Bật agent: `STUDIO_AGENT_TOKEN_SECRET` (≥ 16 ký tự, `openssl rand -hex 32`) trong `apps/api/.env` — API và worker đọc chung
  file này khi chạy trực tiếp. Không đặt thì worker ghi `warn` và không chạy lượt chat nào của dự án.
- Worker gọi tool Studio qua API ở `STUDIO_API_INTERNAL_URL` (máy dev: `http://127.0.0.1:3101`, cổng của Studio API chạy
  trực tiếp). CLI: `claude` trên PATH (hoặc `STUDIO_AGENT_ARGV`), đăng nhập bằng `CLAUDE_CODE_OAUTH_TOKEN` (`claude
  setup-token`); cấu hình/session của agent ở `STUDIO_AGENT_CLAUDE_CONFIG_DIR` (mặc định `<STUDIO_DATA_ROOT>/agent-claude`),
  tách khỏi `~/.claude` của người dùng máy.
- Thư mục dự án: `STUDIO_WORKSPACES_ROOT` (mặc định `<STUDIO_DATA_ROOT>/workspaces`, máy dev
  `E:\ag-local\studio-data\harness\workspaces`). Phải nằm ngoài mọi repo (CLAUDE.md của thư mục cha sẽ lọt vào agent).
- Việc nền của dự án (chuẩn bị video, crawl, dựng timeline, render, thumbnail, học phong cách) chạy trong worker,
  `STUDIO_JOB_LANES` việc cùng lúc (mặc định 2), thêm một việc cho mỗi máy farm đang rảnh tới `STUDIO_JOB_LANES_MAX`
  (mặc định 8). Chuẩn bị video không giải mã gì trên worker: ag-go-api (3738) chuẩn bị sẵn (farm `scan.prep` trên
  `local-scan`, lời thoại `studio.transcribe` trên `local-render`), Studio chép khung, tờ ghép, lời thoại về; ag-go-api
  tắt thì việc chuẩn bị lỗi "fetch failed". Việc dùng farm (lời dẫn, render) cần máy `local-render`
  **online** ở web farm 3011: farm-api tắt lâu thì render worker không tự nối lại — tắt/bật lại `render-worker`.
- Log Studio API/worker khi bật bằng `local-stack.mjs` không vào `E:/ag-local/dev-run/*.log` (chạy dưới `cmd.exe`); xem
  trạng thái lượt chat và job trong Postgres (`agent_messages`, `project_jobs`) hoặc màn web.

## 5. Chạy bằng Docker (cách cũ)

`E:\CODE\ag-studio\docker-compose.yml` + `deploy.sh` (api → worker → web, cổng 3100, cần `../ag-farm` cạnh repo),
ag-go và ag-farm có `docker-compose.yml` riêng; cấu hình sinh bằng `node E:/ag-local/setup/config-local.cjs
farm|go|studio`, đổi Claude giả/thật bằng `config-local.cjs claude fake|real` rồi tạo lại container api và worker.
Không chạy song song với chế độ trực tiếp: hai bên dùng chung cổng.

## 4a. Lời dẫn và nhận dạng lời nói trên farm local

- `local-render` nhận `studio.tts` và `studio.transcribe` khi `E:\ag-local\dev-run\render.yaml` có hai kind đó và
  `extra.python_bin: 'E:/ag-local/venv/Scripts/python.exe'` (venv có OmniVoice + WhisperX, `engines/python/README.md`),
  và render worker từ 0.6.0 (có handler transcribe; worker-sdk dò Python theo `python_bin`). Kiểm ở web farm 3011: node
  khai `python` và hai kind mới. DB farm cần migration `1600000000000-studio-transcribe` (mục 3: chạy migration hub).
- **Kho giọng:** `E:\ag-local\studio-data\voice\<sha256>.wav` + bảng `studio_voice_lines`; một câu (cùng chữ, giọng,
  tốc độ) chỉ đọc một lần cho mọi video; worker dọn câu lâu không đọc (mục 4).
- **Contact sheet thiếu nhãn:** khung vẫn được cắt; nhãn `s000-001` trên ảnh cần font (`STUDIO_FONTS_DIR`).
- Thời gian từng bước đo trên máy dev ghi ở ADR-0001 mục 160 (lần kiểm tay I3 của pha 5).

## 4b. yt-dlp: crawl không cần API key, học phong cách dựng

Worker dùng yt-dlp cho hai việc (ADR-0001 mục 175–176, 186):

- **Crawl:** tab Nghiên cứu và tool của agent tìm video xu hướng, video top của kênh. Không có `YOUTUBE_API_KEY` thì worker
  tìm bằng `yt-dlp ytsearchN:` và kênh `/videos` (không tốn hạn mức, ít số liệu hơn). Không có cả hai thì job `research`
  chờ một worker có.
- **Học phong cách:** chỉ khi người bấm xác nhận thẻ `reference_download`: tải video mẫu ở ≤480p, đo nhịp cắt, giữ khung và
  tờ ghép, **xoá video ngay**. Không cookie, không đăng nhập: video YouTube chặn thì bỏ qua và ghi lỗi. Đây là quyết định
  của người dùng, chấp nhận rủi ro điều khoản YouTube; tắt hẳn bằng `STUDIO_REFERENCE_DOWNLOADS=0` (cả đường farm).
  Có máy farm online nhận `studio.reference_fetch` (máy render có yt-dlp trong venv, tự nhận loại job khi cập nhật) thì
  video mẫu do **máy farm** tải (YouTube thường chặn IP máy chủ, không chặn máy văn phòng): Studio kéo file từ bucket về
  thư mục nháp của job, đo, rồi xoá cả object trên bucket lẫn file nháp (ADR-0001 mục 193). Job hiện "Đang tải video mẫu
  i/n trên máy <tên>"; không có máy nào thì worker tự tải bằng yt-dlp như trên. Video mẫu người dùng
  tải lên tab Đầu vào (mục Video mẫu, `context/references/`, ≤ 300 MB) thì agent học bằng `style_from_files`: không thẻ,
  không mạng, chỉ cần ffmpeg, không xoá file của họ.

Cài trên máy dev Windows (một lần), rồi khai trong `apps/api/.env` (worker chạy trực tiếp đọc file này):

```
py -m pip install --user yt-dlp
```

`YTDLP_PATH` trỏ `yt-dlp.exe` (thường `%APPDATA%PythonPython311Scriptsyt-dlp.exe`), bật lại worker. Log khởi động
worker ghi `"ytdlp":"<phiên bản>"`; `null` kèm `warn` "yt-dlp cannot run" nghĩa là sai đường dẫn. Cập nhật khi YouTube
đổi: `py -m pip install --user -U yt-dlp` (image Docker: đổi `YTDLP_VERSION` trong `Dockerfile`). Bản yt-dlp mới có
thể cần thêm một JS runtime (Deno) cho YouTube: làm theo thông báo lỗi của yt-dlp.

## 6. Sự cố thường gặp

| Hiện tượng | Nguyên nhân hay gặp | Cách xử lý |
|---|---|---|
| Studio API không khởi động, lỗi zod về biến môi trường | `.env` thiếu khoá (Auth0, Account, ag-go, farm, R2 đều bắt buộc) | So `apps/api/.env` với `.env.example` |
| Crawl dùng yt-dlp dù đã có khoá; log khởi động worker `"youtube_api":false` | Khoá chỉ nằm ở `.env` gốc (bộ Docker); worker chạy trực tiếp đọc `apps/api/.env` | Thêm `YOUTUBE_API_KEY` vào `apps/api/.env`, bật lại worker |
| Worker thoát ngay với `STUDIO_CLAUDE_MAX_CONCURRENT must be…` | Giá trị không phải số nguyên 1–100 | Sửa hoặc bỏ khoá (mặc định 20) |
| Đăng nhập Auth0 báo callback không hợp lệ | Web không chạy ở `localhost:3100` hoặc tenant chưa cho phép | Chạy web đúng cổng 3100 |
| Cây folder trống, lỗi CORS khi web gọi ag-go | `CORS_EXTRA_ORIGINS` của ag-go thiếu `http://localhost:3100` | Sửa `ag-go-api/.env`, bật lại ag-go-api |
| Account API không với tới | Container account dừng | Vẫn vào được, nhưng không ai là admin và tên hiện thiếu |
| Job render "Đang chờ máy farm" mãi | Farm hub hoặc `local-render` không chạy, hoặc không máy nào khớp yêu cầu | `local-stack.mjs status`, web farm 3011; quá `STUDIO_FARM_QUEUE_TIMEOUT_MINUTES` thì job tự huỷ và báo vào luồng |
| Dựng timeline báo thiếu giọng đọc | Dự án chưa chọn giọng (hay chưa chọn "không lời dẫn") | Tab Đầu vào → Giọng và nhạc: chọn một file audio đã tải lên làm giọng (vai producer, khai nguồn gốc), hoặc không lời dẫn |
| Đưa audio báo 503 `audio_disabled` (tab Đầu vào báo "máy Studio chưa có ffmpeg") | API thiếu `STUDIO_FFMPEG_PATH` (ffprobe mặc định nằm cạnh; khác chỗ thì đặt `STUDIO_FFPROBE_PATH`) | Đặt trong `apps/api/.env` (máy dev: ffmpeg-static/ffprobe-static của ag-render-worker) rồi bật lại API |
| Tải file lên báo "Không tải được lên kho lưu trữ (R2)" | Bucket R2 chưa bật CORS cho origin của web (DevTools: request `OPTIONS`/`PUT` tới `*.r2.cloudflarestorage.com` bị chặn) | Thêm CORS policy ở mục 4 cho bucket đó |
| Tải file lên báo `upload_missing` | Link PUT hết hạn (1 giờ) hoặc PUT chưa xong | Tải lại |
| Lượt agent chờ lâu, "chờ hạn mức" | Hết hạn mức gói | Đợi; tự thử lại 5→60 phút, không tính là lỗi |
| Lượt agent lỗi `agent CLI failed to start` | Không tìm thấy `claude` / `claude.exe` | Cài Claude Code, hoặc đặt `STUDIO_AGENT_ARGV` về agent giả |
| `up` báo "chưa lên sau 180 s" | Dịch vụ lỗi khi khởi động | Xem `E:\ag-local\dev-run\<tên>.log` |
| Chat hiện agent đang làm mãi, không có chữ nào | Worker không chạy, hoặc thiếu `STUDIO_AGENT_TOKEN_SECRET` | `local-stack.mjs status`; log khởi động worker `"agent_turns":true` |
| Chat hiện "chờ lượt" lâu | Đủ số lượt Claude cùng lúc | Chờ, hoặc admin tăng số lượt ở màn Hàng đợi |
| Render hỏng, job farm `failed` ở `download_composition` với `fetch failed` | `sign_url` của chủ job `studio` trong DB farm trỏ sai: IP máy đã đổi (DHCP), hoặc còn cổng 3100 (chế độ Docker; chạy trực tiếp thì 3100 là web, API ở 3101). `node scripts/local-stack.mjs status` báo khi lệch, `up` tự sửa theo IP LAN hiện tại | `docker exec postgres16 psql -U postgres -d ag_farm -c "UPDATE farm_owners SET sign_url = 'http://<IP máy>:3101/api/farm/sign' WHERE id = 'studio'"`; chuyển lại Docker thì đặt về `:3100` |
| Quét video trên ag-go hỏng hàng loạt, job farm `scan.extract` `failed` ở `download` với `fetch failed` | `sign_url` của chủ job `ag-go` trong DB farm còn trỏ cổng 3737 (chế độ Docker); chạy trực tiếp thì ag-go-api ở 3738 | `docker exec postgres16 psql -U postgres -d ag_farm -c "UPDATE farm_owners SET sign_url = 'http://<IP máy>:3738/api/analysis/farm/sign' WHERE id = 'ag-go'"`, rồi quét lại các video hỏng (backfill "Chỉ chưa phân tích") |
| Màn Hàng đợi "Không đọc được danh sách máy farm" | Farm hub không chạy, hoặc `FARM_OWNER_KEY` sai | `local-stack.mjs status`; log `studio-api` |
| Kiểm trong khung trình duyệt của app desktop, số liệu không tự cập nhật | Khung đó báo trang luôn ẩn nên không polling | Tải lại trang sau mỗi bước |
| Chuẩn bị video treo ở "Đang chờ máy" / "Đang đọc lời thoại" | ag-go chạy `scan.prep` trên `local-scan` (cần bản có `scan.prep`), lời thoại `studio.transcribe` trên `local-render`: máy offline hoặc thiếu kind | Web farm 3011 xem node và job của chủ `ag-go`; trang phân tích ag-go (admin) xem số prep đang chạy |
| Chuẩn bị video lỗi ngay ("fetch failed", 401/403) | ag-go-api 3738 không chạy, hoặc khoá Studio thiếu scope `footage:read`/`footage:resolve` trong `SERVICE_KEYS` của ag-go | `local-stack.mjs status`; sửa `SERVICE_KEYS` rồi bật lại ag-go-api |
| Log worker `usage events not sent to ag-go` (HTTP 403) | Khoá Studio trong `SERVICE_KEYS` của ag-go thiếu scope `usage:write` | Thêm scope rồi bật lại ag-go-api; sự kiện nằm trong `ag_go_usage_outbox` và tự gửi lại (chậm nhất 1 giờ) |
| Dựng timeline treo ở "đọc lời dẫn" | `local-render` không khai `python` hoặc thiếu kind `studio.tts` | Mục 4a; web farm 3011 xem khả năng node |
| Job `studio.transcribe` bị hub từ chối "not allowed for owner studio" | DB farm chưa chạy migration `studio-transcribe` | Chạy migration hub (mục 3) |
| Job học phong cách (`style_watch`) chờ mãi | Không worker nào có ffmpeg (`media`) | Mục 4a/4b; bật lại worker |
| Video YouTube trong job học phong cách báo `no_ytdlp` | Worker không có yt-dlp hay `STUDIO_REFERENCE_DOWNLOADS=0` | Mục 4b; hoặc tải video mẫu lên tab Đầu vào |
| Học phong cách báo "YouTube đang chặn tải từ máy chủ Studio…" (mã `youtube_blocked`; Hàng đợi hiện cảnh báo cho admin) | YouTube đòi xác nhận không phải bot với IP máy chạy worker, và không máy farm nào nhận `studio.reference_fetch` | Bật/cập nhật một máy render có yt-dlp (trang Máy của farm thấy loại `studio.reference_fetch`): video mẫu sẽ đi qua máy đó; hoặc tải video mẫu lên tab Đầu vào, hoặc tả phong cách bằng lời; research đặt `YOUTUBE_API_KEY`. Studio nhớ 6 giờ, tải được trên máy chủ thì tự xoá. Không lách chặn (không cookie) |
| Học phong cách báo "YouTube đang chặn tải từ máy farm <tên>…" (Hàng đợi: "YouTube cũng đang chặn tải từ các máy farm") | YouTube chặn cả IP văn phòng | Tải video mẫu lên tab Đầu vào hoặc tả bằng lời; Studio nhớ 6 giờ (`youtube.farm_blocked_until`), máy farm tải được thì tự xoá |
| Crawl ở tab Nghiên cứu chờ mãi | Worker không có `YOUTUBE_API_KEY` lẫn yt-dlp | Đặt `YOUTUBE_API_KEY` hoặc cài yt-dlp (mục 4b), bật lại worker |
