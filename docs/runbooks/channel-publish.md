# Runbook: phát hành kênh (channel-publish, sub-project 3)

Đích: một máy vai **channel** lấy một `LibraryItem` đã `approved` từ kho (`harness library pick`, sub-project
2C), đóng gói theo hướng SEO của kênh (agent, skill `channel-package`), rồi đưa lên YouTube bằng cách bọc lại
hai script Playwright cũ của kênh (`upload-youtube-playwright.mjs` upload PRIVATE, `publish-video-playwright.mjs
--schedule` đặt lịch native) — **không dùng YouTube Data API**, và harness **không bao giờ** gõ mật khẩu/2FA.
Cộng một dashboard chỉ đọc, dựng từ file `dashboard/snapshot.json`.

Đọc code trước khi tin tài liệu này lệch: `packages/core/src/distribution/{channels,packages,publication,
verify,reconcile,checkers}.ts`, `packages/adapters/{youtube-playwright,agent-cli}/src/`,
`packages/cli/src/commands/{channel,publish,publish-stage,dashboard,doctor}.ts`,
`workflows/channel-publish/workflow.yaml`, `skills/channel-package/SKILL.md`.

---

## 1. Khai một kênh (`channels/<channel_id>/channel.yaml`)

Copy `project-template/channels/example/channel.yaml` thành `channels/<channel_id>/channel.yaml` (**tên thư
mục phải khớp `channel_id`** — lệch tên là `CONFIG_INVALID`, chặn cả `channels:config` của mọi kênh khác
trong cùng project, không chỉ kênh sai). Các trường bắt buộc phải điền đúng máy đang chạy:

- `repo_dir`: đường dẫn **tuyệt đối** tới repo kênh cũ (`D:\<kênh>\...`). Một đường tương đối ở đây resolve
  theo *thư mục làm việc thật của tiến trình `harness`* (`path.resolve()` chuẩn Node), không theo `--project`
  — gần như luôn sai trừ khi bạn cố tình `cd` vào đúng project dir trước mỗi lần chạy (chỉ bộ test tích hợp
  làm vậy, viết đường tuyệt đối vào một bản `channel.yaml` tạm trước khi chạy).
- `legacy_project_id`, `youtube.expected_channel_id`: phải khớp `channel.config.json` của repo kênh cũ
  (`projectId`, `youtube.channelId`) — checker `channel-identity` (stage `build-package`) và doctor
  `channel:<id>:identity` đối chiếu hai bên, lệch thì chặn đóng gói trước khi có job nào được tạo (acceptance
  22 của spec).
- `youtube.account_email_ref`: **ref**, không phải email thật — đúng khuôn hai đoạn
  `secret://<scope>/<name>` (ví dụ `secret://youtube-<channel_id>/email`), resolve từ biến môi trường
  `HARNESS_SECRET_<SCOPE viết hoa, "-"→"_">_<NAME viết hoa, "-"→"_">` (`EnvSecretResolver.envName`,
  `packages/core/src/config/secrets.ts`) — với ví dụ trên là
  `HARNESS_SECRET_YOUTUBE_<CHANNEL_ID viết hoa>_EMAIL`. Set biến đó trong shell/`.env` của máy chạy
  `worker`/`doctor`, giá trị phải khớp `channel.config.json.youtube.accountEmail` của repo kênh cũ. Harness
  **không bao giờ** truyền giá trị này cho script cũ — script cũ tự đọc `channel.config.json` của chính nó
  để làm cổng chặn nhầm tài khoản; ref chỉ dùng để **đối chiếu** (checker + doctor) và bị `Redactor` xoá khỏi
  mọi log kể cả khi chính script tự in nó ra.
- `publication.publish_times`/`timezone`/`max_daily_uploads`/`min_gap_hours`: xem mục 7 khi cần đổi sau này.
- `seo.*`: đầu vào chính cho skill `channel-package` (mục 10) — càng cụ thể càng tốt, đây là toàn bộ ngữ
  cảnh "kênh này về gì, viết tiêu đề kiểu gì" mà agent nhận được.

