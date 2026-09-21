# Runbook: xưởng dựng có engine media thật (sub-project 5A)

Đích: bật `adapters.media: python` trên một máy studio có GPU, để `library-production@1.2.0` tự bóc cảnh, tự
nghe nguồn (WhisperX), tự đọc lời bình (OmniVoice) và tự khớp hình theo lời — thay vì `FakeMediaEngine` chỉ
dùng cho test.

Khác với các runbook trước, **mọi con số trong mục 7 là đo thật** trên máy build (RTX 3060 12 GB, Windows 11,
driver 581.29, Python 3.11.15), không phải ước lượng. Mục 9 chốt DoD #2 và #3 của spec.

Đọc kèm: `engines/python/README.md` (giao thức job/result của hai script), `studio-autopilot.md` (vòng tự
nhận request), `content-library.md` (kho), `go-live.md` §4 (dựng máy studio thật).

---

## 1. Điều kiện của máy, dựng venv, tải trước mô hình

Cần có sẵn:

- GPU NVIDIA với driver hỗ trợ CUDA 12.x. Đo trên RTX 3060 12 GB — đỉnh VRAM thật là **~4.1 GB**, nên card
  8 GB cũng đủ; `media.device: cpu` chạy được nhưng chậm tới mức không dùng được cho sản xuất.
- Python 3.11 (không cần trên PATH, chỉ cần biết đường dẫn tuyệt đối), `ffmpeg`/`ffprobe` trên PATH.
- **~20 GB đĩa trống** và mạng. Đặt tất cả ra ngoài ổ hệ điều hành nếu ổ C hẹp — **trừ** cache torch hub, xem
  cuối mục này.

Venv nằm **ngoài repo**; không có gì ở bước này được commit.

```sh
export PIP_CACHE_DIR=E:/pip-cache HF_HOME=E:/hf-cache

D:/tools/python311/python.exe -m venv E:/harness-venv
E:/harness-venv/Scripts/python -m pip install --upgrade pip

# torch TRƯỚC, từ index CUDA của PyTorch. Cài sau `requirements.txt` thì resolver lấy bản CPU.
E:/harness-venv/Scripts/python -m pip install torch==2.8.0 torchaudio==2.8.0 \
  --index-url https://download.pytorch.org/whl/cu126

E:/harness-venv/Scripts/python -m pip install -r engines/python/requirements.txt

E:/harness-venv/Scripts/python -c "import torch, whisperx, omnivoice; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
# 2.8.0+cu126 True NVIDIA GeForce RTX 3060
```

**Một venv hay hai?** Spec §10 dự phòng phương án hai venv vì sợ torch 2.8 của OmniVoice xung đột với phụ
thuộc của WhisperX trên Windows. **Không xảy ra**: trên máy build, `pip install -r requirements.txt` sau khi
đã có torch 2.8.0+cu126 **không** đụng tới torch (kiểm bằng `pip install --dry-run` trước: `torch` không nằm
trong danh sách "Would install"), và cả `import whisperx` lẫn `import omnivoice` chạy trong đúng một venv.
Bộ đã kiểm: omnivoice 0.2.1, whisperx 3.7.4, faster-whisper 1.2.1, ctranslate2 4.8.2, transformers 5.17.0,
pyannote.audio 3.4.0, numpy 2.0.2, soundfile 0.14.0.

Nếu về sau một bản mới làm hỏng điều đó (dấu hiệu: pip báo sẽ gỡ/hạ `torch`, hoặc một trong hai `import` chết),
dựng hai venv và trỏ riêng từng engine — schema đã có sẵn hai khoá đó từ đầu, không phải đổi lần hai:

```yaml
media:
  transcribe: { python: E:/harness-venv-asr/Scripts/python.exe }
  tts:        { python: E:/harness-venv-tts/Scripts/python.exe }
```

**Tải trước mô hình** (nếu không, lần chạy thật đầu tiên vừa là lần tải đầu tiên — chậm nhất và dễ hỏng nhất):

