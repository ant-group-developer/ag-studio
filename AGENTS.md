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
- Sau khi sửa bất kỳ schema Zod nào trong `packages/contracts/src/` (entity, config, execution): chạy `pnpm gen:schemas` rồi commit các file JSON Schema sinh ra cùng lúc — `test/json-schema.test.ts` kiểm tra chúng khớp.

## Lệnh 2B (script, gate, media, doctor)
- `harness stage submit <stage_run_id> [--from <dir>] [--json]`: submit `output/` của một stage gate đang `WAITING_HUMAN` — verify theo `required_checks` của stage rồi commit đúng đường một worker đi (claim đích danh `stage_run_id` đó, attempt owner mặc định `cli-submit`); thiếu file hay check fail thì bị từ chối, **không đổi state**, in ra `missing`/`failed`; `--from <dir>` copy đè `dir` vào `output/` trước khi verify.
- `harness op intent|confirm|lost ...`: sổ external operation cho wrapper script (qua `ctx.op.*` của `@harness/script-sdk`), luôn cần `--attempt`/`--fencing-token` (hoặc chỉ `--fencing-token` cho `confirm`/`lost` theo `operation_id`) của attempt hiện tại — fencing sai bị từ chối ngay. `intent` trả lại operation `CONFIRMED` sẵn có nếu cùng idempotency key (`kind`+`target`+`payload`); một operation `FAILED` không được coi là hiện hành nên `intent` kế tiếp cùng key ghi dòng mới (gọi provider lại).
- `harness doctor [--json]`: kiểm project + harness install không đổi gì, không gọi mạng — migration đã áp, ffprobe có trên PATH hay không, mỗi stage script của mỗi workflow có entry trong `scripts.yaml` (hoặc là built-in fake) + wrapper file tồn tại + mỗi secret `env_refs` resolve được + mỗi `requires_resources` có capacity > 0, mỗi gate có output đặt `name`, mỗi profile nạp được workflow của nó + mọi `when` tham chiếu option đã khai trong `options_schema` + `options_defaults` hợp lệ, `source-catalog/sources.yaml` không thiếu file. Thiếu hẳn `executors/scripts.yaml` không phải lỗi — gộp thành một dòng `ok` duy nhất.
- `harness source sync [--json]`: đồng bộ `source-catalog/sources.yaml` vào DB catalog (ingest entry chưa có, dedupe theo sha256 như `source ingest`); báo `added`/`already`/`missing_files` (entry trỏ file đã mất)/`unregistered` (source đã có trong DB không entry nào khớp checksum) — thoát mã 1 nếu có `missing_files`.
- `harness retry <run_id> [--stage <key>] [--raise-budget <usd>]`: `--raise-budget` nâng `run.budget_usd` lên trên mức đã chi của variant đó rồi tự advance() — dùng riêng (không kèm `--stage`) khi chỉ cần mở ngân sách, không retry stage nào.

### Quy tắc wrapper / scripts.yaml / secret / gate
- Mỗi stage `executor: { type: script, script: <tên> }` cần một entry `<tên>` trong `executors/scripts.yaml` (khoá theo **tên script**, không theo `stage.key` — nhiều stage có thể dùng chung một script) trỏ `argv` tới một wrapper `.mjs` dùng `@harness/script-sdk`. Xem `docs/runbooks/wrap-a-channel.md` để nối một kênh thật.
- `scripts.yaml.<tên>.requires_resources` (nếu khai) **ghi đè hẳn** (không merge) `requires_resources` của stage trên workflow, chỉ áp dụng tại thời điểm `plan()`. `timeout_seconds` cap thời lượng chạy thật của script con (`min(deadline attempt, timeout_seconds)`) — không khai thì chạy tới hết deadline chung.
- Secret vào env qua `env_refs: { TÊN: "secret://scope/name" }`, resolve vào **env của process con** ngay trước khi spawn — không bao giờ vào `stage-request.json`, event hay log; `Redactor` che mọi giá trị đã resolve xuất hiện trong log dùng chung kể cả khi chính script tự in nó ra. Set biến `HARNESS_SECRET_<SCOPE>_<NAME>` tương ứng trong shell/`.env` của máy chạy worker; không commit giá trị.
- stdout của wrapper: một dòng JSON hợp lệ có `level` (`info`/`warn`/`error`) + `msg` string được log có cấu trúc; dòng khác log nguyên văn ở `info`. `HARNESS_CLI_ARGV` (đặt sẵn cho mọi attempt script) cho `ctx.op.*` biết cách gọi lại CLI harness này.
- Gate (`executor: { type: gate }`) không thực thi gì — chỉ ghi `stage-request.json` + `brief.md` (đề bài) rồi đỗ `WAITING_HUMAN`; xong việc thì `harness stage submit`, không có lệnh nào khác đưa một gate ra khỏi `WAITING_HUMAN`. Executor `gate` không bao giờ được reuse (đã có từ 2A).
- Checker media chọn output theo **mime khai trong `expected_outputs`**, không theo phần mở rộng file; ngưỡng lấy từ `StageRequest.policy` (build từ `profile.content`). Thiếu ffprobe trên máy rơi về `NullMediaProber` — mọi checker media `skip` (không fail); `harness doctor` báo rõ dòng `ffprobe` nhưng không chặn gì khác.