`config_revision` của kênh (sha256 canonical của `channel.yaml`) tự tính lại mỗi lần nạp — không phải trường
cần điền tay.

## 2. Đăng nhập lần đầu (`harness channel login <id>`)

```sh
harness --project <channel-dir> channel login <channel_id>
```

Spawn `scripts/open-channel-chrome.mjs` của repo kênh nếu có, ngược lại in dòng lệnh mở Chrome tay với
`--user-data-dir=<repo_dir>/.upload-profile`. Đăng nhập YouTube trong cửa sổ Chrome đó như bình thường
(kể cả 2FA) — đây là **việc duy nhất của người** trong toàn bộ chu trình phát hành, không có cách nào khác
đưa một profile vào trạng thái đã đăng nhập.

**Không copy `.upload-profile/` giữa các máy.** Chrome ≥127 mã hoá cookie theo máy (App-Bound Encryption) —
một profile copy sang máy khác sẽ không đọc được cookie đã lưu, script cũ coi như chưa đăng nhập (thoát exit
3, `refused`). Mỗi máy chạy `worker`/`upload` cho một kênh phải tự `channel login` một lần trên chính máy đó.

## 3. `harness doctor` — các hàng kênh/agent

```sh
harness --project <channel-dir> doctor
```

Ngoài các hàng chung (migration, ffprobe, resources, ...), một project có `channels/` thêm:

| Hàng | Kiểm gì |
| --- | --- |
| `channels:config` | Cả khối `channels/` nạp được (một kênh lỗi parse/`channel_id` sai tên thư mục/`portfolio_id` lạ làm dòng này FAIL và **không có** năm dòng theo kênh nào cả — sửa kênh đó trước). |
| `channel:<id>:repo` | `repo_dir` tồn tại và là thư mục. |
| `channel:<id>:scripts` | `upload-youtube-playwright.mjs` + `publish-video-playwright.mjs` có mặt trong `scripts/` của repo. |
| `channel:<id>:profile` | `.upload-profile/Default/` tồn tại — **không** kiểm phiên đăng nhập còn hiệu lực thật, chỉ kiểm thư mục có mặt (mục 2). |
| `channel:<id>:identity` | `channel.config.json` khớp `channel.yaml` (`channelId`, `projectId`, `accountEmail` đã resolve) — bỏ qua so email nếu bản thân secret chưa resolve được (đã có dòng `:secrets` báo lỗi đó riêng). |
| `channel:<id>:secrets` | `youtube.account_email_ref` resolve được từ env. |
| `agent:runtime` | CLI của `runtime` (`claude`/`codex`, khai ở đầu `project.yaml`, hoặc `argv[0]` của `adapters.agent_argv` nếu có ghi đè) có trên PATH — chỉ chạy `--version`, không gọi model. |
| `publisher` | Tên adapter đang chọn (`playwright`/`fake`) — luôn `ok`, chỉ để biết đang chạy đường nào. |

Không có `channels/` trong project → không dòng nào ở trên (giống `library:*` khi không khai `library`).
`doctor` không gọi mạng, không sửa gì — chạy lại bao nhiêu lần cũng an toàn.

## 4. Chu trình một tập: pick → plan → enqueue → worker

```sh
harness --project <channel-dir> library sync --json
harness --project <channel-dir> library pick <item_id> --channel <channel_id> --json
# in ra content_id

harness --project <channel-dir> plan --workflow channel-publish@1.0.0 --profile channel --content <content_id> --json
# in ra run_id
harness --project <channel-dir> enqueue <run_id>
harness --project <channel-dir> worker --once   # lặp lại tới khi in "idle" hoặc harness status <run_id> báo SUCCEEDED
```