```sh
cd engines/python
export HF_HOME=E:/hf-cache
P=E:/harness-venv/Scripts/python

$P -c "import torch; from omnivoice import OmniVoice; OmniVoice.from_pretrained('k2-fsa/OmniVoice', device_map='cuda:0', dtype=torch.float16)"
$P -c "import sys; sys.path.insert(0,'.'); import transcribe; transcribe.allow_vad_checkpoint_globals(); import whisperx; whisperx.load_model('large-v3','cuda',device_index=0,compute_type='float16')"
$P -c "import whisperx; whisperx.load_align_model(language_code='en', device='cuda:0')"
$P -c "import whisperx; whisperx.load_align_model(language_code='vi', device='cuda:0')"   # mỗi ngôn ngữ một mô hình
```

Dung lượng đo được sau một lần chạy thật:

| Nơi | Dung lượng | Nội dung |
| --- | ---: | --- |
| `E:\harness-venv` | 7.4 GB | torch 2.8 cu126 + toàn bộ phụ thuộc |
| `E:\hf-cache` (`HF_HOME`) | 8.9 GB | OmniVoice 3.1 GB, faster-whisper large-v3 2.9 GB, wav2vec2 tiếng Việt 3.1 GB |
| `~/.cache/torch/hub/checkpoints` | 0.4 GB | `WAV2VEC2_ASR_BASE_960H` — mô hình căn chỉnh **tiếng Anh** |
| `E:\pip-cache` | 3.0 GB | bánh xe đã tải (xoá được) |

`HF_HOME` **không** dời được mô hình căn chỉnh tiếng Anh: `en` là một bundle của `torchaudio`
(`DEFAULT_ALIGN_MODELS_TORCH`), nên nó vào cache torch hub trên ổ hệ điều hành. Mọi ngôn ngữ khác (`vi`, …)
là mô hình Hugging Face nên có theo `HF_HOME`. Nếu ổ C chật, đặt thêm `TORCH_HOME` cạnh `HF_HOME`.

`HF_HOME` phải được đặt **trong môi trường chạy worker**, không chỉ lúc tải: nó nằm trong danh sách trắng env
mà `mediaChildEnv()` truyền xuống tiến trình Python con (cùng `PATH`, `SystemRoot`, `TEMP`, `TMP`, `CUDA_*`,
`HF_HUB_OFFLINE`, `PYTHONUTF8`). Thiếu nó thì engine đi tìm mô hình ở `~/.cache/huggingface` và tải lại từ đầu.

## 2. Khối `media:` trong `project.yaml`

Mọi khoá đều optional và có mặc định, nên một `project.yaml` cũ vẫn parse nguyên trạng; chỉ `media.python` là
bắt buộc khi `adapters.media: python`.

```yaml
adapters:
  media: python            # python | fake (mặc định fake). Đây là chỗ DUY NHẤT chọn engine;
                           # `core` không bao giờ đọc khoá này, chỉ composition root.
media:
  python: E:/harness-venv/Scripts/python.exe   # bắt buộc khi adapters.media: python
  device: cuda:0                               # cuda:<n> | cpu
  transcribe:
    engine: whisperx
    model: large-v3        # tên mô hình faster-whisper
    compute_type: float16  # float16 | int8_float16 | int8 — hạ xuống nếu OOM
    batch_size: 8
    # python: …            # ghi đè media.python chỉ cho transcribe (phương án hai venv)
  tts:
    engine: omnivoice
    model: k2-fsa/OmniVoice
    dtype: float16         # float16 | bfloat16 | float32
    num_step: 32           # số bước khuếch tán, 4-128; cao hơn = chậm hơn, không hẳn hay hơn
    max_chars: 280         # ngưỡng tách một dòng lời thành nhiều chunk, 80-600
    pause_seconds: 0.25    # khoảng lặng chèn giữa hai chunk của cùng một dòng
    loudness_lufs: -16     # chuẩn hoá độ to từng file wav
    # python: …            # ghi đè media.python chỉ cho tts
  scene:
    threshold: 0.30        # ngưỡng dò cảnh của ffmpeg; cảnh quay rung/đổi sáng thì hạ xuống
    min_shot_seconds: 1.0
    max_shot_seconds: 20   # chặn một shot dài vô tận khi không dò ra cảnh nào
    proxy_height: 540      # chiều cao bản proxy media-index dựng để agent xem
  watch:
    max_sheets: 24
```

