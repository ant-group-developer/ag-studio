# Runbook: dựng hình 4K — chữ, phụ đề, nhạc, chuyển cảnh (sub-project 5B)

Đích: `library-production@1.3.0` nhận `timeline.json` của 5A rồi **tự dựng ra một file 3840×2160 hoàn chỉnh**
— phụ đề theo từ, chữ trên hình theo hồ sơ thương hiệu của kênh, nhạc nền có ducking, chuyển cảnh dissolve —
mà không cần một wrapper nào của ops project ngoài `thumbnail-candidates`.

Hai stage built-in thay hẳn `cut` + `assemble`:

| Stage | Chạy bằng | Vào | Ra |
| --- | --- | --- | --- |
| `media-compose` | **thuần TypeScript**, không spawn gì | `timeline`, `overlays` (tuỳ chọn), `narration`, `brief`, `shots`, brand + kho nhạc | `composition.json`, `captions/` (`.srt` + `.vtt`), `overlay.ass` |
| `media-render` | **ffmpeg** (`requires_resources: [gpu]`) | `composition`, `overlay_ass`, `captions`, `edl`, `voice_set` | `full-episode.mp4`, `cuts/` (`clip_set`), `render-report.json` |

**Mọi con số ở mục 7 là đo thật** trên máy build (RTX 3060 12 GB, driver 581.29, Windows 11, ffmpeg 8.1.2),
không phải ước lượng — nhưng xem kỹ cảnh báo về NVENC ở mục 1 và về bitrate ở mục 7 trước khi trích dẫn
chúng. Mục 9 chốt DoD #2 và #3 của spec.

Đọc kèm: `studio-media.md` (venv, engine media, `timeline.json`, cache TTS — 1.3.0 dùng lại y hệt),
`content-library.md` (kho), `go-live.md` §4 bước 3c (dựng máy studio thật).

---

## 1. Điều kiện của máy: ffmpeg, khối `media.render`, và chuyện NVENC

**`media-compose` không cần gì cả** — nó là số học trên `timeline.json`. Toàn bộ yêu cầu nằm ở
`media-render`, và `harness doctor` gói chúng vào **một** dòng:

```
ok   media:render   ass, xfade, loudnorm, sidechaincompress, overlay, libx264, NVENC
```

Năm filter đó là năm thứ bản dựng thật sự dùng: `ass` (đốt phụ đề + chữ), `xfade` (dissolve), `overlay`
(logo), `sidechaincompress` (ducking), `loudnorm` (chuẩn độ to). `libx264` là encoder mà **mọi** máy phải có
— nó là đường lùi khi không có NVENC. Thiếu bất kỳ cái nào thì dòng in `missing: …` và đó là hỏng thật:
ffmpeg build đó không dựng được tập nào.

```yaml
# project.yaml — mọi khoá optional, đây là giá trị mặc định
media:
  render:
    codec: h264          # h264 | hevc  (hevc: hevc_nvenc / libx265, thêm -tag:v hvc1)
    encoder: auto        # auto | nvenc | cpu
    fps: auto            # auto | 24 | 25 | 30 | 50 | 60
    cache_max_gb: 60     # trần LRU cho <data_root>/cache/mezz
```

- `encoder: auto` dò NVENC **một lần mỗi run** (`ffmpeg -f lavfi -i nullsrc … -c:v h264_nvenc -f null -`,
  kết quả cache 15 phút giống phép dò engine media của 5A) rồi giữ nguyên lựa chọn đó cho cả run.
- `fps: auto` lấy fps **phổ biến nhất theo tổng giây** trong các source rồi làm tròn về {24, 25, 30, 50, 60};
  không đọc được thì 30.
- Đặt thẳng `encoder: nvenc` trên máy không có NVENC **không làm fail** — nó cảnh báo
  (`nvenc_unavailable_cpu_fallback`) rồi render bằng CPU.

### NVENC cần driver mới, và máy build này chưa đủ

```
[h264_nvenc] Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0
[h264_nvenc] The minimum required Nvidia driver for nvenc is 610.00 or newer
```

ffmpeg 8.1.2 đòi **nvenc API 13.1 ⇒ driver NVIDIA ≥ 610.00**. Máy build đang ở **581.29**, nên:

- `probeNvenc` trả `false`, `encoder: auto` giải ra `cpu`, `render-report.encoder = "cpu"` và
  `render-report.warnings` có `encoder_cpu`;
- `harness doctor` in `FAIL media:render "no NVENC, renders on CPU"`. **Đây là cảnh báo, không phải hỏng** —
  đúng khuôn `ok: false`-là-cảnh-báo mà `media:models` của 5A đã dùng, và nó **không** dựng alert doctor nào.
  Nhưng `harness doctor` vẫn **thoát mã 1**: đọc nội dung dòng, đừng đọc mã thoát;
- dashboard dựng alert riêng `render_cpu_fallback` (chỉ khi máy khai `resources.gpu ≥ 1`).

Hệ quả cần nói thẳng: **toàn bộ đường NVENC của 5B chưa từng chạy trên phần cứng thật ở đâu cả.** Argv
mezzanine (`-preset p4 -rc vbr -cq 18`), argv phát hành (`-preset p6 -tune hq -cq 19 -maxrate 60M
-bufsize 120M`), retry-một-lần-bằng-CPU khi NVENC gãy giữa chừng, và việc chuyển cả run sang CPU — tất cả chỉ
được phủ bằng test fake-spawn (`packages/core/test/media/render/run.test.ts`). Nâng driver là việc của người
vận hành máy, không phải của harness. Sau khi nâng, việc đầu tiên là `harness doctor` (dòng `media:render`
phải `ok … NVENC`), rồi so `render_seconds` với bảng CPU ở mục 7.

---

## 2. Hồ sơ thương hiệu của kênh

Thương hiệu **thuộc kênh và nằm trong kho**, không nằm trong `channel.yaml`. Vai `channel` ghi, vai `studio`
chỉ đọc — cùng luật với hồ sơ giọng của 5A.

```sh
# vai channel
harness library brands set <channel_id> --from <đường dẫn>/brand.json [--json]
harness library brands show <channel_id> [--json]
```

`set` parse `harness.brand/v1`, **kiểm font và logo trước khi chạm kho**, copy mọi file được tham chiếu
(đường dẫn **tương đối với chính file `brand.json`**) vào `brands/<channel_id>/`, ghi checksum của từng file
vào bản trong kho và nâng `revision` lên một. Chạy lại là cách duy nhất để sửa. **Không có lệnh xoá**: xoá
thư mục bằng tay nghĩa là kênh bỏ thương hiệu.