Không có gate nào (quyết định thiết kế "không có gate" của sub-project 3) — từ `pick` tới `SCHEDULED` chạy tự
động qua năm stage của `channel-publish@1.0.0`: `fetch-library-item` (script built-in, chép file từ kho) →
`package` (agent, skill `channel-package`, mục 10) → `build-package` (script built-in, ghi vào
`repo_dir/outputs/<legacy_project_id>/episodes/episode-NN/`, tạo `PublicationJob` `READY`) → `upload` (script
built-in, gọi `Publisher.upload`, cần tài nguyên `browser`) → `schedule` (script built-in, gọi
`Publisher.schedule`, cũng cần `browser`). `project.yaml.resources.browser: 1` nghĩa là một Chrome một lúc
trên máy — hai run cùng cần upload/schedule sẽ tuần tự, không song song.

Run `SUCCEEDED` nghĩa là **"đã hẹn lịch trên YouTube"**, không phải "đã public" — video lên public đúng giờ
hay không do sweep `verify` theo dõi tiếp trên `PublicationJob` (mục 6), harness không giữ run mở chờ tới giờ
phát.

`worker` (chạy liên tục, không `--once`) tự làm ba việc khi rảnh: đồng bộ kho (`library sync`, 2C), sweep
`verify` overdue `SCHEDULED` job mỗi `publication.verify_seconds` (mặc định 900s, tối thiểu 60), và làm mới
`dashboard/snapshot.json` mỗi `dashboard.refresh_seconds` (mặc định 60s, tối thiểu 10) — lỗi ở cả ba việc chỉ
log, không dừng worker.

## 5. Đọc trạng thái: `publish list` / `show` / `slots`

```sh
harness --project <channel-dir> publish list [--channel <id>] [--state <STATE>] [--json]
harness --project <channel-dir> publish show <job_id> [--json]      # kèm title/episode_no từ package + event
harness --project <channel-dir> publish slots <channel_id> [--days 7] [--json]   # xem trước, không đặt lịch
```

`state` là một trong máy trạng thái `PublicationJob`: `DRAFT → READY → UPLOADING → PROCESSING → SCHEDULED →
PUBLISHED`, với hai nhánh sự cố `NEEDS_RECONCILIATION` (từ `UPLOADING` hoặc `SCHEDULED`) và `FAILED` (chỉ từ
`publish cancel`, không bao giờ tự động). `publish slots` tính trước các khung giờ `nextSlot()` sẽ cấp tiếp
theo cấu hình `publication.*` hiện tại của kênh — không ghi gì, dùng để trả lời "kênh này còn chỗ tuần này
không" trước khi lên kế hoạch thêm tập.

## 6. `NEEDS_RECONCILIATION`: khi nào tự `reconcile`, khi nào vào Studio tay

Job/`ExternalOperation` rơi vào `NEEDS_RECONCILIATION` khi script cũ thoát mà harness **không biết** video đã
tạo hay chưa (mất kết nối giữa chừng, hoặc quá hạn `verify`). Luôn hỏi provider trước khi làm gì khác:

```sh
harness --project <channel-dir> publish reconcile <job_id> [--json]
# tương đương: harness --project <channel-dir> reconcile --publication <job_id>
```

`reconcile` gọi `Publisher.lookup`: có `youtube_video_id` → oEmbed (`https://www.youtube.com/oembed?...`,
không cần đăng nhập); không có, hoặc oEmbed trả 401/403/404 (video private/không tồn tại với oEmbed) → rơi về
`scripts/lookup.mjs` của adapter — **cần `.upload-profile` đã đăng nhập** (mục 2), mở Studio thật, chỉ đọc,
không bấm gì. Ba kết quả:

- **Tìm thấy video** → job/op được sửa lại đúng theo §2.6 (có lịch → `SCHEDULED`, không lịch → `PROCESSING`
  rồi run tự đi tiếp `schedule`, đã public → `PUBLISHED`) — **không có video thứ hai**.
- **Không tìm thấy** → op `FAILED`, job về `READY` — **đây là lần duy nhất** attempt `upload` kế tiếp được
  phép gọi lại `Publisher.upload()` cho job này (sau khi đã hỏi provider một lần).
- **Reconcile chính nó lỗi** (không đăng nhập, DOM Studio đổi, mất mạng) → in lỗi rõ, job giữ nguyên
  `NEEDS_RECONCILIATION`, thử lại sau.

