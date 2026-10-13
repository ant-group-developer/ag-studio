# Tổng hợp để review: góp ý vòng 2026-10-12 (P1–P9)

Plan: `docs/superpowers/plans/2026-10-12-ag-studio-feedback-round.md`. Mọi commit trên nhánh `dev-duc` của bốn repo,
**chưa push**. Không commit nào có dòng Co-Authored-By / "Generated with".

| Repo | Commit mới | Kiểm tra (2026-10-13) |
|---|---|---|
| ag-studio | 21 (`096a257`…`42df6ce`) | `corepack pnpm -r run build`, `pnpm -r typecheck` sạch; `pnpm test`: 253 file, 1733 test pass, 178 skip |
| ag-farm | 15 (`aeb08f6`…`053f5f2`) | api unit 80/80, DB 77/77 (Postgres test 55433), web xanh, `yarn build` sạch; migration 1800–2200 đã chạy trên DB farm local |
| ag-render-worker | 8 (`77cd2b4`…`63250ce`, bản 0.9.0) | 139/139 |
| ag-scan-worker | 6 (`0037fae`…`6db675e`, bản 0.4.0) | 47/47 |

Xem code: `git log --stat origin/dev-duc..dev-duc` trong từng repo (ag-farm: `git log --stat 5dd56e1..dev-duc`).

---

## P1 — Admin thấy mọi nhóm, gợi ý đúng chỗ (ag-studio)

| Commit | Thay đổi | Chỗ xem code |
|---|---|---|
| `47cd9fb` | `GET /teams` tự hỏi `isAdmin` (guard không gán được vì route không có `@Roles`); trả `isMember` | `apps/api/src/teams/teams.controller.ts`, `teams-admin.spec.ts` |
| `382e47e` | Ô chọn nhóm "Nhóm của tôi" / "Nhóm khác" có tìm; breadcrumb, quyền tạo dự án cho admin; dải "Bạn đang xem với quyền admin" | `apps/web/src/modules/workspace/TeamPicker.tsx`, `use-team-role.ts` |
| `64a244d` | `playbookStatus(…, {scope})`: luồng video chỉ gợi ý bước video; bước cần thứ của kênh có `outsideRequires`; prompt agent theo phạm vi | `packages/studio-engine/src/workspace/playbook-status.ts` |
| `328ee7a` | Chip/rail theo trang, câu gợi ý chat trống theo ngữ cảnh, tên bước qua i18n | `apps/web/src/modules/playbook/step-text.ts`, `WorkspacePages.spec.tsx` |

**Kiểm trên web:** đăng nhập tài khoản admin → `/teams` thấy mọi nhóm, nhóm không phải thành viên có tag "Không là
thành viên"; ô chọn nhóm có "Nhóm khác", gõ tên để tìm. Chat của một video: chỉ gợi ý bước video (không còn "Nghiên cứu
thị trường"), cuối rail có "Kênh còn N bước chưa xong"; video có timeline mà kênh chưa có Branding: chip "Gói YouTube ·
kênh chưa có Branding". Đổi UI sang English: tên bước là tiếng Anh.

**Lưu ý:** hành động của admin trong nhóm không phải thành viên vẫn ghi vai `owner` trong nhật ký (như trước) — dải báo
không nói "ghi là admin".

## P2 — Video mẫu bị YouTube chặn (ag-studio)

| Commit | Thay đổi |
|---|---|
| `5026f1d` | `classifyYtDlp`/`YtDlpError`: mã + lý do tiếng Việt (youtube_blocked, private, …); giữ **đầu** dòng lỗi; bị chặn thì dừng ngay, video còn lại "bỏ qua"; job lỗi có `error_code` |
| `4336570` | `youtube.blocked_until` (6 giờ): agent không tạo thẻ chắc chắn hỏng, thẻ đang chờ có cảnh báo, `/queue` có banner cho admin |
| `a0a0a72` | Học phong cách từ video tự tải lên (`context/references/`, ≤ 300 MB, tool `style_from_files`, không cần thẻ); skill `agent-skills/edit-style` |

