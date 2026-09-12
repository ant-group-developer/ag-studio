# Sub-project 2A: Catalog, planner mở rộng, tài nguyên, artifact thư mục, invalidation và cache — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nền tảng của sub-project 2: dọn các mục ★ để lại, source catalog (source → content → variant có `options`), planner hiểu `when`/dependency mềm/tái sử dụng cache, `claim()` tôn trọng capacity tài nguyên, artifact thư mục, invalidation STALE theo graph, và CLI tương ứng. Plan 2B (script-sdk, scripts.yaml, gate executor, ffprobe/checker media, workflow footage, fixture, acceptance) viết sau khi 2A xong.

**Architecture:** Mọi thay đổi nằm trong các package đã có (`contracts`, `core`, `worker`, `cli`); không tạo package mới. Bảng mới `source_item`, `content_item`, `content_variant` theo mẫu document; `lease` thêm cột `resources`. Planner đánh giá `when` lúc plan, bỏ hẳn stage không cần và nối xuyên dependency. Cache: controller ghi `cache_key` lúc commit; planner tái sử dụng artifact ACCEPTED của run trước cùng variant khi `cache_key` khớp. Invalidation: sau khi một stage ACCEPTED artifact mới, mọi artifact ACCEPTED của stage phụ thuộc bắc cầu trong run trước của cùng variant thành STALE.

**Tech Stack:** như sub-project 1 (TypeScript strict ESM, pnpm 12, Zod, `node:sqlite`, Vitest). Không thêm dependency npm.

Spec: `docs/superpowers/specs/2026-09-12-sub-project-2-footage-production-design.md` (mục 1.3, 1.4, 2, 3.1–3.3, 4.5, 6 phần tài nguyên/cost, 8 mục ★).

## Global Constraints

- Node `>=22.13`, `"type": "module"`, TypeScript strict, NodeNext, import nội bộ có đuôi `.js`. Dependency rule: `contracts` không phụ thuộc ai; `core` chỉ phụ thuộc `contracts`; `core` không import adapter.
- Chỉ `transition()` và `claim()` trong `packages/core/src/state/sqlite-store.ts` được `UPDATE` cột `state`. Mọi cạnh transition phải có trong `TRANSITIONS`.
- Mọi schema object `.strict()`; entity miền và contract có `schema_version` `harness.<tên>/v1`; `Lease` được miễn. Sau khi đổi schema phải chạy `pnpm gen:schemas` và commit JSON (drift test).
- ID `<prefix>_<ULID>`; checksum `sha256:<hex>`; timestamp ISO UTC `Z`; `options_digest` = `canonicalDigest(options)`.
- Test xác định, không mạng, không LLM, temp dir dưới `os.tmpdir()`; mọi `vitest.config.ts` dùng `sharedConfig()` từ `vitest.shared.ts`; `pnpm build` trước `pnpm typecheck`.
- Tên tài nguyên `^[a-z][a-z0-9-]*$`; capacity là số nguyên ≥ 0; tài nguyên không khai báo = capacity 0.
- `when` chỉ có dạng `options.<key> == "<value>"` hoặc `options.<key> != "<value>"`.
- Commit message Conventional Commits, kết thúc bằng `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (không thay bằng tên model khác).

---

## Cấu trúc file

```text
migrations/0002_catalog_resources.sql
packages/contracts/src/
  entities.ts                 SourceItem/ContentVariant/StageRun/Lease/executorRef mở rộng
  config.ts                   stageDefinition (when, depends_on_optional, requires_resources, gate_deadline_seconds, outputs[].kind),
                              ProductionProfile (options_schema, options_defaults, reuse, required_checks_by_stage, content.target_duration_seconds),
                              ProjectConfig (resources, source.materialize), HarnessConfig (resource_wait_warn_seconds)
  execution.ts                StageInput/StageOutput.kind, StageRequest.options/source_items/resources
  interfaces.ts               MediaProber, MediaInfo; StateStore thêm catalog + countLeasedResources + listRuns filter; ClaimParams.resourceCapacity; ReapedLease.run_id
packages/core/src/
  config/resolve.ts           kiểm lease_seconds > heartbeat_seconds
  state/sqlite-store.ts       bảng catalog, lease.resources, claim theo capacity, listRuns theo variant, reap trả run_id
  source-catalog/when.ts      parseWhen(), evaluateWhen()
  source-catalog/catalog.ts   SourceCatalog: ingest, verify, createContent, getOrCreateVariant
  source-catalog/prober.ts    NullMediaProber
  orchestration/planner.ts    plan theo content/variant, when + nối xuyên, depends_on_optional, reuse cache
  orchestration/controller.ts ghi cache_key khi commit, gọi invalidateDownstream
  orchestration/invalidation.ts  dependantsOf(), invalidateDownstream()
  orchestration/cache.ts      stageDefinitionDigest(), computeCacheKey(), findReusableArtifacts()
  artifacts/registry.ts       output kind directory (manifest liệt kê file), acceptedInputsFor tôn trọng reused_artifact_ids
  artifacts/sweep.ts          sweepOrphanArtifacts()
  environment/workspace.ts    materializeInputs cho directory
  verification/checkers.ts    output-exists/checksum-match cho directory
packages/worker/src/worker.ts advance sau reap; request.options/source_items/resources
packages/cli/src/commands/
  retry.ts                    từ chối CANCEL_REQUESTED
  source.ts, content.ts       ingest/list/verify/sync, create
  plan.ts                     --content --option
  resources.ts                status
  artifacts.ts                sweep
packages/cli/src/composition.ts  resourceCapacity từ project.yaml, SourceCatalog
```

---

### Task 1: Mục ★ để lại: validation lease/heartbeat, `retry` từ chối CANCEL_REQUESTED, worker gọi `advance` sau reap

**Files:**
- Modify: `packages/core/src/config/resolve.ts`, `packages/contracts/src/interfaces.ts` (ReapedLease), `packages/core/src/state/sqlite-store.ts` (reapExpiredLeases), `packages/worker/src/worker.ts`, `packages/cli/src/commands/retry.ts`
- Test: `packages/core/test/config/resolve.test.ts`, `packages/worker/test/worker.test.ts`, `packages/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: `resolveEffectiveConfig`, `Planner.cancel/advance`, `store.claim`, `store.reapExpiredLeases`.
- Produces: `ReapedLease` có thêm `run_id: string`; `resolveEffectiveConfig` ném `CONFIG_INVALID` khi `lease_seconds <= heartbeat_seconds`; `harness retry` exit 1 với `INVALID_TRANSITION` cho run `CANCEL_REQUESTED`; `Worker.runOnce` gọi `planner.advance(run_id)` cho mọi run có lease bị reap.

- [ ] **Step 1: Viết test thất bại**

Thêm vào `packages/core/test/config/resolve.test.ts` trong `describe("resolveEffectiveConfig")`:

```ts
  it("rejects a lease shorter than or equal to the heartbeat interval", () => {
    try { resolveEffectiveConfig({ harness, workflowDefaults: {}, profileOverrides: { lease_seconds: 30 }, channelOverrides: {}, runOverrides: {}, profileMaxCostUsd: 5 }); throw new Error("no throw"); }
    catch (e) { expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true); expect((e as Error).message).toContain("heartbeat_seconds"); }
    expect(resolveEffectiveConfig({ harness, workflowDefaults: {}, profileOverrides: { lease_seconds: 31 }, channelOverrides: {}, runOverrides: {}, profileMaxCostUsd: 5 }).snapshot.lease_seconds).toBe(31);
  });
```

Thêm vào `packages/worker/test/worker.test.ts` trong `describe("Worker")` (dùng `makeWorld`, `planAndEnqueue` có sẵn trong file):

```ts
  it("settles a cancelled run after reaping the lease of its last cancel-requested stage", async () => {
    const w = makeWorld();
    const run = planAndEnqueue(w);
    const claim = w.store.claim({ owner: "dead", capabilities: ["write_workspace"], now: w.clock.now(), leaseSeconds: 90 })!;
    const ev = { run_id: run.run_id, stage_run_id: claim.stageRun.stage_run_id, attempt_id: claim.attempt.attempt_id, project_id: "project-main", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info" as const, event_type: "stage.test", payload: {} };
    w.store.transaction(() => {
      w.store.transition("attempt", claim.attempt.attempt_id, "CLAIMED", "RUNNING", ev);
      w.store.transition("stage_run", claim.stageRun.stage_run_id, "CLAIMED", "RUNNING", ev);
    });
    w.planner.cancel(run.run_id);
    expect(w.store.getRun(run.run_id)?.state).toBe("CANCEL_REQUESTED");
    w.clock.advance(121);
    expect(await w.worker.runOnce()).toBe("idle");
    expect(w.store.getStageRun(claim.stageRun.stage_run_id)?.state).toBe("CANCELLED");
    expect(w.store.getRun(run.run_id)?.state).toBe("CANCELLED");
  });
```

Thêm vào `packages/cli/test/cli.test.ts` trong `describe("harness CLI")` (file đã import `SqliteStateStore` và `join`):

```ts
  it("retry refuses a run whose cancel is still pending", () => {
    const p = freshProject();
    const plan = cli(p, "plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--json");
    const { run_id } = JSON.parse(plan.out);
    cli(p, "enqueue", run_id);
    const store = new SqliteStateStore(join(p, "data", "state", "harness.db"));
    const claim = store.claim({ owner: "w", capabilities: ["write_workspace"], now: new Date().toISOString(), leaseSeconds: 90 })!;
    const ev = { run_id, stage_run_id: claim.stageRun.stage_run_id, attempt_id: claim.attempt.attempt_id, project_id: "project-minimal", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info" as const, event_type: "stage.test", payload: {} };
    store.transaction(() => {
      store.transition("attempt", claim.attempt.attempt_id, "CLAIMED", "RUNNING", ev);
      store.transition("stage_run", claim.stageRun.stage_run_id, "CLAIMED", "RUNNING", ev);
    });
    store.close();
    expect(cli(p, "cancel", run_id).out).toContain("CANCEL_REQUESTED");
    const r = cli(p, "retry", run_id);
    expect(r.code).toBe(1);
    expect(r.err).toContain("INVALID_TRANSITION");
  });
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/core/test/config packages/worker packages/cli`
Expected: 3 test mới FAIL (không throw / run vẫn `CANCEL_REQUESTED` / retry exit 0).

- [ ] **Step 3: Sửa `resolve.ts`**

Trong `resolveEffectiveConfig`, sau đoạn policy clamp `default_max_cost_usd`, thêm:

```ts
  // policy: a lease must outlive at least one heartbeat, or a worker reaps itself mid-stage
  const lease = Number(snapshot.lease_seconds);
  if (Number.isFinite(lease) && lease <= input.harness.heartbeat_seconds) {
    throw new HarnessError("CONFIG_INVALID", `lease_seconds (${lease}) must be greater than heartbeat_seconds (${input.harness.heartbeat_seconds})`, { lease_seconds: lease, heartbeat_seconds: input.harness.heartbeat_seconds });
  }
```

- [ ] **Step 4: `ReapedLease.run_id` và worker advance**

`packages/contracts/src/interfaces.ts`:

```ts
export interface ReapedLease { stage_run_id: string; run_id: string; attempt_id: string; owner: string; requeued: boolean }
```

`packages/core/src/state/sqlite-store.ts` — trong `reapExpiredLeases`, cả hai chỗ `out.push({...})` thêm `run_id: stage.run_id`:

```ts
          out.push({ stage_run_id: stage.stage_run_id, run_id: stage.run_id, attempt_id: attempt.attempt_id, owner: lease.owner, requeued: false });
```
và
```ts
        out.push({ stage_run_id: stage.stage_run_id, run_id: stage.run_id, attempt_id: attempt.attempt_id, owner: lease.owner, requeued: canRetry });
```

`packages/worker/src/worker.ts` — trong `runOnce`, ngay sau vòng `for (const r of reaped) logger.warn(...)`:

```ts
    for (const runId of new Set(reaped.map((r) => r.run_id))) {
      try { this.d.planner.advance(runId); } // a reaper-completed cancel or requeue may settle the run
      catch (e) { logger.warn("advance after reap failed", { run_id: runId, error: e instanceof Error ? e.message : String(e) }); }
    }
```

Cập nhật test claim hiện có nếu nó so sánh `reapExpiredLeases` bằng `toEqual` với object không có `run_id`: thêm `run_id: first.stageRun.run_id` vào object kỳ vọng (trong `packages/core/test/state/claim.test.ts`, hai test "reaps expired leases…" và "reports requeued=false…").

- [ ] **Step 5: `retry.ts` từ chối CANCEL_REQUESTED**

Thay dòng guard:

```ts
      if (run.state === "FAILED" || run.state === "CANCELLED" || run.state === "CANCEL_REQUESTED") throw new HarnessError("INVALID_TRANSITION", `run is ${run.state}; ${run.state === "CANCEL_REQUESTED" ? "finish the cancel first" : "plan a new run instead"}`, { runId, state: run.state });
```

- [ ] **Step 6: Chạy test, xác nhận pass**

Run: `pnpm test && pnpm build && pnpm typecheck`
Expected: PASS toàn bộ.

- [ ] **Step 7: Commit**

```bash
git add packages
git commit -m "fix: lease must exceed heartbeat, retry refuses pending cancels, worker settles runs after reaping

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Quét artifact mồ côi (`harness artifacts sweep`)

**Files:**
- Create: `packages/core/src/artifacts/sweep.ts`, `packages/cli/src/commands/artifacts.ts`
- Modify: `packages/core/src/index.ts`, `packages/cli/src/main.ts`
- Test: `packages/core/test/artifacts/sweep.test.ts`, `packages/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: `store.getArtifact`, `ArtifactManifestSchema`, thư mục `<dataRoot>/artifacts/<a>/<b>/<artifact_id>/manifest.json`.
- Produces: `sweepOrphanArtifacts(p: { store: StateStore; dataRoot: string; now: string; olderThanSeconds: number; dryRun: boolean }): SweepReport` với `SweepReport = { scanned: number; removed: string[]; kept: { artifact_id: string; reason: string }[] }`; lệnh `harness artifacts sweep [--older-than-minutes 60] [--dry-run] [--json]`.

Quy tắc: một thư mục artifact là mồ côi khi (a) không có hàng `artifact` trong DB cho `artifact_id`, hoặc (b) hàng tồn tại nhưng `status = PROVISIONAL`; và thư mục đã cũ hơn `olderThanSeconds` (theo mtime của `manifest.json`). Thư mục không có `manifest.json` hoặc manifest không parse được cũng là mồ côi nếu cũ hơn ngưỡng. `dryRun` chỉ báo, không xóa.

- [ ] **Step 1: Viết test thất bại**

`packages/core/test/artifacts/sweep.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@harness/contracts";
import { sha256String } from "../../src/artifacts/checksum.js";
import { ArtifactRegistry } from "../../src/artifacts/registry.js";
import { sweepOrphanArtifacts } from "../../src/artifacts/sweep.js";
import { createWorkspace } from "../../src/environment/workspace.js";
import { beginAttempt, openTempStore, seedStage } from "../helpers.js";

function orphanDir(dataRoot: string, ageSeconds: number, withManifest = true): string {
  const id = newId("artifact");
  const dir = join(dataRoot, "artifacts", "content-x", "variant-y", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.txt"), "x");
  if (withManifest) writeFileSync(join(dir, "manifest.json"), JSON.stringify({ artifact_id: id, status: "provisional" }));
  const old = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(withManifest ? join(dir, "manifest.json") : dir, old, old);
  return dir;
}

describe("sweepOrphanArtifacts", () => {
  it("removes old orphans, keeps young ones and accepted artifacts", async () => {
    const { store, dir, clock } = openTempStore();
    const oldOrphan = orphanDir(dir, 7200);
    const youngOrphan = orphanDir(dir, 10);
    const noManifest = orphanDir(dir, 7200, false);
    // a real ACCEPTED artifact
    const { runId, stage } = seedStage(store);
    const claim = store.claim({ owner: "w", capabilities: [], now: clock.now(), leaseSeconds: 90 })!;
    const { attempt } = beginAttempt(store, claim);
    const ws = await createWorkspace(dir, runId, stage.stage_key, attempt.attempt_id);
    writeFileSync(join(ws, "output", "result.txt"), "hello");
    const registry = new ArtifactRegistry(store, dir);
    const ctx = { run: store.getRun(runId)!, stageRun: store.getStageRun(stage.stage_run_id)!, attempt, executorVersion: "x", inputArtifactIds: [], checkResultIds: [] };
    const staged = await registry.stageOutputs({ workspaceDir: ws, outputs: [{ path: "output/result.txt", type: "t", checksum: sha256String("hello"), size_bytes: 5 }], mimeTypes: {}, ctx });
    const [accepted] = store.transaction(() => registry.commitAccepted(staged, ctx));
    const acceptedDir = join(staged[0]!.manifestPath, "..");
    utimesSync(staged[0]!.manifestPath, new Date(Date.now() - 7200_000), new Date(Date.now() - 7200_000));

    const dry = sweepOrphanArtifacts({ store, dataRoot: dir, now: new Date().toISOString(), olderThanSeconds: 3600, dryRun: true });
    expect(dry.removed.sort()).toEqual([oldOrphan, noManifest].sort());
    expect(existsSync(oldOrphan)).toBe(true);

    const real = sweepOrphanArtifacts({ store, dataRoot: dir, now: new Date().toISOString(), olderThanSeconds: 3600, dryRun: false });
    expect(real.removed.sort()).toEqual([oldOrphan, noManifest].sort());
    expect(existsSync(oldOrphan)).toBe(false);
    expect(existsSync(noManifest)).toBe(false);
    expect(existsSync(youngOrphan)).toBe(true);
    expect(existsSync(acceptedDir)).toBe(true);
    expect(real.kept.some((k) => k.artifact_id === accepted!.artifact_id && k.reason === "ACCEPTED")).toBe(true);
    expect(real.scanned).toBe(4);
  });
});
```