```json
{ "schema_version": "harness.brand/v1", "channel_id": "channel-one", "revision": 1,
  "fonts": { "regular": "fonts/BeVietnamPro-Regular.ttf", "bold": "fonts/BeVietnamPro-Bold.ttf",
             "origin": "licensed", "origin_note": "OFL 1.1" },
  "colors": { "primary": "#F2C94C", "text": "#FFFFFF", "text_outline": "#000000", "box": "#000000B3" },
  "safe_margin_px": 120,
  "text": { "title":       { "size_px": 120, "position": "top_left",    "box": true,  "animation": "slide_up", "seconds": 4 },
            "callout":     { "size_px": 160, "position": "center",      "box": false, "animation": "pop",      "seconds": 3 },
            "lower_third": { "size_px": 72,  "position": "bottom_left", "box": true,  "animation": "fade",     "seconds": 5 } },
  "subtitles": { "mode": "karaoke", "size_px": 88, "position": "bottom_center",
                 "max_chars_per_line": 42, "max_lines": 2, "highlight_color": "#F2C94C" },
  "logo": { "path": "logo.png", "corner": "right", "opacity": 0.8, "height_px": 140 },
  "transition": { "kind": "dissolve", "seconds": 0.4 },
  "source_fit": "scale_pad",
  "music": { "tracks": ["calm-01"], "gain_db": -18, "duck_db": -12,
             "duck_attack_ms": 150, "duck_release_ms": 600 } }
```

Từng khoá:

| Khoá | Nghĩa |
| --- | --- |
| `fonts.regular` / `.bold` | Hai file trong `fonts/`. `bold` dùng cho `title` và `callout`, `regular` cho phụ đề và `lower_third`. **Tên family trong ASS = tên file bỏ đuôi** (`arial.ttf` → `arial`), và render chạy với `fontsdir=<brands/<id>/fonts>` + fontconfig tắt, nên libass **chỉ** thấy hai file này. |
| `fonts.origin` / `origin_note` | `own` / `licensed` / `royalty_free` + ghi chú. **Lời khai, harness không xác minh được** (y như `voice.origin`, ADR mục 105). Trách nhiệm giấy phép thuộc người tạo hồ sơ. |
| `colors` | `#RRGGBB` hoặc `#RRGGBBAA`. `text` là màu chữ, `text_outline` là viền 4 px, `box` là nền hộp khi `box: true`, `primary` là màu nhấn dự phòng. |
| `safe_margin_px` | Lề an toàn ở khung 3840×2160 cho **cả** chữ, phụ đề và logo. |
| `text.<kind>` | `size_px`, `position` (9 vị trí), `box`, `animation` (`none`/`fade`/`slide_up`/`pop`), `seconds` mặc định khi agent không khai. |
| `subtitles.mode` | `burn-in` \| `karaoke` \| `none` — chỉ quyết định có **đốt vào hình** hay không; file `.srt`/`.vtt` **luôn luôn** được sinh. |
| `subtitles.max_chars_per_line` / `max_lines` | Quyết định cách ngắt cue **và** cách xuống dòng. 42×2 là mức dễ đọc ở 4K. |
| `logo.corner` | `left` \| `right`, luôn ở **góc trên**. **Không** liên quan tới `channel.yaml.overlay.side` (khoá đó thuộc đường thumbnail của hệ cũ). |
| `transition` | Kiểu và thời lượng mặc định cho **mọi** mối nối. `seconds` ∈ [0.2, 1.0]. |
| `source_fit` | `scale_pad` (giữ trọn khung, thêm viền) hay `scale_crop` (lấp đầy, cắt mép). |
| `music.tracks` | Những `track_id` trong kho mà kênh này được dùng. Rỗng hoặc thiếu = không nhạc. |

**Font tiếng Việt.** Harness **không ship font nào** — font là tài sản có giấy phép. Chọn font có đủ dấu tổ
hợp (`ẫ`, `ệ`, `ỡ`, `ặ`): **Be Vietnam Pro** (OFL) và **Noto Sans** (OFL) là hai lựa chọn an toàn. Đừng tin
là font nào cũng được: nhiều font phương Tây vẽ `ẫ` thành hai dấu chồng lệch hoặc thành ô vuông. Cách kiểm
duy nhất chắc chắn là **nhìn một khung hình thật** (mục 9). Lần chạy thật này dùng `arial.ttf`/`arialbd.ttf`
của Windows với `origin: licensed`, `origin_note: "Windows system font (test only)"` — đủ dấu, nhưng đó là
font của hệ điều hành, không phải thứ đem đi phát hành.

**Không có brand thì sao?** Tập **vẫn dựng**, không fail: không chữ, không logo, không nhạc, cắt thẳng,
`scale_pad`, phụ đề chỉ là file rời (`subtitles.mode` ép về `none`). `render-report.brand = "absent"`, và
nếu agent có viết `overlays.json` thì nó bị bỏ qua kèm cảnh báo `overlays_ignored_no_brand`.

**Brand hỏng thì sao?** Font/logo thiếu hay checksum lệch bị bắt ở **`intake`, trước `claimRequest`** (cùng
chỗ với phép kiểm giọng của 5A): `CONFIG_INVALID` → lỗi `contract` → stage `intake` đỗ **`WAITING_HUMAN`**
sau đúng một attempt, run **chưa** FAILED, và request vẫn `open`. Sửa kho rồi
`harness retry <run_id> --stage intake`. Dashboard thấy nó qua alert `stage_waiting_human`; `harness doctor`
(`library:brands` ở studio, `channel:<id>:brand` ở máy kênh) đã cảnh báo trước đó.

---

## 3. Kho nhạc

```sh
# vai channel
harness library music add --track-id <id> --file <wav|flac|mp3|m4a> --display-name <tên> \
    --mood calm,neutral --origin own|licensed|royalty_free [--origin-note <ghi chú>] [--loop-ok] [--json]
harness library music list [--json]          # đọc mirror DB: chạy `library sync` trước
harness library music retire <track_id>      # active -> false, GIỮ file
```

