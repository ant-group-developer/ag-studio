# Runbook: studio tự vận hành (sub-project 4)

Đích: máy vai **studio** tự nhận `ContentRequest` do kênh tạo, tự học style từ video mẫu
(`style-study@1.1.0`), tự dựng và tự duyệt một tập (`library-production@1.1.0`) — không cần người bấm gì ở
studio ngoài `harness worker`. Năm gate người của kho (2C: `analyze-style`, `style-review`, `survey-source`,
`plan-edit`, `library-review`) trở thành năm stage **agent** chạy skill; harness tự "xem" video cho agent
bằng stage built-in `watch`.

Đọc code trước khi tin tài liệu này lệch: `packages/core/src/media/watch.ts`,
`packages/core/src/library/auto-accept.ts`, `packages/core/src/orchestration/registry.ts`,
`packages/cli/src/commands/{media,library,worker}.ts`, `workflows/{style-study,library-production}@1.1.0/
workflow.yaml`, `skills/{style-analyze,style-review,source-survey,edit-plan,library-review}/SKILL.md`. Spec:
`docs/superpowers/specs/2026-09-15-sub-project-4-studio-autopilot-design.md`.

---

## 1. Điều kiện của máy studio

- **`ffmpeg`/`ffprobe` trên PATH** — bắt buộc. Stage `watch` (built-in, chạy trước mỗi stage agent) trích
  khung và contact sheet bằng ffmpeg; thiếu thì `contract`, không retry, cả run dừng ở stage `watch` đầu
  tiên. `harness doctor` có dòng `ffprobe` báo trước việc này (mục 3).
- **`claude` hoặc `codex` trên PATH** — bắt buộc để chạy năm stage agent thật (`project.yaml.runtime:
  claude|codex`, `adapters: { agent: cli }`). Không có CLI thật, dùng `adapters: { agent: fake }` hoặc trỏ
  `adapters.agent_argv` vào `fixtures/fake-agent-cli.mjs` chỉ để tập luyện quy trình — output khi đó không có
  giá trị thật (fake luôn ghi output "hợp lệ" theo schema, không thật sự "xem" gì). `harness doctor` có dòng
  `agent:runtime` kiểm CLI có mặt (chỉ chạy `--version`, không gọi model).
- **`yt-dlp`** trên máy chạy wrapper `collect-samples`, nếu `samples.txt` của `style-study` có URL YouTube
  (không bắt buộc nếu chỉ dùng file cục bộ) — harness lõi không biết yt-dlp, wrapper của ops project tự gọi.
- **`whisper`/faster-whisper (tuỳ chọn)** qua hook `transcribe` (`executors/scripts.yaml.transcribe`) —
  không khai thì `watch.json` ghi `transcript: null` cho mọi video, các skill vẫn chạy được (transcript chỉ
  là thêm ngữ cảnh, không bắt buộc).

## 2. Bật `library.auto_accept`

Trong `project.yaml` của máy studio:

```yaml
library:
  root: /path/to/shared-kho
  role: studio
  sync_seconds: 300
  auto_accept:
    enabled: true
    source_collection: main   # collection chọn nguồn khi request không có source_hint
    max_replans: 2            # số lần plan lại tối đa sau khi review từ chối
    max_concurrent_runs: 1    # số run studio auto-accept đang chạy cùng lúc, tối đa
adapters: { agent: cli }      # bắt buộc CLI thật (không phải fake) để doctor library:auto_accept xanh
```

Kiểm bằng `harness doctor`: dòng `library:auto_accept` — `enabled: false` luôn `ok` (không có gì để kiểm);
`enabled: true` FAIL nếu `source_collection` không có source nào trong catalog, hoặc `adapters.agent` là
`fake` (autopilot cần agent thật để chạy được các stage agent, không chỉ để lên kế hoạch). Không sửa gì cả —
chạy lại bao nhiêu lần cũng an toàn.

## 3. Chu trình: request → studio tự chạy → item `approved` → channel `pick`

Phía kênh không đổi so với 2C — tạo request rồi chờ:

```sh
harness --project <channel-dir> library request create --portfolio <id> --channel <id> \
  --topic "<chủ đề>" --style <style_id> --voice none --duration 1,60 \
  --source-hint main --json
```

