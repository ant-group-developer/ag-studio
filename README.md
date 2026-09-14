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

## Tài liệu
- Blueprint: `docs/architecture/YOUTUBE_OPERATIONS_HARNESS_BLUEPRINT_v1.0.md`
- Spec: `docs/superpowers/specs/2026-09-11-harness-structure-and-control-plane-design.md`, `docs/superpowers/specs/2026-09-12-sub-project-2-footage-production-design.md`, `docs/superpowers/specs/2026-09-14-sub-project-2c-content-library-design.md`
- Plan sub-project 1: `docs/superpowers/plans/2026-09-11-control-plane-minimal.md`
- Plan sub-project 2A: `docs/superpowers/plans/2026-09-12-sub-project-2a-catalog-planner-resources.md`
- Plan sub-project 2B: `docs/superpowers/plans/2026-09-13-sub-project-2b-scripts-gate-media-footage.md`
- Plan sub-project 2C: `docs/superpowers/plans/2026-09-14-sub-project-2c-content-library.md`
- ADR: `docs/adr/`
- Runbook: `docs/runbooks/` (`reconcile-and-retry.md`, `wrap-a-channel.md`, `content-library.md`)
- Project mới: copy `project-template/` (xem `docs/runbooks/wrap-a-channel.md` bước 1)

## Trạng thái
Sub-project 1 (control plane) + 2A (source catalog, content/variant, plan theo option, tài nguyên chia sẻ
trong claim, artifact thư mục, invalidation, cache) + 2B (script cũ bọc qua `@harness/script-sdk`, gate
người duyệt + `stage submit`, checker media qua ffprobe, ngân sách theo variant, `harness doctor`/`source
sync`, workflow + profile + fixture `footage`, `project-template/`) + 2C (kho nội dung chia sẻ giữa máy
studio và máy channel: `harness library sync|list|request|accept|review|pick|styles`, bốn stage kho built-in
(`intake`, `style-export`, `export`, `apply-review`), workflow `style-study` + `library-production`, profile
`studio`, worker tự đồng bộ kho khi rảnh) — adapter thật vẫn giả (HeyGen/TTS/YouTube), phát hành nội dung đã
`pick` (channel publish) để lại cho sub-project 3. Còn lại cho sub-project 3: adapter thật (HeyGen, TTS,
YouTube), reconcile với provider thật, workflow phát hành đọc `library_item_id` từ một `ContentItem` đã pick.
Sub-project 4: agent runtime thay executor `gate` (agent tự làm việc trong workspace thay vì người `stage
submit`) — kho có 5 gate cần người hôm nay (`analyze-style`, `style-review`, `survey-source`, `plan-edit`,
`library-review`).
