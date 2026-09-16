# YouTube Operations Harness

Control plane cho sản xuất và phân phối video nhiều kênh: state store SQLite, state machine Run/StageRun/Attempt, claim/lease/fencing, artifact manifest, worker, CLI.

## Bắt đầu

```bash
corepack enable && pnpm install
pnpm build && pnpm test
pnpm harness --project fixtures/ops-project-minimal db migrate

# đăng ký một nguồn, tạo content, plan một variant theo profile + option
pnpm harness --project fixtures/ops-project-minimal source ingest README.md
pnpm harness --project fixtures/ops-project-minimal content create --title "Demo" --source <source_id>
pnpm harness --project fixtures/ops-project-minimal plan --workflow sample-three-stage@1.0.0 --profile cartoon --content <content_id>

pnpm harness --project fixtures/ops-project-minimal enqueue <run_id>
pnpm harness --project fixtures/ops-project-minimal worker --once
pnpm harness --project fixtures/ops-project-minimal status <run_id>

# tình trạng tài nguyên chia sẻ và dọn artifact mồ côi
pnpm harness --project fixtures/ops-project-minimal resources status
pnpm harness --project fixtures/ops-project-minimal artifacts sweep --dry-run
```

Plan cũng chạy được không cần catalog (`plan --workflow ... --profile ...` không có `--content`), như ở sub-project 1; `--option k=v` chỉ hợp lệ khi có `--content`.

## Quick-start: sản xuất footage trên fixture

`fixtures/ops-project-footage` là một ops project đầy đủ (workflow `footage-production`, profile `footage`,
`executors/scripts.yaml` trỏ tới các wrapper giả dùng `@harness/script-sdk` + ffmpeg thật) nhưng không kèm
sẵn footage — cần một file nguồn trước. Cần `ffmpeg`/`ffprobe` trên PATH (không có thì các stage dựng video
sẽ fail transient; `harness doctor` báo rõ dòng `ffprobe`).

```bash
pnpm build
pnpm harness --project fixtures/ops-project-footage db migrate

# 1. một nguồn thật (thay bằng footage của bạn nếu có; lệnh dưới dựng một clip test 5s)
mkdir -p fixtures/ops-project-footage/raw
ffmpeg -y -f lavfi -i testsrc=duration=5:size=320x180:rate=25 -f lavfi -i sine=frequency=440:duration=5 \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest \
  fixtures/ops-project-footage/raw/sample-5s.mp4

# 2. doctor trước khi chạy gì — kiểm migration, wrapper, secret, tài nguyên. FAIL
#    secret:avatar:HEYGEN_API_KEY ở đây là bình thường: walkthrough này không dùng --option avatar=heygen,
#    nên không cần set HARNESS_SECRET_HEYGEN_MAIN (scripts.yaml khai env_refs cho stage avatar dù có dùng hay không).
#    Muốn doctor xanh hết (thoát 0): set biến đó trước, ví dụ HARNESS_SECRET_HEYGEN_MAIN=x.
#    `source-catalog/sources.yaml` của fixture cố ý để `sources: []` (raw/ bị git-ignore, test tự sinh
#    file mẫu + sources.yaml riêng trong project tạm), nên dòng `sources` xanh trên bản vừa clone.
HARNESS_SECRET_HEYGEN_MAIN=x pnpm harness --project fixtures/ops-project-footage doctor

# 3. ingest, tạo content
pnpm harness --project fixtures/ops-project-footage source ingest fixtures/ops-project-footage/raw/sample-5s.mp4 --json
pnpm harness --project fixtures/ops-project-footage content create --title "Demo footage" --source <source_id> --json

# 4. plan hai variant của cùng content (voice khác nhau đổi cache key -> hai run/artifact riêng)
pnpm harness --project fixtures/ops-project-footage plan --workflow footage-production@1.0.0 --profile footage --content <content_id> --option voice=original --json
pnpm harness --project fixtures/ops-project-footage plan --workflow footage-production@1.0.0 --profile footage --content <content_id> --option voice=tts --json

pnpm harness --project fixtures/ops-project-footage enqueue <run_id_original>
pnpm harness --project fixtures/ops-project-footage enqueue <run_id_tts>

# 5. worker: lặp lại tới khi in ra "idle" (dừng khi cả hai run đều cần một gate hoặc đã hết việc)
pnpm harness --project fixtures/ops-project-footage worker --once

# 6. mỗi gate (select-topic, write-script, edit-plan, thumbnail-qc) đỗ WAITING_HUMAN với brief.md sẵn
#    trong workspace của attempt (đường dẫn: `status --json` -> stages[].attempts[-1].workspace_uri) —
#    viết output theo brief.md rồi:
pnpm harness --project fixtures/ops-project-footage stage submit <stage_run_id>
# lặp lại bước 5-6 tới khi cả hai run SUCCEEDED

# 7. xem kết quả
pnpm harness --project fixtures/ops-project-footage status <run_id_original>
```