**Kiểm trên web:** tab Đầu vào → Tài liệu → mục "Video mẫu (học phong cách dựng)" → tải một mp4 → bảo agent học phong
cách từ video đó: job chạy ngay, tờ ghép ở `research/style-…/`, file gốc vẫn còn.

**Lưu ý triển khai:** từ đợt tải thẳng R2 (2026-10-13), file tải lên không còn qua nginx nên không cần nâng
`client_max_body_size` nữa. Thay vào đó bucket R2 phải bật CORS (runbook studio-local mục 4).

## P3 — Tab Xem trước nhanh (ag-studio)

| Commit | Thay đổi |
|---|---|
| `c93659d` | `GET videos/:id/renders` chỉ đọc DB (không còn `url` trong danh sách); `GET videos/:id/renders/:jobId/link` kiểm quyền + ký một bản |
| `a879520` | `FootageRights`: nhớ quyền theo (người, video ag-go) 10 phút, lỗi ag-go 30 giây; chỉ hỏi phần chưa biết; log khi > 2 s |
| `c770278` | Timeline/danh sách hiện ngay; player có khung "Đang lấy link xem…"; tải về xin link lúc bấm; Premiere tự tải vẫn chạy |

**Kiểm trên web:** mở tab Xem trước của video có bản render: danh sách hiện gần như tức thì, player chờ một lần hỏi ag-go
(1–3 s với timeline dài); mở lại tab / chọn bản khác cùng footage / sửa timeline rồi xem: phát ngay, log API không có lần
kiểm mới. **Đổi hợp đồng API:** client nào khác đọc `url` trong danh sách render phải chuyển sang route `/link`.

## P4 — Chat gọn, file đổi + diff (ag-studio)

| Commit | Thay đổi |
|---|---|
| `1bba1c0` | Bài học đề xuất hiện 1 + "Xem tất cả (N)"; bài mới hiện ngay (SSE) |
| `5a1cc0e` | Migration `0038`: `agent_messages.changed_files`; diff dòng tự viết (`workspace/line-diff.ts`); runner quét workspace trước và sau lượt |
| `30e03ed` | `GET projects/:id/files/versions/:versionId/diff?base` |
| `c5046c1` | Lượt xong thu thành "Đã làm N bước · thời gian" (đóng sẵn); việc nền của luồng thành một dòng |
| `eca5768` | Thẻ "N file đã thay đổi": Mở / Xem thay đổi (drawer diff); lịch sử file có "So với bản trước" |

**Kiểm trên web:** bảo agent sửa/tạo vài file → lượt xong chỉ còn một dòng tóm tắt + câu trả lời cuối + thẻ file đổi;
bấm "Xem thay đổi" ra diff xanh/đỏ. Lượt cũ (trước migration 0038) không có thẻ.

## P5 — Tab Đầu vào (ag-studio)

| Commit | Thay đổi |
|---|---|
| `b025923` | `GET audio` có `enabled`, `files` (cả audio tải qua tab Tệp), `libraryTrack`; `POST audio/music/from-library`; ffprobe mặc định cạnh ffmpeg; bỏ nhạc cần editor; audio ≤ 100 MB |
| `fec46a4` | Thẻ **Giọng đọc / Nhạc nền** ở đầu tab: tải lên, chọn file đã tải, chọn từ kho nhạc (nghe thử), không lời dẫn, tự chọn theo mood; nút mờ có lý do |
| `6f1c4e5` | Danh sách nguồn tính trạng thái một lượt + `counts`; sửa lỗi cũ: hàng đợi > 100 job làm video hiện "chưa chuẩn bị" |
| `aeec51e` | Thanh tóm tắt bấm để lọc; hai mục Footage / Tài liệu; tìm, lọc trạng thái, gom theo video, 30 dòng + "Xem thêm"; "Chuẩn bị các video chưa chuẩn bị", "Thử lại các video lỗi" |