- `track_id` ∈ `^[a-z0-9][a-z0-9-]{1,39}$`. File được copy vào `music/<track_id>/` **giữ nguyên đuôi gốc**.
- `add` probe bằng ffprobe và **chỉ nhận file có luồng audio**; `duration_seconds` ghi vào `track.json`.
- `--mood` là danh sách từ khoá **tự do**, khớp **chính xác** (không phân biệt hoa/thường) với `music.mood`
  mà agent viết trong `overlays.json`. Không khớp thì mọi ứng viên vẫn được giữ, kèm cảnh báo
  `music_mood_unmatched` — tập không bao giờ mất nhạc chỉ vì một từ khoá.
- `--loop-ok` là lời khai **"bài này lặp được"**: track ngắn hơn tập sẽ được `aloop` lặp thẳng. Không khai
  thì nhạc phát một lần rồi tắt, kèm cảnh báo `music_ends_early`. 5B **không** crossfade điểm nối vòng lặp.
- `--origin` là **bắt buộc** và, y như font, harness không xác minh được. Ghi nguồn thật vào `--origin-note`
  ("Pixabay licence, tải 2026-09-20") — đó là thứ duy nhất còn lại khi có người hỏi.
- `retire` **giữ file**: track `active: false` không bao giờ được chọn lại, nhưng tập cũ trong kho không gãy.

**Cách harness chọn bài** (agent không chọn): ứng viên = `brand.music.tracks` ∩ track `active` ∩ file còn
tồn tại; lọc theo `overlays.music.mood` nếu có; rồi lấy phần tử thứ `sha256(request_id) mod n`. Tái lập được
(replan cùng request ra cùng bài) nhưng hai tập khác nhau không bị cùng một bài. Ứng viên rỗng ⇒
`music: null` kèm `reason` (`no_candidates` / `no_brand` / `brand_no_tracks`).

---

## 4. `overlays.json` — agent viết gì, `overlays-valid` chặn gì

`overlays.json` là output **thứ tư và tuỳ chọn** của `plan-edit` (`optional: true`). Agent cũ không viết thì
tập không có chữ, chuyển cảnh theo brand, nhạc chọn không mood — không có gì fail.

```json
{ "schema_version": "harness.overlays/v1",
  "items": [
    { "id": "OV01", "kind": "title",       "text": "3 sai lầm khi rút BHXH", "anchor": { "line_id": "L001" } },
    { "id": "OV02", "kind": "callout",     "text": "27,5 %", "anchor": { "line_id": "L004", "word_index": 6 }, "seconds": 3 },
    { "id": "OV03", "kind": "lower_third", "text": "Nguồn: BHXH VN 2025", "anchor": { "edl_order": 7 } } ],
  "transitions": [ { "before_order": 7, "kind": "dip_black" } ],
  "music": { "mood": "calm" } }
```

Agent quyết **nội dung và neo**; harness quyết **font, màu, vị trí, hiệu ứng** (theo brand). Agent không bao
giờ chạm tới hình thức.

`overlays-valid` chạy ở `plan-edit`, **chỉ khi output tồn tại**, và chặn đúng sáu thứ:

1. **Schema** `harness.overlays/v1`, `id` khớp `^OV\d{2,3}$` và duy nhất.
2. **Độ dài chữ**: `title` ≤ 48, `callout` ≤ 24, `lower_third` ≤ 64 ký tự.
3. **≤ 1 `title` cho mỗi đoạn** (mỗi `edl_order` sau khi giải neo).
4. **Neo tồn tại**: `line_id` phải có trong `narration.json`; `edl_order` phải có trong `edl.json` (bản
   **pre-fit**, vì `timeline.json` chưa tồn tại ở bước này); `word_index` chỉ kiểm `< số từ trong text`.
   `speech_index` **không kiểm được ở đây** — nó chỉ giải ra được sau `media-fit-edl`, nên một neo
   `speech_index` sai vẫn qua checker và chỉ rơi ra ở `media-compose` (thành `text_dropped`).
5. **Mật độ** — đây là chỗ hay hiểu nhầm nhất: checker đếm **tổng số `items`**, **không** đo khoảng cách.
   ```
   seconds = max( tổng ký tự lời bình / cps , Σ(out − in) của EDL )      cps = 15 (en) / 14 (vi)
   limit   = max( 1, floor(seconds / spacing) )                           spacing = 5 s (high) / 8 s (medium) / 15 s (low)
   ```
   Hai nửa của `max()` đều cần: chấm theo lời thôi thì tập `voice: none|original` có ngân sách 0; chấm theo
   EDL thôi thì một tập lời dày trên ít hình lại được nhồi chữ. Sàn `max(1, …)` bảo đảm tập ngắn nhất vẫn
   được một `title` mở đầu — nhưng cũng **chỉ** một: một tập 12 giây ở mật độ `medium` có ngân sách **1**, dù
   hai overlay cách nhau 8 giây vẫn bị coi là quá dày. Ở 1.3.0 `plan-edit` **không có input `edit_style`**,
   nên `spacing` **luôn** là 8 s bất kể style của kênh khai gì (ghi ở deferred-items).
6. **`transitions[].before_order`** phải là `order` có thật của đoạn **đứng sau** mối nối (≥ 1).

**Vi phạm `overlays-valid` KHÔNG dẫn tới dựng lại.** Đây là điều quan trọng nhất trong mục này. Một required
check fail ở `plan-edit` là lỗi `result`: stage `FAILED` → **run FAILED** → và không có gì mở lại một run đã
FAILED, nên **request kẹt ở `claimed` vĩnh viễn** và ngay cả alert `request_stuck` cũng không nổ (nó chỉ nhìn
request `open`). Đó là hổng hệ thống của sub-project 4, giống hệt `edl-valid` của 5A — xem
`docs/operations/deferred-items.md` mục "Sau sub-project 5B", mục đầu bảng. Đường dựng lại **thật sự chạy**
cho lỗi chữ là đường duyệt: một bản overlays qua được checker nhưng hỏng ở `media-compose` rơi vào
`render-report.text_events.dropped` → `library-review` từ chối → request về `open` → replan.

---

## 5. Đọc kết quả

### `composition.json` — bản dựng đã lên lịch

Đọc theo thứ tự này:

- **`segments[]`** — bằng **đúng** `timeline.video[]` (`order`/`source_id`/`in`/`out`/`start`/`end`). Checker
  `composition-valid` fail nếu lệch quá 1 ms. Chữ, phụ đề, nhạc, chuyển cảnh chỉ phủ lên trục thời gian chứ
  không bao giờ dời nó (ADR mục 118).
