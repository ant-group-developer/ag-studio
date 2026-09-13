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
- Invalidation theo **nội dung**, không chỉ theo graph (spec §3.2): run cũ nào đang giữ đúng tập checksum vừa commit ở chính stage đó thì được bỏ qua nguyên vẹn — submit lại một gate với nội dung y hệt không làm hỏng gì của run trước.
- Reuse còn xảy ra **lúc release**: một stage PENDING có đủ dependency SUCCEEDED sẽ tính lại cache_key từ input ACCEPTED thật (`stage_definition_digest`, `expected_executor_version`, `reuse_eligible` planner ghi sẵn lên StageRun) và nếu trúng thì đi thẳng `PENDING → SUCCEEDED` với event `stage.reused` (`at: "release"`), không dispatch. Nhờ đó stage nằm dưới một gate — thứ không bao giờ reuse lúc plan — vẫn tái sử dụng được khi gate cho ra đúng nội dung cũ.

## Cách commit state
- Mọi kết quả stage đi qua `Controller.commit()` với fencing token của attempt hiện tại.
- Kết quả không rõ (mất kết nối sau dispatch) → `NEEDS_RECONCILIATION`; chạy `harness reconcile <run_id>` trước khi retry.

## Định nghĩa hoàn thành cho một task phát triển
1. Test viết trước, fail, rồi pass. 2. `pnpm -r typecheck` sạch. 3. Commit theo Conventional Commits. 4. Không để lại TODO/placeholder.
