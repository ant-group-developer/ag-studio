# Runbook: nối một kênh thật vào harness

Đích: một ops project chạy `workflows/footage-production` (hoặc workflow khác) trên harness, còn việc sản
xuất thật vẫn do các script `.mjs` cũ của kênh đó đảm nhiệm — harness chỉ gọi chúng qua một wrapper mỏng
dùng `@harness/script-sdk`. Ví dụ minh hoạ cụ thể trong bài này là các wrapper giả ở
`fixtures/ops-project-footage/executors/wrappers/*.mjs`; kho script thật của một kênh (ví dụ nằm trên ổ đĩa
riêng của máy sản xuất) chỉ được nhắc tới như một khái niệm, không có đường dẫn hay tên kênh cụ thể — mỗi
máy tự biết kho của mình nằm đâu.

## 1. Copy `project-template/` thành một ops project

```sh
cp -r project-template/ /path/to/ops-project-<kênh>
cd /path/to/ops-project-<kênh>
```

Sửa `package.json`: đổi `name`, và sửa đường dẫn `link:` của dependency `@harness/script-sdk` cho khớp nơi
máy này checkout repo harness (package không publish lên registry công khai — `link:` trỏ thẳng vào
`packages/script-sdk` của repo, không copy, nên sửa `script-sdk` xong không cần `pnpm install` lại). Rồi:

```sh
pnpm install     # kéo @harness/script-sdk qua link:, dựng node_modules của ops project
```

Project này **không** nằm trong `pnpm-workspace.yaml` của repo harness (glob chỉ có `fixtures/*`, không có
`project-template` hay project vừa copy) — nó tự quản `pnpm install` của chính nó, độc lập với monorepo.

## 2. `project.yaml`

Sửa các trường theo máy đang chạy:
- `resources`: capacity thật của máy này (`cpu`, `gpu`, hoặc tên tài nguyên khác như slot của một license/API
  — ví dụ `heygen: 1` nếu máy chỉ được phép gọi HeyGen một phiên cùng lúc). `harness resources status` đọc
  từ đây; một stage khai `requires_resources` tên nào không có trong `project.yaml.resources` bị coi là
  capacity 0 (không bao giờ claim được).
- `source.materialize`: `link` (mặc định, hardlink — nhanh nhưng sửa file gốc sau ingest sẽ đổi cả bản đã
  ingest), `copy` (an toàn hơn, tốn dung lượng gấp đôi), hoặc `reference` (không nhân bản, chỉ trỏ URI — dùng
  khi nguồn nằm trên một ổ mạng không nên copy).
- `data_root`: nơi state store (`data/state/harness.db`), artifact và source normalize của project này sống;
  mặc định `./data` — đổi nếu máy có ổ riêng cho dữ liệu sản xuất.

## 3. `source-catalog/sources.yaml`

Liệt kê các file nguồn thật (footage, ảnh, audio…) mà kênh có sẵn, mỗi dòng một `path` tương đối tới project
dir (xem `project-template/source-catalog/sources.yaml` — mặc định `sources: []`, rỗng):

```yaml
schema_version: harness.sources/v1
sources:
  - { path: raw/ep12-a-roll.mp4, collection: main, rights_status: cleared, language: vi }
```

Rồi đồng bộ vào catalog:

```sh
harness --project /path/to/ops-project-<kênh> source sync
```

`sync` ingest mọi entry chưa có trong DB (dedupe theo sha256, giống `source ingest`), báo `missing_files`
(entry trỏ vào file không còn tồn tại) và `unregistered` (source đã có trong DB nhưng không entry nào trong
`sources.yaml` khớp checksum của nó — không tự xoá gì, chỉ báo).

## 4. Một wrapper cho mỗi stage script

Mỗi stage `executor: { type: script, script: <tên> }` trong workflow cần một dòng trong
`executors/scripts.yaml` (argv trỏ `executors/wrappers/<tên>.mjs`) và một file wrapper thật ở đường dẫn đó.
Bắt đầu từ `executors/wrappers/example.mjs` của template, hoặc đọc các wrapper thật trong
`fixtures/ops-project-footage/executors/wrappers/` (`index-source.mjs`, `avatar.mjs`, `cut.mjs`, …) làm mẫu.
Khuôn chung của một wrapper:

1. `const ctx = await start();` — đọc `stage-request.json` từ `HARNESS_WORKSPACE`.
2. Lấy input qua `ctx.input("<type>")` (đường dẫn tuyệt đối trong workspace) hoặc `ctx.source(i)` (source
   item của content, có `uri`/`checksum`/`duration_seconds`).
3. Gọi script cũ của kênh bằng `spawnSync`, đường dẫn tới script đó là **riêng của máy** — đặt nó trong biến
   môi trường (ví dụ `LEGACY_SCRIPT_PATH`, set trong shell hoặc `.env` của máy, không commit) hoặc trong
   `cwd` của entry `scripts.yaml` nếu script cũ mong đợi chạy từ chính kho của kênh.
4. Copy/ghi kết quả script cũ vào `output/` trong workspace (hoặc để script cũ ghi thẳng vào đó nếu sửa
   được đường dẫn output của nó).
5. `await ctx.out.file("output/<tên>", { type: "<type>" })` (hoặc `ctx.out.dir` cho output kiểu `directory`)
   cho từng file khai trong `outputs` của stage definition, rồi `await ctx.done({ cost_usd })`.
6. Script cũ thoát khác 0, hoặc lỗi rõ ràng khác: `await ctx.fail("transient", "...", { ... })` rồi
   `process.exit(0)` — **không** để process thoát khác 0 mà chưa ghi `stage-result.json`, vì executor sẽ
   coi đó là crash (transient) thay vì lỗi có ngữ cảnh.

`harness doctor` (bước 7) kiểm tra file wrapper ở `argv[1]` có tồn tại không, nên tạo xong wrapper trước khi
chạy doctor.

## 5. Secret

Không đặt API key/token trực tiếp trong `scripts.yaml` hay wrapper. Khai `env_refs` trong entry
`scripts.yaml` của script cần nó:

```yaml
avatar: { argv: [...], env_refs: { HEYGEN_API_KEY: "secret://heygen/main" } }
```