Dọn sau khi thử: `rm -rf fixtures/ops-project-footage/data fixtures/ops-project-footage/raw` (state store và
nguồn vừa tạo không commit vào repo). Chi tiết nối một kênh thật (script cũ, secret, external operation có
phí) ở `docs/runbooks/wrap-a-channel.md`.

## Quick-start: kho nội dung trên hai fixture (studio + channel)

`fixtures/ops-project-studio` (vai `studio`, workflow `style-study` + `library-production`) và
`fixtures/ops-project-channel` (vai `channel`, không chạy workflow nào) mount cùng một kho. `library/` của cả
hai fixture bị git-ignore và không có sẵn trên một bản clone mới, nên bước đầu là tạo một kho tạm và trỏ cả
hai `project.yaml` vào đó (đây là con đường `library.root` tạm, giống cách `tests/integration/
library-helpers.ts`'s `freshLibraryWorld()` làm — không phải mount SMB/NAS thật, xem
`docs/runbooks/content-library.md` mục 1 cho việc đó). Cần `ffmpeg`/`ffprobe` trên PATH.

Tạo thư mục kho tạm rồi **sửa tay** dòng `library:` trong `project.yaml` của cả hai fixture cho `root` trỏ
vào đó (`sed -i` không portable: khác nhau giữa GNU/BSD và không có trên PowerShell). Cách không cần editor,
chạy được mọi nơi có Node:

```bash
pnpm build
lib=$(node -e "const{mkdtempSync,mkdirSync}=require('fs'),{join}=require('path');const d=mkdtempSync(join(require('os').tmpdir(),'kho-'));for(const s of ['styles','requests','items'])mkdirSync(join(d,s));console.log(d)")

# trỏ library.root của cả hai fixture vào kho tạm vừa tạo
node -e "const fs=require('fs');for(const p of ['fixtures/ops-project-studio/project.yaml','fixtures/ops-project-channel/project.yaml'])fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('root: ./library','root: '+JSON.stringify(process.argv[1]).slice(1,-1)))" "$lib"

pnpm harness --project fixtures/ops-project-studio db migrate
pnpm harness --project fixtures/ops-project-channel db migrate
pnpm harness --project fixtures/ops-project-studio doctor    # library:root/write/index phải ok
pnpm harness --project fixtures/ops-project-channel doctor

# 1. style-study: học một style rồi xuất vào kho (4 stage, hai gate)
mkdir -p fixtures/ops-project-studio/raw
ffmpeg -y -f lavfi -i testsrc=duration=5:size=320x180:rate=25 -f lavfi -i sine=frequency=440:duration=5 \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest \
  fixtures/ops-project-studio/raw/sample-5s.mp4
echo fixtures/ops-project-studio/raw/sample-5s.mp4 > fixtures/ops-project-studio/raw/samples.txt
pnpm harness --project fixtures/ops-project-studio source ingest fixtures/ops-project-studio/raw/samples.txt --rights cleared --json
pnpm harness --project fixtures/ops-project-studio content create --title "Học style demo" --source <source_id> --json
pnpm harness --project fixtures/ops-project-studio plan --workflow style-study@1.0.0 --profile studio --content <content_id> --json
pnpm harness --project fixtures/ops-project-studio enqueue <run_id>
pnpm harness --project fixtures/ops-project-studio worker --once   # collect-samples chạy, analyze-style đỗ WAITING_HUMAN

# viết output/style.json (status: draft, style_id tự chọn — một chuỗi ULID có tiền tố style_) +
# output/evidence/ theo brief.md của gate analyze-style, rồi
pnpm harness --project fixtures/ops-project-studio stage submit <stage_run_id_analyze_style>
pnpm harness --project fixtures/ops-project-studio worker --once   # style-review đỗ WAITING_HUMAN

# sửa output/style.json thành status: active rồi
pnpm harness --project fixtures/ops-project-studio stage submit <stage_run_id_style_review>
pnpm harness --project fixtures/ops-project-studio worker --once   # style-export ghi styles/<style_id>/ vào kho, run SUCCEEDED

# 2. channel xin nội dung theo style vừa học
pnpm harness --project fixtures/ops-project-channel library request create \
  --portfolio portfolio-channel --channel channel-one --topic "chợ nổi Cái Răng" \
  --style <style_id> --voice none --duration 1,60 --json

# 3. studio: đồng bộ, ingest nguồn dựng, accept request, plan + enqueue
pnpm harness --project fixtures/ops-project-studio library sync --json
pnpm harness --project fixtures/ops-project-studio source ingest fixtures/ops-project-studio/raw/sample-5s.mp4 --rights cleared --json
pnpm harness --project fixtures/ops-project-studio library accept --request <request_id> --source <source_id> --json
pnpm harness --project fixtures/ops-project-studio plan --workflow library-production@1.0.0 --profile studio --content <content_id> --option voice=none --json
pnpm harness --project fixtures/ops-project-studio enqueue <run_id>
pnpm harness --project fixtures/ops-project-studio worker --once   # intake + index-source, survey-source đỗ WAITING_HUMAN

# ba gate lần lượt — survey-source (survey.md), plan-edit (edl.json theo EdlSchema, edit-plan.json,
# narration.txt), library-review (review.json { decision: "approved", note }) — mỗi lần:
pnpm harness --project fixtures/ops-project-studio stage submit <stage_run_id>
pnpm harness --project fixtures/ops-project-studio worker --once   # lặp lại tới khi run SUCCEEDED

# 4. channel: đồng bộ rồi nhận item vừa duyệt
pnpm harness --project fixtures/ops-project-channel library sync --json
pnpm harness --project fixtures/ops-project-channel library pick <item_id> --channel channel-one --json
```

