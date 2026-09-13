# Sub-project 2B: script-sdk, scripts.yaml, gate executor, checker media, workflow footage, fixture và acceptance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nửa sau của sub-project 2: harness chạy được pipeline `footage-production` trọn vẹn trên một ops project với wrapper ngoài (giả nhưng đúng giao thức), stage LLM đi qua cổng người duyệt `harness stage submit`, checker media dùng ffprobe, external effect ghi từ wrapper qua CLI con, ngân sách variant, `source sync`, `harness doctor`, acceptance 6/7/9/12 và secret e2e.

**Architecture:** Hai package mới (`@harness/script-sdk` — JS thuần + `.d.ts`, không phụ thuộc gì; `@harness/adapter-ffprobe` — `MediaProber` bọc ffprobe/ffmpeg). `ScriptExecutor` nhận registry từ `executors/scripts.yaml` của ops project, resolve `secret://` vào env tiến trình con, chuyển stdout JSON-line của wrapper vào logger có redaction. `GateExecutor` trả `deferred`; `submitGate()` trong core làm phần việc của worker cho một stage `WAITING_HUMAN` (claim có chủ đích, verify, commit). Wrapper ghi external operation qua `harness op intent|confirm|lost` (CLI con, cùng journal). Checker media nhận `MediaProber` qua factory; ngưỡng đi trong `StageRequest.policy` lấy từ profile. Ngân sách: planner không release stage khi tổng cost của variant ≥ `run.budget_usd`.

**Tech Stack:** như 2A (TypeScript strict ESM, pnpm 12, Zod, `node:sqlite`, Vitest). ffmpeg/ffprobe là phụ thuộc hệ thống (test media `skipIf` khi thiếu). Không thêm dependency npm.

Spec: `docs/superpowers/specs/2026-09-12-sub-project-2-footage-production-design.md` (mục 1.1, 1.2, 1.4, 3, 4, 5, 6, 7, 8, 10). Đọc code hiện tại trước khi sửa: `packages/worker/src/worker.ts`, `packages/core/src/orchestration/{planner,controller,journal}.ts`, `packages/executors/src/script-executor.ts`, `packages/cli/src/composition.ts`.

## Global Constraints

- Node `>=22.13`, `"type": "module"`, TypeScript strict, NodeNext, import nội bộ có đuôi `.js`. Dependency rule: `contracts` không phụ thuộc ai; `core` chỉ phụ thuộc `contracts`; `core` không import adapter/executor/worker; `@harness/script-sdk` chỉ dùng node builtins.
- Chỉ `transition()` và `claim()` trong `packages/core/src/state/sqlite-store.ts` được `UPDATE` cột `state`. Mọi cạnh transition phải có trong `TRANSITIONS`.
- Mọi schema object `.strict()`; contract có `schema_version` `harness.<tên>/v1`. Sau khi đổi schema Zod phải `pnpm gen:schemas` và commit JSON (drift test `packages/contracts/test/json-schema.test.ts`).
- Secret chỉ tồn tại dưới dạng `secret://scope/name` trong file/event/log; giá trị resolve từ env `HARNESS_SECRET_<SCOPE>_<NAME>` chỉ đi vào env của tiến trình con và vào `Redactor`. Không in `.env`.
- Test xác định, không mạng, không LLM; temp dir dưới `os.tmpdir()`; `vitest.config.ts` dùng `sharedConfig()`; `pnpm build` trước `pnpm typecheck`. Test cần ffmpeg/ffprobe dùng `describe.skipIf(!hasFfmpeg())` và in lý do.
- Tên tài nguyên `^[a-z][a-z0-9-]*$`; tài nguyên không khai báo = capacity 0. Giá trị option của variant luôn là string (`"true"`/`"false"`).
- Khóa trong `executors/scripts.yaml` là **tên script** (`executor.script` trong workflow), không phải stage key; workflow footage đặt `script` trùng stage key theo quy ước.
- Wrapper chỉ nói chuyện với harness qua `stage-request.json`/`stage-result.json`/`progress.json` trong workspace, stdout JSON-line và CLI con `harness op …`.
- Commit message Conventional Commits, kết thúc bằng đúng dòng `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Lỗi rõ ràng trong code của plan: sửa ngay, ghi ledger, không hỏi (quy tắc đã được duyệt); chỉ hỏi khi có đánh đổi thiết kế.

---

## Cấu trúc file

```text
packages/script-sdk/                       @harness/script-sdk (JS + .d.ts, không build)
  package.json  src/index.js  src/index.d.ts  tsconfig.json  vitest.config.ts  README.md  test/sdk.test.ts
packages/adapters/ffprobe/                 @harness/adapter-ffprobe
  package.json  tsconfig.json  vitest.config.ts  src/index.ts  src/ffprobe-prober.ts  test/ffprobe-prober.test.ts
packages/contracts/src/
  edl.ts                      EdlSchema
  config.ts                   ScriptsRegistrySchema, SourcesRegistrySchema, profile.content.max_silence_ratio
  execution.ts                StageRequest.expected_outputs, StageRequest.policy
  entities.ts                 Run.budget_usd, StageRun.gate_deadline_seconds
  interfaces.ts               MediaProber mở rộng (container/video/audio, silenceRatio), ClaimParams.stageRunId
packages/core/src/
  config/scripts.ts           loadScriptsRegistry(), scriptCommandsFrom()
  source-catalog/sources-file.ts  loadSourcesRegistry(), syncSources()
  orchestration/request.ts    buildStageRequest() (chuyển từ worker), mimeTypesFor()
  orchestration/gate.ts       submitGate(), gateOverdue()
  orchestration/budget.ts     variantSpent(), budgetBlocks()
  orchestration/planner.ts    budget_usd, gate_deadline_seconds, requiresResourcesOverride, gate budget trong advance
  orchestration/journal.ts    confirmExternal(), markLost()
  verification/media-checkers.ts  mediaCheckers(prober)
  doctor/doctor.ts            runDoctor()
  state/sqlite-store.ts       claim({ stageRunId })
  artifacts/registry.ts       chuẩn hoá đường dẫn output bằng resolve()
packages/executors/src/
  script-executor.ts          registry ScriptCommand, env secret, timeout_seconds, stdout JSON-line, HARNESS_* env
  gate-executor.ts            GateExecutor
packages/worker/src/worker.ts dùng buildStageRequest, cảnh báo gate quá hạn, map SECRET_UNRESOLVED → contract
packages/cli/src/
  self.ts                     cliArgv()
  composition.ts              scripts.yaml → ScriptExecutor, GateExecutor, FfprobeMediaProber, profiles, mediaCheckers
  commands/stage.ts           stage submit
  commands/op.ts              op intent|confirm|lost
  commands/doctor.ts          doctor
  commands/source.ts          source sync
  commands/retry.ts           --raise-budget
  commands/status.ts          đánh dấu gate quá hạn và stage reuse
workflows/footage-production/workflow.yaml
production-profiles/footage/profile.yaml
fixtures/ops-project-footage/  package.json  project.yaml  executors/scripts.yaml  executors/wrappers/*.mjs  source-catalog/sources.yaml
project-template/executors/scripts.yaml  project-template/executors/wrappers/example.mjs  project-template/source-catalog/sources.yaml
tests/integration/footage-helpers.ts  tests/integration/footage-pipeline.test.ts
tests/acceptance/06-stale-scope.test.ts  07-thumbnail-does-not-rerender.test.ts  09-budget-waits.test.ts  12-old-run-explainable.test.ts  16-secret-e2e.test.ts
docs/runbooks/wrap-a-channel.md
```

---

### Task 1: Contract 2B và chuẩn hoá đường dẫn output

**Files:**
- Create: `packages/contracts/src/edl.ts`
- Modify: `packages/contracts/src/{config,execution,entities,interfaces,index}.ts`, `packages/contracts/scripts/gen-json-schema.ts`, `packages/core/src/artifacts/registry.ts`
- Test: `packages/contracts/test/edl.test.ts`, `packages/contracts/test/config.test.ts`, `packages/core/test/artifacts/registry.test.ts`

**Interfaces:**
- Produces: `EdlSchema`, `type Edl`, `ScriptsRegistrySchema`, `type ScriptsRegistry`, `type ScriptSpec`, `SourcesRegistrySchema`, `type SourcesRegistry`, `StageRequest.expected_outputs: { type; mime_type; kind; name? }[]`, `StageRequest.policy: { target_duration_seconds?: [number, number]; max_silence_ratio?: number }`, `Run.budget_usd?: number`, `StageRun.gate_deadline_seconds?: number`, `MediaProbe` (kết quả probe mở rộng), `MediaProber.silenceRatio?`, `ClaimParams.stageRunId?`.

- [ ] **Step 1: Test thất bại**

`packages/contracts/test/edl.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EdlSchema } from "../src/edl.js";

const SRC = "src_01J00000000000000000000000";
describe("EdlSchema", () => {
  it("accepts ordered entries with in < out", () => {
    const edl = EdlSchema.parse({ schema_version: "harness.edl/v1", entries: [{ source_id: SRC, in: 0, out: 2.5, order: 0 }, { source_id: SRC, in: 2.5, out: 5, order: 1, overlay: "avatar", note: "b-roll" }] });
    expect(edl.entries[0]).toMatchObject({ overlay: null, note: "" });
  });
  it("rejects in >= out and duplicate order", () => {
    expect(EdlSchema.safeParse({ schema_version: "harness.edl/v1", entries: [{ source_id: SRC, in: 3, out: 3, order: 0 }] }).success).toBe(false);
    expect(EdlSchema.safeParse({ schema_version: "harness.edl/v1", entries: [{ source_id: SRC, in: 0, out: 1, order: 0 }, { source_id: SRC, in: 1, out: 2, order: 0 }] }).success).toBe(false);
  });
});
```

Thêm vào `packages/contracts/test/config.test.ts`:

```ts
import { ScriptsRegistrySchema, SourcesRegistrySchema, StageRequestSchema } from "../src/index.js";

describe("2B contracts", () => {
  it("scripts registry defaults cwd, env_refs and resources; rejects a non-secret env ref", () => {
    const r = ScriptsRegistrySchema.parse({ schema_version: "harness.scripts/v1", scripts: { tts: { argv: ["node", "executors/wrappers/tts.mjs"], requires_resources: ["gpu"], timeout_seconds: 60 } } });
    expect(r.scripts.tts).toMatchObject({ cwd: ".", env_refs: {}, requires_resources: ["gpu"], timeout_seconds: 60 });
    expect(ScriptsRegistrySchema.safeParse({ schema_version: "harness.scripts/v1", scripts: { avatar: { argv: ["node", "x.mjs"], env_refs: { HEYGEN_API_KEY: "plain-value" } } } }).success).toBe(false);
    expect(ScriptsRegistrySchema.safeParse({ schema_version: "harness.scripts/v1", scripts: { bad: { argv: [] } } }).success).toBe(false);
  });
  it("sources registry entries default collection and rights", () => {
    const s = SourcesRegistrySchema.parse({ schema_version: "harness.sources/v1", sources: [{ path: "raw/clip.mp4" }] });
    expect(s.sources[0]).toMatchObject({ collection: "main", rights_status: "unknown", language: null });
  });
  it("stage request defaults expected_outputs and policy", () => {
    const req = StageRequestSchema.parse({ schema_version: "harness.stage-request/v1", run_id: "run_01J00000000000000000000000", stage_run_id: "stage_01J00000000000000000000000", attempt_id: "attempt_01J00000000000000000000000", project_id: "p", portfolio_id: "pf", stage_key: "k", workflow: { id: "w", version: "1.0.0", digest: "sha256:" + "a".repeat(64) }, profile_snapshot: { id: "footage", revision: 1 }, inputs: [], workspace_uri: "/ws", stage_config: {}, limits: { deadline_at: "2026-09-13T00:00:00.000Z", max_cost_usd: 1, max_attempts: 1 }, capabilities: [], fencing_token: 1 });
    expect(req.expected_outputs).toEqual([]);
    expect(req.policy).toEqual({});
  });
});
```

Thêm vào `packages/core/test/artifacts/registry.test.ts` (dùng helper `openTempStore`, `seedStage`, `beginAttempt`, `createWorkspace` như các test có sẵn trong file; `ctx` dựng như test "stages outputs" có sẵn):

```ts
  it("rejects overlapping outputs even when one path is written with ./ or ..", async () => {
    // dựng ws + ctx như test overlapping có sẵn; ghi output/cuts/001.mp4
    await expect(registry.stageOutputs({ workspaceDir: ws, outputs: [
      { path: "output/./cuts", type: "clip_set", checksum: SHA, size_bytes: 0, kind: "directory" },
      { path: "output/cuts/../cuts/001.mp4", type: "clip", checksum: SHA, size_bytes: 0, kind: "file" },
    ], mimeTypes: {}, ctx })).rejects.toMatchObject({ code: "IO_ERROR" });
  });
```

- [ ] **Step 2: Chạy, xác nhận fail**

Run: `pnpm vitest run packages/contracts packages/core/test/artifacts`
Expected: FAIL (module `edl.js` không tồn tại; schema mới không có; test overlap `./` không ném).

- [ ] **Step 3: `packages/contracts/src/edl.ts`**

```ts
import { z } from "zod";
import { idSchema } from "./ids.js";
import { schemaVersion } from "./common.js";

export const edlEntrySchema = z.object({
  source_id: idSchema("source_item"),
  in: z.number().min(0),
  out: z.number().positive(),
  order: z.number().int().min(0),
  overlay: z.enum(["avatar"]).nullable().default(null),
  note: z.string().default(""),
}).strict().refine((e) => e.in < e.out, { message: "in must be less than out" });

/** Contract between the edit-plan gate and the cut/assemble scripts (spec §3). */
export const EdlSchema = z.object({
  schema_version: schemaVersion("edl"),
  entries: z.array(edlEntrySchema).min(1),
}).strict().superRefine((edl, ctx) => {
  const orders = edl.entries.map((e) => e.order);
  if (new Set(orders).size !== orders.length) ctx.addIssue({ code: "custom", message: "duplicate order" });
});
export type Edl = z.infer<typeof EdlSchema>;
export type EdlEntry = z.infer<typeof edlEntrySchema>;
```

Thêm `export * from "./edl.js";` vào `packages/contracts/src/index.ts`.

- [ ] **Step 4: `config.ts`**

Thêm sau `HarnessConfigSchema`:

```ts
export const scriptSpecSchema = z.object({
  argv: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1).default("."),
  env_refs: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), secretRefSchema).default({}),
  requires_resources: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).optional(),
  timeout_seconds: z.number().int().min(1).optional(),
}).strict();
/** `executors/scripts.yaml` of an operations project: script name (executor.script) -> command. */
export const ScriptsRegistrySchema = z.object({ schema_version: schemaVersion("scripts"), scripts: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), scriptSpecSchema) }).strict();

export const sourceEntrySchema = z.object({
  path: z.string().min(1),
  collection: z.string().regex(/^[a-z][a-z0-9-]*$/).default("main"),
  rights_status: z.enum(["unknown", "cleared", "restricted"]).default("unknown"),
  language: z.string().nullable().default(null),
}).strict();
/** `source-catalog/sources.yaml`: the reviewed register; the DB is the machine index. */
export const SourcesRegistrySchema = z.object({ schema_version: schemaVersion("sources"), sources: z.array(sourceEntrySchema).default([]) }).strict();

export type ScriptSpec = z.infer<typeof scriptSpecSchema>;
export type ScriptsRegistry = z.infer<typeof ScriptsRegistrySchema>;
export type SourcesRegistry = z.infer<typeof SourcesRegistrySchema>;
```

`requires_resources` trong scriptSpec **không** default `[]` — `undefined` nghĩa là "không ghi đè workflow". Trong `ProductionProfileSchema.content` thêm `max_silence_ratio: z.number().min(0).max(1).optional()`.

- [ ] **Step 5: `execution.ts`**

Thêm trước `StageRequestSchema`:

```ts
export const expectedOutputSchema = z.object({ type: z.string().min(1), mime_type: z.string().min(1), kind: z.enum(["file", "directory"]).default("file"), name: z.string().min(1).optional() }).strict();
export const verificationPolicySchema = z.object({ target_duration_seconds: z.tuple([z.number().min(0), z.number().min(0)]).optional(), max_silence_ratio: z.number().min(0).max(1).optional() }).strict();
```

Trong `StageRequestSchema` thêm hai trường (sau `resources`):

```ts
  expected_outputs: z.array(expectedOutputSchema).default([]),
  policy: verificationPolicySchema.default({}),