- **`segments[].transition_out`** — `{ kind, seconds, tail_available }`. `dissolve` cần **đuôi** lấy thêm từ
  chính source đó (`out + seconds ≤ duration`) **và** đoạn sau dài ≥ `2 × seconds`; thiếu điều nào thì hạ
  xuống `cut`.
- **`captions`** — `mode` + `cues[]`. Mỗi cue có `lines[]` (đã ngắt dòng), `words[]` (mốc từng từ, để vẽ
  karaoke và để `render-valid` đối chiếu) và `raise_px` (> 0 khi một `lower_third` chiếm chỗ ở đáy).
- **`text_events[]`** — overlay đã giải neo ra mốc thật, kèm `position`/`animation` lấy từ brand.
  **`text_dropped[]`** là những cái **không** giải được hoặc va chạm không gỡ được — đây là nơi duy nhất có
  đủ `id` + `reason`.
- **`music`** — `track_id`, `loop`, `fade_in`/`fade_out`, `cues[]`, và `duck`.
  > **`duck.windows` và `duck.gain_db` là THÔNG TIN, không phải lệnh.** Ducking thật do
  > `sidechaincompress` quyết theo **tín hiệu lời** ngay lúc render (ngưỡng 0.031 ≈ −30 dBFS, ratio 6,
  > attack/release lấy từ brand). Hai trường đó chỉ để người và agent đọc, và để checker đối chiếu. Sửa
  > `windows` trong file không đổi được một mẫu âm thanh nào.
- **`transitions`** — `{ requested, applied, downgraded[] }`. Bất biến: `applied + downgraded.length = requested`.
- **`narration[].wav`** — đường dẫn tuyệt đối, **do `media-compose` ghi theo workspace attempt của chính nó**.
  Đừng tin chúng khi đọc file nguội: `media-render` **ghi đè lại** (`rebaseNarrationWavs`) thành
  `<voice_set của attempt render>/<tên file>` ngay trước khi dựng, nên một workspace compose đã bị dọn
  (`harness artifacts sweep`) hay một máy khác vẫn dựng lại được. Thiếu file trong `voice_set` là
  `CONFIG_INVALID` (`contract`, không retry) có nêu tên file.
- **`warnings[]`** — `word_interpolated:<line_id>:<i>` (từ thiếu mốc, phải nội suy), `music_mood_unmatched`,
  `music_ends_early`, `overlay_dropped:<id>`, `overlays_ignored_no_brand`.
  > `music_ends_early` nghĩa là track ngắn hơn tập và **không** khai `--loop-ok`: nhạc dừng ở
  > `music.cues[0].end`, không phải ở cuối tập. Fade-out 3 s được neo vào **chỗ nhạc hết**
  > (`min(total_seconds, cues[0].end) − fade_out`), nên nhạc tắt dần đúng lúc chứ không cụt ngang; phần tập
  > còn lại chỉ có tiếng lời. Muốn nhạc phủ hết tập thì đổi track dài hơn, hoặc `library music add … --loop-ok`.

### `render-report.json` — bản dựng đã render thật

```
encoder        "nvenc" | "cpu"        <- cái thật sự chạy, không phải cái khai trong project.yaml
segments       { total, rendered, cached, mezz_seconds }
transitions    { requested, applied, downgraded[] }
captions       { mode, cues, reason? }
text_events    { total, dropped[] }
music          { track_id | null, reason?, loop }
loudness       { integrated_lufs, true_peak_dbtp, lra }
warnings[]     encoder_cpu | loudnorm_not_linear | nvenc_* | loudnorm_output_unparsed | …
render_seconds, ffmpeg_version, output { width, height, fps, seconds, bytes }
```

**Phải đọc cả hai file.** `render-report.json` **không** gộp `composition.json.warnings`, và `text_dropped`
chỉ đầy đủ ở `composition.json` — skill `library-review` bước 0b nói đúng điều đó.

### Vì sao `library-review` từ chối một tập

Bốn điều kiện, bất kỳ cái nào đúng là **từ chối thẳng** (bỏ qua 6 mục chấm hình thường lệ):

| Điều kiện | Nghĩa thực tế |
| --- | --- |
| `transitions.downgraded.length > 0.3 × requested` | Chuyển cảnh gãy nhiều — thường vì EDL cắt sát mép source (`no_tail`) hoặc có đoạn ngắn hơn `2 × seconds` (`next_too_short`). |
| `text_events.dropped` không rỗng | Chữ đã bị bỏ vì neo không giải được hoặc va chạm không gỡ được. |
| `music.track_id === null` mà brand có nhạc | `reason` không phải `no_brand`/`brand_no_tracks` ⇒ kho nhạc có vấn đề. |
| `loudness.integrated_lufs` ngoài `[−16, −12]` | Xem mục 6. |

Cảnh báo `encoder_cpu` và `loudnorm_not_linear` **không** phải lý do từ chối — chúng chỉ là thông tin, và
`loudnorm_not_linear` chỉ đáng nhắc khi `loudness` đã lệch (lúc đó nó chính là lời giải thích).

Ngưỡng 30 % dễ chạm hơn người ta tưởng trên tập ngắn: tập `en` của lần chạy thật có **3** mối nối, **1** bị
hạ cấp — `1 > 0.9` ⇒ bị từ chối, dù bản dựng hoàn toàn bình thường. Trên tập dài vài phút với vài chục mối
nối thì ngưỡng này hợp lý; trên tập 15 giây nó khắt khe.

### `render-valid` soi những chỗ nào

Checker này là thứ duy nhất **nhìn vào file đã render** chứ không tin vào JSON:

- đúng 1 luồng hình 3840×2160, fps = `output.fps` (±0.01), `|duration − total_seconds| ≤ 0.1 s`;
- ≥ 1 luồng tiếng 48 kHz stereo;
- `loudness.integrated_lufs` ∈ `[−16, −12]` **và** `true_peak_dbtp ≤ −0.5`;
- số cue trong `captions.srt` = `composition.captions.cues.length`;
- **vùng logo**: ô **260×260 px ở góc trên** (`x = 0` khi `corner: left`, `x = 3580` khi `right`), lấy 3 khung
  tại `t = 1`, `total/2`, `total − 1`, yêu cầu **≥ 2 trong 3** khung có độ lệch chuẩn luma **> 4**. Lấy 2/3 vì
  một khung có thể rơi đúng vào giữa một `dip_black`, lúc đó cả khung phẳng một cách hợp lệ;