Thêm vào `packages/cli/test/cli.test.ts`:

```ts
  it("artifacts sweep reports and removes orphan directories", () => {
    const p = freshProject();
    cli(p, "db", "migrate");
    const dir = join(p, "data", "artifacts", "c", "v", "artifact_01J00000000000000000000000");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ artifact_id: "artifact_01J00000000000000000000000", status: "provisional" }));
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(join(dir, "manifest.json"), old, old);
    const dry = JSON.parse(cli(p, "artifacts", "sweep", "--dry-run", "--json").out);
    expect(dry.removed).toHaveLength(1);
    expect(existsSync(dir)).toBe(true);
    const real = JSON.parse(cli(p, "artifacts", "sweep", "--json").out);
    expect(real.removed).toHaveLength(1);
    expect(existsSync(dir)).toBe(false);
  });
```
(thêm `mkdirSync`, `writeFileSync`, `utimesSync`, `existsSync` vào import `node:fs` của file test.)

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/core/test/artifacts/sweep.test.ts packages/cli`
Expected: FAIL, thiếu module / lệnh.

- [ ] **Step 3: Viết `sweep.ts`**

`packages/core/src/artifacts/sweep.ts`:

```ts
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StateStore } from "@harness/contracts";

export interface SweepReport { scanned: number; removed: string[]; kept: { artifact_id: string; reason: string }[] }

function safeList(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }

/** Artifact directories with no ACCEPTED/REJECTED/STALE/ARCHIVED row behind them are orphans once older than the threshold. */
export function sweepOrphanArtifacts(p: { store: StateStore; dataRoot: string; now: string; olderThanSeconds: number; dryRun: boolean }): SweepReport {
  const root = join(p.dataRoot, "artifacts");
  const cutoff = Date.parse(p.now) - p.olderThanSeconds * 1000;
  const report: SweepReport = { scanned: 0, removed: [], kept: [] };
  for (const a of safeList(root)) for (const b of safeList(join(root, a))) for (const id of safeList(join(root, a, b))) {
    const dir = join(root, a, b, id);
    if (!statSync(dir).isDirectory()) continue;
    report.scanned++;
    const manifestPath = join(dir, "manifest.json");
    const stampSource = existsSync(manifestPath) ? manifestPath : dir;
    const mtime = statSync(stampSource).mtimeMs;
    let artifactId = id;
    if (existsSync(manifestPath)) {
      try { artifactId = String((JSON.parse(readFileSync(manifestPath, "utf8")) as { artifact_id?: string }).artifact_id ?? id); } catch { /* unreadable manifest: treat as orphan */ }
    }
    const row = p.store.getArtifact(artifactId);
    if (row && row.status !== "PROVISIONAL") { report.kept.push({ artifact_id: artifactId, reason: row.status }); continue; }
    if (mtime >= cutoff) { report.kept.push({ artifact_id: artifactId, reason: "too_young" }); continue; }
    report.removed.push(dir);
    if (!p.dryRun) rmSync(dir, { recursive: true, force: true });
  }
  return report;
}
```

Thêm `export * from "./artifacts/sweep.js";` vào `packages/core/src/index.ts`.

- [ ] **Step 4: Lệnh CLI**

`packages/cli/src/commands/artifacts.ts`:

```ts
import type { Command } from "commander";
import { sweepOrphanArtifacts } from "@harness/core";
import { print, withContext } from "./shared.js";
export function registerArtifacts(program: Command): void {
  const artifacts = program.command("artifacts").description("artifact store maintenance");
  artifacts.command("sweep").option("--older-than-minutes <n>", "only directories older than this", "60").option("--dry-run", "report only", false).option("--json", "machine output", false)
    .description("remove artifact directories with no accepted row behind them").action(async (o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const report = sweepOrphanArtifacts({ store: ctx.store, dataRoot: ctx.dataRoot, now: ctx.clock.now(), olderThanSeconds: Number(o.olderThanMinutes) * 60, dryRun: Boolean(o.dryRun) });
        print(o.json, report, () => `scanned ${report.scanned}, ${o.dryRun ? "would remove" : "removed"} ${report.removed.length}, kept ${report.kept.length}` + (report.removed.length ? "\n" + report.removed.join("\n") : ""));
      });
    });
}
```

Trong `packages/cli/src/main.ts` import `registerArtifacts` từ `./commands/artifacts.js` và thêm vào mảng đăng ký.

- [ ] **Step 5: Chạy test, xác nhận pass**

Run: `pnpm vitest run packages/core packages/cli && pnpm build && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages
git commit -m "feat: sweep orphan artifact directories (harness artifacts sweep)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 3: Mở rộng contract (catalog, options, when, resources, kind, gate)

**Files:**
- Modify: `packages/contracts/src/entities.ts`, `packages/contracts/src/config.ts`, `packages/contracts/src/execution.ts`, `packages/contracts/src/interfaces.ts`, `packages/contracts/schemas/*.json` (sinh lại)
- Test: `packages/contracts/test/entities.test.ts`, `packages/contracts/test/config.test.ts`, `packages/contracts/test/execution.test.ts`

**Interfaces:**
- Produces (schema/type mới hoặc mở rộng, tên chính xác):
  - `SourceItemSchema` thêm `collection`, `original_uri`, `mime_type`, `size_bytes`, `media` (nullable `{ width, height, fps, has_audio }`).
  - `ContentVariantSchema` thêm `options` (object), `options_digest` (checksum).
  - `StageRunSchema` thêm `depends_on_optional: string[]`, `requires_resources: string[]`, `cache_key?: Checksum`, `reused_artifact_ids?: string[]`.
  - `LeaseSchema` thêm `resources: string[]` (default `[]`).
  - `executorRefSchema` thêm biến thể `{ type: "gate", brief: string }`.
  - `stageDefinitionSchema` thêm `when?`, `depends_on_optional`, `requires_resources`, `gate_deadline_seconds?`, `outputs[].kind` (`file|directory`, default `file`), `outputs[].name` (tùy chọn).
  - `ProductionProfileSchema` thêm `options_schema: Record<string, string[]>`, `options_defaults: object`, `reuse: "allow"|"never"` (default allow), `verification.required_checks_by_stage: Record<string, string[]>`, `content: { target_duration_seconds?: [number, number] }`.
  - `ProjectConfigSchema` thêm `resources: Record<string, int>` (default `{}`), `source: { materialize: "link"|"copy"|"reference" }` (default link).
  - `HarnessConfigSchema` thêm `resource_wait_warn_seconds` (default 600).
  - `stageInputSchema`/`stageOutputSchema` thêm `kind` (default `file`); `StageRequestSchema` thêm `options` (default `{}`), `source_items` (default `[]`, phần tử `{ source_id, uri, checksum, mime_type, duration_seconds: number|null }`), `resources` (default `[]`).
  - `interfaces.ts`: `MediaInfo`, `MediaProber`; `ClaimParams.resourceCapacity?: Record<string, number>`; `ReapedLease.run_id` (Task 1); `StateStore` thêm: `insertSourceItem(s)`, `getSourceItem(id)`, `findSourceItemByChecksum(checksum)`, `listSourceItems(filter?: { collection?: string })`, `insertContentItem(c)`, `getContentItem(id)`, `updateContentItem(c)`, `listContentItems()`, `insertContentVariant(v)`, `getContentVariant(id)`, `findContentVariant(key: { content_id, profile_id, profile_revision, options_digest })`, `listContentVariants(contentId)`, `countLeasedResources(): Record<string, number>`; `listRuns(filter?: { state?: string; variant_id?: string })`.

- [ ] **Step 1: Viết test thất bại**

Thêm vào `packages/contracts/test/entities.test.ts`:

```ts
  it("parses the extended SourceItem, ContentVariant, StageRun and Lease", () => {
    const src = SourceItemSchema.parse({
      schema_version: "harness.source-item/v1", source_id: newId("source_item"), uri: "file:///d/normalized/a.mp4", original_uri: "file:///d/raw/a.mp4",
      checksum: "sha256:" + "a".repeat(64), collection: "main", mime_type: "video/mp4", size_bytes: 10, media: { width: 1920, height: 1080, fps: 30, has_audio: true },
      rights_status: "unknown", language: null, duration_seconds: 5, ingested_at: now,
    });
    expect(src.collection).toBe("main");
    const variant = ContentVariantSchema.parse({
      schema_version: "harness.content-variant/v1", variant_id: newId("content_variant"), content_id: newId("content_item"), profile_id: "footage", profile_revision: 1,
      options: { voice: "tts" }, options_digest: "sha256:" + "b".repeat(64), created_at: now,
    });
    expect(variant.options).toEqual({ voice: "tts" });
    const stage = StageRunSchema.parse({
      schema_version: "harness.stage-run/v1", stage_run_id: newId("stage_run"), run_id: newId("run"), stage_key: "assemble",
      executor: { type: "gate", brief: "decide" }, depends_on: ["cut"], depends_on_optional: ["tts"], requires_resources: ["cpu"],
      required_capabilities: [], required_checks: [], retry: { max_attempts: 1, backoff_seconds: [0], retry_on: [] }, stage_config: {},
      state: "PENDING", attempt_count: 0, result_failures: 0, cache_key: "sha256:" + "c".repeat(64), reused_artifact_ids: [newId("artifact")], created_at: now, updated_at: now,
    });
    expect(stage.depends_on_optional).toEqual(["tts"]);
    expect(LeaseSchema.parse({ stage_run_id: newId("stage_run"), attempt_id: newId("attempt"), owner: "w", expires_at: now, fencing_token: 1 }).resources).toEqual([]);
  });
```
(thêm `SourceItemSchema`, `ContentVariantSchema` vào import của file.)

Thêm vào `packages/contracts/test/config.test.ts`:

```ts
  it("parses when, optional dependencies, resources and directory outputs on stages", () => {
    const wf = WorkflowDefinitionSchema.parse({
      schema_version: "harness.workflow/v1", id: "w", version: "1.0.0", defaults: {},
      stages: [
        { key: "a", executor: { type: "script", script: "x" } },
        { key: "tts", executor: { type: "script", script: "x" }, depends_on: ["a"], when: 'options.voice == "tts"', requires_resources: ["gpu"] },
        { key: "b", executor: { type: "gate", brief: "go" }, depends_on: ["a"], depends_on_optional: ["tts"], gate_deadline_seconds: 3600, outputs: [{ type: "clip_set", mime_type: "application/x-directory", kind: "directory", name: "cuts" }] },
      ],
    });
    expect(wf.stages[1]?.when).toBe('options.voice == "tts"');
    expect(wf.stages[2]?.depends_on_optional).toEqual(["tts"]);
    expect(wf.stages[2]?.outputs[0]?.kind).toBe("directory");
    expect(wf.stages[0]?.outputs).toEqual([]);
    expect(wf.stages[0]?.requires_resources).toEqual([]);
  });
  it("rejects malformed when expressions and unknown optional dependencies", () => {
    const base = { schema_version: "harness.workflow/v1", id: "w", version: "1.0.0", defaults: {} };
    expect(WorkflowDefinitionSchema.safeParse({ ...base, stages: [{ key: "a", executor: { type: "script", script: "x" }, when: "voice == tts" }] }).success).toBe(false);
    expect(WorkflowDefinitionSchema.safeParse({ ...base, stages: [{ key: "a", executor: { type: "script", script: "x" }, depends_on_optional: ["nope"] }] }).success).toBe(false);
  });
  it("parses profile options schema, reuse policy and per-stage checks", () => {
    const p = ProductionProfileSchema.parse({
      schema_version: "harness.production-profile/v1", profile_id: "footage", revision: 1, status: "active", workflow_release: "footage-production@1.0.0",
      options_schema: { voice: ["none", "tts", "original"], avatar: ["none", "heygen"] }, options_defaults: { voice: "none", avatar: "none" },
      verification: { required_checks_by_stage: { assemble: ["media-probe"] } }, content: { target_duration_seconds: [480, 720] },
    });
    expect(p.reuse).toBe("allow");
    expect(p.verification.required_checks).toEqual([]);
    expect(p.verification.required_checks_by_stage.assemble).toEqual(["media-probe"]);
  });
  it("parses project resources and source materialize policy", () => {
    const pc = ProjectConfigSchema.parse({ schema_version: "harness.project-config/v1", project_id: "p", template_release: "0.1.0", runtime: "claude", data_root: "./data", portfolios: [{ portfolio_id: "pf", display_name: "x" }], resources: { gpu: 1, "image-gen": 2 } });
    expect(pc.resources).toEqual({ gpu: 1, "image-gen": 2 });
    expect(pc.source.materialize).toBe("link");
    expect(ProjectConfigSchema.safeParse({ ...pc, resources: { GPU: 1 } }).success).toBe(false);
    expect(HarnessConfigSchema.parse({ schema_version: "harness.config/v1" }).resource_wait_warn_seconds).toBe(600);
  });
```
(thêm `ProductionProfileSchema` vào import.)

Thêm vào `packages/contracts/test/execution.test.ts`:

```ts
  it("defaults kind to file and accepts options, source_items and resources on a request", () => {
    const out = stageOutputSchema.parse({ path: "output/cuts", type: "clip_set", checksum: sha, size_bytes: 0 });
    expect(out.kind).toBe("file");
    const req = StageRequestSchema.parse({
      schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"),
      project_id: "p", portfolio_id: "pf", stage_key: "cut", workflow: { id: "w", version: "1.0.0", digest: sha }, profile_snapshot: { id: "footage", revision: 1 },
      inputs: [{ artifact_id: newId("artifact"), checksum: sha, path: "input/x/edl.json", type: "edl", kind: "file" }], workspace_uri: "file:///ws", stage_config: {},
      options: { voice: "tts" }, source_items: [{ source_id: newId("source_item"), uri: "file:///src.mp4", checksum: sha, mime_type: "video/mp4", duration_seconds: 5 }], resources: ["cpu"],
      limits: { deadline_at: now, max_cost_usd: 5, max_attempts: 3 }, capabilities: [], fencing_token: 1,
    });
    expect(req.source_items).toHaveLength(1);
    expect(StageRequestSchema.parse({ ...req, options: undefined, source_items: undefined, resources: undefined }).options).toEqual({});
  });
```
(thêm `stageOutputSchema` vào import.)

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/contracts`
Expected: các test mới FAIL (unknown key / parse lỗi).

- [ ] **Step 3: Sửa `entities.ts`**

```ts
// executorRefSchema: thêm biến thể gate
export const executorRefSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("script"), script: z.string().min(1) }).strict(),
  z.object({ type: z.literal("agent"), skill: z.string().min(1), brief: z.string().default("") }).strict(),
  z.object({ type: z.literal("gate"), brief: z.string().default("") }).strict(),
]);

// StageRunSchema: thêm sau `required_checks`
  depends_on_optional: z.array(z.string()).default([]),
  requires_resources: z.array(z.string()).default([]),
// ... và sau `last_failure_kind`
  cache_key: checksumSchema.optional(),
  reused_artifact_ids: z.array(idSchema("artifact")).optional(),

// LeaseSchema: thêm
  resources: z.array(z.string()).default([]),

// SourceItemSchema thay toàn bộ
export const mediaInfoSchema = z.object({ width: z.number().int().min(1), height: z.number().int().min(1), fps: z.number().positive().nullable(), has_audio: z.boolean() }).strict();
export const SourceItemSchema = z.object({
  schema_version: schemaVersion("source-item"), source_id: idSchema("source_item"),
  uri: z.string().min(1), original_uri: z.string().min(1), checksum: checksumSchema, collection: z.string().regex(/^[a-z][a-z0-9-]*$/).default("main"),
  mime_type: z.string().min(1), size_bytes: z.number().int().min(0), media: mediaInfoSchema.nullable(),
  rights_status: z.enum(["unknown", "cleared", "restricted"]), language: z.string().nullable(), duration_seconds: z.number().nullable(), ingested_at: timestampSchema,
}).strict();

// ContentVariantSchema thay toàn bộ
export const ContentVariantSchema = z.object({
  schema_version: schemaVersion("content-variant"), variant_id: idSchema("content_variant"), content_id: idSchema("content_item"),
  profile_id: z.string().min(1), profile_revision: revisionSchema, options: jsonObjectSchema.default({}), options_digest: checksumSchema, created_at: timestampSchema,
}).strict();
```
Thêm export type: `export type SourceItem = z.infer<typeof SourceItemSchema>; export type ContentItem = z.infer<typeof ContentItemSchema>; export type ContentVariant = z.infer<typeof ContentVariantSchema>; export type MediaInfo = z.infer<typeof mediaInfoSchema>;`

- [ ] **Step 4: Sửa `config.ts`**

```ts
export const WHEN_RE = /^options\.([a-z][a-z0-9_]*) (==|!=) "([^"]*)"$/;

