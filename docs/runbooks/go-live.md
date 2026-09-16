# Runbook: go-live một máy, hai vai (studio + kênh)

Đích: đưa harness từ fixture giả lập sang chạy thật trên **một máy** vừa dựng video (vai `studio`) vừa đăng
video (vai `channel`). Hai vai là **hai ops project riêng** đặt cạnh nhau, mỗi project một state SQLite, cùng
trỏ `library.root` vào một thư mục kho cục bộ. Không có server, không có máy thứ hai.

Đây là bước chưa ai làm: mọi test đến giờ chạy với adapter giả. Ba bảng DoD còn trống (agent thật —
`channel-publish.md` §10 và `studio-autopilot.md` §9; thu số Studio thật — `channel-learning.md` §9) được
điền chính ở đây. Kỳ vọng có thứ gãy ở wrapper script cũ và `collect-stats.mjs`; ghi lại, đừng sửa tại chỗ
trong `D:\`.

Đọc kèm: `wrap-a-channel.md` (wrapper + secret), `content-library.md` (kho), `studio-autopilot.md`,
`channel-publish.md`, `channel-learning.md`.

---

## 0. Bố cục thư mục trên máy đích

```
E:\YOUTUBE_OPERATIONS_HARNESS\      # clone repo (mã, workflow, skill, template) — chỉ git kéo/đẩy
E:\ops-studio\                      # ops project vai studio (copy từ project-template/)
E:\ops-channel\                     # ops project vai channel (copy từ project-template/)
E:\kho\                             # thư mục kho chung: styles/ requests/ items/
D:\<kênh>\                          # repo kênh cũ, CHỈ ĐỌC (scripts, .upload-profile, outputs/)
```

Đường dẫn ở dưới lấy theo bố cục này; đổi ổ/tên tuỳ máy nhưng giữ quy tắc: ops project và kho nằm **ngoài**
repo harness, và `library.root` của hai project viết **giống hệt nhau** (cả hoa/thường lẫn `/`).

## 1. Cài công cụ (một lần)

- Node ≥ 22.13 → `corepack enable` (pnpm theo `packageManager` của repo).
- `ffmpeg`, `ffprobe` trên PATH (stage `watch`, `build-package`, `durationOf`).
- Git; GitHub CLI không bắt buộc (chỉ cần để tạo repo).
- Agent CLI của máy: `claude` (đăng nhập sẵn, hoặc `ANTHROPIC_API_KEY`) **hoặc** `codex` (`OPENAI_API_KEY`).
  `project.yaml.runtime` chọn cái nào; `harness doctor` hàng `agent:runtime` kiểm `--version`.
- Chrome với profile đã đăng nhập YouTube Studio của từng kênh tại `D:\<kênh>\.upload-profile\Default`
  (như hệ cũ), dùng cho upload/lên lịch (`upload-youtube-playwright.mjs`) và thu số (`collect-stats.mjs`).

## 2. Lấy mã và dựng

```bash
git clone https://github.com/hieuhoangwm01-star/YOUTUBE_OPERATIONS_HARNESS E:/YOUTUBE_OPERATIONS_HARNESS
cd E:/YOUTUBE_OPERATIONS_HARNESS
corepack enable && pnpm install && pnpm build && pnpm test      # ~5 phút, phải xanh hết
```

`pnpm test` xanh nghĩa là máy đủ Node/ffmpeg. Suite có một họ flake khi máy tải nặng (`library-pipeline`,
`06-stale-scope`, `16-secret-e2e`, `07-thumbnail`, footage gpu-serialization, worker lease,
`26-reconcile-not-found`): chạy lại riêng file đó trước khi kết luận.

Mọi lệnh `harness` dưới đây chạy từ thư mục repo: `pnpm harness --project <ops-project> …`.

## 3. Tạo kho cục bộ

```bash
mkdir -p E:/kho/styles E:/kho/requests E:/kho/items
```

Doctor **không** tự tạo ba thư mục này (`content-library.md` §6). Muốn dùng lại kho cũ thì trỏ vào đó,
nhưng kho phải có đúng ba thư mục con.

## 4. Ops project vai studio (`E:\ops-studio`)

```bash
cp -r E:/YOUTUBE_OPERATIONS_HARNESS/project-template E:/ops-studio
cd E:/ops-studio
```

1. `package.json`: đổi `name` (ví dụ `ops-studio`), sửa `link:` thành
   `link:../YOUTUBE_OPERATIONS_HARNESS/packages/script-sdk` (đường tương đối từ `E:\ops-studio`), rồi
   `pnpm install`.
2. `project.yaml` — thay toàn bộ phần dưới `schema_version` bằng:

```yaml
schema_version: harness.project-config/v1
project_id: studio-main
template_release: 0.1.0
runtime: claude                     # hoặc codex
data_root: ./data
portfolios:
  - { portfolio_id: portfolio-studio, display_name: Studio }