Bốn stage media là **built-in** (`harness media index|transcribe|tts|fit-edl`, composition root tự đăng ký),
**không** cần entry trong `executors/scripts.yaml` và không bao giờ gọi tay — chúng đọc `stage-request.json`
trong `$HARNESS_WORKSPACE` giống mọi stage built-in khác.

Python chỉ là **tiến trình con ngắn hạn**: harness ghi một file job JSON, chạy `python transcribe.py --job … 
--result …`, đọc file result rồi xoá cả hai. Không có service thường trú, không có cổng mạng. Exit code luôn
0; mọi thất bại nằm trong file result dưới dạng `{ ok: false, kind: "contract" | "transient", reason }` —
`contract` là lỗi đầu vào retry không bao giờ cứu được, `transient` thì worker thử lại theo `retry` của stage.

## 3. Buổi quay = một collection

Sub-project 5A đổi đơn vị nguồn: một request lấy **cả một buổi quay** chứ không phải một clip.

```sh
harness source ingest D:/quay/2026-09-21 --collection shoot-2026-09-21 --rights cleared --language vi
harness source ingest D:/quay/2026-09-21 --collection shoot-2026-09-21 --recursive    # có thư mục con
```

`source ingest` nhận **một thư mục** (mọi file video trong đó) hoặc một file; trùng byte thì dedupe theo
sha256 và **giữ collection cũ**, nên đừng ingest lại cùng thư mục dưới tên collection khác.

Phía studio, bật chế độ collection bằng `source_collections` (danh sách glob):

```yaml
library:
  auto_accept:
    enabled: true
    source_collections: ["shoot-*"]   # bật CHẾ ĐỘ COLLECTION
    max_sources: 40                   # trần số clip một request được lấy
    max_replans: 2
    max_concurrent_runs: 1
    # workflow_release: library-production@1.1.0   # nút lùi, xem mục 8
```

Có đúng hai chế độ chọn nguồn, và `source_collections` là công tắc:

- **Không khai** `source_collections` → chế độ cũ (sub-project 4): một request lấy **một** source, bận theo
  từng source.
- **Có khai** → chế độ collection: một request lấy **cả collection** khớp glob, và một collection đã được
  một run thành công dùng thì coi là **đã dùng**, request sau không lấy lại (trừ chính request đó khi replan).

`ContentRequest.source_hint.collection` (`library request create --source-hint shoot-2026-09-21`) ưu tiên
trước; không có thì auto-accept tự chọn trong các collection khớp glob.

Doctor:

```
ok   library:auto_accept   enabled, collections shoot-cache (2), shoot-en (3), shoot-orig (3), shoot-vi (3)
```

## 4. Hồ sơ giọng đọc

Giọng thuộc **kênh**, không thuộc xưởng: vai `channel` ghi vào `voices/` của kho, vai `studio` chỉ đọc.

```sh
# vai channel
harness library voices add \
  --display-name "Kênh một — giọng nữ" \
  --ref E:/voices/ref.wav --ref-text E:/voices/ref.txt \
  --language vi --origin synthetic --origin-note "OmniVoice voice design, chỉ từ mô tả chữ" \
  [--speed 1] [--num-step 32] [--voice-id voice_…]     # --voice-id = nâng revision hồ sơ đã có

harness library voices list [--status active|retired]
harness library voices retire <voice_id>
```

- `--ref` phải dài **3–30 s**; harness tự chuyển thành PCM mono 24 kHz `ref.wav` trong kho.
- `--ref-text` là **lời đọc đúng từng chữ** của clip mẫu, hoặc đường dẫn tới file chứa nó. Sai lời mẫu làm
  chất lượng nhân giọng tụt rõ.
- `--origin` là **bắt buộc**: `synthetic` | `own` | `licensed`.