- **vùng phụ đề** (khi `mode ≠ none` và có ≥ 1 cue): ô **1000 px ngang tại `x = 1420`**, cao
  `safe_margin_px + 3 × subtitles.size_px`, sát đáy khung, lấy **một** khung tại **giữa cue đầu tiên**, yêu
  cầu độ lệch chuẩn luma **> 4**.

Hai phép cuối là cách rẻ nhất để trả lời "chữ có thật sự được vẽ lên hình không" mà không cần OCR. Chúng
**không** nói gì về việc chữ có đúng dấu hay không — việc đó là DoD #3, phải có mắt người (mục 9).

### `clip_set` — `cuts/` là gì

`cuts/<order 3 chữ số>.mp4` là **bản sao của mezzanine THÂN** (hardlink khi cùng ổ, copy khi khác ổ), không
kèm đuôi dissolve, độ dài đúng `out − in`; cộng `cuts/manifest.json` liệt kê `{ order, source_id, seconds }`.
Nó tồn tại để giữ nguyên hợp đồng của `thumbnail-candidates` (và checker `clip-set-complete` của 5A chạy
nguyên trạng) — đó cũng là lý do `media-render` khai input `edl` bên cạnh `composition`.

### Cache mezzanine: sidecar, LRU, dọn tay

```
<data_root>/cache/mezz/<key>.mp4        thân đoạn — và cả đuôi dissolve
<data_root>/cache/mezz/<key>.json       sidecar: { key, seconds, bytes, created_at, last_used_at }
```

`key = sha256({ source_checksum, in, out, fit, w, h, fps, has_audio, encoder, codec, mezz_version })` —
**theo nội dung**, không theo run. Đổi chữ, đổi nhạc, đổi kiểu chuyển cảnh mà không đụng tới điểm cắt thì
**không encode lại một khung hình nào**.

> **Đuôi dissolve nằm dưới khoá của CHÍNH NÓ, file `<khoá đuôi>.mp4`** — không có hậu tố `-tail` trên đĩa.
> Đuôi là một lượt gọi riêng với `in = out`, `out = out + tail_seconds` cộng thêm `tail_seconds` vào khoá,
> nên nó băm ra một khoá hoàn toàn khác và nằm phẳng cạnh thân trong cùng thư mục. Chuỗi `-tail` chỉ xuất
> hiện trong **log** (`mezzanine <order>-tail`), không bao giờ trong tên file.

- **Sidecar là nguồn sự thật duy nhất cho LRU**: `atime` trên Windows không tin được, nên `last_used_at` được
  ghi lại mỗi lần cache hit. File media **không có sidecar đọc được** bị coi là miss và **bị xoá cả hai**.
- Sau **mỗi** lần dựng, cache bị quét LRU về dưới `media.render.cache_max_gb` (mặc định 60 GB). Quét ngay
  cuối lượt dựng an toàn **vì `media-render` giữ lease `gpu` duy nhất** (`resources.gpu: 1`), nên không có
  lượt dựng nào khác đang giữ mezzanine nóng. Khai `resources.gpu ≥ 2` thì hai lượt dựng song song có thể
  quét mất mezzanine vừa ghi của nhau (dựng lại được, chỉ tốn thời gian — ghi ở `deferred-items.md`).
- Không có bảng SQLite nào cho cache, và `harness artifacts sweep` **không** biết tới thư mục này. Muốn dọn
  tay thì xoá cả thư mục — lần dựng sau chỉ chậm hơn, không hỏng gì.
- Dashboard cho `mezz_cache.hit_ratio` (Σcached / Σtotal trên 20 lần render gần nhất). **Không có `bytes`** —
  event `media.rendered` không mang dung lượng; muốn biết thì đo thẳng thư mục.

---

## 6. Sự cố

| Triệu chứng | Nguyên nhân thường gặp | Xử lý |
| --- | --- | --- |
| `media:render` FAIL `missing: ass, xfade…` | ffmpeg build thiếu libass/filter | cài bản đủ filter (`ffmpeg -filters \| grep xfade`); không có đường vòng |
| `media:render` FAIL `no NVENC, renders on CPU` | driver < 610.00 (mục 1) | **cảnh báo**, không phải hỏng. Nâng driver nếu muốn NVENC, hoặc để nguyên và chấp nhận thời gian CPU ở mục 7 |
| `media:render` FAIL `ffmpeg not runnable` | `FFMPEG_PATH` sai, ffmpeg không có trên PATH | sửa PATH; đây là hỏng thật, không dựng được tập nào |
| Alert `render_cpu_fallback` trên dashboard | `encoder: auto` giải ra `cpu` trên máy khai `gpu` | đúng như trên; nếu cố ý render CPU thì đặt thẳng `encoder: cpu` cho alert khỏi nổ |
| `render_seconds` đột ngột gấp nhiều lần | NVENC mất giữa chừng (`nvenc_final_fallback` / `nvenc_segment_fallback` trong `warnings`) | driver vừa cập nhật/khởi động lại? kiểm `harness doctor` |
| `render-valid` fail `integrated loudness out of range` | xem khung bên dưới | |
| Chữ ra ô vuông, dấu chồng lệch | font của brand không có glyph tổ hợp tiếng Việt | đổi font (Be Vietnam Pro / Noto Sans), `library brands set` lại, dựng lại |
| Chữ không hiện chút nào | `brand` `absent`, hoặc `overlays.json` bị bỏ qua (`overlays_ignored_no_brand`), hoặc mọi item rơi vào `text_dropped` | đọc `composition.json.text_dropped` trước, `render-report.warnings` sau |
| Phụ đề dính liền không có dấu cách | lỗi đã sửa ở Task 11 — libass chỉ vẽ ký tự **nằm trong** các đoạn `{\kf}`, nên phần lặng giữa hai từ karaoke phải mang theo dấu cách thật | chạy trên bản đã sửa; nếu thấy lại thì kiểm `overlay.ass` có `{\kf4} ` (có dấu cách) chứ không phải `{\kf4}` |
| `transitions.downgraded` nhiều, review từ chối | EDL cắt sát mép source (`no_tail`), hoặc nhiều đoạn ngắn hơn `2 × transition.seconds` (`next_too_short`) | hạ `brand.transition.seconds` (0.4 → 0.3 hạ ngưỡng đoạn tối thiểu từ 0.8 s xuống 0.6 s), hoặc sửa style để `shot_seconds` dài hơn, hoặc đổi `transition.kind` về `cut` |
| `music: null` mà brand có track | track bị `retire`, file mất, hoặc checksum lệch | `harness doctor` dòng `library:music`; `library music list` |
| Cache mezzanine phình to | tập 4K rất tốn đĩa | hạ `media.render.cache_max_gb`, hoặc xoá hẳn `<data_root>/cache/mezz` |