export const stageDefinitionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]*$/),
  executor: executorRefSchema,
  depends_on: z.array(z.string()).default([]),
  depends_on_optional: z.array(z.string()).default([]),
  when: z.string().regex(WHEN_RE, 'expected options.<key> == "<value>" or !=').optional(),
  requires_resources: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).default([]),
  gate_deadline_seconds: z.number().int().min(1).optional(),
  required_capabilities: z.array(z.string()).default([]),
  required_checks: z.array(z.string()).default([]),
  retry: retryPolicySchema.default({ ...DEFAULT_RETRY, retry_on: [...DEFAULT_RETRY.retry_on] }),
  outputs: z.array(z.object({ type: z.string().min(1), mime_type: z.string().min(1), kind: z.enum(["file", "directory"]).default("file"), name: z.string().min(1).optional() }).strict()).default([]),
  config: jsonObjectSchema.default({}),
}).strict();
```
Trong `superRefine` của `WorkflowDefinitionSchema`, mở rộng vòng kiểm dependency để bao gồm `depends_on_optional`:
```ts
  for (const s of wf.stages) for (const d of [...s.depends_on, ...s.depends_on_optional]) {
    if (!keys.has(d)) ctx.addIssue({ code: "custom", message: `stage ${s.key} depends on unknown stage ${d}` });
    if (d === s.key) ctx.addIssue({ code: "custom", message: `stage ${s.key} depends on itself` });
  }
```
và trong DFS cycle: `const deps = new Map(wf.stages.map((s) => [s.key, [...s.depends_on, ...s.depends_on_optional]]));`.

`ProductionProfileSchema`:
```ts
export const ProductionProfileSchema = z.object({
  schema_version: schemaVersion("production-profile"),
  profile_id: z.enum(["cartoon", "avatar", "footage"]),
  revision: revisionSchema,
  status: z.enum(["active", "draft", "retired"]),
  workflow_release: z.string().regex(/^[a-z][a-z0-9-]*@\d+\.\d+\.\d+$/),
  overrides: jsonObjectSchema.default({}),
  options_schema: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.array(z.string().min(1)).min(1)).default({}),
  options_defaults: jsonObjectSchema.default({}),
  reuse: z.enum(["allow", "never"]).default("allow"),
  content: z.object({ target_duration_seconds: z.tuple([z.number().min(0), z.number().min(0)]).optional() }).strict().default({}),
  verification: z.object({ required_checks: z.array(z.string()).default([]), required_checks_by_stage: z.record(z.string(), z.array(z.string())).default({}) }).strict().default({ required_checks: [], required_checks_by_stage: {} }),
  limits: z.object({ max_cost_usd_per_variant: z.number().min(0).default(5), max_concurrency: z.number().int().min(1).default(1) }).strict().default({ max_cost_usd_per_variant: 5, max_concurrency: 1 }),
}).strict();
```
`ProjectConfigSchema` thêm:
```ts
  resources: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.number().int().min(0)).default({}),
  source: z.object({ materialize: z.enum(["link", "copy", "reference"]).default("link") }).strict().default({ materialize: "link" }),
```
`HarnessConfigSchema` thêm `resource_wait_warn_seconds: z.number().int().min(1).default(600),`.

- [ ] **Step 5: Sửa `execution.ts` và `interfaces.ts`**

`execution.ts`: thêm `kind: z.enum(["file", "directory"]).default("file")` vào `stageInputSchema` và `stageOutputSchema`; `StageRequestSchema` thêm:
```ts
  options: jsonObjectSchema.default({}),
  source_items: z.array(z.object({ source_id: idSchema("source_item"), uri: z.string().min(1), checksum: checksumSchema, mime_type: z.string().min(1), duration_seconds: z.number().nullable() }).strict()).default([]),
  resources: z.array(z.string()).default([]),
```

`interfaces.ts` thêm/sửa:
```ts
import type { Artifact, Attempt, CheckResult, ContentItem, ContentVariant, Event, ExternalOperation, Lease, MediaInfo, Run, SourceItem, StageRun } from "./entities.js";

export interface ClaimParams { owner: string; capabilities: string[]; now: string; leaseSeconds: number; resourceCapacity?: Record<string, number> }
export interface ReapedLease { stage_run_id: string; run_id: string; attempt_id: string; owner: string; requeued: boolean }
export interface MediaProber { probe(path: string): Promise<{ media: MediaInfo | null; duration_seconds: number | null; mime_type: string | null } | null> }

// trong StateStore:
  listRuns(filter?: { state?: string; variant_id?: string }): Run[];
  insertSourceItem(s: SourceItem): void;
  getSourceItem(id: string): SourceItem | undefined;
  findSourceItemByChecksum(checksum: string): SourceItem | undefined;
  listSourceItems(filter?: { collection?: string }): SourceItem[];
  insertContentItem(c: ContentItem): void;
  getContentItem(id: string): ContentItem | undefined;
  updateContentItem(c: ContentItem): void;
  listContentItems(): ContentItem[];
  insertContentVariant(v: ContentVariant): void;
  getContentVariant(id: string): ContentVariant | undefined;
  findContentVariant(key: { content_id: string; profile_id: string; profile_revision: number; options_digest: string }): ContentVariant | undefined;
  listContentVariants(contentId: string): ContentVariant[];
  countLeasedResources(): Record<string, number>;