## Lệnh catalog, resource, artifact (sub-project 2A)
- `harness source ingest <path> [--collection <name>] [--rights unknown|cleared|restricted] [--language <code>] [--json]`: đăng ký một file nguồn, dedupe theo sha256 (UNIQUE trên `checksum`, an toàn khi ingest đua nhau); vật liệu hoá theo `project.yaml.source.materialize` (`link` mặc định — hardlink dùng chung inode với file gốc, sửa file gốc sau đó sẽ đổi cả bản normalize; `copy`; `reference` — chỉ trỏ URI, không nhân bản).
- `harness source list [--collection <name>] [--json]`, `harness source verify [--json]` (hash lại toàn bộ nguồn đã đăng ký; thoát mã 1 nếu có nguồn hỏng).
- `harness content create --title <t> --source <src_id>... [--json]`.
- `harness plan --workflow <id@version> --profile <id> --content <content_id> [--option k=v]... [--no-reuse] [--json]`: get-or-create variant khoá theo `content_id` + `profile_id` + `profile.revision` + digest của options (đã hợp nhất với `options_defaults` và kiểm theo `options_schema`); `--option` không có `--content` là lỗi `CONFIG_INVALID`.
- `harness resources status [--json]`: capacity khai trong `project.yaml.resources` so với số lease đang giữ mỗi tài nguyên.
- `harness artifacts sweep [--older-than-minutes 60] [--dry-run] [--json]`: xoá thư mục artifact cũ hơn ngưỡng không có hàng DB không-PROVISIONAL đứng sau (crash/cancel để lại rác giữa lúc ghi output và commit).

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
- Output khai `kind: directory` trong stage definition tạo một artifact cho cả thư mục: manifest liệt kê từng file con kèm checksum riêng, `checksum` của artifact là canonical digest của toàn bộ listing đó; input là thư mục được vật liệu hoá lại thành cây (hardlink, rơi về copy) trong workspace của stage kế tiếp.

## Quy tắc tài nguyên (resources)
- Tài nguyên chia sẻ (GPU, license slot, …) khai trong `project.yaml.resources: { <tên>: <capacity> }`; tên không khai coi như capacity 0.
- Stage khai `requires_resources` trong workflow definition. `claim()` bỏ qua stage nếu bất kỳ tài nguyên yêu cầu nào không còn slot trống (giữ theo lease đang hiệu lực, đếm qua `resources` trên bảng `lease`); worker khác vẫn được claim các stage không tranh chấp.
- Stage READY chờ tài nguyên quá `resource_wait_warn_seconds` (mặc định 600s) sinh event `stage.waiting_resource`, không lặp lại nếu vẫn còn nằm trong cửa sổ đó.

## Quy tắc cache và invalidation
- Controller ghi `cache_key` (digest của stage definition + checksum input đã sort + options digest + effective-config digest + `executor_version`) vào StageRun khi commit SUCCEEDED.
- Khi `plan` một run mới cho cùng variant (`profile.reuse: allow`, mặc định), stage nào có toàn bộ dependency đã reuse/SUCCEEDED sẽ được tái sử dụng artifact nếu tìm thấy stage SUCCEEDED cùng cache_key ở run trước của variant đó — không dispatch lại; event `stage.reused` ghi `reused_artifact_ids`. `profile.reuse: never` tắt hẳn (`harness plan --no-reuse` tắt cho một run); executor `gate` không bao giờ được reuse. Nếu mọi stage đều reuse thì `enqueue` chốt run thành SUCCEEDED ngay, không dispatch gì.
- Khi một stage commit artifact ACCEPTED mới, mọi artifact ACCEPTED của chính stage đó và các stage phụ thuộc (transitive, kể cả `depends_on_optional`) ở các run **trước đó** của cùng variant chuyển sang STALE (`artifact.stale`), kèm event `stage.invalidated_downstream` trên run vừa commit. Artifact STALE không còn được downstream đọc.
- Invalidation theo **nội dung**, không chỉ theo graph (spec §3.2): run cũ nào đang giữ đúng tập checksum vừa commit ở chính stage đó thì được bỏ qua nguyên vẹn — submit lại một gate với nội dung y hệt không làm hỏng gì của run trước. **Ngoại lệ:** một stage commit **không output nào** (tập checksum rỗng) không có gì để so nội dung, nên vẫn invalidate thuần theo graph như trước — không có "byte giống hệt" để so sánh thì không thể bỏ qua.
- Reuse còn xảy ra **lúc release**: một stage PENDING có đủ dependency SUCCEEDED sẽ tính lại cache_key từ input ACCEPTED thật (`stage_definition_digest`, `expected_executor_version`, `reuse_eligible` planner ghi sẵn lên StageRun) và nếu trúng thì đi thẳng `PENDING → SUCCEEDED` với event `stage.reused` (`at: "release"`), không dispatch. Nhờ đó stage nằm dưới một gate — thứ không bao giờ reuse lúc plan — vẫn tái sử dụng được khi gate cho ra đúng nội dung cũ. Ngân sách (variant) chặn nhánh reuse-lúc-release này y hệt dispatch thường (nằm trong cùng vòng lặp `releaseReady`) dù bản thân nó miễn phí; reuse lúc `plan()` thì không bao giờ bị ngân sách chặn.

## Cách commit state
- Mọi kết quả stage đi qua `Controller.commit()` với fencing token của attempt hiện tại.
- Kết quả không rõ (mất kết nối sau dispatch) → `NEEDS_RECONCILIATION`; `harness reconcile <run_id>` hỏi provider rồi tự đưa stage về `READY` ngay khi không còn operation nào của nó còn treo — **kể cả khi provider không xác nhận được (kết quả `FAILED`)**, không chỉ khi `CONFIRMED`; khác biệt duy nhất là lần attempt kế tiếp gọi lại provider (idempotency key cũ bị coi là không hiện hành) thay vì tái dùng kết quả đã confirm. Không bao giờ `retry` trước khi `reconcile`.

## Định nghĩa hoàn thành cho một task phát triển
1. Test viết trước, fail, rồi pass. 2. `pnpm -r typecheck` sạch. 3. Commit theo Conventional Commits. 4. Không để lại TODO/placeholder.