### Loudness lệch — đọc kỹ chỗ này

**Triệu chứng:** `render-valid` fail với `{"reason":"integrated loudness out of range","integrated_lufs":-16.13}`,
`media-render` FAILED, **run FAILED**, và (vì hổng SP4 ở mục 4) request kẹt ở `claimed`.

**Nguyên nhân.** `media-render` chuẩn độ to bằng `loudnorm` **hai lượt**: lượt 1 đo, lượt 2 encode với
`measured_*` + `offset` + `linear=true`. Nhưng ffmpeg **âm thầm** bỏ `linear` và lùi về `dynamic` khi phép
khuếch đại tuyến tính sẽ vượt trần đỉnh:

```
measured_TP + (−14 − measured_I) > −1        ⇔        (TP − I) > 13 dB
```

tức khi **hệ số đỉnh** của bản trộn lớn hơn 13 dB. Chế độ `dynamic` khoá đỉnh ở đúng −1 dBTP và bỏ chương
trình lại **dưới** −14 LUFS. Đo thật trên máy này: một bản trộn ở **−19.35 LUFS / −1.43 dBTP** (hệ số đỉnh
17.9 dB) ra **−16.13 LUFS** — trượt khỏi dải `[−16, −12]` đúng 0.13 dB.

**Cách nhận ra:** `render-report.warnings` có **`loudnorm_not_linear`**. Cảnh báo này được thêm chính vì lần
chạy thật đầu tiên chết ở đây mà không để lại manh mối nào. Nó **không** phải lỗi tự thân: cả bốn tập của
lần chạy thật (giọng đọc câu thật, hệ số đỉnh 12–14 dB) đều mang cảnh báo đó mà vẫn ra −13.85…−14.28 LUFS.
Nó chỉ đáng lo **khi đi cùng** một `loudness` lệch.

**Xử lý ngay:** nguồn của bản trộn quá "nhọn". Thường gặp nhất là lời bình có nhiều đỉnh ngắn trên nền im
lặng. Rút ngắn khoảng lặng giữa các dòng, hoặc chuẩn hoá lại clip lời trước khi đưa vào, đều kéo hệ số đỉnh
xuống. Một nguyên nhân gốc nằm ở 5A: `normalizeLoudness` chuẩn hoá từng dòng bằng **một lượt** `loudnorm`,
mà một lượt thì ffmpeg bỏ qua `linear` và chạy dynamic — trên một dòng 2–3 giây (ngắn hơn cửa sổ nhìn trước
3 giây của chính nó) kết quả lệch xa mục tiêu: đo được **−21.57 LUFS** cho một dòng đặt mục tiêu −16.

**Việc còn lại:** chèn một `alimiter`/`acompressor` nhẹ vào lớp lời trước khi trộn, hoặc nới dải chấp nhận,
hoặc chuyển thất bại loudness từ "fail cứng" thành cảnh báo. Đó là quyết định thiết kế, ghi ở
`docs/operations/deferred-items.md` mục "Sau sub-project 5B", mục đầu bảng thứ hai.

---

## 7. Số đo thật trên máy build

Máy: RTX 3060 12 GB (**driver 581.29 — không NVENC**), Windows 11, ffmpeg 8.1.2, Python 3.11.15 + venv 5A.
Nguồn: ba clip 1920×1080/30, mỗi clip ba cảnh màu phẳng dài 15–17 giây kèm **một câu nói thật do chính
OmniVoice sinh** (không dùng vật liệu của bên thứ ba). Brand: hai font Arial của Windows, logo PNG 400×140 vẽ
bằng ffmpeg, một track nhạc 60 giây sinh bằng `aevalsrc`. Agent là **agent giả**, nhưng lời bình là **câu
tiếng Việt/tiếng Anh thật** (`FAKE_NARRATION_TEXT`) — nếu không thì `media-tts` đọc ra một tràng tiếng gõ và
phép đo độ to nói về thứ khác hẳn.

**Bốn tập, đều `library-production@1.3.0`, mỗi stage đúng một attempt:**

| Stage (giây) | 1. `vi`+`tts`, karaoke | 2. `en`+`tts`, burn-in | 3. `vi`+`original`, karaoke | 4. lặp lại tập 1 |
| --- | ---: | ---: | ---: | ---: |
| intake | 0.5 | 0.5 | 0.5 | 0.5 |
| media-index | 2.6 | 2.6 | 2.6 | 2.5 |
| media-transcribe | 36.7 | 14.2 | 33.7 | 20.3 |
| watch-source | 2.1 | 2.2 | 1.9 | 1.9 |
| survey-source (agent giả) | 0.1 | 0.1 | 0.1 | 0.1 |
| plan-edit (agent giả) | 0.2 | 0.1 | 0.1 | 0.2 |
| media-tts | 27.8 | 26.8 | 0.5 | **0.7** (cache TTS) |
| media-fit-edl | 0.6 | 0.7 | 0.5 | 0.5 |
| **media-compose** | **0.6** | **0.6** | **0.6** | **0.7** |
| **media-render** | **14.5** | **17.4** | **20.4** | **9.8** |
| watch-episode | 2.0 | 2.7 | 3.0 | 1.9 |
| thumbnail-candidates | 0.6 | 0.6 | 0.6 | 0.6 |
| library-export | 0.6 | 0.6 | 0.6 | 0.6 |
| library-review (agent giả) | 0.2 | 0.1 | 0.1 | 0.1 |
| library-apply-review | 0.5 | 0.5 | 0.5 | 0.5 |
| **tổng stage** | **89.6** | **69.7** | **65.7** | **40.9** |
| tổng tường (kể cả vòng `worker --once` rảnh) | 103.6 | 85.7 | 80.3 | 55.4 |

**Bản dựng ra.** Cả bốn đều là `h264 3840×2160 @30` + `aac 48 kHz stereo`, `-movflags +faststart`.

