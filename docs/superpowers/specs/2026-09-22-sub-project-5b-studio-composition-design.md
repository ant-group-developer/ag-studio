# Sub-project 5B: Dựng hình cho studio — chữ, phụ đề, nhạc + ducking, chuyển cảnh, 4K trên `timeline.json`

**Ngày:** 2026-09-22
**Trạng thái:** Đã cài đặt xong (`library-production@1.3.0`, profile `studio` revision 4) và chạy thật 4K trên máy build — xem `docs/runbooks/studio-composition.md`. Bốn chỗ đã sửa lại cho khớp mã sau Task 10/11: §3 (`overlays-valid` fail **không** replan), §6.4 (`mezz_cache` chỉ có `hit_ratio`), §6.5 (dạng chạy tay của `media compose|render` chưa cài), §7 (brand hỏng ở intake → `WAITING_HUMAN`, không phải run FAILED).
**Tiền đề:** Sub-project 1, 2A, 2B, 2C, 3, 4, 3B, 5A đã merge vào `main` (`42951c1`). Spec này chỉ mô tả phần thêm vào; mọi thứ không nhắc tới giữ nguyên như spec 5A (`2026-09-21-sub-project-5a-studio-media-design.md`), spec 4 và spec 2C.
**Tham khảo:** `timeline.json` (`harness.timeline/v1`, spec 5A §4.2, ADR 107) là đầu vào duy nhất mang mốc thời gian; ffmpeg 8.1 trên máy này có `libass`, `xfade`, `sidechaincompress`, `loudnorm`, `h264_nvenc`/`hevc_nvenc` (RTX 3060, driver 581) — không cần engine Python mới; `EditStyleSchema` (`packages/contracts/src/library.ts`) đã có `text_overlay`, `subtitles`, `music`, `transitions`, `aspect_ratio` nhưng chưa stage nào đọc; bản mẫu `fixtures/ops-project-footage/executors/wrappers/assemble.mjs` (5A) chỉ nối clip + trộn tiếng.
**Phạm vi nội dung:** harness **không** dành cho nội dung hoạt hình (ADR 116). 5B dựng từ footage đã cắt; không sinh hình.

---

## 0. Quyết định đã chốt trong brainstorming

| Chủ đề | Quyết định |
|---|---|
| Nơi dựng | **Stage có sẵn trong harness**: `media-compose` (thuần TypeScript, tính mọi mốc) + `media-render` (ffmpeg). Wrapper `assemble`/`cut` của ops project không còn bắt buộc; 1.2.0 giữ nguyên. |
| Khung hình | **Một file 16:9 3840×2160 mỗi tập**. Nguồn thấp hơn phóng lên (lanczos); nguồn khác tỉ lệ thì pad hoặc crop theo kênh. Không 9:16. |
| Phụ đề | **Cả hai**: luôn sinh artifact `captions` (SRT + VTT); kênh chọn `burn-in` / `karaoke` / `none` để đốt vào hình. Cùng một bộ cue cho cả hai. |
| Chữ trên hình | **Agent `plan-edit` viết nội dung + neo** (`overlays.json`), **harness dựng** theo hồ sơ thương hiệu. Agent không chạm font/màu/vị trí. |
| Nhạc | **Kho nhạc trong kho chung** `music/<track_id>/`, có `origin`; kênh khai danh sách track; agent chọn `mood`, harness chọn track, loop, fade, ducking. |
| Thương hiệu | Kho `brands/<channel_id>/brand.json` + font + logo: font, bảng màu, vị trí chữ/phụ đề, logo góc. **Không** intro/outro ở 5B. Harness không ship font. |
| Chuyển cảnh | Kênh khai kiểu mặc định (`cut` / `dissolve` / `dip_black`, thời lượng cố định); agent ghi đè từng cắt. **Không bao giờ dời mốc timeline**: dissolve lấy thêm đuôi từ source, hết hình thì hạ về `cut`. |
| Kiến trúc | **Cách 2 — hai tầng**: mezzanine 4K từng đoạn (cache theo nội dung) → một lệnh cuối nối + đốt ASS + logo + trộn tiếng + encode. Đã loại: một `filter_complex` duy nhất (graph hàng nghìn node, không debug, không resume); frame server PyAV/Remotion (thêm runtime, 4K chậm, đi ngược ADR 116). |
| Tự chốt | Mọi thứ vẽ lên hình ngoài logo là sự kiện **ASS** (libass), không `drawtext`; loudness YouTube −14 LUFS / −1 dBTP; NVENC khi có, CPU khi không, chọn codec `h264` (mặc định) hay `hevc` bằng cấu hình. |

---

## 1. Cấu trúc thêm vào

```
packages/contracts/src/composition.ts      # schema: overlays, brand, music-track, composition, render-report, captions cue
packages/core/src/media/captions.ts        # từ → cue; SRT/VTT
packages/core/src/media/ass.ts             # cue + text_events + brand → overlay.ass
packages/core/src/media/overlays.ts        # neo overlays vào timeline, va chạm, mật độ
packages/core/src/media/music.ts           # chọn track, cue nhạc, cửa sổ ducking
packages/core/src/media/transitions.ts     # gán transition cho từng đoạn, đuôi, hạ cấp
packages/core/src/media/compose.ts         # buildComposition(): timeline + overlays + brand + music → composition.json
packages/core/src/media/render/{mezzanine,final-graph,audio-graph,encoder}.ts   # sinh argv/filter ffmpeg (thuần), cache key
packages/core/src/media/render/run.ts      # chạy ffmpeg qua deps.exec, cache mezz, render-report
packages/core/src/library/{brands,music}.ts  # ghi/đọc kho brands/, music/
packages/core/src/verification/composition-checkers.ts   # overlays-valid, composition-valid, render-valid
packages/cli/src/commands/media.ts         # thêm `media compose|render`
packages/cli/src/commands/library.ts       # thêm `library brands set|show`, `library music add|list|retire`
workflows/library-production@1.3.0/workflow.yaml
production-profiles/studio/profile.yaml    # revision 4 → library-production@1.3.0
skills/{edit-plan,library-review}/SKILL.md # sửa: viết overlays.json; đọc render-report.json
fixtures/fake-agent-cli.mjs                # sinh overlays.json; review đọc render_report
fixtures/brand-sample/                     # brand.json mẫu KHÔNG font/logo (test sinh PNG/lấy font hệ thống lúc chạy)
docs/runbooks/studio-composition.md
```

