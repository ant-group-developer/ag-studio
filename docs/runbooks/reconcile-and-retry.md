# Runbook: reconcile, retry, lease

## Op từ wrapper (NEEDS_RECONCILIATION)
Nguyên nhân: wrapper gọi `ctx.op.lost(...)` (mất kết nối tới provider giữa chừng, không biết cuộc gọi đã
thành công hay chưa) rồi kết thúc bằng `ctx.unknown(...)`; controller đưa external operation về
`NEEDS_RECONCILIATION` và stage đi cùng nó.

1. `harness status <run_id>` để xem stage và external operation đang treo.
2. `harness reconcile <run_id>` (hoặc `harness reconcile <operation_id>` cho một operation cụ thể): hỏi
   provider theo `idempotency_key`. Provider tìm thấy → operation `CONFIRMED` (ghi lại `provider_ref`/
   `receipt`). Không tìm thấy → operation `FAILED`.
3. **Cả hai kết quả đều tự đưa stage từ `NEEDS_RECONCILIATION` về `READY`** ngay khi không còn operation nào
   khác của stage đó còn `NEEDS_RECONCILIATION` — `reconcile` tự gọi `planner.advance()`, không cần
   `harness retry` để "mở khoá" stage. Khác biệt duy nhất giữa hai kết quả nằm ở lần attempt kế tiếp:
   - **CONFIRMED**: wrapper gọi lại `ctx.op.intent(...)` với cùng payload (cùng idempotency key) sẽ nhận lại
     chính operation đã `CONFIRMED` đó (`findConfirmedByKey`) — không gọi lại provider, không tốn tiền lần
     hai.
   - **FAILED**: idempotency key giữ nguyên, nhưng lần `ctx.op.intent(...)` kế tiếp ghi một dòng **mới**
     (một operation FAILED không được coi là "hiện hành" — dòng mới nhất mới là hiện hành), nên attempt kế
     tiếp gọi lại provider từ đầu.
4. Vẫn nên xem `harness events tail --run <run_id>` (`external_operation.reconciled`, `found: false`) trước
   khi để worker tự chạy tiếp một `FAILED` — đây là lúc hợp lý để phát hiện provider/script cũ có vấn đề
   thật sự, dù code không bắt buộc dừng lại chờ người.
5. Không bao giờ `harness retry` một stage đang `NEEDS_RECONCILIATION` trước khi `reconcile` nó — `retry`
   chỉ nhận stage `FAILED`/`WAITING_HUMAN`.

## Gate quá hạn
Nguyên nhân: một stage gate (`executor.type: "gate"`) đỗ ở `WAITING_HUMAN` quá `gate_deadline_seconds` khai
trên stage definition (workflow `footage-production` đặt 86400s = 24h cho mọi gate của nó) mà chưa ai
`stage submit`.

1. Event `stage.gate_overdue` (payload `overdue_seconds`, `deadline_seconds`) được ghi tối đa một lần mỗi
   `resource_wait_warn_seconds` (mặc định 600s) cho cùng một stage — do worker tự kiểm tra ở mỗi vòng poll
   rảnh, và cũng do `harness status <run_id>` tính lại mỗi lần gọi (đánh dấu `OVERDUE` cạnh stage đó trong
   output dạng text lẫn JSON) — không cần worker đang chạy để thấy dấu quá hạn.
2. Quá hạn không tự làm gì khác — stage vẫn `WAITING_HUMAN`, không tự fail, không tự hủy. Xử lý: đọc
   `brief.md` trong workspace của attempt gate đó (đường dẫn từ `harness status <run_id> --json` →
   `stages[].attempts[-1].workspace_uri`), viết output theo yêu cầu, rồi `harness stage submit
   <stage_run_id>`.
3. Nếu deadline quá hạn vì gate không còn cần thiết (đổi hướng sản xuất): `harness cancel <run_id>` thay vì
   cố submit cho xong.

## Submit bị từ chối
`harness stage submit <stage_run_id>` verify `output/` trước khi đổi bất kỳ trạng thái nào — bị từ chối thì
stage vẫn nguyên `WAITING_HUMAN`, không mất gì để thử lại.

1. Output có `missing` (thiếu file) hoặc `failed` (check không đạt) trong response — cả CLI text lẫn `--json`
   đều in đủ hai danh sách này; exit code 1 khi có ít nhất một trong hai.
2. `missing`: thiếu file `output/<name>` mà stage definition khai trong `outputs[].name` — ghi/copy file còn
   thiếu vào `output/` rồi submit lại.
3. `failed`: một required check (`schema-valid`, `checksum-match`, `edl-valid`, …) không đạt — evidence đi
   kèm nói rõ lý do (ví dụ `edl-valid` báo `source_id` không có trong `stage-request.json`, hay
   `clip-set-complete` báo thiếu một file `NNN.mp4`). Sửa nội dung `output/` theo evidence rồi submit lại;
   `--from <dir>` copy đè một thư mục khác vào `output/` trước khi verify nếu tiện hơn sửa tay.
4. Submit rejected ghi event `stage.submit_rejected` (payload `missing`, `failed`) — xem lại bằng
   `harness events tail --run <run_id>` nếu không còn ở terminal đã chạy submit.

## Vượt ngân sách
Nguyên nhân: `run.budget_usd` (đặt lúc `plan` hoặc tính từ `limits.max_cost_usd_per_variant` của profile) đã
bị tổng chi phí của **variant** đó (cộng dồn `total_cost_usd` mọi run của variant, không chỉ run hiện tại)
chạm hoặc vượt qua, trước khi một stage kịp dispatch.

1. Run đỗ `WAITING`, stage kế tiếp `PENDING` (chưa từng `READY`) — event `run.budget_exceeded` (payload
   `spent`, `budget`) ghi trên run ngay khi `advance()`/`enqueue()` phát hiện. `harness status <run_id>` chỉ
   thấy run `WAITING` và stage `PENDING`, không có gì nói rõ lý do là ngân sách — phải đọc `events tail`.
2. Không có "waive" từng phần — chỉ có nâng trần: `harness retry <run_id> --raise-budget <usd>` (usd phải
   lớn hơn số đã chi của variant, không thì lệnh từ chối) ghi `run.budget_raised` rồi tự gọi lại
   `planner.advance()`, không cần thêm lệnh nào khác để giải phóng stage đang chờ.
3. Ngân sách chặn ở **hai** chỗ khác nhau, không đối xứng: reuse **lúc `plan`** (planner chọn sẵn artifact
   cũ khi tạo `StageRun`, trước khi `enqueue`) hoàn toàn không nhìn tới ngân sách — một run mới của cùng
   variant vẫn tái sử dụng toàn bộ stage đã tốn tiền ở run trước dù ngân sách hiện đã hết, vì reuse không
   phát sinh chi phí mới. Nhưng reuse **lúc release** (`tryLateReuse` — một stage `PENDING` dưới một gate,
   dependency vừa `SUCCEEDED`, tính lại cache key từ input ACCEPTED thật) nằm trong cùng vòng lặp với dispatch
   thường (`releaseReady`) và **bị chặn giống hệt dispatch**: khi `budgetBlocks` báo `blocked: true`, vòng
   lặp đó return ngay, kể cả một stage lẽ ra tái sử dụng được (miễn phí) cũng phải chờ `--raise-budget` mới
   được xét lại — dù bản thân việc tái sử dụng nó không tốn thêm tiền.

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