```

Export `type ExpectedOutput`, `type VerificationPolicy`. Dùng `expectedOutputSchema` thay cho object inline trong `stageDefinitionSchema.outputs` của `config.ts` (import từ `execution.js` gây vòng — thay vào đó chuyển `expectedOutputSchema` sang `common.ts` và import ở cả hai nơi).

- [ ] **Step 6: `entities.ts`, `interfaces.ts`**

`RunSchema` thêm `budget_usd: z.number().min(0).optional()` (sau `total_cost_usd`). `StageRunSchema` thêm `gate_deadline_seconds: z.number().int().min(1).optional()` (sau `requires_resources`).

`interfaces.ts`:

```ts
export interface MediaProbe {
  media: MediaInfo | null; duration_seconds: number | null; mime_type: string | null;
  container: string | null;
  video: { codec: string; width: number; height: number; fps: number | null } | null;
  audio: { codec: string; channels: number; sample_rate: number } | null;
}
export interface MediaProber {
  probe(path: string): Promise<MediaProbe | null>;
  /** 0..1 share of the timeline ffmpeg's silencedetect reports as silent; undefined when the prober cannot measure it. */
  silenceRatio?(path: string): Promise<number | null>;
}
export interface ClaimParams { owner: string; capabilities: string[]; now: string; leaseSeconds: number; resourceCapacity?: Record<string, number>; stageRunId?: string }
```

`NullMediaProber.probe` vẫn trả `null` (không đổi). `CheckerInput` giữ nguyên.

- [ ] **Step 7: `gen-json-schema.ts`** thêm `edl: EdlSchema, scripts: C.ScriptsRegistrySchema, sources: C.SourcesRegistrySchema` (import `EdlSchema` từ `../src/edl.js`); chạy `pnpm gen:schemas`.

- [ ] **Step 8: Chuẩn hoá đường dẫn output** — trong `ArtifactRegistry.stageOutputs` thay cách tính `paths`:

```ts
    const paths = p.outputs.map((o) => resolve(p.workspaceDir, o.path).replace(/[\\/]+$/, ""));
    for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
      const a = paths[i]!; const b = paths[j]!;
      if (a === b || b.startsWith(a + sep) || a.startsWith(b + sep)) throw new HarnessError("IO_ERROR", `overlapping outputs: ${p.outputs[i]!.path} and ${p.outputs[j]!.path}`, { a: p.outputs[i]!.path, b: p.outputs[j]!.path });
    }
```

- [ ] **Step 9: Test pass, build, typecheck**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: PASS. (`Run`/`StageRun` mới chỉ thêm trường optional nên test cũ không đổi.)

- [ ] **Step 10: Commit**

```bash
git add packages/contracts packages/core
git commit -m "feat(contracts): EDL, scripts/sources registries, expected outputs and policy on stage request, budget and gate deadline fields

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `buildStageRequest` trong core, claim có chủ đích, planner ghi `gate_deadline_seconds`

**Files:**
- Create: `packages/core/src/orchestration/request.ts`
- Modify: `packages/core/src/state/sqlite-store.ts`, `packages/core/src/orchestration/planner.ts`, `packages/core/src/index.ts`, `packages/worker/src/worker.ts`
- Test: `packages/core/test/orchestration/request.test.ts`, `packages/core/test/state/claim.test.ts`, `packages/core/test/orchestration/planner.test.ts`

**Interfaces:**
- Consumes: `StageRequest.expected_outputs/policy` (Task 1), `ClaimParams.stageRunId` (Task 1).
- Produces:
  ```ts
  export interface RequestDeps { store: StateStore; clock: Clock; harness: HarnessConfig; profiles: (id: string) => ProductionProfile; workflows: (ref: string) => LoadedWorkflow }
  export function buildStageRequest(d: RequestDeps, p: { run: Run; stageRun: StageRun; attempt: Attempt; lease: Lease; inputs: StageInput[]; workspaceDir: string; capabilities: string[] }): StageRequest
  export function stageDefinitionFor(workflows: RequestDeps["workflows"], run: Run, stageKey: string): StageDefinition | undefined
  export function mimeTypesFor(def: StageDefinition | undefined): Record<string, string>   // { [output.type]: output.mime_type }
  export function policyFor(profile: ProductionProfile): VerificationPolicy
  ```
  `WorkerDeps` thêm `profiles: (id: string) => ProductionProfile`. `store.claim({ stageRunId })` chỉ xét đúng stage đó (vẫn kiểm capability, `not_before`, tài nguyên).

- [ ] **Step 1: Test thất bại**

`packages/core/test/orchestration/request.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HARNESS_ROOT, loadHarnessConfig, loadProfile, loadWorkflow, Planner } from "../../src/index.js";
import { buildStageRequest, mimeTypesFor, stageDefinitionFor } from "../../src/orchestration/request.js";
import { beginAttempt, openTempStore } from "../helpers.js";

describe("buildStageRequest", () => {
  it("carries expected outputs, mime map, options, policy and lease resources", () => {
    const { store, clock } = openTempStore();
    const planner = new Planner(store);
    const run = planner.plan({ workflow: loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0"), profile: loadProfile(HARNESS_ROOT, "cartoon"), harness: loadHarnessConfig(HARNESS_ROOT), projectId: "project-main", portfolioId: "portfolio-main" });
    planner.enqueue(run.run_id);
    const claim = store.claim({ owner: "w", capabilities: ["write_workspace"], now: clock.now(), leaseSeconds: 90 })!;
    const { stageRun, attempt } = beginAttempt(store, claim);
    const deps = { store, clock, harness: loadHarnessConfig(HARNESS_ROOT), profiles: (id: string) => loadProfile(HARNESS_ROOT, id), workflows: (ref: string) => loadWorkflow(HARNESS_ROOT, ref) };
    const req = buildStageRequest(deps, { run, stageRun, attempt, lease: claim.lease, inputs: [], workspaceDir: "/ws", capabilities: ["write_workspace"] });
    expect(req.expected_outputs).toEqual([{ type: "script_text", mime_type: "text/plain", kind: "file" }]);
    expect(req.stage_config.__script).toBe("fake-stage");
    expect(req.policy).toEqual({});
    expect(req.resources).toEqual([]);
    expect(mimeTypesFor(stageDefinitionFor(deps.workflows, run, "produce"))).toEqual({ script_text: "text/plain" });
  });
});
```

Thêm vào `packages/core/test/state/claim.test.ts`:

```ts
  it("claim with stageRunId takes only that stage, or nothing", () => {
    const { store, clock } = openTempStore();
    const a = seedStage(store, { key: "a" });
    const b = seedStage(store, { key: "b" });
    const c = store.claim({ owner: "w", capabilities: [], now: clock.now(), leaseSeconds: 90, stageRunId: b.stage.stage_run_id })!;
    expect(c.stageRun.stage_run_id).toBe(b.stage.stage_run_id);
    expect(store.getStageRun(a.stage.stage_run_id)?.state).toBe("READY");
    expect(store.claim({ owner: "w", capabilities: [], now: clock.now(), leaseSeconds: 90, stageRunId: b.stage.stage_run_id })).toBeUndefined();
  });
```

Thêm vào `packages/core/test/orchestration/planner.test.ts` (dùng cách dựng workflow inline như các test `when` có sẵn trong file):

```ts
  it("copies gate_deadline_seconds and budget_usd onto the run and stage", () => {
    const wf = { definition: WorkflowDefinitionSchema.parse({ schema_version: "harness.workflow/v1", id: "g", version: "1.0.0", stages: [{ key: "pick", executor: { type: "gate", brief: "pick a topic" }, gate_deadline_seconds: 3600, outputs: [{ type: "topic", mime_type: "text/markdown", name: "topic.md" }] }] }), digest: "sha256:" + "c".repeat(64) };
    const run = planner.plan({ workflow: wf, profile: loadProfile(HARNESS_ROOT, "cartoon"), harness: loadHarnessConfig(HARNESS_ROOT), projectId: "p", portfolioId: "pf" });
    expect(run.budget_usd).toBe(5);
    expect(store.listStageRuns(run.run_id)[0]?.gate_deadline_seconds).toBe(3600);
  });
```

- [ ] **Step 2: Chạy, xác nhận fail** — `pnpm vitest run packages/core/test/orchestration packages/core/test/state`.

- [ ] **Step 3: `request.ts`**

```ts
import { isHarnessError, type Attempt, type Clock, type HarnessConfig, type Lease, type ProductionProfile, type Run, type SourceItem, type StageDefinition, type StageInput, type StageRequest, type StageRun, type StateStore, type VerificationPolicy } from "@harness/contracts";
import { addSeconds } from "../state/clock.js";
import type { LoadedWorkflow } from "./registry.js";

export interface RequestDeps { store: StateStore; clock: Clock; harness: HarnessConfig; profiles: (id: string) => ProductionProfile; workflows: (ref: string) => LoadedWorkflow }

export function stageDefinitionFor(workflows: RequestDeps["workflows"], run: Run, stageKey: string): StageDefinition | undefined {
  return workflows(`${run.workflow_release.id}@${run.workflow_release.version}`).definition.stages.find((s) => s.key === stageKey);
}
export function mimeTypesFor(def: StageDefinition | undefined): Record<string, string> {
  return Object.fromEntries((def?.outputs ?? []).map((o) => [o.type, o.mime_type]));
}
export function policyFor(profile: ProductionProfile): VerificationPolicy {
  return { ...(profile.content.target_duration_seconds ? { target_duration_seconds: profile.content.target_duration_seconds } : {}), ...(profile.content.max_silence_ratio !== undefined ? { max_silence_ratio: profile.content.max_silence_ratio } : {}) };
}

export function buildStageRequest(d: RequestDeps, p: { run: Run; stageRun: StageRun; attempt: Attempt; lease: Lease; inputs: StageInput[]; workspaceDir: string; capabilities: string[] }): StageRequest {
  const { run, stageRun } = p;
  const cfg = run.effective_config_snapshot;
  const exec = stageRun.executor;
  const stage_config = { ...stageRun.stage_config, ...(exec.type === "script" ? { __script: exec.script } : exec.type === "agent" ? { __skill: exec.skill, __brief: exec.brief } : { __brief: exec.brief }) };
  const content = run.content_id ? d.store.getContentItem(run.content_id) : undefined;
  const source_items = (content?.source_ids ?? []).map((id) => d.store.getSourceItem(id)).filter((s): s is SourceItem => !!s)
    .map((s) => ({ source_id: s.source_id, uri: s.uri, checksum: s.checksum, mime_type: s.mime_type, duration_seconds: s.duration_seconds }));
  const def = stageDefinitionFor(d.workflows, run, stageRun.stage_key);
  let policy: VerificationPolicy = {};
  try { policy = policyFor(d.profiles(run.profile_snapshot.id)); }
  catch (e) { if (!isHarnessError(e, "NOT_FOUND")) throw e; } // only a missing profile file degrades to no thresholds; anything else is a real error
  return {
    schema_version: "harness.stage-request/v1", run_id: run.run_id, stage_run_id: stageRun.stage_run_id, attempt_id: p.attempt.attempt_id,
    project_id: run.project_id, portfolio_id: run.portfolio_id, stage_key: stageRun.stage_key, workflow: run.workflow_release, profile_snapshot: run.profile_snapshot,
    inputs: p.inputs, workspace_uri: p.workspaceDir, stage_config, options: run.options, source_items, resources: p.lease.resources,
    expected_outputs: (def?.outputs ?? []).map((o) => ({ type: o.type, mime_type: o.mime_type, kind: o.kind, ...(o.name ? { name: o.name } : {}) })),
    policy,
    limits: { deadline_at: addSeconds(d.clock.now(), Number(cfg.default_deadline_seconds ?? d.harness.default_deadline_seconds)), max_cost_usd: Number(cfg.default_max_cost_usd ?? d.harness.default_max_cost_usd), max_attempts: stageRun.retry.max_attempts },
    capabilities: p.capabilities, fencing_token: p.lease.fencing_token,
  };
}
```

Export từ `packages/core/src/index.ts`.

- [ ] **Step 4: `claim({ stageRunId })`** — trong `SqliteStateStore.claim`, thay câu SELECT:

```ts
      const rows = params.stageRunId
        ? (this.db.prepare("SELECT data FROM stage_run WHERE state = 'READY' AND id = ?").all(params.stageRunId) as Row[])
        : (this.db.prepare("SELECT data FROM stage_run WHERE state = 'READY' ORDER BY json_extract(data, '$.ready_at'), rowid LIMIT 100").all() as Row[]);
```

- [ ] **Step 5: Planner** — trong `plan()`: run có `budget_usd: input.profile.limits.max_cost_usd_per_variant`; StageRun có `...(s.gate_deadline_seconds ? { gate_deadline_seconds: s.gate_deadline_seconds } : {})`.

- [ ] **Step 6: Worker** — `WorkerDeps` thêm `profiles: (id: string) => ProductionProfile`. Xoá `buildRequest` và `mimeTypesFor` riêng của worker; dùng:

```ts
      request = buildStageRequest({ store, clock, harness: this.d.harness, profiles: this.d.profiles, workflows: this.d.workflows }, { run, stageRun: claim.stageRun, attempt: claim.attempt, lease: claim.lease, inputs, workspaceDir, capabilities: this.d.capabilities });
```

và `mimeTypes: mimeTypesFor(def)` ở cả hai lời gọi `controller.commit`. Map lỗi executor: `isHarnessError(e, "NOT_FOUND") || isHarnessError(e, "SCHEMA_INVALID") || isHarnessError(e, "SECRET_UNRESOLVED") ? "contract" : "transient"`. Cập nhật `packages/worker/test/worker.test.ts` `makeWorld`: `profiles: (id) => loadProfile(HARNESS_ROOT, id)`; `packages/cli/src/commands/worker.ts` truyền `profiles: ctx.profiles` (thêm `profiles` vào `AppContext` ở composition: `(id) => loadProfile(harnessRoot, id)`).

- [ ] **Step 7: Test pass** — `pnpm build && pnpm typecheck && pnpm test`. Test worker "runs the sample workflow" vẫn phải thấy artifact `final_text` có mime `text/plain` (nay lấy từ workflow chứ không hard-code).

- [ ] **Step 8: Commit**

```bash
git add packages
git commit -m "feat(core): buildStageRequest with expected outputs and policy; targeted claim; gate deadline and budget on plan

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `@harness/script-sdk`

**Files:**
- Create: `packages/script-sdk/package.json`, `packages/script-sdk/tsconfig.json`, `packages/script-sdk/vitest.config.ts`, `packages/script-sdk/src/index.js`, `packages/script-sdk/src/index.d.ts`, `packages/script-sdk/README.md`, `packages/script-sdk/test/sdk.test.ts`
- Modify: `vitest.shared.ts` (alias `@harness/script-sdk` → `packages/script-sdk/src/index.js`), `package.json` root devDependencies, `packages/executors/package.json` devDependencies (`@harness/script-sdk: workspace:*`), `packages/executors/test/script-sdk-compat.test.ts` (Create)

**Interfaces:**
- Produces (public, xem `index.d.ts` bên dưới): `start()`, `ScriptContext`. Digest thư mục **phải** trùng `directoryDigest(listDirectoryFiles(dir))` của core: canonical JSON (key sort đệ quy) của mảng entries `{ path, checksum, size_bytes }` sắp theo `path` (forward slash), sha256 hex, tiền tố `sha256:`.
- Env do executor cung cấp (Task 4): `HARNESS_WORKSPACE`, `HARNESS_PROJECT`, `HARNESS_RUN_ID`, `HARNESS_STAGE_RUN_ID`, `HARNESS_ATTEMPT_ID`, `HARNESS_FENCING_TOKEN`, `HARNESS_STAGE_KEY`, `HARNESS_CLI_ARGV` (JSON array).

- [ ] **Step 1: package**

`packages/script-sdk/package.json`:

```json
{
  "name": "@harness/script-sdk", "version": "0.1.0", "type": "module", "license": "MIT",
  "description": "Helpers for wrapper scripts driven by the YouTube Operations Harness (stage-request/stage-result file protocol).",
  "main": "./src/index.js", "types": "./src/index.d.ts",
  "exports": { ".": { "types": "./src/index.d.ts", "default": "./src/index.js" } },
  "files": ["src", "README.md"],
  "scripts": { "build": "node -e \"process.exit(0)\"", "typecheck": "tsc -p tsconfig.json" },
  "engines": { "node": ">=20" }
}
```

`tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "compilerOptions": { "allowJs": true, "checkJs": true, "noEmit": true, "declaration": false, "composite": false, "sourceMap": false }, "include": ["src"] }`.
`vitest.config.ts`: `sharedConfig({ include: ["test/**/*.test.ts"], testTimeout: 20000 })`.

- [ ] **Step 2: Test thất bại** — `packages/script-sdk/test/sdk.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../src/index.js";

const sha = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");
function workspace() {
  const ws = mkdtempSync(join(tmpdir(), "sdk-"));
  mkdirSync(join(ws, "input", "artifact_1"), { recursive: true }); mkdirSync(join(ws, "output"));
  writeFileSync(join(ws, "input", "artifact_1", "narration.txt"), "hello");
  writeFileSync(join(ws, "stage-request.json"), JSON.stringify({
    schema_version: "harness.stage-request/v1", run_id: "run_1", stage_run_id: "stage_1", attempt_id: "attempt_1", project_id: "p", portfolio_id: "pf", stage_key: "tts",
    workflow: { id: "w", version: "1.0.0", digest: sha("w") }, profile_snapshot: { id: "footage", revision: 1 },
    inputs: [{ artifact_id: "artifact_1", checksum: sha("hello"), path: "input/artifact_1/narration.txt", type: "narration", kind: "file" }],
    workspace_uri: ws, stage_config: {}, options: { voice: "tts" }, source_items: [{ source_id: "src_1", uri: "file:///x.mp4", checksum: sha("x"), mime_type: "video/mp4", duration_seconds: 5 }],
    resources: ["gpu"], expected_outputs: [{ type: "voice_track", mime_type: "audio/wav", kind: "file", name: "narration.wav" }], policy: {},
    limits: { deadline_at: "2026-09-13T00:00:00.000Z", max_cost_usd: 1, max_attempts: 1 }, capabilities: [], fencing_token: 1,
  }));
  return ws;
}
const captured: string[] = [];
const io = { stdout: (line: string) => { captured.push(line); }, exit: (_code: number) => {} };