> **Quy tắc, không có ngoại lệ:** không bao giờ nhân giọng một người thật khi chưa có quyền. Harness **không
> kiểm chứng được** `origin` — nó chỉ ghi lại lời khai; trách nhiệm thuộc người tạo hồ sơ (spec §10). Cách an
> toàn và là cách đã dùng cho lần chạy thật này: sinh chính clip mẫu bằng **voice design** của OmniVoice, tức
> chỉ từ một câu mô tả, không có audio tham chiếu nào:
>
> ```python
> from omnivoice import OmniVoice
> m = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map="cuda:0", dtype=torch.float16)
> audio = m.generate(text="<8-12 giây lời đọc>", language="Vietnamese", instruct="female, low pitch")[0]
> ```
>
> `instruct` chỉ nhận một tập mục cố định (giới tính, tuổi, cao độ, `whisper`, giọng vùng tiếng Anh; tiếng
> Trung có thêm phương ngữ) và **ném `ValueError` nếu viết sai** — nó không phải câu mô tả tự do. Giữ nguyên
> văn đoạn text đó làm `--ref-text`, khai `--origin synthetic`. Lệnh sinh clip mẫu chưa được bọc vào CLI
> (ngoài phạm vi 5A, spec §9).

Kênh gắn giọng mặc định trong `channels/<id>/channel.yaml`:

```yaml
voice: { voice_id: voice_01M321KG8Q6TQKN0TX1XKT1Q5S }
```

và mỗi request `tts` phải mang một `--voice-id`:

```sh
harness library request create --portfolio portfolio-channel --channel channel-one \
  --topic "Chợ nổi buổi sáng" --style <style_id> --duration 5,120 \
  --voice tts --voice-id <voice_id> --language vi --source-hint shoot-2026-09-21
```

`--voice tts` **không có** `--voice-id`, hoặc trỏ tới một hồ sơ đã `retired`, bị từ chối ngay lúc tạo
(`requireActiveVoice`). Khi chính kênh tự sinh request (`channel-planning`), thiếu giọng dùng được thì
`create-requests` **hạ xuống `voice: none` kèm ghi chú** thay vì làm hỏng cả stage.

## 5. Đọc kết quả: `fit-report.json`, `timeline.json`, vòng replan, cache TTS

`media-fit-edl` **không bao giờ fail vì thiếu hình**. Nó cắt/kéo EDL cho khớp lời rồi ghi ba thứ:

- `edl.json` — bản EDL đã khớp (stage `cut` dùng bản này; `library-review` nhận **cả hai** — bản trước khi
  khớp do `plan-edit` ghi, và bản đã khớp này).
- `fit-report.json` — `within_target`, và mỗi dòng một `action`: `kept` | `trimmed` | `expanded` | `appended`
  | `dropped`, cộng `shortfalls[]` (`line_ids`, `missing_seconds`, `reused_seconds`, `uncovered_seconds`).
  `shortfalls` không rỗng nghĩa là lời dài hơn hình còn lại — đây là tín hiệu để agent `library-review` loại
  bản dựng.
- `timeline.json` — hợp đồng cho sub-project 5B: `video[]` (thứ tự, source, in/out, start/end),
  `narration[]` (dòng lời, wav, vị trí trên trục thời gian, `words[]`), `speech[]` (câu gốc giữ lại khi
  `voice: original`), `total_seconds`.

Hằng số khớp hình cố định trong mã: vào trước 0.3 s, ra sau 0.4 s, cửa sổ hít cắt ±0.4 s, khe tối thiểu
0.15 s, tay cầm 0.08 s, bỏ đoạn < 0.2 s, dự phòng 0.5 s.

Vòng loại → replan là vòng của sub-project 4, không đổi: `library-review` ghi `rejected` → request về `open`
→ auto-accept plan một run mới (tối đa `max_replans` lần) → hết lượt thì dashboard dựng alert `request_stuck`.

**Cache TTS** nằm ở `<data_root>/cache/tts/<key>.wav|.json`. Khoá băm theo *nội dung*: chữ của dòng, giọng
(`voice_id` + revision + checksum clip mẫu + `ref_text`), `speed`/`num_step`, và `dtype`/`max_chars`/
`pause_seconds`/`loudness_lufs`. Một dòng không đổi ở lần replan sau **không đọc lại** — `narration-timing.json`
ghi `cached: true` cho dòng đó. Đo thật: tập thứ hai với đúng phần lời của tập thứ nhất làm `media-tts` rơi từ
**33.4 s xuống 0.4 s**. Thư mục cache lớn dần và `harness artifacts sweep` **chưa** biết tới nó (xem
`docs/operations/deferred-items.md`).

