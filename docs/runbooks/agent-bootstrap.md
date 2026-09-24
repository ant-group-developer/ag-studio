# Hướng dẫn khởi động cho agent ở máy mới — từ `git clone` tới tập đầu tiên lên YouTube

**Đọc file này đầu tiên** nếu bạn là agent (Claude Code hoặc Codex) được mở trong repo này trên một máy chưa có gì.
Mục tiêu: dẫn người vận hành đi hết đường sản xuất một lần — dựng harness, dựng hai ops project (studio + kênh),
nạp kho, chạy một tập thật qua studio, đăng lên YouTube ở chế độ private theo lịch — rồi bật chế độ tự chạy.

Đây là **lộ trình**, không phải tài liệu tham chiếu. Mỗi bước trỏ tới runbook chi tiết; khi hai bên lệch nhau,
runbook chi tiết đúng, file này sai — sửa file này. Ngày viết: 2026-09-23, trạng thái `main` sau sub-project 5B.

---

## 0. Quy tắc bạn phải giữ trước khi gõ lệnh nào

1. Đọc và tuân thủ `AGENTS.md` (nguyên tắc chung, lệnh CLI, quy ước commit).
2. **Bí mật** chỉ tồn tại dưới dạng tham chiếu `secret://scope/name` trong YAML, giá trị nằm ở biến môi trường
   `HARNESS_SECRET_<SCOPE>_<NAME>` của shell chạy worker. Không bao giờ in giá trị, không bao giờ in `.env`,
   không commit `.env`. Nếu người vận hành dán bí mật vào chat, bảo họ đặt vào shell và không lặp lại giá trị.
3. Thư mục kênh cũ `D:\<kênh>` (hoặc tương đương) là **chỉ đọc**. Harness bọc script trong đó, không sửa.
4. Harness **không** dành cho nội dung hoạt hình. Không đề xuất, không thêm gì theo hướng đó.
5. Không bịa lệnh. Mọi lệnh trong file này có trong `AGENTS.md` hoặc runbook; nếu cần lệnh khác, `pnpm harness --help`
   trước, đọc mã sau, hỏi người sau cùng.
6. Việc chỉ người làm được (đăng nhập YouTube, cập nhật driver, cho phép cài đặt, quyết định giọng/thương hiệu) —
   **dừng lại, nói rõ cần gì, chờ**. Không tìm cách vòng qua.
7. Kết thúc mỗi pha: chạy `harness doctor` của project liên quan và đọc **nội dung** từng dòng, không chỉ exit code
   (một số dòng FAIL là cảnh báo có chủ ý — xem §4).

---

## 1. Máy cần gì (người chuẩn bị, agent kiểm)

| Cần | Kiểm bằng | Ghi chú |
|---|---|---|
| Node ≥ 22.13, `corepack enable` | `node -v`; `corepack enable && pnpm -v` (pnpm ghim trong `packageManager`) | |
| git | `git --version` | GitHub CLI không bắt buộc |
| ffmpeg + ffprobe trên PATH, build có `libass`, `xfade`, `loudnorm`, `sidechaincompress`, `overlay`, `libx264` | `ffmpeg -hide_banner -filters` rồi tìm 5 filter đó; `harness doctor` dòng `media:render` kiểm lại | Bản gyan.dev "essentials" 8.x đủ. NVENC cần driver NVIDIA ≥ 610.00; thiếu thì render bằng CPU, vẫn chạy |
| GPU NVIDIA + CUDA 12.x (cho transcript/TTS thật) | `nvidia-smi` | RTX 3060 12 GB đo đỉnh ~4,1 GB VRAM; 8 GB đủ; `device: cpu` chạy được nhưng quá chậm |
| Python 3.11 + ~20 GB đĩa trống (venv + mô hình) | `py -3.11 --version` | Chỉ cần khi `adapters.media: python` |
| Chrome (cho đăng YouTube qua Playwright) | có trên máy | Hồ sơ đăng nhập `.upload-profile` gắn với **từng máy**, không copy được |

Windows: chạy mọi thứ trong một shell (PowerShell hoặc Git Bash) và đặt biến môi trường ở **đúng shell đó**;
`HF_HOME` phải có trong shell chạy worker, không chỉ lúc tải mô hình.

---

## 2. Dựng repo (agent làm)

```bash
git clone https://github.com/hieuhoangwm01-star/YOUTUBE_OPERATIONS_HARNESS E:/YOUTUBE_OPERATIONS_HARNESS
cd E:/YOUTUBE_OPERATIONS_HARNESS
corepack enable && pnpm install && pnpm build && pnpm test
```