`--source-hint <collection>` (mới, mục 5 dưới) ghi `ContentRequest.source_hint.collection` — gợi ý cho vòng
tự nhận của studio, không bắt buộc (không truyền thì studio rơi về `library.auto_accept.source_collection`
của chính nó).

Phía studio chỉ cần chạy worker liên tục hoặc lặp `--once`:

```sh
harness --project <studio-dir> worker      # hoặc lặp `worker --once` trong vòng lặp shell của bạn
```

Mỗi vòng rảnh, worker: đồng bộ kho (`library sync`, tối đa mỗi `sync_seconds`) rồi gọi `autoAccept` — nhận
một request `open` có style `active`, chọn nguồn theo quy tắc (mục 5), tạo `ContentItem` + `plan` +
`enqueue` một run `library-production@1.1.0` trong **một transaction** (không tạo trùng), rồi dispatch stage
như bình thường. Theo dõi bằng:

```sh
harness --project <studio-dir> library list requests --json     # open -> claimed -> fulfilled
harness --project <studio-dir> status <run_id>                  # trạng thái từng stage
harness --project <studio-dir> dashboard snapshot --json         # tổng quan + alert (mục 6)
```

Item `approved` xuất hiện trong kho (`library list items`); kênh `library sync` rồi `library pick <item_id>
--channel <id>` như cũ — bước `pick` **vẫn tay**, tự động hoá phía kênh là phạm vi sub-project 3B, không
phải sub-project này.

## 4. `style-study@1.1.0`: học style từ `samples.txt`

`samples.txt` (input của stage `collect-samples`, mỗi dòng một mục) nhận cả URL YouTube lẫn đường dẫn cục
bộ — wrapper `collect-samples` của ops project (`fixtures/ops-project-studio/executors/wrappers/
collect-samples.mjs`) tự tải URL bằng `yt-dlp`, copy đường dẫn cục bộ; harness lõi không gọi yt-dlp. Chạy:

```sh
harness --project <studio-dir> source ingest samples.txt --rights cleared --json
harness --project <studio-dir> content create --title "<tên style>" --source <source_id> --json
harness --project <studio-dir> plan --workflow style-study@1.1.0 --profile studio --content <content_id> --json
harness --project <studio-dir> enqueue <run_id>
harness --project <studio-dir> worker --once   # lặp tới khi SUCCEEDED hoặc WAITING_HUMAN
```

Năm stage: `collect-samples` → `watch-samples` (built-in, trích khung + contact sheet) → `analyze-style`
(agent, viết `style.json` `draft` + `evidence/`) → `style-review` (agent, đối chiếu ≥5 khung ngẫu nhiên; đạt
→ `style.json` `active`, lệch ≥2 tham số → giữ `draft`) → `style-export` (built-in, chỉ xuất style `active`
vào kho).

**Khi `style-review` giữ `draft`:** `style-export` fail `contract` ("no active style") → run `FAILED`. Đọc
`review-notes.md` (artifact type `review_notes` của stage `style-review`, đường dẫn qua `status --json` →
`stages[].attempts[-1].workspace_uri`) để biết agent thấy lệch ở đâu. Ba hướng xử lý:

1. Sửa tay `style.json` trong kho (`<library.root>/styles/<style_id>/style.json`, đổi `status: active`) rồi
   `library sync` lại.
2. `harness --project <studio-dir> library styles activate <style_id> [--note "<lý do>"]` — cách nhanh hơn,
   cùng hiệu ứng (`draft|retired → active`, tăng `revision`), không cần sửa file tay.
3. Chạy lại `style-study` với mẫu khác (nhiều/đúng hơn) nếu bản thân mẫu không đủ rõ để agent phân tích
   đúng.

## 5. Khi một stage agent đỗ `WAITING_HUMAN`

Bốn stage agent của `library-production@1.1.0` (`survey-source`, `plan-edit`, `library-review`) cộng hai
stage của `style-study@1.1.0` (`analyze-style`, `style-review`) đều khai `retry: { max_attempts: 2,
backoff_seconds: [60], retry_on: [transient, abandoned] }` — **`contract` không nằm trong `retry_on`**. Một
agent không ghi đúng `output/<name>` theo `expected_outputs`, hoặc ghi JSON sai schema, là lỗi `contract` và
**không bao giờ được retry** dù `max_attempts` khai là 2 — stage đỗ `WAITING_HUMAN` sau **đúng một attempt**.
(Ghi chú: spec §7, mô tả acceptance 29, viết "FAILED sau 2 attempt" — câu đó sai so với hành vi thật của
code; xem ADR-0001 mục 88. Nếu bạn tính thời gian retry theo `backoff_seconds: [60]` cho một lỗi agent,
đừng — nó không xảy ra với lỗi `contract`.)