## 6. Sự cố

| Triệu chứng | Nguyên nhân thường gặp | Xử lý |
| --- | --- | --- |
| `media:python` FAIL | đường dẫn `media.python` sai, venv bị xoá | sửa đường dẫn tuyệt đối, chạy lại `python -c "import torch"` |
| `media:packages` FAIL `missing: …` | cài thiếu, hoặc trỏ nhầm sang python hệ thống | cài lại theo mục 1, kiểm bằng chính đường dẫn trong `project.yaml` |
| `media:device` FAIL `CUDA not available` | driver/CUDA không khớp bánh xe torch | cài lại torch đúng nhánh cu1xx; tạm thời `media.device: cpu` |
| `media:models` FAIL `will download on first run` | chưa tải trước | chỉ là cảnh báo; tải trước theo mục 1 để lần chạy đầu không dài bất thường |
| `media:engine` FAIL `fake media engine` | profile studio đã sang `library-production@1.2.0` nhưng `adapters.media` vẫn `fake` | đổi thành `python`, hoặc lùi `workflow_release` (mục 8) nếu cố ý |
| Stage `media-*` lỗi `transient` lặp lại | OOM, mô hình tải hỏng | hạ `transcribe.compute_type` xuống `int8_float16`, `batch_size` xuống 4, `tts.dtype` xuống `float32` nếu nghi NaN |
| `python engine timed out after Ns` | buổi quay quá dài so với deadline | timeout transcribe tính theo tổng thời lượng audio; nới `default_deadline_seconds` của profile |
| `transcript.json` có `alignment: "segment"` | không có mô hình căn chỉnh cho ngôn ngữ đó | chấp nhận được — engine tự lùi về mốc theo câu, không fail; kiểm `DEFAULT_ALIGN_MODELS_*` của whisperx |
| `narration-timing.json` có `alignment: "chunk"` | mô hình căn chỉnh nạp được nhưng align từng dòng lỗi | cũng không fail; mốc rơi về theo chunk, khớp hình thô hơn |
| `UnpicklingError: Weights only load failed` | torch ≥ 2.6 + checkpoint VAD của whisperx | đã sửa trong `transcribe.py` (`allow_vad_checkpoint_globals`); nếu nâng whisperx/pyannote mà thấy lại, thêm lớp bị báo tên vào danh sách đó |

`harness doctor` **bỏ qua** phép dò engine media khi đang có lease GPU (tránh xếp hàng sau một stage dài
nhiều phút) và dashboard dùng bản dò có cache 900 s; `harness doctor` gõ tay thì luôn dò mới.
`default_deadline_seconds: 14400` của profile `studio` revision 3 áp cho **mọi** stage, kể cả stage agent.

## 7. Thời gian chạy và VRAM đo thật

Máy: RTX 3060 12 GB (driver 581.29), Ryzen/Windows 11, Python 3.11.15, torch 2.8.0+cu126, whisperx 3.7.4,
omnivoice 0.2.1. Nguồn: ba clip mỗi buổi quay, mỗi clip ba cảnh màu + một đoạn nói thật do chính OmniVoice
sinh ra (không dùng vật liệu của bên thứ ba). Agent là **agent giả** (DoD này kiểm media, không kiểm agent),
nên phần lời bình là chuỗi ký tự giữ chỗ — số đo thời gian và VRAM vẫn thật, nhưng đừng đọc chúng như chất
lượng nội dung.

**Bảng thời gian từng stage (giây, một attempt mỗi stage, cả bốn run đều SUCCEEDED đủ 15 stage):**