Chi tiết đầy đủ (mount thật, hai chu trình studio/channel, xử lý sự cố `corrupt`/`missing`/request kẹt
`claimed`/item `withdrawn`) ở `docs/runbooks/content-library.md`. Dọn sau khi thử:

```bash
rm -rf fixtures/ops-project-studio/data fixtures/ops-project-channel/data fixtures/ops-project-studio/raw
git checkout -- fixtures/ops-project-studio/project.yaml fixtures/ops-project-channel/project.yaml
```

## Quick-start: studio tự vận hành (sub-project 4, agent giả)

`fixtures/ops-project-studio/project.yaml` đã bật sẵn `library.auto_accept` và trỏ `adapters.agent_argv` vào
`fixtures/fake-agent-cli.mjs` (đứng thay `claude -p`/`codex exec` — cần `claude`/`codex` thật trên PATH để
chạy skill thật, xem `docs/runbooks/studio-autopilot.md` mục "DoD #3"), nên chu trình dưới đây không cần đổi
gì trong workflow/profile — chỉ cần trỏ cả hai fixture vào cùng một kho tạm **và** đổi hai đường dẫn tương
đối trong `project.yaml`/`samples.txt` thành tuyệt đối, vì chúng được một tiến trình con resolve theo
workspace của chính stage đó (`ScriptExecutor`/`CliAgentRuntime` đều spawn với `cwd` là workspace, không phải
thư mục project hay thư mục bạn gõ lệnh) — `../fake-agent-cli.mjs` và một dòng tương đối trong `samples.txt`
đều sai theo cùng lý do đó. Cần `ffmpeg`/`ffprobe` trên PATH (stage `watch`).

