# Plan: AG Studio làm việc như Claude Code trong một dự án (2026-10-10)

Nhánh: `feat/agent-workspace` (từ `dev-duc`). Spec: `docs/superpowers/specs/2026-10-10-ag-studio-agent-workspace-design.md`.
Mỗi task một commit (Conventional Commits), test viết trước. Số dành riêng: ADR-0001 mục `179`–`195`, migration
`0030`–`0036`. Không push, không đổi hợp đồng ag-farm; đổi ag-go chỉ ở nhánh riêng và hỏi trước khi push.

**Xong khi:** người dùng tạo dự án cho một kênh, chọn project ag-go, chat với agent qua research → channel → branding,
tạo video mới (luồng mới, tuỳ chọn học từ chat cũ), chuẩn bị đầu vào, chọn cảnh, kế hoạch dựng, timeline, xem trước
(nguồn 480p sạch khi ag-go đã sửa), bấm xác nhận render bản cuối; mọi việc nặng hiện ai xử lý, đã trôi, còn ≈, Dừng
được; giao diện và code pipeline cũ đã gỡ; `pnpm test`, `corepack pnpm -r run build`, `pnpm -r typecheck` sạch.

## P0 — Spike CLI, spec, ADR

- [x] Spike Claude Code 2.1.285 (spec mục 9), mẫu `fixtures/agent-stream/*.jsonl`.
- [x] Spec.
- [x] ADR-0001 mục 179–190.
- Probe thật (`packages/adapters/agent-cli/test/real-agent-cli.test.ts`, `HARNESS_REAL_CLAUDE_TEST=1`) viết ở P2 trên
  `AgentSessionRuntime` thật, mã hoá checklist spike.

## P1 — Dữ liệu, workspace, file, khung web mới

1. `feat(db): projects, sources, videos, video revisions, file versions` — `migrations/0030_projects.sql`.
2. `feat(engine): project and video store` — `packages/studio-engine/src/workspace/project-db.ts` (`saveVideoRevision`
   theo `saveEpisodeRevision`).
3. `feat(engine): workspace folders and safe file IO` — `workspace/{paths,files,templates}.ts`: chặn đường tuyệt đối,
   `..`, symlink, cỡ; đường bảo vệ; seed mẫu; phiên bản; `scanWorkspace()`.
4. `feat(api): roles guard reads project/video/thread`.
5. `feat(contracts): workspace DTOs` + `pnpm gen:schemas`.
6. `feat(api): projects, videos, files endpoints` — `apps/api/src/workspace/*`.
7. `feat(web): new shell, projects grid, project page, files tab`.

## P2 — Chat agent

1. `feat(agent-cli): stream-json parser` (test trên `fixtures/agent-stream`).
2. `feat(agent-cli): kill a process tree`.
3. `feat(agent-cli): AgentSessionRuntime` + probe thật.
4. `feat(db): agent threads, thread refs, messages` — `0031`.
5. `feat(engine): agent turn tokens`.
6. `feat(mcp): stdio Studio MCP server` — `packages/studio-mcp`.
7. `feat(api): agent-tools endpoints and guard`.
8. `feat(engine): agent runner` (slot, plugin dir, settings, system prompt, `<studio_context>`, history export, recap,
   rate limit, cancel, `llm_calls`).
9. `feat(api): thread endpoints, SSE deltas, activity`.
10. `feat(web): agent chat, activity drawer, thread list, new video/chat modal`.
11. `test: fake agent CLI` — `fixtures/fake-studio-agent.mjs`.

## P3 — Playbook, kiểm file, skills, bài học

1. `feat(contracts): playbook and frontmatter schemas`.
2. `feat(engine): default playbook and status` + `0032_step_marks.sql`.
3. `feat(engine): file validators`.
4. `feat(engine): project skill plugin` — `agent-skills/<slug>/SKILL.md` + team + project → plugin dir.
5. `feat(agent): playbook in context, post-turn validation, auto-fix`.
6. `feat(engine): thread summaries and lessons`.
7. `feat(api): playbook endpoints`; `feat(web): step rail, next-step chips, file issues, history`.

## P4 — Đầu vào

1. `feat(db): project jobs and farm jobs` — `0033`.
2. `feat(ag-go-client): footage search by project ids`.
3. `feat(api): sources and uploads`.
4. `refactor(engine): lift shot-cut media steps into plain functions` — `workspace/prepare.ts`, `video-index.ts`.
5. `feat(engine): project job runner, progress, ETA, cancel`.
6. `feat(mcp): inputs and job tools`; `feat(web): Inputs tab, ag-go pickers, job cards`.

## P5 — Nghiên cứu

1. `feat(engine): YouTube trending, topic, top channels, channel top videos` (+ yt-dlp dự phòng).
2. `feat(engine): research job` → `research/*.{md,json}`.
3. `feat(mcp): research tools`; `feat(web): Research tab`.

## P6 — Làm video

1. `feat(engine): timeline from edit plan` — `workspace/fit.ts`.
2. `feat(mcp): timeline tools`.
3. `feat(engine): video renders and thumbnails` — `workspace/renders.ts`.
4. `feat(api): sign project farm jobs`.
5. `feat(db): agent actions` — `0034`; `propose_action`, xác nhận/từ chối.
6. `feat(web): video page, action cards, editor adapter`.
7. `feat(engine): style reference measurement` (sau thẻ `reference_download`).

## P7 — Nguồn 480p sạch

1. `feat: ask ag-go for 480p clean sources on previews` (Studio).
2. ag-go-v2 `feat/resolve-prefer` (hỏi trước khi push; profile render là việc vận hành).

## P8 — Gỡ hệ thống cũ, tài liệu

1. `refactor!: remove series workflows and gates` (engine).
2. `refactor!(api): remove production and episode controllers, Canva`.
3. `refactor!(web): remove old pages and modules`.
4. `docs:` AGENTS.md, runbook, `docs/studio-api-v4.md`, `agent-skills/README.md`, `deferred-items.md`, `.env.example`,
   Dockerfile/compose.