Quy tắc phụ thuộc giữ nguyên: `contracts` → `core` → `cli`. `core` không spawn tiến trình; nó nhận `exec` (chạy ffmpeg/ffprobe) qua deps như `watch.ts` hiện nay. Mọi hàm trong `captions|ass|overlays|music|transitions|compose|render/*-graph|encoder` là **thuần** và test không cần ffmpeg.

### 1.1 `project.yaml` thêm (optional, có default)

```yaml
media:
  render:
    codec: h264            # h264 | hevc
    encoder: auto          # auto | nvenc | cpu   (auto: nvenc nếu ffmpeg có và probe thành công, không thì cpu)
    fps: auto              # auto | 24 | 25 | 30 | 50 | 60
    cache_max_gb: 60       # cache mezzanine, dọn LRU khi vượt
```

`media-render` khai `requires_resources: [gpu]` (dùng lease `gpu` sẵn có của 5A) — tránh hai NVENC hoặc NVENC + mô hình cùng lúc. Khi `encoder` giải ra `cpu`, stage vẫn xin lease `gpu` (đơn giản, an toàn; ghi nhận ở §11).

### 1.2 `channel.yaml`

Không thêm trường. Có thư mục `brands/<channel_id>/` trong kho là kênh dùng thương hiệu. `overlay.side` (đã có, dùng cho đường sản xuất cũ) **không** liên kết với `brand.logo.corner` — logo của 5B chỉ theo `brand.json`.

### 1.3 Kho thêm

```
<kho>/brands/<channel_id>/brand.json       # harness.brand/v1
<kho>/brands/<channel_id>/fonts/*.ttf|*.otf
<kho>/brands/<channel_id>/logo.png
<kho>/music/<track_id>/track.json          # harness.music-track/v1
<kho>/music/<track_id>/track.wav           # wav|flac|mp3|m4a (ffmpeg đọc được); tên giữ nguyên phần mở rộng gốc
```

`LibraryFs.assertWritable`: vai **channel** ghi `brands/**` và `music/**`; studio chỉ đọc. `library sync` mirror vào bảng `brand_profile(channel_id, data, revision, updated_at)` và `music_track(id, data, status, updated_at)` (migration `0007_composition.sql`). Dashboard/doctor đọc bảng; stage đọc thẳng file trong kho (đã có `LibraryFs`).

---

## 2. Thương hiệu và nhạc

### 2.1 `brand.json` (`harness.brand/v1`)

```json
{ "schema_version": "harness.brand/v1", "channel_id": "ch1", "revision": 2,
  "fonts": { "regular": "fonts/BeVietnamPro-Regular.ttf", "bold": "fonts/BeVietnamPro-Bold.ttf",
             "origin": "licensed", "origin_note": "OFL 1.1" },
  "colors": { "primary": "#F2C94C", "text": "#FFFFFF", "text_outline": "#000000", "box": "#000000B3" },
  "safe_margin_px": 120,
  "text": { "title":       { "size_px": 120, "position": "top_left",     "box": true,  "animation": "slide_up", "seconds": 4 },
            "callout":     { "size_px": 160, "position": "center",       "box": false, "animation": "pop",      "seconds": 3 },
            "lower_third": { "size_px": 72,  "position": "bottom_left",  "box": true,  "animation": "fade",     "seconds": 5 } },
  "subtitles": { "mode": "burn-in", "size_px": 88, "position": "bottom_center",
                 "max_chars_per_line": 42, "max_lines": 2, "highlight_color": "#F2C94C" },
  "logo": { "path": "logo.png", "corner": "right", "opacity": 0.8, "height_px": 140 },
  "transition": { "kind": "dissolve", "seconds": 0.4 },
  "source_fit": "scale_pad",
  "music": { "tracks": ["calm-01", "upbeat-02"], "gain_db": -18, "duck_db": -12,
             "duck_attack_ms": 150, "duck_release_ms": 600 } }
```

- Mọi kích thước tính ở khung 3840×2160. `position` ∈ `top_left | top_center | top_right | center | bottom_left | bottom_center | bottom_right`. `animation` ∈ `none | fade | slide_up | pop`. `subtitles.mode` ∈ `burn-in | karaoke | none`. `logo.corner` ∈ `left | right` (góc trên). `transition.kind` ∈ `cut | dissolve | dip_black`, `seconds` ∈ [0.2, 1.0]. `source_fit` ∈ `scale_pad | scale_crop`.
- Màu: `#RRGGBB` hoặc `#RRGGBBAA`. `fonts.origin` ∈ `own | licensed | royalty_free`, `origin_note` bắt buộc, không kiểm giấy phép (như `voice.origin`, ADR 105).
- Mọi khối trừ `schema_version|channel_id|revision|fonts|colors` là optional với default như ví dụ; thiếu `logo` → không logo; thiếu `music` → không nhạc; thiếu `subtitles` → `burn-in`.
- **Không có brand** → tập vẫn dựng: không chữ, phụ đề chỉ file rời, không logo, không nhạc, cắt thẳng, `scale_pad`. `render-report.brand = "absent"`; `overlays.json` của agent (nếu có) bị bỏ qua với warning `overlays_ignored_no_brand`.

`library brands set <channel_id> --from <dir>/brand.json` (vai channel): parse, copy font/logo được tham chiếu vào `brands/<channel_id>/` (đường dẫn tương đối trong file), tính `checksums { fonts.regular, fonts.bold, logo }` ghi vào bản trong kho, `revision` = cũ + 1. `library brands show <channel_id>` in bản trong kho. Không có lệnh xoá: thư mục xoá tay = kênh bỏ thương hiệu.

### 2.2 `track.json` (`harness.music-track/v1`)

```json
{ "schema_version": "harness.music-track/v1", "track_id": "calm-01", "display_name": "Calm piano 01",
  "file": "track.wav", "mood": ["calm", "neutral"], "duration_seconds": 184.2, "loop_ok": true,
  "origin": "royalty_free", "origin_note": "Pixabay licence, tải 2026-09-20", "checksum": "sha256:…",
  "active": true, "created_at": "…" }
```

