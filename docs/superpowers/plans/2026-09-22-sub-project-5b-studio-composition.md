# Sub-project 5B: Studio Composition — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Studio dựng được tập 3840×2160 hoàn chỉnh từ `timeline.json`: chữ trên hình do agent viết, phụ đề (file rời + đốt/karaoke), nhạc nền có ducking, chuyển cảnh không dời mốc, logo; chuẩn loudness YouTube; không cần wrapper `cut`/`assemble` của ops project.

**Architecture:** Hai stage built-in mới: `media-compose` (thuần TypeScript: `timeline` + `overlays.json` + hồ sơ thương hiệu kênh + kho nhạc → `composition.json`, `captions.srt/.vtt`, `overlay.ass`) và `media-render` (ffmpeg hai tầng: mezzanine 4K từng đoạn có cache theo nội dung → một lệnh cuối nối + `xfade` + `ass` + logo + trộn tiếng + `loudnorm` + NVENC/CPU). Hồ sơ thương hiệu `brands/<channel_id>/` và kho nhạc `music/<track_id>/` do vai channel ghi, mirror vào SQLite khi sync. Workflow `library-production@1.3.0` (15 stage) thay `cut` + `assemble` bằng hai stage trên; profile `studio` revision 4.

**Tech Stack:** Node 22, pnpm workspaces, TypeScript strict ESM NodeNext (`.js` import, `exactOptionalPropertyTypes`), Zod 3 + `pnpm gen:schemas`, Vitest (test spawn CLI nạp `dist/` → `pnpm build` trước), commander; ffmpeg ≥ 6 với `libass`, `xfade`, `loudnorm`, `sidechaincompress` (máy build có 8.1 + `h264_nvenc`); không engine Python mới.

**Spec:** `docs/superpowers/specs/2026-09-22-sub-project-5b-studio-composition-design.md` ("spec"). Đọc §0–§2 trước Task 1–2, §3–§4 trước Task 3–5, §5 trước Task 6–7, §6 trước Task 8–9.

## Global Constraints

- Core thuần TypeScript; ffmpeg/ffprobe gọi qua `spawn`/`spawnSync` với `FFMPEG_PATH ?? "ffmpeg"` như `watch.ts`; mọi hàm sinh filter/argv là thuần và test bằng snapshot chuỗi, không cần ffmpeg.
- **Bất biến mốc:** `composition.segments[].start/end/in/out/order/source_id` bằng đúng `timeline.video[]`; chuyển cảnh, chữ, nhạc chỉ chồng lên trục thời gian; thời lượng tập ra = `total_seconds ± 0.1 s`.
- Không gate người; `media-compose`/`media-render` chỉ fail vì lỗi máy (brand hỏng, ffmpeg lỗi, loudness lệch); lỗi biên tập (chữ quá dày, neo sai) fail ở `overlays-valid` tại `plan-edit` → replan của SP4.
- `library-production@1.0.0`, `@1.1.0`, `@1.2.0`, `style-study@*`, `channel-*` byte-identical; mọi test SP1–5A xanh nguyên trạng (chỉ được sửa test khẳng định đếm chính xác — bảng, hàng doctor, số stage — và ghi rõ trong report). Bản mẫu `assemble.mjs`/`cut.mjs` không sửa.
- Mọi khối config mới `.strict().default({...})`; schema mới `.strict()`; `pnpm gen:schemas` sau mọi đổi schema.
- Kích thước ra cố định 3840×2160, yuv420p, AAC 256k 48 kHz stereo; loudness `I=-14:TP=-1:LRA=11`; ASS `PlayResX 3840, PlayResY 2160`; font chỉ từ `fontsdir` của brand.
- Hằng số: cue ≤ 6 s, cue ≥ 0.8 s, ngắt khi lặng ≥ 0.5 s, ngắt tại dấu câu khi cue ≥ 1.2 s; overlay `seconds` kẹp [1, 10]; dời va chạm tối đa 2 s; giới hạn ký tự `title` 48 / `callout` 24 / `lower_third` 64; mật độ spacing 5/8/15 s (high/medium/low), cps 15 (en) / 14 (vi) / 15 (khác); transition `seconds` ∈ [0.2, 1.0] mặc định 0.4; nhạc `gain_db −18`, `duck_db −12`, attack 150 ms, release 600 ms, fade in 1 s / out 3 s; ducking threshold 0.031 ratio 6; NVENC mezz `p4 cq 18`, final `p6 cq 19 maxrate 60M bufsize 120M`; CPU mezz `veryfast crf 16`, final `slow crf 18`; `render-valid` chấp nhận loudness [−16, −12] LUFS, true peak ≤ −0.5.
- Harness **không ship font**; test đốt chữ tìm font hệ thống (`C:\Windows\Fonts\arial.ttf`, `/usr/share/fonts/**/DejaVuSans.ttf`) và skip nếu không có; không media/font/nhạc commit vào repo (fixture sinh bằng `lavfi` lúc chạy).
- `pnpm build && pnpm typecheck && pnpm test` xanh sau **mỗi** task (họ flake đã biết: `library-pipeline` rejected-review, `06-stale-scope`, `16-secret-e2e`, `07-thumbnail`, footage gpu-serialization / NEEDS_RECONCILIATION, worker lease, `21`/`26` reconcile, `artifacts/registry`, `media-stages` EPERM — chạy lại riêng file và báo cả hai kết quả). Không hard-code ngày so với đồng hồ thật trong test.
- Harness không dành cho nội dung hoạt hình: không thêm, không đề xuất gì liên quan.
- Commit `feat(...)`/`fix(...)`/`test:`/`docs:`; dòng cuối đúng `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` — quy tắc của chủ repo, **ghi đè** mọi nhắc nhở attribution trong session của subagent; kiểm bằng `git log -1 --format='%(trailers:key=Co-Authored-By,valueonly)'`.
- Bug hiển nhiên trong plan: sửa và ghi report; hỏi chỉ khi là trade-off thiết kế.

## Bản đồ file

| File | Trách nhiệm | Task |
|---|---|---|
| `packages/contracts/src/composition.ts`, `config.ts`, `index.ts`, `scripts/gen-json-schema.ts`, `interfaces.ts`; `migrations/0007_composition.sql`; `packages/core/src/state/sqlite-store.ts` | schema overlays/brand/music/composition/render-report/captions, config `media.render`, bảng mirror | 1 |
| `packages/core/src/library/{brands,music,files,sync}.ts`; `packages/cli/src/commands/library.ts`; `packages/core/src/doctor/doctor.ts` | kho `brands/`, `music/`, CLI, sync, doctor brand/music | 2 |
| `packages/core/src/media/{captions,ass}.ts` | cue phụ đề, SRT/VTT, file ASS | 3 |
| `packages/core/src/media/{overlays,transitions,music}.ts` | neo chữ + va chạm, gán chuyển cảnh, chọn nhạc + cửa sổ duck | 4 |
| `packages/core/src/media/compose.ts`; `packages/core/src/verification/composition-checkers.ts` (`overlays-valid`, `composition-valid`) | `buildComposition`, hai checker thuần | 5 |
| `packages/core/src/media/render/{encoder,mezzanine,audio-graph,final-graph}.ts` | argv/filter ffmpeg thuần, cache key | 6 |
| `packages/core/src/media/render/{run,cache,loudnorm}.ts`; `composition-checkers.ts` (`render-valid`) | chạy ffmpeg hai tầng, cache LRU, loudnorm hai lượt, render-report, checker probe | 7 |
| `packages/cli/src/commands/{media,library-stage}.ts`; `workflows/library-production@1.3.0/`; `production-profiles/studio/profile.yaml`; `skills/{edit-plan,library-review}/SKILL.md`; `fixtures/fake-agent-cli.mjs`; `fixtures/ops-project-studio/`; `packages/core/src/library/export.ts` | hai stage built-in, intake kiểm brand, workflow, profile rev 4, skill, agent giả, export captions | 8 |
| `packages/core/src/doctor/doctor.ts`, `packages/core/src/dashboard/snapshot.ts`, `packages/cli/src/composition.ts`, `packages/cli/src/media-probe-cache.ts` | doctor `media:render`, event, dashboard, alert | 9 |
| `tests/integration/{library-helpers,studio-composition.test}.ts`, `tests/acceptance/47..52` | tích hợp + acceptance | 10 |
| `docs/runbooks/studio-composition.md`, ADR, AGENTS, README, deferred, template, `go-live.md` | chạy thật 4K + tài liệu | 11 |

---

### Task 1: Contracts, config `media.render`, migration `0007_composition.sql`, store

**Files:**
- Create: `packages/contracts/src/composition.ts`, `migrations/0007_composition.sql`
- Modify: `packages/contracts/src/config.ts`, `interfaces.ts` (`StateStore` thêm 6 method), `index.ts`, `packages/contracts/scripts/gen-json-schema.ts`; `packages/core/src/state/sqlite-store.ts`
- Test: `packages/contracts/test/composition.test.ts`, `packages/core/test/state/composition-store.test.ts`

**Interfaces (Produces):**

