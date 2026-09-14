# Sub-project 2C: Kho nội dung (content library) — studio dựng, channel lấy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hai ops project (vai `studio`, vai `channel`) trên cùng harness trao đổi qua một folder kho chia sẻ thuần file: studio học style (`style-study`), dựng tập theo yêu cầu (`library-production`) và export vào kho; channel tạo yêu cầu, sync, `pick` mục đã duyệt. Không YouTube, không agent runtime.

**Architecture:** Contracts thêm `EditStyle`, `ContentRequest`, `LibraryItem`, `LibraryClaim`; `project.yaml.library { root, role }`. Core thêm module `library/` (filesystem nguyên tử + checksum, sync kho ↔ DB, vòng đời request, export, review, claim) và ba bảng bản sao (migration `0003_library.sql`, không đi qua `transition()`). Các stage đụng vào kho (`intake`, `style-export`, `library-export`, `library-apply-review`) là **script stage built-in**: composition đăng ký lệnh `harness library stage <name>` (CLI con, có store + LibraryFs) vào registry lệnh, nên ops project không phải viết wrapper cho chúng; wrapper của ops project chỉ cho việc media (`index-source`, `collect-samples`, `thumbnail-candidates`, `cut`, `assemble`, `tts`). CLI `harness library …`; doctor thêm 3 hàng; worker sync kho định kỳ khi rảnh.

**Tech Stack:** như 2B. Không dependency mới. ffmpeg cho test media.

Spec: `docs/superpowers/specs/2026-09-14-sub-project-2c-content-library-design.md` (toàn bộ). Đọc code trước khi sửa: `packages/core/src/source-catalog/{catalog,sources-file}.ts`, `packages/core/src/doctor/doctor.ts`, `packages/cli/src/{composition.ts,self.ts,commands/{library?,source,doctor,stage}.ts}`, `packages/worker/src/worker.ts`, `tests/integration/footage-helpers.ts`, `fixtures/ops-project-footage/**`, `packages/script-sdk/src/index.js`.

## Global Constraints