`pnpm test` mất 5–8 phút và **phải xanh**. Nhóm file có thể đỏ vì máy quá tải (chạy lại riêng file đó trước khi
kết luận): `library-pipeline`, `06-stale-scope`, `16-secret-e2e`, `07-thumbnail`, footage gpu-serialization,
worker lease, `21`/`26` reconcile, `artifacts/registry`, `media-stages`. Nếu vẫn đỏ sau khi chạy riêng: đó là lỗi
thật của máy (thường thiếu ffmpeg hoặc Node cũ) — sửa máy, không sửa test.

Repo này chỉ để `git pull`/`git push`. **Không** đặt dữ liệu, kho, ops project bên trong.

---

## 3. Bố trí trên một máy hai vai (agent tạo, người xác nhận đường dẫn)

```
E:\YOUTUBE_OPERATIONS_HARNESS\   # repo
E:\ops-studio\                   # ops project vai studio (copy từ project-template/)
E:\ops-channel\                  # ops project vai kênh (copy từ project-template/)
E:\kho\                          # kho chung: styles/ requests/ items/ voices/ music/ (brands/ tự tạo)
D:\<kênh>\                       # repo kênh cũ, CHỈ ĐỌC: scripts/, .upload-profile/, outputs/
```

- `library.root` ở **cả hai** `project.yaml` phải viết **giống hệt** nhau (hoa/thường, dấu gạch).
- Tạo kho: `mkdir -p E:/kho/styles E:/kho/requests E:/kho/items E:/kho/voices E:/kho/music` (doctor không tự tạo).
- Studio: copy `project-template/` → `E:\ops-studio`, sửa `project.yaml` theo `docs/runbooks/go-live.md` §4
  (`library.role: studio`, `auto_accept`, `adapters.agent: cli`, `adapters.media: python` + khối `media:`,
  `media.render`). Wrapper còn phải viết trong `executors/scripts.yaml` cho `library-production@1.3.0`: **đúng một** —
  `thumbnail-candidates`; thêm `collect-samples` nếu dùng `style-study@1.1.0`. `project-template/executors/scripts.yaml`
  còn liệt kê nhiều wrapper cũ (`cut`, `assemble`, `tts`…) — cắt bớt theo go-live, không tin bản mẫu.
- Kênh: copy `project-template/` → `E:\ops-channel`, sửa `project.yaml` theo go-live §7 (`library.role: channel`,
  `adapters.publisher: playwright`, `adapters.stats: playwright`, `resources: { browser: 1 }`), xoá `executors/` và
  `source-catalog/` (mọi stage của kênh là built-in). Tạo `channels/<channel_id>/channel.yaml` từ
  `project-template/channels/example/channel.yaml`: `repo_dir` **tuyệt đối** tới `D:\<kênh>`, `legacy_project_id` và
  `youtube.expected_channel_id` chép từ `D:\<kênh>\channel.config.json`, `episode.start` = số tập kế, `planning.enabled: false`
  (bật sau khi tập đầu đi trọn vòng).

Kiểm: `pnpm harness --project E:/ops-studio doctor` và `pnpm harness --project E:/ops-channel doctor`.

---

## 4. Đọc `harness doctor` cho đúng

- Mọi dòng `ok` → bước đó xong.
- FAIL là **cảnh báo có chủ ý**, không chặn: `media:models` ("will download on first run"), `media:render`
  ("no NVENC, renders on CPU"). Exit code vẫn là 1 — đọc chữ.
- FAIL phải sửa: `library:*` (thiếu thư mục kho, không ghi được), `media:python|packages|device` (venv sai),
  `channel:<id>:repo|scripts|profile|identity|secrets` (đường dẫn, script kênh cũ, hồ sơ đăng nhập, email, bí mật),
  `agent:runtime` (`claude`/`codex` không có trên PATH), `channels:config` (một kênh sai làm **ẩn** mọi dòng của mọi kênh).
- `library:auto_accept` FAIL khi `source_collections` không khớp source nào hoặc `adapters.agent: fake` — phải sửa
  trước khi bật autopilot.

---

## 5. Engine media thật (agent làm, cần mạng và ~20 GB)

Theo `engines/python/README.md`:

```bash
export PIP_CACHE_DIR=E:/pip-cache HF_HOME=E:/hf-cache
py -3.11 -m venv E:/harness-venv
P=E:/harness-venv/Scripts/python
$P -m pip install --upgrade pip
$P -m pip install torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu126
$P -m pip install -r engines/python/requirements.txt
$P -c "import torch, whisperx, omnivoice; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

Torch **phải** cài trước `requirements.txt`, không thì pip lấy bản CPU. Kết quả mong đợi `2.8.0+cu126 True <tên GPU>`.
Ghi `media.python: E:/harness-venv/Scripts/python.exe`, `media.device: cuda:0` vào `E:\ops-studio\project.yaml`.
Mô hình tải ở lần chạy đầu (WhisperX large-v3, OmniVoice) — lâu, cần mạng; `media:models` đỏ tới lúc đó là bình thường.

---

## 6. Nạp kho (người quyết, agent gõ lệnh)

Tất cả chạy ở **vai kênh** (`--project E:/ops-channel`) vì kênh là chủ của giọng, thương hiệu, nhạc:

1. **Giọng đọc** (bắt buộc nếu muốn `--voice tts`): người đưa clip mẫu 3–30 s và văn bản đọc trong clip.
   `harness library voices add --display-name "<tên>" --ref <wav> --ref-text "<văn bản>" --origin synthetic|own|licensed --language vi`
   → ghi `voice.voice_id` vào `channel.yaml`. Không nhân giọng người thật khi không có quyền.
2. **Thương hiệu**: người cung cấp font `.ttf`/`.otf` có đủ dấu tiếng Việt (Be Vietnam Pro, Noto Sans, hoặc Arial hệ thống
   để thử), logo `.png`, bảng màu. Agent viết `brand.json` theo `docs/runbooks/studio-composition.md` §2, rồi
   `harness library brands set <channel_id> --from <dir>/brand.json`. Không có brand thì tập vẫn dựng: không chữ,
   không logo, không nhạc, phụ đề chỉ file rời.
3. **Nhạc nền**: người cung cấp file có giấy phép. `harness library music add --track-id <id> --file <wav|mp3> --display-name "<tên>" --mood calm,neutral --origin royalty_free --origin-note "<nguồn>" --loop-ok`
   và liệt kê id trong `brand.json` → `music.tracks`.
4. **Phong cách dựng**: cần ít nhất một `edit-style` `active` trong kho. Đường chuẩn là `style-study@1.1.0` ở studio
   (`source ingest` 2–3 video mẫu → `content create` → `plan --workflow style-study@1.1.0 --profile studio` → `enqueue` →
   `worker --once` tới SUCCEEDED → `library styles activate <style_id>`). Cần wrapper `collect-samples`.

Kiểm: `harness --project E:/ops-channel doctor` có `channel:<id>:voice`, `channel:<id>:brand` `ok`; `library music list`.

---

## 7. Nguồn quay (người đưa file, agent ingest — vai studio)

```bash
pnpm harness --project E:/ops-studio source ingest <thư mục quay> --collection shoot-2026-09-30 --rights cleared --language vi --recursive
```

Một buổi quay = một collection `shoot-*`; `library.auto_accept.source_collections: ["shoot-*"]` cho phép autopilot lấy
cả buổi cho một request. Nguồn 1080p vẫn ra 4K (phóng lên), nguồn khác tỉ lệ pad/crop theo `brand.source_fit`.

---

## 8. Tập đầu tiên, làm tay từng nấc (agent điều khiển, người xem kết quả)

Chưa bật `planning`, chưa chạy worker dài. Mỗi nấc xanh mới sang nấc sau.

1. **Kênh tạo request**:
   ```bash
   pnpm harness --project E:/ops-channel library request create --portfolio portfolio-channel --channel <channel_id> \
     --topic "<chủ đề>" --style <style_id> --duration 600,900 --voice tts --voice-id <voice_id> --language vi --source-hint shoot-2026-09-30
   ```
   `--duration min,max` **bắt buộc** (thiếu thì studio kẹt ở cuối). `--voice tts` cần giọng `active`.
2. **Studio dựng**: lặp `pnpm harness --project E:/ops-studio worker --once` tới khi run SUCCEEDED (15 stage của
   `library-production@1.3.0`; GPU chạy `media-transcribe`, `media-tts`, `media-render`). Kiểm trong workspace run:
   `render-report.json` (`encoder`, `transitions.downgraded`, `loudness` trong [−16,−12], `warnings`),
   `fit-report.json` (`shortfalls` rỗng), item trong kho có `episode.mp4`, `captions.srt`, `captions.vtt`.
   Review từ chối → autopilot replan tối đa `max_replans` rồi `request_stuck` — đọc `note` để biết vì sao.
3. **Người xem tập**: dừng và đưa đường dẫn `episode.mp4` + 2–3 khung có phụ đề. Người chốt dấu tiếng Việt, chữ,
   nhạc, ducking. Không đạt → sửa brand/giọng/lời rồi tạo request mới; không sửa file trong kho bằng tay.
4. **Kênh đăng nhập YouTube (chỉ người)**: `pnpm harness --project E:/ops-channel channel login <channel_id>` mở Chrome với
   `.upload-profile` của repo kênh; người đăng nhập tay (kể cả 2FA). Làm **trên chính máy này**, một lần cho mỗi kênh.
   Đặt `HARNESS_SECRET_YOUTUBE_<KÊNH>_EMAIL=<email đăng nhập>` trong shell chạy worker (chỉ để đối chiếu danh tính).
   Kiểm: `doctor` có `channel:<id>:profile`, `:identity`, `:secrets` `ok`.
5. **Kênh đóng gói và lên lịch**: `library sync` → `channel pick-next <channel_id>` → lặp `worker --once` tới khi
   `publish list` cho job `SCHEDULED`. Stage `package` là lần chạy agent thật đầu tiên (`claude -p`/`codex exec` với skill
   `channel-package`) — nếu `agent:runtime` FAIL, dừng và bảo người cài CLI agent lên PATH.
   Video lên YouTube ở **private** rồi YouTube tự công khai đúng giờ hẹn; harness không có nút "public" riêng.
6. **Sau giờ hẹn**: worker `verify` chuyển job sang `PUBLISHED`. Sau 72 giờ: `channel collect --channel <channel_id>`.

---

## 9. Bật chế độ tự chạy (khi §8 xanh trọn vòng)

1. `channels/<id>/channel.yaml`: `planning.enabled: true`.
2. Hai worker dài hạn, hai terminal, biến môi trường bí mật và `HF_HOME` đặt sẵn ở cả hai:
   ```bash
   pnpm harness --project E:/ops-studio worker
   pnpm harness --project E:/ops-channel worker
   ```
3. Tuỳ chọn: `pnpm harness --project E:/ops-channel dashboard serve` → `http://127.0.0.1:5200/hub` (chỉ máy này, chỉ đọc).
4. Mỗi ngày nhìn alert trên dashboard: `request_stuck`, `stage_waiting_human`, `media_engine_unavailable`,
   `render_cpu_fallback`, `doctor`.