```

- [ ] **Step 6: Sinh schema, test, typecheck**

Run: `pnpm gen:schemas && pnpm vitest run packages/contracts && pnpm --filter @harness/contracts typecheck`
Expected: PASS. (`core` chưa implement các method mới nên `pnpm -r typecheck` sẽ lỗi cho tới Task 4; chấp nhận ở task này, ghi vào report.)

- [ ] **Step 7: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): catalog entities, variant options, when/optional deps/resources on stages, directory outputs, gate executor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Migration 0002, bảng catalog, `claim()` theo capacity tài nguyên

**Files:**
- Create: `migrations/0002_catalog_resources.sql`
- Modify: `packages/core/src/state/sqlite-store.ts`, `packages/core/test/helpers.ts`
- Test: `packages/core/test/state/catalog-store.test.ts`, `packages/core/test/state/claim.test.ts`

**Interfaces:**
- Consumes: schema Task 3.
- Produces: implementation đầy đủ của các method mới trong `StateStore`; `claim()` bỏ qua stage khi `requires_resources` không còn slot; lease lưu `resources`; `seedStage` nhận `requires_resources`.

- [ ] **Step 1: Migration**

`migrations/0002_catalog_resources.sql`:

```sql
CREATE TABLE source_item (
  id TEXT PRIMARY KEY, checksum TEXT NOT NULL, collection TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX source_item_checksum_idx ON source_item(checksum);  -- dedupe is enforced by the schema, not only by the lookup (review Task 5)

CREATE TABLE content_item (
  id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE content_variant (
  id TEXT PRIMARY KEY, content_id TEXT NOT NULL, profile_id TEXT NOT NULL, variant_key TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX content_variant_content_idx ON content_variant(content_id);

ALTER TABLE lease ADD COLUMN resources TEXT NOT NULL DEFAULT '[]';
CREATE INDEX run_variant_idx ON run(json_extract(data, '$.variant_id'));
```

- [ ] **Step 2: Viết test thất bại**

Sửa `seedStage` trong `packages/core/test/helpers.ts`: thêm `requires_resources?: string[]` vào `opts` và vào StageRun literal `requires_resources: opts.requires_resources ?? [], depends_on_optional: []`.

`packages/core/test/state/catalog-store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newId, type ContentItem, type ContentVariant, type SourceItem } from "@harness/contracts";
import { openTempStore } from "../helpers.js";

const now = "2026-09-12T00:00:00.000Z";
const sha = (c: string) => "sha256:" + c.repeat(64);
const src = (checksum: string): SourceItem => ({ schema_version: "harness.source-item/v1", source_id: newId("source_item"), uri: "file:///n/a.mp4", original_uri: "file:///r/a.mp4", checksum, collection: "main", mime_type: "video/mp4", size_bytes: 1, media: null, rights_status: "unknown", language: null, duration_seconds: null, ingested_at: now });

describe("catalog tables", () => {
  it("migration 0002 adds the three catalog tables", () => {
    const { store } = openTempStore();
    expect(store.tableNames()).toEqual(expect.arrayContaining(["source_item", "content_item", "content_variant"]));
  });
  it("stores sources and finds them by checksum", () => {
    const { store } = openTempStore();
    const a = src(sha("a")); store.insertSourceItem(a);
    expect(store.getSourceItem(a.source_id)).toEqual(a);
    expect(store.findSourceItemByChecksum(sha("a"))?.source_id).toBe(a.source_id);
    expect(store.findSourceItemByChecksum(sha("b"))).toBeUndefined();
    store.insertSourceItem({ ...src(sha("c")), collection: "archive" });
    expect(store.listSourceItems({ collection: "main" })).toHaveLength(1);
    expect(store.listSourceItems()).toHaveLength(2);
  });
  it("stores content and variants keyed by content/profile/revision/options", () => {
    const { store } = openTempStore();
    const content: ContentItem = { schema_version: "harness.content-item/v1", content_id: newId("content_item"), source_ids: [newId("source_item")], revision: 1, title: "t", created_at: now };
    store.insertContentItem(content);
    store.updateContentItem({ ...content, revision: 2, title: "t2" });
    expect(store.getContentItem(content.content_id)?.revision).toBe(2);
    expect(store.listContentItems()).toHaveLength(1);
    const v: ContentVariant = { schema_version: "harness.content-variant/v1", variant_id: newId("content_variant"), content_id: content.content_id, profile_id: "footage", profile_revision: 1, options: { voice: "tts" }, options_digest: sha("d"), created_at: now };
    store.insertContentVariant(v);
    expect(store.findContentVariant({ content_id: content.content_id, profile_id: "footage", profile_revision: 1, options_digest: sha("d") })?.variant_id).toBe(v.variant_id);
    expect(store.findContentVariant({ content_id: content.content_id, profile_id: "footage", profile_revision: 2, options_digest: sha("d") })).toBeUndefined();
    expect(() => store.insertContentVariant({ ...v, variant_id: newId("content_variant") })).toThrow(/UNIQUE/);
    expect(store.listContentVariants(content.content_id)).toHaveLength(1);
  });
});
```

Thêm vào `packages/core/test/state/claim.test.ts` trong `describe("claim")`:

```ts
  it("honours resource capacity and frees the slot when the lease is released or reaped", () => {
    const { store, clock } = openTempStore();
    seedStage(store, { key: "tts-a", requires_resources: ["gpu"] });
    seedStage(store, { key: "tts-b", requires_resources: ["gpu"] });
    seedStage(store, { key: "cpu-only", requires_resources: ["cpu"] });
    const cap = { gpu: 1, cpu: 2 };
    const first = store.claim({ owner: "w1", capabilities: [], now: clock.now(), leaseSeconds: 90, resourceCapacity: cap })!;
    expect(first.stageRun.stage_key).toBe("tts-a");
    expect(first.lease.resources).toEqual(["gpu"]);
    expect(store.countLeasedResources()).toEqual({ gpu: 1 });
    const second = store.claim({ owner: "w2", capabilities: [], now: clock.now(), leaseSeconds: 90, resourceCapacity: cap })!;
    expect(second.stageRun.stage_key).toBe("cpu-only"); // gpu is full, the cpu stage is still claimable
    expect(store.claim({ owner: "w3", capabilities: [], now: clock.now(), leaseSeconds: 90, resourceCapacity: cap })).toBeUndefined();
    store.releaseLease(first.stageRun.stage_run_id, first.lease.fencing_token);
    expect(store.claim({ owner: "w3", capabilities: [], now: clock.now(), leaseSeconds: 90, resourceCapacity: cap })?.stageRun.stage_key).toBe("tts-b");
  });
  it("treats an undeclared resource as capacity zero", () => {
    const { store, clock } = openTempStore();
    seedStage(store, { key: "needs-heygen", requires_resources: ["heygen"] });
    expect(store.claim({ owner: "w", capabilities: [], now: clock.now(), leaseSeconds: 90, resourceCapacity: {} })).toBeUndefined();
    expect(store.claim({ owner: "w", capabilities: [], now: clock.now(), leaseSeconds: 90 })).toBeUndefined();
  });
```

- [ ] **Step 3: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/core/test/state`
Expected: FAIL (bảng thiếu, method thiếu, claim không lọc).

- [ ] **Step 4: Implement trong `sqlite-store.ts`**

Import thêm `ContentItemSchema, ContentVariantSchema, SourceItemSchema` và các type `ContentItem, ContentVariant, SourceItem` từ `@harness/contracts`.

`listRuns` thay bằng:
```ts
  listRuns(filter: { state?: string; variant_id?: string } = {}): Run[] {
    const where: string[] = []; const params: string[] = [];
    if (filter.state) { where.push("state = ?"); params.push(filter.state); }
    if (filter.variant_id) { where.push("json_extract(data, '$.variant_id') = ?"); params.push(filter.variant_id); }
    return this.listDocs(`SELECT data FROM run${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY rowid`, params, (x) => RunSchema.parse(x));
  }
```

Thêm khối catalog (sau `listCheckResults`):
```ts
  // ---- catalog ----
  insertSourceItem(s: SourceItem): void {
    const v = SourceItemSchema.parse(s);
    this.db.prepare("INSERT INTO source_item (id, checksum, collection, data, updated_at) VALUES (?, ?, ?, ?, ?)").run(v.source_id, v.checksum, v.collection, JSON.stringify(v), v.ingested_at);
  }
  getSourceItem(id: string): SourceItem | undefined { return this.getDoc("source_item", id, (x) => SourceItemSchema.parse(x)); }
  findSourceItemByChecksum(checksum: string): SourceItem | undefined {
    const row = this.db.prepare("SELECT data FROM source_item WHERE checksum = ? ORDER BY rowid LIMIT 1").get(checksum) as Row | undefined;
    return row ? SourceItemSchema.parse(JSON.parse(row.data)) : undefined;
  }
  listSourceItems(filter: { collection?: string } = {}): SourceItem[] {
    return filter.collection
      ? this.listDocs("SELECT data FROM source_item WHERE collection = ? ORDER BY rowid", [filter.collection], (x) => SourceItemSchema.parse(x))
      : this.listDocs("SELECT data FROM source_item ORDER BY rowid", [], (x) => SourceItemSchema.parse(x));
  }
  insertContentItem(c: ContentItem): void {
    const v = ContentItemSchema.parse(c);
    this.db.prepare("INSERT INTO content_item (id, data, updated_at) VALUES (?, ?, ?)").run(v.content_id, JSON.stringify(v), v.created_at);
  }
  getContentItem(id: string): ContentItem | undefined { return this.getDoc("content_item", id, (x) => ContentItemSchema.parse(x)); }
  updateContentItem(c: ContentItem): void {
    const v = ContentItemSchema.parse(c);
    const res = this.db.prepare("UPDATE content_item SET data = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(v), this.clock.now(), v.content_id);
    if (res.changes === 0) throw new HarnessError("NOT_FOUND", `content_item ${v.content_id} not found`);
  }
  listContentItems(): ContentItem[] { return this.listDocs("SELECT data FROM content_item ORDER BY rowid", [], (x) => ContentItemSchema.parse(x)); }
  private variantKey(k: { content_id: string; profile_id: string; profile_revision: number; options_digest: string }): string {
    return `${k.content_id}|${k.profile_id}@${k.profile_revision}|${k.options_digest}`;
  }
  insertContentVariant(variant: ContentVariant): void {
    const v = ContentVariantSchema.parse(variant);
    this.db.prepare("INSERT INTO content_variant (id, content_id, profile_id, variant_key, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(v.variant_id, v.content_id, v.profile_id, this.variantKey(v), JSON.stringify(v), v.created_at);
  }
  getContentVariant(id: string): ContentVariant | undefined { return this.getDoc("content_variant", id, (x) => ContentVariantSchema.parse(x)); }
  findContentVariant(key: { content_id: string; profile_id: string; profile_revision: number; options_digest: string }): ContentVariant | undefined {
    const row = this.db.prepare("SELECT data FROM content_variant WHERE variant_key = ?").get(this.variantKey(key)) as Row | undefined;
    return row ? ContentVariantSchema.parse(JSON.parse(row.data)) : undefined;
  }
  listContentVariants(contentId: string): ContentVariant[] {
    return this.listDocs("SELECT data FROM content_variant WHERE content_id = ? ORDER BY rowid", [contentId], (x) => ContentVariantSchema.parse(x));
  }

  // ---- resources ----
  countLeasedResources(): Record<string, number> {
    const held: Record<string, number> = {};
    for (const r of this.db.prepare("SELECT resources FROM lease").all() as { resources: string }[]) {
      for (const name of JSON.parse(r.resources) as string[]) held[name] = (held[name] ?? 0) + 1;
    }
    return held;
  }
```

Trong `claim()`: sau khi lấy `rows`, thêm `const held = this.countLeasedResources(); const cap = params.resourceCapacity ?? {};` và trong vòng lặp, sau kiểm capability:
```ts
        if (stage.requires_resources.some((r) => (held[r] ?? 0) >= (cap[r] ?? 0))) continue; // no free slot for a required resource
```
Khi tạo lease: `const lease: Lease = { ..., resources: stage.requires_resources };` và INSERT thêm cột:
```ts
        this.db.prepare("INSERT OR REPLACE INTO lease (stage_run_id, attempt_id, owner, expires_at, fencing_token, resources) VALUES (?, ?, ?, ?, ?, ?)").run(lease.stage_run_id, lease.attempt_id, lease.owner, lease.expires_at, lease.fencing_token, JSON.stringify(lease.resources));
```
`getLease` và `reapExpiredLeases` đọc thêm cột `resources` và parse: `SELECT stage_run_id, attempt_id, owner, expires_at, fencing_token, resources FROM lease ...`, rồi `LeaseSchema.parse({ ...row, resources: JSON.parse(row.resources) })`.

- [ ] **Step 5: Chạy test, xác nhận pass**

Run: `pnpm vitest run packages/core && pnpm build && pnpm typecheck`
Expected: PASS; typecheck toàn workspace sạch trở lại.

- [ ] **Step 6: Commit**

```bash
git add migrations packages/core
git commit -m "feat(core): catalog tables and resource-aware claim with lease resources

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 5: `SourceCatalog`: ingest, verify, content, variant

**Files:**
- Create: `packages/core/src/source-catalog/prober.ts`, `packages/core/src/source-catalog/catalog.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/source-catalog/catalog.test.ts`

**Interfaces:**
- Consumes: `store.*SourceItem/ContentItem/ContentVariant`, `sha256File`, `canonicalDigest`, `MediaProber`, `ProductionProfile.options_schema/options_defaults`.
- Produces: `class NullMediaProber implements MediaProber` (luôn trả `null`); `class SourceCatalog { constructor(deps: { store; dataRoot; prober: MediaProber; clock: Clock; materialize: "link"|"copy"|"reference" }); ingest(p: IngestInput): Promise<{ source: SourceItem; created: boolean }>; verify(): Promise<VerifyRow[]>; createContent(p: { source_ids: string[]; title: string }): ContentItem; resolveOptions(profile, options): Record<string, unknown>; getOrCreateVariant(p: { content_id: string; profile: ProductionProfile; options: Record<string, unknown> }): { variant: ContentVariant; created: boolean } }`; `IngestInput = { path: string; collection?: string; rights_status?: "unknown"|"cleared"|"restricted"; language?: string | null }`; `VerifyRow = { source_id: string; ok: boolean; reason: string | null }`; `normalizedDir(dataRoot, sourceId)`.
- Quy tắc: `ingest` tính sha256 của file; trùng checksum → trả source cũ, `created: false`, không ghi gì; `mime_type` suy từ đuôi file bằng bảng nhỏ (`mp4→video/mp4, mov→video/quicktime, mkv→video/x-matroska, wav→audio/wav, mp3→audio/mpeg, png→image/png, jpg/jpeg→image/jpeg, txt→text/plain, md→text/markdown, json→application/json, srt→text/plain`, khác → `application/octet-stream`); `materialize: link` = hardlink vào `sources/normalized/<src_id>/<basename>` (fallback copy khi lỗi), `copy` = copy, `reference` = `uri` trỏ thẳng file gốc; `source.json` luôn ghi. `resolveOptions` = `options_defaults` ⊕ options, key lạ hoặc value ngoài `options_schema` → `CONFIG_INVALID`. `verify` đọc lại checksum của `uri`, so với DB.

- [ ] **Step 1: Viết test thất bại**

`packages/core/test/source-catalog/catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isHarnessError, ProductionProfileSchema } from "@harness/contracts";
import { SourceCatalog, NullMediaProber, normalizedDir } from "../../src/index.js";
import { sha256String } from "../../src/artifacts/checksum.js";
import { openTempStore } from "../helpers.js";

const profile = ProductionProfileSchema.parse({
  schema_version: "harness.production-profile/v1", profile_id: "footage", revision: 1, status: "active", workflow_release: "footage-production@1.0.0",
  options_schema: { voice: ["none", "tts", "original"], avatar: ["none", "heygen"] }, options_defaults: { voice: "none", avatar: "none" },
});
function world(materialize: "link" | "copy" | "reference" = "link") {
  const t = openTempStore();
  const raw = mkdtempSync(join(tmpdir(), "raw-"));
  const file = join(raw, "clip.mp4"); writeFileSync(file, "fake video bytes");
  const catalog = new SourceCatalog({ store: t.store, dataRoot: t.dir, prober: new NullMediaProber(), clock: t.clock, materialize });
  return { ...t, raw, file, catalog };
}

describe("SourceCatalog", () => {
  it("ingests a file once, normalises it and dedupes by checksum", async () => {
    const { store, dir, file, catalog } = world();
    const first = await catalog.ingest({ path: file, collection: "main", rights_status: "cleared" });
    expect(first.created).toBe(true);
    expect(first.source.checksum).toBe(sha256String("fake video bytes"));
    expect(first.source.mime_type).toBe("video/mp4");
    expect(first.source.size_bytes).toBe(16);
    expect(first.source.media).toBeNull();
    const norm = normalizedDir(dir, first.source.source_id);
    expect(existsSync(join(norm, "clip.mp4"))).toBe(true);
    expect(JSON.parse(readFileSync(join(norm, "source.json"), "utf8")).source_id).toBe(first.source.source_id);
    expect(fileURLToPath(first.source.uri)).toBe(join(norm, "clip.mp4"));
    const again = await catalog.ingest({ path: file });
    expect(again.created).toBe(false);
    expect(again.source.source_id).toBe(first.source.source_id);
    expect(store.listSourceItems()).toHaveLength(1);
  });
  it("reference mode keeps the original uri", async () => {
    const { file, catalog } = world("reference");
    const { source } = await catalog.ingest({ path: file });
    expect(fileURLToPath(source.uri)).toBe(file);
    expect(source.original_uri).toBe(source.uri);
  });
  it("verify reports sources whose bytes no longer match", async () => {
    const { file, catalog } = world("copy");
    const { source } = await catalog.ingest({ path: file });
    expect(await catalog.verify()).toEqual([{ source_id: source.source_id, ok: true, reason: null }]);
    writeFileSync(fileURLToPath(source.uri), "tampered");
    expect((await catalog.verify())[0]).toMatchObject({ ok: false, reason: expect.stringContaining("checksum") });
  });
  it("creates content and variants with validated, defaulted options", async () => {
    const { store, file, catalog } = world();
    const { source } = await catalog.ingest({ path: file });
    const content = catalog.createContent({ source_ids: [source.source_id], title: "Episode 1" });
    expect(store.getContentItem(content.content_id)?.title).toBe("Episode 1");
    const a = catalog.getOrCreateVariant({ content_id: content.content_id, profile, options: { voice: "tts" } });
    expect(a.created).toBe(true);
    expect(a.variant.options).toEqual({ voice: "tts", avatar: "none" });
    const b = catalog.getOrCreateVariant({ content_id: content.content_id, profile, options: { avatar: "none", voice: "tts" } });
    expect(b.created).toBe(false);
    expect(b.variant.variant_id).toBe(a.variant.variant_id);
    const c = catalog.getOrCreateVariant({ content_id: content.content_id, profile, options: {} });
    expect(c.variant.variant_id).not.toBe(a.variant.variant_id);
    try { catalog.getOrCreateVariant({ content_id: content.content_id, profile, options: { voice: "robot" } }); throw new Error("no throw"); }
    catch (e) { expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true); }
    try { catalog.getOrCreateVariant({ content_id: content.content_id, profile, options: { colour: "red" } }); throw new Error("no throw"); }
    catch (e) { expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true); }
    try { catalog.createContent({ source_ids: ["src_01J00000000000000000000000"], title: "x" }); throw new Error("no throw"); }
    catch (e) { expect(isHarnessError(e, "NOT_FOUND")).toBe(true); }
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/core/test/source-catalog`
Expected: FAIL, thiếu module.

- [ ] **Step 3: Viết `prober.ts` và `catalog.ts`**

`packages/core/src/source-catalog/prober.ts`:

```ts
import type { MediaProber } from "@harness/contracts";
/** Used until an ffprobe adapter is wired (plan 2B): no media metadata, mime from the file extension only. */
export class NullMediaProber implements MediaProber {
  async probe(_path: string): Promise<null> { return null; }
}
```

`packages/core/src/source-catalog/catalog.ts`:

```ts
import { copyFileSync, existsSync, linkSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HarnessError, newId, type Clock, type ContentItem, type ContentVariant, type MediaProber, type ProductionProfile, type SourceItem, type StateStore } from "@harness/contracts";
import { canonicalDigest, sha256File } from "../artifacts/checksum.js";

export interface IngestInput { path: string; collection?: string; rights_status?: "unknown" | "cleared" | "restricted"; language?: string | null }
export interface VerifyRow { source_id: string; ok: boolean; reason: string | null }

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".wav": "audio/wav", ".mp3": "audio/mpeg",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".srt": "text/plain",
};

export function normalizedDir(dataRoot: string, sourceId: string): string { return join(dataRoot, "sources", "normalized", sourceId); }

export class SourceCatalog {
  constructor(private readonly d: { store: StateStore; dataRoot: string; prober: MediaProber; clock: Clock; materialize: "link" | "copy" | "reference" }) {}

  async ingest(p: IngestInput): Promise<{ source: SourceItem; created: boolean }> {
    const src = resolve(p.path);
    if (!existsSync(src) || !statSync(src).isFile()) throw new HarnessError("NOT_FOUND", `source file not found: ${src}`, { path: src });
    const { checksum, size_bytes } = await sha256File(src);
    const existing = this.d.store.findSourceItemByChecksum(checksum);
    if (existing) return { source: existing, created: false };
    const probed = await this.d.prober.probe(src);
    const id = newId("source_item");
    const dir = normalizedDir(this.d.dataRoot, id);
    mkdirSync(dir, { recursive: true });
    let uri = pathToFileURL(src).href;
    if (this.d.materialize !== "reference") {
      const dest = join(dir, basename(src));
      if (this.d.materialize === "copy") copyFileSync(src, dest);
      else { try { linkSync(src, dest); } catch { copyFileSync(src, dest); } }
      uri = pathToFileURL(dest).href;
    }
    const source: SourceItem = {
      schema_version: "harness.source-item/v1", source_id: id, uri, original_uri: pathToFileURL(src).href, checksum, collection: p.collection ?? "main",
      mime_type: probed?.mime_type ?? MIME_BY_EXT[extname(src).toLowerCase()] ?? "application/octet-stream", size_bytes, media: probed?.media ?? null,
      rights_status: p.rights_status ?? "unknown", language: p.language ?? null, duration_seconds: probed?.duration_seconds ?? null, ingested_at: this.d.clock.now(),
    };
    writeFileSync(join(dir, "source.json"), JSON.stringify(source, null, 2) + "\n");
    try { this.d.store.insertSourceItem(source); }
    catch (e) {
      const winner = this.d.store.findSourceItemByChecksum(checksum);
      if (winner && /UNIQUE/.test(String((e as Error).message))) {
        rmSync(dir, { recursive: true, force: true }); // a concurrent ingest won; drop our normalized copy (review Task 5)
        return { source: winner, created: false };
      }
      throw e;
    }
    return { source, created: true };
  }

  async verify(): Promise<VerifyRow[]> {
    const rows: VerifyRow[] = [];
    for (const s of this.d.store.listSourceItems()) {
      const path = fileURLToPath(s.uri);
      if (!existsSync(path)) { rows.push({ source_id: s.source_id, ok: false, reason: "file missing" }); continue; }
      const actual = await sha256File(path);
      rows.push(actual.checksum === s.checksum ? { source_id: s.source_id, ok: true, reason: null } : { source_id: s.source_id, ok: false, reason: `checksum mismatch: ${actual.checksum}` });
    }
    return rows;
  }

  createContent(p: { source_ids: string[]; title: string }): ContentItem {
    for (const id of p.source_ids) if (!this.d.store.getSourceItem(id)) throw new HarnessError("NOT_FOUND", `source not found: ${id}`, { source_id: id });
    const content: ContentItem = { schema_version: "harness.content-item/v1", content_id: newId("content_item"), source_ids: p.source_ids, revision: 1, title: p.title, created_at: this.d.clock.now() };
    this.d.store.insertContentItem(content);
    return content;
  }

  /** options_defaults ⊕ options, validated against options_schema (unknown key or value → CONFIG_INVALID). */
  resolveOptions(profile: ProductionProfile, options: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...profile.options_defaults, ...options };
    for (const [k, v] of Object.entries(merged)) {
      const allowed = profile.options_schema[k];
      if (!allowed) throw new HarnessError("CONFIG_INVALID", `unknown option "${k}" for profile ${profile.profile_id}`, { key: k });
      if (typeof v !== "string" || !allowed.includes(v)) throw new HarnessError("CONFIG_INVALID", `option ${k}=${String(v)} not in [${allowed.join(", ")}]`, { key: k, value: v });
    }
    return Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
  }

  getOrCreateVariant(p: { content_id: string; profile: ProductionProfile; options: Record<string, unknown> }): { variant: ContentVariant; created: boolean } {
    if (!this.d.store.getContentItem(p.content_id)) throw new HarnessError("NOT_FOUND", `content not found: ${p.content_id}`, { content_id: p.content_id });
    const options = this.resolveOptions(p.profile, p.options);
    const key = { content_id: p.content_id, profile_id: p.profile.profile_id, profile_revision: p.profile.revision, options_digest: canonicalDigest(options) };
    const existing = this.d.store.findContentVariant(key);
    if (existing) return { variant: existing, created: false };
    const variant: ContentVariant = { schema_version: "harness.content-variant/v1", variant_id: newId("content_variant"), ...key, options, created_at: this.d.clock.now() };
    this.d.store.insertContentVariant(variant);
    return { variant, created: true };
  }
}
```

Thêm vào `packages/core/src/index.ts`: `export * from "./source-catalog/prober.js"; export * from "./source-catalog/catalog.js";`

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `pnpm vitest run packages/core && pnpm --filter @harness/core typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): source catalog with ingest, verify, content and options-keyed variants

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Planner: `when`, dependency mềm, plan theo content/variant

**Files:**
- Create: `packages/core/src/source-catalog/when.ts`
- Modify: `packages/core/src/orchestration/planner.ts`, `packages/core/src/artifacts/registry.ts` (`acceptedInputsFor`), `packages/core/src/index.ts`
- Test: `packages/core/test/source-catalog/when.test.ts`, `packages/core/test/orchestration/planner.test.ts`

**Interfaces:**
- Consumes: Task 3 schema, `SourceCatalog` (test), `resolveEffectiveConfig`.
- Produces: `parseWhen(expr): { key: string; op: "=="|"!="; value: string }`, `evaluateWhen(expr, options): boolean`; `PlanInput` thêm `content?: ContentItem`, `variant?: ContentVariant`; `Planner.plan` bỏ stage có `when` sai, nối xuyên `depends_on`, lọc `depends_on_optional`, ghi `content_id/variant_id/source_id` lên run, `requires_resources` lên stage, `required_checks` gộp `required_checks_by_stage[key]`; `enqueue`/`advance` coi `depends_on_optional` như dependency phải SUCCEEDED khi tồn tại; `acceptedInputsFor` gộp cả `depends_on_optional`.
- `when` tham chiếu key không có trong `profile.options_schema` → `CONFIG_INVALID` trước khi ghi DB. Mọi stage bị bỏ được ghi vào event `run.created.payload.skipped_stages`.

- [ ] **Step 1: Viết test thất bại**

`packages/core/test/source-catalog/when.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evaluateWhen, parseWhen } from "../../src/source-catalog/when.js";

describe("when expressions", () => {
  it("parses == and !=", () => {
    expect(parseWhen('options.voice == "tts"')).toEqual({ key: "voice", op: "==", value: "tts" });
    expect(parseWhen('options.avatar != "none"')).toEqual({ key: "avatar", op: "!=", value: "none" });
  });
  it("evaluates against options and treats a missing key as empty string", () => {
    expect(evaluateWhen('options.voice == "tts"', { voice: "tts" })).toBe(true);
    expect(evaluateWhen('options.voice == "tts"', { voice: "none" })).toBe(false);
    expect(evaluateWhen('options.avatar != "none"', {})).toBe(true);
  });
  it("rejects anything else", () => {
    expect(() => parseWhen("voice == tts")).toThrow();
  });
});
```

Thêm vào `packages/core/test/orchestration/planner.test.ts` một `describe` mới (file đã import `Planner`, `openTempStore`, `HARNESS_ROOT`, loaders):

```ts
import { WorkflowDefinitionSchema, ProductionProfileSchema, isHarnessError } from "@harness/contracts";
import { canonicalDigest } from "../../src/artifacts/checksum.js";
import { SourceCatalog, NullMediaProber } from "../../src/index.js";

const optWorkflow = { definition: WorkflowDefinitionSchema.parse({
  schema_version: "harness.workflow/v1", id: "opt", version: "1.0.0", defaults: {},
  stages: [
    { key: "script", executor: { type: "script", script: "fake-stage" } },
    { key: "tts", executor: { type: "script", script: "fake-stage" }, depends_on: ["script"], when: 'options.voice == "tts"', requires_resources: ["gpu"] },
    { key: "cut", executor: { type: "script", script: "fake-stage" }, depends_on: ["script"] },
    { key: "assemble", executor: { type: "script", script: "fake-stage" }, depends_on: ["cut"], depends_on_optional: ["tts"] },
    { key: "thumb", executor: { type: "script", script: "fake-stage" }, depends_on: ["tts"] },
  ],
}), digest: "sha256:" + "e".repeat(64) };
const optProfile = ProductionProfileSchema.parse({
  schema_version: "harness.production-profile/v1", profile_id: "footage", revision: 1, status: "active", workflow_release: "opt@1.0.0",
  options_schema: { voice: ["none", "tts"] }, options_defaults: { voice: "none" }, verification: { required_checks_by_stage: { assemble: ["media-probe"] } },
});

describe("Planner with options", () => {
  function setup(options: Record<string, unknown>) {
    const t = openTempStore();
    const catalog = new SourceCatalog({ store: t.store, dataRoot: t.dir, prober: new NullMediaProber(), clock: t.clock, materialize: "reference" });
    const content = catalog.createContent({ source_ids: [], title: "c" });
    const { variant } = catalog.getOrCreateVariant({ content_id: content.content_id, profile: optProfile, options });
    const planner = new Planner(t.store);
    const run = planner.plan({ workflow: optWorkflow, profile: optProfile, harness: loadHarnessConfig(HARNESS_ROOT), projectId: "p", portfolioId: "pf", content, variant });
    return { ...t, planner, run, variant };
  }
  it("drops stages whose when is false and rewires dependants through them", () => {
    const { store, run } = setup({ voice: "none" });
    const stages = store.listStageRuns(run.run_id);
    expect(stages.map((s) => s.stage_key)).toEqual(["script", "cut", "assemble", "thumb"]);
    const byKey = Object.fromEntries(stages.map((s) => [s.stage_key, s]));
    expect(byKey.assemble!.depends_on).toEqual(["cut"]);
    expect(byKey.assemble!.depends_on_optional).toEqual([]);
    expect(byKey.thumb!.depends_on).toEqual(["script"]); // tts skipped -> inherits tts's dependencies
    expect(byKey.assemble!.required_checks).toContain("media-probe");
    expect(store.listEvents({ run_id: run.run_id })[0]?.payload.skipped_stages).toEqual(["tts"]);
  });
  it("keeps optional dependencies when the stage exists and gates release on them", () => {
    const { store, planner, run, clock, variant } = setup({ voice: "tts" });
    expect(run.variant_id).toBe(variant.variant_id);
    expect(run.content_id).toBe(variant.content_id);
    const byKey = Object.fromEntries(store.listStageRuns(run.run_id).map((s) => [s.stage_key, s]));
    expect(byKey.assemble!.depends_on_optional).toEqual(["tts"]);
    expect(byKey.tts!.requires_resources).toEqual(["gpu"]);
    planner.enqueue(run.run_id);
    const finish = (key: string, caps: string[] = []) => {
      const c = store.claim({ owner: "w", capabilities: caps, now: clock.now(), leaseSeconds: 90, resourceCapacity: { gpu: 1 } })!;
      expect(c.stageRun.stage_key).toBe(key);
      const ev = { run_id: run.run_id, stage_run_id: c.stageRun.stage_run_id, attempt_id: c.attempt.attempt_id, project_id: "p", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info" as const, event_type: "stage.test", payload: {} };
      store.transition("stage_run", c.stageRun.stage_run_id, "CLAIMED", "RUNNING", ev);
      store.transition("stage_run", c.stageRun.stage_run_id, "RUNNING", "VERIFYING", ev);
      store.transition("stage_run", c.stageRun.stage_run_id, "VERIFYING", "SUCCEEDED", ev);
      store.releaseLease(c.stageRun.stage_run_id, c.lease.fencing_token);
      return planner.advance(run.run_id).released;
    };
    expect(finish("script").sort()).toEqual(["cut", "tts"]);
    expect(finish("tts")).toEqual(["thumb"]);           // assemble still waits for cut
    expect(finish("cut")).toEqual(["assemble"]);        // both cut and optional tts are done
  });
  it("rejects a when key that the profile does not declare", () => {
    const t = openTempStore();
    const badWf = { ...optWorkflow, definition: WorkflowDefinitionSchema.parse({ ...optWorkflow.definition, stages: [{ key: "a", executor: { type: "script", script: "x" }, when: 'options.colour == "red"' }] }) };
    try { new Planner(t.store).plan({ workflow: badWf, profile: optProfile, harness: loadHarnessConfig(HARNESS_ROOT), projectId: "p", portfolioId: "pf" }); throw new Error("no throw"); }
    catch (e) { expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true); }
    expect(t.store.listRuns()).toHaveLength(0);
  });
  it("still plans without content/variant (options default to the profile defaults)", () => {
    const t = openTempStore();
    const run = new Planner(t.store).plan({ workflow: optWorkflow, profile: optProfile, harness: loadHarnessConfig(HARNESS_ROOT), projectId: "p", portfolioId: "pf" });
    expect(t.store.listStageRuns(run.run_id).map((s) => s.stage_key)).toEqual(["script", "cut", "assemble", "thumb"]);
    expect(run.variant_id).toBeUndefined();
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/core/test/source-catalog/when.test.ts packages/core/test/orchestration/planner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Viết `when.ts`**

`packages/core/src/source-catalog/when.ts`:

```ts
import { HarnessError, WHEN_RE } from "@harness/contracts";

export interface WhenClause { key: string; op: "==" | "!="; value: string }

export function parseWhen(expr: string): WhenClause {
  const m = WHEN_RE.exec(expr);
  if (!m) throw new HarnessError("WORKFLOW_INVALID", `invalid when expression: ${expr}`, { expr });
  return { key: m[1]!, op: m[2] as "==" | "!=", value: m[3]! };
}

export function evaluateWhen(expr: string, options: Record<string, unknown>): boolean {
  const c = parseWhen(expr);
  const actual = options[c.key] === undefined ? "" : String(options[c.key]);
  return c.op === "==" ? actual === c.value : actual !== c.value;
}
```
(`WHEN_RE` được export từ `packages/contracts/src/config.ts` ở Task 3 — kiểm tra nó có trong `index.ts` của contracts; `export * from "./config.js"` đã bao gồm.)

- [ ] **Step 4: Sửa `planner.ts`**

Thay `PlanInput` và `plan()`:

```ts
import { HarnessError, newId, type Attempt, type ContentItem, type ContentVariant, type EventInput, type HarnessConfig, type ProductionProfile, type Run, type StageDefinition, type StageRun, type StateStore } from "@harness/contracts";
import { evaluateWhen, parseWhen } from "../source-catalog/when.js";

export interface PlanInput {
  workflow: LoadedWorkflow; profile: ProductionProfile; harness: HarnessConfig;
  projectId: string; portfolioId: string; runOverrides?: Record<string, unknown>; channelOverrides?: Record<string, unknown>;
  sourceId?: string; content?: ContentItem; variant?: ContentVariant;
}

/** Stages whose `when` is false are dropped; dependants inherit the dropped stage's own dependencies (transitively). */
export function resolveStageGraph(stages: StageDefinition[], options: Record<string, unknown>): { kept: { def: StageDefinition; depends_on: string[]; depends_on_optional: string[] }[]; skipped: string[] } {
  const byKey = new Map(stages.map((s) => [s.key, s]));
  const skipped = new Set(stages.filter((s) => s.when && !evaluateWhen(s.when, options)).map((s) => s.key));
  const expand = (deps: string[], seen = new Set<string>()): string[] => {
    const out: string[] = [];
    for (const d of deps) {
      if (!skipped.has(d)) { if (!out.includes(d)) out.push(d); continue; }
      if (seen.has(d)) continue;
      seen.add(d);
      for (const x of expand(byKey.get(d)!.depends_on, seen)) if (!out.includes(x)) out.push(x);
    }
    return out;
  };
  const kept = stages.filter((s) => !skipped.has(s.key)).map((def) => ({
    def,
    depends_on: expand(def.depends_on),
    depends_on_optional: def.depends_on_optional.filter((d) => !skipped.has(d)),
  }));
  // a required dependency must not also be listed as optional after rewiring
  for (const k of kept) k.depends_on_optional = k.depends_on_optional.filter((d) => !k.depends_on.includes(d));
  return { kept, skipped: [...skipped] };
}
```

Trong class `Planner`, `plan()`:

```ts
  plan(input: PlanInput): Run {
    const options = input.variant?.options ?? input.profile.options_defaults;
    for (const s of input.workflow.definition.stages) {
      if (!s.when) continue;
      const { key } = parseWhen(s.when);
      if (!(key in input.profile.options_schema)) throw new HarnessError("CONFIG_INVALID", `stage ${s.key}: when references option "${key}" not declared by profile ${input.profile.profile_id}`, { stage: s.key, key });
    }
    const { snapshot, digest } = resolveEffectiveConfig({ /* như cũ */ });
    const graph = resolveStageGraph(input.workflow.definition.stages, options);
    return this.store.transaction(() => {
      const now = (this.store as { clock?: { now(): string } }).clock?.now() ?? new Date().toISOString();
      const sourceId = input.sourceId ?? input.content?.source_ids[0];
      const run: Run = {
        schema_version: "harness.run/v1", run_id: newId("run"), project_id: input.projectId, portfolio_id: input.portfolioId,
        workflow_release: { id: input.workflow.definition.id, version: input.workflow.definition.version, digest: input.workflow.digest },
        profile_snapshot: { id: input.profile.profile_id, revision: input.profile.revision },
        ...(sourceId ? { source_id: sourceId } : {}),
        ...(input.content ? { content_id: input.content.content_id } : {}),
        ...(input.variant ? { variant_id: input.variant.variant_id } : {}),
        state: "DRAFT", effective_config_snapshot: snapshot, effective_config_digest: digest, total_cost_usd: 0, created_at: now, updated_at: now,
      };
      this.store.insertRun(run);
      for (const { def: s, depends_on, depends_on_optional } of graph.kept) {
        const stage: StageRun = {
          schema_version: "harness.stage-run/v1", stage_run_id: newId("stage_run"), run_id: run.run_id, stage_key: s.key, executor: s.executor,
          depends_on, depends_on_optional, requires_resources: s.requires_resources, required_capabilities: s.required_capabilities,
          required_checks: [...new Set([...s.required_checks, ...input.profile.verification.required_checks, ...(input.profile.verification.required_checks_by_stage[s.key] ?? [])])],
          retry: s.retry, stage_config: s.config, state: "PENDING", attempt_count: 0, result_failures: 0, created_at: now, updated_at: now,
        };
        this.store.insertStageRun(stage);
      }
      this.store.appendEvent(eventFor(run, null, null, "run.created", "info", { stages: graph.kept.length, skipped_stages: graph.skipped, options }));
      return run;
    });
  }
```

`enqueue`: điều kiện root là `s.depends_on.length === 0 && s.depends_on_optional.length === 0`. `advance`: điều kiện release là
```ts
        const deps = [...s.depends_on, ...s.depends_on_optional];
        if (deps.every((d) => byKey.get(d)?.state === "SUCCEEDED")) { this.ready(run, s); released.push(s.stage_key); }
```
Export `resolveStageGraph` qua `index.ts` (đã `export *` từ planner) và thêm `export * from "./source-catalog/when.js";`.

`acceptedInputsFor` trong `registry.ts`:
```ts
export function acceptedInputsFor(store: StateStore, stage: StageRun): Artifact[] {
  const wanted = new Set([...stage.depends_on, ...stage.depends_on_optional]);
  const upstream = store.listStageRuns(stage.run_id).filter((s) => wanted.has(s.stage_key));
  return upstream.flatMap((s) => store.listArtifacts({ stage_run_id: s.stage_run_id, status: "ACCEPTED" }));
}
```
(Task 9 sẽ mở rộng cho artifact tái sử dụng.)

- [ ] **Step 5: Chạy test, xác nhận pass**

Run: `pnpm vitest run packages/core && pnpm build && pnpm typecheck`
Expected: PASS. Test planner cũ ("creates a DRAFT run with one PENDING stage per workflow stage…") vẫn đúng vì workflow mẫu không có `when`.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): planner evaluates when, rewires skipped stages, honours optional dependencies and plans per variant

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 7: Artifact thư mục (`kind: directory`)

**Files:**
- Create: `packages/core/src/artifacts/directory.ts`
- Modify: `packages/core/src/artifacts/registry.ts`, `packages/core/src/environment/workspace.ts`, `packages/core/src/verification/checkers.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/artifacts/directory.test.ts`, `packages/core/test/artifacts/registry.test.ts`, `packages/core/test/environment/workspace.test.ts`, `packages/core/test/verification/verifier.test.ts`

**Interfaces:**
- Consumes: `StageOutput.kind`, `StageInput.kind`, `sha256File`, `canonicalDigest`.
- Produces: `listDirectoryFiles(dir): Promise<DirectoryEntry[]>` (`{ path: string /* relative, forward slashes, sorted */; checksum; size_bytes }`), `directoryDigest(entries): { checksum: Checksum; size_bytes: number }` (checksum = `canonicalDigest(entries)`, size = tổng), `copyTree(src, dest)` (hardlink từng file, fallback copy). Registry: output `directory` được verify bằng `directoryDigest`, chuyển bằng `renameSync` cả thư mục, `manifest.json` thêm `files: DirectoryEntry[]`; artifact `uri` trỏ tới thư mục. `materializeInputs`: input `directory` copy cây vào `input/<artifact_id>/<basename>/`, `StageInput.kind = "directory"`. Checker `output-exists` chấp nhận thư mục; `checksum-match` so `directoryDigest`.
- `ArtifactManifestSchema` thêm `files: z.array(directoryEntrySchema).optional()` (contracts) — sửa ở task này, sinh lại schema.

- [ ] **Step 1: Viết test thất bại**

`packages/core/test/artifacts/directory.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyTree, directoryDigest, listDirectoryFiles } from "../../src/artifacts/directory.js";
import { sha256String } from "../../src/artifacts/checksum.js";