- TypeScript strict ESM NodeNext, import `.js`; `contracts` không phụ thuộc ai; `core` chỉ phụ thuộc `contracts`; `core` không import adapter/executor/cli; `cli` là composition root duy nhất.
- Mọi schema `.strict()`, `schema_version` `harness.<tên>/v1`; sau khi đổi Zod: `pnpm gen:schemas` và commit JSON.
- Chỉ `transition()`/`claim()` UPDATE cột `state` của bảng control plane. Ba bảng `edit_style`, `content_request`, `library_item` là **bản sao** của kho: ghi bằng `upsert*` từ `syncLibrary`, không đi qua `transition()`; ghi rõ trong ADR.
- Kho: mỗi file đúng một chủ ghi theo `library.role` (`studio`: `styles/`, `items/<id>/manifest.json` và file dữ liệu, `index.json`, đổi `status` của `requests/`; `channel`: tạo `requests/*.json`, `items/<id>/claims/<channel_id>.json`). Ghi nguyên tử: `<file>.tmp-<ulid>` rồi `rename`. Không xóa; `withdrawn` thay cho xóa. `sync` bỏ qua `.tmp-*`.
- Đường dẫn kho chỉ trong `project.yaml` của máy; harness không hard-code. Không secret trong kho.
- Test xác định, temp dir dưới `os.tmpdir()`; test cần ffmpeg dùng `describe.skipIf(!hasFfmpeg())`; `pnpm build` trước `pnpm typecheck`; test spawn CLI dùng `dist/` nên `pnpm build` trước `pnpm test`.
- Commit Conventional Commits, kết thúc đúng dòng `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Lỗi rõ ràng trong code của plan: sửa ngay, ghi ledger, không hỏi; chỉ hỏi khi có đánh đổi thiết kế.

---

## Cấu trúc file

```text
packages/contracts/src/library.ts            EditStyle, ContentRequest, LibraryItem, LibraryClaim, LibraryBrief
packages/contracts/src/{ids,entities,config,interfaces,index}.ts   prefix mới; ContentItem.library_brief/library_item_id; ProjectConfig.library; StateStore.*Library*
migrations/0003_library.sql
packages/core/src/library/files.ts           LibraryFs
packages/core/src/library/sync.ts            syncLibrary, writeIndex
packages/core/src/library/requests.ts        createRequest, claimRequest, fulfillRequest, rejectRequest, reopenRequest
packages/core/src/library/export.ts          exportItem, exportStyle
packages/core/src/library/review.ts          applyReview, claimItem
packages/core/src/verification/library-checkers.ts   brief-duration, library-export-valid
packages/core/src/state/sqlite-store.ts      upsert/get/list cho 3 bảng
packages/core/src/doctor/doctor.ts           library:root, library:write, library:index
packages/cli/src/commands/library.ts         sync|list|request create|accept|review|pick|styles show
packages/cli/src/commands/library-stage.ts   harness library stage intake|style-export|export|apply-review (chạy trong workspace)
packages/cli/src/composition.ts              libraryFs (khi có project.library), builtinLibraryCommands()
packages/worker/src/worker.ts                sync kho định kỳ khi rảnh
workflows/style-study/workflow.yaml
workflows/library-production/workflow.yaml
production-profiles/studio/profile.yaml
fixtures/ops-project-studio/{package.json,project.yaml,executors/scripts.yaml,executors/wrappers/{collect-samples,thumbnail-candidates}.mjs,source-catalog/sources.yaml}
fixtures/ops-project-channel/{project.yaml,source-catalog/sources.yaml}
tests/integration/library-helpers.ts, tests/integration/library-pipeline.test.ts
tests/acceptance/{17-unapproved-never-picked,18-corrupt-file-isolated,19-request-single-claim}.test.ts
docs/runbooks/content-library.md, docs/adr/0001-control-plane-baseline.md, AGENTS.md, README.md, docs/operations/deferred-items.md
```

---

### Task 1: Contract kho, `project.yaml.library`, migration 0003, store

**Files:**
- Create: `packages/contracts/src/library.ts`, `migrations/0003_library.sql`
- Modify: `packages/contracts/src/{ids,entities,config,interfaces,index}.ts`, `packages/contracts/scripts/gen-json-schema.ts`, `packages/core/src/state/sqlite-store.ts`
- Test: `packages/contracts/test/library.test.ts`, `packages/core/test/state/library-store.test.ts`

**Interfaces (Produces):**
```ts
// ids.ts: ID_PREFIXES thêm edit_style: "style", content_request: "req", library_item: "item"
// library.ts
export const libraryBriefSchema = z.object({ request_id: idSchema("content_request").optional(), topic: z.string().min(1), style_id: idSchema("edit_style"), style_revision: revisionSchema, target_duration_seconds: z.tuple([z.number().min(0), z.number().min(0)]).optional(), voice: z.enum(["none","tts","original"]).default("none"), language: z.string().min(1).default("vi") }).strict();
export const EditStyleSchema = z.object({ schema_version: schemaVersion("edit-style"), style_id, revision: revisionSchema, name: z.string().min(1), status: z.enum(["draft","active","retired"]), learned_from: z.array(z.object({ label: z.string().min(1), url: z.string().optional(), notes: z.string().default("") }).strict()).default([]), params: z.object({ cut_rhythm: z.enum(["fast","medium","slow"]), shot_seconds: z.tuple([z.number().min(0), z.number().min(0)]), transitions: z.array(z.string()).default([]), text_overlay: z.object({ style: z.string(), density: z.enum(["none","low","medium","high"]) }).strict(), subtitles: z.enum(["burn-in","karaoke","none"]), music: z.object({ mood: z.string(), ducking: z.boolean() }).strict(), opening: z.object({ seconds: z.number().min(0), structure: z.string() }).strict(), aspect_ratio: z.string().regex(/^\d+:\d+$/), pace_notes: z.string().default("") }).strict(), evidence: z.array(z.object({ path: z.string().min(1), note: z.string().default("") }).strict()).default([]), created_at, updated_at }).strict();
export const ContentRequestSchema = z.object({ schema_version: schemaVersion("content-request"), request_id, requested_by: z.object({ portfolio_id: z.string().min(1), channel_id: z.string().min(1).optional() }).strict(), topic: z.string().min(1), style_id: idSchema("edit_style").optional(), style_revision: revisionSchema.optional(), target_duration_seconds: tuple.optional(), voice: z.enum(["none","tts","original"]).default("none"), language: z.string().min(1).default("vi"), count: z.number().int().min(1).default(1), due_at: timestampSchema.optional(), status: z.enum(["open","claimed","fulfilled","rejected"]), claimed_by_run: z.object({ project_id: z.string().min(1), run_id: idSchema("run") }).strict().optional(), item_ids: z.array(idSchema("library_item")).default([]), notes: z.string().default(""), created_at, updated_at }).strict();
export const libraryFileSchema = z.object({ path: z.string().min(1), checksum: checksumSchema, size_bytes: z.number().int().min(0), mime_type: z.string().min(1) }).strict();
export const LibraryItemSchema = z.object({ schema_version: schemaVersion("library-item"), item_id, status: z.enum(["pending_review","approved","rejected","withdrawn"]), title_hint: z.string().default(""), summary: z.string().default(""), style: z.object({ style_id, revision: revisionSchema }).strict(), request_id: idSchema("content_request").optional(), duration_seconds: z.number().min(0), media: mediaInfoSchema.nullable(), files: z.array(libraryFileSchema).min(1), lineage: z.object({ project_id: z.string().min(1), run_id: idSchema("run"), content_id: idSchema("content_item"), source_ids: z.array(idSchema("source_item")) }).strict(), review: z.object({ by: z.string().optional(), note: z.string().default(""), at: timestampSchema.optional() }).strict().default({ note: "" }), created_at, updated_at }).strict();
export const LibraryClaimSchema = z.object({ schema_version: schemaVersion("library-claim"), item_id, channel_id: z.string().min(1), portfolio_id: z.string().min(1), claimed_at: timestampSchema, note: z.string().default("") }).strict();
// entities.ts ContentItem thêm: library_brief: libraryBriefSchema.optional(), library_item_id: idSchema("library_item").optional()   (import từ library.js — library.js chỉ import ids/common, không import entities → không vòng; mediaInfoSchema chuyển sang common.ts nếu cần)
// config.ts ProjectConfig thêm: library: z.object({ root: z.string().min(1), role: z.enum(["studio","channel"]), sync_seconds: z.number().int().min(10).default(300) }).strict().optional()
// interfaces.ts StateStore thêm:
upsertEditStyle(s: EditStyle): void; getEditStyle(id: string): EditStyle | undefined; listEditStyles(filter?: { status?: string }): EditStyle[];
upsertContentRequest(r: ContentRequest): void; getContentRequest(id: string): ContentRequest | undefined; listContentRequests(filter?: { status?: string }): ContentRequest[];
upsertLibraryItem(i: LibraryItem): void; getLibraryItem(id: string): LibraryItem | undefined; listLibraryItems(filter?: { status?: string }): LibraryItem[];
```
`mediaInfoSchema` hiện ở `entities.ts`; chuyển định nghĩa sang `common.ts` và re-export từ `entities.ts` để `library.ts` dùng không tạo vòng.

- [ ] **Step 1: Test thất bại**

`packages/contracts/test/library.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ContentRequestSchema, EditStyleSchema, LibraryClaimSchema, LibraryItemSchema, ContentItemSchema, ProjectConfigSchema, newId } from "../src/index.js";

