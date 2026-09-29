# ag-studio

Engine dựng video nội bộ của nhóm, fork từ **YouTube Operations Harness** (tag `harness-baseline`).
Chạy trên một node Linux trung tâm; phần render nặng (TTS, encode 4K) đẩy ra **ag-render-worker** qua **ag-farm**.

---

## Tổng quan hệ thống

```
Người dùng (trình duyệt)
       │
       ▼
ag-studio  ──────► ag-go-api  (footage, act-as)
       │
       ▼
ag-farm  ◄──────► ag-render-worker  (TTS, render preview / final)
```

- **ag-studio** giữ engine SQLite (`node:sqlite`, Node ≥ 22.13), API NestJS, và web React.
- Claude chạy qua `claude -p` (gói subscription), không dùng `ANTHROPIC_API_KEY`.
- Mỗi production lưu timeline (`CompositionSchema`) qua migration `0008_studio.sql`.
- Render worker đọc `@ag-studio/render` và nhận URL ký qua `POST /farm/sign`.

---

## Yêu cầu môi trường

| Phần mềm | Phiên bản tối thiểu |
|---|---|
| Node.js | 22.13 |
| pnpm | 12.3.4 (qua `corepack`) |
| ffmpeg / ffprobe | 6.0+ trên PATH (chỉ cần cho test media) |
| Claude CLI | phiên bản mới nhất, đăng nhập gói subscription |

**Lưu ý:** `pnpm` không có trên PATH — dùng `corepack pnpm …` trên mọi lệnh.

---

## Cài đặt

```bash
corepack enable
corepack pnpm install
corepack pnpm build
```

Tạo database cho project thử:

```bash
corepack pnpm harness --project fixtures/ops-project-minimal db migrate
```

Chạy toàn bộ test:

```bash
corepack pnpm test
```

---

## Cấu trúc packages

| Package | Tên | Mô tả |
|---|---|---|
| `packages/contracts` | `@harness/contracts` | Zod schema dùng chung: `CompositionSchema`, `ProjectConfigSchema`, `StageRequest`, v.v. |
| `packages/core` | `@harness/core` | Engine: state machine, SQLite store, media compose/render, verification |
| `packages/executors` | `@harness/executors` | Script, agent, gate, **farm** executor |
| `packages/render` | `@ag-studio/render` | Re-export `renderComposition` dùng cho ag-render-worker |
| `packages/script-sdk` | `@harness/script-sdk` | SDK cho script executor |
| `packages/adapters/agent-cli` | `@harness/adapter-agent-cli` | Runtime `claude -p` với structured mode, OAuth, rate-limit |
| `packages/adapters/fake` | `@harness/adapter-fake` | Adapter giả dùng trong test |
| `packages/cli` | `@harness/cli` | Lệnh `harness` (db, plan, enqueue, worker, status…) |
| `packages/worker` | `@harness/worker` | Worker daemon |
| `packages/dashboard` | `@harness/dashboard` | Dashboard web nội bộ |

---

## Database

Migration file nằm trong `migrations/`. Chạy:

```bash
corepack pnpm harness --project <project_dir> db migrate
```

Danh sách migration:

| File | Nội dung |
|---|---|
| `0001` – `0007` | Schema harness gốc (runs, stage_runs, artifacts, compositions…) |
| `0008_studio.sql` | `teams`, `team_members`, `productions`, `production_sources`, `timeline_revisions`, `comments` |

---

## Canvas

`render.canvas` trong `project.yaml` (mặc định `3840×2160`) quyết định độ phân giải ra. ASS subtitle và
composition checker đều đọc từ giá trị này; không còn hằng số cứng trong code.

```yaml
media:
  render:
    canvas:
      width: 1920
      height: 1080
```

---

## Claude (gói subscription)

Runtime `claude` trong `adapters/agent-cli` dùng **`CLAUDE_CODE_OAUTH_TOKEN`** (không phải `ANTHROPIC_API_KEY`).

Lấy token:

```bash
claude setup-token
```

Skill Studio chạy ở structured mode: prompt + catalog đưa qua **stdin**, tắt hết tool, parse `structured_output` từ JSON trả về.

---

## Executor `farm`

Stage khai báo:

```yaml
executor:
  type: farm
  job: studio.tts
stage_config:
  production_id: "{{production_id}}"
```

Executor tự đẩy input lên bucket Studio, gửi job sang ag-farm (idempotent qua `correlation_id = attempt_id`), poll đến khi xong, tải output về, rồi ack job.

---

## Package `@ag-studio/render`

```typescript
import { renderComposition, probeNvenc } from "@ag-studio/render";
import type { RenderDeps, RenderInput } from "@ag-studio/render";
```

ag-render-worker chỉ cần phụ thuộc vào package này, không cần import toàn bộ `@harness/core`.

---

## AG Studio — Chạy API và Web

### Biến môi trường

Tạo `apps/api/.env` và `apps/web/.env` từ các file mẫu `.env.example`.

#### `apps/api/.env`