`track_id` ∈ `^[a-z0-9][a-z0-9-]{1,39}$`. `library music add --track-id --file --display-name --mood a,b --origin --origin-note [--loop-ok]` (probe `duration_seconds` bằng ffprobe, có audio stream mới nhận); `library music list`; `library music retire <id>` (`active: false`, file giữ). Track `active: false` không bao giờ được chọn nhưng tập cũ trong kho không bị đụng.

### 2.3 Chọn track

Ứng viên = `brand.music.tracks` ∩ track `active` ∩ tồn tại file. Nếu `overlays.music.mood` có, lọc ứng viên chứa mood đó; rỗng thì giữ toàn bộ ứng viên + warning `music_mood_unmatched`. Chọn phần tử thứ `hash(request_id) mod n` (sha256 → 32 bit đầu) để tập khác nhau không cùng một bài mà vẫn tái lập được. Ứng viên rỗng → `music: null`, `reason: "no_candidates" | "no_brand" | "brand_no_tracks"`.

---

## 3. `overlays.json` (`harness.overlays/v1`) — agent viết

Output thứ tư, **tuỳ chọn**, của `plan-edit` (`outputs` khai `optional: true`). Agent cũ không viết → tập không chữ, transition theo brand, nhạc chọn không mood.

```json
{ "schema_version": "harness.overlays/v1",
  "items": [
    { "id": "OV01", "kind": "title",       "text": "3 sai lầm khi rút BHXH", "anchor": { "line_id": "L001" } },
    { "id": "OV02", "kind": "callout",     "text": "27,5 %", "anchor": { "line_id": "L004", "word_index": 6 }, "seconds": 3 },
    { "id": "OV03", "kind": "lower_third", "text": "Nguồn: BHXH VN 2025", "anchor": { "edl_order": 7 } } ],
  "transitions": [ { "before_order": 7, "kind": "dip_black" } ],
  "music": { "mood": "calm" } }
```

- `id` ∈ `^OV\d{2,3}$`, duy nhất. `kind` ∈ `title | callout | lower_third`. Giới hạn ký tự: `title` ≤ 48, `callout` ≤ 24, `lower_third` ≤ 64. `seconds` optional, kẹp vào [1, 10]; mặc định `brand.text[kind].seconds`.
- `anchor` đúng một trong: `{ line_id, word_index? }` (chỉ `voice: tts`, `line_id` phải có trong `narration`, `word_index` < số từ), `{ edl_order }` (phải có trong `timeline.video`), `{ speech_index }` (chỉ `voice: original`, chỉ số trong `timeline.speech`).
- `transitions[].before_order` = `order` của đoạn **sau** điểm cắt (≥ 1), `kind` ∈ `cut | dissolve | dip_black`; không có `seconds` (theo brand).
- `music.mood` là chuỗi tự do, khớp chính xác (không phân biệt hoa/thường) với `track.mood[]`.

Checker `overlays-valid` (chạy ở `plan-edit`, chỉ khi output tồn tại): schema; độ dài; `id` duy nhất; ≤ 1 `title` cho mỗi `edl_order` (tính theo neo giải ra); neo tồn tại (đọc `edl.json` pre-fit + `narration.json` cùng stage — `timeline` chưa có ở bước này, nên `word_index` chỉ kiểm `< số từ trong text` theo tách khoảng trắng); mật độ: `seconds = max(total_narration_chars / cps, Σ(out − in) của EDL)` (lời ước lượng theo cps = 15 (en) / 14 (vi) như skill `edit-plan`; `voice: none|original` không có lời thì chỉ còn thời lượng EDL), `limit = max(1, floor(seconds / spacing))` với `spacing` = 5 s (`high`), 8 s (`medium`, mặc định), 15 s (`low`) theo `edit-style.params.text_overlay.density` nếu có trong input; số `items` > `limit` → fail. Luôn cho phép ít nhất một sự kiện (một `title` mở đầu).

**Vi phạm `overlays-valid` KHÔNG dẫn tới replan** (sửa sau Task 10, acceptance 48(a)). Một required check fail ở `plan-edit` là lỗi `result`: stage `FAILED` → **run FAILED**, và không có gì mở lại một run đã FAILED — `intake` là chỗ duy nhất đưa request `open → claimed`, `library-apply-review` là chỗ duy nhất đưa nó ngược lại, mà một run chết ở `plan-edit` không bao giờ tới được `library-apply-review`. Request **kẹt ở `claimed`** và `autoAccept` (chỉ nhìn request `open`) không bao giờ thấy nó nữa. Đây là tính chất sẵn có của vòng sub-project 4, giống hệt `edl-valid` của 5A, **không** phải thứ 5B tạo ra; ghi ở `docs/operations/deferred-items.md` mục "Sau sub-project 5B" như hổng hệ thống cần SP4 mở lại request kèm ghi chú. Đường replan **thật sự chạy** cho lỗi chữ là đường duyệt: một bản overlays qua được `overlays-valid` nhưng hỏng ở `media-compose` rơi vào `render-report.text_events.dropped` → `library-review` từ chối → `library-apply-review` đưa request về `open` → replan (acceptance 48(b)).

Skill `edit-plan` sửa: viết `overlays.json`; hướng dẫn: `title` một cái mỗi đoạn lớn, `callout` cho con số/từ khoá đúng lúc lời nói tới, `lower_third` cho nguồn; không lặp lại nguyên câu lời đọc; `transitions` chỉ ở đổi chủ đề; chọn `music.mood` theo brief.

---

## 4. `media-compose` (thuần TypeScript; `requires_resources: [cpu]`; `depends_on: [media-fit-edl, plan-edit, intake, media-index]`)

Inputs: `timeline`, `overlays` (optional), `narration` (optional), `brief`, `shots` (lấy `duration_seconds`, `width/height/fps`, `has_audio` của từng source), brand + kho nhạc đọc qua `LibraryFs`. Outputs: `composition` (`composition.json`), `captions` (thư mục `captions/` chứa `captions.srt`, `captions.vtt`), `overlay_ass` (`overlay.ass`).

### 4.1 Phụ đề (`captions.ts`)

Nguồn từ: `timeline.narration[].words` (`tts`) hoặc `timeline.speech[].words` (`original`); `voice: none` → không cue, `captions.srt` rỗng hợp lệ, `render-report.captions.reason = "voice_none"`.