```ts
// composition.ts — import { checksumSchema, revisionSchema, schemaVersion, timestampSchema } from "./common.js"; import { idSchema } from "./ids.js"; import { WordSchema } from "./media-engine.js" (export `word` của 5A dưới tên WordSchema nếu chưa export)
export const OVERLAY_KINDS = ["title", "callout", "lower_third"] as const;
export const TRANSITION_KINDS = ["cut", "dissolve", "dip_black"] as const;
export const TEXT_POSITIONS = ["top_left", "top_center", "top_right", "center", "bottom_left", "bottom_center", "bottom_right"] as const;
export const TEXT_ANIMATIONS = ["none", "fade", "slide_up", "pop"] as const;
export const SUBTITLE_MODES = ["burn-in", "karaoke", "none"] as const;
export const OVERLAY_TEXT_MAX: Record<OverlayKind, number> = { title: 48, callout: 24, lower_third: 64 };
const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/);
const anchorSchema = z.union([
  z.object({ line_id: z.string().regex(/^L\d{3}$/), word_index: z.number().int().min(0).optional() }).strict(),
  z.object({ edl_order: z.number().int().min(0) }).strict(),
  z.object({ speech_index: z.number().int().min(0) }).strict() ]);
export const OverlaysSchema = z.object({ schema_version: schemaVersion("overlays"),
  items: z.array(z.object({ id: z.string().regex(/^OV\d{2,3}$/), kind: z.enum(OVERLAY_KINDS), text: z.string().min(1).max(64), anchor: anchorSchema, seconds: z.number().min(1).max(10).optional() }).strict()).default([]),
  transitions: z.array(z.object({ before_order: z.number().int().min(1), kind: z.enum(TRANSITION_KINDS) }).strict()).default([]),
  music: z.object({ mood: z.string().min(1).max(40) }).strict().optional() }).strict();
const textStyle = (size: number, position: TextPosition, box: boolean, animation: TextAnimation, seconds: number) =>
  z.object({ size_px: z.number().int().min(24).max(400).default(size), position: z.enum(TEXT_POSITIONS).default(position), box: z.boolean().default(box), animation: z.enum(TEXT_ANIMATIONS).default(animation), seconds: z.number().min(1).max(10).default(seconds) }).strict().default({});
export const BrandProfileSchema = z.object({ schema_version: schemaVersion("brand"), channel_id: z.string().min(1), revision: revisionSchema,
  fonts: z.object({ regular: z.string().min(1), bold: z.string().min(1), origin: z.enum(["own", "licensed", "royalty_free"]), origin_note: z.string().min(1) }).strict(),
  colors: z.object({ primary: hexColor, text: hexColor.default("#FFFFFF"), text_outline: hexColor.default("#000000"), box: hexColor.default("#000000B3") }).strict(),
  safe_margin_px: z.number().int().min(0).max(600).default(120),
  text: z.object({ title: textStyle(120, "top_left", true, "slide_up", 4), callout: textStyle(160, "center", false, "pop", 3), lower_third: textStyle(72, "bottom_left", true, "fade", 5) }).strict().default({}),
  subtitles: z.object({ mode: z.enum(SUBTITLE_MODES).default("burn-in"), size_px: z.number().int().min(24).max(300).default(88), position: z.enum(["bottom_center", "top_center"]).default("bottom_center"), max_chars_per_line: z.number().int().min(16).max(80).default(42), max_lines: z.number().int().min(1).max(3).default(2), highlight_color: hexColor.default("#F2C94C") }).strict().default({}),
  logo: z.object({ path: z.string().min(1), corner: z.enum(["left", "right"]).default("right"), opacity: z.number().min(0).max(1).default(0.8), height_px: z.number().int().min(24).max(600).default(140) }).strict().optional(),
  transition: z.object({ kind: z.enum(TRANSITION_KINDS).default("cut"), seconds: z.number().min(0.2).max(1).default(0.4) }).strict().default({}),
  source_fit: z.enum(["scale_pad", "scale_crop"]).default("scale_pad"),
  music: z.object({ tracks: z.array(z.string()).default([]), gain_db: z.number().min(-40).max(0).default(-18), duck_db: z.number().min(-40).max(0).default(-12), duck_attack_ms: z.number().int().min(10).max(2000).default(150), duck_release_ms: z.number().int().min(10).max(5000).default(600) }).strict().default({}),
  checksums: z.record(z.string(), checksumSchema).default({}),   // "fonts.regular" | "fonts.bold" | "logo" — ghi bởi `library brands set`
  created_at: timestampSchema.optional(), updated_at: timestampSchema.optional() }).strict();
export const MusicTrackSchema = z.object({ schema_version: schemaVersion("music-track"), track_id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/), display_name: z.string().min(1), file: z.string().min(1),
  mood: z.array(z.string().min(1)).min(1), duration_seconds: z.number().positive(), loop_ok: z.boolean().default(false), origin: z.enum(["own", "licensed", "royalty_free"]), origin_note: z.string().min(1),
  checksum: checksumSchema, active: z.boolean().default(true), created_at: timestampSchema, updated_at: timestampSchema }).strict();
export const CaptionCueSchema = z.object({ index: z.number().int().min(1), start: z.number().min(0), end: z.number().min(0), lines: z.array(z.string()).min(1).max(3), raise_px: z.number().int().min(0).default(0), words: z.array(WordSchema).default([]) }).strict();
export const TextEventSchema = z.object({ id: z.string(), kind: z.enum(OVERLAY_KINDS), text: z.string(), start: z.number().min(0), end: z.number().min(0), position: z.enum(TEXT_POSITIONS), animation: z.enum(TEXT_ANIMATIONS) }).strict();
export const CompositionSchema = z.object({ schema_version: schemaVersion("composition"),
  output: z.object({ width: z.literal(3840), height: z.literal(2160), fps: z.number().int(), codec: z.enum(["h264", "hevc"]) }).strict(),
  voice: z.enum(["none", "tts", "original"]), language: z.string(), total_seconds: z.number().min(0), request_id: idSchema("content_request"),
  brand: z.object({ channel_id: z.string(), revision: revisionSchema, dir: z.string(), fonts_dir: z.string(), checksums: z.record(z.string(), checksumSchema) }).strict().nullable(),
  segments: z.array(z.object({ order: z.number().int().min(0), source_id: idSchema("source_item"), source_path: z.string(), in: z.number(), out: z.number(), start: z.number(), end: z.number(), fit: z.enum(["scale_pad", "scale_crop"]), has_audio: z.boolean(),
    transition_out: z.object({ kind: z.enum(TRANSITION_KINDS), seconds: z.number(), tail_available: z.boolean() }).strict() }).strict()),
  text_events: z.array(TextEventSchema), captions: z.object({ mode: z.enum(SUBTITLE_MODES), cues: z.array(CaptionCueSchema), reason: z.string().optional() }).strict(),
  music: z.object({ track_id: z.string(), path: z.string(), loop: z.boolean(), fade_in: z.number(), fade_out: z.number(), cues: z.array(z.object({ start: z.number(), end: z.number(), gain_db: z.number() }).strict()),
    duck: z.object({ windows: z.array(z.object({ start: z.number(), end: z.number() }).strict()), gain_db: z.number(), attack_ms: z.number(), release_ms: z.number() }).strict() }).strict().nullable(),
  music_reason: z.string().optional(),
  logo: z.object({ path: z.string(), corner: z.enum(["left", "right"]), opacity: z.number(), height_px: z.number() }).strict().nullable(),
  narration: z.array(z.object({ line_id: z.string(), wav: z.string(), start: z.number(), end: z.number() }).strict()),
  transitions: z.object({ requested: z.number().int(), applied: z.number().int(), downgraded: z.array(z.object({ before_order: z.number().int(), reason: z.enum(["no_tail", "next_too_short", "too_short"]) }).strict()) }).strict(),
  text_dropped: z.array(z.object({ id: z.string(), reason: z.string() }).strict()).default([]),
  warnings: z.array(z.string()) }).strict();
export const RenderReportSchema = z.object({ schema_version: schemaVersion("render-report"), encoder: z.enum(["nvenc", "cpu"]), codec: z.enum(["h264", "hevc"]),
  output: z.object({ width: z.number().int(), height: z.number().int(), fps: z.number(), seconds: z.number(), bytes: z.number().int() }).strict(),
  segments: z.object({ total: z.number().int(), rendered: z.number().int(), cached: z.number().int(), mezz_seconds: z.number() }).strict(),
  transitions: CompositionSchema.shape.transitions, captions: z.object({ mode: z.enum(SUBTITLE_MODES), cues: z.number().int(), reason: z.string().optional() }).strict(),
  text_events: z.object({ total: z.number().int(), dropped: z.array(z.object({ id: z.string(), reason: z.string() }).strict()) }).strict(),
  music: z.object({ track_id: z.string().nullable(), reason: z.string().optional(), loop: z.boolean() }).strict(),
  loudness: z.object({ integrated_lufs: z.number(), true_peak_dbtp: z.number(), lra: z.number() }).strict().nullable(),
  brand: z.enum(["present", "absent"]), warnings: z.array(z.string()), render_seconds: z.number(), ffmpeg_version: z.string() }).strict();
// types: Overlays, OverlayKind, TextPosition, TextAnimation, SubtitleMode, TransitionKind, BrandProfile, MusicTrack, CaptionCue, TextEvent, Composition, CompositionSegment, RenderReport
// config.ts mediaConfigSchema thêm: render: z.object({ codec: z.enum(["h264","hevc"]).default("h264"), encoder: z.enum(["auto","nvenc","cpu"]).default("auto"), fps: z.union([z.literal("auto"), z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)])]).default("auto"), cache_max_gb: z.number().positive().default(60) }).strict().default({})
// StateStore: upsertBrandProfile(b: BrandProfile): void; getBrandProfile(channelId: string): BrandProfile | undefined; listBrandProfiles(): BrandProfile[];
//             upsertMusicTrack(t: MusicTrack): void; getMusicTrack(id: string): MusicTrack | undefined; listMusicTracks(filter?: { active?: boolean }): MusicTrack[]
```

```sql
-- migrations/0007_composition.sql
-- Mirrors of <kho>/brands/<channel_id>/brand.json and <kho>/music/<track_id>/track.json (channel role writes the kho; both roles mirror on sync). Not control-plane state.
CREATE TABLE brand_profile (channel_id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE music_track (id TEXT PRIMARY KEY, data TEXT NOT NULL, active INTEGER NOT NULL, updated_at TEXT NOT NULL);
```

