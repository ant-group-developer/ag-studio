# ADR-0001: Baseline control plane

**Ngày:** 2026-09-11 · **Trạng thái:** Accepted

## Bối cảnh
Blueprint v1.0 định nghĩa harness đa kênh, đa profile, đa worker. Hệ thống cũ chạy bằng phiên Claude Code tương tác và script Node `.mjs` trên máy khác.

## Quyết định
1. Stack TypeScript/Node 22, pnpm monorepo, Zod, Vitest.
2. State store: SQLite WAL qua `node:sqlite` (có sẵn trong Node 22.13+, không cần build native), `busy_timeout` 5000ms; transaction lồng nhau dùng SAVEPOINT. `better-sqlite3` là phương án thay sau interface `StateStore`.
3. Mỗi entity một bảng document (`id`, `state`, `data` JSON) cộng bảng `lease`; index theo cột nghiệp vụ cần lọc.
4. Mọi đổi trạng thái đi qua `transition()` (kiểm bảng transition + ghi event, một transaction) hoặc `claim()`.
5. Fencing token tăng theo attempt của một stage; mọi commit kết quả kiểm token.
6. Agent runtime trung lập, chọn theo `project.yaml` (`claude` | `codex`).
7. Profile đặt tên theo phong cách sản xuất: `cartoon`, `avatar`, `footage`.
8. Mỗi máy một state store; không chia sẻ state giữa máy ở v1.
9. Bổ sung so với blueprint §9: `VERIFYING → WAITING_HUMAN` (lỗi hợp đồng), `VERIFYING → READY` (lease bị bỏ rơi trong lúc verify), `NEEDS_RECONCILIATION → READY` (reconcile xong thì attempt mới), `CLAIMED → READY|FAILED` (lease bị bỏ rơi hết hạn).
10. Test dùng `vitest.shared.ts` ở root, cấu hình plugin `node:sqlite` cho Vite và alias `@harness/*` → `src`; nhờ vậy chạy test không cần build `dist/`. Ngược lại typecheck từng package (`tsc --noEmit`) cần `dist/*.d.ts` của package phụ thuộc, nên `pnpm typecheck` phải chạy sau `pnpm build`.
11. Lệnh script (`__script`) resolve loader `tsx` bằng absolute `file://` URL trong `fakeScriptCommands()`, để worker chạy được từ workspace nằm ngoài repo (khác ổ đĩa, khác thư mục làm việc).
12. `ExecutorContext` mang theo `clock` của harness; mọi executor tính deadline dựa trên `clock` này, không dùng `Date.now()` trực tiếp, để test có thể giả lập thời gian.
13. External operation: cột `idempotency_key` KHÔNG unique trong SQL — một retry sau khi FAILED tạo dòng mới cùng key; dòng mới nhất là dòng hiện hành. Việc suy ra "hiện hành" là trách nhiệm của tầng đọc (`findExternalOperationByKey`, newest-wins), không phải ràng buộc DB.
14. `harness retry` từ chối run ở trạng thái terminal (FAILED/CANCELLED) trước khi ghi bất cứ gì — kiểm tra xảy ra trước mọi side effect.
15. Cancel hai nhịp: stage không do worker giữ (PENDING, READY, WAITING_HUMAN, WAITING_EXTERNAL, NEEDS_RECONCILIATION) đi thẳng `CANCELLED`; stage đang do worker giữ (CLAIMED, RUNNING, VERIFYING) đi qua `CANCEL_REQUESTED` và chỉ thành `CANCELLED` khi worker commit (không stage artifact, không cộng cost) hoặc khi lease reaper thu hồi lease. Run `CANCEL_REQUESTED` tự settle thành `CANCELLED` trong `advance()` ngay khi không còn stage nào nợ xác nhận.
16. `outcome: "deferred"` trong `StageResult` là cửa người duyệt, không phải lỗi: `FAILURE_KINDS` có thêm `deferred`, attempt FAILED với `failure_kind: "deferred"`, stage đỗ ở `WAITING_HUMAN`, không tăng `result_failures`, không retry, không tạo artifact REJECTED.

## Hệ quả
- Script cũ được bọc qua giao thức file `stage-request.json` / `stage-result.json` trong workspace (sub-project 2).
- Chuyển sang Postgres/object storage chỉ cần implementation mới của `StateStore` và `ArtifactRegistry`.
- Test acceptance cho rò rỉ secret (#11) chỉ chứng minh không rò rỉ theo cấu trúc code (không có đường dẫn nào ghi giá trị secret ra ngoài `secret://scope/name`); trường hợp end-to-end với agent runtime thật để lại cho sub-project 3.
