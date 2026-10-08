# ag-studio

Engine dựng video nội bộ của nhóm, fork từ **YouTube Operations Harness** (ADR-0001 mục 127). Người dùng tạo một
*production* (series nhiều tập) từ footage đã quét trên **ag-go**; Claude nghiên cứu thị trường rồi đề xuất R&D,
branding, kế hoạch tập; người duyệt từng bước; mỗi tập tự dựng timeline, render qua **ag-farm**, có thumbnail, gói
YouTube và xuất được project Premiere.

```
Trình duyệt ──► apps/web ──► apps/api ─┬─► studio.db (SQLite) ◄── apps/worker
     │                                 │                          │
     └────► ag-go-api (bearer Auth0)   └─► ag-go-api (service key, act-as)
                                                                  ▼
                                   ag-render-worker ◄──── ag-farm (hàng đợi render)
```

## Bắt đầu

| Bạn cần | Đọc |
|---|---|
| Chạy trên một máy (dịch vụ, cổng, cấu hình, bật hằng ngày) | `docs/runbooks/studio-local.md` |
| Tạo và vận hành một production, xử lý lỗi | `docs/runbooks/studio-production.md` |
| Quy tắc cho agent làm việc trong repo | `AGENTS.md` |
| Vì sao thiết kế như vậy | `docs/adr/0001-control-plane-baseline.md` (mục 127 trở đi cho Studio) |
| Hợp đồng API giữa web và api | `docs/studio-api-v3.md` |
| Skill nào chạy ở bước nào | `skills/README.md` |
| Việc đang làm, việc còn nợ | `docs/superpowers/specs/`, `docs/superpowers/plans/`, `docs/operations/deferred-items.md` |

Yêu cầu: Node ≥ 22.13, pnpm 12 qua `corepack` (`pnpm` không có trên PATH thì gõ `corepack pnpm …`), ffmpeg/ffprobe
cho thumbnail và test media, checkout `../ag-farm` (các package `@ag-farm/*` được link từ đó), Claude CLI đăng nhập
gói subscription (hoặc `CLAUDE_CODE_OAUTH_TOKEN`).

```bash
corepack enable
corepack pnpm install
corepack pnpm build
corepack pnpm test
```

## Cấu trúc

| Thư mục | Package | Vai trò |
|---|---|---|
| `apps/api` | `@ag-studio/api` | NestJS: Auth0, teams/vai, productions, run/gate, editor, thumbnail, Canva, `/farm/sign` |
| `apps/web` | `@ag-studio/web` | React + Ant Design: danh sách production, các bước duyệt, editor timeline theo tập |
| `apps/worker` | `@ag-studio/worker` | Chạy engine: claim stage, gọi Claude, gửi job farm |
| `packages/studio-engine` | `@ag-studio/engine` | Stage in-process, run-control (gate, retry, resume), editor, thumbnail, nhật ký LLM, nghiên cứu YouTube |
| `packages/ag-go-client` | `@ag-studio/ag-go-client` | Client footage của ag-go (service key + act-as) |
| `packages/render` | `@ag-studio/render` | Re-export `renderComposition` cho ag-render-worker |
| `packages/contracts` | `@harness/contracts` | Zod schema; tài liệu Studio ở `src/studio.ts` |
| `packages/core` | `@harness/core` | Control plane harness (state machine, planner, controller, artifact) + `src/studio/*` + pipeline media |
| `packages/executors` | `@harness/executors` | Executor script/agent/gate/**farm**, `StudioAgentExecutor` |
| `packages/adapters/agent-cli` | `@harness/adapter-agent-cli` | Gọi `claude -p` (file mode và structured mode) |
| `packages/cli`, `packages/worker` | `@harness/cli`, `@harness/worker` | CLI `harness` và vòng worker của harness |
| `workflows/`, `skills/`, `production-profiles/` | | Định nghĩa run, đề bài cho Claude, profile |
| `migrations/` | | SQL `0001`–`0007` (harness), `0008`–`0018` (Studio); API tự migrate khi khởi động |

## Phụ thuộc ngoài

| Dịch vụ | Vai trò | Cần đăng ký |
|---|---|---|
| **Auth0** | Đăng nhập (JWT) | Client SPA cho web; `azp` nằm trong `AUTH0_ALLOWED_CLIENT_IDS` của Studio và ag-go; cho phép origin của web |
| **Account API** | Quyền admin, tên/email người dùng | `ACCOUNT_API_KEY`; không với tới thì không ai là admin, còn lại vẫn chạy |
| **ag-go-api** | Footage đã quét, URL ký tới file gốc/proxy | Service key scope `footage:read,footage:resolve`; origin của web trong `CORS_EXTRA_ORIGINS` |
| **ag-farm** + **ag-render-worker** | Render preview/final, xuất Premiere | Owner `studio` (xem dưới) |
| **R2** | Input/output render, thumbnail, export, payload nhật ký LLM | Bucket và khoá ghi |
| **YouTube Data API** | Nghiên cứu thị trường (tuỳ chọn) | `YOUTUBE_API_KEY` |
| **Canva** | Sửa thumbnail (tuỳ chọn) | App Canva Connect, `CANVA_*` |

Tên mọi biến môi trường: `.env.example`. Không commit `.env`.

### Đăng ký owner `studio` trên ag-farm

Trên ag-farm-web (vai ADMIN), tạo owner:
- **ID:** `studio`
- **sign_url:** `https://<studio-api-host>/api/farm/sign`
- **Loại job:** `studio.render_preview`, `studio.render_final`, `studio.export_premiere` (`studio.tts` chỉ còn cho
  luồng cũ)
- **Lane mặc định:** `interactive`

Rồi đặt khoá owner (`FARM_OWNER_KEY`) và khoá công khai Ed25519 (`FARM_TICKET_PUBLIC_KEY`) vào `.env`.

## Triển khai

`docker-compose.yml` (api → worker → web, cổng `STUDIO_PORT`, mặc định 3100) và `deploy.sh`; CI và deploy ở
`.github/workflows/` (`ci.yml`, `deploy.dev.yml` cho nhánh `dev`, `deploy.prod.yml` cho `main`, chạy tay).

## Nguồn gốc

Fork từ `E:\CODE\ag-harness-agent\YOUTUBE_OPERATIONS_HARNESS` (tag `harness-baseline`). Phần harness còn giữ và phần
đã gỡ: ADR-0001 mục 127; `AGENTS.md` mục "Pipeline media của harness".