- [ ] **Step 1: Test thất bại** — contracts: mẫu hợp lệ của 7 schema (`overlays`, `brand`, `music-track`, `caption-cue`, `text-event`, `composition`, `render-report`); `OverlaysSchema`: `id "OV1"` bị từ chối, anchor có cả `line_id` và `edl_order` bị từ chối, `items` thiếu → `[]`; `BrandProfileSchema`: tối thiểu (`fonts`, `colors.primary`) parse ra mọi default đúng như spec §2.1 (`text.title.size_px 120`, `subtitles.mode "burn-in"`, `transition.kind "cut"`, `music.gain_db -18`), màu `#12345` bị từ chối, `transition.seconds 1.5` bị từ chối; `MusicTrackSchema`: `track_id "A"` bị từ chối, `mood []` bị từ chối; `CompositionSchema`: `output.width 1920` bị từ chối; `ProjectConfigSchema` cũ → `media.render.codec "h264"`, `encoder "auto"`, `fps "auto"`, `cache_max_gb 60`; `fps: 29` bị từ chối. Store: upsert/get/list brand; upsert cùng `channel_id` → thay; music list theo `active`; hai bảng tồn tại sau migrate.
- [ ] **Step 2–4:** triển khai; thêm 7 schema vào `gen-json-schema.ts` (`overlays`, `brand`, `music-track`, `caption-cue`, `text-event`, `composition`, `render-report`); `pnpm gen:schemas`; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(contracts): overlays/brand/music-track/composition/render-report schemas, media.render config, brand_profile and music_track tables`.

---

### Task 2: Kho `brands/` và `music/` — core, CLI, sync, doctor

**Files:**
- Create: `packages/core/src/library/brands.ts`, `music.ts`
- Modify: `packages/core/src/library/files.ts` (paths `brandsDir`, `brandDir(ch)`, `brandFile(ch)`, `brandFontsDir(ch)`, `musicDir`, `trackDir(id)`, `trackFile(id)`; `listBrandChannelIds()`, `listTrackIds()`; `assertWritable`: channel ghi `brands/<ch>/**` (≥ 3 segment) và `music/<id>/<file>` (đúng 3 segment)), `sync.ts` (mirror `brands/` → `upsertBrandProfile`, `music/` → `upsertMusicTrack`; `SyncReport.imported/updated` thêm `brands`, `tracks`; `missing` kind `brand` | `track`), `packages/cli/src/commands/library.ts` (`brands set|show`, `music add|list|retire`), `packages/core/src/doctor/doctor.ts` (`library:music`, `library:brands`, `channel:<id>:brand`), `packages/core/src/index.ts`
- Test: `packages/core/test/library/{brands,music,files-brands,sync-brands}.test.ts`, `packages/cli/test/library-brands-music.test.ts`, `packages/core/test/doctor/doctor.test.ts` (thêm)

**Interfaces (Produces):**

```ts
// brands.ts
export interface LoadedBrand { brand: BrandProfile; dir: string; fonts_dir: string; font_regular_path: string; font_bold_path: string; logo_path: string | null }
export async function setBrand(d: { fs: LibraryFs; store: StateStore; clock: Clock }, p: { channel_id: string; source_path: string }): Promise<BrandProfile>
//  đọc file JSON ngoài kho (BrandProfileSchema, bỏ qua checksums/revision/timestamps có sẵn); mọi đường dẫn font/logo tương đối với thư mục chứa file nguồn; copy qua fs.copyFileWithChecksum vào brands/<ch>/fonts/<basename> và brands/<ch>/<basename logo>;
//  ghi brand.json với đường dẫn tương đối trong kho, checksums {"fonts.regular","fonts.bold","logo"?}, revision = (cũ?.revision ?? 0) + 1, created_at giữ, updated_at = clock; upsertBrandProfile. Font phải là .ttf|.otf, logo .png; thiếu file → CONFIG_INVALID nêu đường dẫn; channel_id phải khớp trường trong file.
export function loadBrand(fs: LibraryFs, channelId: string): LoadedBrand | null      // null khi brands/<ch>/ không tồn tại; parse lỗi/thiếu font → CONFIG_INVALID
export async function verifyBrandFiles(fs: LibraryFs, b: LoadedBrand): Promise<{ ok: true } | { ok: false; reason: string }>   // sha256 từng file so với checksums
// music.ts
export async function addMusicTrack(d: { fs: LibraryFs; store: StateStore; clock: Clock; prober: MediaProber }, p: { track_id: string; display_name: string; file_path: string; mood: string[]; origin: MusicTrack["origin"]; origin_note: string; loop_ok?: boolean }): Promise<MusicTrack>
//  prober.probe: phải có audio stream, duration > 5 → CONFIG_INVALID nếu không; copy giữ phần mở rộng thành music/<id>/track.<ext>; track_id tồn tại → CONFIG_INVALID (không bump — nhạc bất biến, muốn đổi thì id mới)
export function retireMusicTrack(d: { fs: LibraryFs; store: StateStore; clock: Clock }, trackId: string): MusicTrack   // active false; NOT_FOUND
export function activeTracks(store: StateStore, ids: string[]): MusicTrack[]   // theo thứ tự ids, chỉ active, bỏ id không có
// doctor: library:music (thư mục tồn tại; mọi track active trong store có file + checksum khớp — sha256FileSync); library:brands (vai studio: mọi brands/<ch>/brand.json parse + font tồn tại, liệt kê kênh hỏng);
//         channel:<id>:brand (vai channel, chỉ khi brands/<id>/ tồn tại: loadBrand + verifyBrandFiles ok; thiếu → fail nêu file)
```

CLI: `library brands set <channel_id> --from <path/brand.json> [--json]`, `library brands show <channel_id> [--json]`; `library music add --track-id --file --display-name --mood a,b --origin --origin-note [--loop-ok] [--json]`, `library music list [--json]`, `library music retire <id>`. Khuôn `voices add` (commander, `withContext`, `requireLibrary`).

- [ ] **Step 1: Test thất bại** — `files-brands`: channel ghi `brands/ch1/brand.json`, `brands/ch1/fonts/a.ttf`, `music/t1/track.json`; studio bị `CONFIG_INVALID`; channel ghi `music/t1/x/y.wav` bị từ chối. `brands`: brand mẫu + 2 font giả (file bất kỳ đuôi .ttf) + logo PNG 8×8 sinh bằng Buffer → `revision 1`, checksums 3 khoá, đường dẫn trong kho tương đối; set lại → `revision 2`, `created_at` giữ; thiếu font → `CONFIG_INVALID` nêu tên; `loadBrand` null khi không thư mục; sửa byte font → `verifyBrandFiles` `ok: false`. `music` (`skipIf(!hasFfmpeg())`): wav sine 8 s → track, `duration_seconds ≈ 8`; file không audio → từ chối; add trùng id → từ chối; retire → `active false`; `activeTracks` giữ thứ tự và bỏ retired. `sync-brands`: brand + track ghi tay được mirror ở vai studio; xoá thư mục → `missing`. CLI spawn: `brands set … --json` rồi `brands show --json`; `music add … --json` rồi `music list --json`. Doctor: `library:music` fail khi checksum lệch; `library:brands` fail nêu kênh hỏng; `channel:ch1:brand` ok / fail thiếu logo / không hàng khi không thư mục.
- [ ] **Step 2–4:** triển khai; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(library): channel-owned brand profiles and music tracks in the kho, CLI, sync mirror and doctor rows`.

---

### Task 3: Core phụ đề — `captions`, `ass`

**Files:**
- Create: `packages/core/src/media/captions.ts`, `ass.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/media/{captions,ass}.test.ts`

**Interfaces (Produces):**

```ts
// captions.ts (thuần)
export const CAPTION = { max_cue_seconds: 6, min_cue_seconds: 0.8, silence_break_seconds: 0.5, punct_break_min_seconds: 1.2, cue_gap_seconds: 0.05 } as const;
export function buildCaptionCues(p: { timeline: Timeline; max_chars_per_line: number; max_lines: number }): { cues: CaptionCue[]; warnings: string[] }
//  nguồn: voice tts → narration[].words theo từng dòng; original → speech[].words theo từng segment; none → cues []
//  từ không mốc (start/end null/undefined hoặc end <= start) → nội suy tuyến tính giữa hai từ có mốc gần nhất cùng dòng (đầu/cuối dòng dùng start/end của dòng), warning `word_interpolated:<line_id|speech_index>:<i>`
//  quy tắc đóng cue (spec §4.1): vượt max_chars_per_line × max_lines; > 6 s; từ kết thúc [.,;:?!] và cue ≥ 1.2 s; lặng tới từ kế ≥ 0.5 s; hết dòng
//  cue < 0.8 s → end = min(start + 0.8, next.start − 0.05); lines = wrapLines(text, max_chars_per_line, max_lines)
export function wrapLines(text: string, maxChars: number, maxLines: number): string[]   // ≤ maxChars/dòng, cắt tại khoảng trắng gần giữa nhất, không tách `<số>[ ]<đơn vị>` (regex /\d[\d.,]*\s?(%|[A-Za-zÀ-ỹ]{1,6})$/ ở cuối dòng trên → kéo cả cụm xuống); quá maxLines → dòng cuối nhận phần dư
export function toSrt(cues: CaptionCue[]): string   // "1\n00:00:00,300 --> 00:00:03,100\nline1\nline2\n\n"; cues rỗng → ""
export function toVtt(cues: CaptionCue[]): string   // "WEBVTT\n\n" + như SRT với "." thay ","
// ass.ts (thuần)
export interface AssInput { brand: BrandProfile | null; mode: SubtitleMode; cues: CaptionCue[]; text_events: TextEvent[]; logo: { corner: "left" | "right"; height_px: number } | null }
export function buildAss(p: AssInput): string
//  header: [Script Info] ScriptType: v4.00+, PlayResX: 3840, PlayResY: 2160, WrapStyle: 2, ScaledBorderAndShadow: yes
//  [V4+ Styles] Sub (fontname = family lấy từ tên file font regular không đuôi — libass map theo fontsdir), size subtitles.size_px, PrimaryColour = colors.text, OutlineColour = colors.text_outline, Outline 4, Shadow 0, Alignment 2 (hoặc 8 khi position top_center), MarginV = safe_margin_px;
//    SubHi = Sub + SecondaryColour = highlight_color (karaoke); Title/Callout/LowerThird theo brand.text[kind] (bold cho title/callout; box → BorderStyle 3, BackColour = colors.box)
//  màu ASS: "&H" + AA + BB + GG + RR (alpha ASS = 255 − alpha CSS; CSS không alpha → 00)
//  [Events]: cue (mode ≠ none) → layer 0, style Sub|SubHi, MarginV = safe_margin + raise_px, text = lines.join("\\N"); karaoke → mỗi từ "{\kf<cs>}" với cs = round((end−start)×100), khoảng lặng giữa từ → "{\kf<cs>}" rỗng, đầu cue lệch với từ đầu → "{\kf<cs>}" rỗng
//  text_events → layer 1, style theo kind, {\an<n>\pos(x,y)} từ position + safe_margin (top_left an7 (m,m); top_center an8 (1920,m); top_right an9 (3840−m,m); center an5 (1920,1080); bottom_* an1/an2/an3 với y = 2160−m); animation: fade → \fad(250,250); slide_up → \move(x,y+60,x,y,0,250)\fad(250,0); pop → \fscx80\fscy80\t(0,250,\fscx100\fscy100)\fad(120,120); none → không thẻ
//  escape: "{"→"\{", "}"→"\}", "\"→"\\", "\n"→"\N"; thời gian "H:MM:SS.cc"
//  brand null → chỉ header + style mặc định Arial, không sự kiện (mode none)
export function countDialogues(ass: string): number
```

- [ ] **Step 1: Test thất bại** — `captions`: timeline tts 2 dòng 12 từ có dấu chấm giữa dòng → 2+ cue, không cue vượt 6 s, không cue dưới 0.8 s, cue kết thúc tại dấu chấm khi ≥ 1.2 s; khoảng lặng 0.7 s giữa từ → ngắt; từ thiếu `end` → nội suy + warning; `original` với 2 segment → cue theo segment; `none` → `[]`; `wrapLines("Giá tăng 27,5 % so với năm trước", 20, 2)` không tách `27,5 %`; `toSrt` 2 cue → chuỗi đúng định dạng; `toVtt` bắt đầu `WEBVTT`. `ass`: 3 cue + 2 text_events burn-in → `countDialogues === 5`; karaoke → mọi Dialogue cue chứa `\kf`, tổng centiseconds của một cue = `round((end−start)×100)` ±1; `mode none` → 2 Dialogue; text `"a{b}"` được escape; màu `#F2C94C` → `&H004CC9F2`; `#000000B3` → `&H4C000000`; `slide_up` sinh `\move`; brand null → 0 Dialogue.
- [ ] **Step 2–4:** triển khai; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(core): caption cues from word timings, SRT/VTT writers, ASS builder with karaoke and branded text styles`.

---

### Task 4: Core chữ trên hình, chuyển cảnh, nhạc — `overlays`, `transitions`, `music`

**Files:**
- Create: `packages/core/src/media/overlays.ts`, `transitions.ts`, `music.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/media/{overlays,transitions,music}.test.ts`

**Interfaces (Produces):**

```ts
// overlays.ts (thuần)
export const OVERLAY = { max_shift_seconds: 2, lower_third_raise_factor: 1.6 } as const;
export function resolveAnchor(anchor: Overlays["items"][number]["anchor"], timeline: Timeline): number | null   // null khi neo không tồn tại
export function placeOverlays(p: { overlays: Overlays | null; timeline: Timeline; brand: BrandProfile; logo: { corner: "left" | "right" } | null }): { events: TextEvent[]; dropped: { id: string; reason: string }[]; warnings: string[] }
//  start = resolveAnchor; null → dropped reason "anchor_missing"; end = min(start + (item.seconds ?? brand.text[kind].seconds), total); end − start < 0.5 → dropped "too_short"
//  vùng = top | center | bottom theo position; sắp theo start; cùng vùng chồng → start' = prev.end (+ end giữ độ dài); dịch > 2 s → dropped "collision", warning `overlay_dropped:<id>`
//  logo: position top_left/top_right trùng góc logo → đổi sang góc kia; nếu góc kia cũng bị chiếm bởi sự kiện đang chồng → top_center
export function raiseCaptions(cues: CaptionCue[], events: TextEvent[], brand: BrandProfile): CaptionCue[]   // cue giao thời gian với lower_third → raise_px = round(text.lower_third.size_px × 1.6)
export function overlayDensityLimit(p: { narration: Narration | null; edl: Edl; language: string; density: "low" | "medium" | "high" }): number   // floor(seconds / spacing), seconds = Σchars/cps (tts) hoặc Σ(out−in) (khác), spacing 15/8/5
// transitions.ts (thuần)
export function assignTransitions(p: { timeline: Timeline; overlays: Overlays | null; brand: BrandProfile | null; sourceDurations: ReadonlyMap<string, number> }): { transition_out: CompositionSegment["transition_out"][]; summary: Composition["transitions"] }
//  đoạn cuối luôn cut (không đếm vào requested); kind = overlays.transitions[before_order = k+1]?.kind ?? brand?.transition.kind ?? "cut"; seconds = brand?.transition.seconds ?? 0.4
//  dissolve: cần out_k + seconds ≤ duration(source_k) (thiếu duration → coi như không đủ) và (end_{k+1} − start_{k+1}) ≥ 2 × seconds; sai → cut + downgraded no_tail | next_too_short
//  dip_black: cả hai đoạn ≥ seconds; sai → cut + too_short. requested = số k có kind ≠ cut trước hạ cấp; applied = requested − downgraded.length
// music.ts (thuần)
export function selectTrack(p: { tracks: MusicTrack[]; mood: string | undefined; request_id: string }): { track: MusicTrack | null; reason?: "no_candidates"; warnings: string[] }
//  tracks đã lọc active theo brand.music.tracks (Task 2 activeTracks); mood → lọc track.mood chứa mood (không phân biệt hoa/thường), rỗng → giữ toàn bộ + warning "music_mood_unmatched:<mood>"; chọn index = (4 byte đầu sha256(request_id) big-endian) mod n
export function buildMusicPlan(p: { track: MusicTrack; path: string; brand: BrandProfile; timeline: Timeline }): { music: NonNullable<Composition["music"]>; warnings: string[] }
//  loop = track.duration_seconds < total && loop_ok; cues[0] = { start 0, end: loop || duration ≥ total ? total : duration, gain_db }; end < total → warning "music_ends_early"
//  duck.windows = hợp của narration[].{start,end} (tts) hoặc speech[] (original), gộp khoảng cách < 0.5 s; none → []
export function duckWindows(timeline: Timeline): { start: number; end: number }[]
```

- [ ] **Step 1: Test thất bại** — `overlays`: neo `line_id` → start = narration.start; `word_index` → words[i].start; `edl_order` → video.start; `speech_index`; neo lạ → dropped `anchor_missing`; hai `title` cùng vùng chồng 1 s → cái sau dịch, dịch 3 s → dropped `collision`; `title` + `callout` chồng nhau được giữ cả hai; `top_right` trùng logo phải → thành `top_left`; `raiseCaptions` nâng đúng cue giao lower_third; `overlayDensityLimit` với 1200 ký tự en, medium → `floor(80/8) = 10`. `transitions`: dissolve đủ đuôi → applied; source hết hình → `no_tail`; đoạn sau 0.5 s với seconds 0.4 → `next_too_short`; agent ghi đè `dip_black` tại `before_order 2`; brand null → mọi cut, requested 0; đoạn cuối không đếm. `music`: 3 track, mood "calm" khớp 1 → chọn nó; mood lạ → warning + vẫn chọn; cùng `request_id` chọn ổn định, `request_id` khác có thể khác; track 10 s, tập 30 s, loop_ok → loop true; không loop_ok → cue end 10 + warning; `duckWindows` gộp hai dòng cách 0.3 s thành một.
- [ ] **Step 2–4:** triển khai; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(core): overlay placement with collision rules, transition assignment that never moves the timeline, music selection and duck windows`.

---

### Task 5: Core `compose` + checker `overlays-valid`, `composition-valid`

**Files:**
- Create: `packages/core/src/media/compose.ts`, `packages/core/src/verification/composition-checkers.ts`
- Modify: `packages/core/src/index.ts`, `packages/cli/src/composition.ts` (Verifier thêm `...compositionCheckers({ prober, available: proberAvailable, ffmpeg })`)
- Test: `packages/core/test/media/compose.test.ts`, `packages/core/test/verification/{overlays-valid,composition-valid}.test.ts`

**Interfaces (Produces):**

```ts
// compose.ts (thuần)
export interface ComposeInput { timeline: Timeline; overlays: Overlays | null; narration: Narration | null; edl: Edl; brand: LoadedBrand | null; tracks: MusicTrack[]; trackPath: (t: MusicTrack) => string;
  sources: ReadonlyMap<string, { path: string; duration_seconds: number; has_audio: boolean; fps: number | null }>; voiceSetDir: string | null; request_id: string; subtitlesOverride?: SubtitleMode;
  render: MediaConfig["render"] }
export function buildComposition(p: ComposeInput): { composition: Composition; srt: string; vtt: string; ass: string }
//  fps: render.fps số → dùng; "auto" → fps phổ biến nhất theo tổng giây (làm tròn về {24,25,30,50,60} gần nhất), không có → 30
//  segments từ timeline.video: source_path/has_audio từ sources (thiếu → HarnessError CONFIG_INVALID), fit = brand?.source_fit ?? "scale_pad", transition_out từ assignTransitions
//  brand null → text_events [], captions.mode "none" (cues vẫn tính để SRT/VTT), music null reason "no_brand", logo null, warning "overlays_ignored_no_brand" nếu overlays có items
//  mode = subtitlesOverride ?? brand.subtitles.mode; voice none → cues [], captions.reason "voice_none"
//  music: brand.music.tracks rỗng → null "brand_no_tracks"; activeTracks rỗng → "no_candidates"
//  narration[] = timeline.narration map wav → join(voiceSetDir, basename) (tuyệt đối); voice tts mà voiceSetDir null → CONFIG_INVALID
//  warnings = gộp captions + overlays + transitions + music
// composition-checkers.ts
export function compositionCheckers(o: { prober: MediaProber; available?: boolean; ffmpeg?: string }): Checker[]   // overlays-valid 1.0.0, composition-valid 1.0.0, render-valid 1.0.0 (Task 7)
//  overlays-valid: output type "overlays" không có → skip "no matching output"; parse OverlaysSchema; text > OVERLAY_TEXT_MAX[kind] → fail; id trùng → fail; ≤ 1 title mỗi edl_order giải ra (line_id → narration line.edl_order; edl_order trực tiếp; speech_index → bỏ qua kiểm này) → fail; neo: line_id phải có trong output "narration" (cùng stage), word_index < số từ tách khoảng trắng của text; edl_order phải có trong output "edl"; transitions[].before_order ∈ orders; density: items.length ≤ overlayDensityLimit(density từ input "edit_style"?.params.text_overlay.density ?? "medium") → fail nêu limit
//  composition-valid: output "composition" + input "timeline": segments ↔ video từng trường (|Δ| > 0.001 → fail nêu order/trường); text_events/cues trong [0, total]; cues không chồng (start_i+1 ≥ end_i − 0.001); output "overlay_ass" countDialogues === (mode none ? 0 : cues.length) + text_events.length; output dir "captions": captions.srt số block = cues.length; transitions.applied + downgraded.length === requested; mọi source_path, narration wav, music.path, logo.path, brand.fonts_dir tồn tại
```

- [ ] **Step 1: Test thất bại** — `compose`: timeline 3 đoạn + brand đầy đủ + 2 track + overlays 3 item → `CompositionSchema.parse` ok, segments bằng timeline từng trường, `text_events` 3, cues > 0, `music.track_id` ∈ tracks, `logo` không null, ASS Dialogue = cues + 3, SRT block = cues; brand null → text_events [], mode none, music null "no_brand", warning; `subtitlesOverride "karaoke"` thắng brand; `render.fps 25` → 25; nguồn 25 fps + 30 fps (30 dài hơn) → 30; voice tts thiếu voiceSetDir → `CONFIG_INVALID`. `overlays-valid` (fixture workspace tay như test `survey-valid`): hợp lệ pass; `callout` 30 ký tự fail nêu id; hai title cùng `edl_order` fail; `line_id` không có fail; 20 items với lời 300 ký tự medium fail nêu limit; không output → skip. `composition-valid`: pass; sửa `segments[1].start` +0.01 → fail nêu order; ASS thiếu một Dialogue → fail; thiếu file wav → fail.
- [ ] **Step 2–4:** triển khai; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(core): buildComposition and the overlays-valid / composition-valid checkers`.

---

### Task 6: Graph ffmpeg thuần — `encoder`, `mezzanine`, `audio-graph`, `final-graph`

**Files:**
- Create: `packages/core/src/media/render/{encoder,mezzanine,audio-graph,final-graph}.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/media/render/{encoder,mezzanine,audio-graph,final-graph}.test.ts`

**Interfaces (Produces):**

```ts
// encoder.ts
export type EncoderChoice = "nvenc" | "cpu";
export function videoEncoderArgs(p: { choice: EncoderChoice; codec: "h264" | "hevc"; tier: "mezz" | "final"; fps: number }): string[]
//  nvenc mezz: ["-c:v","h264_nvenc","-preset","p4","-rc","vbr","-cq","18","-b:v","0"]; final: [...,"-preset","p6","-tune","hq","-rc","vbr","-cq","19","-b:v","0","-maxrate","60M","-bufsize","120M","-profile:v","high"]; hevc → "hevc_nvenc", final profile main + ["-tag:v","hvc1"]
//  cpu mezz: ["-c:v","libx264","-preset","veryfast","-crf","16"]; final: ["-c:v","libx264","-preset","slow","-crf","18","-profile:v","high"]; hevc → libx265 crf 20 (mezz 18)
//  luôn thêm ["-pix_fmt","yuv420p","-r",String(fps),"-g",String(tier === "mezz" ? fps : 2*fps)]
export const NVENC_PROBE_ARGS = ["-hide_banner","-f","lavfi","-i","nullsrc=s=256x256:d=0.1","-c:v","h264_nvenc","-f","null","-"];
export function resolveEncoder(cfg: "auto" | "nvenc" | "cpu", nvencAvailable: boolean): EncoderChoice   // auto → nvenc nếu available; "nvenc" mà không available → cpu (warning ở runner)
// mezzanine.ts
export const MEZZ_VERSION = 1;
export function mezzCacheKey(p: { source_checksum: string; in: number; out: number; fit: "scale_pad" | "scale_crop"; w: number; h: number; fps: number; has_audio: boolean; encoder: EncoderChoice; codec: "h264" | "hevc"; tail_seconds?: number }): string   // sha256 hex của JSON khoá sắp xếp + MEZZ_VERSION
export function scaleFilter(fit: "scale_pad" | "scale_crop", w: number, h: number): string
//  scale_pad: `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`; scale_crop: `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}`
export function mezzArgs(p: { ffmpeg: string; source: string; in: number; out: number; fit; w; h; fps; has_audio: boolean; encoder: EncoderChoice; codec; out_path: string }): string[]
//  [ffmpeg,"-hide_banner","-y","-ss",in,"-to",out,"-i",source, (has_audio ? [] : ["-f","lavfi","-t",String(out−in),"-i","anullsrc=r=48000:cl=stereo"]),
//   "-filter_complex", `[0:v]${scaleFilter},fps=${fps},format=yuv420p[v];` + (has_audio ? `[0:a]aresample=48000,aformat=channel_layouts=stereo[a]` : `[1:a]anull[a]`), "-map","[v]","-map","[a]", ...videoEncoderArgs(mezz), "-c:a","pcm_s16le","-ar","48000","-ac","2","-t",String(out−in),"-movflags","+faststart", out_path]
//  (vì trim bằng -ss/-to trước -i nên thời lượng ra đúng out−in; -t kẹp thêm để mọi mezz dài chính xác)
// audio-graph.ts (thuần)
export interface AudioGraphInput { composition: Composition; mezzIndex: (order: number) => number /* index input ffmpeg của body */; narrationIndex: (line_id: string) => number; musicIndex: number | null; loudnorm: LoudnormMeasured | null }
export function audioGraph(p: AudioGraphInput): { filter: string; out: string /* label "[aout]" */ }
//  voice tts: mỗi narration → `[i:a]adelay=${ms}|${ms}[n_k]`; `[n_0]...[n_N-1]amix=inputs=N:normalize=0:duration=longest[voice]`; N=0 → `anullsrc=r=48000:cl=stereo,atrim=0:${total}[voice]`
//  original: `[i:a]atrim=0:${end−start},afade=t=in:d=0.02,afade=t=out:st=${len−0.02}:d=0.02[s_k]` mỗi đoạn → `concat=n=N:v=0:a=1[voice]`
//  none: như original rồi `volume=-12dB`
//  music != null: `[m:a]` + (loop ? `aloop=loop=-1:size=2e9,` : "") + `atrim=0:${total},afade=t=in:d=${fade_in},afade=t=out:st=${total−fade_out}:d=${fade_out},volume=${gain_db}dB[music]`;
//    voice ≠ none → `[voice]asplit=2[voice_mix][voice_sc];[music][voice_sc]sidechaincompress=threshold=0.031:ratio=6:attack=${attack_ms}:release=${release_ms}:makeup=1[music_d];[voice_mix][music_d]amix=inputs=2:normalize=0:duration=first[mix]`; voice none → `[voice][music]amix=...[mix]`
//  music null → `[voice]anull[mix]`
//  loudnorm: measured null → `[mix]loudnorm=I=-14:TP=-1:LRA=11:print_format=json[aout]`; có measured → `...:measured_I=..:measured_TP=..:measured_LRA=..:measured_thresh=..:offset=..:linear=true:print_format=json[aout]`
// final-graph.ts (thuần)
export interface FinalGraphInput { ffmpeg: string; composition: Composition; mezz: { order: number; body: string; tail: string | null }[]; assPath: string | null; fontsDir: string | null; encoder: EncoderChoice; loudnorm: LoudnormMeasured | null; out_path: string; measureOnly: boolean }
export function finalArgs(p: FinalGraphInput): { argv: string[]; inputs: { kind: "body" | "tail" | "narration" | "music" | "logo"; path: string; index: number }[] }
//  inputs theo thứ tự: body_0, tail_0?, body_1, ..., narration wavs (tts), music, logo (png)
//  video: mỗi đoạn `[b_k:v]` (+ dip_black fades theo transitions: đoạn k có transition_out dip_black → `fade=t=out:st=${len−s/2}:d=${s/2}`; đoạn k+1 → `fade=t=in:d=${s/2}`); dissolve → `[b_k:v][t_k:v]concat=n=2:v=1:a=0[v_k]`
//    nối: gom khối liên tiếp không dissolve `concat=n=M:v=1:a=0`; giữa khối `xfade=transition=fade:duration=${s}:offset=${Σ độ dài khối trước (không đuôi)}` — offset tính trên luồng tích luỹ: offset_j = Σ_{i<j}(len_i) với len = end−start của từng đoạn thuộc các khối trước
//    → `[vcat]`; assPath → `ass=filename='${escape(assPath)}':fontsdir='${escape(fontsDir)}'` (escape ':' '\' ''' theo quy tắc filter ffmpeg; Windows `C:\` → `C\:/`); logo → `[logo:v]scale=-1:${height_px},format=rgba,colorchannelmixer=aa=${opacity}[lg];[v][lg]overlay=${corner left ? m/2 : W-w-m/2}:${m/2}[vout]` với m = safe_margin_px (brand) ; format=yuv420p cuối
//  measureOnly → argv = [ffmpeg,-hide_banner,-y, inputs..., -filter_complex <chỉ audio graph với loudnorm measured null>, -map [aout], -f null, -]  (không video)
//  đầy đủ → [..., -filter_complex <video + audio>, -map [vout] -map [aout], ...videoEncoderArgs(final), -c:a aac -b:a 256k -ar 48000 -ac 2, -movflags +faststart, out_path]
export function escapeFilterPath(p: string): string
```

- [ ] **Step 1: Test thất bại** — `encoder`: 8 tổ hợp choice×codec×tier snapshot; `resolveEncoder("auto", false) === "cpu"`. `mezzanine`: key đổi khi đổi `in`, `fit`, `encoder`, `MEZZ_VERSION`; không đổi khi đổi thứ tự khoá; `mezzArgs` có audio chứa `aresample=48000` và không `anullsrc`; không audio chứa `anullsrc` và `-t`; `scale_crop` chứa `crop=3840:2160`. `audio-graph`: tts 2 dòng + nhạc → chứa `adelay=300|300`, `sidechaincompress`, `amix=inputs=2`; original → `concat=n=3:v=0:a=1`, `afade`; none không nhạc → `volume=-12dB` và `anull[mix]`; loudnorm measured → chứa `linear=true` và `measured_I=`; tts 0 dòng → `anullsrc`. `final-graph`: 3 đoạn, dissolve giữa 0–1 → argv chứa `xfade=transition=fade:duration=0.4:offset=<len0>` và `concat=n=2` cho body+tail; dip_black giữa 1–2 → `fade=t=out` và `fade=t=in`; ass + fontsDir Windows → `ass=filename='E\:/x/overlay.ass':fontsdir='E\:/x/fonts'`; logo → `overlay=`; `measureOnly` → không `-map [vout]`, có `-f null`; inputs index đúng thứ tự.
- [ ] **Step 2–4:** triển khai; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(core): pure ffmpeg argument builders for mezzanine, audio mix with ducking and loudnorm, and the final composition graph`.