| | 1. `vi`+`tts` | 2. `en`+`tts` | 3. `vi`+`original` | 4. lặp lại tập 1 |
| --- | ---: | ---: | ---: | ---: |
| `total_seconds` | 12.10 | 15.16 | 21.00 | 12.10 |
| Đoạn (`segments`) | 3 | 4 | 3 | 3 |
| Cue phụ đề | 3 (karaoke) | 5 (burn-in) | 6 (karaoke) | 3 |
| `text_events` / bị bỏ | 2 / 0 | 2 / 0 | 2 / 0 | 2 / 0 |
| Chuyển cảnh yêu cầu → áp dụng | 2 → 2 | 3 → **2** | 2 → 2 | 2 → 2 |
| Nhạc | calm-loop-01 | calm-loop-01 | calm-loop-01 | calm-loop-01 |
| Cửa sổ ducking | 3 | 3 | 2 | 3 |
| `encoder` | cpu | cpu | cpu | cpu |
| Mezzanine render / cache | 3 / **0** | 4 / 0 | 3 / 0 | **0 / 3** |
| `render_seconds` | 11.685 | 14.328 | 17.264 | **7.014** |
| **tỉ lệ render / thời lượng** | **0.97×** | **0.95×** | **0.82×** | **0.58×** |
| Kích thước file | 1.15 MB | 0.98 MB | 1.68 MB | 1.15 MB |
| Bitrate (`ffprobe format=bit_rate`) | 759 kbps | 515 kbps | 641 kbps | 759 kbps |
| Bitrate luồng tiếng (aac 48 kHz stereo) | 215 kbps | 219 kbps | 231 kbps | 215 kbps |
| `integrated_lufs` / `true_peak_dbtp` | −13.97 / −1.00 | −14.28 / −1.00 | −13.85 / −3.51 | −13.97 / −1.00 |
| `lra` | 1.4 | 2.2 | 9.5 | 1.4 |
| `warnings` | `loudnorm_not_linear`, `encoder_cpu` | như tập 1 | `encoder_cpu` | như tập 1 |
| `library-review` | approved | **rejected** (1/3 chuyển cảnh hạ cấp) | approved | approved |

**Đỉnh RAM** (mẫu 500 ms suốt cả bốn tập, đo hai lượt): ffmpeg **4.17–4.19 GB**, tiến trình Python của engine
media **3.77 GB**. Hai cái đó không chạy cùng lúc (stage media và stage render đều giữ lease `gpu`), nên đỉnh
thật của máy là ~4.2 GB chứ không phải tổng.

**Cache mezzanine sau bốn tập**: 16 file `.mp4` (10 thân + 6 đuôi dissolve) + 16 sidecar, tổng **9.9 MB** —
nhỏ vì nguồn là màu phẳng; xem cảnh báo bitrate ngay dưới.

Đọc bảng:

- **Render CPU 4K nhanh hơn thời gian thực (0.8–1.0×) trên vật liệu này — đừng ngoại suy con số đó.** Nguồn
  là những mảng màu phẳng: `libx264 -crf 18` gần như không có gì để làm. Footage thật (nhiễu cảm biến, chi
  tiết, chuyển động) sẽ chậm hơn nhiều lần. Tỉ lệ này chỉ đáng dùng để so **giữa các dòng trong chính bảng
  này**.
- **Cache mezzanine là thứ tiết kiệm nhiều nhất.** Tập 4 lặp lại đúng tập 1: 3/3 đoạn cache hit, `media-render`
  **14.5 s → 9.8 s** và `render_seconds` **11.7 s → 7.0 s**. Phần còn lại (~7 s) là lượt cuối — nối, đốt ASS,
  phủ logo, trộn tiếng, loudnorm hai lượt, encode — thứ **không bao giờ** cache được. Cộng với cache TTS của
  5A (`media-tts` 27.8 s → 0.7 s), cả run rơi từ 89.6 s xuống 40.9 s.
- **`media-compose` gần như miễn phí** (0.6–0.7 s cho cả phụ đề, ASS, chọn nhạc, gán chuyển cảnh). Nó là số
  học thuần; mọi chi phí nằm ở `media-render`.
- **`voice: original` render lâu hơn** (17.3 s cho 21 s hình so với 11.7 s cho 12.1 s) đơn giản vì tập dài
  hơn; tỉ lệ của nó lại **tốt nhất** (0.82×) vì không phải trộn ba file wav lời.
- **Bitrate ra chỉ 0.5–0.8 Mbps, và đó KHÔNG phải lý do đổi `-cq`/`-crf`.** Spec §11 đặt cửa "thấp hơn
  30 Mbps thì đổi sang `-cq 17`" — cửa đó dành cho vật liệu thật. Ở đây con số thấp vì **nội dung** gần như
  không có entropy, không phải vì cấu hình encoder: `libx264 -crf 18` là encoder **theo chất lượng**, nó tiêu
  đúng số bit mà khung hình cần. Đo lại trên footage thật trước khi động vào bất kỳ hằng số nào.
- **Ducking đo được: 10.8 dB.** Dựng lại đúng nhánh nhạc của `audio-graph.ts` (atrim/afade/volume rồi
  `sidechaincompress`) hai lần — có và không có sidechain — rồi đo `volumedetect` trên cùng một khoảng:

  | Khoảng | Nhạc không ducking | Nhạc có ducking | Chênh |
  | --- | ---: | ---: | ---: |
  | Trong lời (0.6–2.8 s, đã bỏ 0.15 s attack) | −36.8 dB | −47.6 dB | **10.8 dB** |
  | Khe giữa hai dòng (7.75–8.08 s, 0.35 s sau khi dòng trước dứt) | −38.1 dB | −38.2 dB | **0.1 dB** |

  Tức là nhạc bị kéo xuống ~11 dB khi có lời và **hồi lại gần như hoàn toàn trong vòng 350 ms** sau khi lời
  dứt, dù `duck_release_ms` là 600. Vượt xa mức 6 LU mà spec đòi.
- **`harness doctor` trên project studio tạm** (`adapters.media: python`, `media.render.encoder: auto`):

  ```
  ok   library:voices        E:\tmp-5b-studio\kho\voices exists
  ok   library:music         E:\tmp-5b-studio\kho\music ok
  ok   library:brands        1 brand(s) ok
  ok   media:python          python E:/harness-venv/Scripts/python.exe
  ok   media:packages        torch 2.8.0+cu126, omnivoice 0.2.1, whisperx unknown
  ok   media:device          cuda:0: NVIDIA GeForce RTX 3060, 11240 MB free
  ok   media:models          all models cached
  FAIL media:render          no NVENC, renders on CPU
  ```

  và trên project kênh: `ok channel:channel-one:brand  channel-one rev1 brand ok`.