const NOW = "2026-09-14T00:00:00.000Z";
const SHA = "sha256:" + "a".repeat(64);
export const style = () => ({ schema_version: "harness.edit-style/v1", style_id: newId("edit_style"), revision: 1, name: "vlog-fast", status: "active", params: { cut_rhythm: "fast", shot_seconds: [2, 6], text_overlay: { style: "bold-center", density: "medium" }, subtitles: "burn-in", music: { mood: "upbeat", ducking: true }, opening: { seconds: 5, structure: "hook-then-title" }, aspect_ratio: "16:9" }, created_at: NOW, updated_at: NOW });
describe("library contracts", () => {
  it("edit style defaults and rejects a bad aspect ratio", () => {
    const s = EditStyleSchema.parse(style());
    expect(s).toMatchObject({ learned_from: [], evidence: [], params: { transitions: [], pace_notes: "" } });
    expect(EditStyleSchema.safeParse({ ...style(), params: { ...style().params, aspect_ratio: "wide" } }).success).toBe(false);
  });
  it("content request defaults voice/language/count/item_ids", () => {
    const r = ContentRequestSchema.parse({ schema_version: "harness.content-request/v1", request_id: newId("content_request"), requested_by: { portfolio_id: "pf" }, topic: "chợ nổi", status: "open", created_at: NOW, updated_at: NOW });
    expect(r).toMatchObject({ voice: "none", language: "vi", count: 1, item_ids: [], notes: "" });
  });
  it("library item needs at least one file and a style snapshot; claim is strict", () => {
    const base = { schema_version: "harness.library-item/v1", item_id: newId("library_item"), status: "pending_review", style: { style_id: newId("edit_style"), revision: 1 }, duration_seconds: 12.5, media: null, lineage: { project_id: "studio", run_id: newId("run"), content_id: newId("content_item"), source_ids: [] }, created_at: NOW, updated_at: NOW };
    expect(LibraryItemSchema.safeParse({ ...base, files: [] }).success).toBe(false);
    expect(LibraryItemSchema.parse({ ...base, files: [{ path: "episode.mp4", checksum: SHA, size_bytes: 1, mime_type: "video/mp4" }] }).review).toEqual({ note: "" });
    expect(LibraryClaimSchema.safeParse({ schema_version: "harness.library-claim/v1", item_id: base.item_id, channel_id: "c1", portfolio_id: "pf", claimed_at: NOW, extra: 1 }).success).toBe(false);
  });
  it("content item carries an optional brief; project config validates library", () => {
    const c = ContentItemSchema.parse({ schema_version: "harness.content-item/v1", content_id: newId("content_item"), source_ids: [], revision: 1, title: "t", created_at: NOW, library_brief: { topic: "x", style_id: newId("edit_style"), style_revision: 1 } });
    expect(c.library_brief).toMatchObject({ voice: "none", language: "vi" });
    const p = ProjectConfigSchema.parse({ schema_version: "harness.project-config/v1", project_id: "p", template_release: "0.1.0", runtime: "claude", data_root: "./data", portfolios: [{ portfolio_id: "pf", display_name: "x" }], library: { root: "E:/lib", role: "studio" } });
    expect(p.library).toEqual({ root: "E:/lib", role: "studio", sync_seconds: 300 });
    expect(ProjectConfigSchema.safeParse({ ...p, library: { root: "x", role: "viewer" } }).success).toBe(false);
  });
});
```

`packages/core/test/state/library-store.test.ts`: dùng `openTempStore`; `upsertEditStyle` hai lần cùng id (revision 1 rồi 2) → `getEditStyle` trả revision 2, `listEditStyles({ status: "active" })` lọc đúng; tương tự request và item (`listLibraryItems({ status: "approved" })`); `migrate` áp `0003_library.sql` (tableNames chứa ba bảng).

- [ ] **Step 2: Chạy, xác nhận fail** — `pnpm vitest run packages/contracts packages/core/test/state/library-store.test.ts`.

- [ ] **Step 3: Contracts** theo Interfaces; `index.ts` export `library.js`; `gen-json-schema.ts` thêm `"edit-style"`, `"content-request"`, `"library-item"`, `"library-claim"`; `pnpm gen:schemas`.

- [ ] **Step 4: `migrations/0003_library.sql`**

```sql
CREATE TABLE edit_style (id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX edit_style_state_idx ON edit_style(state);
CREATE TABLE content_request (id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX content_request_state_idx ON content_request(state);
CREATE TABLE library_item (id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX library_item_state_idx ON library_item(state);
```

- [ ] **Step 5: Store** — ba bộ `upsert/get/list` theo mẫu `insertContentItem`/`listDocs`; `upsert*` dùng `INSERT … ON CONFLICT(id) DO UPDATE SET state=excluded.state, data=excluded.data, updated_at=excluded.updated_at`; `state` = `status` của entity; `updated_at` = `updated_at` của entity. Ghi chú trong code: đây là bản sao của kho, không qua `transition()`.

- [ ] **Step 6:** `pnpm build && pnpm typecheck && pnpm test` xanh.
- [ ] **Step 7: Commit**

```bash
git add packages migrations
git commit -m "feat(contracts): content library entities, project.yaml.library, migration 0003 and store mirrors

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `LibraryFs` — đường dẫn, ghi nguyên tử, checksum, quyền theo vai

**Files:**
- Create: `packages/core/src/library/files.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/library/files.test.ts`

**Interfaces (Produces):**
```ts
export type LibraryRole = "studio" | "channel";
export interface LibraryPaths { root: string; styles: string; requests: string; items: string; index: string; styleDir(id): string; styleFile(id): string; requestFile(id): string; itemDir(id): string; manifest(id): string; claimsDir(id): string; claimFile(id, channelId): string }
export function libraryPaths(root: string): LibraryPaths
export class LibraryFs {
  constructor(o: { root: string; role: LibraryRole })
  readonly paths: LibraryPaths
  exists(): boolean                                   // root là thư mục
  readJson<T>(path: string, schema: ZodType<T>): T     // ném CONFIG_INVALID (schema) hoặc IO_ERROR (không đọc được/JSON hỏng)
  writeJsonAtomic(path: string, value: unknown): void  // kiểm quyền theo role (assertWritable), mkdir -p, ghi `<path>.tmp-<ulid>` rồi renameSync
  copyFileWithChecksum(src: string, dest: string): Promise<LibraryFile>  // copy qua tmp + rename, trả { path: basename, checksum, size_bytes, mime_type }
  verifyFile(dir: string, f: LibraryFile): Promise<boolean>              // tồn tại + checksum + size
  listStyleIds(): string[]; listRequestIds(): string[]; listItemIds(): string[]; listClaims(itemId): LibraryClaim[]
  assertWritable(path: string): void   // studio: dưới styles/, items/ (trừ items/*/claims/), index.json, requests/*.json (chỉ khi file đã tồn tại — studio không tạo request); channel: requests/*.json (tạo mới hoặc file của chính nó), items/*/claims/*.json; ngoài ra ném CONFIG_INVALID "role <r> may not write <path>"
}
```
Mime: dùng bảng `MIME_BY_EXT` của catalog (export nó từ `source-catalog/catalog.ts`).

- [ ] **Step 1: Test thất bại** — `files.test.ts` với kho trong `mkdtempSync`:
  - `writeJsonAtomic` ghi file và không để lại `.tmp-*`; giả lập lỗi giữa chừng bằng cách ghi vào đường dẫn có thư mục cha là file → ném `IO_ERROR`, không có file dở.
  - Quyền: studio ghi `styles/x/style.json` ok; channel ghi `styles/x/style.json` → `CONFIG_INVALID`; channel ghi `items/i/claims/c1.json` ok; studio ghi claim → `CONFIG_INVALID`; channel tạo `requests/r.json` ok; studio ghi `requests/r.json` khi chưa tồn tại → `CONFIG_INVALID`, khi đã tồn tại → ok.
  - `readJson` với JSON hỏng → `IO_ERROR`; sai schema → `CONFIG_INVALID`.
  - `copyFileWithChecksum` + `verifyFile` đúng; sửa file → `verifyFile` false.
  - `listItemIds` bỏ qua thư mục không có `manifest.json` và mục `.tmp-*`.
- [ ] **Step 2: Chạy, xác nhận fail.**
- [ ] **Step 3: Triển khai** (`node:fs` sync cho JSON, `sha256File` cho copy). `renameSync` cùng thư mục. Windows: `renameSync` ghi đè file đích có sẵn — chấp nhận (chủ ghi duy nhất).
- [ ] **Step 4:** `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(core): LibraryFs with atomic writes, checksums and role-based write guard`.

---

### Task 3: `syncLibrary` và `index.json`

**Files:**
- Create: `packages/core/src/library/sync.ts`
- Test: `packages/core/test/library/sync.test.ts`

**Interfaces (Produces):**
```ts
export interface SyncReport { imported: { styles: string[]; requests: string[]; items: string[] }; updated: { styles: string[]; requests: string[]; items: string[] }; corrupt: { path: string; reason: string }[]; missing: { kind: "style"|"request"|"item"; id: string }[] }
export function syncLibrary(d: { store: StateStore; fs: LibraryFs; role: LibraryRole; clock: Clock }): Promise<SyncReport>
export function writeIndex(d: { fs: LibraryFs; store: StateStore; clock: Clock }): void   // { generated_at, styles: [{id,revision,status,name}], requests: [{id,status,topic}], items: [{id,status,title_hint,duration_seconds,style}] } — chỉ studio gọi
```
Quy tắc: với mỗi file trong kho: đọc + validate (lỗi → `corrupt`, bỏ qua); với item còn `verifyFile` từng file dữ liệu (checksum lệch → `corrupt`, không nhập); so với DB: chưa có → `imported`; có và (`updated_at` mới hơn **hoặc** nội dung khác theo `canonicalDigest`) → `updated`; DB có mà kho không có file → `missing` (không xóa). Vai studio cuối cùng `writeIndex`. `.tmp-*` bỏ qua.

- [ ] **Step 1: Test thất bại** — kho temp có 1 style, 2 request, 2 item (một item có file dữ liệu bị sửa sau khi ghi manifest), 1 request JSON hỏng, 1 file `.tmp-x`; sau `sync` với store `openTempStore`: `imported` đúng, `corrupt` có 2 mục (request hỏng, item lệch checksum), item lệch không có trong DB; ghi lại request với `updated_at` mới → lần 2 `updated` = [id]; xóa file style → `missing` = [{style}], DB vẫn giữ; vai studio tạo `index.json` hợp lệ, vai channel không tạo.
- [ ] **Step 2–5:** như Task 2. Commit `feat(core): syncLibrary mirrors the shared library into the local store; index.json for studio`.

---

### Task 4: Vòng đời request, review, claim

**Files:**
- Create: `packages/core/src/library/requests.ts`, `packages/core/src/library/review.ts`
- Test: `packages/core/test/library/requests.test.ts`, `packages/core/test/library/review.test.ts`

**Interfaces (Produces):**
```ts
// requests.ts (mọi hàm đọc file ngay trước khi ghi; ghi qua fs.writeJsonAtomic; trả bản mới; cập nhật store bằng upsert)
export function createRequest(d, p: { requested_by; topic; style_id?; style_revision?; target_duration_seconds?; voice?; language?; count?; due_at?; notes? }): ContentRequest      // channel
export function claimRequest(d, p: { request_id; run: { project_id; run_id } }): ContentRequest   // studio; open → claimed; đã claimed bởi cùng run → trả nguyên (idempotent); claimed bởi run khác / fulfilled / rejected → INVALID_TRANSITION
export function fulfillRequest(d, p: { request_id; item_id }): ContentRequest    // claimed → fulfilled (count>1: item_ids đẩy thêm; fulfilled khi item_ids.length >= count, ngược lại vẫn claimed)
export function rejectRequest(d, p: { request_id; note }): ContentRequest         // claimed → rejected
export function reopenRequest(d, p: { request_id; note }): ContentRequest         // claimed|rejected → open, xoá claimed_by_run, notes += note
// review.ts
export function applyReview(d, p: { item_id; decision: "approved"|"rejected"; note?; by? }): { item: LibraryItem; request?: ContentRequest }   // studio; pending_review → approved|rejected; nếu item.request_id: approved → fulfillRequest, rejected → reopenRequest
export function withdrawItem(d, p: { item_id; note? }): LibraryItem                 // studio; approved|rejected → withdrawn
export function claimItem(d: { store; fs; clock; catalog: SourceCatalog }, p: { item_id; channel_id; portfolio_id; note? }): { claim: LibraryClaim; content: ContentItem }   // channel; đọc manifest từ kho (không tin DB); NẾU claims/<channel>.json đã có → trả claim đó + ContentItem có library_item_id (tạo nếu chưa có) bất kể status hiện tại (idempotent, như claimRequest); ngược lại item phải approved (INVALID_TRANSITION nếu không), ghi claim, tạo ContentItem { source_ids: [], title: item.title_hint, library_item_id }
```
`d` chung: `{ store: StateStore; fs: LibraryFs; clock: Clock }`. `SourceCatalog.createContent` hiện yêu cầu `source_ids`; thêm tham số tuỳ chọn `library_item_id`/`library_brief` cho `createContent` (mở rộng chữ ký, không đổi hành vi cũ).

- [ ] **Step 1: Test thất bại** — requests: `createRequest` với role channel ghi file `open`; `claimRequest` cùng run hai lần idempotent; run khác → `INVALID_TRANSITION`; `fulfillRequest` với `count: 2` cần hai item; `reopenRequest` từ `rejected` về `open` giữ notes. review: `applyReview approved` → manifest `approved` + request `fulfilled`; `rejected` → request `open` với note; `claimItem` với item `pending_review` → `INVALID_TRANSITION`; với `approved` → claim file + ContentItem có `library_item_id`; claim lần hai idempotent; role studio gọi `claimItem` → `CONFIG_INVALID` từ `assertWritable`.
- [ ] **Step 2–5:** như Task 2. Commit `feat(core): content request lifecycle, review application and channel claims`.

---

### Task 5: `exportItem`, `exportStyle`, checker kho

**Files:**
- Create: `packages/core/src/library/export.ts`, `packages/core/src/verification/library-checkers.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/library/export.test.ts`, `packages/core/test/verification/library-checkers.test.ts`

**Interfaces (Produces):**
```ts
export interface ExportReceipt { item_id: string; item_dir: string; files: LibraryFile[]; manifest_checksum: Checksum }
export function exportItem(d: { store; fs; clock; prober: MediaProber }, p: { run: Run; content: ContentItem; brief: LibraryBrief; episodePath: string; thumbnailPaths: string[]; captionsPath?: string; editPlanPath: string; existingItemId?: string }): Promise<{ item: LibraryItem; receipt: ExportReceipt }>
// idempotent: existingItemId (đọc từ receipt cũ trong workspace nếu attempt chạy lại) → ghi đè cùng item_dir; item.status luôn pending_review khi export; lineage từ run/content; duration/media từ prober.probe(episodePath)
export function exportStyle(d: { store; fs; clock }, p: { style: EditStyle; evidenceDir?: string }): { style: EditStyle; dir: string }   // copy evidence/*, ghi style.json, upsert store
// library-checkers.ts
export function libraryCheckers(prober: MediaProber, opts?: { available?: boolean }): Checker[]
//  brief-duration: output type episode_video; đọc input type `brief` (brief.json) trong request.inputs; skip nếu brief không có target_duration_seconds; fail khi probe null (available) hoặc ngoài khoảng
//  library-export-valid: output type export_receipt; đọc receipt JSON; mọi f trong receipt.files: file tồn tại tại join(item_dir, f.path) đúng checksum+size; manifest.json parse được và checksum bằng manifest_checksum
```

- [ ] **Step 1: Test thất bại** — export: kho temp + store; run/content giả; `episodePath` là file bất kỳ (prober giả trả duration 12, media null) → `items/<id>/` có `episode.mp4`, `thumbnail-01.png`…, `edit-plan.json`, `manifest.json` hợp lệ `pending_review`, `files` có checksum đúng; gọi lại với `existingItemId` → cùng thư mục, không tạo id mới; `exportStyle` ghi `styles/<id>/style.json` + evidence. checkers: fake prober như `media-checkers.test.ts`; `brief-duration` pass/fail/skip; `library-export-valid` pass rồi sửa một file trong kho → fail với `path`.
- [ ] **Step 2–5:** như Task 2. Commit `feat(core): export items and styles to the library; brief-duration and library-export-valid checkers`.

---

### Task 6: CLI `harness library …`, stage built-in `harness library stage …`, composition, doctor, worker sync

**Files:**
- Create: `packages/cli/src/commands/library.ts`, `packages/cli/src/commands/library-stage.ts`
- Modify: `packages/cli/src/{composition.ts,main.ts,commands/doctor.ts}`, `packages/cli/package.json` (dependency `@harness/script-sdk: workspace:*`), `packages/core/src/doctor/doctor.ts`, `packages/worker/src/worker.ts`, `packages/core/src/index.ts`
- Test: `packages/cli/test/library.test.ts`, `packages/core/test/doctor/doctor.test.ts`, `packages/worker/test/worker.test.ts`

**Interfaces (Produces):**
- `AppContext` thêm `library?: { fs: LibraryFs; role: LibraryRole; syncSeconds: number }` (chỉ khi `project.library`), `prober: MediaProber`.
- `composition.ts`: `builtinLibraryCommands(cliArgv, projectDir): Record<string, ScriptCommand>` = `{ "library-intake": { argv: [...cliArgv, "--project", projectDir, "library", "stage", "intake"] }, "library-style-export": …"style-export", "library-export": …"export", "library-apply-review": …"apply-review" }`, hợp nhất vào `commands` **trước** registry ops project (ops project vẫn được ghi đè nếu muốn). `scriptCommandNames` bao gồm chúng (doctor coi là built-in).
- `harness library stage <intake|style-export|export|apply-review>`: chạy trong workspace do `ScriptExecutor` cung cấp (`HARNESS_WORKSPACE`); dùng `start()` của `@harness/script-sdk` để đọc request và ghi result; dùng `withContext` để có store/fs. Mỗi stage:
  - `intake`: `run = store.getRun(request.run_id)`, `content = store.getContentItem(run.content_id)`; thiếu `content.library_brief` → `ctx.fail("contract", …)`; `style = fs.readJson(styleFile(brief.style_id))` phải `active` và `revision === brief.style_revision`; nếu `brief.request_id`: `claimRequest({ request_id, run })` (INVALID_TRANSITION → `ctx.fail("contract")`); ghi `output/brief.json` (LibraryBrief + `style_snapshot`); `ctx.out.file("output/brief.json", { type: "brief" })`; `done`.
  - `style-export`: input type `style` (`style.json` từ gate) + input directory type `style_evidence` nếu có → `exportStyle`; ghi `output/export-receipt.json` `{ style_id, revision, dir }`; `done`.
  - `export`: inputs `episode_video`, `thumbnail_set` (directory), `captions` (optional), `edit_plan`, `brief`; `existingItemId` đọc từ `output/export-receipt.json` cũ nếu còn (attempt retry cùng workspace không có — workspace mới; đọc từ `store.listLibraryItems` lọc `lineage.run_id === run_id` thay thế) → `exportItem`; ghi `output/export-receipt.json`; `done`.
  - `apply-review`: input type `review` (`review.json` `{ decision, note }`) + `export_receipt` → `applyReview({ item_id, decision, note, by: "gate:library-review" })`; ghi `output/apply-receipt.json`; `done`.
- `harness library sync|list|request create|accept|review|pick|styles show` như spec §4.2, thêm `accept`:
  - `library accept (--request <req_id> | --topic "…" --style <style_id>) --source <src_id>... [--title …] [--json]` (studio): dựng `library_brief` (từ request hoặc tay; `style_revision` = revision hiện tại của style trong DB, phải `active`), `catalog.createContent({ source_ids, title, library_brief })`, in `content_id` để `plan --content`. Không claim request ở đây.
  - `library review <item_id> --approve|--reject [--note]` (studio) → `applyReview` với `by: "cli"`.
  - `library pick <item_id> --channel <c> [--json]` (channel) → `claimItem`; in `content_id`.
  - Mọi lệnh `library` không có `project.library` → `CONFIG_INVALID`.
- Doctor thêm hàng: `library:root` (`fs.exists()`), `library:write` (ghi rồi xoá `<root>/.doctor-<role>-<ulid>` trong thư mục hợp lệ theo vai: studio `styles/`, channel `requests/`), `library:index` (parse `index.json` nếu có). Không có `project.library` → không thêm hàng.
- Worker: khi `d.library` có, ở nhánh idle sau `warnGateOverdue()`: nếu `now - lastSyncAt >= syncSeconds` → `await syncLibrary(...)`, log `corrupt`/`missing` ở mức warn. `WorkerDeps.library?: { fs; role; syncSeconds }`.

- [ ] **Step 1: Test thất bại** — `packages/cli/test/library.test.ts` (fixture tạm: copy `ops-project-minimal`, thêm `library: { root: <temp>/lib, role: channel }` vào `project.yaml`, migrate): `library request create … --json` tạo file `requests/req_*.json` `open`; `library list requests --json` sau `sync` có 1 mục; project vai studio (project khác cùng root): `library sync` thấy request; `library accept --request … --source …` → `content_id`, `status`-free; `library review` với item giả ghi tay vào kho (`pending_review`) → manifest `approved`; channel `library pick` → claim file + `content_id`; lệnh `library` trên project không có `library` → exit 1 `CONFIG_INVALID`. Doctor test: 3 hàng mới ok/fail (root không tồn tại → fail). Worker test: `makeWorld` với `library` → sau `runOnce` idle, request ghi tay vào kho xuất hiện trong `store.listContentRequests()`; gọi `runOnce` lần hai trước `syncSeconds` không sync lại (đếm qua spy trên `fs.listRequestIds`).
  Stage built-in được test ở Task 8 (cần workflow); ở đây chỉ test `harness library stage intake` chạy tay: dựng workspace với `stage-request.json` giả trỏ tới run/content có `library_brief` → `output/brief.json` + `stage-result.json` `succeeded`; thiếu brief → result `failed` kind `contract`.
- [ ] **Step 2: Chạy, xác nhận fail.**
- [ ] **Step 3: Triển khai.** `library-stage.ts` dùng `start({ env: process.env })` từ script-sdk rồi `withContext(cmd, …)`. Lưu ý `HARNESS_PROJECT` do executor đặt; lệnh nhận `--project` từ argv built-in.
- [ ] **Step 4:** `pnpm build && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Commit** — `feat(cli): harness library commands, built-in library stages, doctor rows and periodic worker sync`.

---

### Task 7: Workflow `style-study`, `library-production`, profile `studio`

**Files:**
- Create: `workflows/style-study/workflow.yaml`, `workflows/library-production/workflow.yaml`, `production-profiles/studio/profile.yaml`
- Test: `packages/core/test/orchestration/library-workflows.test.ts`

**`workflows/style-study/workflow.yaml`:**
```yaml
schema_version: harness.workflow/v1
id: style-study
version: 1.0.0
defaults: {}
stages:
  - key: collect-samples
    executor: { type: script, script: collect-samples }
    requires_resources: [cpu]
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: sample_set, mime_type: application/x-directory, kind: directory, name: samples }
  - key: analyze-style
    executor: { type: gate, brief: "Xem samples/ (khung hình theo mốc, transcript). Viết output/style.json theo schema harness.edit-style/v1 (status: draft) và output/evidence/ (ảnh + ghi chú vì sao)." }
    depends_on: [collect-samples]
    gate_deadline_seconds: 86400
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: style, mime_type: application/json, name: style.json }
      - { type: style_evidence, mime_type: application/x-directory, kind: directory, name: evidence }
  - key: style-review
    executor: { type: gate, brief: "Sửa style.json nếu cần và đặt status: active. Chỉ nộp khi đồng ý dùng style này cho sản xuất." }
    depends_on: [analyze-style]
    gate_deadline_seconds: 86400
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: style, mime_type: application/json, name: style.json }
  - key: style-export
    executor: { type: script, script: library-style-export }
    depends_on: [style-review, analyze-style]
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: export_receipt, mime_type: application/json, name: export-receipt.json }
```

**`workflows/library-production/workflow.yaml`** (11 stage theo spec §3.2; các stage `index-source`, `tts`, `cut`, `assemble` chép nguyên từ `footage-production` với `depends_on` đổi theo bảng; `plan-edit` outputs `edl.json` (type `edl`), `edit-plan.json` (type `edit_plan`), `narration.txt` (type `narration`); `assemble` `depends_on_optional: [tts]`; `thumbnail-candidates` `{ type: thumbnail_set, kind: directory, name: thumbnails }`; `library-export` script `library-export`, `depends_on: [assemble, thumbnail-candidates, plan-edit, intake]`, `depends_on_optional: [tts]`, required_checks thêm `library-export-valid`, output `export_receipt`; `library-review` gate output `{ type: review, name: review.json }`; `library-apply-review` script `library-apply-review`, `depends_on: [library-review, library-export]`, output `{ type: apply_receipt, name: apply-receipt.json }`; `intake` script `library-intake`, output `{ type: brief, name: brief.json }`; `assemble` required_checks thêm `brief-duration`; `survey-source` gate output `{ type: survey, mime_type: text/markdown, name: survey.md }`, `depends_on: [index-source, intake]`.)

**`production-profiles/studio/profile.yaml`:** `profile_id: studio` — `ProductionProfileSchema.profile_id` hiện là enum `cartoon|avatar|footage`; **mở rộng enum** thêm `studio` (và `ProductionProfileRefSchema`), `pnpm gen:schemas`. `workflow_release: library-production@1.0.0`, `options_schema: { voice: [none, tts, original], subtitles: ["true","false"] }`, defaults `voice: none, subtitles: "false"`, `content: { target_duration_seconds: [1, 1800], max_silence_ratio: 0.9 }`, `limits: { max_cost_usd_per_variant: 5, max_concurrency: 2 }`. `style-study` cũng chạy với profile `studio` (workflow ref truyền qua `plan --workflow`; profile chỉ cần options hợp lệ — `style-study` không có `when`).

- [ ] **Step 1: Test thất bại** — `library-workflows.test.ts`: cả hai workflow load được; `library-production` có 11 stage đúng thứ tự và loại; mọi gate output có `name`; `resolveStageGraph` với `voice=none` bỏ `tts` và `library-export`/`assemble` không còn cạnh optional tới `tts`; profile `studio` parse được; `loadProfile(HARNESS_ROOT, "studio").workflow_release === "library-production@1.0.0"`.
- [ ] **Step 2–4:** viết YAML, mở rộng enum, `pnpm gen:schemas`, test xanh, `pnpm test`.
- [ ] **Step 5: Commit** — `feat: style-study and library-production workflows; studio profile`.

---

### Task 8: Fixture `ops-project-studio` + `ops-project-channel`, test tích hợp, acceptance 17/18/19

**Files:**
- Create: `fixtures/ops-project-studio/{package.json,project.yaml,executors/scripts.yaml,executors/wrappers/collect-samples.mjs,executors/wrappers/thumbnail-candidates.mjs,source-catalog/sources.yaml}`, `fixtures/ops-project-channel/{project.yaml,source-catalog/sources.yaml}`, `tests/integration/library-helpers.ts`, `tests/integration/library-pipeline.test.ts`, `tests/acceptance/17-unapproved-never-picked.test.ts`, `tests/acceptance/18-corrupt-file-isolated.test.ts`, `tests/acceptance/19-request-single-claim.test.ts`
- Modify: `.gitignore` (`fixtures/**/raw/`, `fixtures/**/library/` nếu tạo)

**Fixture studio:** `project.yaml` (`project_id: project-studio`, `resources { cpu: 2, gpu: 1 }`, `library: { root: ./library, role: studio, sync_seconds: 10 }` — test ghi đè `root` bằng đường dẫn temp), `package.json` như fixture footage (dependency `@harness/script-sdk`), `scripts.yaml`:
```yaml
schema_version: harness.scripts/v1
scripts:
  collect-samples:      { argv: [node, executors/wrappers/collect-samples.mjs], requires_resources: [cpu], timeout_seconds: 600 }
  thumbnail-candidates: { argv: [node, executors/wrappers/thumbnail-candidates.mjs], timeout_seconds: 600 }
  index-source:         { argv: [node, executors/wrappers/index-source.mjs], cwd: ../ops-project-footage, requires_resources: [cpu], timeout_seconds: 600 }
  tts:                  { argv: [node, executors/wrappers/tts.mjs], cwd: ../ops-project-footage, requires_resources: [gpu], timeout_seconds: 600 }
  cut:                  { argv: [node, executors/wrappers/cut.mjs], cwd: ../ops-project-footage, requires_resources: [cpu], timeout_seconds: 600 }
  assemble:             { argv: [node, executors/wrappers/assemble.mjs], cwd: ../ops-project-footage, requires_resources: [cpu], timeout_seconds: 600 }