Xử lý:

```sh
harness --project <studio-dir> status <run_id> --json   # tìm stage_run_id đang WAITING_HUMAN + workspace_uri
```

1. Đọc `logs/agent-stdout.log` trong workspace của attempt vừa fail để hiểu agent đã làm/thấy gì (prompt gửi
   qua file `agent-prompt.md` cùng thư mục, không qua argv).
2. Sửa input nếu vấn đề nằm ở đầu vào (ví dụ `shots.json` rỗng, `watch/` thiếu khung do ffmpeg lỗi giữa
   chừng) hoặc sửa thẳng skill (`skills/<tên>/SKILL.md`) nếu vấn đề là hướng dẫn chưa đủ rõ.
3. `harness --project <studio-dir> retry <run_id> --stage <stage_key>` — đưa đúng stage đó từ `WAITING_HUMAN`
   về `READY`, worker chạy lại từ đầu (một attempt mới, không kế thừa gì từ attempt cũ).

Trong lúc stage đỗ, request kho vẫn `claimed` (run chưa kết thúc) — `autoAccept` không bao giờ tạo run thứ
hai cho cùng request khi run đầu còn sống, kể cả khi đang `WAITING_HUMAN`.

## 6. Alert `request_stuck`

Khi `library-apply-review` từ chối liên tiếp và số run **đã kết thúc** của một request vượt `max_replans`
(tức đã thử `max_replans + 1` lần), `autoAccept` bỏ cuộc — event `request.auto_accept_exhausted
{ request_id, finished_runs, max_replans }` ghi **đúng một lần** cho mỗi request (kèm một
`request.auto_accept_skipped { reason: "exhausted" }` cùng khuôn dedupe, thứ báo cáo mỗi vòng poll đọc),
request ở lại `open`, dashboard snapshot thêm alert:

```sh
harness --project <studio-dir> dashboard snapshot --json
# alerts: [{ kind: "request_stuck", ref: "<request_id>", message: "... exhausted its replan budget ..." }]
```

Xử lý (request vẫn `open`, không tự động thử lại tới khi bạn can thiệp):

1. Đọc `notes` của request (`library list requests --json` hoặc file `requests/<id>.json` trong kho) — mỗi
   lần từ chối, `library-apply-review` nối ghi chú lý do vào đó; `intake` của lần plan tiếp theo chép nó vào
   `brief.json.request_notes` để agent `plan-edit` đọc được.
2. Nếu nguồn (`source`) là vấn đề (bản thân footage không đủ để dựng theo yêu cầu): đổi
   `source_hint`/`--source-id` của request, hoặc ingest nguồn khác vào collection.
3. Nếu style hoặc chính sách duyệt quá khắt khe so với chất liệu hiện có: nới `library.auto_accept.
   max_replans` trong `project.yaml` (chỉ ảnh hưởng request tạo/plan lại **sau** khi đổi, không hồi tố request
   đã kẹt).
4. Sau khi sửa, request tự được `autoAccept` nhặt lại ở vòng poll kế tiếp — không cần lệnh gì đặc biệt để
   "mở khoá" nó, `finishedRunCounts` tính lại mỗi lần gọi.

## 7. Chi phí

`production-profiles/studio/profile.yaml` (revision 2) đặt `limits.max_cost_usd_per_variant: 8` — chặn
dispatch mới khi tổng chi phí của variant (mọi run cùng content+profile+options) chạm mức đó; `harness retry
--raise-budget <usd>` nâng lên khi cần (như mọi profile khác, không riêng sub-project 4). Bốn stage agent là
phần tốn nhất: mỗi stage đọc ảnh (contact sheet trước, tối đa 20 khung đơn — ngân sách khung của spec §2.3),
contact sheet giảm số lần gọi model khoảng 10× so với gửi từng khung rời. Chưa có trần chi phí theo
ngày/portfolio (ngoài phạm vi, xem `docs/operations/deferred-items.md`) — theo dõi qua `harness status
--json`'s `run.total_cost_usd` hoặc dashboard.

