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
`harness cancel <run_id>`. Stage không do worker nào giữ bị `CANCELLED` ngay. Stage đang chạy (CLAIMED/RUNNING/VERIFYING) chuyển sang `CANCEL_REQUESTED`: worker đang giữ nó sẽ kết thúc attempt hiện tại rồi commit thành `CANCELLED` (kết quả bị bỏ, không có artifact, không cộng cost); nếu worker đã chết thì lease reaper hoàn tất việc hủy khi lease hết hạn. Run ở `CANCEL_REQUESTED` chuyển sang `CANCELLED` khi worker commit stage cuối cùng. Nếu stage cuối được lease reaper hoàn tất (worker đã chết), mỗi lần `runOnce` của worker (poll thường hoặc `--once`) đều tự gọi `reapExpiredLeases` rồi `planner.advance` trên các run vừa reap — nên run tự chốt thành `CANCELLED` ở lượt worker kế tiếp mà không cần thao tác thêm. Nếu không có worker nào đang chạy, `harness cancel <run_id>` (idempotent) chốt ngay; riêng `harness leases reap` chỉ thu hồi lease, **không** gọi `planner.advance`, nên tự nó không chốt run. `harness status` chỉ đọc, không chốt. Run đã `CANCELLED` là terminal: muốn chạy lại thì `harness plan` một run mới.

## Dọn workspace
`harness workspaces prune [--days N]` xóa workspace attempt cũ hơn retention mà stage của nó đã terminal (SUCCEEDED/FAILED/CANCELLED) và không còn lease; thư mục không khớp attempt nào bị bỏ qua và đếm vào `skipped`. Thêm `--force` nếu muốn xóa cả những thư mục không có attempt row.

## Stage chờ tài nguyên
Nguyên nhân: stage READY khai `requires_resources` nhưng mọi slot của tài nguyên đó đang bị lease khác giữ, hoặc tên tài nguyên không có trong `project.yaml.resources` (coi như capacity 0).
1. `harness resources status [--json]`: liệt kê từng tài nguyên khai trong `project.yaml.resources` (cộng cả tên đang bị giữ nhưng không khai) với `capacity`, `held` (đếm qua lease đang hiệu lực), `free`.
2. `harness status <run_id>`: stage bị chặn vẫn hiện ở `READY`, không có lease — khác với stage đang chờ dependency (vẫn ở `PENDING`). Không có lệnh CLI liệt kê trực tiếp "stage nào đang chờ tài nguyên"; đọc `requires_resources` của stage đó trong output `status --json` rồi so với `resources status`.
3. Nếu một stage ở `READY` quá `resource_wait_warn_seconds` (mặc định 600s) mà vẫn chưa được claim, worker ghi event `stage.waiting_resource` (payload có `resources` — danh sách tài nguyên đang thiếu slot, và `waiting_since`). Xem `harness events tail --run <run_id>` để xác nhận đây là do tài nguyên chứ không phải worker hết capability/deadline.
4. Xử lý: chờ lease đang giữ tài nguyên đó hết hạn hoặc stage giữ nó commit xong (tự giải phóng); hoặc tăng `resources.<tên>` trong `project.yaml` nếu máy thật sự có thêm slot; hoặc `harness cancel` một run khác đang giữ tài nguyên nếu nó không còn cần thiết. Không có lệnh "ưu tiên" — tài nguyên cấp theo thứ tự `claim()` quét thấy stage READY, không theo hàng đợi công bằng.

## Artifact STALE / tái sử dụng
**STALE (invalidation).** Khi một stage của run mới commit một artifact ACCEPTED, mọi artifact ACCEPTED của chính stage đó và các stage phụ thuộc nó (transitive, kể cả `depends_on_optional`) ở **run khác trước đó của cùng variant** tự động chuyển sang `STALE` — không cần thao tác gì. Đây là hành vi đúng: artifact STALE không còn được downstream đọc (`acceptedInputsFor` chỉ lấy ACCEPTED), và không có "un-stale" — một artifact đã STALE thì STALE vĩnh viễn; muốn có artifact mới cho variant đó thì `harness plan` một run mới (reuse sẽ nhặt lại những gì còn ACCEPTED và chạy lại phần còn thiếu).
1. Xem run/stage nào vừa bị đánh STALE: `harness events tail --run <run_id_cũ>`, lọc `artifact.stale` (payload có `superseded_by_run`, `stage_key`) và `stage.invalidated_downstream` trên run vừa commit (payload `stale`: danh sách artifact_id).
2. `harness status <run_id_cũ>` hiện artifact với `status: STALE` thay vì `ACCEPTED`.
3. Không cần hành động khắc phục — đây không phải lỗi. **`harness retry` không hồi sinh một artifact STALE** (nó chỉ đẩy lại stage về READY trong run cũ, và mọi artifact STALE vẫn STALE). Cách đúng: `harness plan` một run mới cho variant đó — reuse sẽ nhặt lại những stage còn artifact ACCEPTED và chỉ chạy lại phần đã bị STALE.

**Tái sử dụng (cache).** Ngược lại, `plan()` một run mới có thể **tránh** phải chạy lại một stage nếu tìm thấy stage SUCCEEDED cùng `cache_key` (digest của stage definition + checksum input + options + effective config + executor version) ở một run trước đó của cùng variant còn artifact ACCEPTED — stage đó được tạo thẳng ở `SUCCEEDED` với `reused_artifact_ids`, không dispatch, kèm event `stage.reused`.
1. Xem stage nào được tái sử dụng: `harness status <run_id_mới> --json` — stage có `state: "SUCCEEDED"`, `attempts: []` (chưa từng chạy trong run này) và `reused_artifact_ids` khác rỗng; hoặc `events tail --run <run_id_mới>` tìm `stage.reused` (payload `artifacts`, `cache_key`).
2. Nếu **không** muốn tái sử dụng (ví dụ input trông giống nhưng thực chất cần chạy lại vì lý do ngoài cache key, như script bên ngoài đổi hành vi mà stage definition không đổi): `harness plan ... --no-reuse` cho một lần, đặt `reuse: never` trên profile cho mọi lần, hoặc sửa `stage.config`/`outputs` để đổi `stageDefinitionDigest` và phá cache key.
3. Cache chỉ so khớp trong phạm vi **cùng variant** (`content_id` + `profile_id` + `profile.revision` + options digest); đổi bất kỳ thành phần nào trong đó tạo variant mới, không còn gì để tái sử dụng cho lần plan đầu.
4. Executor `gate` không bao giờ được tái sử dụng — luôn tạo `StageRun` mới ở `PENDING`/`READY`, kể cả khi mọi dependency đều reuse.
