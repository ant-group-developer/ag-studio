# ag-studio

Công cụ dựng video nội bộ của nhóm, fork từ **YouTube Operations Harness** (ADR-0001 mục 127). Mỗi *dự án* là một
kênh YouTube: người dùng chat tự do với agent (Claude Code làm việc trong thư mục dự án như một repo) để nghiên cứu, lên
chiến lược, branding, rồi làm từng *video* từ footage trên **ag-go** — chọn cảnh, kế hoạch dựng, timeline, render qua
**ag-farm**, thumbnail, gói YouTube, xuất project Premiere. Kết quả là file sửa được; việc nặng hiện ai làm, bao lâu,
dừng được.

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
| Làm một dự án tới bản cuối, xử lý lỗi | `docs/runbooks/studio-project.md` |
| Quy tắc cho agent làm việc trong repo | `AGENTS.md` |
| Vì sao thiết kế như vậy | `docs/adr/0001-control-plane-baseline.md` (mục 127 trở đi cho Studio) |
| Hợp đồng API giữa web, api và agent | `docs/studio-api-v4.md` |
| Skill của agent | `agent-skills/README.md` |
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
| `apps/api` | `@ag-studio/api` | NestJS: Auth0, teams/vai, dự án, video, tệp, luồng chat, đầu vào, nghiên cứu, thẻ xác nhận, tool của agent, `/farm/sign` |
| `apps/web` | `@ag-studio/web` | React + Ant Design: dự án, chat với agent, tệp, đầu vào, nghiên cứu, xem trước, Hàng đợi |
| `apps/worker` | `@ag-studio/worker` | Lượt agent (`claude -p` stream-json), job của dự án (ffmpeg, farm, crawl), quét dọn |
| `packages/studio-engine` | `@ag-studio/engine` | Workspace dự án, agent runner và tool, playbook, job runner, chuẩn bị media, render, crawl YouTube |
| `packages/studio-mcp` | | Server MCP stdio: tool Studio của agent → `/api/agent-tools` |
| `packages/ag-go-client` | `@ag-studio/ag-go-client` | Client footage của ag-go (service key + act-as) |
| `packages/render` | `@ag-studio/render` | Re-export `renderComposition` cho ag-render-worker |
| `packages/contracts` | `@harness/contracts` | Zod schema; tài liệu Studio ở `src/studio.ts` |
| `packages/core` | `@harness/core` | Control plane harness (state machine, planner, controller, artifact) + `src/studio/*` + pipeline media |
| `packages/executors` | `@harness/executors` | Executor script/agent/gate/**farm** của harness |
| `packages/adapters/agent-cli` | `@harness/adapter-agent-cli` | Gọi `claude -p` (stream-json cho agent Studio; file/structured cho harness) |
| `packages/cli`, `packages/worker` | `@harness/cli`, `@harness/worker` | CLI `harness` và vòng worker của harness |
| `agent-skills/` | | Skill của agent Studio |
| `workflows/`, `skills/`, `production-profiles/` | | Workflow, skill, profile của harness CLI |
| `migrations/` | | SQL `0001`–`0007` (harness), `0008`–`0029` (Studio cũ), `0030`–`0035` (dự án, agent); API tự migrate khi khởi động |

## Phụ thuộc ngoài

| Dịch vụ | Vai trò | Cần đăng ký |
|---|---|---|
| **Auth0** | Đăng nhập (JWT) | Client SPA cho web; `azp` nằm trong `AUTH0_ALLOWED_CLIENT_IDS` của Studio và ag-go; cho phép origin của web |
| **Account API** | Quyền admin, tên/email người dùng | `ACCOUNT_API_KEY`; không với tới thì không ai là admin, còn lại vẫn chạy |
| **ag-go-api** | Footage đã quét, URL ký tới file gốc/proxy | Service key scope `footage:read,footage:resolve`; origin của web trong `CORS_EXTRA_ORIGINS` |
| **ag-farm** + **ag-render-worker** | Render preview/final, xuất Premiere | Owner `studio` (xem dưới) |
| **R2** | Input/output render, thumbnail, export, audio dự án, payload nhật ký LLM | Bucket và khoá ghi |
| **YouTube Data API** | Crawl xu hướng, kênh top (tuỳ chọn; không có thì yt-dlp) | `YOUTUBE_API_KEY` |

Tên mọi biến môi trường: `.env.example`. Không commit `.env`.

### Đăng ký owner `studio` trên ag-farm

Trên ag-farm-web (vai ADMIN), tạo owner:
- **ID:** `studio`
- **sign_url:** `https://<studio-api-host>/api/farm/sign`
- **Loại job:** `studio.render_preview`, `studio.render_final`, `studio.export_premiere`, `studio.tts`,
  `studio.transcribe`
- **Lane mặc định:** `interactive`

Rồi đặt khoá owner (`FARM_OWNER_KEY`) và khoá công khai Ed25519 (`FARM_TICKET_PUBLIC_KEY`) vào `.env`.

## Triển khai

`docker-compose.yml` (api → worker → web, cổng `STUDIO_PORT`, mặc định 3100) và `deploy.sh`; CI và deploy ở
`.github/workflows/` (`ci.yml`, `deploy.dev.yml` cho nhánh `dev`, `deploy.prod.yml` cho `main`, chạy tay).

## Nguồn gốc

Fork từ `E:\CODE\ag-harness-agent\YOUTUBE_OPERATIONS_HARNESS` (tag `harness-baseline`). Phần harness còn giữ và phần
đã gỡ: ADR-0001 mục 127; `AGENTS.md` mục "Pipeline media của harness".
