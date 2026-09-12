# AGENTS.md — nguyên tắc cho mọi agent làm việc trong repo này

## Repo này là gì
YouTube Operations Harness: control plane điều phối sản xuất và phân phối video nhiều kênh. Session/agent là **worker tạm thời**; **state store là nguồn sự thật**. Đọc `docs/superpowers/specs/` trước khi đổi kiến trúc.

## Cách tìm việc
- Việc vận hành nằm trong state store của một operations project: `harness --project <dir> status <run_id>` hoặc `harness worker --once`.
- Việc phát triển: `docs/superpowers/plans/*.md`, làm theo từng task, mỗi task một commit.

## Lệnh chuẩn
- Cài: `corepack enable && pnpm install`
- Test: `pnpm test` (toàn bộ), `pnpm vitest run packages/<pkg>` (một package)
- Typecheck: `pnpm -r typecheck` · Build: `pnpm build` · Sinh JSON Schema: `pnpm gen:schemas`
- CLI dev: `pnpm harness --project fixtures/ops-project-minimal <command>`
- `pnpm typecheck` cần chạy sau `pnpm build`: typecheck từng package dùng `tsc --noEmit` và cần `dist/*.d.ts` của các package phụ thuộc; test (`vitest`) thì không cần build vì `vitest.shared.ts` ở root đã cấu hình alias `@harness/*` trỏ thẳng vào `src`.
- `node:sqlite` in ra `ExperimentalWarning` trên Node 22 — đây là bình thường, không phải lỗi; có thể tắt bằng `NODE_OPTIONS=--no-warnings` khi chạy test nếu muốn output sạch.

## Giới hạn quyền
- Không sửa cột `state` ngoài `transition()` và `claim()` trong `packages/core/src/state/`.
- Không import `adapters/*` hay `agent-runtime/*` từ `packages/core`.
- Không ghi giá trị secret vào file, event, log, manifest; chỉ dùng `secret://scope/name`.
- Không gọi mạng hay LLM trong test.
- Không upload/publish thật khi chưa có adapter YouTube ở sub-project 3; mọi thứ hiện là adapter giả.

## Quy tắc artifact
- Worker ghi vào `workspaces/<run>/<stage>/<attempt>/output/`. Controller mới chuyển vào `artifacts/` và đánh dấu ACCEPTED.
- Downstream chỉ đọc artifact ACCEPTED (`acceptedInputsFor`).
- Mọi artifact có `manifest.json` cạnh file, checksum sha256, lineage.

## Cách commit state
- Mọi kết quả stage đi qua `Controller.commit()` với fencing token của attempt hiện tại.
- Kết quả không rõ (mất kết nối sau dispatch) → `NEEDS_RECONCILIATION`; chạy `harness reconcile <run_id>` trước khi retry.

## Định nghĩa hoàn thành cho một task phát triển
1. Test viết trước, fail, rồi pass. 2. `pnpm -r typecheck` sạch. 3. Commit theo Conventional Commits. 4. Không để lại TODO/placeholder.
