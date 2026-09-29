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

## Liên kết

- Kế hoạch triển khai: `C:\Users\AG-89\.claude\plans\ok-h-y-c-p-nh-t-shimmying-starfish.md`
- ag-farm: `E:\CODE\ag-farm`
- Harness gốc (nguồn): `E:\CODE\ag-harness-agent\YOUTUBE_OPERATIONS_HARNESS` (tag `harness-baseline`)