---

### Task 7: Runner render — `run`, `cache`, `loudnorm`, checker `render-valid`

**Files:**
- Create: `packages/core/src/media/render/{run,cache,loudnorm}.ts`
- Modify: `packages/core/src/verification/composition-checkers.ts` (`render-valid`), `packages/core/src/index.ts`
- Test: `packages/core/test/media/render/{cache,loudnorm,run}.test.ts`, `packages/core/test/verification/render-valid.test.ts`

**Interfaces (Produces):**

```ts
// loudnorm.ts (thuần)
export interface LoudnormMeasured { input_i: number; input_tp: number; input_lra: number; input_thresh: number; target_offset: number }
export interface LoudnormOutput { output_i: number; output_tp: number; output_lra: number }
export function parseLoudnorm(stderr: string): { measured: LoudnormMeasured; output: LoudnormOutput } | null   // khối JSON cuối cùng sau "[Parsed_loudnorm"; giá trị "-inf" → −99
// cache.ts
export interface MezzCache { dir: string; maxBytes: number }
export function cacheLookup(c: MezzCache, key: string, ext: "mp4"): string | null            // <dir>/<key>.mp4 tồn tại và sidecar <key>.json parse → cập nhật last_used_at, trả path; thiếu sidecar → coi như miss (xoá file)
export function cacheCommit(c: MezzCache, key: string, tmpPath: string, meta: { seconds: number; bytes: number; now: string }): string   // rename tmp → <key>.mp4, ghi sidecar { key, seconds, bytes, created_at, last_used_at }
export function cacheEvict(c: MezzCache): { removed: number; bytes: number }                    // tổng bytes > maxBytes → xoá theo last_used_at cũ nhất tới khi ≤ maxBytes
// run.ts
export interface RenderDeps { ffmpeg: string; prober: MediaProber; cache: MezzCache; nvencAvailable: () => Promise<boolean>; clock: Clock; log?: (line: string) => void; spawn?: typeof import("node:child_process").spawn }
export interface RenderInput { composition: Composition; assPath: string | null; outDir: string; encoderCfg: "auto" | "nvenc" | "cpu"; timeoutSeconds: number; sourceChecksums: ReadonlyMap<string, string> }
export async function renderComposition(d: RenderDeps, p: RenderInput): Promise<{ report: RenderReport; episodePath: string; clipSetDir: string }>
//  1) encoder = resolveEncoder(cfg, await nvencAvailable()); cfg "nvenc" mà không có → warning "nvenc_unavailable_cpu_fallback"
//  2) mỗi segment: key thân (+ key đuôi khi dissolve tail_available) → cacheLookup; miss → mezzArgs vào <outDir>/tmp/<key>.mp4 → probe duration lệch > 0.05 s → IO_ERROR; cacheCommit. Encode fail với nvenc → thử lại 1 lần cpu cho đoạn đó (warning); vẫn fail → IO_ERROR (transient khi ffmpeg bị kill/timeout: exit null)
//  3) clip_set: <outDir>/cuts/<order 3 chữ số>.mp4 = hardlink (linkSync) thân, EXDEV/EPERM → copyFileSync; cuts/manifest.json [{ order, source_id, seconds }]
//  4) lượt đo: finalArgs({ measureOnly: true, loudnorm: null }) → parseLoudnorm(stderr) → measured (null → IO_ERROR "loudnorm measure failed")
//  5) lượt render: finalArgs({ measureOnly: false, loudnorm: measured }) → <outDir>/full-episode.mp4; parseLoudnorm(stderr) → output
//  6) probe file ra → report (output.fps từ probe, bytes statSync); cacheEvict; report.render_seconds
//  spawn bất đồng bộ (không spawnSync) với timeout → kill; stderr giữ 4000 ký tự cuối cho log
export async function probeNvenc(ffmpeg: string): Promise<boolean>   // spawn NVENC_PROBE_ARGS, exit 0 → true; timeout 20 s → false
// render-valid (composition-checkers.ts): output "episode_video" + output "render_report" + input "composition":
//  probe: video đúng 1 stream (prober.probe.video != null) — 3840×2160; |fps − composition.output.fps| ≤ 0.01; |duration − total_seconds| ≤ 0.1; audio != null, sample_rate 48000, channels 2
//  report.loudness: integrated ∈ [−16, −12], true_peak ≤ −0.5 (null → fail)
//  output dir "captions": số block SRT = composition.captions.cues.length
//  logo != null → frameStdDev(t ∈ {1, total/2, total−1}, vùng góc: x = corner left ? 0 : 3840−260, y = 0, 260×260) > 4 với ít nhất 2/3 frame; captions.mode ≠ none && cues > 0 → frameStdDev(t = giữa cue[0], vùng x 1420..2420, y = 2160−safe−size×3 .. 2160) > 4
//  frameStdDev: `ffmpeg -ss t -i file -frames:v 1 -vf crop=w:h:x:y,format=gray -f rawvideo -` → stddev của Buffer; ffmpeg lỗi → fail "frame extract failed"
//  prober không có (available false) → skip
```