rồi set biến môi trường tương ứng — `secret://heygen/main` map sang `HARNESS_SECRET_HEYGEN_MAIN` — trong
shell chạy `harness worker` (hoặc trong một file `.env` của máy đó mà shell load trước khi chạy worker).
Không commit giá trị secret vào git. Harness resolve `env_refs` thành biến môi trường của **process con**
(script cũ) mà thôi; giá trị không bao giờ được ghi vào `stage-request.json`, event, hay log —
`Redactor` che mọi giá trị đã resolve xuất hiện trong dòng log, kể cả khi script cũ tự `console.log` nó ra
(xem acceptance #16).

## 6. External effect có phí (gọi API bên ngoài, tính tiền theo lần gọi)

Nếu script cũ gọi một provider bên ngoài (render giọng nói, dựng avatar, upload video…) mà gọi lại khi retry
sẽ tốn tiền hoặc tạo bản trùng, bọc nó bằng vòng đời `ctx.op.*`:

```js
const intent = await ctx.op.intent({ provider: "heygen", kind: "render", target: ctx.request.stage_run_id, payload: { /* khoá idempotency ổn định qua các lần attempt, ví dụ checksum input chứ không phải path */ } });
if (intent.status === "CONFIRMED") { /* đã làm rồi ở một attempt trước, dùng lại kết quả, đừng gọi lại */ }
else {
  // gọi provider thật ở đây
  await ctx.op.confirm(intent.operation_id, { provider_ref: "...", receipt: { ... }, cost_usd: 0.5 });
}
```

Mất kết nối giữa chừng (không biết provider đã làm xong hay chưa): `await ctx.op.lost(intent.operation_id,
"...")` rồi kết thúc bằng `await ctx.unknown("...", [intent.operation_id])` — **không** `ctx.fail` (fail nói
"chắc chắn chưa xong", trong khi ở đây không biết). Stage đỗ ở `NEEDS_RECONCILIATION`; xem
`docs/runbooks/reconcile-and-retry.md` mục "Op từ wrapper" để xử lý tiếp.

## 7. `harness doctor` xanh

```sh
harness --project /path/to/ops-project-<kênh> doctor
```

Mọi dòng phải `ok`: migration đã áp, mỗi `scripts.<tên>` có wrapper tồn tại, mỗi secret trong `env_refs`
resolve được, mỗi `requires_resources` có capacity > 0 trong `project.yaml`, mỗi workflow/profile nạp được,
`source-catalog/sources.yaml` (nếu có) không thiếu file. `doctor` không gọi mạng và không sửa gì — chạy lại
bao nhiêu lần cũng an toàn.

## 8. Chạy thử một content

```sh
harness --project /path/to/ops-project-<kênh> source ingest raw/ep12-a-roll.mp4
harness --project /path/to/ops-project-<kênh> content create --title "Tập 12" --source <source_id>
harness --project /path/to/ops-project-<kênh> plan --workflow footage-production@1.0.0 --profile footage --content <content_id> --option voice=original
harness --project /path/to/ops-project-<kênh> enqueue <run_id>
harness --project /path/to/ops-project-<kênh> worker --once   # lặp lại tới khi in ra "idle"
```

`voice=original` bỏ qua cả stage `tts` lẫn `avatar` (workflow chỉ chạy chúng khi option tương ứng khớp),
nên attempt đầu tiên gọn nhất để thử đường ống. Các stage gate (`select-topic`, `write-script`, `edit-plan`,
`thumbnail-qc`) đỗ ở `WAITING_HUMAN`; workspace của attempt gate có sẵn `brief.md` — đề bài cho người (hoặc
một phiên Claude/Codex làm việc trực tiếp trong workspace đó) đọc rồi viết output theo yêu cầu. Xong một
gate:

```sh
harness --project /path/to/ops-project-<kênh> stage submit <stage_run_id>
```

`stage submit` verify `output/` giống hệt đường một worker sẽ đi rồi mới commit; thiếu file hay check nào
fail thì bị từ chối (không đổi trạng thái gì) và in ra chính xác thiếu gì/check nào fail. Lặp lại
`worker --once` sau mỗi lần submit tới khi run `SUCCEEDED`, rồi:

```sh
harness --project /path/to/ops-project-<kênh> status <run_id>
```

## 9. Sự cố thường gặp

| Triệu chứng | Lệnh chẩn đoán / xử lý |
| --- | --- |
| Stage `WAITING_HUMAN` mãi không có ai submit | `harness status <run_id>` xem còn gate nào chờ; `stage.gate_overdue` trong `events tail` nếu quá `gate_deadline_seconds`. Xem runbook reconcile mục "Gate quá hạn". |
| `stage submit` bị từ chối | Đọc `missing`/`failed` trong output — thiếu file `output/<name>` hay check nào fail; sửa rồi submit lại. Xem runbook reconcile mục "Submit bị từ chối". |
| Stage đỗ `NEEDS_RECONCILIATION` | Wrapper gọi `ctx.op.lost` (mất kết nối provider giữa chừng). `harness reconcile <run_id>`. Xem runbook reconcile mục "Op từ wrapper". |
| Run đỗ `WAITING`, stage kế tiếp `PENDING` không dispatch | Có thể do vượt ngân sách variant (`run.budget_usd`) — xem `events tail` tìm `run.budget_exceeded`, rồi `harness retry <run_id> --raise-budget <usd>`. Xem runbook reconcile mục "Vượt ngân sách". |
| Stage `READY` không được claim | Tài nguyên (`requires_resources`) đang hết slot — `harness resources status`; xem runbook reconcile mục "Stage chờ tài nguyên". |
| `doctor` báo `secret:<script>:<env>` FAIL | Biến `HARNESS_SECRET_<SCOPE>_<NAME>` chưa set trong shell/`.env` của máy đang chạy `doctor`/`worker`. |
| `doctor` báo `wrapper:<tên>` FAIL | `argv[1]` trong `scripts.yaml` không trỏ đúng file — kiểm tra `cwd` (mặc định `.` = project dir) cộng đường dẫn tương đối. |
| Script cũ crash (exit khác 0, không ghi `stage-result.json`) | Attempt fail "transient", tự retry theo backoff của stage. Sửa script cũ hoặc wrapper rồi để lần retry kế tiếp chạy, hoặc `harness retry <run_id> --stage <key>` để chạy lại ngay. |

Xem đầy đủ hơn ở `docs/runbooks/reconcile-and-retry.md` (gate quá hạn, submit bị từ chối, op từ wrapper, vượt
ngân sách, worker chết giữa chừng, hủy run, artifact STALE/tái sử dụng).