**Khi nào tự tay vào YouTube Studio trước khi chạy `reconcile`:** nếu bạn nghi script cũ đã hỏng thật sự (DOM
Studio đổi — không có cảnh báo tự động nào cho việc này, `doctor` không phát hiện được vì nó không kiểm nội
dung DOM) và có thể `reconcile` sẽ báo "không tìm thấy" sai (video thật ra đã có), **hãy tự kiểm trên Studio
trước**: `reconcile` "không tìm thấy" luôn dẫn tới **upload lại** ở attempt kế tiếp — nếu video thật ra đã
tồn tại mà `reconcile` không thấy được (ví dụ do `lookup.mjs` cũng hỏng theo cùng lý do), kết quả là **hai
video trên YouTube** cho cùng một tập. Xem log `upload-debug/` trong repo kênh (script cũ tự ghi) để nhận
biết DOM đã đổi.

`harness publish cancel <job_id> --note "..."` (chỉ `READY|PROCESSING|SCHEDULED → FAILED`) dùng khi bạn quyết
định **không** phát hành job này nữa — không bao giờ đụng tới video đã có trên YouTube (nếu video đã tồn
tại, xoá/sửa nó là việc tay trên Studio, ngoài phạm vi harness).

## 7. Đổi giờ phát hoặc `max_daily_uploads`

Sửa `publication.publish_times`/`max_daily_uploads`/`min_gap_hours`/`timezone` thẳng trong `channel.yaml`.
Thay đổi này **chỉ ảnh hưởng job phát hành sau đó** — `nextSlot()` đọc cấu hình hiện tại của kênh mỗi lần
stage `schedule` chạy, không có gì đi sửa lại `scheduled_at` của job đã `SCHEDULED`/`PUBLISHED`. Không cần
lệnh gì khác; `channel_config_revision` (ghi vào `ChannelPackage` mới) tự đổi theo nội dung file.

## 8. Dừng một kênh

Không có lệnh "tắt kênh" — bỏ hẳn thư mục `channels/<channel_id>/` ra khỏi project (xoá hoặc chuyển đi nơi
khác ngoài `channels/`). Trước khi làm vậy:

1. Đảm bảo không còn run nào đang ở giữa `channel-publish` cho kênh này (`harness publish list --channel
   <channel_id> --state PROCESSING`/`SCHEDULED` để xem còn job nào chưa xong) — một stage
   `build-package`/`upload`/`schedule` chạy sau khi `channels/<id>/` đã biến mất sẽ fail `NOT_FOUND` (channel
   not found) thay vì một lỗi rõ ràng hơn.
2. Xoá thư mục. `harness channel list`/`doctor`'s `channel:<id>:*` rows không còn kênh đó nữa; `harness
   publish list` vẫn liệt kê được các `PublicationJob` cũ của kênh (dữ liệu trong state store không bị xoá
   theo).

## 9. Dashboard (`harness dashboard`)

```sh
harness --project <channel-dir> dashboard snapshot [--json]   # ghi dashboard/snapshot.json ngay, in đường dẫn
harness --project <channel-dir> dashboard serve [--port 5200] # ghi một snapshot rồi phục vụ /hub tới Ctrl+C
```

`serve` bind `127.0.0.1:<port>` (`--port` > `HARNESS_DASHBOARD_PORT` > `project.yaml.dashboard.port`, mặc
định 5200). Mở `http://127.0.0.1:<port>/hub` — trang tĩnh, tự poll `/api/snapshot` mỗi 30s **chỉ khi** có run
đang chạy hoặc job đang `UPLOADING` (tắt poll khi rảnh). Dashboard **chỉ đọc**: không route `POST`, mọi
method khác 405, mọi route khác 404 — dữ liệu luôn là ảnh chụp `dashboard/snapshot.json` do `harness dashboard
snapshot`/worker sinh, không phải state hai chiều.

### Checklist nghiệm thu tay (rút gọn)