describe("script-sdk", () => {
  it("reads the request from HARNESS_WORKSPACE, resolves inputs by type or path, exposes sources and resources", async () => {
    const ws = workspace();
    const ctx = await start({ env: { HARNESS_WORKSPACE: ws }, io });
    expect(ctx.request.stage_key).toBe("tts");
    expect(ctx.input("narration")).toBe(join(ws, "input", "artifact_1", "narration.txt"));
    expect(ctx.input("narration.txt")).toBe(join(ws, "input", "artifact_1", "narration.txt"));
    expect(() => ctx.input("missing")).toThrow(/no input/);
    expect(ctx.source(0).source_id).toBe("src_1");
    expect(ctx.hasResource("gpu")).toBe(true);
    expect(ctx.options.voice).toBe("tts");
  });
  it("declares file and directory outputs with checksums matching the harness algorithm, then writes stage-result.json", async () => {
    const ws = workspace();
    const ctx = await start({ env: { HARNESS_WORKSPACE: ws }, io });
    writeFileSync(join(ws, "output", "narration.wav"), "RIFF");
    mkdirSync(join(ws, "output", "cuts")); writeFileSync(join(ws, "output", "cuts", "001.mp4"), "a"); writeFileSync(join(ws, "output", "cuts", "002.mp4"), "bb");
    await ctx.out.file("output/narration.wav", { type: "voice_track" });
    await ctx.out.dir("output/cuts", { type: "clip_set" });
    ctx.heartbeat({ percent: 50 });
    ctx.log.info("rendered", { n: 2 });
    await ctx.done({ cost_usd: 0.25 });
    const result = JSON.parse(readFileSync(join(ws, "stage-result.json"), "utf8"));
    expect(result).toMatchObject({ schema_version: "harness.stage-result/v1", attempt_id: "attempt_1", outcome: "succeeded", usage: { cost_usd: 0.25 } });
    expect(result.outputs[0]).toEqual({ path: "output/narration.wav", type: "voice_track", checksum: sha("RIFF"), size_bytes: 4, kind: "file" });
    const listing = [{ checksum: sha("a"), path: "001.mp4", size_bytes: 1 }, { checksum: sha("bb"), path: "002.mp4", size_bytes: 2 }];
    expect(result.outputs[1]).toEqual({ path: "output/cuts", type: "clip_set", checksum: sha(JSON.stringify(listing)), size_bytes: 3, kind: "directory" });
    expect(JSON.parse(readFileSync(join(ws, "progress.json"), "utf8"))).toMatchObject({ percent: 50 });
    expect(JSON.parse(captured.at(-1)!)).toMatchObject({ level: "info", msg: "rendered", n: 2 });
  });
  it("fail() and unknown() write failed/unknown results and out.clear() empties output/", async () => {
    const ws = workspace();
    const ctx = await start({ env: { HARNESS_WORKSPACE: ws }, io });
    writeFileSync(join(ws, "output", "junk"), "x");
    ctx.out.clear();
    expect(readFileSync(join(ws, "stage-request.json"), "utf8")).toContain("tts");
    await ctx.fail("transient", "gpu busy", { code: 503 });
    expect(JSON.parse(readFileSync(join(ws, "stage-result.json"), "utf8"))).toMatchObject({ outcome: "failed", errors: [{ kind: "transient", message: "gpu busy", details: { code: 503 } }] });
    await ctx.unknown("lost after dispatch", ["op_1"]);
    expect(JSON.parse(readFileSync(join(ws, "stage-result.json"), "utf8"))).toMatchObject({ outcome: "unknown", external_operations: ["op_1"] });
  });
});
```

Run: `pnpm vitest run packages/script-sdk` → FAIL (module không tồn tại).

- [ ] **Step 3: `src/index.js`**

```js
// @harness/script-sdk — no dependencies beyond node builtins. Talks to the harness only through files in the workspace,
// stdout JSON lines, and the `harness op …` CLI (child process). See README.md.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const sha256 = (buf) => "sha256:" + createHash("sha256").update(buf).digest("hex");
function sha256File(path) { const h = createHash("sha256"); h.update(readFileSync(path)); return { checksum: "sha256:" + h.digest("hex"), size_bytes: statSync(path).size }; }
function walk(root, dir, out) { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(root, p, out); else if (e.isFile()) out.push(p); } }
/** Same listing + digest as the harness core (`listDirectoryFiles` / `directoryDigest`). */
export function directoryListing(dir) {
  const files = []; walk(dir, dir, files);
  const entries = files.map((f) => ({ path: relative(dir, f).split(sep).join("/"), ...sha256File(f) })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, checksum: sha256(JSON.stringify(sortKeys(entries))), size_bytes: entries.reduce((n, e) => n + e.size_bytes, 0) };
}

export async function start(opts = {}) {
  const env = opts.env ?? process.env;
  const io = { stdout: opts.io?.stdout ?? ((line) => process.stdout.write(line + "\n")), exit: opts.io?.exit ?? ((code) => { process.exitCode = code; }) };
  const workspace = resolve(env.HARNESS_WORKSPACE ?? opts.workspace ?? process.cwd());
  const request = JSON.parse(readFileSync(join(workspace, "stage-request.json"), "utf8"));
  const outputs = [];
  const abs = (rel) => (isAbsolute(rel) ? rel : join(workspace, rel));
  const relPosix = (rel) => rel.split("\\").join("/").replace(/\/+$/, "");
  const cliArgv = () => { const raw = env.HARNESS_CLI_ARGV; if (!raw) throw new Error("HARNESS_CLI_ARGV is not set: ctx.op.* needs the harness CLI"); return JSON.parse(raw); };
  const cli = (args) => {
    const [cmd, ...rest] = cliArgv();
    const r = spawnSync(cmd, [...rest, "--project", env.HARNESS_PROJECT ?? process.cwd(), ...args, "--json"], { encoding: "utf8", env: { ...process.env, HARNESS_LOG_LEVEL: "error" } });
    if (r.status !== 0) throw new Error(`harness ${args.join(" ")} failed: ${r.stderr.trim()}`);
    return JSON.parse(r.stdout.trim().split("\n").at(-1));
  };
  const writeResult = (partial) => {
    const result = { schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outputs, checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [], ...partial };
    writeFileSync(join(workspace, "stage-result.json"), JSON.stringify(result, null, 2));
    io.exit(0);
    return result;
  };
  const log = (level) => (msg, data = {}) => io.stdout(JSON.stringify({ level, msg, ...data }));
  return {
    request, workspace, options: request.options ?? {}, sources: request.source_items ?? [],
    input(typeOrPath) {
      const i = (request.inputs ?? []).find((x) => x.type === typeOrPath) ?? (request.inputs ?? []).find((x) => x.path === typeOrPath || x.path.endsWith("/" + typeOrPath));
      if (!i) throw new Error(`no input with type or path "${typeOrPath}" (have: ${(request.inputs ?? []).map((x) => `${x.type}:${x.path}`).join(", ") || "none"})`);
      return abs(i.path);
    },
    inputs(type) { return (request.inputs ?? []).filter((x) => x.type === type).map((x) => abs(x.path)); },
    hasInput(type) { return (request.inputs ?? []).some((x) => x.type === type); },
    source(i) { const s = (request.source_items ?? [])[i]; if (!s) throw new Error(`no source item at index ${i}`); return s; },
    hasResource(name) { return (request.resources ?? []).includes(name); },
    out: {
      async file(rel, o) { const p = abs(rel); if (!existsSync(p)) throw new Error(`output missing: ${rel}`); outputs.push({ path: relPosix(rel), type: o.type, ...sha256File(p), kind: "file" }); },
      async dir(rel, o) { const p = abs(rel); if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error(`output directory missing: ${rel}`); const { checksum, size_bytes } = directoryListing(p); outputs.push({ path: relPosix(rel), type: o.type, checksum, size_bytes, kind: "directory" }); },
      clear() { const dir = join(workspace, "output"); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); outputs.length = 0; },
    },
    heartbeat(p = {}) { writeFileSync(join(workspace, "progress.json"), JSON.stringify({ ...p, at: new Date().toISOString() })); },
    log: { info: log("info"), warn: log("warn"), error: log("error") },
    async done(o = {}) { return writeResult({ outcome: "succeeded", usage: { wall_seconds: o.wall_seconds ?? 0, cost_usd: o.cost_usd ?? 0 }, external_operations: o.external_operations ?? [] }); },
    async fail(kind, message, details = {}) { return writeResult({ outcome: "failed", outputs: [], errors: [{ kind, message, details }] }); },
    async unknown(message, external_operations = []) { return writeResult({ outcome: "unknown", outputs: [], external_operations, errors: [{ kind: "unknown", message, details: {} }] }); },
    op: {
      async intent(p) { return cli(["op", "intent", "--attempt", env.HARNESS_ATTEMPT_ID, "--fencing-token", env.HARNESS_FENCING_TOKEN, "--provider", p.provider, "--kind", p.kind, "--target", p.target, "--payload", JSON.stringify(p.payload ?? {})]); },
      async confirm(operationId, r) { return cli(["op", "confirm", operationId, "--fencing-token", env.HARNESS_FENCING_TOKEN, "--provider-ref", r.provider_ref, "--receipt", JSON.stringify(r.receipt ?? {}), ...(r.cost_usd !== undefined ? ["--cost-usd", String(r.cost_usd)] : [])]); },
      async lost(operationId, reason) { return cli(["op", "lost", operationId, "--fencing-token", env.HARNESS_FENCING_TOKEN, "--reason", reason]); },
    },
  };
}
```

- [ ] **Step 4: `src/index.d.ts`**

```ts
export interface StageInputLike { artifact_id: string; checksum: string; path: string; type: string; kind: "file" | "directory" }
export interface SourceItemLike { source_id: string; uri: string; checksum: string; mime_type: string; duration_seconds: number | null }
export interface ExpectedOutputLike { type: string; mime_type: string; kind: "file" | "directory"; name?: string }
export interface StageRequestLike {
  schema_version: string; run_id: string; stage_run_id: string; attempt_id: string; project_id: string; portfolio_id: string; stage_key: string;
  workflow: { id: string; version: string; digest: string }; profile_snapshot: { id: string; revision: number };
  inputs: StageInputLike[]; workspace_uri: string; stage_config: Record<string, unknown>; options: Record<string, unknown>;
  source_items: SourceItemLike[]; resources: string[]; expected_outputs: ExpectedOutputLike[]; policy: Record<string, unknown>;
  limits: { deadline_at: string; max_cost_usd: number; max_attempts: number }; capabilities: string[]; fencing_token: number;
}
export type FailureKind = "transient" | "result" | "contract";
export interface OperationRecord { operation_id: string; status: string; provider_ref: string | null; receipt: Record<string, unknown> | null }
export interface ScriptContext {
  readonly request: StageRequestLike; readonly workspace: string; readonly options: Record<string, unknown>; readonly sources: SourceItemLike[];
  input(typeOrPath: string): string; inputs(type: string): string[]; hasInput(type: string): boolean; source(i: number): SourceItemLike; hasResource(name: string): boolean;
  out: { file(rel: string, o: { type: string; mime?: string }): Promise<void>; dir(rel: string, o: { type: string }): Promise<void>; clear(): void };
  heartbeat(p?: { percent?: number; message?: string }): void;
  log: { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void; error(msg: string, data?: Record<string, unknown>): void };
  done(o?: { cost_usd?: number; wall_seconds?: number; external_operations?: string[] }): Promise<unknown>;
  fail(kind: FailureKind, message: string, details?: Record<string, unknown>): Promise<unknown>;
  unknown(message: string, external_operations?: string[]): Promise<unknown>;
  op: {
    intent(p: { provider: string; kind: string; target: string; payload?: Record<string, unknown> }): Promise<OperationRecord>;
    confirm(operationId: string, r: { provider_ref: string; receipt?: Record<string, unknown>; cost_usd?: number }): Promise<OperationRecord>;
    lost(operationId: string, reason: string): Promise<OperationRecord>;
  };
}
export interface StartOptions { workspace?: string; env?: Record<string, string | undefined>; io?: { stdout?(line: string): void; exit?(code: number): void } }
export function start(opts?: StartOptions): Promise<ScriptContext>;
export function directoryListing(dir: string): { entries: { path: string; checksum: string; size_bytes: number }[]; checksum: string; size_bytes: number };
```

- [ ] **Step 5: Cross-check với core** — `packages/executors/test/script-sdk-compat.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryDigest, listDirectoryFiles } from "@harness/core";
import { directoryListing } from "@harness/script-sdk";

describe("script-sdk directory digest matches core", () => {
  it("same checksum and size for a nested tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmp-"));
    mkdirSync(join(dir, "sub")); writeFileSync(join(dir, "b.txt"), "bb"); writeFileSync(join(dir, "sub", "a.txt"), "a");
    const core = directoryDigest(await listDirectoryFiles(dir));
    const sdk = directoryListing(dir);
    expect(sdk.checksum).toBe(core.checksum);
    expect(sdk.size_bytes).toBe(core.size_bytes);
  });
});
```

Thêm alias vào `vitest.shared.ts`: `"@harness/script-sdk": \`${ROOT}packages/script-sdk/src/index.js\``; root `package.json` devDependencies và `packages/executors/package.json` devDependencies thêm `"@harness/script-sdk": "workspace:*"`; `pnpm install`.

- [ ] **Step 6: README.md** của package: mục đích, cài `npm i @harness/script-sdk`, ví dụ wrapper 15 dòng (đọc input, chạy lệnh ngoài bằng `spawnSync`, `out.file`, `done`), bảng API, quy ước exit code (luôn 0 sau `done/fail/unknown`; exit ≠ 0 = transient), giải thích `HARNESS_*` env và `ctx.op.*`.

- [ ] **Step 7: Test pass** — `pnpm install && pnpm build && pnpm typecheck && pnpm test`.

- [ ] **Step 8: Commit**

```bash
git add packages/script-sdk packages/executors vitest.shared.ts package.json pnpm-lock.yaml
git commit -m "feat(script-sdk): dependency-free helper for wrapper scripts (request, outputs, result, ops)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `ScriptExecutor` v2 — registry từ `executors/scripts.yaml`, secret qua env, timeout, stdout JSON-line

**Files:**
- Create: `packages/core/src/config/scripts.ts`, `packages/cli/src/self.ts`
- Modify: `packages/executors/src/script-executor.ts`, `packages/adapters/fake/src/index.ts`, `packages/core/src/orchestration/planner.ts`, `packages/core/src/index.ts`, `packages/cli/src/composition.ts`, `packages/cli/src/commands/plan.ts`
- Test: `packages/executors/test/script-executor.test.ts`, `packages/core/test/config/scripts.test.ts`, `packages/core/test/orchestration/planner.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // core/config/scripts.ts
  export function loadScriptsRegistry(projectDir: string): ScriptsRegistry | undefined   // undefined khi không có executors/scripts.yaml; ném CONFIG_INVALID khi sai schema
  export function scriptCommandsFrom(registry: ScriptsRegistry, projectDir: string): Record<string, ScriptCommand>
  // contracts (thêm vào interfaces.ts)
  export interface ScriptCommand { argv: string[]; cwd?: string; env_refs?: Record<string, string>; timeout_seconds?: number }
  // executors
  export interface ScriptExecutorOptions { projectDir?: string; secrets?: SecretResolver; cliArgv?: string[] }
  export class ScriptExecutor { constructor(commands: Record<string, ScriptCommand>, opts?: ScriptExecutorOptions) }
  // planner
  PlanInput.requiresResourcesOverride?: (stage: StageDefinition) => string[] | undefined
  // cli/self.ts
  export function cliArgv(): string[]   // [process.execPath, ...execArgv với `--import <bare>` đã resolve thành file:// URL, process.argv[1]]
  ```
- `fakeScriptCommands()` giữ nguyên kiểu trả về nhưng giá trị nay là `Record<string, ScriptCommand>` (`{ "fake-stage": { argv } }`). Sửa mọi chỗ gọi `new ScriptExecutor(fakeScriptCommands())` — vẫn hợp lệ vì cùng shape.

Hành vi executor:
1. `cwd` của tiến trình con = `resolve(projectDir, cmd.cwd ?? ".")` (không có `projectDir` → workspace, giữ tương thích test cũ).
2. Env con = `process.env` + `HARNESS_WORKSPACE`, `HARNESS_PROJECT`, `HARNESS_RUN_ID`, `HARNESS_STAGE_RUN_ID`, `HARNESS_ATTEMPT_ID`, `HARNESS_FENCING_TOKEN`, `HARNESS_STAGE_KEY`, `HARNESS_CLI_ARGV` (JSON của `opts.cliArgv` nếu có) + mỗi `env_refs[NAME] = secrets.resolve(ref)`. Không có `secrets` mà có `env_refs` → ném `SECRET_UNRESOLVED`.
3. `timeoutMs = min(deadline - now, timeout_seconds * 1000)`.
4. Mỗi dòng stdout: nếu parse được JSON object có `level` ∈ info|warn|error và `msg` string → `ctx.logger[level](msg, rest)`; ngược lại `ctx.logger.info(line, { stream: "stdout" })`. Logger của worker đã có Redactor nên giá trị secret bị che.
5. Vẫn ghi `logs/script-stderr.log`; giữ nguyên các nhánh lỗi (exit ≠ 0 transient, thiếu/sai `stage-result.json` result/contract).

- [ ] **Step 1: Test thất bại**

Thêm vào `packages/executors/test/script-executor.test.ts` (giữ các test cũ; `request()` helper đã có):

```ts
  it("runs from the project cwd, passes HARNESS_* env, resolved secrets, and redacts JSON-line logs through the logger", async () => {
    const project = mkdtempSync(join(tmpdir(), "proj-"));
    writeFileSync(join(project, "echo.mjs"), `
      import { writeFileSync } from "node:fs"; import { join } from "node:path";
      console.log(JSON.stringify({ level: "warn", msg: "key is " + process.env.MY_KEY, cwd: process.cwd() }));
      console.log("plain line");
      writeFileSync(join(process.env.HARNESS_WORKSPACE, "stage-result.json"), JSON.stringify({ schema_version: "harness.stage-result/v1", attempt_id: process.env.HARNESS_ATTEMPT_ID, outcome: "succeeded", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [] }));
    `);
    const lines: { level: string; msg: string; data?: object }[] = [];
    const logger = { info: (msg: string, data?: object) => lines.push({ level: "info", msg, data }), warn: (msg: string, data?: object) => lines.push({ level: "warn", msg, data }), error: (msg: string, data?: object) => lines.push({ level: "error", msg, data }) };
    const secrets = { resolve: (ref: string) => (ref === "secret://heygen/main" ? "s3cr3t" : (() => { throw new Error("nope"); })()), resolvedValues: () => ["s3cr3t"] };
    const ex = new ScriptExecutor({ echo: { argv: [process.execPath, "echo.mjs"], cwd: ".", env_refs: { MY_KEY: "secret://heygen/main" } } }, { projectDir: project, secrets, cliArgv: ["node", "cli.js"] });
    const req = request({ __script: "echo" });
    const res = await ex.execute(req, { workspaceDir: req.workspace_uri, logger, clock: wall });
    expect(res.outcome).toBe("succeeded");
    expect(res.attempt_id).toBe(req.attempt_id);
    const warn = lines.find((l) => l.level === "warn")!;
    expect(warn.msg).toBe("key is s3cr3t"); // the executor forwards raw text; redaction is the logger's job (worker logger has the Redactor)
    expect((warn.data as { cwd: string }).cwd.toLowerCase()).toBe(project.toLowerCase());
    expect(lines.some((l) => l.msg === "plain line")).toBe(true);
  });
  it("caps the deadline by timeout_seconds", async () => {
    const ex = new ScriptExecutor({ ...fakeScriptCommands(), slow: { ...fakeScriptCommands()["fake-stage"]!, timeout_seconds: 1 } });
    const req = { ...request({ __script: "slow", sleep_ms: 5000 }), limits: { deadline_at: new Date(Date.now() + 60_000).toISOString(), max_cost_usd: 5, max_attempts: 3 } };
    const res = await ex.execute(req, { workspaceDir: req.workspace_uri, logger: silent, clock: wall });
    expect(res.errors[0]).toMatchObject({ kind: "transient", details: { code: "EXECUTOR_TIMEOUT" } });
  });
  it("throws SECRET_UNRESOLVED when an env ref cannot be resolved", async () => {
    const ex = new ScriptExecutor({ x: { argv: [process.execPath, "-e", "0"], env_refs: { K: "secret://tts/main" } } }, { secrets: { resolve: () => { throw new HarnessError("SECRET_UNRESOLVED", "cannot resolve", {}); }, resolvedValues: () => [] } });
    const req = request({ __script: "x" });
    await expect(ex.execute(req, { workspaceDir: req.workspace_uri, logger: silent, clock: wall })).rejects.toMatchObject({ code: "SECRET_UNRESOLVED" });
  });