## 8. Quay về workflow 1.0.0 (gate người)

`style-study@1.0.0` và `library-production@1.0.0` **không bị xoá hay đổi** — hai bản version cùng nằm trong
`workflows/`, `loadWorkflow`/`listWorkflowRefs` (ADR-0001 mục 81) hỗ trợ song song. Muốn quay lại quy trình
có người duyệt (ví dụ style/agent chưa đủ tin cậy cho một loại nội dung cụ thể):

```sh
harness --project <studio-dir> plan --workflow library-production@1.0.0 --profile studio --content <id> --json
```

`--workflow` luôn tường minh (không có mặc định) nên chọn bản nào là quyết định của người gọi `plan`, kể cả
khi `production-profiles/studio/profile.yaml`'s `workflow_release` đã trỏ `@1.1.0` — profile chỉ quyết định
`autoAccept` dùng bản nào (luôn `profile.workflow_release`), không ép `plan` tay theo cùng bản. Muốn tắt hẳn
autopilot cho một project mà vẫn giữ workflow 1.1.0 cài sẵn: `library.auto_accept.enabled: false` (hoặc bỏ
hẳn khối `auto_accept`) trong `project.yaml` — quay lại quy trình 2C hoàn toàn tay (`library accept` → `plan`
→ gate `stage submit`).

## 9. DoD #3 — chạy năm stage agent thật ít nhất một tập

Spec yêu cầu (§8 mục 3) xác nhận các stage agent chạy được với `claude`/`codex` **thật** trên máy có CLI, ít
nhất một tập — kiểm tay, không có cách chứng minh qua test tự động (bản thân việc gọi model là external
effect có chi phí, giống DoD #6 của sub-project 3). Đúng ra là **năm** stage agent trên **hai** workflow, không
phải bốn trên một: ba của `library-production@1.1.0` (`survey-source`, `plan-edit`, `library-review`) cộng
hai của `style-study@1.1.0` (`analyze-style`, `style-review`) — spec §8 mục 3 viết "bốn" là đếm sai, tương tự
lỗi "2 attempt" đã sửa ở mục 5; xem ADR-0001 mục 92.

**Cách chạy** (tương tự runbook `channel-publish.md` mục 10, đổi sang workflow kho):

```sh
harness --project <studio-dir> skills sync      # copy 5 skill vào .claude/skills/ và .agents/skills/
# project.yaml: adapters: { agent: cli }, KHÔNG khai agent_argv (để dùng RUNTIME_COMMANDS mặc định của
# runtime đã chọn ở đầu project.yaml — claude | codex)
harness --project <studio-dir> plan --workflow style-study@1.1.0 --profile studio --content <content_id> --json
harness --project <studio-dir> enqueue <run_id>
harness --project <studio-dir> worker --once    # analyze-style, style-review spawn claude -p/codex exec thật
# rồi tương tự cho library-production@1.1.0 sau khi có style active + request + source
harness --project <studio-dir> status <run_id> --json   # xem từng stage agent SUCCEEDED/FAILED, checker nào
```

> **Trạng thái tại Task 9 (2026-09-15): chưa chạy được.** `claude`/`codex` không có trên PATH trong môi
> trường build/subagent thực hiện Task 9 (`harness doctor`'s `agent:runtime` row sẽ FAIL với "not on PATH"
> nếu thử) — không có cách nào trong môi trường này để spawn một CLI agent thật. Toàn bộ đường ống agent của
> sub-project 4 đã được kiểm bằng `fake-agent-cli.mjs` (test tích hợp `studio-autopilot.test.ts`, acceptance
> 27-32) và bằng agent thật ở mức "CLI có mặt, `--version` chạy được" khi có (`agent:runtime` doctor row) —
> nhưng **chưa có lần chạy thật nào sinh `style.json`/`survey.json`/`edl.json`/`review.json` qua checker với
> `claude -p`/`codex exec` thật**. Người vận hành có CLI cài sẵn trên máy studio cần tự chạy chu trình trên
> rồi thêm một dòng vào bảng dưới, cùng khuôn với DoD #6 sub-project 3:
>
> | Ngày | Stage | Runtime | Model | Qua checker? | Ghi chú |
> | --- | --- | --- | --- | --- | --- |
> | _(chưa có)_ | | | | | |