Ghép từ thành cue, duyệt tuần tự trong từng dòng/segment (không ghép qua ranh giới dòng lời):
1. Đóng cue khi thêm từ kế sẽ vượt `max_chars_per_line × max_lines` ký tự, hoặc cue dài > 6 s, hoặc từ hiện tại kết thúc bằng `. , ; : ? !` và cue đã ≥ 1,2 s, hoặc khoảng lặng tới từ kế ≥ 0,5 s.
2. `start` = start từ đầu, `end` = end từ cuối; cue < 0,8 s thì kéo `end` tới `min(start + 0.8, start của cue sau − 0.05)`.
3. Xuống dòng: chỉ khi > `max_chars_per_line`; cắt tại khoảng trắng gần giữa nhất; không tách cặp `số + đơn vị` (`27,5 %`, `3 triệu`) — kiểm bằng regex số ở cuối dòng.
4. Từ thiếu mốc (`start`/`end` null hoặc `end ≤ start`): nội suy tuyến tính giữa hai từ có mốc gần nhất trong cùng dòng, warning `word_interpolated:<line_id>:<i>`.

SRT/VTT viết từ cùng danh sách cue (VTT thêm `WEBVTT` + `.` thay `,`). `captions[]` trong `composition.json` giữ `words[]` để `render-valid`/review đối chiếu.

### 4.2 Chữ trên hình (`overlays.ts`)

Neo → `start`: `line_id` → `narration[line].start`; `+ word_index` → `words[i].start`; `edl_order` → `video[order].start`; `speech_index` → `speech[i].start`. `end = start + seconds`, kẹp `end ≤ total_seconds`.

Va chạm (theo `position` quy về vùng: `top_*`, `center`, `bottom_*`): hai sự kiện cùng vùng chồng thời gian → sự kiện sau dời `start` tới `end` sự kiện trước; dời quá 2 s → bỏ, warning `overlay_dropped:<id>`. Vùng khác nhau được chồng. `lower_third` và phụ đề cùng đáy: phụ đề trong khoảng đó nâng lên `text.lower_third.size_px × 1.6` px (ghi vào cue dạng `raise_px`). Không sự kiện nào vào hộp logo (vùng góc `height_px + safe_margin_px`): `top_left|top_right` trùng góc logo thì dời sang góc kia; trùng cả hai → dùng `top_center`.

### 4.3 Chuyển cảnh (`transitions.ts`)

Với mỗi đoạn `k` (trừ đoạn cuối): `kind` = `overlays.transitions[before_order = k+1]` nếu có, không thì `brand.transition.kind`, không brand → `cut`. `seconds` = `brand.transition.seconds` (mặc định 0,4).
- `dissolve`: cần đuôi từ source đoạn `k`: `out + seconds ≤ duration(source)`; và đoạn `k+1` dài ≥ `2 × seconds`. Không đủ → `cut`, `downgraded[] { before_order, reason: "no_tail" | "next_too_short" }`.
- `dip_black`: không đuôi; fade out `seconds/2` cuối đoạn `k`, fade in `seconds/2` đầu đoạn `k+1`. Đoạn nào ngắn hơn `seconds` → `cut`, reason `too_short`.
- Kết quả `segments[k].transition_out = { kind, seconds, tail_available }`, `tail_seconds` = `seconds` khi dissolve.

### 4.4 Nhạc (`music.ts`)

Chọn track (§2.3). `cues[] = [{ start: 0, end: total_seconds, gain_db }]`; track ngắn hơn tập và `loop_ok` → `loop: true` (lặp thẳng, không crossfade ở 5B); không `loop_ok` → phát một lần, `cues[0].end = min(total, duration)`, warning `music_ends_early`. `fade_in: 1`, `fade_out: 3`. `duck.windows[]` = hợp của `narration[].start..end` (tts) hoặc `speech[].start..end` (original), nối các khoảng cách nhau < 0,5 s; `voice: none` → không cửa sổ, không ducking. Cửa sổ chỉ để **kiểm** và cho review đọc; ffmpeg ducking theo tín hiệu thật (§5.3).

### 4.5 `composition.json` (`harness.composition/v1`)

```json
{ "schema_version": "harness.composition/v1",
  "output": { "width": 3840, "height": 2160, "fps": 30, "codec": "h264" },
  "voice": "tts", "language": "vi", "total_seconds": 431.6,
  "brand": { "channel_id": "ch1", "revision": 2, "checksums": { "fonts.regular": "…", "fonts.bold": "…", "logo": "…" } },
  "segments": [ { "order": 0, "source_id": "src_…", "source_path": "…", "in": 41.2, "out": 50.3, "start": 0.0, "end": 9.1,
                  "fit": "scale_pad", "has_audio": true,
                  "transition_out": { "kind": "dissolve", "seconds": 0.4, "tail_available": true } } ],
  "text_events": [ { "id": "OV01", "kind": "title", "text": "…", "start": 0.3, "end": 4.3, "position": "top_left", "animation": "slide_up" } ],
  "captions": { "mode": "karaoke", "cues": [ { "index": 1, "start": 0.3, "end": 3.1, "lines": ["…"], "raise_px": 0, "words": [ { "word": "…", "start": 0.3, "end": 0.55 } ] } ] },
  "music": { "track_id": "calm-01", "path": "…", "loop": true, "fade_in": 1, "fade_out": 3,
             "cues": [ { "start": 0, "end": 431.6, "gain_db": -18 } ],
             "duck": { "windows": [ { "start": 0.3, "end": 8.7 } ], "gain_db": -12, "attack_ms": 150, "release_ms": 600 } },
  "logo": { "path": "…", "corner": "right", "opacity": 0.8, "height_px": 140 },
  "narration": [ { "line_id": "L001", "wav": "…", "start": 0.3, "end": 8.7 } ],
  "transitions": { "requested": 12, "applied": 10, "downgraded": [ { "before_order": 7, "reason": "no_tail" } ] },
  "warnings": [] }
```

`output.fps`: `media.render.fps` nếu số; `auto` → fps phổ biến nhất (theo tổng giây) trong các source, làm tròn về {24, 25, 30, 50, 60}, không có thông tin → 30. `music` là `null` (kèm `music_reason`) khi không nhạc; `logo` `null` khi không logo; `brand` `null` khi không brand.