- [ ] 4 chip đầu (kênh · tập · mục kho đã duyệt · request mở) khớp số liệu thật của project.
- [ ] Mỗi thẻ kênh có viền màu đúng `channel.yaml.color`, ba ô số (đăng hôm nay a/b, tập, tập mới nhất) đúng.
- [ ] Badge `⚠ reconcile` xuất hiện đúng khi kênh có job `NEEDS_RECONCILIATION`; `⏳ đang chạy` khi có run
      active; `🔑 có profile`/`🔑 chưa profile` khớp `.upload-profile/Default` có/không tồn tại.
- [ ] Click một thẻ kênh mở modal: cài đặt (SEO language, giờ đăng, mục tiêu/ngày, timezone) đúng
      `channel.yaml`; panel tài khoản có dòng `harness channel login <id>` chép được; mỗi gói đăng tải có
      thumbnail + nút chép cho tiêu đề/mô tả/tags/hashtag/playlist/lịch, đếm ký tự tiêu đề đỏ khi > 100.
- [ ] Panel "CẢNH BÁO" liệt kê đúng alert hiện có (`reconcile`, `run_failed`, `gate_overdue`, `doctor`,
      `library_unmounted`, `missing_today`) — trống thì ẩn panel.
- [ ] Thu cửa sổ trình duyệt xuống ~720px: layout không vỡ, lưới thẻ kênh tự xếp lại.
- [ ] Refresh trang: `generated_at` ở header cập nhật đúng lần `snapshot`/worker refresh gần nhất.

## 10. DoD #6 — chạy skill `channel-package` với `claude`/`codex` thật

Spec yêu cầu (§9 mục 6) xác nhận skill `skills/channel-package/SKILL.md` sinh được `output/package.json` qua
đủ checker (`schema-valid`, `youtube-limits`, `hypothesis-complete`) khi chạy **CLI agent thật** (`claude -p`
hoặc `codex exec`) trên máy, không phải `fake-agent-cli.mjs` mà mọi test/fixture tự động dùng. Đây là kiểm
tay — không có cách nào chứng minh qua test tự động vì bản thân việc gọi model là external effect có chi phí
và không xác định (spec §11).

**Cách chạy:**

```sh
harness --project <channel-dir> skills sync           # copy skills/channel-package vào .claude/skills/ và
                                                        # .agents/skills/ của project này
# project.yaml: adapters: { agent: cli }, KHÔNG khai agent_argv (để CliAgentRuntime dùng RUNTIME_COMMANDS
# mặc định của runtime đã chọn ở đầu project.yaml — claude | codex)
harness --project <channel-dir> library pick <item_id> --channel <channel_id>
harness --project <channel-dir> plan --workflow channel-publish@1.0.0 --profile channel --content <content_id>
harness --project <channel-dir> enqueue <run_id>
harness --project <channel-dir> worker --once   # stage "package" spawn `claude -p`/`codex exec` thật
harness --project <channel-dir> status <run_id> --json   # xem stage "package" SUCCEEDED hay FAILED, checker nào
```

Ghi lại vào phần dưới đây mỗi lần chạy thật: **ngày**, **model/runtime** (`claude` hay `codex`, phiên bản
nếu biết), **có qua đủ ba checker hay không** (và nếu fail, checker nào + lý do).

> **Trạng thái tại Task 12 (2026-09-15):** chưa chạy được — `claude` (và `codex`) không có trên PATH trong
> môi trường build agent thực hiện Task 12 (`harness doctor`'s `agent:runtime` row sẽ FAIL với "claude not on
> PATH" nếu thử). Toàn bộ đường ống `channel-publish` đã được kiểm bằng `fake-agent-cli.mjs` (test tích hợp,
> acceptance 21-26) và bằng agent thật ở mức "CLI có mặt, chạy `--version` được" (`agent:runtime` doctor row,
> khi có CLI) — nhưng **chưa có lần chạy thật nào sinh `package.json` qua checker**. Người vận hành có
> `claude`/`codex` cài sẵn trên máy cần tự chạy chu trình trên, rồi thêm một dòng vào bảng dưới:
>
> | Ngày | Runtime | Model | Qua checker? | Ghi chú |
> | --- | --- | --- | --- | --- |
> | _(chưa có)_ | | | | |