| Stage | 1. `en` + `tts` | 2. `vi` + `tts` | 3. `en` + `original` | 4. `en` + `tts` (cache) |
| --- | ---: | ---: | ---: | ---: |
| intake | 0.4 | 0.3 | 0.3 | 0.3 |
| media-index | 1.3 | 1.0 | 1.1 | 0.7 |
| **media-transcribe** | **32.9** | **66.8** | **53.9** | **33.5** |
| watch-source | 3.0 | 2.1 | 2.0 | 1.8 |
| survey-source (agent giả) | 0.1 | 0.1 | 0.1 | 0.1 |
| plan-edit (agent giả) | 0.1 | 0.1 | 0.1 | 0.1 |
| **media-tts** | **33.4** | **54.5** | **0.3** | **0.4** |
| media-fit-edl | 0.4 | 0.4 | 0.4 | 0.4 |
| cut | 0.9 | 0.6 | 0.4 | 0.5 |
| assemble | 0.7 | 0.7 | 0.7 | 0.7 |
| watch-episode | 0.9 | 0.9 | 0.8 | 0.8 |
| thumbnail-candidates | 0.2 | 0.2 | 0.2 | 0.3 |
| library-export | 0.4 | 0.4 | 0.4 | 0.5 |
| library-review (agent giả) | 0.1 | 0.1 | 0.1 | 0.1 |
| library-apply-review | 0.3 | 0.4 | 0.3 | 0.4 |
| **tổng run (tường)** | **86.1** | **135.3** | **67.9** | **52.3** |

**VRAM, khối lượng và tỉ lệ thời gian thực:**

| | 1. `en` + `tts` | 2. `vi` + `tts` | 3. `en` + `original` | 4. cache |
| --- | ---: | ---: | ---: | ---: |
| Số clip nguồn | 3 | 3 | 3 | 2 |
| Tổng audio nguồn | 31.4 s | 26.2 s | 29.8 s | 12.9 s |
| VRAM đỉnh (mẫu 500 ms) | 4067 MiB | 4083 MiB | 4069 MiB | 4047 MiB |
| VRAM lúc rảnh | ~324 MiB | ~323 MiB | ~324 MiB | ~320 MiB |
| `transcript` alignment | `word` | `word` | `word` | `word` |
| Số từ có mốc | 104 | 103 | 89 | 44 |
| Dòng lời bình | 3 | 3 | 0 | 2 (đều `cached`) |
| Audio lời bình sinh ra | 9.24 s | 8.33 s | — | 6.16 s (0 s sinh mới) |
| `narration-timing` alignment | `word` | `word` | — | `word` |
| `timeline.total_seconds` | 12.08 | 10.91 | 15.30 | 7.56 |
| `full-episode.mp4` (ffprobe) | 12.20 s | 11.04 s | 15.40 s | 7.64 s |
| Âm lượng (`volumedetect`) | -20.9 / -4.3 dB | -21.4 / -4.5 dB | -26.5 / -9.3 dB | -20.5 / -4.4 dB |
| `fit-report.within_target` | true | true | true | true |

Đọc bảng:

- **Nạp mô hình chi phối, không phải tính toán.** Mỗi stage media là một tiến trình Python mới: OmniVoice
  mất ~12 s để nạp từ cache (87 s lần đầu, gồm tải), whisper large-v3 + VAD ~4 s, và cả hai mô hình căn chỉnh
  nạp thêm một lần nữa. Với 30 s audio nguồn thì gần như toàn bộ 33 s của `media-transcribe` là nạp mô hình;
  buổi quay 40 clip sẽ **không** tốn gấp 40 lần.
- **Lần đầu của một ngôn ngữ mới đắt hơn hẳn.** Run `vi` mất 66.8 s cho transcribe và 54.5 s cho tts vì mô
  hình căn chỉnh tiếng Việt (`nguyenvulebinh/wav2vec2-base-vi-vlsp2020`, 3.1 GB) được tải và nạp trong cả hai
  stage. Tải trước theo mục 1 thì lần sau chỉ còn phần nạp.
- **Tỉ lệ thời gian thực của TTS** (đo riêng, sau khi mô hình đã nạp): **1.98×** cho một câu tiếng Anh
  8.98 s và **2.54×** cho một câu tiếng Việt 8.26 s — tức sinh nhanh hơn thời gian phát ~2–2.5 lần. Ở chế độ
  voice design không có clip mẫu, lần đọc đầu tiên sau khi nạp chậm hơn rõ (0.67× rồi lên 5.21× cho câu thứ
  hai) — hâm nóng CUDA, không phải đặc tính của văn bản.