resources: { cpu: 2, gpu: 1 }       # capacity thật của máy; gpu là số job TTS/render chạy song song
source: { materialize: link }
library:
  root: E:/kho
  role: studio
  sync_seconds: 60
  auto_accept: { enabled: true, source_collection: main, max_replans: 2, max_concurrent_runs: 1 }
adapters:
  agent: cli                        # KHÔNG dùng fake ở go-live; doctor sẽ FAIL nếu auto_accept bật + agent fake
workflows: [style-study@1.1.0, library-production@1.1.0]
```

3. `executors/scripts.yaml` + `executors/wrappers/*.mjs`: `library-production@1.1.0` gọi bảy script
   `collect-samples`, `transcribe`, `thumbnail-candidates`, `index-source`, `tts`, `cut`, `assemble`
   (bốn lệnh `library-*` và `watch-*` là built-in, không cần wrapper). Mỗi tên một dòng trong
   `scripts.yaml` và một wrapper gọi script cũ ở `D:\<kênh>\scripts\` theo khuôn `wrap-a-channel.md` §4
   (đường dẫn script cũ đặt qua env hoặc `cwd`, không hard-code trong wrapper để commit được). Mẫu chạy
   được: `fixtures/ops-project-studio/executors/` và `fixtures/ops-project-footage/executors/wrappers/`.
   **Đây là phần việc thật lớn nhất của go-live và chưa có wrapper nào cho script cũ ở `D:\`** — làm
   từng cái, thử bằng một run tay (`content create` → `plan` → `enqueue` → `worker --once`, xem
   `wrap-a-channel.md` §8) trước khi giao cho worker chạy nền.
4. `source-catalog/sources.yaml`: khai collection `main` trỏ vào corpus nguồn (ví dụ `D:\hub-tai-chinh-us`),
   rồi `harness source ingest …` để `library:auto_accept` có ít nhất một source.
5. Skill cho agent: `pnpm harness --project E:/ops-studio skills sync` (chép `skills/*` vào
   `.claude/skills/` và `.agents/skills/` của project; chạy lại sau mỗi lần kéo repo).
6. Khởi tạo và kiểm:

```bash
pnpm harness --project E:/ops-studio db migrate
pnpm harness --project E:/ops-studio doctor      # library:root/write, agent:runtime, library:auto_accept, từng script
```

## 5. Ops project vai kênh (`E:\ops-channel`)

```bash
cp -r E:/YOUTUBE_OPERATIONS_HARNESS/project-template E:/ops-channel
cd E:/ops-channel
```

1. `package.json` như trên (`name: ops-channel`, cùng `link:`), `pnpm install`.
2. `project.yaml`:

```yaml
schema_version: harness.project-config/v1
project_id: channel-main
template_release: 0.1.0
runtime: claude
data_root: ./data
portfolios:
  - { portfolio_id: portfolio-channel, display_name: Kênh }
source: { materialize: link }
library: { root: E:/kho, role: channel }        # đúng chuỗi như bên studio
workflows: [channel-publish@1.1.0, channel-planning@1.0.0]
resources: { browser: 1 }                        # upload/schedule/collect dùng chung một Chrome
learning: { collect_seconds: 1800, collect_batch: 5 }
adapters:
  publisher: playwright
  agent: cli
  stats: playwright
```

   Vai kênh không cần `executors/`: fetch/channel-brief/build-package/upload/schedule/demand/create-requests
   đều là lệnh built-in. Xoá `executors/` và `source-catalog/` của template cho khỏi lẫn.
3. Mỗi kênh một `channels/<channel_id>/channel.yaml`, theo `channels/example/channel.yaml` của template và
   `channel-publish.md` §1: `repo_dir: D:/<kênh>`, `legacy_project_id` và `youtube.expected_channel_id`
   chép từ `D:\<kênh>\channel.config.json`, `seo` từ định hướng kênh, `episode.start` = số tập kế tiếp.
   Bật vòng học ngay từ đầu nhưng để kênh tự pick chứ chưa tự sinh chủ đề:

```yaml
learning: { horizon_hours: 72, recollect_hours: [168, 720], min_impressions: 50, min_samples: 2 }
planning: { enabled: false }       # bật sau khi tập đầu tiên đi hết vòng
auto_pick: { enabled: true, max_concurrent_runs: 1 }
```

4. Secret: `youtube.account_email_ref: secret://youtube-<kênh>/email` → set env
   `HARNESS_SECRET_YOUTUBE_<KÊNH>_EMAIL=<email đăng nhập Studio>` trong shell chạy worker (đặt trong
   `.env` của máy, không commit). Checker `channel-identity` cần nó ở mọi tiến trình CLI con.
5. `pnpm harness --project E:/ops-channel skills sync`, `db migrate`, rồi:

```bash
pnpm harness --project E:/ops-channel channel login <channel_id>   # mở Chrome, đăng nhập Studio nếu chưa
pnpm harness --project E:/ops-channel doctor
```

   Phải ok: `channels:config`, `channel:<id>:repo|scripts|profile|identity|secrets|stats`, `agent:runtime`,
   `library:root|write`. Hàng `channel:<id>:planning` chỉ xuất hiện khi `planning.enabled`.

## 6. Chạy thử tay, từng bước, trước khi để worker chạy nền

Mở hai terminal, cùng export secret. Thứ tự và lệnh giống quick-start 3B trong `README.md`, chỉ khác là mọi
thứ thật. Mỗi bước dừng lại đọc `status <run_id>` / log trước khi sang bước sau.

1. **Studio học style** từ 2–3 video mẫu thật của kênh (`source ingest` file mẫu, `content create`,
   `plan --workflow style-study@1.1.0 --profile studio`, `enqueue`, `worker --once` tới SUCCEEDED). Đây là lần
   chạy agent thật đầu tiên: điền bảng `studio-autopilot.md` §9.
2. **Kênh tạo một request tay** (chưa bật planning):
   `library request create --portfolio portfolio-channel --channel <channel_id> --topic "…" --style <style_id>
   --duration 600,900` (`--duration` là `min,max` giây và **bắt buộc**: thiếu thì studio kẹt ở stage
   `assemble` — xem deferred-items "Sau sub-project 3B").
3. **Studio worker** nhận request (`worker --once` lặp) → `library-production@1.1.0` chạy đủ 13 stage → item
   `approved` trong kho. Đây là lúc wrapper script cũ lộ lỗi; sửa wrapper, không sửa script cũ.
4. **Kênh pick và phát**: `library sync`, `channel pick-next <id>`, `worker --once` lặp → `publish list`
   thấy job SCHEDULED. Stage `package` là lần chạy agent thật cho skill `channel-package`: điền
   `channel-publish.md` §10. Vào Studio xác nhận bản nháp đã lên lịch đúng giờ.
5. **Chờ tới giờ phát** → worker sweep `verify` chuyển job sang PUBLISHED. Sau 72 h: `channel collect
   --channel <id>` → nếu `collected 1` thì điền `channel-learning.md` §9; nếu `blocked`/`error`, đọc log,
   sửa selector trong `collect-stats.mjs` (adapter, được sửa) và ghi lại.
6. Xanh cả năm bước → bật `planning.enabled: true` cho kênh, rồi để hai worker chạy nền:

```bash
pnpm harness --project E:/ops-studio worker      # terminal 1
pnpm harness --project E:/ops-channel worker     # terminal 2
pnpm harness --project E:/ops-channel dashboard serve   # tuỳ chọn, http://127.0.0.1:5200/hub
```

## 7. Cập nhật mã sau này

Trên máy phát triển: merge local → `git push origin main`. Trên máy đích:

```bash
cd E:/YOUTUBE_OPERATIONS_HARNESS && git pull && pnpm install && pnpm build
pnpm harness --project E:/ops-studio db migrate && pnpm harness --project E:/ops-channel db migrate
pnpm harness --project E:/ops-studio skills sync && pnpm harness --project E:/ops-channel skills sync
```

Ops project và kho không nằm trong git; sao lưu `E:\ops-*\data\state\harness.db` và `E:\kho` theo cách
riêng của máy.

## 8. Điều chưa từng chạy thật (kiểm đầu tiên khi gãy)

- Bảy wrapper cho script cũ ở `D:\` — chưa viết.
- `claude -p` / `codex exec` với skill thật, `--allowedTools` cố định trong `RUNTIME_COMMANDS`
  (`packages/adapters/agent-cli/src/cli-agent-runtime.ts`).
- `upload-youtube-playwright.mjs` / `publish-video-playwright.mjs` được gọi từ harness thay vì từ phiên
  Claude Code cũ (`PlaywrightPublisher`).
- `collect-stats.mjs` trên Studio thật: chỉ bấm tab Reach, chờ nhãn ≤ 45 s mỗi tab, ngân sách 300 s.
- Hai worker dùng chung một Chrome profile: `resources: { browser: 1 }` chỉ khoá trong project kênh; studio
  không mở Chrome nên không đụng nhau.