**Kiểm trên web:** `/p/<id>` → Đầu vào: thẻ giọng/nhạc đứng đầu; vai editor thấy nút giọng mờ "Cần vai producer"; "Chọn
từ kho nhạc" nghe thử rồi chọn; dự án nhiều video: tóm tắt, chuyển Footage/Tài liệu, gom nhóm, làm hàng loạt.

## P6 — Thứ tự ưu tiên máy farm (ag-farm)

| Commit | Thay đổi |
|---|---|
| `aeb08f6` | `farm_nodes.priority_order` (migration 1800), `POST admin/nodes/reorder`, mặc định sắp theo thứ tự |
| `6a937da` | Claim: máy sau nhường job cho máy trước đang rảnh, đủ điều kiện; job chờ > `NODE_PRIORITY_GRACE_SECONDS` (10) thì máy nào cũng lấy; job ghim máy giữ nguyên (`modules/worker/node-priority.ts`) |
| `cf49ffe` | Trang Máy: cột "Thứ tự" + kéo thả (khi sắp theo Thứ tự, không tìm) |

**Kiểm trên web farm:** trang Máy kéo một dòng → "Đã lưu thứ tự worker"; Studio `/queue` hiện máy theo cùng thứ tự.

## P7 — Worker tự cài, tự cập nhật, tự nhận loại job (ag-farm + hai worker)

| Repo | Commit | Thay đổi |
|---|---|---|
| ag-farm | `ee0cb51`, `1629f60` | `install.ps1` chạy setup cả lúc cài và cập nhật; cập nhật **ghi lại config** (giữ name/token/khoá tự thêm, `.bak`) |
| ag-render-worker | `77cd2b4`, `1d96583` | `deploy/setup-render.ps1`: tự cài Python 3.11 (winget → python.org có kiểm chữ ký), venv, torch CUDA + thư viện khi có GPU, **yt-dlp** (nâng mỗi lần), tải trước model, bỏ qua pip khi không đổi |
| ag-farm | `e303852`; workers `d92d5af`, `ce30aed` | `kinds` trong config thành tuỳ chọn: worker tự báo loại job có handler và máy đủ điều kiện; `engines.ytdlp`; dò ffmpeg kèm theo |
| ag-farm | `65d7078` | `allowed_kinds` → `blocked_kinds` (migration 1900): loại job mới tự chạy; trang Máy có công tắc từng loại |
| ag-farm | `b977daf`; workers `03d3259`, `fdb95e3` | Tự cập nhật: xem `latest.json` 15 phút/lần, ngừng nhận việc, chờ việc xong, chạy task `ag-farm-updater`; không lên trong 3 phút thì **quay về bản cũ**; dự phòng 03:00 |
| ag-farm | `4dfb346` | Trang Máy: phiên bản so với bản mới nhất, trạng thái cập nhật, "Tự cập nhật", "Cập nhật ngay", máy thiếu gì |
| ag-farm | `b268711`; workers `6bf1f43`, `215e8cb` | `POST /v1/admin/releases`; `release.mjs --publish --upload` đẩy thẳng lên hub (khoá `FARM_RELEASE_KEY`), hết scp tay |

**Chưa kiểm thật:** cài/cập nhật trên máy Windows sạch (winget, chạy dưới SYSTEM, task `ag-farm-updater`, quay lui 3 phút)
— chỉ chạy được test script và `setup-render.ps1` trên máy này. **Nên thử trên một máy farm trước khi rải.** Bản dự phòng
03:00 không chờ việc xong (việc đang chạy lúc đó bị dừng). Một bản đã hỏng trên máy thì không tự thử lại; bấm "Cập nhật
ngay" để thử lại.

## P8 — Theo dõi tài nguyên máy (ag-farm)