- **Sửa trong lúc chạy thật:** một defect (`torch` ≥ 2.6 từ chối unpickle checkpoint VAD của WhisperX —
  `allow_vad_checkpoint_globals()` trong `transcribe.py`, ADR mục 114) và một thiếu sót (`tts.py` không
  truyền `language` của job xuống `OmniVoice.generate`). Cả hai đã sửa và có test hồi quy chạy không cần GPU.
- **VRAM đỉnh ~4.1 GB** cho cả ba chế độ. `tts.py` giải phóng mô hình TTS (`del model` + `empty_cache()`)
  **trước** khi nạp mô hình căn chỉnh, `transcribe.py` làm y hệt với mô hình whisper — nhờ đó hai mô hình
  không bao giờ cùng nằm trên card, và 12 GB thừa rất nhiều.
- **Tải lần đầu:** OmniVoice 3.1 GB (69 s), faster-whisper large-v3 2.9 GB, wav2vec2 tiếng Việt 3.1 GB,
  wav2vec2 tiếng Anh 0.36 GB (torch hub). Bánh xe pip ~3.0 GB, trong đó riêng torch cu126 là 2.9 GB.

Cảnh báo về độ chính xác của bảng: các số đo lấy từ `status --json` (mốc bắt đầu/kết thúc của attempt cuối).
Trong lúc đo run 2 và 3, một vòng `worker --once` rảnh của run trước vẫn đang quay trên cùng máy, nên vài
chục mili giây CPU là nhiễu; các con số nên đọc như **chặn trên**, không phải mốc chính xác tuyệt đối.

## 8. Quay về `library-production@1.1.0`

1.2.0 là bản duy nhất dùng engine media. Lùi một cấp mà không đụng profile:

```yaml
library:
  auto_accept:
    workflow_release: library-production@1.1.0
```

Khoá này ghim **vòng autopilot** vào một release cụ thể thay vì đi theo `workflow_release` của profile
`studio`. Không khai = đi theo profile (hiện là 1.2.0). Chạy tay thì `harness plan --workflow
library-production@1.1.0 …` luôn được, bất kể profile trỏ đâu. Lùi rồi thì `adapters.media` không còn tác
dụng gì (1.1.0 không có stage media nào) và dòng doctor `media:engine` biến mất.

## 9. Kết luận DoD #2 và #3

**DoD #2 — chạy thật trên máy build: ĐẠT.**

- Venv dựng theo `engines/python/README.md`, **một** venv, không xung đột phiên bản.
- `harness doctor` trên project studio tạm (`adapters.media: python`, `media.device: cuda:0`):

  ```
  ok   ffprobe               ffprobe is available; media probing enabled
  ok   library:voices        E:\tmp-5a-studio\kho\voices exists
  ok   library:auto_accept   enabled, collections shoot-cache (2), shoot-en (3), shoot-orig (3), shoot-vi (3)
  ok   media:python          python E:/harness-venv/Scripts/python.exe
  ok   media:packages        torch 2.8.0+cu126, omnivoice 0.2.1, whisperx unknown
  ok   media:device          cuda:0: NVIDIA GeForce RTX 3060, 11240 MB free
  ok   media:models          all models cached
  ```

  (`whisperx unknown` là đúng: gói whisperx 3.7.4 không khai `__version__`, probe ghi `"unknown"` thay vì
  `null`, nên dòng `media:packages` vẫn `ok`.)
- Bốn tập chạy hết 15 stage, mỗi stage đúng một attempt, `library-production@1.2.0`, không lệnh người nào
  ngoài `worker --once`: `en`+`tts`, `vi`+`tts`, `en`+`original`, và một tập `en`+`tts` thứ hai để kiểm cache.
- `transcript.json` có `words[]` và `alignment: "word"` cho **cả bốn** tập, kể cả tiếng Việt.
- `narration-timing.json` có `alignment: "word"` và wav thật; `full-episode.mp4` có luồng audio, thời lượng
  lệch `timeline.total_seconds` ≤ 0.12 s, và `volumedetect` cho mean -20.5…-26.5 dB (không phải im lặng).