```

(import thêm `HarnessError`, `writeFileSync`.)

`packages/core/test/config/scripts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessError } from "@harness/contracts";
import { loadScriptsRegistry, scriptCommandsFrom } from "../../src/config/scripts.js";

describe("scripts registry", () => {
  it("returns undefined without a file, parses a valid one, rejects an invalid one", () => {
    const p = mkdtempSync(join(tmpdir(), "sr-"));
    expect(loadScriptsRegistry(p)).toBeUndefined();
    mkdirSync(join(p, "executors"));
    writeFileSync(join(p, "executors", "scripts.yaml"), "schema_version: harness.scripts/v1\nscripts:\n  tts: { argv: [node, executors/wrappers/tts.mjs], requires_resources: [gpu], env_refs: { TTS_KEY: 'secret://tts/main' } }\n");
    const reg = loadScriptsRegistry(p)!;
    expect(scriptCommandsFrom(reg, p).tts).toEqual({ argv: ["node", "executors/wrappers/tts.mjs"], cwd: p, env_refs: { TTS_KEY: "secret://tts/main" } });
    writeFileSync(join(p, "executors", "scripts.yaml"), "schema_version: harness.scripts/v1\nscripts:\n  tts: { argv: [] }\n");
    try { loadScriptsRegistry(p); throw new Error("no throw"); } catch (e) { expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true); }
  });
});
```

Planner test (thêm vào `planner.test.ts`):

```ts
  it("requiresResourcesOverride replaces the workflow's requires_resources for a script stage", () => {
    const run = planner.plan({ workflow: loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0"), profile: loadProfile(HARNESS_ROOT, "cartoon"), harness: loadHarnessConfig(HARNESS_ROOT), projectId: "p", portfolioId: "pf", requiresResourcesOverride: (s) => (s.key === "produce" ? ["cpu"] : undefined) });
    const byKey = Object.fromEntries(store.listStageRuns(run.run_id).map((s) => [s.stage_key, s.requires_resources]));
    expect(byKey).toEqual({ produce: ["cpu"], review: [], finalize: [] });
  });
```

- [ ] **Step 2: Chạy, xác nhận fail** — `pnpm vitest run packages/executors packages/core/test/config packages/core/test/orchestration/planner.test.ts`.

- [ ] **Step 3: `core/config/scripts.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { HarnessError, ScriptsRegistrySchema, type ScriptCommand, type ScriptsRegistry } from "@harness/contracts";

export const SCRIPTS_FILE = join("executors", "scripts.yaml");

export function loadScriptsRegistry(projectDir: string): ScriptsRegistry | undefined {
  const file = join(projectDir, SCRIPTS_FILE);
  if (!existsSync(file)) return undefined;
  const parsed = ScriptsRegistrySchema.safeParse(parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new HarnessError("CONFIG_INVALID", `${file} invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, { file, issues: parsed.error.issues });
  return parsed.data;
}

export function scriptCommandsFrom(registry: ScriptsRegistry, projectDir: string): Record<string, ScriptCommand> {
  return Object.fromEntries(Object.entries(registry.scripts).map(([name, s]) => [name, { argv: s.argv, cwd: resolve(projectDir, s.cwd), env_refs: s.env_refs, ...(s.timeout_seconds !== undefined ? { timeout_seconds: s.timeout_seconds } : {}) }]));
}
```

Thêm `ScriptCommand` vào `contracts/src/interfaces.ts`; export `scripts.js` từ core index.

- [ ] **Step 4: `script-executor.ts`** — viết lại theo hành vi 1–5 ở trên. Khung:

```ts
export class ScriptExecutor implements Executor {
  readonly version = "script-executor@0.2.0";
  constructor(private readonly commands: Record<string, ScriptCommand>, private readonly opts: ScriptExecutorOptions = {}) {}
  async execute(request: StageRequest, ctx: ExecutorContext): Promise<StageResult> {
    const name = String(request.stage_config.__script ?? "");
    const cmd = this.commands[name];
    if (!cmd || cmd.argv.length === 0) throw new HarnessError("NOT_FOUND", `no script registered for "${name}"`, { script: name });
    const env: Record<string, string> = { ...(process.env as Record<string, string>), HARNESS_WORKSPACE: ctx.workspaceDir, HARNESS_PROJECT: this.opts.projectDir ?? ctx.workspaceDir, HARNESS_RUN_ID: request.run_id, HARNESS_STAGE_RUN_ID: request.stage_run_id, HARNESS_ATTEMPT_ID: request.attempt_id, HARNESS_FENCING_TOKEN: String(request.fencing_token), HARNESS_STAGE_KEY: request.stage_key, ...(this.opts.cliArgv ? { HARNESS_CLI_ARGV: JSON.stringify(this.opts.cliArgv) } : {}) };
    for (const [k, ref] of Object.entries(cmd.env_refs ?? {})) {
      if (!this.opts.secrets) throw new HarnessError("SECRET_UNRESOLVED", `script "${name}" needs ${k} from ${ref} but no secret resolver is configured`, { script: name, env: k, ref });
      env[k] = this.opts.secrets.resolve(ref); // throws SECRET_UNRESOLVED; the value never touches request/result/event
    }
    writeFileSync(join(ctx.workspaceDir, "stage-request.json"), JSON.stringify(request, null, 2));
    const deadlineMs = Math.max(1, Date.parse(request.limits.deadline_at) - Date.parse(ctx.clock.now()));
    const timeoutMs = cmd.timeout_seconds ? Math.min(deadlineMs, cmd.timeout_seconds * 1000) : deadlineMs;
    const cwd = cmd.cwd ? resolve(this.opts.projectDir ?? ctx.workspaceDir, cmd.cwd) : ctx.workspaceDir;
    // spawn như cũ nhưng { cwd, env }, stdout đi qua forwardStdoutLine(ctx.logger)
    …
  }
}
function forwardStdout(logger: ExecutorContext["logger"]) {
  let buf = "";
  return (chunk: Buffer | string, flush = false) => {
    buf += String(chunk);
    const lines = buf.split(/\r?\n/); buf = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as Record<string, unknown>;
        if (j && typeof j === "object" && typeof j.msg === "string" && (j.level === "info" || j.level === "warn" || j.level === "error")) { const { level, msg, ...rest } = j; logger[level as "info" | "warn" | "error"](msg as string, rest); continue; }
      } catch { /* not JSON */ }
      logger.info(line, { stream: "stdout" });
    }
  };
}
```

`fakeScriptCommands()` trả `{ "fake-stage": { argv: [...] } }` (không `cwd` → chạy trong workspace như trước; `fake-stage-script.ts` đọc `process.cwd()` nên giữ đúng hành vi).

- [ ] **Step 5: Planner** — trong `plan()` khi dựng StageRun: `requires_resources: input.requiresResourcesOverride?.(s) ?? s.requires_resources`.

- [ ] **Step 6: `cli/self.ts` và composition**

```ts
// packages/cli/src/self.ts
/** argv that re-invokes this very CLI from any cwd: bare `--import x` specifiers become absolute file:// URLs. */
export function cliArgv(): string[] {
  const execArgv: string[] = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    const a = process.execArgv[i]!;
    if ((a === "--import" || a === "--loader" || a === "-r" || a === "--require") && process.execArgv[i + 1] && !/^(file:|\.|\/|[A-Za-z]:)/.test(process.execArgv[i + 1]!)) {
      execArgv.push(a, import.meta.resolve(process.execArgv[++i]!)); continue;
    }
    if (a.startsWith("--import=")) { const spec = a.slice(9); execArgv.push(`--import=${/^(file:|\.|\/|[A-Za-z]:)/.test(spec) ? spec : import.meta.resolve(spec)}`); continue; }
    execArgv.push(a);
  }
  return [process.execPath, ...execArgv, process.argv[1]!];
}
```

`composition.ts`: `const scripts = loadScriptsRegistry(projectDir); const commands = { ...fakeScriptCommands(), ...(scripts ? scriptCommandsFrom(scripts, projectDir) : {}) }; executors.register("script", new ScriptExecutor(commands, { projectDir, secrets, cliArgv: cliArgv() }));` — registry ops project thắng khi trùng tên. `AppContext` thêm `scripts: ScriptsRegistry | undefined`, `profiles`. `plan.ts` truyền `requiresResourcesOverride: (s) => s.executor.type === "script" ? ctx.scripts?.scripts[s.executor.script]?.requires_resources : undefined`.

- [ ] **Step 7: Test pass** — `pnpm build && pnpm typecheck && pnpm test`.

- [ ] **Step 8: Commit**

```bash
git add packages
git commit -m "feat(executors): script registry from executors/scripts.yaml, secrets via env, timeout cap, JSON-line stdout logs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: External operation từ wrapper — `harness op intent|confirm|lost`

**Files:**
- Create: `packages/cli/src/commands/op.ts`
- Modify: `packages/core/src/orchestration/journal.ts`, `packages/cli/src/main.ts`
- Test: `packages/core/test/orchestration/journal.test.ts`, `packages/cli/test/op.test.ts`

**Interfaces:**
- Produces (journal):
  ```ts
  confirmExternal(operationId: string, r: { provider_ref: string; receipt: Record<string, unknown>; cost_usd?: number }): ExternalOperation  // INTENT_RECORDED → DISPATCHED → CONFIRMED (hoặc DISPATCHED → CONFIRMED); idempotent nếu đã CONFIRMED
  markLost(operationId: string, reason: string): ExternalOperation   // INTENT_RECORDED → DISPATCHED → NEEDS_RECONCILIATION (hoặc từ DISPATCHED)
  ```
- CLI (đầu ra `--json` là `{ operation_id, status, provider_ref, receipt }`):
  - `harness op intent --attempt <attempt_id> --fencing-token <n> --provider <p> --kind <k> --target <t> --payload <json> [--json]`: kiểm `store.assertFencing(attempt.stage_run_id, token)`; nếu đã có op CONFIRMED cùng idempotency key → trả nó (`status: CONFIRMED`) để wrapper bỏ qua lời gọi; ngược lại `recordIntent`.
  - `harness op confirm <op_id> --fencing-token <n> --provider-ref <ref> [--receipt <json>] [--cost-usd <n>] [--json]`
  - `harness op lost <op_id> --fencing-token <n> --reason <text> [--json]`
- Cost của op (`cost_usd`) chỉ ghi trên external_operation; run cost vẫn cộng từ `StageResult.usage.cost_usd` như cũ (wrapper tự khai trong `done()`).

- [ ] **Step 1: Test thất bại** — thêm vào `journal.test.ts` (dùng cách seed run/stage/attempt của test có sẵn trong file):

```ts
  it("confirmExternal and markLost drive an intent recorded by a wrapper", () => {
    const op = journal.recordIntent({ request, provider: "heygen", kind: "render", target: "stage-x", payload: { a: 1 } });
    const confirmed = journal.confirmExternal(op.operation_id, { provider_ref: "hg-1", receipt: { ok: true }, cost_usd: 0.4 });
    expect(confirmed).toMatchObject({ status: "CONFIRMED", provider_ref: "hg-1", cost_usd: 0.4 });
    expect(journal.confirmExternal(op.operation_id, { provider_ref: "hg-1", receipt: {} }).status).toBe("CONFIRMED"); // idempotent
    const op2 = journal.recordIntent({ request, provider: "heygen", kind: "render", target: "stage-y", payload: {} });
    expect(journal.markLost(op2.operation_id, "socket closed").status).toBe("NEEDS_RECONCILIATION");
    expect(store.listEvents({ run_id: request.run_id, limit: 50 }).map((e) => e.event_type)).toEqual(expect.arrayContaining(["external_operation.confirmed", "external_operation.needs_reconciliation"]));
  });
```

`packages/cli/test/op.test.ts` (dùng `cli`, `freshProject` như `cli.test.ts`; claim một stage qua store để có attempt + token):

```ts
  it("op intent/confirm/lost run under the attempt's fencing token and reject a stale token", () => {
    const p = freshProject(); cli(p, "db", "migrate");
    const { run_id } = JSON.parse(cli(p, "plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--json").out);
    cli(p, "enqueue", run_id);
    const store = new SqliteStateStore(join(p, "data", "state", "harness.db"));
    const claim = store.claim({ owner: "w", capabilities: ["write_workspace"], now: new Date().toISOString(), leaseSeconds: 90 })!;
    store.close();
    const intent = JSON.parse(cli(p, "op", "intent", "--attempt", claim.attempt.attempt_id, "--fencing-token", "1", "--provider", "heygen", "--kind", "render", "--target", "t", "--payload", '{"x":1}', "--json").out);
    expect(intent.status).toBe("INTENT_RECORDED");
    const again = JSON.parse(cli(p, "op", "intent", "--attempt", claim.attempt.attempt_id, "--fencing-token", "1", "--provider", "heygen", "--kind", "render", "--target", "t", "--payload", '{"x":1}', "--json").out);
    expect(again.operation_id).toBe(intent.operation_id); // same idempotency key, still pending → same row
    expect(cli(p, "op", "confirm", intent.operation_id, "--fencing-token", "2", "--provider-ref", "hg-1").code).toBe(1);
    const confirmed = JSON.parse(cli(p, "op", "confirm", intent.operation_id, "--fencing-token", "1", "--provider-ref", "hg-1", "--receipt", '{"ok":true}', "--json").out);
    expect(confirmed).toMatchObject({ status: "CONFIRMED", provider_ref: "hg-1" });
    const third = JSON.parse(cli(p, "op", "intent", "--attempt", claim.attempt.attempt_id, "--fencing-token", "1", "--provider", "heygen", "--kind", "render", "--target", "t", "--payload", '{"x":1}', "--json").out);
    expect(third.status).toBe("CONFIRMED"); // wrapper must skip the paid call
    const lost = JSON.parse(cli(p, "op", "intent", "--attempt", claim.attempt.attempt_id, "--fencing-token", "1", "--provider", "heygen", "--kind", "render", "--target", "u", "--payload", "{}", "--json").out);
    expect(JSON.parse(cli(p, "op", "lost", lost.operation_id, "--fencing-token", "1", "--reason", "timeout", "--json").out).status).toBe("NEEDS_RECONCILIATION");
  });
```

- [ ] **Step 2: Chạy, xác nhận fail.**

- [ ] **Step 3: Journal**

```ts
  confirmExternal(operationId: string, r: { provider_ref: string; receipt: Record<string, unknown>; cost_usd?: number }): ExternalOperation {
    return this.store.transaction(() => {
      const op = this.must(operationId);
      if (op.status === "CONFIRMED") return op;
      if (op.status === "INTENT_RECORDED") this.store.transition("external_operation", op.operation_id, "INTENT_RECORDED", "DISPATCHED", this.ev(op, "external_operation.dispatched"));
      const cur = this.store.getExternalOperation(op.operation_id)!;
      if (cur.status !== "DISPATCHED") throw new HarnessError("INVALID_TRANSITION", `operation ${operationId} is ${cur.status}; cannot confirm`, { status: cur.status });
      this.store.updateExternalOperation({ ...cur, provider_ref: r.provider_ref, receipt: r.receipt, cost_usd: r.cost_usd ?? cur.cost_usd });
      this.store.transition("external_operation", op.operation_id, "DISPATCHED", "CONFIRMED", this.ev(op, "external_operation.confirmed", { provider_ref: r.provider_ref }));
      return this.store.getExternalOperation(op.operation_id)!;
    });
  }
  markLost(operationId: string, reason: string): ExternalOperation {
    return this.store.transaction(() => {
      const op = this.must(operationId);
      if (op.status === "INTENT_RECORDED") this.store.transition("external_operation", op.operation_id, "INTENT_RECORDED", "DISPATCHED", this.ev(op, "external_operation.dispatched"));
      const cur = this.store.getExternalOperation(op.operation_id)!;
      if (cur.status === "NEEDS_RECONCILIATION") return cur;
      if (cur.status !== "DISPATCHED") throw new HarnessError("INVALID_TRANSITION", `operation ${operationId} is ${cur.status}; cannot mark lost`, { status: cur.status });
      this.store.transition("external_operation", op.operation_id, "DISPATCHED", "NEEDS_RECONCILIATION", this.ev(op, "external_operation.needs_reconciliation", { reason }));
      return this.store.getExternalOperation(op.operation_id)!;
    });
  }
  private must(id: string): ExternalOperation { const op = this.store.getExternalOperation(id); if (!op) throw new HarnessError("NOT_FOUND", `external operation not found: ${id}`, { id }); return op; }
```

- [ ] **Step 4: `commands/op.ts`** — ba subcommand; mỗi lệnh: lấy attempt (`intent`: từ `--attempt`; `confirm`/`lost`: từ `op.attempt_id`), `ctx.store.assertFencing(attempt.stage_run_id, Number(token))` (ném `FENCING_REJECTED` → exit 1), rồi gọi journal. `intent` trước khi `recordIntent`: `const key = ctx.journal.keyFor({kind,target,payload}); const done = ctx.journal.findConfirmedByKey(key); if (done) return print(done)`. `--payload`/`--receipt` parse JSON, lỗi → `CONFIG_INVALID`. Output text: `${operation_id} ${status}`. Đăng ký `registerOp` trong `main.ts`.

- [ ] **Step 5: Test pass** — `pnpm build && pnpm typecheck && pnpm test`.

- [ ] **Step 6: Commit**

```bash
git add packages
git commit -m "feat(cli): harness op intent|confirm|lost so wrapper scripts journal external effects under the attempt's fencing token

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Gate executor, `submitGate()` và `harness stage submit`, cảnh báo gate quá hạn

**Files:**
- Create: `packages/executors/src/gate-executor.ts`, `packages/core/src/orchestration/gate.ts`, `packages/cli/src/commands/stage.ts`
- Modify: `packages/executors/src/index.ts`, `packages/core/src/index.ts`, `packages/worker/src/worker.ts`, `packages/cli/src/{composition.ts,main.ts,commands/status.ts}`, `packages/core/src/state/transitions.ts` (nếu thiếu cạnh)
- Test: `packages/executors/test/gate-executor.test.ts`, `packages/core/test/orchestration/gate.test.ts`, `packages/cli/test/stage-submit.test.ts`

**Interfaces:**
- `GateExecutor implements Executor` (`version = "gate-executor@0.1.0"`): ghi `stage-request.json` và `brief.md` vào workspace; trả `{ outcome: "deferred", outputs: [], errors: [] }`. `brief.md` gồm: tiêu đề `# <stage_key>`, đoạn `__brief`, bảng input (type, path), bảng output mong đợi từ `request.expected_outputs` (name, type, mime, kind), `options`, `source_items` (id, uri, duration), và dòng lệnh nộp: `harness stage submit <stage_run_id>` (ghi rõ file phải nằm trong `output/`).
- core:
  ```ts
  export interface GateDeps { store: StateStore; planner: Planner; controller: Controller; verifier: Verifier; clock: Clock; harness: HarnessConfig; profiles: (id: string) => ProductionProfile; workflows: (ref: string) => LoadedWorkflow; owner?: string }
  export interface SubmitReport { stageRunId: string; stageState: string; runState: string; missing: string[]; failed: { check_id: string; evidence: Record<string, unknown> }[]; artifacts: string[] }
  export async function submitGate(d: GateDeps, p: { stageRunId: string; fromDir?: string }): Promise<SubmitReport>
  export function gateOverdue(store: StateStore, now: string, windowSeconds: number): { run: Run; stage: StageRun; overdue_seconds: number }[]   // ghi event stage.gate_overdue tối đa một lần mỗi windowSeconds
  ```
- CLI: `harness stage submit <stage_run_id> [--from <dir>] [--json]` — exit 1 khi `missing`/`failed` khác rỗng (stage vẫn `WAITING_HUMAN`).

Quy tắc `submitGate`:
1. Stage phải `WAITING_HUMAN` và `executor.type === "gate"`, ngược lại `INVALID_TRANSITION`. Run không được terminal.
2. Workspace = `attempt.workspace_uri` của attempt cuối (gate attempt). Không có attempt/workspace → `NOT_FOUND`.
3. `--from`: `copyTree(fromDir, join(ws, "output"))` (ghi đè).
4. Outputs mong đợi = `stageDefinitionFor(...).outputs`; mỗi output của gate **phải có `name`** (`CONFIG_INVALID` nếu thiếu). Đường dẫn `output/<name>`; file → `sha256File`, directory → `directoryDigest(listDirectoryFiles)`. Thiếu → `missing`.
5. Pre-verify với request/result dựng trên attempt gate cũ (`buildStageRequest` với lease giả `{ resources: [], fencing_token: attempt.fencing_token }`): `verifier.verify(..., stageRun.required_checks)`; có `fail`/`missing` checker → trả về `failed`, ghi event `stage.submit_rejected` (payload `missing`, `failed`), **không** đổi state.
6. Khi sạch: `store.transaction`: `transition(WAITING_HUMAN → READY, "stage.submitted")`, `updateStageRun({ ready_at: now, not_before: now })`; sau transaction `claim({ owner: d.owner ?? "cli-submit", capabilities: stageRun.required_capabilities, now, leaseSeconds: harness.lease_seconds, stageRunId })` (undefined → `STALE_STATE`); transition attempt/stage `CLAIMED → RUNNING`; `updateAttempt({ workspace_uri })` (cùng workspace gate); dựng lại request+result với attempt mới; `verify` lại; `controller.commit({ ..., executorVersion: "cli-submit@0.1.0", inputArtifactIds: acceptedInputsFor(store, stageRun).map(id), mimeTypes: mimeTypesFor(def), stageDefinitionDigest })`.
7. `SubmitReport.artifacts` = id artifact ACCEPTED; `missing`/`failed` phản ánh lần verify sau claim. Sau khi `WAITING_HUMAN → READY`, nếu run đang `WAITING` thì gọi `planner.advance(run_id)` (như `retry.ts`) để run về RUNNING trước khi commit settle. Mọi lỗi ném ra sau khi claim (materialize, build request, verify) được commit như một `StageResult` failed (phase `submit`) để lease được trả, giống nhánh setup-failure của worker.

- [ ] **Step 1: Test thất bại**

`packages/executors/test/gate-executor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type StageRequest } from "@harness/contracts";
import { GateExecutor } from "../src/gate-executor.js";

describe("GateExecutor", () => {
  it("writes the request and a brief, then defers", async () => {
    const ws = mkdtempSync(join(tmpdir(), "gate-"));
    const req: StageRequest = { schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"), project_id: "p", portfolio_id: "pf", stage_key: "select-topic", workflow: { id: "footage-production", version: "1.0.0", digest: "sha256:" + "a".repeat(64) }, profile_snapshot: { id: "footage", revision: 1 }, inputs: [{ artifact_id: newId("artifact"), checksum: "sha256:" + "b".repeat(64), path: "input/x/shots.json", type: "shots", kind: "file" }], workspace_uri: ws, stage_config: { __brief: "Pick one topic from the shots." }, options: { voice: "tts" }, source_items: [], resources: [], expected_outputs: [{ type: "topic", mime_type: "text/markdown", kind: "file", name: "topic.md" }], policy: {}, limits: { deadline_at: "2026-09-13T01:00:00.000Z", max_cost_usd: 0, max_attempts: 1 }, capabilities: [], fencing_token: 1 };
    const res = await new GateExecutor().execute(req, { workspaceDir: ws, logger: { info() {}, warn() {}, error() {} }, clock: { now: () => "2026-09-13T00:00:00.000Z" } });
    expect(res).toMatchObject({ outcome: "deferred", outputs: [], attempt_id: req.attempt_id });
    expect(existsSync(join(ws, "stage-request.json"))).toBe(true);
    const brief = readFileSync(join(ws, "brief.md"), "utf8");
    expect(brief).toContain("Pick one topic"); expect(brief).toContain("output/topic.md"); expect(brief).toContain(`harness stage submit ${req.stage_run_id}`); expect(brief).toContain("input/x/shots.json");
  });
});
```

`packages/core/test/orchestration/gate.test.ts` — dựng world với workflow inline hai stage: `draft` (script fake-stage, outputs `script_text`) → `pick` (gate, outputs `[{ type: "topic", mime_type: "text/markdown", name: "topic.md" }]`, `required_checks: [schema-valid, output-exists, checksum-match]`, `gate_deadline_seconds: 60`). Chạy `draft` bằng `Controller.commit` trực tiếp như `controller.test.ts` (hoặc seed artifact), rồi để `pick` READY, claim với owner `"gate-worker"`, chạy `GateExecutor` không được (core không import executors) → giả lập bằng cách gọi `controller.commit` với `result.outcome = "deferred"` sau `createWorkspace` + `updateAttempt(workspace_uri)`. Sau đó:

```ts
  it("rejects a submit with missing outputs without touching state, then commits when the file is there", async () => {
    // … pick đang WAITING_HUMAN với attempt có workspace ws
    const deps = { store, planner, controller, verifier: new Verifier(BUILTIN_CHECKERS), clock, harness: loadHarnessConfig(HARNESS_ROOT), profiles: () => loadProfile(HARNESS_ROOT, "cartoon"), workflows: () => wf };
    const rejected = await submitGate(deps, { stageRunId: pick.stage_run_id });
    expect(rejected.missing).toEqual(["output/topic.md"]);
    expect(store.getStageRun(pick.stage_run_id)?.state).toBe("WAITING_HUMAN");
    expect(store.listAttempts(pick.stage_run_id)).toHaveLength(1);
    expect(store.listEvents({ run_id: run.run_id, limit: 5, newest: true }).at(-1)?.event_type).toBe("stage.submit_rejected"); // newest:true returns chronological order, newest last
    writeFileSync(join(ws, "output", "topic.md"), "# Topic\n");
    const ok = await submitGate(deps, { stageRunId: pick.stage_run_id });
    expect(ok).toMatchObject({ stageState: "SUCCEEDED", runState: "SUCCEEDED", missing: [], failed: [] });
    const attempts = store.listAttempts(pick.stage_run_id);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({ lease_owner: "cli-submit", state: "SUCCEEDED", fencing_token: 2 });
    const [art] = store.listArtifacts({ stage_run_id: pick.stage_run_id, status: "ACCEPTED" });
    expect(art).toMatchObject({ type: "topic", mime_type: "text/markdown" });
    expect(art?.lineage.input_artifacts).toHaveLength(1);
    expect(store.getLease(pick.stage_run_id)).toBeUndefined();
  });
  it("copies --from into output/ and refuses a non-gate or non-waiting stage", async () => { /* --from dir chứa topic.md → SUCCEEDED; submit lại → INVALID_TRANSITION */ });
  it("gateOverdue emits stage.gate_overdue once per window after gate_deadline_seconds", () => {
    // pick WAITING_HUMAN, deadline 60s; clock.advance(30) → []; advance(31) → 1 mục + event; gọi lại ngay → [] (đã có event trong cửa sổ); advance(600) → lại 1 mục
  });
```

`packages/cli/test/stage-submit.test.ts`: dùng workflow `sample-three-stage` không có gate → tạo workflow tạm? CLI nạp workflow từ `HARNESS_ROOT/workflows`, nên test CLI cho gate dùng workflow thật `footage-production` — để lại cho Task 9 (integration). Ở task này chỉ test CLI đường lỗi: `harness stage submit stage_<ulid-không-tồn-tại>` → exit 1, `NOT_FOUND`.

- [ ] **Step 2: Chạy, xác nhận fail.**

- [ ] **Step 3: `gate-executor.ts`** — theo mô tả Interfaces; export từ executors index; `composition.ts`: `executors.register("gate", new GateExecutor())`. Worker test `makeWorld` cũng đăng ký `gate`.

- [ ] **Step 4: `core/orchestration/gate.ts`** — `submitGate` theo quy tắc 1–7; `gateOverdue`:

```ts
export function gateOverdue(store: StateStore, now: string, windowSeconds: number) {
  const out: { run: Run; stage: StageRun; overdue_seconds: number }[] = [];
  for (const run of [...store.listRuns({ state: "WAITING" }), ...store.listRuns({ state: "RUNNING" })]) {
    for (const s of store.listStageRuns(run.run_id)) {
      if (s.state !== "WAITING_HUMAN" || s.executor.type !== "gate" || !s.gate_deadline_seconds) continue;
      const overdue = (Date.parse(now) - Date.parse(s.updated_at)) / 1000 - s.gate_deadline_seconds;
      if (overdue < 0) continue;
      const recent = store.listEvents({ run_id: run.run_id, limit: 200, newest: true }).some((e) => e.event_type === "stage.gate_overdue" && e.stage_run_id === s.stage_run_id && Date.parse(now) - Date.parse(e.occurred_at) < windowSeconds * 1000);
      if (recent) continue;
      store.appendEvent(eventFor(run, s, null, "stage.gate_overdue", "warn", { overdue_seconds: Math.floor(overdue), deadline_seconds: s.gate_deadline_seconds }));
      out.push({ run, stage: s, overdue_seconds: Math.floor(overdue) });
    }
  }
  return out;
}
```

Worker: trong `runOnce` khi idle (cùng chỗ `warnResourceStarvation`) gọi `gateOverdue(store, clock.now(), harness.resource_wait_warn_seconds)` và `logger.warn("gate overdue", …)` cho từng mục. `harness status`: gọi `gateOverdue` trước khi in; dòng stage gate quá hạn thêm ` OVERDUE`; stage có `reused_artifact_ids` thêm ` reused=<n>` và liệt kê artifact reuse với nhãn `(reused)` (đóng mục deferred "status không có dấu reused").

- [ ] **Step 5: `commands/stage.ts`**

```ts
export function registerStage(program: Command): void {
  const stage = program.command("stage").description("stage-level operations");
  stage.command("submit <stage_run_id>").option("--from <dir>", "copy this directory into the gate workspace output/ first").option("--json", "machine output", false)
    .description("submit the output of a WAITING_HUMAN gate stage: verify, then commit like a worker").action(async (id: string, o, cmd) => {
      await withContext(cmd, {}, async (ctx) => {
        const r = await submitGate({ store: ctx.store, planner: ctx.planner, controller: ctx.controller, verifier: ctx.verifier, clock: ctx.clock, harness: ctx.harness, profiles: ctx.profiles, workflows: ctx.workflows }, { stageRunId: id, ...(o.from ? { fromDir: o.from } : {}) });
        print(o.json, r, () => r.missing.length || r.failed.length ? ["submit rejected:", ...r.missing.map((m) => `  missing ${m}`), ...r.failed.map((f) => `  check ${f.check_id} failed ${JSON.stringify(f.evidence)}`)].join("\n") : `${id} ${r.stageState} (run ${r.runState}) artifacts=${r.artifacts.length}`);
        if (r.missing.length || r.failed.length) process.exitCode = 1;
      });
    });
}
```

- [ ] **Step 6: Test pass** — `pnpm build && pnpm typecheck && pnpm test`. Kiểm `TRANSITIONS`: `WAITING_HUMAN → READY` đã có (retry dùng); `READY → CLAIMED` qua `claim()`.

- [ ] **Step 7: Commit**

```bash
git add packages
git commit -m "feat: gate executor and harness stage submit; gate overdue events; status marks reuse and overdue

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `@harness/adapter-ffprobe` và checker media

**Files:**
- Create: `packages/adapters/ffprobe/{package.json,tsconfig.json,vitest.config.ts,src/index.ts,src/ffprobe-prober.ts,test/ffprobe-prober.test.ts}`, `packages/core/src/verification/media-checkers.ts`, `packages/core/test/verification/media-checkers.test.ts`, `tests/media.ts` (helper sinh file media bằng ffmpeg, dùng chung)
- Modify: `packages/core/src/index.ts`, `packages/cli/src/composition.ts`, `packages/cli/package.json`, `packages/cli/tsconfig.json`, `vitest.shared.ts`, `pnpm-workspace.yaml` (đã có `packages/adapters/*`)

**Interfaces:**
- `FfprobeMediaProber implements MediaProber`: `constructor(opts?: { ffprobe?: string; ffmpeg?: string })` (mặc định `process.env.FFPROBE_PATH ?? "ffprobe"`, `process.env.FFMPEG_PATH ?? "ffmpeg"`); `static isAvailable(opts?): boolean` (`spawnSync(ffprobe, ["-version"])` exit 0); `probe(path)` chạy `ffprobe -v error -print_format json -show_format -show_streams <path>` → `MediaProbe` (`mime_type` từ `format_name`: `mov,mp4,…` → `video/mp4`, `matroska` → `video/x-matroska`, `wav` → `audio/wav`, `mp3` → `audio/mpeg`, `png_pipe` → `image/png`, `image2`/`mjpeg` → `image/jpeg`, khác → `null`; `media` = `{ width, height, fps (parse `r_frame_rate` a/b), has_audio }` khi có stream video, ngược lại `null`; `duration_seconds` từ `format.duration`); lỗi spawn/parse → `null`. `silenceRatio(path)`: `ffmpeg -nostats -i <path> -af silencedetect=noise=-50dB:d=0.3 -f null -`, cộng `silence_duration:` trên stderr chia `duration_seconds`; không có audio → `null`.
- `mediaCheckers(prober: MediaProber): Checker[]` → 5 checker, version `1.0.0`. `BUILTIN_CHECKERS` giữ nguyên; composition ghép `new Verifier([...BUILTIN_CHECKERS, ...mediaCheckers(prober)])`.
- `tests/media.ts`:
  ```ts
  export function hasFfmpeg(): boolean
  export function makeVideo(path: string, o: { seconds: number; audio?: boolean; size?: string }): void   // ffmpeg -f lavfi testsrc(+sine) -> mp4 h264/aac
  export function makeWav(path: string, seconds: number, o?: { silent?: boolean }): void
  ```

Bảng checker (mọi checker `skip` với evidence `{ reason: "no matching output" }` khi không có output áp dụng — `skip` không làm `allRequiredPassed` đúng, vì vậy profile chỉ khai checker media cho stage thật sự có output tương ứng):

| check_id | Output áp dụng | fail khi |
|---|---|---|
| `media-probe` | mime (theo `expected_outputs` type→mime) bắt đầu `video/` hoặc `audio/`, kind file | `probe()` trả `null` hoặc không có stream video/audio |
| `duration-range` | mime `video/*`, kind file | `policy.target_duration_seconds` có và duration ngoài `[min, max]`; skip nếu policy không có |
| `audio-integrity` | mime `audio/*` hoặc `video/*`, kind file | không có stream audio; hoặc `policy.max_silence_ratio` có, prober có `silenceRatio` và ratio > ngưỡng |
| `clip-set-complete` | kind directory, type `clip_set` | không tìm được input type `edl`; thiếu file `<order padStart 3 "0">.mp4` cho một entry; hoặc `abs(duration - (out - in)) > 0.5` |
| `edl-valid` | type `edl` | `EdlSchema` sai; `source_id` không nằm trong `request.source_items` |

- [ ] **Step 1: Test thất bại**

`packages/adapters/ffprobe/test/ffprobe-prober.test.ts` (`describe.skipIf(!hasFfmpeg())`): sinh `clip.mp4` 2s có audio và `tone.wav` 1s, `silent.wav` 1s (`anullsrc`); kiểm `probe(clip)` → `{ container: "mov,mp4,m4a,3gp,3g2,mj2", mime_type: "video/mp4", duration_seconds ≈ 2 (±0.2), media: { width: 320, height: 180, has_audio: true }, video.codec: "h264", audio.channels ≥ 1 }`; `probe(tone.wav).media` null, `mime_type "audio/wav"`; `silenceRatio(silent.wav)` ≥ 0.9; `silenceRatio(tone.wav)` ≤ 0.1; `probe("/no/such")` → null; `isAvailable({ ffprobe: "no-such-binary" })` false.

`packages/core/test/verification/media-checkers.test.ts`: dùng một `MediaProber` **giả** (không cần ffmpeg) trả theo map path → probe; dựng `CheckerInput` với `expected_outputs`, `policy`, `source_items`, input `edl`:
- `media-probe` pass cho `output/full-episode.mp4` (probe có video), fail khi probe null;
- `duration-range` fail với duration 20 khi policy `[1, 10]`, skip khi không policy;
- `audio-integrity` fail khi `audio: null`; fail khi `silenceRatio` 0.95 > `max_silence_ratio` 0.5; pass ở 0.1;
- `clip-set-complete`: EDL 2 entry (`out - in` = 2 và 3), thư mục `output/cuts/000.mp4`, `001.mp4` với probe duration 2.0 và 3.4 → pass (lệch 0.4); đổi 3.6 → fail; xoá `001.mp4` → fail `missing`;
- `edl-valid`: pass với EDL đúng và `source_id` có trong `source_items`; fail khi `source_id` lạ; fail khi `in >= out`.

- [ ] **Step 2: Chạy, xác nhận fail.**

- [ ] **Step 3: Adapter** — `package.json` như `adapter-fake` (name `@harness/adapter-ffprobe`, deps `@harness/contracts`); tsconfig references `../../contracts`; `src/index.ts` export `FfprobeMediaProber`. Thêm alias vào `vitest.shared.ts`, dependency + reference vào `packages/cli`.

- [ ] **Step 4: `media-checkers.ts`** — khung:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EdlSchema, type Checker, type CheckerInput, type MediaProber, type StageOutput } from "@harness/contracts";

function mimeOf(input: CheckerInput, o: StageOutput): string { return input.request.expected_outputs.find((e) => e.type === o.type)?.mime_type ?? ""; }
const isAv = (m: string) => m.startsWith("video/") || m.startsWith("audio/");
const skip = (reason: string) => ({ verdict: "skip" as const, evidence: { reason } });

export function mediaCheckers(prober: MediaProber): Checker[] {
  const mediaProbe: Checker = { id: "media-probe", version: "1.0.0", async check(input) { … } };
  const durationRange: Checker = { id: "duration-range", version: "1.0.0", async check(input) { … } };
  const audioIntegrity: Checker = { id: "audio-integrity", version: "1.0.0", async check(input) { … } };
  const clipSetComplete: Checker = { id: "clip-set-complete", version: "1.0.0", async check(input) { … } };
  const edlValid: Checker = { id: "edl-valid", version: "1.0.0", async check(input) { … } };
  return [mediaProbe, durationRange, audioIntegrity, clipSetComplete, edlValid];
}
```

Mỗi checker duyệt `input.result.outputs` áp dụng, dừng ở fail đầu tiên với evidence `{ path, reason, … }`, pass với `{ checked: [paths] }`. `clip-set-complete` đọc EDL từ `input.request.inputs.find((i) => i.type === "edl")` → `join(workspaceDir, i.path)`.

- [ ] **Step 5: Composition** — `const prober = FfprobeMediaProber.isAvailable() ? new FfprobeMediaProber() : new NullMediaProber();` dùng cho `SourceCatalog` và `mediaCheckers`; `AppContext` thêm `proberAvailable: boolean` (doctor dùng). Ingest qua CLI trên máy có ffprobe nay ghi `duration_seconds`/`media` thật.

- [ ] **Step 6: Test pass** — `pnpm install && pnpm build && pnpm typecheck && pnpm test`; xác nhận `packages/core/test/source-catalog/catalog.test.ts` không đổi (vẫn `NullMediaProber`).

- [ ] **Step 7: Commit**

```bash
git add packages vitest.shared.ts pnpm-lock.yaml tests/media.ts
git commit -m "feat: ffprobe media prober adapter and media checkers (probe, duration, audio, clip set, edl)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Workflow `footage-production@1.0.0` và profile `footage`

**Files:**
- Create: `workflows/footage-production/workflow.yaml`, `production-profiles/footage/profile.yaml`
- Test: `packages/core/test/orchestration/footage-workflow.test.ts`

**Interfaces:**
- Consumes: `when`, `depends_on_optional`, `requires_resources`, `gate_deadline_seconds`, outputs `name`/`kind` (2A + Task 1), checker id của Task 7.
- Produces: workflow 10 stage đúng bảng spec §3; profile `footage` với `options_schema { voice: [none, tts, original], avatar: [none, heygen], subtitles: ["true","false"] }`, defaults `{ voice: none, avatar: none, subtitles: "false" }`.

- [ ] **Step 1: Test thất bại** — `footage-workflow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HARNESS_ROOT, loadHarnessConfig, loadProfile, loadWorkflow, Planner, resolveStageGraph } from "../../src/index.js";
import { openTempStore } from "../helpers.js";

describe("footage-production@1.0.0", () => {
  const wf = loadWorkflow(HARNESS_ROOT, "footage-production@1.0.0");
  const profile = loadProfile(HARNESS_ROOT, "footage");
  it("has the ten stages of the spec in topological order with gates where the LLM would be", () => {
    expect(wf.definition.stages.map((s) => `${s.key}:${s.executor.type}`)).toEqual(["index-source:script", "select-topic:gate", "write-script:gate", "edit-plan:gate", "tts:script", "avatar:script", "cut:script", "assemble:script", "thumbnail-render:script", "thumbnail-qc:gate"]);
    for (const s of wf.definition.stages) if (s.executor.type === "gate") for (const o of s.outputs) expect(o.name, `${s.key} output ${o.type}`).toBeTruthy();
    expect(profile.workflow_release).toBe("footage-production@1.0.0");
  });
  it("voice=original,avatar=none drops tts and avatar and rewires assemble to cut only", () => {
    const g = resolveStageGraph(wf.definition.stages, { voice: "original", avatar: "none", subtitles: "false" });
    expect(g.skipped.sort()).toEqual(["avatar", "tts"]);
    const assemble = g.kept.find((k) => k.def.key === "assemble")!;
    expect(assemble.depends_on).toEqual(["cut"]); expect(assemble.depends_on_optional).toEqual([]);
  });
  it("voice=tts,avatar=heygen keeps all ten and assemble waits for tts and avatar", () => {
    const { store } = openTempStore();
    const run = new Planner(store).plan({ workflow: wf, profile, harness: loadHarnessConfig(HARNESS_ROOT), projectId: "p", portfolioId: "pf" }); // defaults: none/none
    expect(store.listStageRuns(run.run_id)).toHaveLength(8);
    const g = resolveStageGraph(wf.definition.stages, { voice: "tts", avatar: "heygen", subtitles: "true" });
    expect(g.skipped).toEqual([]);
    const assemble = g.kept.find((k) => k.def.key === "assemble")!;
    expect(assemble.depends_on_optional.sort()).toEqual(["avatar", "tts"]);
    expect(g.kept.find((k) => k.def.key === "tts")!.def.requires_resources).toEqual(["gpu"]);
  });
});
```

- [ ] **Step 2: Chạy, xác nhận fail** (file workflow chưa có).

- [ ] **Step 3: `workflows/footage-production/workflow.yaml`**

```yaml
schema_version: harness.workflow/v1
id: footage-production
version: 1.0.0
defaults: {}
stages:
  - key: index-source
    executor: { type: script, script: index-source }
    requires_resources: [cpu]
    required_checks: [schema-valid, output-exists, checksum-match, media-probe]
    outputs:
      - { type: shots, mime_type: application/json, name: shots.json }
      - { type: proxy_video, mime_type: video/mp4, name: proxy.mp4 }
  - key: select-topic
    executor: { type: gate, brief: "Read shots.json and choose one topic for this episode. Write output/topic.md: title, angle, 3-5 key beats, which shots support each beat." }
    depends_on: [index-source]
    gate_deadline_seconds: 86400
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: topic, mime_type: text/markdown, name: topic.md }
  - key: write-script
    executor: { type: gate, brief: "From topic.md write the narration (output/narration.txt, plain text, one paragraph per beat) and the full script with on-screen notes (output/script.md)." }
    depends_on: [select-topic]
    gate_deadline_seconds: 86400
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: narration, mime_type: text/plain, name: narration.txt }
      - { type: script, mime_type: text/markdown, name: script.md }
  - key: edit-plan
    executor: { type: gate, brief: "Produce output/edl.json (schema harness.edl/v1): ordered entries { source_id, in, out, order, overlay, note } covering the narration, using only sources listed in stage-request.json." }
    depends_on: [write-script, index-source]
    gate_deadline_seconds: 86400
    required_checks: [schema-valid, output-exists, checksum-match, edl-valid]
    outputs:
      - { type: edl, mime_type: application/json, name: edl.json }
  - key: tts
    executor: { type: script, script: tts }
    depends_on: [write-script]
    when: options.voice == "tts"
    requires_resources: [gpu]
    required_checks: [schema-valid, output-exists, checksum-match, audio-integrity]
    outputs:
      - { type: voice_track, mime_type: audio/wav, name: narration.wav }
      - { type: captions, mime_type: application/json, name: captions.json }
  - key: avatar
    executor: { type: script, script: avatar }
    depends_on: [write-script, edit-plan]
    when: options.avatar == "heygen"
    requires_resources: [heygen]
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: avatar_clips, mime_type: application/x-directory, kind: directory, name: avatar-clips }
  - key: cut
    executor: { type: script, script: cut }
    depends_on: [edit-plan]
    requires_resources: [cpu]
    required_checks: [schema-valid, output-exists, checksum-match, clip-set-complete]
    outputs:
      - { type: clip_set, mime_type: application/x-directory, kind: directory, name: cuts }
  - key: assemble
    executor: { type: script, script: assemble }
    depends_on: [cut]
    depends_on_optional: [tts, avatar]
    requires_resources: [cpu]
    required_checks: [schema-valid, output-exists, checksum-match, media-probe, duration-range, audio-integrity]
    outputs:
      - { type: episode_video, mime_type: video/mp4, name: full-episode.mp4 }
  - key: thumbnail-render
    executor: { type: script, script: thumbnail-render }
    depends_on: [cut, write-script]
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: thumbnail, mime_type: image/png, name: thumbnail.png }
  - key: thumbnail-qc
    executor: { type: gate, brief: "Open thumbnail.png; write output/qc-checklist.json { readable: bool, on_brand: bool, notes: string }." }
    depends_on: [thumbnail-render]
    gate_deadline_seconds: 86400
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: qc_checklist, mime_type: application/json, name: qc-checklist.json }
```

- [ ] **Step 4: `production-profiles/footage/profile.yaml`**

```yaml
schema_version: harness.production-profile/v1
profile_id: footage
revision: 1
status: active
workflow_release: footage-production@1.0.0
overrides: {}
options_schema:
  voice: [none, tts, original]
  avatar: [none, heygen]
  subtitles: ["true", "false"]
options_defaults: { voice: none, avatar: none, subtitles: "false" }
reuse: allow
content:
  target_duration_seconds: [1, 900]
  max_silence_ratio: 0.9
verification:
  required_checks: []
  required_checks_by_stage: {}
limits:
  max_cost_usd_per_variant: 5
  max_concurrency: 2
```

(Checker theo stage đã khai trong workflow; profile để trống `required_checks_by_stage` để một profile khác có thể siết thêm.)

- [ ] **Step 5: Test pass** — `pnpm vitest run packages/core/test/orchestration/footage-workflow.test.ts && pnpm test`.

- [ ] **Step 6: Commit**

```bash
git add workflows production-profiles packages/core/test
git commit -m "feat: footage-production workflow and footage profile

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Fixture `ops-project-footage`, wrapper giả và test tích hợp trọn pipeline

**Files:**
- Create: `fixtures/ops-project-footage/{package.json,project.yaml,executors/scripts.yaml,source-catalog/sources.yaml,executors/wrappers/{index-source,tts,avatar,cut,assemble,thumbnail-render}.mjs}`, `tests/integration/footage-helpers.ts`, `tests/integration/footage-pipeline.test.ts`
- Modify: `pnpm-workspace.yaml` (thêm `fixtures/*`), `.gitignore` (đã ignore `fixtures/**/data/`)

**Interfaces:**
- Fixture là workspace package `ops-project-footage-fixture` (private) với dependency `@harness/script-sdk: workspace:*` → wrapper `import { start } from "@harness/script-sdk"` resolve qua `node_modules` của fixture sau `pnpm install`.
- Test **không copy** fixture: `freshFootageProject()` tạo temp dir với `project.yaml` (data_root = temp), `executors/scripts.yaml` chép từ fixture nhưng `cwd` = đường dẫn tuyệt đối của `fixtures/ops-project-footage` (wrapper chạy tại chỗ, resolve được sdk), `source-catalog/sources.yaml` trỏ tới video sinh trong temp.
- Env điều khiển wrapper giả: `FAKE_TTS_SLEEP_MS` (giữ GPU lâu), `FAKE_HEYGEN_LOSE=1` (mất kết nối sau intent), `HEYGEN_API_KEY` do executor bơm từ `secret://heygen/main`.

- [ ] **Step 1: Fixture**

`fixtures/ops-project-footage/package.json`:

```json
{ "name": "ops-project-footage-fixture", "private": true, "type": "module", "version": "0.0.0", "dependencies": { "@harness/script-sdk": "workspace:*" } }
```

`project.yaml`:

```yaml
schema_version: harness.project-config/v1
project_id: project-footage
template_release: 0.1.0
runtime: claude
data_root: ./data
portfolios:
  - { portfolio_id: portfolio-main, display_name: Footage portfolio }
resources: { cpu: 2, gpu: 1, heygen: 1 }
source: { materialize: link }
```

`executors/scripts.yaml`:

```yaml
schema_version: harness.scripts/v1
scripts:
  index-source:     { argv: [node, executors/wrappers/index-source.mjs], requires_resources: [cpu], timeout_seconds: 600 }
  tts:              { argv: [node, executors/wrappers/tts.mjs], requires_resources: [gpu], timeout_seconds: 600 }
  avatar:           { argv: [node, executors/wrappers/avatar.mjs], env_refs: { HEYGEN_API_KEY: "secret://heygen/main" }, requires_resources: [heygen], timeout_seconds: 600 }
  cut:              { argv: [node, executors/wrappers/cut.mjs], requires_resources: [cpu], timeout_seconds: 600 }
  assemble:         { argv: [node, executors/wrappers/assemble.mjs], requires_resources: [cpu], timeout_seconds: 600 }
  thumbnail-render: { argv: [node, executors/wrappers/thumbnail-render.mjs], timeout_seconds: 600 }
```

`source-catalog/sources.yaml`: `schema_version: harness.sources/v1` + `sources: [{ path: raw/sample-5s.mp4, collection: main, rights_status: cleared, language: vi }]` (file `raw/` git-ignored, test tự sinh).

- [ ] **Step 2: Wrapper giả** (mỗi file `.mjs`, dùng `spawnSync` gọi `ffmpeg`/`ffprobe` từ PATH hoặc `FFMPEG_PATH`/`FFPROBE_PATH`; helper chung `executors/wrappers/_media.mjs` với `ffmpeg(args)`, `probeDuration(path)`, `fileUrlToPath(uri)`):

`index-source.mjs`:

```js
import { start } from "@harness/script-sdk";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ffmpeg, fileUrlToPath, probeDuration } from "./_media.mjs";
const ctx = await start();
const src = ctx.source(0); const path = fileUrlToPath(src.uri);
const duration = src.duration_seconds ?? probeDuration(path);
writeFileSync(join(ctx.workspace, "output", "shots.json"), JSON.stringify({ source_id: src.source_id, duration_seconds: duration, shots: [{ in: 0, out: duration / 2 }, { in: duration / 2, out: duration }], transcript: null }, null, 2));
ffmpeg(["-y", "-i", path, "-vf", "scale=320:-2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", join(ctx.workspace, "output", "proxy.mp4")]);
await ctx.out.file("output/shots.json", { type: "shots" }); await ctx.out.file("output/proxy.mp4", { type: "proxy_video" });
ctx.log.info("indexed", { duration }); await ctx.done({ cost_usd: 0 });
```

`tts.mjs`: đọc `ctx.input("narration")`; nếu `!ctx.hasResource("gpu")` → `ctx.fail("contract", "tts needs the gpu slot")`; ngủ `FAKE_TTS_SLEEP_MS` (Atomics.wait); sinh `output/narration.wav` bằng `ffmpeg -f lavfi -i sine=frequency=440:duration=<max(1, words/3)>` và `output/captions.json` `[{ start, end, text }]` theo dòng; `out.file` ×2; `done({ cost_usd: 0.05 })`.

`avatar.mjs`:

```js
const ctx = await start();
const key = process.env.HEYGEN_API_KEY ?? "";
console.log(`avatar: using api key ${key}`);                     // cố ý: acceptance secret e2e chứng minh log bị che
ctx.log.info("calling heygen", { key });                          // cả JSON-line lẫn dòng thường
const intent = await ctx.op.intent({ provider: "heygen", kind: "render", target: ctx.request.stage_run_id, payload: { script: ctx.input("script") } });
if (intent.status === "CONFIRMED") { ctx.log.info("reusing confirmed render", { operation_id: intent.operation_id }); }
else if (process.env.FAKE_HEYGEN_LOSE === "1") { await ctx.op.lost(intent.operation_id, "socket closed after dispatch"); await ctx.unknown("heygen connection lost", [intent.operation_id]); process.exit(0); }
else { await ctx.op.confirm(intent.operation_id, { provider_ref: "fake-heygen-" + intent.operation_id.slice(-6), receipt: { rendered: true }, cost_usd: 0.5 }); }
mkdirSync(join(ctx.workspace, "output", "avatar-clips"), { recursive: true });
ffmpeg(["-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x180:rate=25", "-c:v", "libx264", "-preset", "ultrafast", join(ctx.workspace, "output", "avatar-clips", "000.mp4")]);
await ctx.out.dir("output/avatar-clips", { type: "avatar_clips" });
await ctx.done({ cost_usd: 0.5, external_operations: [intent.operation_id] });
```

`cut.mjs`: đọc EDL từ `ctx.input("edl")`; với mỗi entry: source = `ctx.sources.find(s => s.source_id === e.source_id)`; `ffmpeg -y -ss in -to out -i <src> -c:v libx264 -preset ultrafast -c:a aac output/cuts/<order padStart 3 "0">.mp4`; `out.dir("output/cuts", { type: "clip_set" })`; `done`.

`assemble.mjs`: liệt kê `output`... đúng hơn: input thư mục `clip_set` (`ctx.input("clip_set")` là thư mục), sort file, ghi `concat.txt`, `ffmpeg -f concat -safe 0 -i concat.txt`; nếu `ctx.hasInput("voice_track")` → thêm `-i narration.wav -map 0:v -map 1:a -shortest`; nếu `ctx.hasInput("avatar_clips")` → ghi chú vào log (giả không overlay); ra `output/full-episode.mp4`; `done`.

`thumbnail-render.mjs`: `ffmpeg -y -i <first cut> -frames:v 1 output/thumbnail.png`; `done`.

- [ ] **Step 3: `tests/integration/footage-helpers.ts`**

```ts
export const FIXTURE = join(HARNESS_ROOT, "fixtures", "ops-project-footage");
export function freshFootageProject(): { dir: string; source: string }   // temp dir: project.yaml (data_root temp/data), executors/scripts.yaml với cwd = FIXTURE, raw/sample-5s.mp4 (makeVideo 5s có audio), source-catalog/sources.yaml; chạy db migrate
export function cli(project: string, args: string[], env?: Record<string, string>): { code: number | null; out: string; err: string }   // như tests/acceptance/helpers.ts nhưng có HARNESS_SECRET_HEYGEN_MAIN mặc định "heygen-secret-KEY-42"
export function drain(project: string, env?: Record<string, string>, max = 30): string[]   // gọi worker --once tới khi "idle"; trả mảng kết quả
export function status(project: string, runId: string): StatusJson
export function stageId(project: string, runId: string, key: string): string
export function submitGate(project: string, runId: string, key: string, files: Record<string, string>): void   // ghi files vào <workspace>/output rồi `stage submit`, expect exit 0
export function planFootage(project: string, contentId: string, options: string[]): string   // plan --workflow footage-production@1.0.0 --profile footage --content … --option … ; enqueue; trả run_id
export const SAMPLE_EDL = (sourceId: string) => JSON.stringify({ schema_version: "harness.edl/v1", entries: [{ source_id: sourceId, in: 0, out: 2, order: 0 }, { source_id: sourceId, in: 2, out: 4.5, order: 1, overlay: "avatar" }] })
```

`submitGate` tìm workspace qua `status --json` → `stages[].attempts.at(-1).workspace_uri`.

- [ ] **Step 4: `tests/integration/footage-pipeline.test.ts`** (`describe.skipIf(!hasFfmpeg())`, timeout 300s):

```ts
describe.skipIf(!hasFfmpeg())("footage-production on the fixture ops project", () => {
  it("runs two variants to an ACCEPTED full-episode.mp4, gates through stage submit, gpu:1 serialises tts", async () => {
    const { dir, source } = freshFootageProject();
    expect(cli(dir, ["doctor"]).code).toBe(0);
    const ingest = JSON.parse(cli(dir, ["source", "ingest", source, "--rights", "cleared", "--json"]).out);
    const { content_id } = JSON.parse(cli(dir, ["content", "create", "--title", "Sample", "--source", ingest.source_id, "--json"]).out);
    const runA = planFootage(dir, content_id, ["voice=tts", "avatar=heygen"]);
    const runB = planFootage(dir, content_id, ["voice=original"]);
    // index-source → gates
    drain(dir);
    for (const run of [runA, runB]) {
      expect(status(dir, run).stages.find((s) => s.stage_key === "select-topic")?.state).toBe("WAITING_HUMAN");
      submitGate(dir, run, "select-topic", { "topic.md": "# Sample topic\n" });
      drain(dir);
      submitGate(dir, run, "write-script", { "narration.txt": "Line one.\nLine two.\nLine three.\n", "script.md": "# Script\n" });
      drain(dir);
      submitGate(dir, run, "edit-plan", { "edl.json": SAMPLE_EDL(ingest.source_id) });
    }
    drain(dir); // tts, avatar, cut, assemble, thumbnail-render run; thumbnail-qc parks at WAITING_HUMAN
    for (const run of [runA, runB]) {
      expect(status(dir, run).stages.find((s) => s.stage_key === "assemble")?.state).toBe("SUCCEEDED");
      submitGate(dir, run, "thumbnail-qc", { "qc-checklist.json": JSON.stringify({ readable: true, on_brand: true, notes: "" }) });
      drain(dir);
      const s = status(dir, run);
      expect(s.run.state).toBe("SUCCEEDED");
      const episode = s.artifacts.find((a) => a.type === "episode_video" && a.status === "ACCEPTED")!;
      expect(episode.lineage.source_items).toEqual([ingest.source_id]);
      for (const st of s.stages) expect(st.attempts.filter((a) => a.state === "SUCCEEDED"), st.stage_key).toHaveLength(1);
    }
    expect(status(dir, runB).stages.map((s) => s.stage_key)).not.toContain("tts");
    expect(status(dir, runA).stages.map((s) => s.stage_key)).toEqual(expect.arrayContaining(["tts", "avatar"]));
    expect(status(dir, runA).artifacts.some((a) => a.type === "avatar_clips" && a.status === "ACCEPTED")).toBe(true);
    // re-plan A: index-source comes from the cache, every gate runs again
    const runA2 = planFootage(dir, content_id, ["voice=tts", "avatar=heygen"]);
    drain(dir);
    const a2 = status(dir, runA2);
    expect(a2.stages.find((s) => s.stage_key === "index-source")).toMatchObject({ state: "SUCCEEDED", attempts: [] });
    expect(a2.stages.find((s) => s.stage_key === "select-topic")?.state).toBe("WAITING_HUMAN");
    expect(cli(dir, ["events", "tail", "--run", runA2, "--json", "--limit", "200"]).out).toContain("stage.reused");
  }, 300_000);

  it("gpu: 1 — two tts stages never overlap", async () => {
    // hai run cùng content, cả hai tới tts READY (submit gate cho cả hai), FAKE_TTS_SLEEP_MS=1500,
    // chạy 2 worker --once song song (cliAsync): đúng 1 "done" + 1 "idle"; sau đó `resources status --json` gpu.held 0; drain → cả hai tts SUCCEEDED
  }, 300_000);

  it("avatar that loses the connection lands in NEEDS_RECONCILIATION; reconcile then retry works with the journaled op", async () => {
    // FAKE_HEYGEN_LOSE=1 cho lượt worker chạy avatar → stage NEEDS_RECONCILIATION, op NEEDS_RECONCILIATION
    // `harness reconcile <run>` với FakeProvider → op FAILED, stage vẫn NEEDS_RECONCILIATION → `retry --stage avatar` → worker (không LOSE) → intent mới cùng key → CONFIRMED → SUCCEEDED
  }, 300_000);
});
```

Viết đầy đủ ba test (không để comment thay code); test 1 phải có phần "A2 re-run" kiểm `stage.reused` cho `index-source` và thumbnail-render/assemble chạy lại (gate mới → artifact mới → cache key khác).

- [ ] **Step 5: `pnpm install`** (link fixture) rồi `pnpm vitest run tests/integration`; sửa wrapper cho tới khi xanh. Kiểm thời gian chạy; nếu > 120s thì giảm `preset`/kích thước video.

- [ ] **Step 6: Commit**

```bash
git add fixtures pnpm-workspace.yaml pnpm-lock.yaml tests/integration
git commit -m "test: fixture ops project with fake wrappers over the script-sdk; footage pipeline integration

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: `harness source sync` và `harness doctor`

**Files:**
- Create: `packages/core/src/source-catalog/sources-file.ts`, `packages/core/src/doctor/doctor.ts`, `packages/cli/src/commands/doctor.ts`
- Modify: `packages/core/src/index.ts`, `packages/contracts/src/interfaces.ts` (`StateStore.listAppliedMigrations(): string[]`), `packages/core/src/state/sqlite-store.ts` (`SELECT name FROM schema_migrations ORDER BY name`), `packages/cli/src/commands/source.ts`, `packages/cli/src/main.ts`, `packages/cli/src/composition.ts`
- Test: `packages/core/test/source-catalog/sources-file.test.ts`, `packages/core/test/doctor/doctor.test.ts`, `packages/cli/test/cli.test.ts`

**Interfaces:**
```ts
// sources-file.ts
export const SOURCES_FILE = join("source-catalog", "sources.yaml");
export function loadSourcesRegistry(projectDir: string): SourcesRegistry | undefined
export interface SyncReport { added: { source_id: string; path: string }[]; already: { source_id: string; path: string }[]; missing_files: string[]; unregistered: { source_id: string; uri: string }[] }
export async function syncSources(p: { catalog: SourceCatalog; store: StateStore; projectDir: string; registry: SourcesRegistry }): Promise<SyncReport>
// doctor.ts
export interface DoctorRow { check: string; ok: boolean; detail: string }
export interface DoctorInput { projectDir: string; project: ProjectConfig; harness: HarnessConfig; scripts: ScriptsRegistry | undefined; builtinScripts: string[]; workflows: { ref: string; loaded: LoadedWorkflow }[]; profiles: ProductionProfile[]; secrets: SecretResolver; proberAvailable: boolean; store: StateStore; migrationsDir: string }
// `builtinScripts` = tên lệnh do composition root cung cấp sẵn (fakeScriptCommands) — script không có trong scripts.yaml nhưng có ở đây là hợp lệ (row ok, detail "provided by built-in commands"), không kiểm wrapper/secret.
export function runDoctor(i: DoctorInput): DoctorRow[]
```
Doctor kiểm (mỗi dòng một `check`):
1. `migrations`: mọi file `.sql` trong `migrationsDir` có trong `schema_migrations` (`store.migrate` không được gọi; đọc qua `store.db` thì core biết SqliteStateStore… dùng `store.listAppliedMigrations()` — thêm method này vào `StateStore` + sqlite-store).
2. `ffprobe`: `proberAvailable`.
3. `resources`: tên trong `project.resources` hợp lệ (schema đã ép) — ok luôn; ghi detail liệt kê.
4. Với mỗi workflow và mỗi stage `script`: `scripts.<name>` tồn tại (`script:<wf>/<stage>`), file `argv[1]` (nếu kết thúc `.mjs|.js|.cjs|.ts|.py|.sh`) tồn tại tại `resolve(projectDir, cwd, argv[1])`, mọi `env_refs` resolve được (`secrets.resolve` trong try/catch; detail chỉ ghi tên env + ref, **không** ghi giá trị), `requires_resources` (scripts.yaml nếu có, ngược lại workflow) đều khai trong `project.resources` với capacity > 0.
5. Với mỗi stage `gate`: mọi `outputs[]` có `name`.
6. Với mỗi profile: `workflow_release` nạp được; mọi `when` trong workflow đó tham chiếu key có trong `options_schema`; `options_defaults` là giá trị hợp lệ của `options_schema`.
7. `sources.yaml`: parse được (nếu có) và mọi `path` tồn tại.

CLI: `harness doctor [--json]` in bảng `ok`/`FAIL` + detail, exit 1 nếu có FAIL. `harness source sync [--json]`: in `added/already/missing/unregistered`, exit 1 nếu `missing_files` khác rỗng.

- [ ] **Step 1: Test thất bại**

`sources-file.test.ts`: temp project với `source-catalog/sources.yaml` 2 entry (một file có, một file không); DB đã có 1 source khác (ingest tay) → `syncSources` trả `added` 1, `missing_files` 1, `unregistered` 1; gọi lại → `already` 1.

`doctor.test.ts`: `DoctorInput` với `scripts` thiếu `tts`, wrapper `cut` không tồn tại, `env_refs` không resolve, `requires_resources: [gpu]` khi project `resources: { cpu: 1 }`, profile `options_defaults: { voice: "loud" }`, gate output không `name` → mỗi lỗi một dòng `ok: false` với `check` tương ứng (`script:footage-production/tts`, `wrapper:cut`, `secret:avatar:HEYGEN_API_KEY`, `resource:tts:gpu`, `profile:footage:options_defaults`, `gate-output:select-topic`); input sạch → mọi dòng `ok: true`.

`cli.test.ts`: `harness doctor` trên `fixtures/ops-project-minimal` (không có scripts.yaml) exit 0 khi có ffprobe; với `HARNESS_SECRET_…` thiếu trên fixture footage helper → exit 1 và stderr/out có `secret:avatar:HEYGEN_API_KEY` nhưng không có giá trị nào.

- [ ] **Step 2: Chạy, xác nhận fail.**

- [ ] **Step 3: Triển khai** — `syncSources`: với mỗi entry `resolve(projectDir, path)`; không tồn tại → `missing_files`; `sha256File` → `store.findSourceItemByChecksum` → `already` hoặc `catalog.ingest({ path, collection, rights_status, language })` → `added`; `unregistered` = `store.listSourceItems()` có checksum không nằm trong tập checksum của yaml. `runDoctor` theo danh sách 1–7. `composition.ts`: `AppContext` thêm `sources: SourcesRegistry | undefined`.

- [ ] **Step 4: Test pass** — `pnpm build && pnpm typecheck && pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(cli): source sync against sources.yaml and harness doctor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Ngân sách variant — `run.budget_exceeded` và `retry --raise-budget`

**Files:**
- Create: `packages/core/src/orchestration/budget.ts`
- Modify: `packages/core/src/orchestration/planner.ts`, `packages/core/src/index.ts`, `packages/cli/src/commands/retry.ts`
- Test: `packages/core/test/orchestration/budget.test.ts`, `packages/cli/test/cli.test.ts`

**Interfaces:**
```ts
export function variantSpent(store: StateStore, run: Run): number        // tổng total_cost_usd của mọi run cùng variant_id (kể cả run này); run không có variant → chính nó
export function budgetBlocks(store: StateStore, run: Run): { blocked: boolean; spent: number; budget: number | null }
export function raiseBudget(store: StateStore, planner: Planner, runId: string, budgetUsd: number): Run   // set budget_usd (phải > spent), event run.budget_raised, rồi planner.advance
```
Planner `advance()`: tính `budgetBlocks` trước vòng release; nếu `blocked` → không `ready()` stage nào; nếu run `RUNNING`, không stage active, có stage PENDING → `RUNNING → WAITING` với event `run.budget_exceeded` (payload `{ spent, budget }`) và **không** đánh giá các nhánh khác. `enqueue()` cũng qua `budgetBlocks` (variant đã cạn từ run trước → run mới `READY` rồi `WAITING` ngay: `READY → RUNNING → WAITING`). `retry [--raise-budget <usd>]`: nếu có flag → `raiseBudget` (kể cả không có stage FAILED/WAITING_HUMAN), in `budget ${old} -> ${new}`, rồi in phần retry như cũ.

- [ ] **Step 1: Test thất bại** — `budget.test.ts`: dùng `openTempStore`, planner với workflow `sample-three-stage`, profile inline `limits.max_cost_usd_per_variant: 0.03` và content/variant qua `SourceCatalog` (materialize `reference`, file tạm); commit `produce` với `usage.cost_usd: 0.05` qua `Controller.commit` (như `controller.test.ts`) → `review` vẫn `PENDING`, run `WAITING`, event `run.budget_exceeded` `{ spent: 0.05, budget: 0.03 }`; `raiseBudget(…, 1)` → `review` `READY`, run `RUNNING`, event `run.budget_raised`; `raiseBudget(…, 0.04)` khi spent 0.05 → `CONFIG_INVALID`. Test thứ hai: run thứ hai cùng variant với budget 0.03 khi variant đã tiêu 0.05 → sau `enqueue` run ở `WAITING` với `run.budget_exceeded`, không stage nào READY.

`cli.test.ts`: `retry <run> --raise-budget 10` trên run `WAITING` vì budget → stdout chứa `budget` và stage kế `READY`.

- [ ] **Step 2: Chạy, xác nhận fail.**

- [ ] **Step 3: Triển khai** theo Interfaces. Trong `advance()`:

```ts
      const gate = budgetBlocks(this.store, run);
      for (const s of stages) {
        if (s.state !== "PENDING" || gate.blocked) continue;
        …
      }
      …
      const anyPending = fresh.some((s) => s.state === "PENDING");
      if (gate.blocked && current.state === "RUNNING" && !anyActive && anyPending) { this.store.transition("run", runId, "RUNNING", "WAITING", eventFor(run, null, null, "run.budget_exceeded", "warn", { spent: gate.spent, budget: gate.budget })); }
      else if (…các nhánh cũ…)
```

Trong `enqueue()` sau khi release root: nếu `gate.blocked` và run vẫn `READY` với stage PENDING và không stage READY → `READY → RUNNING` (`run.started`, reason `budget_check`) rồi `RUNNING → WAITING` (`run.budget_exceeded`).

- [ ] **Step 4: Test pass** — `pnpm build && pnpm typecheck && pnpm test` (worker/cli test cũ có cost 0.01–0.04 với budget 5 nên không đổi).

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(core): variant budget gate in the planner; retry --raise-budget

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Acceptance 6, 7, 9, 12 và secret e2e

**Files:**
- Create: `tests/acceptance/06-stale-scope.test.ts`, `tests/acceptance/07-thumbnail-does-not-rerender.test.ts`, `tests/acceptance/09-budget-waits.test.ts`, `tests/acceptance/12-old-run-explainable.test.ts`, `tests/acceptance/16-secret-e2e.test.ts`
- Modify: `tests/acceptance/11-secret-never-leaks.test.ts` (cập nhật SCOPE NOTE: e2e nay ở #16)

Mọi test footage dùng `tests/integration/footage-helpers.ts` và `describe.skipIf(!hasFfmpeg())`; test 9 và 12 chạy được trên `ops-project-minimal` không cần ffmpeg.

- [ ] **Step 1: #6 — "Thay script làm downstream artifact đúng phạm vi thành STALE"**
  Invalidation chỉ áp lên run **khác** của cùng variant (ADR §25), nên kịch bản dùng hai run. Run A (`voice=tts`, `avatar=none`) chạy tới `SUCCEEDED` (submit 4 gate). Plan A2 cùng variant → `index-source` reused; drain tới `select-topic` WAITING_HUMAN; submit `topic.md` **giống hệt** A. Ngay sau commit đó kiểm `status <A> --json`: artifact của `index-source` (A) vẫn `ACCEPTED`; artifact của `select-topic` và mọi dependant bắc cầu (`write-script`, `edit-plan`, `tts`, `cut`, `assemble`, `thumbnail-render`, `thumbnail-qc`) đều `STALE`; `events tail --run <A2>` có `stage.invalidated_downstream` với `stale` gồm đúng 8 artifact đó. Tiếp tục A2: submit `write-script` với narration **khác** → `stage.invalidated_downstream` của lần này có `stale: []` (A đã STALE từ trước, không lặp). Assert thêm: `index-source` của A2 có `reused_artifact_ids` = artifact `index-source` của A và `attempts: []`.
- [ ] **Step 2: #7 — "Thay thumbnail không render lại video"**
  Run A `voice=original` tới `SUCCEEDED`. `harness retry <A> --stage thumbnail-qc` → gate về READY → worker tạo attempt gate mới → submit qc-checklist khác → `thumbnail-qc` SUCCEEDED lần 2. Kiểm: `assemble`, `cut`, `thumbnail-render` mỗi stage vẫn đúng 1 attempt; artifact `episode_video` của A vẫn `ACCEPTED` cùng id; `status --json` không có stage nào ngoài `thumbnail-qc` có `attempt_count` 2. Thêm nhánh: plan A2 cùng variant → `index-source`, `cut`, `assemble`, `thumbnail-render` đều `reused` (không attempt), chỉ 4 gate chạy lại.
- [ ] **Step 3: #9 — "Vượt daily budget chuyển job sang trạng thái chờ"**
  Trên `ops-project-minimal`: `plan --workflow sample-three-stage@1.0.0 --profile cartoon --content <c> --override default_max_cost_usd=…` không đủ (budget là của profile). Dùng profile inline không được qua CLI → tạo profile test `production-profiles/cartoon-tight/`? Không thêm profile giả vào harness. Thay vào đó test #9 dùng `SqliteStateStore` trực tiếp: sau `plan --content` (variant), `updateRun({ ...run, budget_usd: 0.015 })`; `enqueue`; worker `--once` ×2: `produce` (0.01) xong → `review` READY (spent 0.01 < 0.015) → review (0.02) xong → spent 0.03 ≥ 0.015 → `finalize` PENDING, run `WAITING`, event `run.budget_exceeded`; `retry <run> --raise-budget 1` → `finalize` READY → worker → run `SUCCEEDED`.
- [ ] **Step 4: #12 — "Run cũ vẫn giải thích được sau khi profile nâng revision"**
  Không sửa file profile trong repo. Test dùng API core trực tiếp (như `packages/worker/test/worker.test.ts` `makeWorld`, nhưng đặt trong `tests/acceptance` với world tự dựng): `profile1 = loadProfile(HARNESS_ROOT, "cartoon")`, `profile2 = { ...profile1, revision: 2, overrides: { lease_seconds: 150 } }`; catalog tạo content (file tạm, `materialize: "reference"`); `variant1 = getOrCreateVariant(content, profile1)`, plan + drain run 1 → `SUCCEEDED`; `variant2 = getOrCreateVariant(content, profile2)` (id khác), plan + drain run 2. Assert: run 1 vẫn đọc được `profile_snapshot { id: "cartoon", revision: 1 }`, `effective_config_snapshot.lease_seconds` 120 (giá trị lúc plan), artifact của run 1 có `reproducibility.production_profile === "cartoon@1"` và manifest trên đĩa nói cùng điều đó; `store.listEvents({ run_id: run1 })` có `run.created` với `options`; run 2 `profile_snapshot.revision === 2`, không có `stage.reused` (variant khác), artifact `cartoon@2`; artifact run 1 vẫn `ACCEPTED` (invalidation không vượt variant).
- [ ] **Step 5: #16 — secret e2e**
  Fixture footage với env `HARNESS_SECRET_HEYGEN_MAIN = "heygen-secret-KEY-42"`, `HARNESS_LOG_LEVEL=debug`: chạy tới `avatar` (variant `avatar=heygen`, `voice=none`); gom stdout+stderr của mọi `worker --once`, `status --json`, `events tail --json --limit 1000`, nội dung `logs/script-stderr.log` không cần (stderr của wrapper không in key) và `stage-result.json`/`stage-request.json` của workspace avatar, `manifest.json` của artifact avatar: **không** chứa `heygen-secret-KEY-42`; stdout worker **có** chứa `[REDACTED]` (chứng minh dòng log đã đi qua Redactor thay vì bị nuốt). `project.yaml`/`scripts.yaml` chỉ chứa `secret://heygen/main`.
- [ ] **Step 6: Chạy** `pnpm vitest run tests` xanh; cập nhật SCOPE NOTE của #11.
- [ ] **Step 7: Commit**

```bash
git add tests
git commit -m "test(acceptance): stale scope (#6), thumbnail re-run (#7), budget wait (#9), old run explainable (#12), secret e2e (#16)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Tài liệu, project-template và báo cáo 2B

**Files:**
- Create: `docs/runbooks/wrap-a-channel.md`, `project-template/executors/scripts.yaml`, `project-template/executors/wrappers/example.mjs`, `project-template/source-catalog/sources.yaml`, `project-template/package.json`
- Modify: `AGENTS.md`, `README.md`, `docs/adr/0001-control-plane-baseline.md` (mục 29+), `docs/operations/deferred-items.md`, `docs/runbooks/reconcile-and-retry.md`, `packages/script-sdk/README.md` (nếu Task 3 chưa đủ)

- [ ] **Step 1: `docs/runbooks/wrap-a-channel.md`** — các bước nối một repo kênh thật (ví dụ minh hoạ bằng inventory ổ D:, không bắt buộc): (1) copy `project-template/` → ops project, `pnpm install` (kéo `@harness/script-sdk`); (2) `project.yaml`: `resources` theo máy, `source.materialize`; (3) `sources.yaml` → `harness source sync`; (4) mỗi stage script một wrapper: đọc input qua `ctx.input`, gọi script cũ của kênh bằng `spawnSync` với đường dẫn riêng của máy (đặt trong `cwd` của scripts.yaml hoặc env), copy/ghi kết quả vào `output/`, `ctx.out.*`, `ctx.done`; (5) secret: `env_refs` + `HARNESS_SECRET_<SCOPE>_<NAME>` trong shell/`.env` của máy (không commit); (6) external effect có phí: `ctx.op.intent` trước khi gọi API, `confirm` sau, `lost` khi mất kết nối; (7) `harness doctor` xanh; (8) chạy thử một content với `voice=original`, các gate qua `stage submit` (người hoặc phiên Claude/Codex làm việc trong workspace, `brief.md` là đề bài); (9) xử lý sự cố: bảng lỗi → lệnh (tham chiếu runbook reconcile-and-retry).
- [ ] **Step 2: `project-template`** — `executors/scripts.yaml` mẫu (6 script như fixture nhưng argv trỏ `executors/wrappers/<name>.mjs`, có comment), `wrappers/example.mjs` (wrapper 20 dòng dùng sdk gọi `node path/to/legacy.mjs`), `source-catalog/sources.yaml` rỗng, `package.json` với dependency `@harness/script-sdk`.
- [ ] **Step 3: Tài liệu khác** — `AGENTS.md`: mục "Lệnh 2B" (`stage submit`, `op …`, `doctor`, `source sync`, `retry --raise-budget`), quy tắc wrapper/scripts.yaml/secret env, quy tắc gate. `README.md`: quick-start footage trên fixture (doctor → ingest → content → plan hai variant → worker → stage submit → status), trạng thái mới. ADR mục 29+: scripts.yaml khoá theo tên script; secret vào env con + Redactor; stdout JSON-line; gate = deferred + `stage submit` với attempt `cli-submit`; `HARNESS_CLI_ARGV` và `op` qua CLI con; `EdlSchema` bọc trong object có `schema_version`; checker media theo mime của `expected_outputs`, ngưỡng qua `StageRequest.policy`; budget theo variant (tổng mọi run) gate trong `advance`; `claim({ stageRunId })`; ffprobe là phụ thuộc hệ thống, fallback `NullMediaProber`. `deferred-items.md`: gạch ★ secret e2e, mime worker, external op qua script, overlap `.`/`..`, status reuse; thêm mục mới phát sinh. Runbook reconcile: mục "Gate quá hạn", "Submit bị từ chối", "Op từ wrapper".
- [ ] **Step 4:** `pnpm build && pnpm typecheck && pnpm test` xanh; chạy tay README quick-start trên fixture footage; dọn `fixtures/**/data/` và `fixtures/ops-project-footage/raw/`.
- [ ] **Step 5: Commit**

```bash
git add AGENTS.md README.md docs project-template
git commit -m "docs: wrap-a-channel runbook, project template with scripts.yaml and wrapper, ADR and deferred items for 2B

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 6:** Báo cáo trong chat: file đã tạo/sửa, số test, DoD spec §8 từng mục đạt/chưa, điều gì để lại cho sub-project 3 (adapter HeyGen/TTS/YouTube thật, reconcile provider thật) và 4 (agent runtime thay gate).

---

## Tự rà soát plan 2B

**Phủ spec (phần thuộc 2B):**
- 1.1 `script-sdk` → Task 3; `gate-executor`, `script-executor` registry → Task 4, 6; `adapter-ffprobe`, `checkers/` → Task 7; workflow + profile → Task 8; `project-template` → Task 13; fixture → Task 9; runbook → Task 13.
- 1.4 CLI: `source sync`, `doctor` → Task 10; `stage submit` → Task 6; `op …` → Task 5; `retry --raise-budget` → Task 11.
- 3 workflow, `EdlSchema`, `edl-valid` → Task 1, 7, 8. 4.1 scripts.yaml (`cwd`, `env_refs`, `requires_resources` ghi đè, `timeout_seconds`, doctor) → Task 4, 10. 4.2 request mở rộng (`expected_outputs`, `policy`; `options/source_items/resources` đã có từ 2A) → Task 1, 2. 4.3 sdk API (`start`, `input`, `source`, `out.file/dir/clear`, `heartbeat`, `log`, `done`, `fail`, `op.*`) → Task 3, 5. 4.4 gate + submit + `gate_deadline_seconds` → Task 6. 5 checker media → Task 7. 6 xử lý lỗi: source hỏng → checker/probe fail (contract qua `SECRET_UNRESOLVED`/`STALE_STATE` đã có); wrapper chết → lease (đã có); op mất kết nối → Task 5 + test Task 9; gate quá hạn → Task 6; submit thiếu → Task 6; budget → Task 11. 7 kiểm thử → Task 9, 12. 8 DoD → Task 9 (hai variant, gate, gpu:1), Task 12 (acceptance), Task 10 (doctor xanh), Task 3/13 (README, runbook).
- Ngoài phạm vi giữ nguyên (§9): không adapter thật, không agent runtime, không fair-queue.

**Nhất quán kiểu:** `ScriptCommand` (contracts) dùng ở Task 4 và `fakeScriptCommands()`; `buildStageRequest`/`mimeTypesFor`/`stageDefinitionFor` (Task 2) dùng ở worker và `submitGate` (Task 6); `GateDeps.profiles` cùng chữ ký với `WorkerDeps.profiles` và `AppContext.profiles`; `SubmitReport` dùng ở CLI Task 6; `budgetBlocks` dùng trong `enqueue`/`advance` Task 11; env `HARNESS_*` liệt kê ở Task 3 được executor Task 4 đặt đủ; `directoryListing` (sdk) và `directoryDigest` (core) được cross-check ở Task 3.

**Điểm cần chú ý khi thực thi:**
- Task 1 đổi `ClaimParams`/`MediaProber` interface → `pnpm typecheck` đỏ tới khi Task 2/7 implement; test (`vitest`) vẫn chạy được.
- `fakeScriptCommands()` đổi shape ở Task 4 → mọi test `new ScriptExecutor(fakeScriptCommands())` không cần sửa; test có `{ "bad-json": [argv] }` phải đổi thành `{ "bad-json": { argv: [...] } }`.
- Task 9 cần `pnpm install` sau khi thêm fixture vào workspace; nếu junction `node_modules` trong fixture gây lỗi trên Windows, thay import trong wrapper bằng `import { start } from "@harness/script-sdk"` **giữ nguyên** và đặt `NODE_PATH` không có tác dụng với ESM — phương án dự phòng là executor set `NODE_OPTIONS=--import <file URL của một shim đăng ký module.register hook>`; ghi ledger nếu phải dùng.
- Acceptance #12 dùng API core với profile object revision 2, không đụng file trong repo.
- Task 10 thêm `listAppliedMigrations(): string[]` vào `StateStore` (contracts) và `SqliteStateStore`; doctor so với danh sách `.sql` trong `migrationsDir`.