```bash
pnpm build
lib=$(node -e "const{mkdtempSync,mkdirSync}=require('fs'),{join}=require('path');const d=mkdtempSync(join(require('os').tmpdir(),'kho-'));for(const s of ['styles','requests','items'])mkdirSync(join(d,s));console.log(d)")
node -e "const fs=require('fs');for(const p of ['fixtures/ops-project-studio/project.yaml','fixtures/ops-project-channel/project.yaml'])fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('root: ./library','root: '+JSON.stringify(process.argv[1]).slice(1,-1)))" "$lib"
node -e "const fs=require('fs'),path=require('path');const abs=path.resolve('fixtures/fake-agent-cli.mjs').split(path.sep).join('/');const p='fixtures/ops-project-studio/project.yaml';fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('../fake-agent-cli.mjs',abs))"

pnpm harness --project fixtures/ops-project-studio db migrate
pnpm harness --project fixtures/ops-project-channel db migrate
pnpm harness --project fixtures/ops-project-studio doctor   # library:auto_accept FAIL là bình thường:
                                                              # chưa có source nào trong collection "main"
                                                              # (dòng đó xanh sau bước 1 dưới)

# 1. style-study@1.1.0: một mẫu cục bộ, không cần người duyệt (analyze-style/style-review là agent, không
#    phải gate) -- agent giả mặc định ghi style "active" khi qua đủ checker
mkdir -p fixtures/ops-project-studio/raw
ffmpeg -y -f lavfi -i testsrc=duration=5:size=320x180:rate=25 -f lavfi -i sine=frequency=440:duration=5 \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest \
  fixtures/ops-project-studio/raw/sample-5s.mp4
node -e "console.log(require('path').resolve('fixtures/ops-project-studio/raw/sample-5s.mp4').split(require('path').sep).join('/'))" > fixtures/ops-project-studio/raw/samples.txt
pnpm harness --project fixtures/ops-project-studio source ingest fixtures/ops-project-studio/raw/samples.txt --rights cleared --json
pnpm harness --project fixtures/ops-project-studio content create --title "Học style demo (autopilot)" --source <source_id> --json
pnpm harness --project fixtures/ops-project-studio plan --workflow style-study@1.1.0 --profile studio --content <content_id> --json
pnpm harness --project fixtures/ops-project-studio enqueue <run_id>
pnpm harness --project fixtures/ops-project-studio worker --once   # lặp lại tới khi status <run_id> báo SUCCEEDED

# 2. một nguồn dựng cho auto-accept chọn (đường tuyệt đối, cùng lý do như samples.txt ở trên), rồi channel
#    tạo request với --source-hint
pnpm harness --project fixtures/ops-project-studio source ingest fixtures/ops-project-studio/raw/sample-5s.mp4 --rights cleared --json
pnpm harness --project fixtures/ops-project-channel library sync --json
pnpm harness --project fixtures/ops-project-channel library request create \
  --portfolio portfolio-channel --channel channel-one --topic "chợ nổi Cái Răng" \
  --style <style_id> --voice none --duration 1,60 --source-hint main --json

# 3. studio: chỉ `worker`, không lệnh người nào khác -- auto-accept tự đồng bộ, tự nhận request, tự plan,
#    tự chạy hết library-production@1.1.0 (13 stage, không gate nào)
pnpm harness --project fixtures/ops-project-studio worker --once   # lặp lại nhiều lần tới khi
pnpm harness --project fixtures/ops-project-studio library list requests --json   # thấy request "fulfilled"

# 4. channel: đồng bộ rồi nhận item vừa duyệt (bước duy nhất vẫn tay ở phía kênh)
pnpm harness --project fixtures/ops-project-channel library sync --json
pnpm harness --project fixtures/ops-project-channel library pick <item_id> --channel channel-one --json
```