- [ ] **Step 1: Test thất bại** — `loudnorm`: stderr mẫu (ffmpeg thật, 2 khối JSON) → measured từ khối cuối; `-inf` → −99; không JSON → null. `cache`: commit rồi lookup hit + `last_used_at` tăng; thiếu sidecar → miss và file bị xoá; evict với maxBytes nhỏ xoá cũ nhất. `run` (`skipIf(!hasFfmpeg())`, 120 s; `encoderCfg: "cpu"`): composition 2 đoạn từ 2 clip `testsrc2` 2 s (một có `sine`, một không) 640×360 25 fps, không brand (assPath null, logo null, music null), voice none → `full-episode.mp4` 3840×2160, thời lượng 4 ± 0.1, có audio 48 kHz stereo, `cuts/000.mp4` + `001.mp4` thời lượng 2 ± 0.05, `report.segments.rendered 2`; chạy lại cùng cache → `cached 2`, `rendered 0`; dissolve giữa 2 đoạn (source 3 s, out 2, đuôi 0.4 có) → thời lượng vẫn 4 ± 0.1 và `report.transitions.applied 1`; voice tts với 1 wav sine 1 s tại 0.5 → audio không câm ở giây 1 (volumedetect > −60 dB); music sine 220 Hz 3 s loop → tập 4 s vẫn có nhạc ở giây 3.5; `loudness.integrated_lufs` ∈ [−16, −12]. `render-valid` (fixture từ run test hoặc file sinh riêng): pass; sửa `total_seconds` +1 trong composition → fail; report loudness −20 → fail; không prober → skip.
- [ ] **Step 2–4:** triển khai; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(core): two-tier renderer with content-addressed mezzanine cache, two-pass loudnorm, clip_set and render-report; render-valid checker`.

---

### Task 8: Stage `media compose|render`, intake kiểm brand, workflow `library-production@1.3.0`, profile, skill, agent giả, export captions

**Files:**
- Create: `workflows/library-production@1.3.0/workflow.yaml`
- Modify: `packages/cli/src/commands/media.ts` (`MEDIA_STAGE_NAMES` thêm `compose`, `render`; `builtinMediaCommands` thêm `media-compose|media-render`), `packages/cli/src/commands/library-stage.ts` (intake kiểm brand; `library-export` captions thư mục), `packages/core/src/library/export.ts` (`captionsDir?`), `production-profiles/studio/profile.yaml` (rev 4), `skills/{edit-plan,library-review}/SKILL.md`, `fixtures/fake-agent-cli.mjs`, `fixtures/ops-project-studio/project.yaml` (`workflows` thêm 1.3.0), `packages/adapters/agent-cli/src/cli-agent-runtime.ts` (`FAKE_OVERLAYS` vào `FAKE_AGENT_TEST_ENV`), `tests/integration/library-helpers.ts` (`freshLibraryWorld({ media1_3?: true })`, `setBrand(world, channelId, { withLogo?: boolean })`, `addTrack(world, id)`)
- Test: `packages/cli/test/composition-stages.test.ts`, `packages/core/test/orchestration/library-production-1-3.test.ts`, `packages/adapters/agent-cli/test/fake-agent-outputs.test.ts` (thêm), `packages/core/test/library/export-captions.test.ts`

**Stage built-in (khuôn `mediaFitEdlStage`; lỗi map y hệt 5A):**
- `compose`: inputs `timeline`, `brief`, `edl`, `shots`, `overlays` (optional → null), `narration` (optional), `voice_set` (optional dir); `brand = loadBrand(lib.fs, brief.channel_id)` (brief đã có `channel_id` — kiểm; nếu không, lấy qua `app.store.getContentRequest(request_id).channel_id`), `verifyBrandFiles` lệch → `CONFIG_INVALID`; `tracks = activeTracks(store, brand.music.tracks)`, `trackPath = join(lib.fs.paths.trackDir(id), track.file)`; `sources`: từ `sdk.sources` (path) + `shots.sources` (duration, has_audio) + `app.prober`/shots cho fps; `subtitlesOverride` từ `brief.options.subtitles` (`"burn-in"|"karaoke"|"none"` → dùng; `"false"` → `"none"`; `"true"`/thiếu → undefined); `render` từ `app.mediaConfig.render`; → `output/composition.json` (type `composition`), `output/captions/captions.srt|.vtt` (type `captions`, dir), `output/overlay.ass` (type `overlay_ass`); event `media.composed { run_id, cues, text_events, music_track }`.
- `render`: inputs `composition`, `overlay_ass`, `captions`, `edl`, `voice_set` (optional); `sourceChecksums` từ `app.store.getSourceItem(id).checksum`; `cache = { dir: join(app.dataRoot, "cache", "mezz"), maxBytes: render.cache_max_gb × 2^30 }`; `nvencAvailable` = `probeNvenc` có cache TTL 900 s trong `media-probe-cache.ts` (hàm mới `resolveNvencProbe`); `timeoutSeconds = max(1200, total × 3 + 300)` kẹp ≤ giây còn lại tới `request.limits.deadline_at − 30`; → `output/full-episode.mp4` (type `episode_video`), `output/cuts/` (type `clip_set`, dir), `output/render-report.json` (type `render_report`); event `media.rendered { run_id, seconds, encoder, cached_segments, rendered_segments, render_seconds }`; `report.encoder === "cpu"` với cfg `auto` → warning trong report `encoder_cpu` (dashboard đọc).
- `intake` (library-stage.ts): **trước** `claimRequest`, sau kiểm giọng: `brand = loadBrand(fs, channel_id)`; có → `verifyBrandFiles` fail → `CONFIG_INVALID` nêu file (request không bị claim). Không thêm trường brief.
- `library-export`: `sdk.hasInput("captions")` → nếu path là thư mục → `captionsDir`; `exportItem` copy `captions.srt` và `captions.vtt` vào item (files `captions.srt`, `captions.vtt`); là file (đường cũ) → `captions.json` như cũ.

**`workflows/library-production@1.3.0/workflow.yaml`:** chép nguyên 1.2.0, `version: 1.3.0`, rồi:

```yaml
  # plan-edit: outputs thêm { type: overlays, mime_type: application/json, name: overlays.json, optional: true }  (kiểm khoá `optional` có trong schema stage output; nếu chưa có, thêm vào contracts với default false và checker output-exists bỏ qua optional thiếu); required_checks thêm overlays-valid; brief thêm câu: "Viết output/overlays.json (harness.overlays/v1): title/callout/lower_third neo vào line_id/edl_order, transitions ghi đè, music.mood."
  # xoá stage cut và assemble; thay bằng:
  - key: media-compose
    executor: { type: script, script: media-compose }
    depends_on: [media-fit-edl, plan-edit, intake, media-index, media-tts]
    requires_resources: [cpu]
    required_checks: [schema-valid, output-exists, checksum-match, composition-valid]
    outputs:
      - { type: composition, mime_type: application/json, name: composition.json }
      - { type: captions, mime_type: application/x-directory, kind: directory, name: captions }
      - { type: overlay_ass, mime_type: text/plain, name: overlay.ass }
  - key: media-render
    executor: { type: script, script: media-render }
    depends_on: [media-compose, media-fit-edl, media-tts, media-index, intake]
    requires_resources: [gpu]
    timeout_seconds: 7200
    retry: { max_attempts: 2, backoff_seconds: [60], retry_on: [transient, abandoned] }
    required_checks: [schema-valid, output-exists, checksum-match, media-probe, duration-range, audio-integrity, brief-duration, clip-set-complete, render-valid]
    outputs:
      - { type: episode_video, mime_type: video/mp4, name: full-episode.mp4 }
      - { type: clip_set, mime_type: application/x-directory, kind: directory, name: cuts }
      - { type: render_report, mime_type: application/json, name: render-report.json }
  # watch-episode: depends_on: [media-render]; thumbnail-candidates: depends_on: [media-render]
  # library-export: depends_on thay assemble → media-render (giữ thumbnail-candidates, plan-edit, intake)
  # library-review: depends_on thêm media-compose, media-render; brief thêm: "đọc render-report.json và composition.json: từ chối khi downgraded > 30 % requested, text_events.dropped không rỗng, music null dù brand có track, word_interpolated > 10 % số từ, loudness ngoài [−16,−12]"