**Bất biến** (checker `composition-valid` khoá lại): `segments[].start/end/in/out/order/source_id` **bằng đúng** `timeline.video[]` (sai > 1 ms → fail); mọi `text_events`/`cues` nằm trong `[0, total_seconds]`; cue không chồng nhau; `overlay.ass` parse được (đếm `Dialogue:` = số cue đốt + số text_events); số cue trong `captions.srt` = `captions.cues.length`; `transitions.applied + downgraded.length = requested`; đường dẫn `source_path`, `wav`, `music.path`, `logo.path`, font tồn tại.

### 4.6 `overlay.ass` (`ass.ts`)

`PlayResX 3840`, `PlayResY 2160`, `WrapStyle 2`, `ScaledBorderAndShadow yes`. Style: `Sub` (font regular, `subtitles.size_px`, màu `text`, viền `text_outline` 4 px, bóng 0, `\an2`, lề dưới `safe_margin_px`), `SubHi` (karaoke: `SecondaryColour` = `highlight_color`), `Title`, `Callout`, `LowerThird` (font bold cho `title`/`callout`; `box: true` → `BorderStyle 3` với `BackColour = colors.box`). Fontname trong ASS là tên family; render dùng `fontsdir=<brands/ch1/fonts>` + `fontconfig` tắt (`ass=…:fontsdir=…`), nên libass chỉ thấy font của brand — không lấy font hệ thống, kết quả giống nhau mọi máy.