Chi tiết đầy đủ (bật `auto_accept` trên một project thật, xử lý `WAITING_HUMAN` của stage agent,
`request_stuck`, `style-review` giữ draft, quay lại workflow `1.0.0` gate người, DoD #3) ở
`docs/runbooks/studio-autopilot.md`. Dọn sau khi thử:

```bash
rm -rf fixtures/ops-project-studio/data fixtures/ops-project-channel/data fixtures/ops-project-studio/raw
git checkout -- fixtures/ops-project-studio/project.yaml fixtures/ops-project-channel/project.yaml
```

## Quick-start: phát hành kênh trên fixture (studio → channel → YouTube)

`fixtures/ops-project-channel` (vai `channel`, workflow `channel-publish`, hai kênh `channel-one`/
`channel-two`) và `fixtures/legacy-channel-repo` (repo kênh cũ giả — script Playwright giả, không đụng
Chrome thật) minh hoạ sub-project 3: lấy một mục kho đã duyệt, đóng gói theo kênh, "đưa lên YouTube" (script
giả ghi `publish-queue.json`), đặt lịch, rồi xem qua `harness publish`/`harness dashboard`. Cần `ffmpeg`/
`ffprobe` trên PATH cho `fetch-library-item` (media-probe); `claude`/`codex` **không** cần cho quick-start
này — `project.yaml.adapters.agent_argv` của fixture đã trỏ tới một agent giả (`fake-agent-cli.mjs`), không
phải skill `channel-package` thật (xem `docs/runbooks/channel-publish.md` mục "DoD #6" cho cách chạy skill
thật).

`channels/*/channel.yaml` của fixture khai `repo_dir: ../legacy-channel-repo` — một đường dẫn **tương đối
theo thư mục làm việc thật của tiến trình `harness` lúc chạy** (Node `path.resolve()`, không theo
`--project`), đúng khi `harness` chạy với cwd = chính `fixtures/ops-project-channel/` (cách bộ test tích hợp
tự viết đường dẫn tuyệt đối, xem comment trong file); chạy từ gốc repo như mọi quick-start khác ở trên thì
`repo_dir` phải sửa thành đường tuyệt đối trước (cách một kênh thật khai, xem `project-template/channels/
example/channel.yaml`) — không có `sed -i` portable nên dùng Node:

```bash
pnpm build
pnpm harness --project fixtures/ops-project-channel db migrate

node -e "const fs=require('fs'),path=require('path');const abs=path.resolve('fixtures/legacy-channel-repo').split(path.sep).join('/');for(const p of ['fixtures/ops-project-channel/channels/channel-one/channel.yaml','fixtures/ops-project-channel/channels/channel-two/channel.yaml'])fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('repo_dir: ../legacy-channel-repo','repo_dir: '+abs))"
mkdir -p fixtures/ops-project-channel/library/styles fixtures/ops-project-channel/library/requests fixtures/ops-project-channel/library/items

# doctor: hai dòng channel:*:secrets FAIL cho tới khi set biến secret theo channel_id
#   (secret://youtube-channel-one/email -> HARNESS_SECRET_YOUTUBE_CHANNEL_ONE_EMAIL, khớp
#   channel.config.json.youtube.accountEmail = owner@example.com của repo giả). Mọi dòng khác phải ok.
HARNESS_SECRET_YOUTUBE_CHANNEL_ONE_EMAIL=owner@example.com \
HARNESS_SECRET_YOUTUBE_CHANNEL_TWO_EMAIL=owner@example.com \
pnpm harness --project fixtures/ops-project-channel doctor

pnpm harness --project fixtures/ops-project-channel channel list
```

Chu trình đầy đủ (kho → `pick` → `plan --workflow channel-publish@1.0.0 --profile channel` → `enqueue` →
worker → `publish list/show/slots` → `NEEDS_RECONCILIATION`/`reconcile` → `dashboard serve`), checklist
nghiệm thu dashboard, và cách chạy skill `channel-package` thật với `claude`/`codex` ở
`docs/runbooks/channel-publish.md`. Dọn sau khi thử:

```bash
rm -rf fixtures/ops-project-channel/data fixtures/ops-project-channel/library
git checkout -- fixtures/ops-project-channel/channels/channel-one/channel.yaml fixtures/ops-project-channel/channels/channel-two/channel.yaml
```

## Quick-start: vòng học kênh (sub-project 3B, agent + số liệu giả)

Tiếp trên hai fixture của mục "studio tự vận hành" ở trên (`ops-project-studio` + `ops-project-channel`, cùng
kho tạm) — `channels/channel-one/channel.yaml` của fixture đã bật sẵn `learning`/`planning`/`auto_pick`
(`channels/channel-two` cố tình tắt cả hai, xem comment trong file), và `project.yaml` của cả hai máy đã có
`adapters.stats: fake`/`learning: { collect_seconds: 60, collect_batch: 5 }` — không cần sửa gì thêm ngoài
đường dẫn tuyệt đối cho kho tạm + `fake-agent-cli.mjs` (giống mục "studio tự vận hành"). Cần `ffmpeg`/
`ffprobe` trên PATH (stage `watch` của studio).

```bash
pnpm build
lib=$(node -e "const{mkdtempSync,mkdirSync}=require('fs'),{join}=require('path');const d=mkdtempSync(join(require('os').tmpdir(),'kho-'));for(const s of ['styles','requests','items'])mkdirSync(join(d,s));console.log(d)")
node -e "const fs=require('fs');for(const p of ['fixtures/ops-project-studio/project.yaml','fixtures/ops-project-channel/project.yaml'])fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('root: ./library','root: '+JSON.stringify(process.argv[1]).slice(1,-1)))" "$lib"
node -e "const fs=require('fs'),path=require('path');const abs=path.resolve('fixtures/fake-agent-cli.mjs').split(path.sep).join('/');for(const p of ['fixtures/ops-project-studio/project.yaml','fixtures/ops-project-channel/project.yaml'])fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('../fake-agent-cli.mjs',abs))"
node -e "const fs=require('fs'),path=require('path');const abs=path.resolve('fixtures/legacy-channel-repo').split(path.sep).join('/');for(const p of ['fixtures/ops-project-channel/channels/channel-one/channel.yaml','fixtures/ops-project-channel/channels/channel-two/channel.yaml'])fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('repo_dir: ../legacy-channel-repo','repo_dir: '+abs))"

# channel-identity (checker của build-package) đòi cả hai secret suốt phiên -- export một lần, không chỉ cho
# doctor: publish-build-package/upload/schedule chạy trong tiến trình CLI con riêng (AGENTS.md "Lệnh 3"), mỗi
# tiến trình tự resolve lại.
export HARNESS_SECRET_YOUTUBE_CHANNEL_ONE_EMAIL=owner@example.com HARNESS_SECRET_YOUTUBE_CHANNEL_TWO_EMAIL=owner@example.com

pnpm harness --project fixtures/ops-project-studio db migrate
pnpm harness --project fixtures/ops-project-channel db migrate
pnpm harness --project fixtures/ops-project-channel doctor   # channel-one:stats/planning phải ok (adapters.stats: fake)

# 0. studio: học một style trước, y hệt mục "studio tự vận hành" -- create-requests (bước 2) cần một style
#    active để gán cho các request tự sinh
mkdir -p fixtures/ops-project-studio/raw
ffmpeg -y -f lavfi -i testsrc=duration=5:size=320x180:rate=25 -f lavfi -i sine=frequency=440:duration=5 \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest fixtures/ops-project-studio/raw/sample-5s.mp4
node -e "console.log(require('path').resolve('fixtures/ops-project-studio/raw/sample-5s.mp4').split(require('path').sep).join('/'))" > fixtures/ops-project-studio/raw/samples.txt
pnpm harness --project fixtures/ops-project-studio source ingest fixtures/ops-project-studio/raw/samples.txt --rights cleared --json
pnpm harness --project fixtures/ops-project-studio content create --title "Học style (3B)" --source <source_id> --json
pnpm harness --project fixtures/ops-project-studio plan --workflow style-study@1.1.0 --profile studio --content <content_id> --json
pnpm harness --project fixtures/ops-project-studio enqueue <run_id>
pnpm harness --project fixtures/ops-project-studio worker --once   # lặp lại tới khi status <run_id> báo SUCCEEDED
pnpm harness --project fixtures/ops-project-studio source ingest fixtures/ops-project-studio/raw/sample-5s.mp4 --rights cleared --json
pnpm harness --project fixtures/ops-project-channel library sync --json

# 1. kênh rỗng tự sinh request: channel-planning@1.0.0 (channel-brief -> demand -> propose-topics agent giả
#    -> create-requests), chạy tay bỏ qua cadence (planning.check_seconds)
pnpm harness --project fixtures/ops-project-channel channel demand channel-one --json   # needed=3 (chưa job/request nào)
pnpm harness --project fixtures/ops-project-channel channel plan-requests channel-one --json   # in ra run_id
pnpm harness --project fixtures/ops-project-channel worker --once   # lặp lại tới khi status <run_id> báo SUCCEEDED
pnpm harness --project fixtures/ops-project-channel library list requests --json   # 3 request "open", topic "auto-plan <run_id>: ..."

# 2. studio: worker tự nhận một request (auto_accept, y hệt mục "studio tự vận hành") -> item "approved"
pnpm harness --project fixtures/ops-project-studio worker --once   # lặp lại tới khi library list requests thấy 1 "fulfilled"
pnpm harness --project fixtures/ops-project-studio library list requests --json

# 3. kênh: tự pick (bỏ qua cadence auto_pick), phát tới SCHEDULED
pnpm harness --project fixtures/ops-project-channel library sync --json
pnpm harness --project fixtures/ops-project-channel channel pick-next channel-one --json   # in ra item_id + run_id
pnpm harness --project fixtures/ops-project-channel worker --once   # lặp lại tới khi status <run_id> báo SUCCEEDED
pnpm harness --project fixtures/ops-project-channel publish list --channel channel-one --json   # 1 job SCHEDULED

# 4. thu số (fake) + nhập sổ cũ -- job chưa PUBLISHED thật (không đợi được trong quick-start), nên minh hoạ
#    `metrics import` bằng chính youtube_video_id vừa upload (lấy id thật ở output publish list phía trên)
echo '{"videoId":"<youtube_video_id>","views":1234,"publishedAt":"2026-09-01T00:00:00.000Z"}' > /tmp/legacy-metrics.jsonl
pnpm harness --project fixtures/ops-project-channel channel metrics import channel-one /tmp/legacy-metrics.jsonl --json   # imported=1
pnpm harness --project fixtures/ops-project-channel channel collect --channel channel-one --json   # collected=0 (job chưa PUBLISHED)
pnpm harness --project fixtures/ops-project-channel channel learned channel-one --json   # standard rỗng, note "cần >=2 mẫu"
pnpm harness --project fixtures/ops-project-channel dashboard snapshot --json   # channels[].learning
```

Chu trình đầy đủ (đọc `channel learned`/`channel demand`, cách chuẩn kênh đổi, ba alert mới, sự cố
`stats_blocked`/`stats_failing`/`planning_failed`, nhập sổ cũ, quay về thủ công, DoD #4) ở
`docs/runbooks/channel-learning.md`. Dọn sau khi thử:

```bash
rm -rf fixtures/ops-project-studio/data fixtures/ops-project-channel/data fixtures/ops-project-studio/raw fixtures/ops-project-studio/library fixtures/ops-project-channel/library /tmp/legacy-metrics.jsonl
git checkout -- fixtures/ops-project-studio/project.yaml fixtures/ops-project-channel/project.yaml fixtures/ops-project-channel/channels/channel-one/channel.yaml fixtures/ops-project-channel/channels/channel-two/channel.yaml
```

## Tài liệu
- Blueprint: `docs/architecture/YOUTUBE_OPERATIONS_HARNESS_BLUEPRINT_v1.0.md`
- Spec: `docs/superpowers/specs/2026-09-11-harness-structure-and-control-plane-design.md`, `docs/superpowers/specs/2026-09-12-sub-project-2-footage-production-design.md`, `docs/superpowers/specs/2026-09-14-sub-project-2c-content-library-design.md`, `docs/superpowers/specs/2026-09-14-sub-project-3-channel-publish-design.md`, `docs/superpowers/specs/2026-09-15-sub-project-4-studio-autopilot-design.md`, `docs/superpowers/specs/2026-09-15-sub-project-3b-channel-learning-design.md`
- Plan sub-project 1: `docs/superpowers/plans/2026-09-11-control-plane-minimal.md`
- Plan sub-project 2A: `docs/superpowers/plans/2026-09-12-sub-project-2a-catalog-planner-resources.md`
- Plan sub-project 2B: `docs/superpowers/plans/2026-09-13-sub-project-2b-scripts-gate-media-footage.md`
- Plan sub-project 2C: `docs/superpowers/plans/2026-09-14-sub-project-2c-content-library.md`
- Plan sub-project 4: `docs/superpowers/plans/2026-09-15-sub-project-4-studio-autopilot.md`
- ADR: `docs/adr/`
- Runbook: `docs/runbooks/` (`go-live.md` — đưa lên máy thật, một máy hai vai; `reconcile-and-retry.md`, `wrap-a-channel.md`, `content-library.md`, `channel-publish.md`, `studio-autopilot.md`, `channel-learning.md`)
- Việc để lại: `docs/operations/deferred-items.md`
- Project mới: copy `project-template/` (xem `docs/runbooks/wrap-a-channel.md` bước 1; mẫu kênh ở `project-template/channels/example/channel.yaml`; khối `library.auto_accept` mẫu trong `project-template/project.yaml`)

## Trạng thái
Sub-project 1 (control plane) + 2A (source catalog, content/variant, plan theo option, tài nguyên chia sẻ
trong claim, artifact thư mục, invalidation, cache) + 2B (script cũ bọc qua `@harness/script-sdk`, gate
người duyệt + `stage submit`, checker media qua ffprobe, ngân sách theo variant, `harness doctor`/`source
sync`, workflow + profile + fixture `footage`, `project-template/`) + 2C (kho nội dung chia sẻ giữa máy
studio và máy channel: `harness library sync|list|request|accept|review|pick|styles`, bốn stage kho built-in
(`intake`, `style-export`, `export`, `apply-review`), workflow `style-study` + `library-production`, profile
`studio`, worker tự đồng bộ kho khi rảnh) + 3 (phát hành kênh: bảng `channel_package`/`publication_job` +
máy trạng thái riêng, workflow `channel-publish` (`fetch-library-item` → agent `package` → `build-package` →
`upload` → `schedule`, bốn stage built-in qua CLI con), cổng `Publisher` bọc script Playwright cũ của kênh
(`playwright` thật + `fake` cho test) thay vì gọi YouTube Data API, `@harness/adapter-agent-cli` chạy `claude
-p`/`codex exec` headless cho skill `channel-package`, `harness channel *`/`publish *`/`skills sync`/
`dashboard snapshot|serve`, sweep `verify` + `reconcile` theo trạng thái `PublicationJob`, dashboard chỉ đọc
từ `snapshot.json`) — adapter TTS/avatar (HeyGen) của sub-project 2 vẫn giả; upload/schedule YouTube giờ có
đường thật (bọc script cũ) nhưng cần đăng nhập Chrome tay và `claude`/`codex` thật trên máy (chưa kiểm được
trong môi trường build agent này, xem `docs/runbooks/channel-publish.md` mục "DoD #6") + 4 (studio tự vận
hành: năm gate người của kho (`analyze-style`, `style-review`, `survey-source`, `plan-edit`,
`library-review`) thành năm stage `agent` chạy skill (`skills/{style-analyze,style-review,source-survey,
edit-plan,library-review}/SKILL.md`), stage built-in `watch` (ffmpeg trích khung + contact sheet + hook
transcript tuỳ chọn) thay việc người tự xem video, worker studio tự nhận request kho qua `library.
auto_accept` (`harness library styles activate`, `library request create --source-hint`, doctor
`library:auto_accept`, dashboard alert `request_stuck`), workflow `style-study@1.1.0` +
`library-production@1.1.0` chạy song song với bản `1.0.0` gate-người cũ (`loadWorkflow`/`listWorkflowRefs`
hỗ trợ nhiều version cùng thư mục `workflows/`) — năm stage agent (ba của `library-production@1.1.0`, hai
của `style-study@1.1.0`) chưa được kiểm bằng `claude`/`codex` thật trong môi trường build agent này, xem
`docs/runbooks/studio-autopilot.md` mục "DoD #3") + 3B (vòng học kênh: cổng `StatsCollector` (`playwright`
đọc read-only ba tab Studio Analytics qua `collect-stats.mjs` + `fake`) và bảng `video_metrics` append-only,
`evaluateHypotheses` (`open → supported/refuted/void`) + `learnChannelStandard` (quy tắc thuần, nhóm theo
angle/mẫu tiêu đề/overlay, ngưỡng đổi chuẩn 10%, `channel_learned` + `history`), stage built-in `channel-brief`
vá lỗ hổng SP3 (gói giờ nhận `seo` + chuẩn kênh + giả thuyết đã đánh giá), workflow `channel-planning@1.0.0`
(agent `channel-plan` đề xuất chủ đề từ `channel-brief`/`demand`, được web) tự sinh `ContentRequest` tối đa
một run mỗi kênh mỗi ngày, `channel-publish@1.1.0` (profile `channel` revision 2) thêm stage `channel-brief`
trước `package`, ba sweep worker kênh mới (`maybeCollectStats`, `maybePlanRequests`, `maybeAutoPick` ưu tiên
request của chính kênh), `harness channel stats|learned|demand|collect|plan-requests|pick-next|metrics
import`, doctor `channel:<id>:stats|planning`, dashboard khối `learning` + alert
`stats_blocked|stats_failing|planning_failed` — cổng học không chặn phát hành, chỉ ưu tiên đề xuất kế tiếp;
thu số thật (`adapters.stats: playwright`) và agent `channel-plan`/`channel-package` thật chưa kiểm được
trong môi trường build agent này, xem `docs/runbooks/channel-learning.md` mục "DoD #4"). Còn lại: sửa
metadata video đã lên theo kết quả, YouTube Test & Compare, học chéo kênh (`fleetLessons`), mục tiêu doanh
thu/đăng ký, agent tự chọn nguồn phía studio, tự động hoá đăng nhập Studio (xem
`docs/operations/deferred-items.md`).