describe("directory artifacts", () => {
  it("lists files recursively with stable order and forward slashes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "da-"));
    mkdirSync(join(dir, "b")); writeFileSync(join(dir, "b", "2.txt"), "two"); writeFileSync(join(dir, "1.txt"), "one");
    const entries = await listDirectoryFiles(dir);
    expect(entries).toEqual([
      { path: "1.txt", checksum: sha256String("one"), size_bytes: 3 },
      { path: "b/2.txt", checksum: sha256String("two"), size_bytes: 3 },
    ]);
    const d1 = directoryDigest(entries);
    expect(d1.size_bytes).toBe(6);
    writeFileSync(join(dir, "b", "2.txt"), "TWO");
    expect(directoryDigest(await listDirectoryFiles(dir)).checksum).not.toBe(d1.checksum);
  });
  it("copies a tree", async () => {
    const src = mkdtempSync(join(tmpdir(), "da-")); mkdirSync(join(src, "x")); writeFileSync(join(src, "x", "f.bin"), "z");
    const dest = join(mkdtempSync(join(tmpdir(), "da-")), "copy");
    await copyTree(src, dest);
    expect(readFileSync(join(dest, "x", "f.bin"), "utf8")).toBe("z");
  });
});
```

Thêm vào `packages/core/test/artifacts/registry.test.ts` (dùng `setup()` có sẵn):

```ts
  it("stages a directory output as one artifact with a file listing in the manifest", async () => {
    const { store, ws, registry, ctx, stage } = await setup();
    mkdirSync(join(ws, "output", "cuts"), { recursive: true });
    writeFileSync(join(ws, "output", "cuts", "001.mp4"), "aaa"); writeFileSync(join(ws, "output", "cuts", "002.mp4"), "bbbb");
    const entries = await listDirectoryFiles(join(ws, "output", "cuts"));
    const { checksum, size_bytes } = directoryDigest(entries);
    const staged = await registry.stageOutputs({ workspaceDir: ws, outputs: [{ path: "output/cuts", type: "clip_set", checksum, size_bytes, kind: "directory" }], mimeTypes: { clip_set: "application/x-directory" }, ctx });
    const [art] = store.transaction(() => registry.commitAccepted(staged, ctx));
    expect(art!.size_bytes).toBe(7);
    expect(existsSync(join(fileURLToPath(art!.uri), "002.mp4"))).toBe(true);
    expect(existsSync(join(ws, "output", "cuts"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(fileURLToPath(art!.uri), "..", "manifest.json"), "utf8"));
    expect(manifest.files.map((f: { path: string }) => f.path)).toEqual(["001.mp4", "002.mp4"]);
    expect(store.listArtifacts({ stage_run_id: stage.stage_run_id, status: "ACCEPTED" })).toHaveLength(1);
  });
  it("rejects a directory output whose digest does not match", async () => {
    const { ws, registry, ctx } = await setup();
    mkdirSync(join(ws, "output", "cuts"), { recursive: true }); writeFileSync(join(ws, "output", "cuts", "001.mp4"), "aaa");
    await expect(registry.stageOutputs({ workspaceDir: ws, outputs: [{ path: "output/cuts", type: "clip_set", checksum: sha256String("nope"), size_bytes: 3, kind: "directory" }], mimeTypes: {}, ctx })).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
  });
```
(import `listDirectoryFiles`, `directoryDigest` từ `../../src/artifacts/directory.js`.)

Thêm vào `packages/core/test/environment/workspace.test.ts`:

```ts
  it("materialises a directory artifact as a tree under input/<artifact_id>/", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    const srcDir = join(root, "cuts"); mkdirSync(srcDir); writeFileSync(join(srcDir, "001.mp4"), "aaa");
    const art: Artifact = {
      schema_version: "harness.artifact/v1", artifact_id: newId("artifact"), run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"),
      type: "clip_set", status: "ACCEPTED", uri: pathToFileURL(srcDir).href, checksum: "sha256:" + "a".repeat(64), size_bytes: 3, mime_type: "application/x-directory",
      lineage: { input_artifacts: [], source_items: [] }, reproducibility: { workflow_release: "w@1.0.0", production_profile: "footage@1", channel_config_revision: null, executor_version: "x", model_parameters_digest: null },
      checks: [], created_at: "2026-09-12T00:00:00.000Z", updated_at: "2026-09-12T00:00:00.000Z",
    };
    const dir = await createWorkspace(root, "run_A", "assemble", "attempt_D");
    const inputs = await materializeInputs(dir, [art]);
    expect(inputs).toEqual([{ artifact_id: art.artifact_id, checksum: art.checksum, path: `input/${art.artifact_id}/cuts`, type: "clip_set", kind: "directory" }]);
    expect(readFileSync(join(dir, inputs[0]!.path, "001.mp4"), "utf8")).toBe("aaa");
  });
