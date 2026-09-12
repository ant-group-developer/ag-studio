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

## Hủy run
`harness cancel <run_id>`. Stage không do worker nào giữ bị `CANCELLED` ngay. Stage đang chạy (CLAIMED/RUNNING/VERIFYING) chuyển sang `CANCEL_REQUESTED`: worker đang giữ nó sẽ kết thúc attempt hiện tại rồi commit thành `CANCELLED` (kết quả bị bỏ, không có artifact, không cộng cost); nếu worker đã chết thì lease reaper hoàn tất việc hủy khi lease hết hạn. Run ở `CANCEL_REQUESTED` chuyển sang `CANCELLED` khi worker commit stage cuối cùng. Nếu stage cuối được lease reaper hoàn tất (worker đã chết), run vẫn ở `CANCEL_REQUESTED` cho tới khi chạy lại `harness cancel <run_id>` (lệnh này idempotent và sẽ chốt run). `harness status` chỉ đọc, không chốt. Run đã `CANCELLED` là terminal: muốn chạy lại thì `harness plan` một run mới.

## Dọn workspace
`harness workspaces prune [--days N]` xóa workspace attempt cũ hơn retention mà stage của nó đã terminal (SUCCEEDED/FAILED/CANCELLED) và không còn lease; thư mục không khớp attempt nào bị bỏ qua và đếm vào `skipped`. Thêm `--force` nếu muốn xóa cả những thư mục không có attempt row.