```

`production-profiles/studio/profile.yaml`: `revision: 4`, `workflow_release: library-production@1.3.0`, `options_schema.subtitles: ["burn-in", "karaoke", "none", "true", "false"]`, phần còn lại giữ. Artifact type enum (nếu đóng): thêm `overlays`, `composition`, `captions` (đã có?), `overlay_ass`, `render_report`.

**Skill:** `edit-plan` thêm mục "Cấu trúc `output/overlays.json`" (JSON mẫu spec §3, giới hạn ký tự, quy tắc neo, ≤ 1 title mỗi đoạn, không lặp nguyên câu lời, transitions chỉ ở đổi chủ đề, `music.mood` theo brief); `library-review` thêm bước đọc `render-report.json`/`composition.json` với 5 điều kiện từ chối và `note` nêu `id`/`before_order`.

**`fake-agent-cli.mjs`:** `plan-edit` → viết `overlays.json` theo `FAKE_OVERLAYS` (`none` → không file; `medium` (mặc định) → 1 `title` neo `L001` (hoặc `edl_order 0` khi không tts) + 1 `callout` neo `edl_order` giữa + `music.mood "calm"`; `dense` → 30 callout cùng `edl_order 0`; `invalid` → neo `line_id "L999"`); khi `brief.request_notes` chứa "chữ" → `medium`. `review` → nếu có input `render_report`: `transitions.downgraded.length > 0.3 × requested` || `text_events.dropped.length > 0` || (`music.track_id === null` && `music.reason` không thuộc {`no_brand`,`brand_no_tracks`}) → `rejected`, `note` "chữ …"/"nhạc …".

- [ ] **Step 1: Test thất bại** — workflow: 1.3.0 nạp, 15 stage đúng thứ tự spec §6.1, không `cut`/`assemble`, `media-render.requires_resources === ["gpu"]`, `plan-edit` có output `overlays` optional; 1.0.0/1.1.0/1.2.0 không đổi (so `git show HEAD:` hoặc đếm stage); profile rev 4. `composition-stages.test.ts` (CLI spawn, `pnpm build`, `skipIf(!hasFfmpeg())`, `adapters.media: fake`, workspace tay như `media-stages.test.ts`): kho có brand (font hệ thống copy vào, logo PNG sinh) + 1 track sine → `media compose` với timeline 2 đoạn + overlays medium → 3 output, `composition-valid` pass qua Verifier thật; brand thiếu font → exit ≠ 0 `contract`; không brand → `captions.mode none`, exit 0; `media render` (`encoder: cpu`) → `full-episode.mp4` 4K, `cuts/000.mp4`, `render-report.json`, `render-valid` + `clip-set-complete` pass; chạy lại → `cached === total`. Intake: brand hỏng → run FAILED tại intake, request vẫn `open`. Export: `captionsDir` → item có `captions.srt`, `.vtt`. Fake agent: `FAKE_OVERLAYS=medium` qua `overlays-valid`; `dense` fail; `invalid` fail; review từ chối khi `render_report.text_events.dropped` không rỗng.
- [ ] **Step 2–4:** triển khai; `fixtures/ops-project-studio/project.yaml` `workflows` thêm `library-production@1.3.0`; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat: media compose/render stages, brand check at intake, library-production@1.3.0, studio profile rev 4, overlays in skills and fake agent, captions export`.