```
(import `mkdirSync` nếu thiếu.)

Thêm vào `packages/core/test/verification/verifier.test.ts`:

```ts
  it("output-exists and checksum-match handle directory outputs", async () => {
    const { ws, request, result } = fixture("hello", sha256String("hello"));
    mkdirSync(join(ws, "output", "set")); writeFileSync(join(ws, "output", "set", "a.txt"), "A");
    const entries = await listDirectoryFiles(join(ws, "output", "set"));
    const { checksum, size_bytes } = directoryDigest(entries);
    const withDir = { ...result, outputs: [...result.outputs, { path: "output/set", type: "image_set", checksum, size_bytes, kind: "directory" as const }] };
    const ok = await new Verifier(BUILTIN_CHECKERS).verify({ request, result: withDir, workspaceDir: ws }, ["output-exists", "checksum-match"]);
    expect(ok.allRequiredPassed).toBe(true);
    writeFileSync(join(ws, "output", "set", "a.txt"), "B");
    const bad = await new Verifier(BUILTIN_CHECKERS).verify({ request, result: withDir, workspaceDir: ws }, ["checksum-match"]);
    expect(bad.results[0]).toMatchObject({ verdict: "fail", evidence: { path: "output/set" } });
  });
```
(import `listDirectoryFiles`, `directoryDigest`.)

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/core/test/artifacts packages/core/test/environment packages/core/test/verification`
Expected: FAIL.

- [ ] **Step 3: Viết `directory.ts`**

`packages/core/src/artifacts/directory.ts`:

```ts
import { copyFile, link, mkdir, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Checksum } from "@harness/contracts";
import { canonicalDigest, sha256File } from "./checksum.js";

export interface DirectoryEntry { path: string; checksum: Checksum; size_bytes: number }

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(root, p, out);
    else if (e.isFile()) out.push(p);
  }
}

/** Every regular file below `dir`, relative forward-slash paths, sorted, with sha256 and size. */
export async function listDirectoryFiles(dir: string): Promise<DirectoryEntry[]> {
  if (!(await stat(dir)).isDirectory()) throw new Error(`not a directory: ${dir}`);
  const files: string[] = [];
  await walk(dir, dir, files);
  const entries: DirectoryEntry[] = [];
  for (const f of files) {
    const { checksum, size_bytes } = await sha256File(f);
    entries.push({ path: relative(dir, f).split("\\").join("/"), checksum, size_bytes });
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The artifact-level checksum of a directory is the canonical digest of its file listing. */
export function directoryDigest(entries: DirectoryEntry[]): { checksum: Checksum; size_bytes: number } {
  return { checksum: canonicalDigest(entries), size_bytes: entries.reduce((n, e) => n + e.size_bytes, 0) };
}

export async function copyTree(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true })) {
    const s = join(src, e.name); const d = join(dest, e.name);
    if (e.isDirectory()) await copyTree(s, d);
    else { try { await link(s, d); } catch { await copyFile(s, d); } }
  }
}
```

- [ ] **Step 4: Registry, workspace, checkers, manifest**

`packages/contracts/src/execution.ts` — trước `ArtifactManifestSchema` thêm `export const directoryEntrySchema = z.object({ path: z.string().min(1), checksum: checksumSchema, size_bytes: z.number().int().min(0) }).strict();` và trong `ArtifactManifestSchema` thêm `files: z.array(directoryEntrySchema).optional(),`. Chạy `pnpm gen:schemas`.

`packages/core/src/artifacts/registry.ts`:
- `StagedOutput` thêm `files?: DirectoryEntry[]`.
- Trong `stageOutputs`, vòng verify: thay khối tính `actual` bằng
```ts
      let actual: { checksum: string; size_bytes: number }; let files: DirectoryEntry[] | undefined;
      if (out.kind === "directory") {
        if (!existsSync(src) || !statSync(src).isDirectory()) throw new HarnessError("IO_ERROR", `output directory missing: ${out.path}`, { path: out.path });
        files = await listDirectoryFiles(src);
        actual = directoryDigest(files);
      } else {
        actual = await sha256File(src).catch(() => { throw new HarnessError("IO_ERROR", `output missing: ${out.path}`, { path: out.path }); });
      }
      if (actual.checksum !== out.checksum || actual.size_bytes !== out.size_bytes) throw new HarnessError("CHECKSUM_MISMATCH", `checksum mismatch for ${out.path}`, { path: out.path, declared: out.checksum, actual: actual.checksum });
      verified.push({ out, src, files });
```
(`verified` có kiểu `{ out; src; files?: DirectoryEntry[] }[]`; import `existsSync`, `statSync` từ `node:fs` và `listDirectoryFiles`, `directoryDigest`, `DirectoryEntry` từ `./directory.js`.)
- Trong vòng move: `renameSync(src, dest)` giữ nguyên (đổi tên cả thư mục), `staged.push({ artifact, manifestPath, manifest, ...(files ? { files } : {}) })`, và `toManifest(artifact, files)` ghi `files` khi có. Sửa chữ ký `toManifest(a: Artifact, files?: DirectoryEntry[]): ArtifactManifest` trả về `{ ..., ...(files ? { files } : {}) }`; trong `commitAccepted` gọi `toManifest(accepted, s.files)` (destructure `files` từ staged).

`packages/core/src/environment/workspace.ts` — `materializeInputs`:
```ts
  for (const a of artifacts) {
    const src = fileURLToPath(a.uri);
    const isDir = statSync(src).isDirectory();
    const rel = join("input", a.artifact_id, basename(src)).split("\\").join("/");
    await mkdir(join(workspaceDir, "input", a.artifact_id), { recursive: true });
    if (isDir) await copyTree(src, join(workspaceDir, rel)); else await linkOrCopy(src, join(workspaceDir, rel));
    inputs.push({ artifact_id: a.artifact_id, checksum: a.checksum, path: rel, type: a.type, kind: isDir ? "directory" : "file" });
  }
```
(import `statSync` từ `node:fs`, `copyTree` từ `../artifacts/directory.js`.)

`packages/core/src/verification/checkers.ts`:
- `outputExistsChecker`: `existsSync(join(workspaceDir, o.path))` đã đúng cho cả thư mục.
- `checksumMatchChecker`: trong vòng lặp, `const actual = o.kind === "directory" ? directoryDigest(await listDirectoryFiles(path)) : await sha256File(path);` (bọc `listDirectoryFiles` trong try → fail với `reason: "not a directory"`).

Thêm `export * from "./artifacts/directory.js";` vào `index.ts`.

- [ ] **Step 5: Chạy test, xác nhận pass**

Run: `pnpm gen:schemas && pnpm test && pnpm build && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages
git commit -m "feat(core): directory artifacts with file listings, tree materialisation and directory-aware checkers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Invalidation STALE theo graph

**Files:**
- Create: `packages/core/src/orchestration/invalidation.ts`
- Modify: `packages/core/src/orchestration/controller.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/orchestration/invalidation.test.ts`

**Interfaces:**
- Consumes: `store.listRuns({ variant_id })`, `store.listStageRuns`, `store.listArtifacts`, `store.transition("artifact", …, "ACCEPTED", "STALE", …)`.
- Produces: `dependantsOf(stages: Pick<StageRun, "stage_key"|"depends_on"|"depends_on_optional">[], stageKey: string): string[]` (bắc cầu, không gồm chính nó); `invalidateDownstream(p: { store: StateStore; run: Run; stageKey: string; now: string }): { stale: string[] }` — với mọi run khác cùng `variant_id` (bỏ qua nếu run không có `variant_id`): artifact ACCEPTED của stage có `stage_key` ∈ `{stageKey} ∪ dependantsOf(current run graph, stageKey)` → STALE, event `artifact.stale` (payload `{ superseded_by_run, stage_key }`). Được gọi trong `Controller.commit` ngay sau `commitAccepted` (cùng transaction).

- [ ] **Step 1: Viết test thất bại**

`packages/core/test/orchestration/invalidation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newId, type Artifact, type Run, type StageRun } from "@harness/contracts";
import { dependantsOf, invalidateDownstream } from "../../src/orchestration/invalidation.js";
import { openTempStore } from "../helpers.js";

const now = "2026-09-12T00:00:00.000Z"; const sha = "sha256:" + "a".repeat(64);
const graph = [
  { stage_key: "script", depends_on: [], depends_on_optional: [] },
  { stage_key: "tts", depends_on: ["script"], depends_on_optional: [] },
  { stage_key: "edit-plan", depends_on: ["script"], depends_on_optional: [] },
  { stage_key: "cut", depends_on: ["edit-plan"], depends_on_optional: [] },
  { stage_key: "assemble", depends_on: ["cut"], depends_on_optional: ["tts"] },
  { stage_key: "thumb", depends_on: ["cut", "script"], depends_on_optional: [] },
];

describe("dependantsOf", () => {
  it("returns transitive dependants over required and optional edges", () => {
    expect(dependantsOf(graph, "edit-plan").sort()).toEqual(["assemble", "cut", "thumb"]);
    expect(dependantsOf(graph, "tts")).toEqual(["assemble"]);
    expect(dependantsOf(graph, "thumb")).toEqual([]);
  });
});

