# YouTube Operations Harness

Control plane cho sản xuất và phân phối video nhiều kênh: state store SQLite, state machine Run/StageRun/Attempt, claim/lease/fencing, artifact manifest, worker, CLI.

## Bắt đầu

```bash
corepack enable && pnpm install
pnpm build && pnpm test
pnpm harness --project fixtures/ops-project-minimal db migrate

# đăng ký một nguồn, tạo content, plan một variant theo profile + option
pnpm harness --project fixtures/ops-project-minimal source ingest README.md
pnpm harness --project fixtures/ops-project-minimal content create --title "Demo" --source <source_id>
pnpm harness --project fixtures/ops-project-minimal plan --workflow sample-three-stage@1.0.0 --profile cartoon --content <content_id>

pnpm harness --project fixtures/ops-project-minimal enqueue <run_id>
pnpm harness --project fixtures/ops-project-minimal worker --once
pnpm harness --project fixtures/ops-project-minimal status <run_id>

# tình trạng tài nguyên chia sẻ và dọn artifact mồ côi
pnpm harness --project fixtures/ops-project-minimal resources status
pnpm harness --project fixtures/ops-project-minimal artifacts sweep --dry-run
```

Plan cũng chạy được không cần catalog (`plan --workflow ... --profile ...` không có `--content`), như ở sub-project 1; `--option k=v` chỉ hợp lệ khi có `--content`.

## Tài liệu
- Blueprint: `docs/architecture/YOUTUBE_OPERATIONS_HARNESS_BLUEPRINT_v1.0.md`
- Spec: `docs/superpowers/specs/2026-09-11-harness-structure-and-control-plane-design.md`, `docs/superpowers/specs/2026-09-12-sub-project-2-footage-production-design.md`
- Plan sub-project 1: `docs/superpowers/plans/2026-09-11-control-plane-minimal.md`
- Plan sub-project 2A: `docs/superpowers/plans/2026-09-12-sub-project-2a-catalog-planner-resources.md`
- ADR: `docs/adr/`
- Runbook: `docs/runbooks/`

## Trạng thái
Sub-project 1 (control plane) + 2A (source catalog, content/variant, plan theo option, tài nguyên chia sẻ trong claim, artifact thư mục, invalidation, cache) — adapter vẫn giả. Chưa nối script sản xuất thật (script executor chưa có giao thức external operation), chưa có gate executor/`stage submit`, chưa nối YouTube.