---

### Task 9: Doctor `media:render`, event, dashboard

**Files:**
- Modify: `packages/core/src/doctor/doctor.ts` (`media:render`), `packages/cli/src/composition.ts` (`computeDoctorRows` nhận `render: { filters: string[]; encoders: string[]; nvenc: boolean | null }` từ `ffmpeg -filters`/`-encoders` — chạy một lần, cache như media probe), `packages/cli/src/media-probe-cache.ts` (`resolveNvencProbe`, `resolveFfmpegCapabilities` TTL 900 s), `packages/core/src/dashboard/snapshot.ts` (`media` thêm `last_render_at`, `render_encoder`, `mezz_cache: { hit_ratio, bytes: null }`; alert `render_cpu_fallback`)
- Test: `packages/core/test/doctor/doctor.test.ts` (thêm), `packages/core/test/dashboard/snapshot.test.ts` (thêm), `packages/cli/test/media-probe-cache.test.ts` (thêm)

**Interfaces (Produces):**

```ts
// doctor (vai studio, mọi adapter): media:render — ffmpeg có filters {ass, xfade, loudnorm, sidechaincompress, overlay} và encoder libx264 → ok; thiếu → fail liệt kê; có đủ nhưng nvenc false → ok:false detail "no NVENC, renders on CPU" (cảnh báo, không alert — cùng khuôn media:models)
// snapshot: media.last_render_at = occurred_at của event media.rendered mới nhất | null; render_encoder = payload.encoder của event đó | null;
//   mezz_cache.hit_ratio = Σcached_segments / Σ(cached+rendered) của 20 event media.rendered gần nhất | null
//   alert "render_cpu_fallback" khi event media.rendered mới nhất có encoder "cpu" và project.resources.gpu ≥ 1 và mediaConfig.render.encoder === "auto"
```

- [ ] **Step 1: Test thất bại** — doctor: đủ filter + nvenc → ok; thiếu `ass` → fail nêu "ass"; nvenc false → ok:false không alert; vai channel → không hàng. Snapshot: 2 event `media.rendered` → `hit_ratio` đúng, `render_encoder` của event mới nhất; alert khi encoder cpu + gpu ≥ 1; không alert khi `render.encoder: cpu` cấu hình rõ. Probe cache: `resolveNvencProbe` gọi probe một lần trong TTL.
- [ ] **Step 2–4:** triển khai; `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(core): doctor media:render, dashboard render block and render_cpu_fallback alert`.

---

### Task 10: Test tích hợp `studio-composition`, acceptance 47–52

**Files:**
- Modify: `tests/integration/library-helpers.ts` (nếu Task 8 chưa đủ: `setBrand`, `addTrack`, `systemFontPath()`)
- Create: `tests/integration/studio-composition.test.ts`, `tests/acceptance/47-branded-episode-4k-with-captions.test.ts`, `48-overlays-too-dense-rejected-then-replanned.test.ts`, `49-transitions-never-move-the-timeline.test.ts`, `50-no-brand-still-produces-episode.test.ts`, `51-broken-brand-fails-before-claim.test.ts`, `52-library-production-1-2-0-still-runs.test.ts`

- [ ] **Step 1: `studio-composition.test.ts`** (`skipIf(!hasFfmpeg())`, `skipIf(!systemFontPath())` cho phần đốt chữ, 900 s): `freshLibraryWorld({ media1_3: true })`; `writeActiveStyle`; `addVoice`; `setBrand(world, channelId, { withLogo: true })` (font hệ thống, `subtitles.mode karaoke`, `transition dissolve 0.4`, `music.tracks ["calm-01"]`); `addTrack(world, "calm-01")` (sine 220 Hz 8 s loop_ok); `ingestShoot(world, "shoot-a", 3, { withAudio: true })`; kênh `request create --voice tts …`; `studioWorkerUntil(fulfilled)` → run 1.3.0, 15 stage SUCCEEDED, không stage `cut`/`assemble`; `composition.json` segments = `timeline.json.video`; `full-episode.mp4` 3840×2160, thời lượng = `total_seconds ± 0.1`; item kho có `captions.srt` với ≥ 1 cue và `captions.vtt`; `render-report.json`: `brand present`, `music.track_id "calm-01"`, `captions.mode karaoke`, `loudness` trong khoảng; event `media.composed`, `media.rendered`; chạy request thứ hai cùng shoot → `report.segments.cached > 0`.
- [ ] **Step 2: Acceptance**
  - **47**: như trên nhưng thêm: `overlay.ass` có ≥ 1 `Dialogue` style `Title`; vùng logo của frame giữa không trơn (`frameStdDev` qua helper test); `cuts/` có đúng số file = số đoạn.
  - **48**: `FAKE_OVERLAYS=dense` → run 1 FAILED tại `plan-edit` (`overlays-valid`), autopilot replan (SP4; kiểm rằng stage-fail ở plan-edit đi vào đường replan như 5A `edl-valid` — nếu không, đây là lỗi plan-text: mô tả trong report và dùng đường review-rejected: `medium` + review giả từ chối vì `dropped`) → run 2 với `request_notes` chứa "chữ" → `approved`.
  - **49**: brand `transition dissolve 0.4`, 3 đoạn: `composition.transitions.applied ≥ 1`; `full-episode.mp4` duration = Σ(end−start) ± 0.1; `cuts/NNN.mp4` mỗi file = `out−in ± 0.05`; ép 1 source cắt sát cuối (`out = duration`) → `downgraded` có `no_tail` và thời lượng vẫn đúng.
  - **50**: kênh không brand → run `approved`; `render-report.brand "absent"`, `captions.mode "none"`, item vẫn có `captions.srt`; `overlays.json` của agent tồn tại nhưng `text_events` rỗng + warning `overlays_ignored_no_brand`.
  - **51**: brand hợp lệ rồi xoá `logo.png` trong kho → request mới: run FAILED tại `intake`, request `open` (không `claimed`), doctor `channel:<id>:brand` fail nêu `logo.png`; phục hồi file → request chạy tới `approved`.
  - **52**: `library.auto_accept.workflow_release: library-production@1.2.0` trên world 1.3.0 → run dùng 1.2.0 với wrapper `cut`/`assemble` cũ tới `approved`; `loadWorkflow("library-production@1.2.0")` có `assemble`, không `media-render`.
- [ ] **Step 3:** `pnpm build && pnpm test`; không media/font/nhạc trong repo.
- [ ] **Step 4: Commit** — `test: studio composition integration (branded 4K episode with karaoke captions, music and dissolves); acceptance 47-52`.