```
(`library-intake`, `library-style-export`, `library-export`, `library-apply-review` là built-in, không khai.) `collect-samples.mjs`: đọc source văn bản đầu tiên (`samples.txt`, mỗi dòng một đường dẫn video cục bộ), với mỗi video chụp 3 khung bằng ffmpeg vào `output/samples/<i>-{start,mid,end}.png`, ghi `output/samples/samples.json`; `ctx.out.dir("output/samples", { type: "sample_set" })`. `thumbnail-candidates.mjs`: từ thư mục `clip_set` lấy 3 khung → `output/thumbnails/thumbnail-0{1,2,3}.png`; `ctx.out.dir(..., { type: "thumbnail_set" })`.

**Fixture channel:** `project.yaml` (`project_id: project-channel`, `library: { root: ./library, role: channel }`, không `executors/`), `sources.yaml` rỗng.

**`tests/integration/library-helpers.ts`:** `freshLibraryWorld(): { lib: string; studio: string; channel: string; sample: string }` — kho temp, hai project temp (project.yaml sinh từ fixture với `data_root` temp, `library.root` = lib, scripts.yaml của studio đọc từ fixture rồi ghi `cwd` tuyệt đối), `raw/sample-5s.mp4` bằng `makeVideo`, `samples.txt` trỏ vào nó; `db migrate` cả hai; export lại `cli`, `drain`, `status`, `submitGate`, `stageId` từ `footage-helpers.ts` (import) + `SAMPLE_STYLE` (EditStyle JSON hợp lệ), `SAMPLE_EDL`.

- [ ] **Step 1: `library-pipeline.test.ts`** (`describe.skipIf(!hasFfmpeg())`, 300 s):
  1. **style-study**: studio `source ingest samples.txt` → `content create` → `plan --workflow style-study@1.0.0 --profile studio --content …` → `enqueue` → `drain` → `analyze-style` WAITING_HUMAN → `submitGate` với `style.json` (SAMPLE_STYLE, `status: draft`) và `evidence/note.md` → `drain` → `style-review` → submit `style.json` với `status: active` → `drain` → run SUCCEEDED; kho có `styles/<id>/style.json` `active`; channel `library sync` → `library list styles --json` thấy nó.
  2. **request → production → review → pick**: channel `library request create --portfolio pf --channel c1 --topic "chợ nổi" --style <id> --voice none --json` → studio `library sync` (request trong DB) → `source ingest sample-5s.mp4` → `library accept --request <req> --source <src> --json` → `plan --workflow library-production@1.0.0 --profile studio --content … --option voice=none` → `enqueue` → `drain` (intake claim request; index-source) → `survey-source` submit `survey.md` → `plan-edit` submit `edl.json` (SAMPLE_EDL) + `edit-plan.json` `{ style_id, notes }` → `drain` (cut, assemble, thumbnail-candidates, library-export) → kho có `items/<id>/manifest.json` `pending_review` + `episode.mp4`; channel `sync` + `pick` → exit 1 `INVALID_TRANSITION` (chưa duyệt); studio `library-review` submit `review.json` `{ decision: "approved" }` → `drain` (apply-review) → manifest `approved`, request `fulfilled` với `item_ids`; channel `sync` → `pick --channel c1 --json` → `content_id`; `claims/c1.json` tồn tại; đọc `manifest.files` và kiểm sha256 của `episode.mp4` trong kho khớp; `status --json` của run studio: mọi stage SUCCEEDED, `library-export` artifact `export_receipt` ACCEPTED.
  3. **rejected → reopen**: run thứ hai cùng request? Request đã `fulfilled` → `library accept --request` từ chối (`INVALID_TRANSITION`). Dùng request mới: chạy tới `library-review`, submit `rejected` với note → request `open`, notes chứa note; `retry --stage plan-edit` → gate lại WAITING_HUMAN.
- [ ] **Step 2: Acceptance** (footage-based, `skipIf`):
  - **17**: mục `pending_review`, `rejected` (ghi tay manifest vào kho), `withdrawn` → channel `pick` exit 1 mỗi trường hợp; chỉ `approved` pass. Không cần ffmpeg (manifest giả với file text) → không `skipIf`.
  - **18**: kho có 3 item hợp lệ + 1 item manifest hỏng + 1 item checksum lệch → `library sync --json` trên channel: `imported.items` 3, `corrupt` 2, exit 1; `library list items` 3. Không cần ffmpeg.
  - **19**: hai `library accept --request <r>` tạo hai content; plan hai run; `drain` → đúng một run có `intake` SUCCEEDED, run kia `intake` WAITING_HUMAN (contract) và request `claimed_by_run` là run thứ nhất. Không cần ffmpeg nếu `index-source` không chạy: `intake` không phụ thuộc source; dùng `worker --once` từng lượt và kiểm sau hai lượt đầu (mỗi lượt claim một `intake`; thứ tự theo `ready_at`), rồi `cancel` cả hai run.
- [ ] **Step 3:** `pnpm install && pnpm build && pnpm vitest run tests` xanh; `pnpm test` xanh; không media/data trong repo.
- [ ] **Step 4: Commit** — `test: studio/channel fixtures over a shared library; library pipeline integration; acceptance 17-19`.

---

### Task 9: Tài liệu và báo cáo

**Files:** Create `docs/runbooks/content-library.md`; Modify `AGENTS.md`, `README.md`, `docs/adr/0001-control-plane-baseline.md` (mục 48+ "Sub-project 2C"), `docs/operations/deferred-items.md`, `project-template/project.yaml` (khối `library` có comment, mặc định bỏ), `packages/script-sdk/README.md` (không đổi trừ khi cần).

- [ ] **Step 1: Runbook `content-library.md`:** mount kho (SMB/NAS/Drive: lưu ý rename nguyên tử), khai `library` ở hai máy, chu trình studio (sync → accept → plan → gate → review), chu trình channel (request → sync → pick → plan phát hành khi có sub-project 3), quyền ghi theo vai, xử lý sự cố (`corrupt`, `missing`, request kẹt `claimed`, item `withdrawn`), lệnh `doctor`.
- [ ] **Step 2: ADR 48+:** kho là file + mỗi file một chủ ghi; ba bảng bản sao không qua `transition()`; stage kho là built-in CLI (vì cần store, không phải wrapper); `intake` là nơi duy nhất claim request; `library-apply-review` là nơi duy nhất ghi kết quả duyệt; `updated_at` + digest để nhận bản mới; enum `profile_id` thêm `studio`. AGENTS.md: mục "Lệnh 2C" và quy tắc kho. README: quick-start hai fixture. Deferred: mục mới từ ledger 2C.
- [ ] **Step 3:** `pnpm build && pnpm typecheck && pnpm test`; chạy tay quick-start; dọn `fixtures/**/data`, `library/`, `raw/`.
- [ ] **Step 4: Commit** — `docs: content library runbook, ADR 48+, AGENTS/README for sub-project 2C`.
- [ ] **Step 5:** Báo cáo trong chat: DoD spec §8 từng mục; điều để lại cho sub-project 3 (channel-publish với `fetch-library-item`, tự sinh request) và 4 (agent cho 5 gate).

---

## Tự rà soát plan 2C

**Phủ spec:** §1 cấu trúc → Task 1, 2, 6, 7, 8; §1.2 `project.yaml.library` → Task 1; §1.3 kho → Task 2, 3; §2 entity/bảng/quy tắc ghi/lineage → Task 1, 2, 4 (`ContentItem.library_item_id`, `library_brief`); §3.1 `style-study` → Task 7, 8; §3.2 `library-production` 11 stage → Task 7, built-in stage Task 6, wrapper Task 8; checker `brief-duration`, `library-export-valid` → Task 5; §3.3 gate → dùng `stage submit` có sẵn; §4.1 core `library/` → Task 2–5; §4.2 CLI + doctor + worker sync → Task 6; §5 `pick` → Task 4, 6 (phần phát hành là sub-project 3); §6 lỗi → Task 4 (INVALID_TRANSITION), 3 (corrupt/missing), 6 (`transient` khi kho mất là hành vi mặc định của `ScriptExecutor` với exit ≠ 0 — built-in stage kết thúc bằng `ctx.fail("transient")` khi `IO_ERROR`); §7 test → Task 8; §8 DoD → Task 8, 9.

**Nhất quán kiểu:** `LibraryFs`/`LibraryRole` (Task 2) dùng ở 3–6; `SyncReport` (3) dùng ở CLI/worker (6); `applyReview`/`claimItem` (4) dùng ở CLI + stage (6); `exportItem`/`exportStyle` + `ExportReceipt` (5) dùng ở stage `export`/`style-export` (6) và checker `library-export-valid` (5); output type `brief`, `style`, `style_evidence`, `sample_set`, `thumbnail_set`, `edit_plan`, `export_receipt`, `review`, `apply_receipt` khớp giữa workflow (7), stage built-in (6) và wrapper (8); tên script built-in `library-intake`, `library-style-export`, `library-export`, `library-apply-review` khớp giữa composition (6) và workflow (7).

**Điểm chú ý khi thực thi:**
- Task 1 chuyển `mediaInfoSchema` sang `common.ts`; mọi import hiện có qua `entities.js` vẫn hợp lệ nhờ re-export.
- Task 6 phụ thuộc `@harness/script-sdk` trong `cli` — thêm alias đã có trong `vitest.shared.ts`; `pnpm install`.
- Stage built-in chạy qua CLI con nên test spawn cần `pnpm build` trước (`dist/`), như 2B.
- `ProductionProfileSchema.profile_id` mở rộng enum kéo theo `ProductionProfileRefSchema`; JSON schema đổi.