- `voice: original` không cắt giữa chữ: đối chiếu từng điểm cắt của `timeline.video[]` với mốc từ trong
  `transcript.json` — **0 từ** bị một điểm cắt nào chia đôi.
- Cache TTS: tập thứ tư đọc lại đúng phần lời của tập thứ nhất → cả hai dòng `cached: true`, `media-tts`
  33.4 s → 0.4 s.

**DoD #3 — tiếng Việt của OmniVoice: ĐẠT (theo số đo khách quan; cần một lần nghe của người để chốt).**

Không nghe được trong môi trường build, nên dùng ba phép đo gián tiếp — và nói rõ đây là *gián tiếp*. Mẫu
đo được sinh bằng **chính `engines/python/tts.py`**, chạy như một tiến trình con với đúng payload job mà
`PythonMediaEngine.synthesize()` ghi ra (hai câu thành hai chunk của một dòng, `pause_seconds: 0.25`,
`num_step: 32`, `speed: 1.0`, nhân giọng từ clip mẫu do voice design sinh) — không phải một lời gọi thư viện
viết tay đi đường khác.

1. **Nghe ngược bằng WhisperX.** Một câu tiếng Việt thật (138 ký tự, 32 từ), đọc rồi cho WhisperX large-v3
   (`language: vi`) nghe lại:

   | | vào | nghe ra |
   | --- | --- | --- |
   | `vi` | "Chợ nổi mở trên mặt nước từ rất sớm, trước khi mặt trời lên. Người bán treo một chùm trái cây trên cây sào cao để người mua nhìn thấy từ xa." | "Chợ nổi mở trên mặt nước từ rất sớm trước khi mặt trời lên. Người bán treo một chùm trái cây trên cây xảo cao để người mua nhìn thấy từ xa." |

   **WER 3.1 % (1/32 từ), CER 1.9 %.** Từ sai duy nhất là `sào` → `xảo` — `s`/`x` không phân biệt ở giọng
   Nam, nên đây nhiều khả năng là lỗi của bên **nghe**, không phải bên đọc. Cùng phép đo với tiếng Anh cho
   **WER 0 %, CER 0 %** (29/29 từ đúng).
2. **Tốc độ đọc.** 16.47 ký tự/giây cho tiếng Việt so với 15.52 cho tiếng Anh — cùng một khoảng, không có
   dấu hiệu đọc vội, kéo dài hay lặp; hai chunk rơi đúng vào 0–3.57 s và 3.82–8.50 s (khoảng lặng 0.25 s
   giữa chúng đúng như `pause_seconds`).
3. **Căn chỉnh từ chạy được.** Chính `tts.py` trả `alignment: "word"` với **32/32 từ** có mốc cho câu tiếng
   Việt (và 29/29 cho tiếng Anh); `transcript.json` của tập 2 cũng `alignment: "word"`. Mô hình
   `nguyenvulebinh/wav2vec2-base-vi-vlsp2020` khớp được từng từ vào audio do OmniVoice sinh — việc đó không
   xảy ra được với audio méo hoặc sai âm tiết.

Ngoài ra, ba đoạn nói tiếng Việt dùng làm **nguồn** cho tập 2 cũng do OmniVoice sinh, và WhisperX chép lại
gần như đúng nguyên văn (lệch: `cây sào`→`cây xào`, `chợ dời`→`trợ rời`, `chín giờ`→`9 giờ`).

Ba phép đo này **không** trả lời được: thanh điệu nghe có tự nhiên với tai người Việt không, ngắt câu có
đúng chỗ không, và giọng có "nghe như đọc máy" không. Bốn file để chủ máy nghe và chốt:

```
E:\tmp-5a-studio\listen\engine-vi.wav    8.50 s — câu tiếng Việt ở bảng trên, qua tts.py
E:\tmp-5a-studio\listen\engine-en.wav    9.41 s — câu tiếng Anh để so sánh, qua tts.py
E:\tmp-5a-studio\listen\listen-vi.wav    8.26 s — cùng câu, gọi thẳng OmniVoice (trước khi sửa `language`)
E:\tmp-5a-studio\listen\listen-en.wav    8.98 s
```

Không commit vào repo.