---

### Task 11: Chạy thật 4K trên máy build, tài liệu

**Files:** Create `docs/runbooks/studio-composition.md`; Modify `AGENTS.md` ("Lệnh 5B (dựng hình)"), `README.md` (trạng thái + quick-start 5B), `docs/adr/0001-control-plane-baseline.md` (mục 117+), `docs/operations/deferred-items.md` ("Sau sub-project 5B"; đóng các mục 5A về captions/`assemble.mjs`), `docs/runbooks/go-live.md` (bước wrapper: chỉ còn `thumbnail-candidates`; khối `brands`/`music`; `media.render`), `project-template/project.yaml` (`media.render`), `project-template/README` hoặc `channels/example/` (ghi chú brand), `docs/runbooks/studio-media.md` (trỏ sang 5B cho `assemble`)

- [ ] **Step 1: Chuẩn bị ngoài repo** (`E:\tmp-5b-studio\`): tải font Be Vietnam Pro (OFL) Regular + Bold; logo PNG tự vẽ bằng ffmpeg (`-f lavfi -i color=c=0xF2C94C:s=400x140` + `drawtext` "KÊNH"); nhạc: sinh `lavfi` (`aevalsrc` hợp âm 60 s) hoặc file royalty-free tải tay (ghi nguồn vào `origin_note`); brand.json theo spec §2.1 với `subtitles.mode karaoke`, `transition dissolve`. Không commit gì.
- [ ] **Step 2: Chạy thật** trên ops project temp (copy `fixtures/ops-project-studio`, `adapters.media: python` với venv `E:\harness-venv`, agent giả, `media.render.encoder auto`): `harness doctor` → `media:render` ok (NVENC), `library:brands`, `library:music`, `channel:<id>:brand` ok. Dựng lại ≥ 2 tập từ nguồn 5A (`vi` + tts karaoke, `en` + tts burn-in; thêm `original` nếu còn thời gian): ghi bảng stage/thời gian/VRAM; `render_seconds` NVENC; chạy lại một tập với `encoder: cpu` để so; bitrate ra (`ffprobe -show_entries format=bit_rate`) — thấp hơn 30 Mbps → đổi `-cq 17` và ghi report; kiểm ducking bằng tai + `ebur128` trong/ngoài cửa sổ lời (chênh ≥ 6 LU); tiếng Việt: chụp 3 frame có phụ đề (`-frames:v 1` tại giữa 3 cue) vào `E:\tmp-5b-studio\frames\` để anh xem dấu. Lỗi gặp khi chạy thật → sửa + test tái hiện không cần GPU nếu có thể, commit `fix(...)` riêng.
- [ ] **Step 3: Runbook** `studio-composition.md`: (1) điều kiện ffmpeg (libass, xfade, NVENC) và `media.render`; (2) hồ sơ thương hiệu: `brands set|show`, font Việt khuyến nghị, `origin`, ý nghĩa từng khoá, không brand thì sao; (3) kho nhạc: `music add|list|retire`, mood, loop, giấy phép; (4) `overlays.json` agent viết gì, `overlays-valid` chặn gì; (5) đọc `composition.json` / `render-report.json`, vì sao review loại, cache mezz và dọn; (6) sự cố: `media:render` fail, NVENC mất, loudness lệch, font thiếu dấu, dissolve bị hạ cấp nhiều; (7) số đo Step 2 (NVENC vs CPU, bitrate, VRAM); (8) quay về 1.2.0; (9) kết luận DoD #2, #3 (frame cho anh xem).
- [ ] **Step 4:** ADR 117+ (hai tầng mezz/final; bất biến mốc và cách dissolve lấy đuôi; ASS là kênh vẽ duy nhất; brand thuộc kênh, harness không ship font; nhạc trong kho có origin, chọn theo hash request; kiểm brand ở intake trước claim; encoder auto/NVENC; captions luôn file rời), AGENTS, README, deferred (từ ledger + spec §11: crossfade vòng nhạc, `duck_threshold_db`, render theo khối, lease gpu khi CPU, 9:16, intro/outro), template, `go-live.md`, `studio-media.md`.
- [ ] **Step 5:** `pnpm build && pnpm typecheck && pnpm test`; dọn ops project temp (giữ `E:\tmp-5b-studio\` font/frames cho anh xem, xoá dữ liệu run).
- [ ] **Step 6: Commit** — `docs: studio composition runbook with real 4K render results, ADR 117+, AGENTS/README, templates and go-live for sub-project 5B`.
- [ ] **Step 7:** Báo cáo: bảng DoD spec §9 (item → bằng chứng → trạng thái), điều để lại.

---

## Tự rà soát plan 5B

**Phủ spec:** §0 → toàn bộ; §1 cấu trúc → Task 1–9, 11; §1.1 config → Task 1 (schema), 8 (stage đọc), 11 (template); §1.2 → Task 8 (intake); `brand.logo.corner` có default riêng, **không** đọc `channel.yaml overlay.side` (spec đã sửa cùng plan này); §1.3 kho + bảng → Task 1, 2; §2.1 brand → Task 1, 2; §2.2 track → Task 1, 2; §2.3 chọn track → Task 4; §3 overlays + `overlays-valid` + skill → Task 1, 4, 5, 8; §4.1 captions → Task 3; §4.2 chữ → Task 3 (ASS), 4; §4.3 chuyển cảnh → Task 4, 6; §4.4 nhạc → Task 4, 6; §4.5 composition + `composition-valid` → Task 1, 5; §4.6 ASS → Task 3; §5.1 mezz → Task 6, 7; §5.2 hình → Task 6; §5.3 tiếng → Task 6, 7 (hai lượt); §5.4 encoder → Task 6, 7, 8 (probe cache); §5.5 report + clip_set → Task 1, 7; §6.1 workflow/profile/export → Task 8; §6.2 checker → Task 5, 7; §6.3 review + agent giả → Task 8; §6.4 doctor/event/dashboard → Task 2 (brand/music rows), 8 (event), 9; §6.5 CLI → Task 2, 8; §7 lỗi → Task 2 (brand), 5, 7 (retry cpu, transient), 8 (intake); §8 test → mọi task + Task 10; §9 DoD → Task 10, 11; §10/§11 → Task 11.

**Nhất quán kiểu:** `Overlays`/`BrandProfile`/`MusicTrack`/`CaptionCue`/`TextEvent`/`Composition`/`CompositionSegment`/`RenderReport`/`SubtitleMode`/`TransitionKind` (Task 1) dùng ở 2–10; `LoadedBrand`, `loadBrand`, `verifyBrandFiles`, `setBrand`, `addMusicTrack`, `retireMusicTrack`, `activeTracks` (2) dùng ở 5, 8, 9; `buildCaptionCues`, `wrapLines`, `toSrt`, `toVtt`, `buildAss`, `countDialogues` (3) dùng ở 5; `placeOverlays`, `raiseCaptions`, `overlayDensityLimit`, `assignTransitions`, `selectTrack`, `buildMusicPlan`, `duckWindows` (4) dùng ở 5; `buildComposition`, `compositionCheckers` (5) dùng ở 8; `videoEncoderArgs`, `resolveEncoder`, `NVENC_PROBE_ARGS`, `mezzCacheKey`, `mezzArgs`, `audioGraph`, `finalArgs`, `escapeFilterPath` (6) dùng ở 7; `renderComposition`, `probeNvenc`, `parseLoudnorm`, `cacheLookup/Commit/Evict` (7) dùng ở 8, 9; artifact type `overlays`, `composition`, `captions`, `overlay_ass`, `episode_video`, `clip_set`, `render_report` khớp workflow (8), stage (8), checker (5, 7), export (8), agent giả (8); script built-in `media-compose|media-render` khớp composition và workflow; env test `FAKE_OVERLAYS` (8, 10) nằm trong passthrough agent-cli; event `media.composed`, `media.rendered` (8) đọc ở 9.

**Điểm chú ý khi thực thi:**
- `optional: true` trên output stage: kiểm schema workflow/stage-result hiện có; nếu chưa hỗ trợ, thêm ở contracts (default `false`) và để `output-exists`/`schema-valid` bỏ qua output optional thiếu — ghi report. Nếu thay đổi này chạm 1.x.0 cũ, phải byte-identical: chỉ thêm khoá optional với default.
- `Timeline.video[]` không mang `source_path`: `compose` lấy từ `sdk.sources` (map `source_id → path`) như `media index`; `shots.json` v2 cho `duration_seconds`/`has_audio`; fps từ `app.prober.probe` từng source (cache trong stage) — nếu `shots` v2 đã có fps thì dùng.
- `brief.channel_id`: kiểm `libraryBriefSchema`; nếu thiếu, `compose`/`intake` lấy `channel_id` từ `ContentRequest` trong store (`request_id` có trong brief).
- `xfade` yêu cầu hai luồng cùng kích thước/fps/pix_fmt và **timestamps liên tục**: sau `concat` thêm `settb=AVTB,setpts=PTS-STARTPTS` cho từng khối trước `xfade`; nếu ffmpeg báo lỗi "First input link … parameters do not match", đó là chỗ này.
- `sidechaincompress` với `threshold` là biên độ tuyến tính (0.031 ≈ −30 dBFS); `makeup=1` nghĩa không tăng.
- `loudnorm` lượt 1 với `-f null` phải chạy qua **cùng** graph tiếng (kể cả ducking) để số đo đúng; lượt 2 `linear=true` chỉ hợp lệ khi có đủ `measured_*`.
- Windows: đường dẫn trong `ass=filename=` phải escape `:` thành `\:` và dùng `/`; test snapshot Task 6 khoá điều này.
- `linkSync` cho `clip_set` có thể fail trên khác volume/quyền → fallback copy; test chỉ kiểm file tồn tại và thời lượng.
- Task 8 `overlays-valid` chạy ở `plan-edit` là stage agent: stage fail ở agent đi vào đường replan của SP4 giống `edl-valid` — xác nhận trong test 48; nếu đường đó không tồn tại, dùng review-rejected và ghi report (không mở rộng SP4 trong 5B).
- Test dùng font hệ thống: `systemFontPath()` thử `C:\Windows\Fonts\arial.ttf`, `/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf`, `/System/Library/Fonts/Supplemental/Arial.ttf`; không có → skip phần đốt chữ, các phần khác vẫn chạy với `subtitles.mode none` và không text_events.
- Task 11 cần GPU và font tải về; chạy ngoài CI; tập 4K NVENC vài phút, CPU có thể 20–40 phút — đặt `default_deadline_seconds` profile đủ (14400 đã có).
