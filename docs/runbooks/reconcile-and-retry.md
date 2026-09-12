# Runbook: reconcile, retry, lease

## Stage ở NEEDS_RECONCILIATION
1. `harness status <run_id>` để xem stage và external operation.
2. `harness reconcile <run_id>`: hỏi provider theo idempotency key. CONFIRMED → stage về READY, worker sẽ tái sử dụng operation đã confirm, không dispatch lại. FAILED → stage vẫn cần người xem xét; sau đó `harness retry <run_id> --stage <key>`.
3. Không bao giờ `retry` trước khi `reconcile`.

## Stage ở WAITING_HUMAN
Nguyên nhân: kết quả sai schema, checker thiếu, hoặc fencing bị từ chối. Xem `harness events tail --run <run_id>`, sửa nguyên nhân (workflow, checker, script), rồi `harness retry <run_id> --stage <key>`.

## Worker chết giữa chừng
Không cần làm gì: lease hết sau `lease_seconds` (mặc định 90s), worker kế tiếp gọi `reapExpiredLeases` rồi claim lại. Ép ngay: `harness leases reap`.

## Run FAILED
Run FAILED là terminal. Tạo run mới bằng `harness plan`; lineage vẫn truy vết được qua state store.

## Dọn workspace
`harness workspaces prune [--days N]` xóa workspace attempt cũ hơn retention và không còn lease.