```env
# SQLite database
STUDIO_DB_PATH=./data/studio.db

# Auth0 (dùng chung audience với ag-go-api)
AUTH0_ISSUER_URL=https://<your-tenant>.auth0.com/
AUTH0_AUDIENCE=https://api.ant-group.net
AUTH0_JWKS_URI=https://<your-tenant>.auth0.com/.well-known/jwks.json
# Client IDs được phép (SPA ag-studio-web); phân tách bằng dấu phẩy
AUTH0_ALLOWED_CLIENT_IDS=<studio-web-client-id>

# Account API (lấy quyền user theo userId)
ACCOUNT_API_URL=https://account.ant-group.net
ACCOUNT_API_KEY=<service-api-key>

# ag-go-api (footage, act-as)
AG_GO_API_URL=https://go-api.ant-group.net
AG_GO_SERVICE_KEY=<studio-service-key-registered-in-ag-go>

# ag-farm (gửi job render, poll kết quả)
FARM_URL=https://farm.ant-group.net
FARM_OWNER_KEY=<studio-owner-key-registered-in-ag-farm>
# Khoá công khai Ed25519 của ag-farm (PEM), dùng để kiểm vé job
FARM_TICKET_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"

# R2 bucket của Studio (giữ riêng, không chia sẻ với ag-go hay ag-farm)
STUDIO_R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
STUDIO_R2_BUCKET=ag-studio
STUDIO_R2_ACCESS_KEY_ID=<r2-access-key-id>
STUDIO_R2_SECRET_ACCESS_KEY=<r2-secret-access-key>

# TTL URL ký (giây); render worker cần đủ thời gian tải file
FARM_URL_TTL_SECONDS=3600
```

#### `apps/web/.env`

```env
VITE_AUTH0_DOMAIN=<your-tenant>.auth0.com
VITE_AUTH0_CLIENT_ID=<studio-web-spa-client-id>
VITE_AUTH0_AUDIENCE=https://api.ant-group.net

# Studio API — bỏ trống nếu dùng proxy Vite (proxy /api → localhost:3100)
VITE_STUDIO_API_URL=

# ag-go-api — web gọi TRỰC TIẾP bằng token của người dùng (không qua Studio)
VITE_AG_GO_API_URL=https://go-api.ant-group.net
```

### Chạy development

```bash
# Cài dependencies
corepack pnpm install

# Chạy API (cổng 3100)
corepack pnpm --filter @ag-studio/api start:dev

# Chạy Web (cổng 5173, proxy /api → localhost:3100)
corepack pnpm --filter @ag-studio/web dev
```

### Phụ thuộc ngoài

| Service | Vai trò | Ghi chú |
|---|---|---|
| **Auth0** | Xác thực người dùng (JWT) | Tạo SPA app cho `ag-studio-web`; `azp` phải nằm trong `AUTH0_ALLOWED_CLIENT_IDS` |
| **Account API** (`/v2/public/users/{userId}/access`) | Lấy `user_type` + quyền của user theo ID | Cần endpoint mới cho act-as (không phải `/v2/users/me`) |
| **ag-go-api** | Footage, danh mục đoạn, ký URL | Đăng ký Studio làm service key với scope `footage:read,footage:resolve`; cho `azp` của web vào allowlist |
| **ag-farm** | Hàng đợi job render | Đăng ký Studio làm owner `studio` với `sign_url = <studio-api-url>/api/farm/sign`; lấy khoá owner và khoá công khai |
| **R2 bucket** | Lưu input/output render, thư viện brand/nhạc | Tạo bucket riêng; lấy R2 API token với quyền ghi |

### Đăng ký ag-farm owner

Trên ag-farm-web (vai ADMIN), tạo owner mới:
- **ID:** `studio`
- **sign_url:** `https://<studio-api-host>/api/farm/sign`
- **Loại job cho phép:** `studio.tts`, `studio.render_preview`, `studio.render_final`
- **Lane mặc định:** `interactive`

Sau đó copy khoá owner và khoá công khai Ed25519 vào `.env` của API.

---

## Database

Migration file nằm trong `migrations/`. Chạy:

```bash
corepack pnpm harness --project <project_dir> db migrate
```

Danh sách migration:

| File | Nội dung |
|---|---|
| `0001` – `0007` | Schema harness gốc (runs, stage_runs, artifacts, compositions…) |
| `0008_studio.sql` | `teams`, `team_members`, `productions`, `production_sources`, `timeline_revisions`, `comments` |
| `0009_studio_farm_jobs.sql` | `studio_farm_jobs` (theo dõi farm job ID per attempt), `sign_audit_log` |

API tự chạy migration khi khởi động qua `StudioDbService`.

---

## Liên kết

- Kế hoạch triển khai: `C:\Users\AG-89\.claude\plans\ok-h-y-c-p-nh-t-shimmying-starfish.md`
- ag-farm: `E:\CODE\ag-farm`
- Harness gốc (nguồn): `E:\CODE\ag-harness-agent\YOUTUBE_OPERATIONS_HARNESS` (tag `harness-baseline`)