---

## 10. Sự cố hay gặp và cách xử lý

| Dấu hiệu | Nghĩa | Làm gì |
|---|---|---|
| Stage `WAITING_HUMAN` ở `intake` | giọng/brand trong kho hỏng hoặc lệch checksum | sửa kho (vai kênh), rồi `harness retry <run_id> --stage intake`; request vẫn `open` |
| Run FAILED ở `plan-edit`/`media-index` (`edl-valid`, `overlays-valid`) | **lỗ hổng đã biết**: request kẹt `claimed` mãi, không alert | mở lại request bằng tay trong kho (`status: open`), hoặc `library accept --request <id>` rồi `plan` run mới. Việc sửa gốc đang ở deferred-items "Sau sub-project 5B" #1 |
| `render-valid` fail "integrated loudness out of range" | hệ số đỉnh của lời > 13 dB, `loudnorm` lùi về dynamic | xem `render-report.warnings` có `loudnorm_not_linear`; hiện chưa có sửa tự động (deferred #2); tạm thời đổi lời/giọng, hoặc render tay với limiter |
| `media:render` "no NVENC" | driver < 610 | chấp nhận CPU (chậm ~10×) hoặc người cập nhật driver NVIDIA |
| Stage GPU `transient`/timeout | OOM hoặc tải mô hình lâu | `harness retry <run_id>`; nâng `default_deadline_seconds` trong profile nếu tái diễn |
| Workspace đầy đĩa | | `harness workspaces prune --days <n>`; cache mezzanine tự dọn theo `media.render.cache_max_gb` |
| Cần quay về bản dựng cũ | | `library.auto_accept.workflow_release: library-production@1.2.0` (cần lại wrapper `cut`, `assemble`) |

---

## 11. Những gì chưa ai chạy thật (bạn là người đầu tiên — báo cáo kỹ)

- Wrapper `thumbnail-candidates` (và `collect-samples`) bọc script kênh cũ: chưa viết.
- `claude -p`/`codex exec` với skill thật ở stage `package`/`plan-edit`/`library-review`: chưa chạy trong harness.
- `upload-youtube-playwright.mjs`/`publish-video-playwright.mjs` gọi từ harness: chưa chạy.
- NVENC: chưa máy nào đủ driver; mọi đường NVENC chỉ có test giả.
- Engine Python trên máy khác máy build: chưa kiểm.
- Bitrate 4K trên footage thật: chưa đo (số hiện có là footage tổng hợp phẳng, không dùng để chỉnh `-cq`/`-crf`).

Gặp lỗi ở các chỗ này: ghi lại lệnh, output (đã che bí mật), `render-report.json`/`stage-result.json` liên quan, rồi
đề xuất sửa trong repo theo đúng quy trình `AGENTS.md` (nhánh, test, commit có trailer). Không vá tay ngoài repo.

---

## 12. Báo cáo cuối mỗi phiên

Trả lời người vận hành bằng tiếng Việt, ngắn: pha đang ở, dòng doctor còn đỏ và nghĩa của nó, việc đang chờ người
(đúng một câu mỗi việc), đường dẫn tới thứ họ cần xem. Không dán log dài, không dán bí mật.

Tài liệu chi tiết: `docs/runbooks/go-live.md` (bố trí hai vai), `studio-media.md` (5A: engine, giọng, khớp hình),
`studio-composition.md` (5B: brand, nhạc, chữ, phụ đề, render), `channel-publish.md` (kênh: đăng nhập, đóng gói, đăng),
`docs/operations/deferred-items.md` (lỗ hổng đã biết).

---

## Phụ lục — prompt đầu tiên để dán vào agent trên máy mới

Người vận hành mở Claude Code (hoặc Codex) trong thư mục repo vừa clone và dán nguyên khối dưới đây:

```text
Bạn là agent vận hành YouTube Operations Harness trên một máy mới. Đọc docs/runbooks/agent-bootstrap.md và AGENTS.md trước, tuân thủ mọi quy tắc trong đó (bí mật chỉ qua biến môi trường, thư mục kênh cũ chỉ đọc, không bịa lệnh, không nội dung hoạt hình, việc nào chỉ người làm được thì dừng và hỏi).

Trước khi chạy bất kỳ lệnh nào, hỏi tôi đúng ba nhóm thông tin sau, mỗi nhóm một câu hỏi, chờ tôi trả lời rồi mới hỏi tiếp:
1. Kho chung đặt ở đâu (đường dẫn tuyệt đối, ví dụ E:/kho) và hai ops project đặt ở đâu (ví dụ E:/ops-studio, E:/ops-channel).
2. Số kênh muốn làm ban đầu, và với mỗi kênh: channel_id ngắn không dấu, thị trường/ngách nội dung, ngôn ngữ, đường dẫn tuyệt đối tới repo kênh cũ trên máy này (nơi có channel.config.json, scripts/, .upload-profile/), số tập kế tiếp.
3. Tài nguyên có sẵn cho từng kênh: clip giọng mẫu (hoặc chưa có), font/logo/màu thương hiệu (hoặc chưa có), nhạc nền có giấy phép (hoặc chưa có), thư mục footage đã quay (hoặc chưa có).

Sau khi có đủ, làm theo agent-bootstrap.md từ mục 1 tới mục 8 theo đúng thứ tự: kiểm máy, dựng repo, tạo kho và hai ops project (mỗi kênh một channels/<id>/channel.yaml, planning tắt), chạy harness doctor cho cả hai project và giải thích từng dòng đỏ, dựng venv GPU nếu máy có GPU NVIDIA, nạp kho theo những gì tôi đã cung cấp, ingest footage, rồi dựng tập đầu tiên cho một kênh duy nhất trước.

Dừng lại và báo tôi ở đúng những điểm sau: khi cần tôi cung cấp file (giọng, font, logo, nhạc, footage); khi cần tôi đăng nhập YouTube qua harness channel login; khi tập đầu đã dựng xong để tôi xem; khi có dòng doctor đỏ mà bạn không sửa được. Tuyệt đối không tự tạo request, không bật planning, không chạy worker dài hạn khi chưa được tôi đồng ý.

Cuối mỗi lượt trả lời: tình trạng từng pha (xong / đang / chờ tôi), việc đang chờ tôi (mỗi việc một câu), đường dẫn tới thứ tôi cần xem. Trả lời bằng tiếng Việt, không dán log dài, không in bí mật.
```

Ba câu hỏi ở đầu là cố ý: kho và ops project (mục 3), số kênh và thông tin từng kênh (mục 3 + `channel.yaml`), tài nguyên
nạp kho (mục 6–7). Agent không được đoán những thứ này.