| Commit | Thay đổi |
|---|---|
| `2a3e0d9` | SDK đo nền 15 s: CPU %, RAM, ổ (của work_dir/cache), mạng ↓↑ (Windows `netstat -e`), GPU %/VRAM/nhiệt độ; `metrics` tuỳ chọn trong heartbeat; tắt bằng `metrics: false` |
| `e4482f0` | `farm_nodes.metrics`, bảng `farm_machine_metrics` (mỗi phút, giữ `MACHINE_METRICS_KEEP_DAYS`=7), `GET /v1/admin/machines/:machine/metrics?range=1h|24h|7d` |
| `42d3c45` | Trang Máy: cột CPU/RAM/Ổ đĩa/Mạng/GPU có màu, sắp xếp, banner gộp, drawer biểu đồ |

Đo thật trên máy này: một lần đo 32–94 ms. **Kiểm:** sau khi máy chạy worker mới ~30 s, các cột có số; bấm ô sức khoẻ
mở biểu đồ.

## P9 — Tải video mẫu qua máy farm (ag-farm + ag-render-worker + ag-studio)

| Repo | Commit | Thay đổi |
|---|---|---|
| ag-farm | `94fd0e3`, `053f5f2` | `JobFailure(code, retryable)` trong SDK; job `studio.reference_fetch` (cần yt-dlp), chủ job có `studio.tts` tự có loại này (migration 2200) |
| ag-render-worker | `831f0a5`, `63250ce` | Handler chạy yt-dlp đúng cờ của Studio (không cookie), phân loại lỗi như Studio, đẩy lên bucket, xoá file trên máy; bản 0.9.0 |
| ag-studio | `42df6ce` | `style_watch` tải qua farm khi có máy nhận, không thì yt-dlp trên máy chủ; xoá object bucket + file nháp trong `finally`; nhớ chặn riêng máy chủ / farm; thẻ được tạo lại khi máy chủ bị chặn nhưng farm tải được |

Chạy thật trên máy văn phòng này: tải được một video YouTube công khai (IP văn phòng không bị chặn). **Kiểm:** có máy
render 0.9.0 có yt-dlp đang chạy → `/queue` (admin) báo "video mẫu tải qua máy farm (tên máy)" → bảo agent học phong
cách từ link YouTube → bấm thẻ → job hiện "Đang tải video mẫu 1/1 trên máy …" → `research/style-…/README.md`.

---

## Triển khai (thứ tự bắt buộc)

1. **Farm hub trước** (`deploy.sh` chạy migration 1800–2200). Thêm env `FARM_RELEASE_KEY` (+ tuỳ chọn
   `NODE_PRIORITY_GRACE_SECONDS`, `FARM_RELEASE_MAX_MB`, `MACHINE_METRICS_KEEP_DAYS`); `chown -R 1000:1000` thư mục
   releases; thêm block nginx cho route upload (xem `ag-farm/docs/deploy-vps.md` mục 5). Hub cũ sẽ từ chối heartbeat có
   trường mới, nên **không** đưa worker mới lên trước hub.
2. **Phát hành worker:** `node scripts/release.mjs --publish --upload <hub>` ở ag-render-worker (0.9.0) và ag-scan-worker
   (0.4.0), với `FARM_RELEASE_KEY` trong env.
3. **Mỗi máy farm chạy lệnh cập nhật một lần cuối bằng tay** (lệnh cài ở trang Máy, bỏ `-Code`). Từ đó tự cập nhật.
4. **Studio** (`deploy.sh`; migration 0038 chạy lúc API khởi động). Nginx của aaPanel cho body ≥ 300 MB.

## Chạy local để xem trên web

```bash
node scripts/local-stack.mjs up all
```

Studio web: http://localhost:3100 · farm web: http://localhost:3011 (cần đăng nhập Auth0). DB farm local đã chạy migration
mới; ag-farm đã `yarn build`. Khung trình duyệt của app desktop không polling: tải lại trang để thấy số mới.