describe("invalidateDownstream", () => {
  function seedRun(store: ReturnType<typeof openTempStore>["store"], variantId: string, keys: string[]) {
    const run: Run = { schema_version: "harness.run/v1", run_id: newId("run"), project_id: "p", portfolio_id: "pf", workflow_release: { id: "w", version: "1.0.0", digest: sha }, profile_snapshot: { id: "footage", revision: 1 }, variant_id: variantId, state: "SUCCEEDED", effective_config_snapshot: {}, effective_config_digest: sha, total_cost_usd: 0, created_at: now, updated_at: now };
    store.insertRun(run);
    const arts: Record<string, Artifact> = {};
    for (const key of keys) {
      const g = graph.find((x) => x.stage_key === key)!;
      const s: StageRun = { schema_version: "harness.stage-run/v1", stage_run_id: newId("stage_run"), run_id: run.run_id, stage_key: key, executor: { type: "script", script: "x" }, depends_on: g.depends_on, depends_on_optional: g.depends_on_optional, requires_resources: [], required_capabilities: [], required_checks: [], retry: { max_attempts: 1, backoff_seconds: [0], retry_on: [] }, stage_config: {}, state: "SUCCEEDED", attempt_count: 1, result_failures: 0, created_at: now, updated_at: now };
      store.insertStageRun(s);
      const a: Artifact = { schema_version: "harness.artifact/v1", artifact_id: newId("artifact"), run_id: run.run_id, stage_run_id: s.stage_run_id, attempt_id: newId("attempt"), type: key, status: "ACCEPTED", uri: "file:///x", checksum: sha, size_bytes: 1, mime_type: "text/plain", lineage: { input_artifacts: [], source_items: [] }, reproducibility: { workflow_release: "w@1.0.0", production_profile: "footage@1", channel_config_revision: null, executor_version: "x", model_parameters_digest: null }, checks: [], created_at: now, updated_at: now };
      store.insertArtifact(a); arts[key] = a;
    }
    return { run, arts };
  }
  it("marks downstream accepted artifacts of earlier runs of the same variant STALE, leaves siblings alone", () => {
    const { store } = openTempStore();
    const variant = newId("content_variant");
    const old = seedRun(store, variant, graph.map((g) => g.stage_key));
    const other = seedRun(store, newId("content_variant"), ["cut"]);
    const current = seedRun(store, variant, graph.map((g) => g.stage_key));
    const { stale } = invalidateDownstream({ store, run: current.run, stageKey: "edit-plan", now });
    expect(stale.sort()).toEqual([old.arts["edit-plan"]!.artifact_id, old.arts.cut!.artifact_id, old.arts.assemble!.artifact_id, old.arts.thumb!.artifact_id].sort());
    expect(store.getArtifact(old.arts.tts!.artifact_id)?.status).toBe("ACCEPTED");
    expect(store.getArtifact(old.arts.script!.artifact_id)?.status).toBe("ACCEPTED");
    expect(store.getArtifact(other.arts.cut!.artifact_id)?.status).toBe("ACCEPTED");
    expect(store.getArtifact(current.arts.cut!.artifact_id)?.status).toBe("ACCEPTED"); // the current run is never invalidated
    expect(store.listEvents({ run_id: old.run.run_id }).filter((e) => e.event_type === "artifact.stale")).toHaveLength(4);
    expect(invalidateDownstream({ store, run: current.run, stageKey: "edit-plan", now }).stale).toEqual([]); // idempotent
  });
  it("does nothing for a run without a variant", () => {
    const { store } = openTempStore();
    const { run } = seedRun(store, newId("content_variant"), ["script"]);
    const noVariant: Run = { ...run, run_id: newId("run"), variant_id: undefined as unknown as string };
    delete (noVariant as { variant_id?: string }).variant_id;
    store.insertRun(noVariant);
    expect(invalidateDownstream({ store, run: noVariant, stageKey: "script", now }).stale).toEqual([]);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/core/test/orchestration/invalidation.test.ts`
Expected: FAIL, thiếu module.

- [ ] **Step 3: Viết `invalidation.ts` và nối vào controller**

`packages/core/src/orchestration/invalidation.ts`:

```ts
import type { Run, StageRun, StateStore } from "@harness/contracts";
import { eventFor } from "./planner.js";

type GraphNode = Pick<StageRun, "stage_key" | "depends_on" | "depends_on_optional">;

/** Transitive dependants of `stageKey` over required and optional edges (excluding itself). */
export function dependantsOf(stages: GraphNode[], stageKey: string): string[] {
  const out = new Set<string>();
  const frontier = [stageKey];
  while (frontier.length) {
    const k = frontier.pop()!;
    for (const s of stages) {
      if (out.has(s.stage_key) || s.stage_key === stageKey) continue;
      if (s.depends_on.includes(k) || s.depends_on_optional.includes(k)) { out.add(s.stage_key); frontier.push(s.stage_key); }
    }
  }
  return [...out];
}

/** A stage of `run` produced a new ACCEPTED artifact: earlier runs of the same variant lose that stage's and its dependants' artifacts. Must run inside a transaction. */
export function invalidateDownstream(p: { store: StateStore; run: Run; stageKey: string; now: string }): { stale: string[] } {
  if (!p.run.variant_id) return { stale: [] };
  const graph = p.store.listStageRuns(p.run.run_id);
  const affected = new Set([p.stageKey, ...dependantsOf(graph, p.stageKey)]);
  const stale: string[] = [];
  for (const other of p.store.listRuns({ variant_id: p.run.variant_id })) {
    if (other.run_id === p.run.run_id) continue;
    for (const s of p.store.listStageRuns(other.run_id)) {
      if (!affected.has(s.stage_key)) continue;
      for (const a of p.store.listArtifacts({ stage_run_id: s.stage_run_id, status: "ACCEPTED" })) {
        p.store.transition("artifact", a.artifact_id, "ACCEPTED", "STALE", eventFor(other, s, null, "artifact.stale", "info", { artifact_id: a.artifact_id, superseded_by_run: p.run.run_id, stage_key: p.stageKey }));
        stale.push(a.artifact_id);
      }
    }
  }
  return { stale };
}
```

Trong `controller.ts`, nhánh `kind === null`, ngay sau `artifacts = registry.commitAccepted(...)`:
```ts
        const { stale } = invalidateDownstream({ store, run, stageKey: stage.stage_key, now });
        if (stale.length) store.appendEvent(ev("stage.invalidated_downstream", "info", { stale }));
```
(import `invalidateDownstream` từ `./invalidation.js`). Thêm `export * from "./orchestration/invalidation.js";` vào `index.ts`.

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `pnpm vitest run packages/core && pnpm build && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): mark downstream artifacts of earlier runs STALE when a stage produces a new accepted artifact

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 9: Cache: `cache_key` khi commit, tái sử dụng khi plan

**Files:**
- Create: `packages/core/src/orchestration/cache.ts`
- Modify: `packages/core/src/orchestration/controller.ts`, `packages/core/src/orchestration/planner.ts`, `packages/core/src/artifacts/registry.ts` (`acceptedInputsFor`), `packages/core/src/index.ts`
- Test: `packages/core/test/orchestration/cache.test.ts`

**Interfaces:**
- Consumes: `canonicalDigest`, `store.listRuns({ variant_id })`, `store.listArtifacts`, `StageDefinition`, `resolveStageGraph`.
- Produces: `stageDefinitionDigest(def: StageDefinition): Checksum` (canonical digest của `{ key, executor, required_checks, outputs, config }`); `computeCacheKey(p: { stageDefinitionDigest; inputChecksums: string[] (sorted); optionsDigest: Checksum; effectiveConfigDigest: Checksum }): Checksum`; `findReusableArtifacts(store, p: { variantId; stageKey; cacheKey; excludeRunId }): Artifact[]` (artifact ACCEPTED của stage cùng key trong run khác cùng variant có `stage_run.cache_key === cacheKey`, ưu tiên run mới nhất); `PlanInput.reuse?: boolean` (mặc định theo `profile.reuse === "allow"`); planner tạo stage tái sử dụng ở `SUCCEEDED` với `reused_artifact_ids`, `cache_key`, event `stage.reused`; `Controller.commit` ghi `cache_key` lên stage_run khi SUCCEEDED (cần `stageDefinitionDigest` → `StageRun.stage_config` không đủ: `CommitParams` thêm `stageDefinitionDigest: Checksum`, worker lấy từ workflow đã load); `acceptedInputsFor` trả `reused_artifact_ids` cho stage tái sử dụng.
- Quy tắc reuse khi plan: duyệt stage theo thứ tự workflow; stage tái sử dụng được khi (1) executor không phải `gate` (trừ khi `reuseGates: true`), (2) mọi dependency (required + optional còn lại) đã tái sử dụng hoặc không có dependency, (3) tìm được artifact khớp `cache_key` tính từ checksum của artifact tái sử dụng upstream, `options_digest` của variant, `effective_config_digest` của run mới. Stage tái sử dụng có `attempt_count: 0`, không có attempt, không có lease.
- Worker cần `stageDefinitionDigest`: `WorkerDeps` thêm `workflows: (ref: string) => LoadedWorkflow` (composition root truyền `(ref) => loadWorkflow(harnessRoot, ref)`); worker tra `definition.stages.find(s => s.key === stage_key)`.

- [ ] **Step 1: Viết test thất bại**

`packages/core/test/orchestration/cache.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProductionProfileSchema, WorkflowDefinitionSchema, type StageRequest, type StageResult } from "@harness/contracts";
import { ArtifactRegistry, BUILTIN_CHECKERS, Controller, HARNESS_ROOT, NullMediaProber, Planner, SourceCatalog, Verifier, computeCacheKey, createWorkspace, loadHarnessConfig, sha256String, stageDefinitionDigest } from "../../src/index.js";
import { acceptedInputsFor } from "../../src/artifacts/registry.js";
import { beginAttempt, openTempStore } from "../helpers.js";

const wf = { definition: WorkflowDefinitionSchema.parse({ schema_version: "harness.workflow/v1", id: "two", version: "1.0.0", defaults: {}, stages: [
  { key: "produce", executor: { type: "script", script: "fake-stage" }, required_checks: ["schema-valid"], outputs: [{ type: "script_text", mime_type: "text/plain" }] },
  { key: "finalize", executor: { type: "script", script: "fake-stage" }, depends_on: ["produce"], required_checks: ["schema-valid"] },
] }), digest: "sha256:" + "f".repeat(64) };
const profile = ProductionProfileSchema.parse({ schema_version: "harness.production-profile/v1", profile_id: "footage", revision: 1, status: "active", workflow_release: "two@1.0.0", options_schema: { voice: ["none", "tts"] }, options_defaults: { voice: "none" } });

describe("cache", () => {
  it("cache key depends on definition, inputs, options and config", () => {
    const d = stageDefinitionDigest(wf.definition.stages[0]!);
    const k1 = computeCacheKey({ stageDefinitionDigest: d, inputChecksums: [], optionsDigest: "sha256:" + "1".repeat(64), effectiveConfigDigest: "sha256:" + "2".repeat(64) });
    expect(k1).toMatch(/^sha256:/);
    expect(computeCacheKey({ stageDefinitionDigest: d, inputChecksums: ["sha256:" + "9".repeat(64)], optionsDigest: "sha256:" + "1".repeat(64), effectiveConfigDigest: "sha256:" + "2".repeat(64) })).not.toBe(k1);
    expect(stageDefinitionDigest({ ...wf.definition.stages[0]!, config: { x: 1 } })).not.toBe(d);
  });

  it("a re-run reuses accepted artifacts of the previous run, then stops at the first stage that cannot be reused", async () => {
    const t = openTempStore();
    const catalog = new SourceCatalog({ store: t.store, dataRoot: t.dir, prober: new NullMediaProber(), clock: t.clock, materialize: "reference" });
    const content = catalog.createContent({ source_ids: [], title: "c" });
    const { variant } = catalog.getOrCreateVariant({ content_id: content.content_id, profile, options: {} });
    const planner = new Planner(t.store);
    const registry = new ArtifactRegistry(t.store, t.dir);
    const controller = new Controller({ store: t.store, registry, planner, clock: t.clock });
    const harness = loadHarnessConfig(HARNESS_ROOT);
    const run1 = planner.plan({ workflow: wf, profile, harness, projectId: "p", portfolioId: "pf", content, variant });
    planner.enqueue(run1.run_id);
    // run produce for real
    const claim = t.store.claim({ owner: "w", capabilities: [], now: t.clock.now(), leaseSeconds: 90 })!;
    const { stageRun, attempt } = beginAttempt(t.store, claim);
    const ws = await createWorkspace(t.dir, run1.run_id, "produce", attempt.attempt_id);
    writeFileSync(join(ws, "output", "result.txt"), "hello");
    const result: StageResult = { schema_version: "harness.stage-result/v1", attempt_id: attempt.attempt_id, outcome: "succeeded", outputs: [{ path: "output/result.txt", type: "script_text", checksum: sha256String("hello"), size_bytes: 5, kind: "file" }], checks: [], usage: { wall_seconds: 1, cost_usd: 0 }, external_operations: [], errors: [] };
    const request = { attempt_id: attempt.attempt_id } as StageRequest;
    const verify = await new Verifier(BUILTIN_CHECKERS).verify({ request: { ...request, attempt_id: attempt.attempt_id }, result, workspaceDir: ws }, ["schema-valid"]);
    const out = await controller.commit({ stageRun, attempt, fencingToken: claim.lease.fencing_token, result, verify, workspaceDir: ws, executorVersion: "fake@0.1.0", inputArtifactIds: [], mimeTypes: { script_text: "text/plain" }, stageDefinitionDigest: stageDefinitionDigest(wf.definition.stages[0]!) });
    expect(out.stageState).toBe("SUCCEEDED");
    expect(t.store.getStageRun(stageRun.stage_run_id)?.cache_key).toMatch(/^sha256:/);

    // second run of the same variant: produce is reused, finalize is not (no accepted artifact for it yet)
    const run2 = planner.plan({ workflow: wf, profile, harness, projectId: "p", portfolioId: "pf", content, variant });
    const stages2 = t.store.listStageRuns(run2.run_id);
    expect(stages2.map((s) => [s.stage_key, s.state])).toEqual([["produce", "SUCCEEDED"], ["finalize", "PENDING"]]);
    expect(stages2[0]?.reused_artifact_ids).toEqual(out.artifacts.map((a) => a.artifact_id));
    expect(stages2[0]?.attempt_count).toBe(0);
    expect(t.store.listEvents({ run_id: run2.run_id }).some((e) => e.event_type === "stage.reused")).toBe(true);
    planner.enqueue(run2.run_id);
    expect(t.store.listStageRuns(run2.run_id).map((s) => s.state)).toEqual(["SUCCEEDED", "READY"]);
    expect(acceptedInputsFor(t.store, stages2[1]!).map((a) => a.artifact_id)).toEqual(out.artifacts.map((a) => a.artifact_id));

    // a different options digest never reuses
    const { variant: other } = catalog.getOrCreateVariant({ content_id: content.content_id, profile, options: { voice: "tts" } });
    const run3 = planner.plan({ workflow: wf, profile, harness, projectId: "p", portfolioId: "pf", content, variant: other });
    expect(t.store.listStageRuns(run3.run_id)[0]?.state).toBe("PENDING");
    // reuse: never
    const run4 = planner.plan({ workflow: wf, profile: { ...profile, reuse: "never" }, harness, projectId: "p", portfolioId: "pf", content, variant });
    expect(t.store.listStageRuns(run4.run_id)[0]?.state).toBe("PENDING");
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/core/test/orchestration/cache.test.ts`
Expected: FAIL.

- [ ] **Step 3: Viết `cache.ts`**

`packages/core/src/orchestration/cache.ts`:

```ts
import type { Artifact, Checksum, StageDefinition, StateStore } from "@harness/contracts";
import { canonicalDigest } from "../artifacts/checksum.js";

export function stageDefinitionDigest(def: StageDefinition): Checksum {
  return canonicalDigest({ key: def.key, executor: def.executor, required_checks: def.required_checks, outputs: def.outputs, config: def.config });
}

export function computeCacheKey(p: { stageDefinitionDigest: Checksum; inputChecksums: string[]; optionsDigest: Checksum; effectiveConfigDigest: Checksum }): Checksum {
  return canonicalDigest({ d: p.stageDefinitionDigest, i: [...p.inputChecksums].sort(), o: p.optionsDigest, c: p.effectiveConfigDigest });
}

/** ACCEPTED artifacts of the newest earlier run of the same variant whose stage carries the same cache key. */
export function findReusableArtifacts(store: StateStore, p: { variantId: string; stageKey: string; cacheKey: Checksum; excludeRunId?: string }): Artifact[] {
  const runs = store.listRuns({ variant_id: p.variantId }).filter((r) => r.run_id !== p.excludeRunId).reverse();
  for (const run of runs) {
    const stage = store.listStageRuns(run.run_id).find((s) => s.stage_key === p.stageKey && s.state === "SUCCEEDED" && s.cache_key === p.cacheKey);
    if (!stage) continue;
    const artifacts = stage.reused_artifact_ids
      ? stage.reused_artifact_ids.map((id) => store.getArtifact(id)).filter((a): a is Artifact => !!a && a.status === "ACCEPTED")
      : store.listArtifacts({ stage_run_id: stage.stage_run_id, status: "ACCEPTED" });
    if (artifacts.length) return artifacts;
  }
  return [];
}
```

- [ ] **Step 4: Controller ghi `cache_key`**

`CommitParams` thêm `stageDefinitionDigest: Checksum`. Trong nhánh `kind === null` của `commit`, sau `commitAccepted` và invalidation:
```ts
        const inputChecksums = p.inputArtifactIds.map((id) => store.getArtifact(id)?.checksum).filter((c): c is string => !!c);
        const variant = run.variant_id ? store.getContentVariant(run.variant_id) : undefined;
        const cacheKey = computeCacheKey({ stageDefinitionDigest: p.stageDefinitionDigest, inputChecksums, optionsDigest: variant?.options_digest ?? canonicalDigest({}), effectiveConfigDigest: run.effective_config_digest });
```
và khi cập nhật stage sau `VERIFYING → SUCCEEDED`: `store.updateStageRun({ ...store.getStageRun(stage.stage_run_id)!, cache_key: cacheKey });` (import `computeCacheKey` từ `./cache.js`, `canonicalDigest` từ `../artifacts/checksum.js`). Cập nhật mọi caller của `commit` (worker, tests controller/cache/worker/acceptance) để truyền `stageDefinitionDigest`; trong test cũ dùng `stageDefinitionDigest(<stage def của sample workflow>)` hoặc một checksum cố định `"sha256:" + "0".repeat(64)` khi không quan trọng.

Worker: `WorkerDeps` thêm `workflows: (ref: string) => LoadedWorkflow`; trong `runOnce` trước commit:
```ts
    const def = this.d.workflows(`${run.workflow_release.id}@${run.workflow_release.version}`).definition.stages.find((s) => s.key === claim.stageRun.stage_key);
    const defDigest = def ? stageDefinitionDigest(def) : canonicalDigest({ key: claim.stageRun.stage_key });
```
và truyền `stageDefinitionDigest: defDigest` vào cả hai lời gọi `commit` (setup-failure và bình thường). Test world của worker/acceptance truyền `workflows: (ref) => loadWorkflow(HARNESS_ROOT, ref)`.

- [ ] **Step 5: Planner tái sử dụng**

Trong `plan()`, sau khi tạo `run` và trước vòng insert stage: `const reuse = input.reuse ?? input.profile.reuse === "allow"; const reusable = new Map<string, Artifact[]>();` rồi trong vòng lặp cho mỗi stage:
```ts
        let reused: Artifact[] | undefined;
        if (reuse && input.variant && s.executor.type !== "gate") {
          const deps = [...depends_on, ...depends_on_optional];
          if (deps.every((d) => reusable.has(d))) {
            const inputChecksums = deps.flatMap((d) => reusable.get(d)!.map((a) => a.checksum));
            const cacheKey = computeCacheKey({ stageDefinitionDigest: stageDefinitionDigest(s), inputChecksums, optionsDigest: input.variant.options_digest, effectiveConfigDigest: digest });
            const found = findReusableArtifacts(this.store, { variantId: input.variant.variant_id, stageKey: s.key, cacheKey, excludeRunId: run.run_id });
            if (found.length) { reused = found; reusable.set(s.key, found); stageCacheKey = cacheKey; }
          }
        }
```
(`let stageCacheKey: Checksum | undefined` khai báo trước.) Stage literal: `state: reused ? "SUCCEEDED" : "PENDING"`, `...(reused ? { reused_artifact_ids: reused.map((a) => a.artifact_id), cache_key: stageCacheKey } : {})`. Sau insert, nếu `reused`: `this.store.appendEvent(eventFor(run, stage, null, "stage.reused", "info", { artifacts: reused.map((a) => a.artifact_id), cache_key: stageCacheKey }))`. `enqueue` và `advance` không cần đổi: stage SUCCEEDED đã thỏa điều kiện release cho dependants. `PlanInput` thêm `reuse?: boolean`.

`acceptedInputsFor`:
```ts
  return upstream.flatMap((s) => s.reused_artifact_ids
    ? s.reused_artifact_ids.map((id) => store.getArtifact(id)).filter((a): a is Artifact => !!a && a.status === "ACCEPTED")
    : store.listArtifacts({ stage_run_id: s.stage_run_id, status: "ACCEPTED" }));
```
Thêm `export * from "./orchestration/cache.js";` vào `index.ts`.

- [ ] **Step 6: Chạy test, xác nhận pass**

Run: `pnpm test && pnpm build && pnpm typecheck`
Expected: PASS (mọi caller của `commit` đã có `stageDefinitionDigest`).

- [ ] **Step 7: Commit**

```bash
git add packages
git commit -m "feat(core): cache keys at commit and artifact reuse at plan time for the same variant

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: CLI (source, content, plan theo variant, resources), composition, worker request

**Files:**
- Create: `packages/cli/src/commands/source.ts`, `packages/cli/src/commands/content.ts`, `packages/cli/src/commands/resources.ts`
- Modify: `packages/cli/src/composition.ts`, `packages/cli/src/commands/plan.ts`, `packages/cli/src/commands/worker.ts`, `packages/cli/src/main.ts`, `packages/worker/src/worker.ts`, `packages/core/src/orchestration/registry.ts` (`loadProfile` hỗ trợ profile chưa tồn tại → NOT_FOUND rõ), `fixtures/ops-project-minimal/project.yaml`, `project-template/project.yaml`, `production-profiles/cartoon/profile.yaml`
- Test: `packages/cli/test/cli.test.ts`, `packages/worker/test/worker.test.ts`

**Interfaces:**
- Consumes: `SourceCatalog`, `NullMediaProber`, `ProjectConfig.resources/source`, `Planner.plan({ content, variant })`, `store.countLeasedResources`.
- Produces: `AppContext` thêm `catalog: SourceCatalog`, `resourceCapacity: Record<string, number>`, `workflows(ref)`; lệnh:
  - `harness source ingest <path> [--collection main] [--rights unknown|cleared|restricted] [--language xx] [--json]` → in `source_id` (và `created`).
  - `harness source list [--collection] [--json]`, `harness source verify [--json]` (exit 1 nếu có source hỏng).
  - `harness content create --source <src_id> [--source ...] --title "<t>" [--json]` → `content_id`.
  - `harness plan` thêm `--content <content_id>` và `--option k=v` (lặp); khi có `--content`, planner nhận `content` + `variant` (get-or-create); `--json` in thêm `variant_id`, `skipped_stages`.
  - `harness resources status [--json]` → bảng `resource | capacity | held | free`.
  - Worker: `claim(... resourceCapacity)`; request có `options` (từ variant), `source_items` (từ content), `resources` (lease); event `stage.waiting_resource` khi một stage READY có `requires_resources` hết slot lâu hơn `resource_wait_warn_seconds` (kiểm trong `runOnce` khi `claim` trả `undefined`: liệt kê stage READY có resource thiếu và `ready_at` cũ hơn ngưỡng; ghi event tối đa một lần mỗi `resource_wait_warn_seconds` — dùng `stage_config.__last_resource_warn_at`? Không sửa stage_config; dùng bảng event: bỏ qua nếu đã có event cùng loại cho stage trong khoảng ngưỡng).
- `source sync` hoãn sang 2B (khi có `source-catalog/sources.yaml` mẫu trong fixture ops project).

- [ ] **Step 1: Cập nhật fixture và profile**

`fixtures/ops-project-minimal/project.yaml` và `project-template/project.yaml` thêm:
```yaml
resources: { cpu: 2, gpu: 1 }
source: { materialize: link }
```
`production-profiles/cartoon/profile.yaml` thêm `options_schema: {}` và `options_defaults: {}` (giữ workflow mẫu; profile `footage` là 2B).

- [ ] **Step 2: Viết test thất bại**

Thêm vào `packages/cli/test/cli.test.ts`:

```ts
  it("ingests a source, creates content, plans a variant and shows resources", () => {
    const p = freshProject();
    cli(p, "db", "migrate");
    const raw = join(p, "raw.txt"); writeFileSync(raw, "raw source bytes");
    const ing = JSON.parse(cli(p, "source", "ingest", raw, "--collection", "main", "--rights", "cleared", "--json").out);
    expect(ing.source_id).toMatch(/^src_/); expect(ing.created).toBe(true);
    expect(JSON.parse(cli(p, "source", "ingest", raw, "--json").out).created).toBe(false);
    expect(JSON.parse(cli(p, "source", "list", "--json").out)).toHaveLength(1);
    expect(cli(p, "source", "verify").code).toBe(0);
    const content = JSON.parse(cli(p, "content", "create", "--source", ing.source_id, "--title", "Ep 1", "--json").out);
    expect(content.content_id).toMatch(/^content_/);
    const plan = JSON.parse(cli(p, "plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--content", content.content_id, "--json").out);
    expect(plan.variant_id).toMatch(/^variant_/);
    const status = JSON.parse(cli(p, "status", plan.run_id, "--json").out);
    expect(status.run.content_id).toBe(content.content_id);
    expect(status.run.source_id).toBe(ing.source_id);
    const res = JSON.parse(cli(p, "resources", "status", "--json").out);
    expect(res).toEqual(expect.arrayContaining([{ resource: "gpu", capacity: 1, held: 0, free: 1 }]));
    expect(cli(p, "plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--content", content.content_id, "--option", "voice=tts").code).toBe(1); // cartoon declares no options
  });
```

Thêm vào `packages/worker/test/worker.test.ts`:

```ts
  it("passes options, source items and held resources to the executor request", async () => {
    const w = makeWorld();
    const raw = join(w.dir, "raw.txt"); writeFileSync(raw, "src");
    const { source } = await w.catalog.ingest({ path: raw });
    const content = w.catalog.createContent({ source_ids: [source.source_id], title: "c" });
    const { variant } = w.catalog.getOrCreateVariant({ content_id: content.content_id, profile: loadProfile(HARNESS_ROOT, "cartoon"), options: {} });
    const run = w.planner.plan({ workflow: loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0"), profile: loadProfile(HARNESS_ROOT, "cartoon"), harness: loadHarnessConfig(HARNESS_ROOT), projectId: "project-main", portfolioId: "portfolio-main", content, variant });
    for (const s of w.store.listStageRuns(run.run_id)) w.store.updateStageRun({ ...s, requires_resources: s.stage_key === "produce" ? ["cpu"] : [] });
    w.planner.enqueue(run.run_id);
    let seen: StageRequest | undefined;
    w.executors.register("script", { version: "spy", execute: async (req) => { seen = req; return { schema_version: "harness.stage-result/v1", attempt_id: req.attempt_id, outcome: "failed", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [{ kind: "transient", message: "spy", details: {} }] }; } });
    await w.worker.runOnce();
    expect(seen?.options).toEqual({});
    expect(seen?.source_items.map((s) => s.source_id)).toEqual([source.source_id]);
    expect(seen?.resources).toEqual(["cpu"]);
  });
```
`makeWorld` phải trả thêm `catalog` (SourceCatalog với NullMediaProber, materialize `reference`), `executors`, và truyền `workflows`, `resourceCapacity: { cpu: 2, gpu: 1 }` vào `Worker`.

- [ ] **Step 3: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/cli packages/worker`
Expected: FAIL.

- [ ] **Step 4: Composition và worker**

`composition.ts`: thêm vào `AppContext` `catalog: SourceCatalog; resourceCapacity: Record<string, number>; workflows: (ref: string) => LoadedWorkflow;` và trong `buildContext`:
```ts
  const catalog = new SourceCatalog({ store, dataRoot, prober: new NullMediaProber(), clock, materialize: project.source.materialize });
  const workflows = (ref: string) => loadWorkflow(harnessRoot, ref);
  return { ..., catalog, resourceCapacity: project.resources, workflows };
```
`WorkerDeps` thêm `resourceCapacity: Record<string, number>` và `workflows`; `runOnce` truyền `resourceCapacity` vào `claim`, và `buildRequest` thêm:
```ts
    const variant = run.variant_id ? this.d.store.getContentVariant(run.variant_id) : undefined;
    const content = run.content_id ? this.d.store.getContentItem(run.content_id) : undefined;
    const source_items = (content?.source_ids ?? []).map((id) => this.d.store.getSourceItem(id)).filter((s): s is SourceItem => !!s).map((s) => ({ source_id: s.source_id, uri: s.uri, checksum: s.checksum, mime_type: s.mime_type, duration_seconds: s.duration_seconds }));
    return { ..., options: variant?.options ?? {}, source_items, resources: claim.lease.resources, ... };
```
Cảnh báo tài nguyên, trong `runOnce` khi `claim` trả `undefined`:
```ts
    if (!claim) { this.warnResourceStarvation(); return "idle"; }
```
với
```ts
  private warnResourceStarvation(): void {
    const { store, clock, harness } = this.d;
    const held = store.countLeasedResources(); const now = clock.now();
    for (const run of store.listRuns({ state: "RUNNING" })) for (const s of store.listStageRuns(run.run_id)) {
      if (s.state !== "READY" || !s.requires_resources.length || !s.ready_at) continue;
      if (Date.parse(now) - Date.parse(s.ready_at) < harness.resource_wait_warn_seconds * 1000) continue;
      const starved = s.requires_resources.filter((r) => (held[r] ?? 0) >= (this.d.resourceCapacity[r] ?? 0));
      if (!starved.length) continue;
      const recent = store.listEvents({ run_id: run.run_id, limit: 200, newest: true }).some((e) => e.event_type === "stage.waiting_resource" && e.stage_run_id === s.stage_run_id && Date.parse(now) - Date.parse(e.occurred_at) < harness.resource_wait_warn_seconds * 1000);
      if (!recent) store.appendEvent(eventFor(run, s, null, "stage.waiting_resource", "warn", { resources: starved, waiting_since: s.ready_at }));
    }
  }
```
(kiểm `listRuns({ state: "READY" })` nữa vì run có thể chưa RUNNING; gộp hai state.)

`commands/worker.ts`: truyền `resourceCapacity: ctx.resourceCapacity, workflows: ctx.workflows` vào `Worker`.

- [ ] **Step 5: Lệnh CLI**

`commands/source.ts`:
```ts
import type { Command } from "commander";
import { print, withContext } from "./shared.js";
export function registerSource(program: Command): void {
  const source = program.command("source").description("source catalog");
  source.command("ingest <path>").option("--collection <name>", "collection", "main").option("--rights <status>", "unknown|cleared|restricted", "unknown").option("--language <code>").option("--json", "machine output", false)
    .description("register a raw source file (deduplicated by checksum)").action(async (path: string, o, cmd) => {
      await withContext(cmd, {}, async (ctx) => {
        const r = await ctx.catalog.ingest({ path, collection: o.collection, rights_status: o.rights, language: o.language ?? null });
        print(o.json, { source_id: r.source.source_id, created: r.created, checksum: r.source.checksum, uri: r.source.uri }, () => `${r.source.source_id} ${r.created ? "created" : "already registered"} ${r.source.checksum.slice(0, 19)}`);
      });
    });
  source.command("list").option("--collection <name>").option("--json", "machine output", false).action(async (o, cmd) => {
    await withContext(cmd, {}, (ctx) => {
      const rows = ctx.store.listSourceItems(o.collection ? { collection: o.collection } : {});
      print(o.json, rows, () => rows.map((s) => `${s.source_id} ${s.collection.padEnd(8)} ${s.mime_type.padEnd(18)} ${s.rights_status.padEnd(10)} ${s.uri}`).join("\n") || "no sources");
    });
  });
  source.command("verify").option("--json", "machine output", false).description("re-hash every registered source").action(async (o, cmd) => {
    await withContext(cmd, {}, async (ctx) => {
      const rows = await ctx.catalog.verify();
      print(o.json, rows, () => rows.map((r) => `${r.source_id} ${r.ok ? "ok" : "BROKEN " + r.reason}`).join("\n") || "no sources");
      if (rows.some((r) => !r.ok)) process.exitCode = 1;
    });
  });
}
```
`commands/content.ts`:
```ts
import type { Command } from "commander";
import { print, withContext } from "./shared.js";
export function registerContent(program: Command): void {
  const content = program.command("content").description("content items");
  content.command("create").requiredOption("--title <title>").option("--source <src_id>", "source id (repeatable)", (v: string, acc: string[]) => [...acc, v], [] as string[]).option("--json", "machine output", false)
    .action(async (o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const c = ctx.catalog.createContent({ source_ids: o.source, title: o.title });
        print(o.json, { content_id: c.content_id, revision: c.revision }, () => `${c.content_id} "${c.title}" sources=${c.source_ids.length}`);
      });
    });
}
```
`commands/resources.ts`:
```ts
import type { Command } from "commander";
import { print, withContext } from "./shared.js";
export function registerResources(program: Command): void {
  const resources = program.command("resources").description("shared resource capacity");
  resources.command("status").option("--json", "machine output", false).action(async (o, cmd) => {
    await withContext(cmd, {}, (ctx) => {
      const held = ctx.store.countLeasedResources();
      const names = new Set([...Object.keys(ctx.resourceCapacity), ...Object.keys(held)]);
      const rows = [...names].sort().map((resource) => { const capacity = ctx.resourceCapacity[resource] ?? 0; const h = held[resource] ?? 0; return { resource, capacity, held: h, free: Math.max(0, capacity - h) }; });
      print(o.json, rows, () => rows.map((r) => `${r.resource.padEnd(12)} capacity=${r.capacity} held=${r.held} free=${r.free}`).join("\n") || "no resources declared");
    });
  });
}
```
`commands/plan.ts`: thêm `.option("--content <content_id>")` và `.option("--option <k=v>", "variant option (repeatable)", (v, acc) => [...acc, v], [] as string[])`; trong action:
```ts
        const profile = loadProfile(ctx.harnessRoot ?? HARNESS_ROOT, o.profile);
        let content, variant;
        if (o.content) {
          content = ctx.store.getContentItem(o.content);
          if (!content) throw new HarnessError("NOT_FOUND", `content not found: ${o.content}`, { content_id: o.content });
          variant = ctx.catalog.getOrCreateVariant({ content_id: content.content_id, profile, options: parseOverrides(o.option) }).variant;
        } else if (o.option.length) throw new HarnessError("CONFIG_INVALID", "--option requires --content", {});
        const run = ctx.planner.plan({ workflow: ctx.workflows(o.workflow), profile, harness: ctx.harness, projectId: ctx.project.project_id, portfolioId: o.portfolio ?? ctx.project.portfolios[0]!.portfolio_id, runOverrides: parseOverrides(o.override), ...(o.source ? { sourceId: o.source } : {}), ...(content ? { content } : {}), ...(variant ? { variant } : {}) });
        const created = ctx.store.listEvents({ run_id: run.run_id, limit: 1 })[0];
        print(o.json, { run_id: run.run_id, state: run.state, digest: run.effective_config_digest, variant_id: run.variant_id ?? null, skipped_stages: created?.payload.skipped_stages ?? [] }, () => `${run.run_id} (${run.state})${run.variant_id ? " variant " + run.variant_id : ""} config ${run.effective_config_digest.slice(0, 19)}`);
```
(`parseOverrides` tái dùng cho `--option`; giá trị option luôn là chuỗi nên `voice=tts` → `"tts"`, nhưng `parseOverrides` ép số/boolean — thêm tham số `parseOverrides(list, { coerce: boolean })` và gọi với `coerce: false` cho `--option`.)

`main.ts`: đăng ký `registerSource`, `registerContent`, `registerResources`.

- [ ] **Step 6: Chạy test, xác nhận pass**

Run: `pnpm test && pnpm build && pnpm typecheck`; chạy tay README quick-start cộng `harness source ingest README.md --json`, `harness content create --source <id> --title t --json`, `harness plan --workflow sample-three-stage@1.0.0 --profile cartoon --content <id> --json`, `harness resources status`; xóa `fixtures/ops-project-minimal/data/` sau đó.
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages fixtures project-template production-profiles
git commit -m "feat(cli): source/content/resources commands, plan per variant, worker passes options, sources and resources

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Tài liệu và báo cáo 2A

**Files:**
- Modify: `AGENTS.md` (lệnh mới, quy tắc resource/cache), `README.md` (quick-start có `source ingest` → `content create` → `plan --content`), `docs/adr/0001-control-plane-baseline.md` (thêm ADR-0002 hoặc mục 17+: catalog, when/rewire, resources trong claim, cache_key, invalidation, artifact thư mục), `docs/operations/deferred-items.md` (gạch các mục ★ đã làm; thêm mục mới nếu có), `docs/runbooks/reconcile-and-retry.md` (mục "Stage chờ tài nguyên", "Artifact STALE")

- [ ] **Step 1:** Cập nhật các file trên theo đúng hành vi đã triển khai (đọc code, không chép từ plan).
- [ ] **Step 2:** `pnpm build && pnpm typecheck && pnpm test` xanh; README quick-start chạy tay một lần; dọn `fixtures/ops-project-minimal/data/`.
- [ ] **Step 3: Commit**

```bash
git add AGENTS.md README.md docs
git commit -m "docs: catalog, resources, cache and invalidation for sub-project 2A

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 4:** Báo cáo trong chat: file đã tạo/sửa, số test, các mục ★ đã đóng, điều gì để lại cho 2B (script-sdk, scripts.yaml, gate executor + `stage submit`, ffprobe/checker media, workflow `footage-production`, profile `footage`, fixture ops project, `source sync`, acceptance 6/7/9/12 + secret e2e, runbook wrap-a-channel).

---

## Tự rà soát plan 2A

**Phủ spec (phần thuộc 2A):**
- 1.3 runtime data (`sources/normalized`) → Task 5. 1.4 CLI: `source ingest|list|verify`, `content create`, `plan --content --option`, `resources status`, `artifacts sweep` → Task 2, 10; `source sync`, `stage submit`, `doctor` → 2B.
- 2.1 lineage + 2.2 bảng + variant key → Task 3, 4, 5. 3 `when`/nối xuyên/dependency mềm → Task 6. 3.1 artifact tập hợp → Task 7. 3.2 invalidation → Task 8. 3.3 cache → Task 9. 4.5 tài nguyên trong claim + event `stage.waiting_resource` → Task 4, 10. 8 mục ★ → Task 1, 2. Cost budget (`run.budget_exceeded`) → để 2B cùng acceptance 9.
- Không có TBD/TODO. `PlanInput`, `CommitParams.stageDefinitionDigest`, `WorkerDeps.workflows/resourceCapacity`, `AppContext.catalog/resourceCapacity/workflows` dùng nhất quán giữa Task 6, 9, 10.

**Điểm cần chú ý khi thực thi:**
- Task 3 làm `pnpm -r typecheck` đỏ tạm thời cho tới Task 4 (interface mới chưa implement); mỗi task khác phải xanh.
- Test hiện có gọi `controller.commit` phải thêm `stageDefinitionDigest` từ Task 9; test dùng `reapExpiredLeases` phải thêm `run_id` từ Task 1.
- `harness plan` với `--content` nhưng profile không khai `options_schema` → chỉ `--option` rỗng hợp lệ (`cartoon` hiện tại).