Sự kiện: cue → `Dialogue: 0,<start>,<end>,Sub,,0,0,<raise_px>,,<text>`; karaoke → mỗi từ `{\kf<centiseconds>}` theo `words[]`, phần lặng giữa từ thêm `{\kf}` trống. Text event → layer 1, style theo `kind`, `\pos` từ `position` + lề; `animation`: `fade` → `\fad(250,250)`; `slide_up` → `\move(x, y+60, x, y, 0, 250)` + `\fad(250,0)`; `pop` → `\t(0,250,\fscx100\fscy100)` từ `\fscx80\fscy80` + `\fad(120,120)`; `none` → không thẻ. Ký tự `{`, `}`, `\` trong text được escape.

---

## 5. `media-render` (`requires_resources: [gpu]`; `depends_on: [media-compose, media-fit-edl, media-tts, media-index]`)

Inputs: `composition`, `overlay_ass`, `captions`, `edl` (cho `clip-set-complete`), `voice_set` (optional). Outputs: `episode_video` (`full-episode.mp4`), `clip_set` (thư mục `cuts/` chứa **liên kết/copy** mezzanine theo tên `<order>.mp4` — giữ hợp đồng cho `thumbnail-candidates`), `render_report` (`render-report.json`).

### 5.1 Tầng đoạn — mezzanine (`mezzanine.ts`)

Mỗi `segments[k]` → một lệnh ffmpeg cho **thân** (`-ss in -to out`, độ dài đúng `end − start`) và, khi `transition_out.kind = dissolve`, một lệnh nữa cho **đuôi** (`-ss out -to out + tail_seconds`, file riêng dưới **khoá của chính nó**, `<khoá đuôi>.mp4` — không có hậu tố `-tail` trên đĩa; chuỗi `-tail` chỉ nằm trong log). Thân và đuôi tách file để `clip_set` giữ đúng độ dài và đổi kiểu chuyển cảnh không làm mất cache thân. Video: `scale` (lanczos) về 3840×2160 theo `fit` (`scale_pad`: `scale=3840:2160:force_original_aspect_ratio=decrease,pad=3840:2160:(ow-iw)/2:(oh-ih)/2`; `scale_crop`: `…=increase,crop=3840:2160`), `fps=<output.fps>`, `format=yuv420p`; audio: có → `aresample=48000`, `aformat=stereo`; không có → `anullsrc=r=48000:cl=stereo` cắt đúng độ dài (**mọi mezzanine đều có tiếng**, PCM `pcm_s16le`). Encoder mezz: NVENC `h264_nvenc -preset p4 -rc vbr -cq 18 -b:v 0` / CPU `libx264 -preset veryfast -crf 16`; container `.mp4`, GOP ngắn (`-g <fps>`).

Cache: `data_root/cache/mezz/<key>.mp4` cho **cả** thân lẫn đuôi (mỗi cái một khoá, nằm phẳng cạnh nhau), `key = sha256({ source_checksum, in, out, fit, w, h, fps, has_audio, encoder, codec, mezz_version })`, đuôi thêm `tail_seconds` vào key riêng của nó (`mezz_version` là hằng trong code, tăng khi đổi filter). Hit → không chạy ffmpeg. Mỗi file có sidecar `<key>.json { key, seconds, bytes, created_at, last_used_at }` (atime Windows không tin được); dọn LRU theo `media.render.cache_max_gb` sau mỗi run bằng `last_used_at`; thiếu sidecar → coi như miss và xoá file. Không bảng SQLite cho cache. `render-report.segments.cached/rendered`.

### 5.2 Tầng cuối — hình (`final-graph.ts`)

Inputs ffmpeg: mọi mezzanine theo thứ tự, wav lời (tts), nhạc, logo. Video:
1. Mỗi mezz `[k:v]`: `dip_black` → `fade=out:st=<len−s/2>:d=<s/2>` ở đoạn trước và `fade=in:d=<s/2>` ở đoạn sau. Đoạn có dissolve → `[body][tail]concat` thành một luồng dài `len + s`.
2. Nối: cặp có `dissolve` → `xfade=transition=fade:duration=<s>:offset=<end_k − start_k>`; `offset` là độ dài đoạn **không kể đuôi**, nên đoạn sau bắt đầu đúng tại `start_{k+1}` và phần đuôi (`s` giây) của đoạn trước chồng lên `s` giây đầu đoạn sau. Cặp `cut`/`dip_black` → `concat`. Cài đặt: gom các đoạn liên tiếp không dissolve thành khối bằng `concat`, rồi `xfade` giữa các khối — số node = số đoạn + số dissolve.
3. `ass=overlay.ass:fontsdir=<fonts>` → `overlay` logo (`scale=-1:<height_px>`, `format=rgba,colorchannelmixer=aa=<opacity>`, đặt góc `safe_margin_px/2`) → `format=yuv420p`.

Tổng độ dài video sau xfade = Σ(end − start) chính xác vì mỗi dissolve tiêu đúng phần đuôi. `render-valid` kiểm `|duration − total_seconds| ≤ 0.1`.

### 5.3 Tầng cuối — tiếng (`audio-graph.ts`)

- Lời: `tts` → mỗi wav `adelay=<start_ms>|<start_ms>`, `amix` không chuẩn hoá (`normalize=0`); tiếng mezz bỏ. `original` → tiếng các mezz `concat` (không đuôi: `atrim` bỏ phần tail), `afade` 20 ms mỗi mép. `none` → tiếng mezz ở `volume=-12dB`.
- Nhạc: `aloop=loop=-1:size=<số mẫu của track>` khi `loop` (5B lặp thẳng, **không** crossfade giữa hai vòng — §11), `atrim=0:total`, `afade=in:d=1`, `afade=out:st=total−3:d=3`, `volume=<gain_db>dB`. `composition.music.loop_crossfade_seconds` không tồn tại ở 5B; §4.4 chỉ ghi `loop: true`.
- Ducking: `[music][voice_sc]sidechaincompress=threshold=0.031:ratio=6:attack=<attack_ms>:release=<release_ms>:makeup=1` (0,031 ≈ −30 dBFS). `voice_sc` là bản `asplit` của lớp lời. `voice: none` → không ducking.
- Trộn: `amix=inputs=2:normalize=0` (lời + nhạc) → `loudnorm=I=-14:TP=-1:LRA=11:print_format=json` **hai lượt**: lượt 1 chạy `-f null` trên graph tiếng để lấy `measured_*`, lượt 2 encode với `measured_*` + `linear=true`. Không nhạc → chỉ lớp lời qua loudnorm. Số đo lượt 2 ghi `render-report.loudness`.
- Encode tiếng: `aac -b:a 256k -ar 48000 -ac 2`.

### 5.4 Encoder (`encoder.ts`)

`encoder: auto` → thử `ffmpeg -f lavfi -i nullsrc=s=256x256:d=0.1 -c:v h264_nvenc -f null -` một lần mỗi run (cache 15 phút như media probe); được → `nvenc`. Phát hành: NVENC `-preset p6 -tune hq -rc vbr -cq 19 -b:v 0 -maxrate 60M -bufsize 120M -profile:v high -pix_fmt yuv420p` (hevc: `hevc_nvenc … -profile:v main -tag:v hvc1`); CPU `libx264 -preset slow -crf 18 -profile:v high -pix_fmt yuv420p` (hevc: `libx265 -crf 20`). `-movflags +faststart`, `-r <fps>`, `-g <2×fps>`.

Timeout stage = `max(1200, total_seconds × 3 + 300)` giây, khai qua `timeout_seconds` tính động trong stage (workflow khai 7200 làm trần).

### 5.5 `render-report.json` (`harness.render-report/v1`)

`{ encoder: "nvenc" | "cpu", codec, output { width, height, fps, seconds, bytes }, segments { total, rendered, cached, mezz_seconds }, transitions { requested, applied, downgraded[] }, captions { mode, cues, reason? }, text_events { total, dropped[] }, music { track_id | null, reason?, loop }, loudness { integrated_lufs, true_peak_dbtp, lra }, brand: "present" | "absent", warnings[], render_seconds, ffmpeg_version }`.

`clip_set`: `cuts/<order 3 chữ số>.mp4` là copy của mezzanine **thân** (hardlink khi cùng volume, copy khi khác), không đuôi, độ dài đúng `out − in`; `cuts/manifest.json` liệt kê `{ order, source_id, seconds }`. Checker `clip-set-complete` của 5A (đếm `NNN.mp4` theo `edl`, sai lệch ≤ 0,5 s) chạy nguyên trạng — vì thế `media-render` khai input `edl` bên cạnh `composition`.

---

## 6. Workflow, checker, review, doctor, dashboard

### 6.1 `library-production@1.3.0` (15 stage, không gate)

`intake → media-index → media-transcribe → watch-source → survey-source → plan-edit → media-tts → media-fit-edl → media-compose → media-render → watch-episode → thumbnail-candidates → library-export → library-review → library-apply-review`

- `plan-edit`: outputs thêm `overlays` (`overlays.json`, `optional: true`); required_checks thêm `overlays-valid`.
- `media-compose`, `media-render`: như §4, §5. `media-render` required_checks: `schema-valid, output-exists, checksum-match, media-probe, duration-range, audio-integrity, brief-duration, clip-set-complete, render-valid`.
- `cut`, `assemble` **không còn** trong 1.3.0. `thumbnail-candidates` `depends_on: [media-render]` (input `clip_set` giữ nguyên). `watch-episode` `depends_on: [media-render]`.
- `library-export`: `depends_on` thêm `media-render`; xuất `captions/captions.srt` và `.vtt` vào item kho (đường `hasInput("captions")` có sẵn nay có dữ liệu thật). `library-review`: inputs thêm `render_report`, `composition`.
- Profile `studio` revision 4 → `library-production@1.3.0`; `library.auto_accept.workflow_release: library-production@1.2.0` là đường lùi (ADR 111). 1.1.0 và 1.2.0 byte-identical. Test helper `freshLibraryWorld({ media1_3: true })` chọn 1.3.0; `{ media1_2: true }` giữ nghĩa cũ.
- `options_schema` của profile `studio`: `subtitles` (đang thừa, deferred-items) nay có nghĩa: request `subtitles: burn-in | karaoke | none` **ghi đè** `brand.subtitles.mode` cho tập đó.

Ops project sau 5B chỉ còn nợ wrapper `thumbnail-candidates` (go-live cập nhật). Bản mẫu `assemble.mjs`/`cut.mjs` giữ cho 1.1.0/1.2.0, không sửa.

### 6.2 Checker

- `overlays-valid` — §3.
- `composition-valid` — §4.5.
- `render-valid` — probe `episode_video`: đúng 1 video stream, 3840×2160, `fps` = `output.fps` (±0,01), `|duration − total_seconds| ≤ 0.1`, ≥ 1 audio stream 48 kHz stereo; `render-report.loudness.integrated_lufs` ∈ [−16, −12] và `true_peak_dbtp ≤ −0.5`; `captions.srt` số cue = `composition.captions.cues.length`; khi `logo` không null: trích 3 frame (`t = 1, total/2, total−1`) vùng góc logo 200×200 px bằng `ffmpeg -vf crop … -f rawvideo`, độ lệch chuẩn luma > 4 (không phải nền trơn) — bảo đảm overlay thực sự được vẽ; khi `captions.mode ≠ none` và có ≥ 1 cue: cùng cách, vùng phụ đề tại giữa cue đầu tiên có độ lệch chuẩn > 4.
- `audio-integrity`: giữ nguyên, "silent by brief" (ADR 110) vẫn đúng vì `voice: none` + sources câm + không nhạc → im lặng hợp lệ; có nhạc → có tiếng, pass.

### 6.3 `library-review`

Skill đọc thêm `render-report.json` và `composition.json`. Từ chối khi: `transitions.downgraded.length > 0.3 × requested` (chuyển cảnh gãy nhiều — thường do EDL cắt sát mép source), `text_events.dropped` không rỗng, `music == null` mà `brand` present và `brand.music.tracks` không rỗng, `warnings` chứa `word_interpolated` > 10 % số từ, `loudness` ngoài khoảng. `note` nêu `id`/`before_order` để replan sửa đúng chỗ. `fixtures/fake-agent-cli.mjs` sinh `overlays.json` hợp lệ (env `FAKE_OVERLAYS=none|medium|dense|invalid` — `dense` để test `overlays-valid` fail, `invalid` neo sai) và review đọc `render_report`.

### 6.4 Doctor, sự kiện, dashboard

Doctor: `media:render` (ffmpeg có `ass`, `xfade`, `loudnorm`, `sidechaincompress`, `overlay` + encoder `libx264`; NVENC probe — không có thì dòng in `FAIL … "no NVENC, renders on CPU"`, nhưng đó là **cảnh báo** theo đúng khuôn `ok: false`-là-cảnh-báo của `media:models`: không dựng alert doctor nào. `DoctorRow` không có mức `warn` riêng, nên `harness doctor` vẫn thoát mã 1 — đọc nội dung dòng, đừng đọc mã thoát); `library:music` (thư mục, mọi track `active` có file + checksum khớp); `channel:<id>:brand` (vai channel, khi `brands/<id>/` tồn tại: parse, font/logo tồn tại, checksum khớp); vai studio: `library:brands` (mọi brand trong kho parse được, font tồn tại — brand hỏng của kênh nào thì tập kênh đó fail sớm ở `media-compose`).

Sự kiện: `media.composed { run_id, cues, text_events, music_track }`, `media.rendered { run_id, seconds, encoder, cached_segments, rendered_segments, render_seconds }`. Dashboard `media` thêm `last_render_at`, `render_encoder`, `mezz_cache { hit_ratio }`; alert `render_cpu_fallback` khi `encoder: auto` giải ra `cpu` trên máy có GPU lease (`resources.gpu ≥ 1`).

`mezz_cache` **chỉ có `hit_ratio`** (sửa ở Task 9): `bytes` không có nguồn dữ liệu nào — snapshot dashboard dựng từ event `media.rendered`, và event đó mang số đoạn cached/rendered chứ không mang dung lượng thư mục cache. Muốn biết dung lượng thì đo thẳng `<data_root>/cache/mezz/` (runbook `studio-composition.md` mục 5).

### 6.5 CLI

`library brands set|show`, `library music add|list|retire` (§2).

`harness media compose` / `harness media render` **chỉ có dạng stage** (đọc `stage-request.json` trong `$HARNESS_WORKSPACE`, như bốn stage media của 5A) — dạng chạy tay `--timeline … --overlays … --brand-dir … --out …` / `--composition … --out …` **chưa cài** ở 1.3.0 (ghi ở deferred-items "Sau sub-project 5B"). Dựng lại một tập thì phải đi qua một run: `harness retry <run_id> --stage media-render` khi stage đó **đang FAILED/WAITING_HUMAN** (`retry` chỉ đưa hai trạng thái đó về READY), còn một stage đã SUCCEEDED thì phải `plan` một run mới (`--no-reuse` nếu muốn ép dựng lại).

---

## 7. Xử lý lỗi

| Tình huống | Hành vi |
|---|---|
| Brand khai font nhưng file thiếu / checksum lệch | Kiểm ở **`intake`, trước `claimRequest`** (cùng chỗ và cùng cách với kiểm giọng của 5A): `loadBrand` + `verifyBrandFiles` fail → `CONFIG_INVALID` nêu file. Đó là lỗi **`contract`**, mà `retry_on` của `intake` không có `contract` → stage đỗ **`WAITING_HUMAN`** sau đúng một attempt (run **chưa** FAILED); vì fail xảy ra **trước** `claimRequest` nên request vẫn `open`, không kẹt ở `claimed`. Sửa brand trong kho rồi `harness retry <run_id> --stage intake` là chạy tiếp — giống hệt đường kiểm giọng của 5A. Dashboard thấy nó qua alert `stage_waiting_human`; doctor `channel:<id>:brand` đã cảnh báo trước. `media-compose` kiểm lại lần nữa (rẻ) cho chắc. |
| Không brand | Dựng không chữ/logo/nhạc, warning, không fail (§2.1). |
| `overlays.json` neo sai / quá dài / quá dày | `overlays-valid` fail ở `plan-edit` → stage `FAILED` → **run FAILED**, request kẹt ở `claimed`, **không replan** (§3; hổng hệ thống của SP4, acceptance 48(a)). |
| Chữ va chạm không giải được | Bỏ sự kiện, `warnings`, review từ chối khi có `dropped`. |
| Source hết đuôi cho dissolve | Hạ `cut`, `downgraded[]`, không fail. |
| Nhạc không khớp mood / không ứng viên | Warning / `music: null`; review quyết. |
| Mezzanine encode fail một đoạn | Thử lại một lần bằng CPU encoder; vẫn fail → stage fail (lỗi máy), `transient` nếu ffmpeg bị kill/timeout. |
| NVENC probe fail giữa chừng (driver) | `encoder: cpu` cho toàn run, alert `render_cpu_fallback`. |
| Loudness ngoài khoảng sau lượt 2 | `render-valid` fail → stage fail (lỗi máy, không replan). |
| Cache mezz hỏng (file cụt) | Probe trước khi dùng: duration lệch > 0,05 s → xoá, render lại. |
| `voice: tts` mà `voice_set` thiếu wav | Fail sớm ở `media-compose` (đã kiểm ở `media-fit-edl`, lặp lại cho chắc). |

---

## 8. Kiểm thử

- **Thuần (không ffmpeg)**: `captions` (ngắt câu, 6 s, 0,8 s, xuống dòng, không tách số-đơn vị, nội suy); `overlays` (neo ba loại, va chạm, dời/bỏ, nâng phụ đề, tránh logo); `transitions` (đuôi đủ/thiếu, đoạn ngắn, dip_black, ưu tiên agent > brand); `music` (lọc mood, hash ổn định, loop/ends_early, cửa sổ duck); `compose` (bất biến mốc, fps auto, không brand); `ass` (số Dialogue, karaoke `\kf` tổng = độ dài cue, escape); `mezzanine`/`final-graph`/`audio-graph`/`encoder` (so chuỗi argv/filter với snapshot, mọi tổ hợp voice × nhạc × logo × mode); cache key thay đổi đúng khi đổi brand revision/font checksum; checker ba cái với fixture JSON.
- **Tích hợp có ffmpeg thật** (`tests/integration/studio-composition.test.ts`, skip nếu không có ffmpeg): sinh 3 clip 2 s màu khác nhau + 1 clip 4:3 bằng `lavfi` (`testsrc2`, `sine`), nhạc 5 s `sine 220 Hz`, logo PNG 64×64 sinh bằng ffmpeg, font: **lấy font hệ thống có sẵn** (`C:\Windows\Fonts\arial.ttf` / `/usr/share/fonts/**/DejaVuSans.ttf`, skip test đốt chữ nếu không tìm thấy); chạy `media compose` + `media render` với `encoder: cpu`, kiểm: thời lượng = Σ đoạn ± 0,1 s, 3840×2160, số cue SRT, `render-valid` pass, vùng logo không trơn, vùng phụ đề không trơn tại cue đầu, không nhạc → loudness vẫn đạt, dissolve giữa 2 đoạn không đổi thời lượng, chạy lần hai `segments.cached = total`.
- **Vòng kín 1.3.0**: `freshLibraryWorld({ media1_3: true })` + engine giả + fake agent + ffmpeg thật trên fixture nhỏ: request `tts` → 15 stage → item kho có `captions`; `FAKE_OVERLAYS=dense` → `overlays-valid` fail → replan → lần hai pass; `workflow_release: library-production@1.2.0` → chạy đường 5A không đổi.
- **Chạy thật trên máy này** (Task cuối plan): dựng lại bốn tập 5A ở 4K với brand mẫu (font Be Vietnam Pro tải về `E:\tmp-5b-studio\brand\`, nhạc `lavfi` hoặc file royalty-free tải tay — không commit), đo `render_seconds` NVENC vs CPU cho một tập, nghe/xem một tập tiếng Việt karaoke.

Acceptance 47–52 trong `docs/acceptance/` theo mẫu 5A.

---

## 9. Definition of Done sub-project 5B

1. Vòng kín `library-production@1.3.0` chạy hết với engine giả + fake agent + ffmpeg thật trên fixture nhỏ, không lệnh người; item kho có `captions.srt/.vtt`; `1.1.0`, `1.2.0` byte-identical.
2. Chạy thật trên máy này: ≥ 2 tập từ nguồn 5A ra 3840×2160 với chữ, phụ đề karaoke (vi), nhạc ducked, dissolve; `render-valid` pass; ghi `render_seconds` NVENC và CPU vào runbook.
3. Anh xem một tập tiếng Việt và xác nhận chữ/phụ đề đọc được, dấu tiếng Việt đúng, nhạc không át lời.
4. `docs/runbooks/studio-composition.md`, ADR (mục 117+), `docs/operations/deferred-items.md`, `project-template`, `docs/runbooks/go-live.md` (studio còn nợ đúng một wrapper `thumbnail-candidates`), `AGENTS.md` lệnh 5B, README quick-start.
5. `pnpm build && pnpm typecheck && pnpm test` xanh; `pnpm gen:schemas` không drift.

---

## 10. Ngoài phạm vi

9:16 / Shorts; thumbnail thật; intro/outro; kinetic typography, chữ động phức tạp; hiệu ứng ảnh (LUT, ổn định, color grade); nhiều track nhạc hoặc đổi nhạc giữa tập; SFX; dịch phụ đề sang ngôn ngữ thứ hai; kiểm giấy phép font/nhạc; render phân tán; HDR.

---

## 11. Rủi ro và điểm mở

- **`xfade` + `concat` chuỗi dài**: ffmpeg xử lý tốt vài trăm đoạn nhưng filter graph vẫn một tiến trình; nếu tập > 300 đoạn hoặc RAM > 8 GB, phương án lùi là dựng theo **khối** (mỗi 50 đoạn một mezz cấp 2) — ghi nhận, không làm ở 5B trừ khi run thật buộc.
- **Crossfade vòng lặp nhạc**: `aloop` không crossfade; nếu điểm nối nghe rõ, thêm bản trễ + `acrossfade`; quyết ở run thật.
- **libass và font Việt**: dấu chồng (ẫ, ệ) phụ thuộc font có glyph tổ hợp sẵn; runbook khuyến nghị Be Vietnam Pro / Noto Sans; test đốt chữ dùng font hệ thống nên chỉ kiểm "có vẽ", không kiểm dấu — dấu kiểm ở DoD #3.
- **`sidechaincompress` ngưỡng** cố định −30 dBFS phù hợp TTS đã chuẩn −16 LUFS (5A); `original` tiếng gốc nhỏ có thể không kích ducking → điểm mở, đo ở run thật, có thể thêm `duck_threshold_db` vào brand.
- **NVENC CQ 19 ở 4K** ~ 25–40 Mbps; YouTube khuyến nghị 35–45 Mbps cho 2160p30 — nếu bitrate thấp bất thường ở run thật, đổi sang `-cq 17`.
- **Lease `gpu` khi render CPU**: giữ đơn giản; nếu làm nghẽn `media-tts` của run khác, tách `requires_resources` theo encoder ở sub-project sau.
- **`media-render` phụ thuộc `media-fit-edl`** gián tiếp qua `edl` input: workflow khai `depends_on` thêm `media-fit-edl` để artifact `edl` (bản đã fit) là bản được nối vào, không phải `edl.json` pre-fit của `plan-edit`.