- **Hai lỗi sửa trong lúc chạy thật**, cả hai có test hồi quy không cần GPU:
  1. **Phụ đề karaoke mất hết dấu cách** — libass chỉ vẽ ký tự nằm **trong** các đoạn `{\kf}`, nên một
     `{\kf4}` rỗng làm phần lặng giữa hai từ không vẽ gì cả và cả dòng dính liền
     ("Chợbênsôngmởtừlúc"). Dấu cách giờ đi kèm đoạn lặng (ADR mục 119).
  2. **`loudnorm` lùi từ `linear` về `dynamic` mà không ai biết** — thêm cảnh báo `loudnorm_not_linear`
     (mục 6).

---

## 8. Quay về `library-production@1.2.0`

1.3.0 là bản duy nhất dựng hình. Lùi một cấp mà không đụng tới profile:

```yaml
library:
  auto_accept:
    workflow_release: library-production@1.2.0
```

Khoá này ghim **vòng autopilot** vào một release cụ thể thay vì đi theo `workflow_release` của profile
`studio` (revision 4 = 1.3.0). Chạy tay thì `harness plan --workflow library-production@1.2.0 …` luôn được.

Lùi rồi thì: cần lại **hai wrapper `cut` và `assemble`** trong `executors/scripts.yaml`; `media.render` không
còn tác dụng gì; item ra kho **không có `captions.srt`/`.vtt`**, không chữ, không nhạc, không chuyển cảnh;
dòng doctor `media:render` biến mất. Hồ sơ thương hiệu và kho nhạc **vẫn nằm yên trong kho** và vẫn được
`library sync`/doctor kiểm — chỉ là không ai đọc tới chúng. `library-production@1.1.0` và `@1.2.0` là
byte-identical so với trước 5B, nên lùi không mất cache của run cũ.

---

## 9. Kết luận DoD #2 và #3

**DoD #2 — chạy thật 4K trên máy build: ĐẠT.**

- Bốn tập chạy hết 15 stage của `library-production@1.3.0`, mỗi stage đúng một attempt, không có `cut`/
  `assemble`, không lệnh người nào ngoài `worker --once` (riêng tập `en` dùng đường chạy tay `library accept`
  + `plan --option subtitles=burn-in`, vì vòng autopilot **chưa** có chỗ đặt tuỳ chọn `subtitles` cho từng
  request — ghi ở deferred-items).
- Cả bốn ra **3840×2160 @30, h264, aac 48 kHz stereo**, `|duration − total_seconds| ≤ 0.04 s`,
  `render-valid` **pass** ở cả bốn (kể cả hai phép soi khung: vùng logo và vùng phụ đề đều "có vẽ thật").
- Có chữ (2 `text_events` mỗi tập, 0 bị bỏ), có phụ đề đốt vào hình (karaoke ở hai tập `vi`, burn-in ở tập
  `en`, đúng như `--option subtitles=burn-in` ghi đè `brand.subtitles.mode: karaoke`), có nhạc nền ducked
  **10.8 dB**, có dissolve (2/2 áp dụng ở ba tập; tập `en` 2/3 vì một đoạn ngắn hơn `2 × 0.4 s`).
- Độ to nằm trong dải ở cả bốn: **−13.85 … −14.28 LUFS**, true peak ≤ −1.00 dBTP.
- Item ra kho có **`captions.srt` + `captions.vtt`** (ba tập `approved`, một tập `rejected` đúng luật vì
  chuyển cảnh hạ cấp quá 30 %).
- Cache mezzanine chứng minh được: tập thứ tư lặp lại tập đầu → **3/3 đoạn cache hit**, `render_seconds`
  11.7 s → 7.0 s.
- **`render_seconds` NVENC: KHÔNG ĐO ĐƯỢC.** Driver của máy build (581.29) thấp hơn mức ffmpeg 8.1.2 đòi
  (≥ 610.00), nên mọi số ở mục 7 là **CPU**. Đây là giới hạn của máy, không phải của mã — và là việc đầu
  tiên phải kiểm lại trên một máy studio có driver mới.

**DoD #3 — chủ máy xem một tập tiếng Việt: CẦN MỘT LẦN XEM CỦA NGƯỜI.**

Phép soi của `render-valid` chỉ trả lời "vùng đó có được vẽ lên không", **không** trả lời "dấu tiếng Việt có
đúng không". Năm khung 3840×2160 trích từ tập `vi` + `tts` + karaoke để chủ máy xem tận mắt:

```
E:\tmp-5b-studio\frames\01-phu-de-cue1-va-tieu-de.png     t=1.61s  phụ đề cue 1 + title "Tiêu đề mở đầu" + logo
E:\tmp-5b-studio\frames\02-phu-de-cue2-va-callout.png     t=5.51s  phụ đề cue 2 + callout "Điểm nhấn" (hiệu ứng pop)
E:\tmp-5b-studio\frames\03-phu-de-cue3.png                t=9.91s  phụ đề cue 3
E:\tmp-5b-studio\frames\04-logo-goc-tren-phai.png         t=11.95s chỉ logo, góc trên phải
E:\tmp-5b-studio\frames\05-tieu-de-goc-tren-trai.png      t=0.85s  title lúc đang trượt lên (slide_up)
```

Cần nhìn đúng ba thứ: **(a)** dấu tổ hợp — `Chợ`, `mở`, `trời`, `chưa`, `hẳn`, `thuyền`, `lặng` — có vẽ đúng
chỗ, không chồng lệch, không thành ô vuông; **(b)** các từ có **dấu cách** giữa chúng (đây chính là lỗi đã
sửa trong lúc chạy thật); **(c)** phần đã đọc của dòng phụ đề đổi sang màu `highlight_color` (#F2C94C) còn
phần chưa đọc vẫn trắng — đó là karaoke đang chạy.

Hồ sơ thương hiệu dùng cho năm khung này nằm ở `E:\tmp-5b-studio\brand\` (không commit): `brand.json`, hai
font Arial của Windows và `logo.png`. Đó là font của hệ điều hành, khai `origin: licensed` với
`origin_note: "Windows system font (test only)"` — **không** phải thứ đem đi phát hành; kênh thật phải chọn
một font có giấy phép rõ ràng và có đủ dấu (mục 2).
