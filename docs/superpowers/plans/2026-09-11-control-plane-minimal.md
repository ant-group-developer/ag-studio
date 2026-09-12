# Control Plane Tối Thiểu (Sub-project 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Xây control plane bền vững của YouTube Operations Harness: contract, SQLite state store, state machine, claim/lease/fencing, artifact manifest, planner, worker, executor với adapter giả, và CLI `harness` chạy end-to-end một workflow mẫu.

**Architecture:** Monorepo pnpm với package `contracts` (Zod, không phụ thuộc ai), `core` (state, orchestration, artifacts, verification, config, observability), `executors`, `adapter-fake`, `worker`, `cli`. State store là SQLite WAL qua `node:sqlite`, mỗi entity một bảng "document" (`id`, `state`, `data` JSON) cộng bảng `lease`. Mọi đổi trạng thái đi qua một hàm `transition()` ghi `event` trong cùng transaction. Worker chỉ nói chuyện với `StateStore` và `Executor` qua interface; composition root ở `cli`.

**Tech Stack:** Node 22.23+, TypeScript 5 strict ESM, pnpm 10 (qua corepack), Zod 3, `zod-to-json-schema`, `node:sqlite` (`DatabaseSync`), `ulid`, `yaml`, `commander`, `pino`, Vitest 2, `tsx`.

Spec: `docs/superpowers/specs/2026-09-11-harness-structure-and-control-plane-design.md` (Phần B).

## Global Constraints

- Node `>=22.13` (để `node:sqlite` không cần cờ). `"type": "module"` ở mọi package. TypeScript `strict: true`, `moduleResolution: NodeNext`, import nội bộ có đuôi `.js`.
- Package scope `@harness/*`. Dependency rule: `contracts` không phụ thuộc package nào; `core` chỉ phụ thuộc `contracts`; `executors` phụ thuộc `contracts`, `core`; `adapter-fake` chỉ phụ thuộc `contracts`; `worker` phụ thuộc `contracts`, `core`, `executors`; `cli` phụ thuộc tất cả. `core` không bao giờ import `adapter-fake`.
- ID = `<prefix>_<ULID>`. Prefix: `run_`, `stage_`, `attempt_`, `artifact_`, `op_`, `check_`, `evt_`, `src_`, `content_`, `variant_`, `pkg_`, `pub_`, `inc_`.
- Checksum `sha256:<64 hex thường>`. Timestamp ISO 8601 UTC hậu tố `Z`. Revision số nguyên `>= 1`.
- Mọi schema object dùng `.strict()`. Mọi entity miền và contract có `schema_version` dạng `harness.<tên>/v1`. Ngoại lệ: `Lease` là hàng nội bộ của state store (5 cột SQL), không có `schema_version` (quyết định 2026-09-11 khi review Task 2).
- Profile đặt tên `cartoon`, `avatar`, `footage`. Không dùng `direction-a/b/c`.
- Không module nào `UPDATE` cột `state` ngoài `transition()` và `claim()` trong `core/state`.
- Secret chỉ ở dạng `secret://<scope>/<name>`; giá trị không được vào snapshot, event, log, manifest.
- Test xác định, không mạng, không LLM. SQLite test dùng file tạm trong `os.tmpdir()`.
- Mọi `vitest.config.ts` của package dùng `sharedConfig()` từ `vitest.shared.ts` ở root (thêm sau review Task 4): nó cung cấp plugin `node:sqlite` cho vite-node và alias `@harness/*` → `packages/*/src/index.ts`, nên test không cần build `dist/`.
- Lease mặc định 90 giây, heartbeat 30 giây, poll 2 giây; retry mặc định `max_attempts=3`, `backoff_seconds=[10,60,300]`, `retry_on=[transient, abandoned]`.
- Commit message theo Conventional Commits, kết thúc bằng `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## Cấu trúc file

```text
package.json  pnpm-workspace.yaml  tsconfig.base.json  vitest.workspace.ts  .npmrc
AGENTS.md  CLAUDE.md  README.md
configs/harness.yaml
migrations/0001_initial.sql
project-template/project.yaml
production-profiles/cartoon/profile.yaml
workflows/sample-three-stage/workflow.yaml
fixtures/ops-project-minimal/project.yaml
packages/contracts/
  package.json  tsconfig.json
  src/index.ts
  src/ids.ts                      newId(), idSchema()
  src/common.ts                   checksum, timestamp, revision, schemaVersion
  src/errors.ts                   HarnessError, ErrorCode
  src/entities.ts                 18 entity + Event + Lease (Zod)
  src/execution.ts                StageRequest, StageResult, ArtifactManifest
  src/config.ts                   WorkflowDefinition, ProductionProfile, ChannelConfig, ProjectConfig, HarnessConfig
  src/interfaces.ts               StateStore, Executor, AgentRuntime, Checker, SecretResolver, Clock, ExternalProvider
  scripts/gen-json-schema.ts      sinh schemas/*.json
  schemas/*.json
  test/*.test.ts
packages/core/
  src/index.ts
  src/state/sqlite-store.ts       SqliteStateStore (node:sqlite)
  src/state/transitions.ts        bảng transition hợp lệ
  src/state/claim.ts              SQL claim/heartbeat/reap (được SqliteStateStore gọi)
  src/config/resolve.ts           resolveEffectiveConfig()
  src/config/secrets.ts           EnvSecretResolver
  src/observability/redaction.ts  Redactor
  src/observability/logger.ts     createLogger()
  src/artifacts/checksum.ts       sha256File(), canonicalDigest()
  src/artifacts/registry.ts       ArtifactRegistry.commitFromWorkspace()
  src/environment/workspace.ts    createWorkspace(), workspacePath()
  src/orchestration/planner.ts    Planner.plan(), enqueue(), advance()
  src/orchestration/controller.ts Controller.commit()
  src/orchestration/journal.ts    ExternalOperationJournal
  src/orchestration/reconcile.ts  reconcileOperation()
  src/verification/verifier.ts    Verifier
  src/verification/checkers.ts    schemaValid, outputExists, checksumMatch
  test/**/*.test.ts
packages/executors/
  src/index.ts  src/script-executor.ts  src/agent-executor.ts  src/registry.ts
packages/adapters/fake/
  src/index.ts  src/fake-stage-script.ts  src/fake-agent-runtime.ts  src/fake-provider.ts
packages/worker/
  src/index.ts  src/worker.ts  src/heartbeat.ts
packages/cli/
  src/main.ts  src/composition.ts  src/commands/*.ts
tests/integration/*.test.ts
tests/acceptance/*.test.ts
docs/adr/0001-control-plane-baseline.md
```

---

### Task 1: Bootstrap monorepo và package `contracts` với ID

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `.npmrc`
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/src/ids.ts`, `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/ids.test.ts`

**Interfaces:**
- Produces: `newId(kind: IdKind): string`, `idSchema(kind: IdKind): z.ZodString`, `ID_PREFIXES`.

- [ ] **Step 1: Kích hoạt pnpm qua corepack và tạo file gốc**

```bash
corepack enable
corepack prepare pnpm@latest --activate
pnpm --version
```

`package.json` (điền `packageManager` bằng đúng version `pnpm --version` vừa in):

```json
{
  "name": "youtube-operations-harness",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.0.0",
  "engines": { "node": ">=22.13" },
  "scripts": {
    "build": "pnpm -r --filter './packages/**' run build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "pnpm -r --filter './packages/**' run typecheck",
    "gen:schemas": "pnpm --filter @harness/contracts run gen:schemas"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "packages/adapters/*"
  - "packages/agent-runtime/*"
```

`.npmrc`:

```ini
node-linker=hoisted
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "types": ["node"]
  }
}
```

`vitest.workspace.ts`:

```ts
export default [
  "packages/*/vitest.config.ts",
  "packages/adapters/*/vitest.config.ts",
  "tests/vitest.config.ts",
];
```

- [ ] **Step 2: Tạo package contracts**

`packages/contracts/package.json`:

```json
{
  "name": "@harness/contracts",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "gen:schemas": "tsx scripts/gen-json-schema.ts"
  },
  "dependencies": {
    "ulid": "^2.3.0",
    "zod": "^3.23.0",
    "zod-to-json-schema": "^3.23.0"
  }
}
```

`packages/contracts/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`packages/contracts/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

Chạy `pnpm install` ở root. Kỳ vọng: `node_modules/` xuất hiện, không lỗi.

- [ ] **Step 3: Viết test ID thất bại**

`packages/contracts/test/ids.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ID_PREFIXES, idSchema, newId } from "../src/ids.js";

describe("ids", () => {
  it("generates prefixed ULIDs for every kind", () => {
    for (const kind of Object.keys(ID_PREFIXES) as (keyof typeof ID_PREFIXES)[]) {
      const id = newId(kind);
      expect(id).toMatch(new RegExp(`^${ID_PREFIXES[kind]}_[0-9A-HJKMNP-TV-Z]{26}$`));
      expect(idSchema(kind).safeParse(id).success).toBe(true);
    }
  });
  it("rejects ids with the wrong prefix", () => {
    expect(idSchema("run").safeParse(newId("attempt")).success).toBe(false);
  });
  it("uses the blueprint prefixes", () => {
    expect(ID_PREFIXES).toEqual({
      run: "run", stage_run: "stage", attempt: "attempt", artifact: "artifact",
      external_operation: "op", check_result: "check", event: "evt", source_item: "src",
      content_item: "content", content_variant: "variant", channel_package: "pkg",
      publication_job: "pub", incident: "inc",
    });
  });
});
```

- [ ] **Step 4: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/contracts/test/ids.test.ts`
Expected: FAIL, `Cannot find module '../src/ids.js'`.

- [ ] **Step 5: Viết `ids.ts` và `index.ts`**

`packages/contracts/src/ids.ts`:

```ts
import { ulid } from "ulid";
import { z } from "zod";

export const ID_PREFIXES = {
  run: "run",
  stage_run: "stage",
  attempt: "attempt",
  artifact: "artifact",
  external_operation: "op",
  check_result: "check",
  event: "evt",
  source_item: "src",
  content_item: "content",
  content_variant: "variant",
  channel_package: "pkg",
  publication_job: "pub",
  incident: "inc",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const ULID_RE = "[0-9A-HJKMNP-TV-Z]{26}";

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${ulid()}`;
}

export function idSchema(kind: IdKind): z.ZodString {
  return z.string().regex(new RegExp(`^${ID_PREFIXES[kind]}_${ULID_RE}$`), `expected ${kind} id`);
}
```

`packages/contracts/src/index.ts`:

```ts
export * from "./ids.js";
```

- [ ] **Step 6: Chạy test, xác nhận pass**

Run: `pnpm vitest run packages/contracts/test/ids.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: bootstrap pnpm monorepo and contracts package with ULID ids

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 2: Contract chung, lỗi có mã và 18 entity

**Files:**
- Create: `packages/contracts/src/common.ts`, `packages/contracts/src/errors.ts`, `packages/contracts/src/entities.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/entities.test.ts`, `packages/contracts/test/errors.test.ts`

**Interfaces:**
- Consumes: `idSchema`, `newId` từ Task 1.
- Produces: `checksumSchema`, `timestampSchema`, `revisionSchema`, `schemaVersion(name)`, `HarnessError`, `ErrorCode`, và các Zod schema + type: `Run`, `StageRun`, `Attempt`, `Artifact`, `ExternalOperation`, `CheckResult`, `Event`, `Lease`, `Project`, `Portfolio`, `Channel`, `SourceItem`, `ContentItem`, `ProductionProfileRef`, `ContentVariant`, `DistributionPlan`, `ChannelPackage`, `PublicationJob`, `WorkflowRelease`, `Incident`. Các enum state: `RUN_STATES`, `STAGE_RUN_STATES`, `ATTEMPT_STATES`, `ARTIFACT_STATUSES`, `EXTERNAL_OPERATION_STATUSES`, `PUBLICATION_STATES`.

- [ ] **Step 1: Viết test thất bại**

`packages/contracts/test/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HarnessError } from "../src/errors.js";

describe("HarnessError", () => {
  it("carries a closed error code and details", () => {
    const err = new HarnessError("INVALID_TRANSITION", "bad move", { from: "A", to: "B" });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("INVALID_TRANSITION");
    expect(err.details).toEqual({ from: "A", to: "B" });
    expect(err.message).toBe("bad move");
  });
});
```

`packages/contracts/test/entities.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newId } from "../src/ids.js";
import { AttemptSchema, ArtifactSchema, RunSchema, StageRunSchema, EventSchema, LeaseSchema } from "../src/entities.js";

const now = "2026-09-11T00:00:00.000Z";

describe("entities", () => {
  it("round-trips a Run", () => {
    const run = {
      schema_version: "harness.run/v1",
      run_id: newId("run"),
      project_id: "project-main",
      portfolio_id: "portfolio-main",
      workflow_release: { id: "sample-three-stage", version: "1.0.0", digest: "sha256:" + "a".repeat(64) },
      profile_snapshot: { id: "cartoon", revision: 1 },
      state: "DRAFT",
      effective_config_snapshot: { lease_seconds: 90 },
      effective_config_digest: "sha256:" + "b".repeat(64),
      total_cost_usd: 0,
      created_at: now,
      updated_at: now,
    };
    expect(RunSchema.parse(run)).toEqual(run);
  });

  it("rejects unknown keys and bad ids", () => {
    const base = StageRunSchema.parse({
      schema_version: "harness.stage-run/v1",
      stage_run_id: newId("stage_run"),
      run_id: newId("run"),
      stage_key: "produce",
      executor: { type: "script", script: "fake-stage" },
      depends_on: [],
      required_capabilities: ["write_workspace"],
      required_checks: ["schema-valid"],
      retry: { max_attempts: 3, backoff_seconds: [10, 60, 300], retry_on: ["transient", "abandoned"] },
      stage_config: {},
      state: "PENDING",
      attempt_count: 0,
      result_failures: 0,
      created_at: now,
      updated_at: now,
    });
    expect(StageRunSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(StageRunSchema.safeParse({ ...base, run_id: "run_bad" }).success).toBe(false);
    expect(StageRunSchema.safeParse({ ...base, state: "FLYING" }).success).toBe(false);
  });

  it("requires sha256 checksums and Z timestamps", () => {
    const attempt = {
      schema_version: "harness.attempt/v1",
      attempt_id: newId("attempt"),
      stage_run_id: newId("stage_run"),
      run_id: newId("run"),
      lease_owner: "worker-1",
      fencing_token: 1,
      state: "CLAIMED",
      started_at: now,
      created_at: now,
      updated_at: now,
    };
    expect(AttemptSchema.safeParse(attempt).success).toBe(true);
    expect(AttemptSchema.safeParse({ ...attempt, started_at: "2026-09-11T00:00:00+07:00" }).success).toBe(false);
    expect(ArtifactSchema.safeParse({ checksum: "md5:abc" }).success).toBe(false);
  });

  it("parses Event and Lease", () => {
    expect(EventSchema.safeParse({
      schema_version: "harness.event/v1", event_id: newId("event"), occurred_at: now,
      run_id: newId("run"), stage_run_id: null, attempt_id: null, project_id: "p", portfolio_id: null,
      channel_id: null, content_id: null, variant_id: null, workflow_release: "sample@1.0.0",
      severity: "info", event_type: "run.created", payload: {},
    }).success).toBe(true);
    expect(LeaseSchema.safeParse({
      stage_run_id: newId("stage_run"), attempt_id: newId("attempt"), owner: "w", expires_at: now, fencing_token: 1,
    }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/contracts`
Expected: FAIL, module `../src/errors.js` và `../src/entities.js` không tồn tại.

- [ ] **Step 3: Viết `common.ts` và `errors.ts`**

`packages/contracts/src/common.ts`:

```ts
import { z } from "zod";

export const checksumSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<hex>");
export const timestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/,
  "expected ISO 8601 UTC with Z suffix",
);
export const revisionSchema = z.number().int().min(1);
export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
export const secretRefSchema = z.string().regex(/^secret:\/\/[a-z0-9-]+\/[a-z0-9-]+$/);
export const jsonObjectSchema = z.record(z.string(), z.unknown());

export function schemaVersion<N extends string>(name: N) {
  return z.literal(`harness.${name}/v1` as const);
}

export type Checksum = z.infer<typeof checksumSchema>;
export type Timestamp = z.infer<typeof timestampSchema>;
```

`packages/contracts/src/errors.ts`:

```ts
export const ERROR_CODES = [
  "INVALID_TRANSITION",
  "STALE_STATE",
  "FENCING_REJECTED",
  "LEASE_LOST",
  "NOT_FOUND",
  "SCHEMA_INVALID",
  "CONFIG_INVALID",
  "UNKNOWN_CONFIG_KEY",
  "SECRET_UNRESOLVED",
  "CHECKSUM_MISMATCH",
  "WORKFLOW_INVALID",
  "EXECUTOR_FAILED",
  "EXECUTOR_TIMEOUT",
  "CONNECTION_LOST",
  "RECONCILE_FAILED",
  "IO_ERROR",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class HarnessError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
    this.details = details;
  }
}

export function isHarnessError(e: unknown, code?: ErrorCode): e is HarnessError {
  return e instanceof HarnessError && (code === undefined || e.code === code);
}
```

- [ ] **Step 4: Viết `entities.ts`**

`packages/contracts/src/entities.ts`:

```ts
import { z } from "zod";
import { idSchema } from "./ids.js";
import { checksumSchema, jsonObjectSchema, revisionSchema, schemaVersion, secretRefSchema, semverSchema, timestampSchema } from "./common.js";

// ---- state enums (blueprint §9 + spec B.5) ----
export const RUN_STATES = ["DRAFT", "READY", "RUNNING", "WAITING", "CANCEL_REQUESTED", "CANCELLED", "SUCCEEDED", "FAILED"] as const;
export const STAGE_RUN_STATES = ["PENDING", "READY", "CLAIMED", "RUNNING", "VERIFYING", "WAITING_EXTERNAL", "NEEDS_RECONCILIATION", "WAITING_HUMAN", "CANCEL_REQUESTED", "CANCELLED", "SUCCEEDED", "FAILED"] as const;
export const ATTEMPT_STATES = ["CLAIMED", "RUNNING", "SUCCEEDED", "FAILED", "ABANDONED", "CANCELLED"] as const;
export const ARTIFACT_STATUSES = ["PROVISIONAL", "ACCEPTED", "REJECTED", "STALE", "ARCHIVED"] as const;
export const EXTERNAL_OPERATION_STATUSES = ["INTENT_RECORDED", "DISPATCHED", "NEEDS_RECONCILIATION", "CONFIRMED", "FAILED"] as const;
export const PUBLICATION_STATES = ["DRAFT", "READY", "SCHEDULED", "UPLOADING", "PROCESSING", "PUBLISHED", "NEEDS_RECONCILIATION", "FAILED"] as const;
export const FAILURE_KINDS = ["transient", "result", "contract", "unknown", "abandoned"] as const;
export const SEVERITIES = ["debug", "info", "warn", "error"] as const;

export const workflowRefSchema = z.object({ id: z.string().min(1), version: semverSchema, digest: checksumSchema }).strict();
export const profileRefSchema = z.object({ id: z.string().min(1), revision: revisionSchema }).strict();
export const retryPolicySchema = z.object({
  max_attempts: z.number().int().min(1),
  backoff_seconds: z.array(z.number().int().min(0)),
  retry_on: z.array(z.enum(FAILURE_KINDS)),
}).strict();
export const executorRefSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("script"), script: z.string().min(1) }).strict(),
  z.object({ type: z.literal("agent"), skill: z.string().min(1), brief: z.string().default("") }).strict(),
]);

// ---- control plane entities ----
export const RunSchema = z.object({
  schema_version: schemaVersion("run"),
  run_id: idSchema("run"),
  project_id: z.string().min(1),
  portfolio_id: z.string().min(1),
  workflow_release: workflowRefSchema,
  profile_snapshot: profileRefSchema,
  source_id: idSchema("source_item").optional(),
  content_id: idSchema("content_item").optional(),
  variant_id: idSchema("content_variant").optional(),
  state: z.enum(RUN_STATES),
  effective_config_snapshot: jsonObjectSchema,
  effective_config_digest: checksumSchema,
  total_cost_usd: z.number().min(0),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const StageRunSchema = z.object({
  schema_version: schemaVersion("stage-run"),
  stage_run_id: idSchema("stage_run"),
  run_id: idSchema("run"),
  stage_key: z.string().regex(/^[a-z][a-z0-9-]*$/),
  executor: executorRefSchema,
  depends_on: z.array(z.string()),
  required_capabilities: z.array(z.string()),
  required_checks: z.array(z.string()),
  retry: retryPolicySchema,
  stage_config: jsonObjectSchema,
  state: z.enum(STAGE_RUN_STATES),
  attempt_count: z.number().int().min(0),
  result_failures: z.number().int().min(0),
  ready_at: timestampSchema.optional(),
  not_before: timestampSchema.optional(),
  last_failure_kind: z.enum(FAILURE_KINDS).optional(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const AttemptSchema = z.object({
  schema_version: schemaVersion("attempt"),
  attempt_id: idSchema("attempt"),
  stage_run_id: idSchema("stage_run"),
  run_id: idSchema("run"),
  lease_owner: z.string().min(1),
  fencing_token: z.number().int().min(1),
  state: z.enum(ATTEMPT_STATES),
  workspace_uri: z.string().optional(),
  started_at: timestampSchema,
  finished_at: timestampSchema.optional(),
  failure_kind: z.enum(FAILURE_KINDS).optional(),
  error_summary: z.string().optional(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const ArtifactSchema = z.object({
  schema_version: schemaVersion("artifact"),
  artifact_id: idSchema("artifact"),
  run_id: idSchema("run"),
  stage_run_id: idSchema("stage_run"),
  attempt_id: idSchema("attempt"),
  type: z.string().min(1),
  status: z.enum(ARTIFACT_STATUSES),
  uri: z.string().min(1),
  checksum: checksumSchema,
  size_bytes: z.number().int().min(0),
  mime_type: z.string().min(1),
  lineage: z.object({ input_artifacts: z.array(idSchema("artifact")), source_items: z.array(z.string()) }).strict(),
  reproducibility: z.object({
    workflow_release: z.string(),
    production_profile: z.string(),
    channel_config_revision: z.number().int().nullable(),
    executor_version: z.string(),
    model_parameters_digest: checksumSchema.nullable(),
  }).strict(),
  checks: z.array(idSchema("check_result")),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const ExternalOperationSchema = z.object({
  schema_version: schemaVersion("external-operation"),
  operation_id: idSchema("external_operation"),
  run_id: idSchema("run"),
  stage_run_id: idSchema("stage_run"),
  attempt_id: idSchema("attempt"),
  provider: z.string().min(1),
  kind: z.string().min(1),
  target: z.string().min(1),
  idempotency_key: checksumSchema,
  status: z.enum(EXTERNAL_OPERATION_STATUSES),
  provider_ref: z.string().nullable(),
  receipt: jsonObjectSchema.nullable(),
  cost_usd: z.number().min(0),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const CheckResultSchema = z.object({
  schema_version: schemaVersion("check-result"),
  check_result_id: idSchema("check_result"),
  check_id: z.string().min(1),
  checker_version: z.string().min(1),
  attempt_id: idSchema("attempt"),
  artifact_id: idSchema("artifact").nullable(),
  verdict: z.enum(["pass", "fail", "skip"]),
  evidence: jsonObjectSchema,
  created_at: timestampSchema,
}).strict();

export const EventSchema = z.object({
  schema_version: schemaVersion("event"),
  event_id: idSchema("event"),
  occurred_at: timestampSchema,
  run_id: idSchema("run").nullable(),
  stage_run_id: idSchema("stage_run").nullable(),
  attempt_id: idSchema("attempt").nullable(),
  project_id: z.string().nullable(),
  portfolio_id: z.string().nullable(),
  channel_id: z.string().nullable(),
  content_id: z.string().nullable(),
  variant_id: z.string().nullable(),
  workflow_release: z.string().nullable(),
  severity: z.enum(SEVERITIES),
  event_type: z.string().regex(/^[a-z_]+\.[a-z_]+$/),
  payload: jsonObjectSchema,
}).strict();

export const LeaseSchema = z.object({
  stage_run_id: idSchema("stage_run"),
  attempt_id: idSchema("attempt"),
  owner: z.string().min(1),
  expires_at: timestampSchema,
  fencing_token: z.number().int().min(1),
}).strict();

// ---- domain entities frozen now, tables added in later sub-projects ----
export const ProjectSchema = z.object({
  schema_version: schemaVersion("project"), project_id: z.string().min(1), template_release: z.string().min(1),
  runtime: z.enum(["claude", "codex"]), data_root: z.string().min(1), created_at: timestampSchema,
}).strict();
export const PortfolioSchema = z.object({
  schema_version: schemaVersion("portfolio"), portfolio_id: z.string().min(1), project_id: z.string().min(1), display_name: z.string(),
}).strict();
export const ChannelSchema = z.object({
  schema_version: schemaVersion("channel"), channel_id: z.string().min(1), portfolio_id: z.string().min(1),
  account_ref: secretRefSchema, expected_channel_id: z.string().min(1), config_revision: revisionSchema,
}).strict();
export const SourceItemSchema = z.object({
  schema_version: schemaVersion("source-item"), source_id: idSchema("source_item"), uri: z.string().min(1),
  checksum: checksumSchema, rights_status: z.enum(["unknown", "cleared", "restricted"]), language: z.string().nullable(),
  duration_seconds: z.number().nullable(), ingested_at: timestampSchema,
}).strict();
export const ContentItemSchema = z.object({
  schema_version: schemaVersion("content-item"), content_id: idSchema("content_item"), source_ids: z.array(idSchema("source_item")),
  revision: revisionSchema, title: z.string(), created_at: timestampSchema,
}).strict();
export const ProductionProfileRefSchema = z.object({
  schema_version: schemaVersion("production-profile-ref"), profile_id: z.enum(["cartoon", "avatar", "footage"]), profile_revision: revisionSchema,
}).strict();
export const ContentVariantSchema = z.object({
  schema_version: schemaVersion("content-variant"), variant_id: idSchema("content_variant"), content_id: idSchema("content_item"),
  profile_id: z.string().min(1), profile_revision: revisionSchema, created_at: timestampSchema,
}).strict();
export const DistributionPlanSchema = z.object({
  schema_version: schemaVersion("distribution-plan"), plan_id: z.string().min(1), revision: revisionSchema,
  entries: z.array(z.object({ variant_id: idSchema("content_variant"), channel_id: z.string(), publish_slot: timestampSchema.nullable() }).strict()),
}).strict();
export const ChannelPackageSchema = z.object({
  schema_version: schemaVersion("channel-package"), package_id: idSchema("channel_package"), channel_id: z.string().min(1),
  variant_id: idSchema("content_variant"), manifest_digest: checksumSchema, video_artifact_id: idSchema("artifact"),
  thumbnail_artifact_id: idSchema("artifact"), metadata_revision: revisionSchema, channel_config_revision: revisionSchema, created_at: timestampSchema,
}).strict();
export const PublicationJobSchema = z.object({
  schema_version: schemaVersion("publication-job"), publication_job_id: idSchema("publication_job"), package_id: idSchema("channel_package"),
  idempotency_key: checksumSchema, state: z.enum(PUBLICATION_STATES), youtube_video_id: z.string().nullable(), receipt: jsonObjectSchema.nullable(),
  created_at: timestampSchema, updated_at: timestampSchema,
}).strict();
export const WorkflowReleaseSchema = z.object({
  schema_version: schemaVersion("workflow-release"), workflow_id: z.string().min(1), version: semverSchema, digest: checksumSchema, released_at: timestampSchema,
}).strict();
export const IncidentSchema = z.object({
  schema_version: schemaVersion("incident"), incident_id: idSchema("incident"), severity: z.enum(["low", "medium", "high", "critical"]),
  run_id: idSchema("run").nullable(), status: z.enum(["open", "investigating", "resolved"]), summary: z.string(), created_at: timestampSchema,
}).strict();

export type Run = z.infer<typeof RunSchema>;
export type StageRun = z.infer<typeof StageRunSchema>;
export type Attempt = z.infer<typeof AttemptSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type ExternalOperation = z.infer<typeof ExternalOperationSchema>;
export type CheckResult = z.infer<typeof CheckResultSchema>;
export type Event = z.infer<typeof EventSchema>;
export type Lease = z.infer<typeof LeaseSchema>;
export type RetryPolicy = z.infer<typeof retryPolicySchema>;
export type ExecutorRef = z.infer<typeof executorRefSchema>;
export type FailureKind = (typeof FAILURE_KINDS)[number];
export type RunState = (typeof RUN_STATES)[number];
export type StageRunState = (typeof STAGE_RUN_STATES)[number];
export type AttemptState = (typeof ATTEMPT_STATES)[number];
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];
export type ExternalOperationStatus = (typeof EXTERNAL_OPERATION_STATUSES)[number];
```

Cập nhật `packages/contracts/src/index.ts`:

```ts
export * from "./ids.js";
export * from "./common.js";
export * from "./errors.js";
export * from "./entities.js";
```

- [ ] **Step 5: Chạy test, xác nhận pass**

Run: `pnpm vitest run packages/contracts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): add common scalars, HarnessError and entity schemas

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Contract thực thi, contract cấu hình, interface và JSON Schema

**Files:**
- Create: `packages/contracts/src/execution.ts`, `packages/contracts/src/config.ts`, `packages/contracts/src/interfaces.ts`, `packages/contracts/scripts/gen-json-schema.ts`, `packages/contracts/schemas/` (sinh ra)
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/execution.test.ts`, `packages/contracts/test/config.test.ts`, `packages/contracts/test/json-schema.test.ts`

**Interfaces:**
- Produces: `StageRequestSchema`, `StageResultSchema`, `ArtifactManifestSchema`, `WorkflowDefinitionSchema`, `ProductionProfileSchema`, `ChannelConfigSchema`, `ProjectConfigSchema`, `HarnessConfigSchema` và type tương ứng; interface `StateStore`, `Executor`, `ExecutorContext`, `AgentRuntime`, `AgentTask`, `Checker`, `SecretResolver`, `Clock`, `ExternalProvider`, `ClaimResult`, `TransitionKind`, `EventInput`, `ReapedLease`. Hàm `ALL_SCHEMAS` (map tên → Zod).

- [ ] **Step 1: Viết test thất bại**

`packages/contracts/test/execution.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newId } from "../src/ids.js";
import { StageRequestSchema, StageResultSchema, ArtifactManifestSchema } from "../src/execution.js";

const now = "2026-09-11T00:00:00.000Z";
const sha = "sha256:" + "c".repeat(64);

describe("execution contracts", () => {
  it("parses a StageRequest", () => {
    const req = {
      schema_version: "harness.stage-request/v1",
      run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"),
      project_id: "project-main", portfolio_id: "portfolio-main", stage_key: "produce",
      workflow: { id: "sample-three-stage", version: "1.0.0", digest: sha },
      profile_snapshot: { id: "cartoon", revision: 1 },
      inputs: [{ artifact_id: newId("artifact"), checksum: sha, path: "input/script.txt", type: "text/plain" }],
      workspace_uri: "file:///tmp/ws",
      stage_config: { fail_transient_times: 0 },
      limits: { deadline_at: now, max_cost_usd: 5, max_attempts: 3 },
      capabilities: ["write_workspace"],
      fencing_token: 1,
    };
    expect(StageRequestSchema.parse(req)).toEqual(req);
  });
  it("parses a StageResult with defaults", () => {
    const res = StageResultSchema.parse({
      schema_version: "harness.stage-result/v1", attempt_id: newId("attempt"), outcome: "succeeded",
      outputs: [{ path: "output/result.txt", type: "text/plain", checksum: sha, size_bytes: 12 }],
    });
    expect(res.checks).toEqual([]);
    expect(res.usage).toEqual({ wall_seconds: 0, cost_usd: 0 });
    expect(res.external_operations).toEqual([]);
    expect(res.errors).toEqual([]);
  });
  it("rejects outcome outside the enum", () => {
    expect(StageResultSchema.safeParse({ schema_version: "harness.stage-result/v1", attempt_id: newId("attempt"), outcome: "meh", outputs: [] }).success).toBe(false);
  });
  it("parses an ArtifactManifest", () => {
    expect(ArtifactManifestSchema.safeParse({
      schema_version: "harness.artifact/v1", artifact_id: newId("artifact"), type: "final_video", status: "accepted",
      uri: "file:///x", checksum: sha, size_bytes: 1, mime_type: "video/mp4",
      created_by: { run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt") },
      lineage: { input_artifacts: [], source_items: [] },
      reproducibility: { workflow_release: "w@1.0.0", production_profile: "cartoon@1", channel_config_revision: null, executor_version: "fake@0.1.0", model_parameters_digest: null },
      checks: [],
    }).success).toBe(true);
  });
});
```

`packages/contracts/test/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HarnessConfigSchema, ProjectConfigSchema, WorkflowDefinitionSchema } from "../src/config.js";

describe("config contracts", () => {
  it("parses a workflow definition and rejects unknown keys", () => {
    const wf = {
      schema_version: "harness.workflow/v1", id: "sample-three-stage", version: "1.0.0",
      defaults: { lease_seconds: 90 },
      stages: [
        { key: "produce", executor: { type: "script", script: "fake-stage" }, depends_on: [], required_capabilities: ["write_workspace"], required_checks: ["schema-valid", "output-exists", "checksum-match"], outputs: [{ type: "script_text", mime_type: "text/plain" }] },
        { key: "verify", executor: { type: "agent", skill: "fake-review", brief: "review it" }, depends_on: ["produce"], required_capabilities: ["read_source"], required_checks: ["schema-valid"] },
      ],
    };
    const parsed = WorkflowDefinitionSchema.parse(wf);
    expect(parsed.stages[0]?.retry).toEqual({ max_attempts: 3, backoff_seconds: [10, 60, 300], retry_on: ["transient", "abandoned"] });
    expect(WorkflowDefinitionSchema.safeParse({ ...wf, bogus: true }).success).toBe(false);
  });
  it("rejects a stage that depends on a missing key", () => {
    expect(WorkflowDefinitionSchema.safeParse({
      schema_version: "harness.workflow/v1", id: "w", version: "1.0.0", defaults: {},
      stages: [{ key: "a", executor: { type: "script", script: "x" }, depends_on: ["nope"], required_capabilities: [], required_checks: [] }],
    }).success).toBe(false);
  });
  it("rejects a dependency cycle longer than one stage", () => {
    const r = WorkflowDefinitionSchema.safeParse({
      schema_version: "harness.workflow/v1", id: "w", version: "1.0.0", defaults: {},
      stages: [
        { key: "a", executor: { type: "script", script: "x" }, depends_on: ["c"], required_capabilities: [], required_checks: [] },
        { key: "b", executor: { type: "script", script: "x" }, depends_on: ["a"], required_capabilities: [], required_checks: [] },
        { key: "c", executor: { type: "script", script: "x" }, depends_on: ["b"], required_capabilities: [], required_checks: [] },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.message.startsWith("dependency cycle"))).toBe(true);
  });
  it("applies harness defaults", () => {
    const cfg = HarnessConfigSchema.parse({ schema_version: "harness.config/v1" });
    expect(cfg.lease_seconds).toBe(90);
    expect(cfg.heartbeat_seconds).toBe(30);
    expect(cfg.poll_seconds).toBe(2);
    expect(cfg.retention.workspace_days).toBe(7);
  });
  it("parses project config with runtime", () => {
    expect(ProjectConfigSchema.parse({
      schema_version: "harness.project/v1", project_id: "project-main", template_release: "0.1.0", runtime: "claude",
      data_root: "E:/youtube-operations-data", portfolios: [{ portfolio_id: "portfolio-main", display_name: "Main" }],
    }).runtime).toBe("claude");
  });
});
```

`packages/contracts/test/json-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ALL_SCHEMAS, toJsonSchema } from "../scripts/gen-json-schema.js";

describe("generated JSON schemas", () => {
  it("match the Zod definitions on disk", () => {
    for (const [name, schema] of Object.entries(ALL_SCHEMAS)) {
      const file = join(__dirname, "..", "schemas", `${name}.json`);
      expect(existsSync(file), `${file} missing; run pnpm gen:schemas`).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(toJsonSchema(name, schema));
    }
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/contracts`
Expected: FAIL, thiếu module `execution.js`, `config.js`, `gen-json-schema.js`.

- [ ] **Step 3: Viết `execution.ts`**

`packages/contracts/src/execution.ts`:

```ts
import { z } from "zod";
import { idSchema } from "./ids.js";
import { checksumSchema, jsonObjectSchema, schemaVersion, timestampSchema } from "./common.js";
import { profileRefSchema, workflowRefSchema } from "./entities.js";

export const stageInputSchema = z.object({
  artifact_id: idSchema("artifact"),
  checksum: checksumSchema,
  path: z.string().min(1),
  type: z.string().min(1),
}).strict();

export const StageRequestSchema = z.object({
  schema_version: schemaVersion("stage-request"),
  run_id: idSchema("run"),
  stage_run_id: idSchema("stage_run"),
  attempt_id: idSchema("attempt"),
  project_id: z.string().min(1),
  portfolio_id: z.string().min(1),
  stage_key: z.string().min(1),
  workflow: workflowRefSchema,
  profile_snapshot: profileRefSchema,
  inputs: z.array(stageInputSchema),
  workspace_uri: z.string().min(1),
  stage_config: jsonObjectSchema,
  limits: z.object({ deadline_at: timestampSchema, max_cost_usd: z.number().min(0), max_attempts: z.number().int().min(1) }).strict(),
  capabilities: z.array(z.string()),
  fencing_token: z.number().int().min(1),
}).strict();

export const stageOutputSchema = z.object({
  path: z.string().min(1),
  type: z.string().min(1),
  checksum: checksumSchema,
  size_bytes: z.number().int().min(0),
}).strict();

export const stageErrorSchema = z.object({
  kind: z.enum(["transient", "result", "contract", "unknown"]),
  message: z.string(),
  details: jsonObjectSchema.default({}),
}).strict();

export const StageResultSchema = z.object({
  schema_version: schemaVersion("stage-result"),
  attempt_id: idSchema("attempt"),
  outcome: z.enum(["succeeded", "failed", "deferred", "unknown"]),
  outputs: z.array(stageOutputSchema),
  checks: z.array(z.object({ check_id: z.string(), verdict: z.enum(["pass", "fail", "skip"]), evidence: jsonObjectSchema.default({}) }).strict()).default([]),
  usage: z.object({ wall_seconds: z.number().min(0), cost_usd: z.number().min(0) }).strict().default({ wall_seconds: 0, cost_usd: 0 }),
  external_operations: z.array(idSchema("external_operation")).default([]),
  errors: z.array(stageErrorSchema).default([]),
}).strict();

export const ArtifactManifestSchema = z.object({
  schema_version: schemaVersion("artifact"),
  artifact_id: idSchema("artifact"),
  type: z.string().min(1),
  status: z.enum(["provisional", "accepted", "rejected", "stale", "archived"]),
  uri: z.string().min(1),
  checksum: checksumSchema,
  size_bytes: z.number().int().min(0),
  mime_type: z.string().min(1),
  created_by: z.object({ run_id: idSchema("run"), stage_run_id: idSchema("stage_run"), attempt_id: idSchema("attempt") }).strict(),
  lineage: z.object({ input_artifacts: z.array(idSchema("artifact")), source_items: z.array(z.string()) }).strict(),
  reproducibility: z.object({
    workflow_release: z.string(), production_profile: z.string(), channel_config_revision: z.number().int().nullable(),
    executor_version: z.string(), model_parameters_digest: checksumSchema.nullable(),
  }).strict(),
  checks: z.array(idSchema("check_result")),
}).strict();

export type StageRequest = z.infer<typeof StageRequestSchema>;
export type StageResult = z.infer<typeof StageResultSchema>;
export type StageOutput = z.infer<typeof stageOutputSchema>;
export type StageInput = z.infer<typeof stageInputSchema>;
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
```

- [ ] **Step 4: Viết `config.ts`**

`packages/contracts/src/config.ts`:

```ts
import { z } from "zod";
import { jsonObjectSchema, revisionSchema, schemaVersion, secretRefSchema, semverSchema } from "./common.js";
import { executorRefSchema, retryPolicySchema } from "./entities.js";

export const DEFAULT_RETRY = { max_attempts: 3, backoff_seconds: [10, 60, 300], retry_on: ["transient", "abandoned"] as const };

export const stageDefinitionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]*$/),
  executor: executorRefSchema,
  depends_on: z.array(z.string()).default([]),
  required_capabilities: z.array(z.string()).default([]),
  required_checks: z.array(z.string()).default([]),
  retry: retryPolicySchema.default({ ...DEFAULT_RETRY, retry_on: [...DEFAULT_RETRY.retry_on] }),
  outputs: z.array(z.object({ type: z.string().min(1), mime_type: z.string().min(1) }).strict()).default([]),
  config: jsonObjectSchema.default({}),
}).strict();

export const WorkflowDefinitionSchema = z.object({
  schema_version: schemaVersion("workflow"),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: semverSchema,
  defaults: jsonObjectSchema.default({}),
  stages: z.array(stageDefinitionSchema).min(1),
}).strict().superRefine((wf, ctx) => {
  const keys = new Set(wf.stages.map((s) => s.key));
  if (keys.size !== wf.stages.length) ctx.addIssue({ code: "custom", message: "duplicate stage key" });
  for (const s of wf.stages) for (const d of s.depends_on) {
    if (!keys.has(d)) ctx.addIssue({ code: "custom", message: `stage ${s.key} depends on unknown stage ${d}` });
    if (d === s.key) ctx.addIssue({ code: "custom", message: `stage ${s.key} depends on itself` });
  }
  // cycle detection (added after Task 3 review): DFS with colouring over depends_on edges
  const deps = new Map(wf.stages.map((s) => [s.key, s.depends_on]));
  const colour = new Map<string, 1 | 2>();
  const visit = (k: string, path: string[]): void => {
    if (colour.get(k) === 2) return;
    if (colour.get(k) === 1) { ctx.addIssue({ code: "custom", message: `dependency cycle: ${[...path, k].join(" -> ")}` }); return; }
    colour.set(k, 1);
    for (const d of deps.get(k) ?? []) if (keys.has(d)) visit(d, [...path, k]);
    colour.set(k, 2);
  };
  for (const s of wf.stages) visit(s.key, []);
});

export const ProductionProfileSchema = z.object({
  schema_version: schemaVersion("production-profile"),
  profile_id: z.enum(["cartoon", "avatar", "footage"]),
  revision: revisionSchema,
  status: z.enum(["active", "draft", "retired"]),
  workflow_release: z.string().regex(/^[a-z][a-z0-9-]*@\d+\.\d+\.\d+$/),
  overrides: jsonObjectSchema.default({}),
  verification: z.object({ required_checks: z.array(z.string()).default([]) }).strict().default({ required_checks: [] }),
  limits: z.object({ max_cost_usd_per_variant: z.number().min(0).default(5), max_concurrency: z.number().int().min(1).default(1) }).strict().default({ max_cost_usd_per_variant: 5, max_concurrency: 1 }),
}).strict();

export const ChannelConfigSchema = z.object({
  schema_version: schemaVersion("channel"),
  channel_id: z.string().min(1),
  config_revision: revisionSchema,
  display_name: z.string(),
  portfolio_id: z.string().min(1),
  youtube: z.object({ account_ref: secretRefSchema, expected_channel_id: z.string().min(1) }).strict(),
  publication: z.object({
    timezone: z.string(), visibility: z.enum(["private", "unlisted", "public"]), allowed_profiles: z.array(z.string()),
    max_daily_uploads: z.number().int().min(0), require_human_approval_for_public: z.boolean(),
  }).strict(),
  overrides: jsonObjectSchema.default({}),
}).strict();

export const ProjectConfigSchema = z.object({
  schema_version: schemaVersion("project"),
  project_id: z.string().min(1),
  template_release: z.string().min(1),
  runtime: z.enum(["claude", "codex"]),
  data_root: z.string().min(1),
  portfolios: z.array(z.object({ portfolio_id: z.string().min(1), display_name: z.string() }).strict()).min(1),
}).strict();

export const HarnessConfigSchema = z.object({
  schema_version: schemaVersion("config"),
  lease_seconds: z.number().int().min(5).default(90),
  heartbeat_seconds: z.number().int().min(1).default(30),
  poll_seconds: z.number().int().min(1).default(2),
  default_deadline_seconds: z.number().int().min(1).default(3600),
  default_max_cost_usd: z.number().min(0).default(5),
  retention: z.object({ workspace_days: z.number().int().min(0).default(7) }).strict().default({ workspace_days: 7 }),
  allowed_override_keys: z.array(z.string()).default(["lease_seconds", "default_deadline_seconds", "default_max_cost_usd"]),
}).strict();

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type StageDefinition = z.infer<typeof stageDefinitionSchema>;
export type ProductionProfile = z.infer<typeof ProductionProfileSchema>;
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
```

- [ ] **Step 5: Viết `interfaces.ts`**

`packages/contracts/src/interfaces.ts`:

```ts
import type { Artifact, Attempt, CheckResult, Event, ExternalOperation, Lease, Run, StageRun } from "./entities.js";
import type { StageRequest, StageResult } from "./execution.js";

export type TransitionKind = "run" | "stage_run" | "attempt" | "artifact" | "external_operation";

export type EventInput = Omit<Event, "schema_version" | "event_id" | "occurred_at">;

export interface ClaimParams { owner: string; capabilities: string[]; now: string; leaseSeconds: number }
export interface ClaimResult { stageRun: StageRun; attempt: Attempt; lease: Lease }
export interface ReapedLease { stage_run_id: string; attempt_id: string; owner: string; requeued: boolean }

export interface StateStore {
  migrate(migrationsDir: string): string[];
  transaction<T>(fn: () => T): T;
  close(): void;

  insertRun(run: Run): void;
  getRun(id: string): Run | undefined;
  updateRun(run: Run): void;
  listRuns(filter?: { state?: string }): Run[];

  insertStageRun(s: StageRun): void;
  getStageRun(id: string): StageRun | undefined;
  updateStageRun(s: StageRun): void;
  listStageRuns(runId: string): StageRun[];

  insertAttempt(a: Attempt): void;
  getAttempt(id: string): Attempt | undefined;
  updateAttempt(a: Attempt): void;
  listAttempts(stageRunId: string): Attempt[];

  insertArtifact(a: Artifact): void;
  getArtifact(id: string): Artifact | undefined;
  listArtifacts(filter: { stage_run_id?: string; run_id?: string; status?: string }): Artifact[];

  insertExternalOperation(op: ExternalOperation): void;
  getExternalOperation(id: string): ExternalOperation | undefined;
  findExternalOperationByKey(idempotencyKey: string): ExternalOperation | undefined;
  updateExternalOperation(op: ExternalOperation): void;

  insertCheckResult(c: CheckResult): void;
  listCheckResults(attemptId: string): CheckResult[];

  appendEvent(e: EventInput): Event;
  listEvents(filter: { run_id?: string; limit?: number }): Event[];

  transition(kind: TransitionKind, id: string, expectedFrom: string, to: string, event: EventInput): void;
  claim(params: ClaimParams): ClaimResult | undefined;
  heartbeat(attemptId: string, fencingToken: number, newExpiresAt: string): boolean;
  getLease(stageRunId: string): Lease | undefined;
  releaseLease(stageRunId: string, fencingToken: number): void;
  reapExpiredLeases(now: string): ReapedLease[];
}

export interface ExecutorContext {
  workspaceDir: string;
  logger: { info(msg: string, data?: object): void; warn(msg: string, data?: object): void; error(msg: string, data?: object): void };
  signal?: AbortSignal;
}
export interface Executor { readonly version: string; execute(request: StageRequest, ctx: ExecutorContext): Promise<StageResult> }

export interface AgentTask { skill: string; brief: string; request: StageRequest; workspaceDir: string }
export interface AgentRuntime { readonly name: string; readonly version: string; runTask(task: AgentTask, ctx: ExecutorContext): Promise<StageResult> }

export interface CheckerInput { request: StageRequest; result: StageResult; workspaceDir: string }
export interface Checker { readonly id: string; readonly version: string; check(input: CheckerInput): Promise<{ verdict: "pass" | "fail" | "skip"; evidence: Record<string, unknown> }> }

export interface SecretResolver { resolve(ref: string): string; resolvedValues(): string[] }
export interface Clock { now(): string }

export interface ExternalProvider {
  readonly name: string;
  dispatch(op: ExternalOperation, payload: Record<string, unknown>): Promise<{ provider_ref: string; receipt: Record<string, unknown> }>;
  lookup(idempotencyKey: string): Promise<{ found: boolean; provider_ref?: string; receipt?: Record<string, unknown> }>;
}
```

- [ ] **Step 6: Viết script sinh JSON Schema và cập nhật index**

`packages/contracts/scripts/gen-json-schema.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import * as E from "../src/entities.js";
import * as X from "../src/execution.js";
import * as C from "../src/config.js";

export const ALL_SCHEMAS: Record<string, ZodTypeAny> = {
  run: E.RunSchema, "stage-run": E.StageRunSchema, attempt: E.AttemptSchema, artifact: E.ArtifactSchema,
  "external-operation": E.ExternalOperationSchema, "check-result": E.CheckResultSchema, event: E.EventSchema, lease: E.LeaseSchema,
  project: E.ProjectSchema, portfolio: E.PortfolioSchema, channel: E.ChannelSchema, "source-item": E.SourceItemSchema,
  "content-item": E.ContentItemSchema, "production-profile-ref": E.ProductionProfileRefSchema, "content-variant": E.ContentVariantSchema,
  "distribution-plan": E.DistributionPlanSchema, "channel-package": E.ChannelPackageSchema, "publication-job": E.PublicationJobSchema,
  "workflow-release": E.WorkflowReleaseSchema, incident: E.IncidentSchema,
  "stage-request": X.StageRequestSchema, "stage-result": X.StageResultSchema, "artifact-manifest": X.ArtifactManifestSchema,
  workflow: C.WorkflowDefinitionSchema, "production-profile": C.ProductionProfileSchema, "channel-config": C.ChannelConfigSchema,
  "project-config": C.ProjectConfigSchema, "harness-config": C.HarnessConfigSchema,
};

export function toJsonSchema(name: string, schema: ZodTypeAny) {
  return zodToJsonSchema(schema, { name, $refStrategy: "none" });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
  mkdirSync(out, { recursive: true });
  for (const [name, schema] of Object.entries(ALL_SCHEMAS)) {
    writeFileSync(join(out, `${name}.json`), JSON.stringify(toJsonSchema(name, schema), null, 2) + "\n");
  }
  console.log(`wrote ${Object.keys(ALL_SCHEMAS).length} schemas to ${out}`);
}
```

`packages/contracts/src/index.ts`:

```ts
export * from "./ids.js";
export * from "./common.js";
export * from "./errors.js";
export * from "./entities.js";
export * from "./execution.js";
export * from "./config.js";
export * from "./interfaces.js";
```

Chạy `pnpm gen:schemas`. Kỳ vọng in `wrote 28 schemas to ...`.

- [ ] **Step 7: Chạy test và typecheck, xác nhận pass**

Run: `pnpm vitest run packages/contracts && pnpm --filter @harness/contracts typecheck`
Expected: PASS toàn bộ, typecheck không lỗi.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): add execution, config contracts, interfaces and generated JSON schemas

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 4: Package `core`, migration SQL và `SqliteStateStore` (CRUD, event, transaction)

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/vitest.config.ts`, `packages/core/src/index.ts`
- Create: `migrations/0001_initial.sql`, `packages/core/src/state/sqlite-store.ts`, `packages/core/src/state/clock.ts`
- Test: `packages/core/test/state/sqlite-store.test.ts`, `packages/core/test/helpers.ts`

**Interfaces:**
- Consumes: `StateStore`, `EventInput`, entity schema, `newId`, `HarnessError` từ Task 1–3.
- Produces: `class SqliteStateStore implements StateStore` với `constructor(dbPath: string, clock?: Clock)`; `SystemClock`; `FixedClock(iso)` với `advance(seconds)`; helper test `openTempStore(): { store, dir }`; hằng `MIGRATIONS_DIR` (đường dẫn tuyệt đối tới `migrations/` ở root repo). Task này chưa có `transition/claim/heartbeat/reap`: các hàm đó `throw new Error("not implemented")` và được thay ở Task 5, 6.

- [ ] **Step 1: Tạo package core**

`packages/core/package.json`:

```json
{
  "name": "@harness/core",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.json", "typecheck": "tsc -p tsconfig.json --noEmit" },
  "dependencies": { "@harness/contracts": "workspace:*", "pino": "^9.5.0", "yaml": "^2.6.0", "zod": "^3.23.0" }
}
```

`packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"],
  "references": [{ "path": "../contracts" }]
}
```

`packages/core/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 20000 } });
```

Thêm vào `packages/contracts/tsconfig.json` trường `"composite": true` trong `compilerOptions`. Chạy `pnpm install`.

- [ ] **Step 2: Viết migration**

`migrations/0001_initial.sql`:

```sql
CREATE TABLE run (
  id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX run_state_idx ON run(state);

CREATE TABLE stage_run (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX stage_run_run_idx ON stage_run(run_id);
CREATE INDEX stage_run_state_idx ON stage_run(state);

CREATE TABLE attempt (
  id TEXT PRIMARY KEY, stage_run_id TEXT NOT NULL, state TEXT NOT NULL, fencing_token INTEGER NOT NULL,
  data TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX attempt_stage_idx ON attempt(stage_run_id);

CREATE TABLE artifact (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, stage_run_id TEXT NOT NULL, state TEXT NOT NULL,
  data TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX artifact_stage_idx ON artifact(stage_run_id);
CREATE INDEX artifact_run_idx ON artifact(run_id);

CREATE TABLE external_operation (
  id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
  data TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE check_result (
  id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX check_result_attempt_idx ON check_result(attempt_id);

CREATE TABLE event (
  id TEXT PRIMARY KEY, run_id TEXT, occurred_at TEXT NOT NULL, event_type TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX event_run_idx ON event(run_id, occurred_at);

CREATE TABLE lease (
  stage_run_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, owner TEXT NOT NULL,
  expires_at TEXT NOT NULL, fencing_token INTEGER NOT NULL
);
```

Bảng `schema_migrations` do runner tạo, tổng cộng 9 bảng.

- [ ] **Step 3: Viết test thất bại**

`packages/core/test/helpers.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixedClock, MIGRATIONS_DIR, SqliteStateStore } from "../src/index.js";

export function openTempStore(startIso = "2026-09-11T00:00:00.000Z") {
  const dir = mkdtempSync(join(tmpdir(), "harness-"));
  const clock = new FixedClock(startIso);
  const store = new SqliteStateStore(join(dir, "state.db"), clock);
  store.migrate(MIGRATIONS_DIR);
  return { store, dir, clock };
}
```

`packages/core/test/state/sqlite-store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newId, type Run, type Artifact } from "@harness/contracts";
import { openTempStore } from "../helpers.js";
import { MIGRATIONS_DIR, SqliteStateStore } from "../../src/index.js";
import { join } from "node:path";

const now = "2026-09-11T00:00:00.000Z";
const sha = "sha256:" + "a".repeat(64);
function makeRun(): Run {
  return {
    schema_version: "harness.run/v1", run_id: newId("run"), project_id: "p", portfolio_id: "pf",
    workflow_release: { id: "w", version: "1.0.0", digest: sha }, profile_snapshot: { id: "cartoon", revision: 1 },
    state: "DRAFT", effective_config_snapshot: {}, effective_config_digest: sha, total_cost_usd: 0, created_at: now, updated_at: now,
  };
}

describe("SqliteStateStore", () => {
  it("migrates once and creates 9 tables", () => {
    const { store, dir } = openTempStore();
    expect(store.tableNames().sort()).toEqual(["artifact", "attempt", "check_result", "event", "external_operation", "lease", "run", "schema_migrations", "stage_run"]);
    expect(store.migrate(MIGRATIONS_DIR)).toEqual([]);
    const again = new SqliteStateStore(join(dir, "state.db"));
    expect(again.migrate(MIGRATIONS_DIR)).toEqual([]);
  });

  it("round-trips a run and validates on read", () => {
    const { store } = openTempStore();
    const run = makeRun();
    store.insertRun(run);
    expect(store.getRun(run.run_id)).toEqual(run);
    store.updateRun({ ...run, total_cost_usd: 1.5 });
    expect(store.getRun(run.run_id)?.total_cost_usd).toBe(1.5);
    expect(store.listRuns({ state: "DRAFT" })).toHaveLength(1);
    expect(store.getRun("run_missing")).toBeUndefined();
  });

  it("filters artifacts by status", () => {
    const { store } = openTempStore();
    const base: Artifact = {
      schema_version: "harness.artifact/v1", artifact_id: newId("artifact"), run_id: newId("run"), stage_run_id: newId("stage_run"),
      attempt_id: newId("attempt"), type: "t", status: "PROVISIONAL", uri: "file:///a", checksum: sha, size_bytes: 1, mime_type: "text/plain",
      lineage: { input_artifacts: [], source_items: [] },
      reproducibility: { workflow_release: "w@1.0.0", production_profile: "cartoon@1", channel_config_revision: null, executor_version: "x", model_parameters_digest: null },
      checks: [], created_at: now, updated_at: now,
    };
    store.insertArtifact(base);
    store.insertArtifact({ ...base, artifact_id: newId("artifact"), status: "ACCEPTED" });
    expect(store.listArtifacts({ stage_run_id: base.stage_run_id, status: "ACCEPTED" })).toHaveLength(1);
    expect(store.listArtifacts({ stage_run_id: base.stage_run_id })).toHaveLength(2);
  });

  it("appends events with generated id and clock time", () => {
    const { store, clock } = openTempStore();
    const runId = newId("run");
    const e = store.appendEvent({ run_id: runId, stage_run_id: null, attempt_id: null, project_id: "p", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info", event_type: "run.created", payload: { a: 1 } });
    expect(e.event_id).toMatch(/^evt_/);
    expect(e.occurred_at).toBe(clock.now());
    clock.advance(1);
    store.appendEvent({ ...e, event_type: "run.enqueued" });
    expect(store.listEvents({ run_id: runId }).map((x) => x.event_type)).toEqual(["run.created", "run.enqueued"]);
  });

  it("rolls back a transaction when the callback throws", () => {
    const { store } = openTempStore();
    const run = makeRun();
    expect(() => store.transaction(() => { store.insertRun(run); throw new Error("boom"); })).toThrow("boom");
    expect(store.getRun(run.run_id)).toBeUndefined();
    store.transaction(() => { store.insertRun(run); store.transaction(() => store.updateRun({ ...run, total_cost_usd: 2 })); });
    expect(store.getRun(run.run_id)?.total_cost_usd).toBe(2);
  });
});
```

- [ ] **Step 4: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/core`
Expected: FAIL, thiếu `../src/index.js`.

- [ ] **Step 5: Viết `clock.ts` và `sqlite-store.ts`**

`packages/core/src/state/clock.ts`:

```ts
import type { Clock } from "@harness/contracts";

export class SystemClock implements Clock {
  now(): string { return new Date().toISOString(); }
}

export class FixedClock implements Clock {
  private t: number;
  constructor(iso: string) { this.t = Date.parse(iso); }
  now(): string { return new Date(this.t).toISOString(); }
  advance(seconds: number): void { this.t += seconds * 1000; }
  set(iso: string): void { this.t = Date.parse(iso); }
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}
```

`packages/core/src/state/sqlite-store.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ArtifactSchema, AttemptSchema, CheckResultSchema, EventSchema, ExternalOperationSchema, HarnessError, RunSchema, StageRunSchema,
  newId, type Artifact, type Attempt, type CheckResult, type ClaimParams, type ClaimResult, type Clock, type Event, type EventInput,
  type ExternalOperation, type Lease, type ReapedLease, type Run, type StageRun, type StateStore, type TransitionKind,
} from "@harness/contracts";
import { SystemClock } from "./clock.js";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "migrations");

type Row = { data: string };

export class SqliteStateStore implements StateStore {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  private depth = 0;

  constructor(dbPath: string, clock: Clock = new SystemClock()) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.clock = clock;
  }

  migrate(migrationsDir: string): string[] {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const done = new Set(this.db.prepare("SELECT name FROM schema_migrations").all().map((r) => (r as { name: string }).name));
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      this.transaction(() => {
        this.db.exec(readFileSync(join(migrationsDir, f), "utf8"));
        this.db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(f, this.clock.now());
      });
      applied.push(f);
    }
    return applied;
  }

  tableNames(): string[] {
    return this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => (r as { name: string }).name);
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      // nested: SAVEPOINT so an inner throw caught by the outer still rolls back the inner writes (review Task 4)
      const sp = `sp_${this.depth}`;
      this.db.exec(`SAVEPOINT ${sp}`);
      this.depth++;
      try { const out = fn(); this.db.exec(`RELEASE SAVEPOINT ${sp}`); return out; }
      catch (e) { this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}`); this.db.exec(`RELEASE SAVEPOINT ${sp}`); throw e; }
      finally { this.depth--; }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try { const out = fn(); this.db.exec("COMMIT"); return out; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
    finally { this.depth = 0; }
  }

  close(): void { this.db.close(); }

  // ---- generic helpers ----
  private getDoc<T>(table: string, id: string, parse: (x: unknown) => T): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
    return row ? parse(JSON.parse(row.data)) : undefined;
  }
  private listDocs<T>(sql: string, params: (string | number)[], parse: (x: unknown) => T): T[] {
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => parse(JSON.parse(r.data)));
  }

  // ---- run ----
  insertRun(run: Run): void {
    const r = RunSchema.parse(run);
    this.db.prepare("INSERT INTO run (id, state, data, updated_at) VALUES (?, ?, ?, ?)").run(r.run_id, r.state, JSON.stringify(r), r.updated_at);
  }
  getRun(id: string): Run | undefined { return this.getDoc("run", id, (x) => RunSchema.parse(x)); }
  updateRun(run: Run): void {
    const r = RunSchema.parse(run);
    const res = this.db.prepare("UPDATE run SET data = ?, updated_at = ? WHERE id = ? AND state = ?").run(JSON.stringify(r), r.updated_at, r.run_id, r.state);
    if (res.changes === 0) throw new HarnessError("STALE_STATE", `run ${r.run_id} not in state ${r.state}`);
  }
  listRuns(filter: { state?: string } = {}): Run[] {
    return filter.state
      ? this.listDocs("SELECT data FROM run WHERE state = ? ORDER BY id", [filter.state], (x) => RunSchema.parse(x))
      : this.listDocs("SELECT data FROM run ORDER BY id", [], (x) => RunSchema.parse(x));
  }

  // ---- stage_run ----
  insertStageRun(s: StageRun): void {
    const v = StageRunSchema.parse(s);
    this.db.prepare("INSERT INTO stage_run (id, run_id, state, data, updated_at) VALUES (?, ?, ?, ?, ?)").run(v.stage_run_id, v.run_id, v.state, JSON.stringify(v), v.updated_at);
  }
  getStageRun(id: string): StageRun | undefined { return this.getDoc("stage_run", id, (x) => StageRunSchema.parse(x)); }
  updateStageRun(s: StageRun): void {
    const v = StageRunSchema.parse(s);
    const res = this.db.prepare("UPDATE stage_run SET data = ?, updated_at = ? WHERE id = ? AND state = ?").run(JSON.stringify(v), v.updated_at, v.stage_run_id, v.state);
    if (res.changes === 0) throw new HarnessError("STALE_STATE", `stage_run ${v.stage_run_id} not in state ${v.state}`);
  }
  listStageRuns(runId: string): StageRun[] {
    // ORDER BY rowid = insertion order = workflow definition order; ULIDs are not ordered within one millisecond (review Task 9)
    return this.listDocs("SELECT data FROM stage_run WHERE run_id = ? ORDER BY rowid", [runId], (x) => StageRunSchema.parse(x));
  }

  // ---- attempt ----
  insertAttempt(a: Attempt): void {
    const v = AttemptSchema.parse(a);
    this.db.prepare("INSERT INTO attempt (id, stage_run_id, state, fencing_token, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(v.attempt_id, v.stage_run_id, v.state, v.fencing_token, JSON.stringify(v), v.updated_at);
  }
  getAttempt(id: string): Attempt | undefined { return this.getDoc("attempt", id, (x) => AttemptSchema.parse(x)); }
  updateAttempt(a: Attempt): void {
    const v = AttemptSchema.parse(a);
    const res = this.db.prepare("UPDATE attempt SET data = ?, updated_at = ? WHERE id = ? AND state = ?").run(JSON.stringify(v), v.updated_at, v.attempt_id, v.state);
    if (res.changes === 0) throw new HarnessError("STALE_STATE", `attempt ${v.attempt_id} not in state ${v.state}`);
  }
  listAttempts(stageRunId: string): Attempt[] {
    return this.listDocs("SELECT data FROM attempt WHERE stage_run_id = ? ORDER BY fencing_token", [stageRunId], (x) => AttemptSchema.parse(x));
  }

  // ---- artifact ----
  insertArtifact(a: Artifact): void {
    const v = ArtifactSchema.parse(a);
    this.db.prepare("INSERT INTO artifact (id, run_id, stage_run_id, state, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(v.artifact_id, v.run_id, v.stage_run_id, v.status, JSON.stringify(v), v.updated_at);
  }
  getArtifact(id: string): Artifact | undefined { return this.getDoc("artifact", id, (x) => ArtifactSchema.parse(x)); }
  listArtifacts(filter: { stage_run_id?: string; run_id?: string; status?: string }): Artifact[] {
    const where: string[] = []; const params: string[] = [];
    if (filter.stage_run_id) { where.push("stage_run_id = ?"); params.push(filter.stage_run_id); }
    if (filter.run_id) { where.push("run_id = ?"); params.push(filter.run_id); }
    if (filter.status) { where.push("state = ?"); params.push(filter.status); }
    const sql = `SELECT data FROM artifact${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id`;
    return this.listDocs(sql, params, (x) => ArtifactSchema.parse(x));
  }

  // ---- external_operation ----
  insertExternalOperation(op: ExternalOperation): void {
    const v = ExternalOperationSchema.parse(op);
    this.db.prepare("INSERT INTO external_operation (id, idempotency_key, state, data, updated_at) VALUES (?, ?, ?, ?, ?)").run(v.operation_id, v.idempotency_key, v.status, JSON.stringify(v), v.updated_at);
  }
  getExternalOperation(id: string): ExternalOperation | undefined { return this.getDoc("external_operation", id, (x) => ExternalOperationSchema.parse(x)); }
  findExternalOperationByKey(key: string): ExternalOperation | undefined {
    const row = this.db.prepare("SELECT data FROM external_operation WHERE idempotency_key = ?").get(key) as Row | undefined;
    return row ? ExternalOperationSchema.parse(JSON.parse(row.data)) : undefined;
  }
  updateExternalOperation(op: ExternalOperation): void {
    const v = ExternalOperationSchema.parse(op);
    const res = this.db.prepare("UPDATE external_operation SET data = ?, updated_at = ? WHERE id = ? AND state = ?").run(JSON.stringify(v), v.updated_at, v.operation_id, v.status);
    if (res.changes === 0) throw new HarnessError("STALE_STATE", `external_operation ${v.operation_id} not in status ${v.status}`);
  }

  // ---- check_result ----
  insertCheckResult(c: CheckResult): void {
    const v = CheckResultSchema.parse(c);
    this.db.prepare("INSERT INTO check_result (id, attempt_id, data) VALUES (?, ?, ?)").run(v.check_result_id, v.attempt_id, JSON.stringify(v));
  }
  listCheckResults(attemptId: string): CheckResult[] {
    return this.listDocs("SELECT data FROM check_result WHERE attempt_id = ? ORDER BY id", [attemptId], (x) => CheckResultSchema.parse(x));
  }

  // ---- event ----
  appendEvent(input: EventInput): Event {
    const e = EventSchema.parse({ ...input, schema_version: "harness.event/v1", event_id: newId("event"), occurred_at: this.clock.now() });
    this.db.prepare("INSERT INTO event (id, run_id, occurred_at, event_type, data) VALUES (?, ?, ?, ?, ?)").run(e.event_id, e.run_id, e.occurred_at, e.event_type, JSON.stringify(e));
    return e;
  }
  listEvents(filter: { run_id?: string; limit?: number }): Event[] {
    const limit = filter.limit ?? 1000;
    return filter.run_id
      ? this.listDocs("SELECT data FROM event WHERE run_id = ? ORDER BY occurred_at, id LIMIT ?", [filter.run_id, limit], (x) => EventSchema.parse(x))
      : this.listDocs("SELECT data FROM event ORDER BY occurred_at, id LIMIT ?", [limit], (x) => EventSchema.parse(x));
  }

  // ---- implemented in Task 5 and 6 ----
  transition(_kind: TransitionKind, _id: string, _from: string, _to: string, _event: EventInput): void { throw new Error("not implemented"); }
  claim(_params: ClaimParams): ClaimResult | undefined { throw new Error("not implemented"); }
  heartbeat(_attemptId: string, _token: number, _newExpiresAt: string): boolean { throw new Error("not implemented"); }
  getLease(_stageRunId: string): Lease | undefined { throw new Error("not implemented"); }
  releaseLease(_stageRunId: string, _token: number): void { throw new Error("not implemented"); }
  reapExpiredLeases(_now: string): ReapedLease[] { throw new Error("not implemented"); }
}
```

`packages/core/src/index.ts`:

```ts
export * from "./state/clock.js";
export * from "./state/sqlite-store.js";
```

- [ ] **Step 6: Chạy test, xác nhận pass**

Run: `pnpm vitest run packages/core`
Expected: PASS, 5 tests. Có thể thấy `ExperimentalWarning: SQLite is an experimental feature` trên stderr, chấp nhận được.

- [ ] **Step 7: Commit**

```bash
git add packages/core migrations packages/contracts/tsconfig.json
git commit -m "feat(core): add SQLite state store with migrations, CRUD, events and transactions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Bảng transition và `transition()` nguyên tử

**Files:**
- Create: `packages/core/src/state/transitions.ts`
- Modify: `packages/core/src/state/sqlite-store.ts` (thay `transition`), `packages/core/src/index.ts`
- Test: `packages/core/test/state/transitions.test.ts`

**Interfaces:**
- Consumes: `SqliteStateStore`, `HarnessError`.
- Produces: `TRANSITIONS: Record<TransitionKind, Record<string, readonly string[]>>`, `assertTransition(kind, from, to): void`, `isTerminal(kind, state): boolean`, và `store.transition(kind, id, expectedFrom, to, event)` hoạt động.

- [ ] **Step 1: Viết test thất bại**

`packages/core/test/state/transitions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isHarnessError, newId, type Run } from "@harness/contracts";
import { assertTransition, isTerminal, TRANSITIONS } from "../../src/state/transitions.js";
import { openTempStore } from "../helpers.js";

const now = "2026-09-11T00:00:00.000Z";
const sha = "sha256:" + "a".repeat(64);
const run = (): Run => ({
  schema_version: "harness.run/v1", run_id: newId("run"), project_id: "p", portfolio_id: "pf",
  workflow_release: { id: "w", version: "1.0.0", digest: sha }, profile_snapshot: { id: "cartoon", revision: 1 },
  state: "DRAFT", effective_config_snapshot: {}, effective_config_digest: sha, total_cost_usd: 0, created_at: now, updated_at: now,
});
const evt = (run_id: string, event_type: string) => ({
  run_id, stage_run_id: null, attempt_id: null, project_id: "p", portfolio_id: null, channel_id: null, content_id: null,
  variant_id: null, workflow_release: null, severity: "info" as const, event_type, payload: {},
});

describe("transition tables", () => {
  it("allow every blueprint path", () => {
    const ok: [keyof typeof TRANSITIONS, string, string][] = [
      ["run", "DRAFT", "READY"], ["run", "READY", "RUNNING"], ["run", "RUNNING", "SUCCEEDED"], ["run", "RUNNING", "WAITING"],
      ["stage_run", "PENDING", "READY"], ["stage_run", "READY", "CLAIMED"], ["stage_run", "CLAIMED", "RUNNING"], ["stage_run", "RUNNING", "VERIFYING"],
      ["stage_run", "VERIFYING", "SUCCEEDED"], ["stage_run", "VERIFYING", "FAILED"], ["stage_run", "FAILED", "READY"], ["stage_run", "RUNNING", "WAITING_EXTERNAL"],
      ["stage_run", "WAITING_EXTERNAL", "NEEDS_RECONCILIATION"], ["stage_run", "NEEDS_RECONCILIATION", "READY"], ["stage_run", "RUNNING", "READY"],
      ["attempt", "CLAIMED", "RUNNING"], ["attempt", "RUNNING", "ABANDONED"], ["artifact", "PROVISIONAL", "ACCEPTED"],
      ["external_operation", "INTENT_RECORDED", "DISPATCHED"], ["external_operation", "DISPATCHED", "NEEDS_RECONCILIATION"], ["external_operation", "NEEDS_RECONCILIATION", "CONFIRMED"],
    ];
    for (const [k, f, t] of ok) expect(() => assertTransition(k, f, t), `${k} ${f}->${t}`).not.toThrow();
  });
  it("forbid illegal paths", () => {
    const bad: [keyof typeof TRANSITIONS, string, string][] = [
      ["run", "DRAFT", "RUNNING"], ["run", "SUCCEEDED", "RUNNING"], ["stage_run", "PENDING", "CLAIMED"], ["stage_run", "READY", "SUCCEEDED"],
      ["stage_run", "SUCCEEDED", "READY"], ["attempt", "SUCCEEDED", "RUNNING"], ["artifact", "ACCEPTED", "PROVISIONAL"], ["artifact", "REJECTED", "ACCEPTED"],
      ["external_operation", "CONFIRMED", "DISPATCHED"],
    ];
    for (const [k, f, t] of bad) {
      expect(() => assertTransition(k, f, t), `${k} ${f}->${t}`).toThrow();
      try { assertTransition(k, f, t); } catch (e) { expect(isHarnessError(e, "INVALID_TRANSITION")).toBe(true); }
    }
  });
  it("knows terminal states", () => {
    expect(isTerminal("stage_run", "SUCCEEDED")).toBe(true);
    expect(isTerminal("stage_run", "READY")).toBe(false);
    expect(isTerminal("run", "CANCELLED")).toBe(true);
  });
});

describe("store.transition", () => {
  it("updates state, data and appends an event atomically", () => {
    const { store } = openTempStore();
    const r = run(); store.insertRun(r);
    store.transition("run", r.run_id, "DRAFT", "READY", evt(r.run_id, "run.enqueued"));
    expect(store.getRun(r.run_id)?.state).toBe("READY");
    expect(store.listEvents({ run_id: r.run_id }).map((e) => e.event_type)).toEqual(["run.enqueued"]);
  });
  it("throws STALE_STATE when the row is not in the expected state and writes nothing", () => {
    const { store } = openTempStore();
    const r = run(); store.insertRun(r);
    expect(() => store.transition("run", r.run_id, "READY", "RUNNING", evt(r.run_id, "run.started"))).toThrow(/not in state READY/);
    expect(store.listEvents({ run_id: r.run_id })).toHaveLength(0);
  });
  it("throws INVALID_TRANSITION before touching the database", () => {
    const { store } = openTempStore();
    const r = run(); store.insertRun(r);
    expect(() => store.transition("run", r.run_id, "DRAFT", "SUCCEEDED", evt(r.run_id, "run.finished"))).toThrow(/DRAFT -> SUCCEEDED/);
    expect(store.getRun(r.run_id)?.state).toBe("DRAFT");
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/core/test/state/transitions.test.ts`
Expected: FAIL, thiếu `transitions.js`.

- [ ] **Step 3: Viết `transitions.ts`**

`packages/core/src/state/transitions.ts`:

```ts
import { HarnessError, type TransitionKind } from "@harness/contracts";

export const TRANSITIONS: Record<TransitionKind, Record<string, readonly string[]>> = {
  run: {
    DRAFT: ["READY", "CANCELLED"],
    READY: ["RUNNING", "CANCEL_REQUESTED"],
    RUNNING: ["WAITING", "SUCCEEDED", "FAILED", "CANCEL_REQUESTED"],
    WAITING: ["RUNNING", "CANCEL_REQUESTED"],
    CANCEL_REQUESTED: ["CANCELLED"],
    CANCELLED: [], SUCCEEDED: [], FAILED: [],
  },
  stage_run: {
    PENDING: ["READY", "CANCEL_REQUESTED", "CANCELLED"],
    READY: ["CLAIMED", "CANCEL_REQUESTED", "CANCELLED"],
    CLAIMED: ["RUNNING", "READY", "CANCEL_REQUESTED"],            // CLAIMED -> READY: lease abandoned
    RUNNING: ["VERIFYING", "WAITING_EXTERNAL", "WAITING_HUMAN", "FAILED", "READY", "CANCEL_REQUESTED"], // RUNNING -> READY: lease abandoned
    VERIFYING: ["SUCCEEDED", "FAILED", "WAITING_HUMAN"],          // WAITING_HUMAN: contract failure (spec B.9)
    WAITING_EXTERNAL: ["RUNNING", "NEEDS_RECONCILIATION"],
    NEEDS_RECONCILIATION: ["RUNNING", "READY"],                   // READY: reconciled, retry with new attempt (spec addition v1)
    WAITING_HUMAN: ["READY", "CANCEL_REQUESTED"],
    FAILED: ["READY"],                                            // retry policy
    CANCEL_REQUESTED: ["CANCELLED"],
    CANCELLED: [], SUCCEEDED: [],
  },
  attempt: {
    CLAIMED: ["RUNNING", "ABANDONED", "CANCELLED", "FAILED"],
    RUNNING: ["SUCCEEDED", "FAILED", "ABANDONED", "CANCELLED"],
    SUCCEEDED: [], FAILED: [], ABANDONED: [], CANCELLED: [],
  },
  artifact: {
    PROVISIONAL: ["ACCEPTED", "REJECTED"],
    ACCEPTED: ["STALE", "ARCHIVED"],
    STALE: ["ARCHIVED"],
    REJECTED: [], ARCHIVED: [],
  },
  external_operation: {
    INTENT_RECORDED: ["DISPATCHED", "FAILED"],
    DISPATCHED: ["CONFIRMED", "FAILED", "NEEDS_RECONCILIATION"],
    NEEDS_RECONCILIATION: ["CONFIRMED", "FAILED", "DISPATCHED"],
    CONFIRMED: [], FAILED: [],
  },
};

export function assertTransition(kind: TransitionKind, from: string, to: string): void {
  const allowed = TRANSITIONS[kind][from];
  if (!allowed || !allowed.includes(to)) {
    throw new HarnessError("INVALID_TRANSITION", `${kind}: ${from} -> ${to} is not allowed`, { kind, from, to });
  }
}

export function isTerminal(kind: TransitionKind, state: string): boolean {
  return (TRANSITIONS[kind][state] ?? []).length === 0;
}

export const TABLE_BY_KIND: Record<TransitionKind, string> = {
  run: "run", stage_run: "stage_run", attempt: "attempt", artifact: "artifact", external_operation: "external_operation",
};
export const STATE_FIELD_BY_KIND: Record<TransitionKind, "state" | "status"> = {
  run: "state", stage_run: "state", attempt: "state", artifact: "status", external_operation: "status",
};
```

- [ ] **Step 4: Thay `transition()` trong `sqlite-store.ts`**

Import thêm ở đầu file: `import { assertTransition, STATE_FIELD_BY_KIND, TABLE_BY_KIND } from "./transitions.js";`. Thay method `transition`:

```ts
  transition(kind: TransitionKind, id: string, expectedFrom: string, to: string, event: EventInput): void {
    assertTransition(kind, expectedFrom, to);
    this.transaction(() => {
      const table = TABLE_BY_KIND[kind];
      const field = STATE_FIELD_BY_KIND[kind];
      const now = this.clock.now();
      const res = this.db
        .prepare(`UPDATE ${table} SET state = ?, data = json_set(data, '$.${field}', ?, '$.updated_at', ?), updated_at = ? WHERE id = ? AND state = ?`)
        .run(to, to, now, now, id, expectedFrom);
      if (res.changes === 0) throw new HarnessError("STALE_STATE", `${kind} ${id} not in state ${expectedFrom}`, { kind, id, expectedFrom, to });
      this.appendEvent({ ...event, payload: { ...event.payload, from: expectedFrom, to } });
    });
  }
```

Thêm vào `packages/core/src/index.ts`: `export * from "./state/transitions.js";`

- [ ] **Step 5: Chạy test, xác nhận pass**

Run: `pnpm vitest run packages/core`
Expected: PASS, tất cả test core (5 cũ + 6 mới).

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): add transition tables and atomic transition() with event logging

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 6: Claim nguyên tử, lease, fencing token, heartbeat, reap

**Files:**
- Modify: `packages/contracts/src/interfaces.ts` (thêm `assertFencing`), `packages/core/src/state/transitions.ts` (thêm 2 cạnh abandoned), `packages/core/src/state/sqlite-store.ts` (thay 6 method), `packages/core/test/helpers.ts`
- Test: `packages/core/test/state/claim.test.ts`

**Interfaces:**
- Consumes: `SqliteStateStore`, `transition`, `FixedClock`, `addSeconds`.
- Produces: `store.claim(params)`, `store.heartbeat()`, `store.getLease()`, `store.releaseLease()`, `store.reapExpiredLeases(now)`, `store.assertFencing(stageRunId, token)`; helper test `seedStage(store, opts)`.

- [ ] **Step 1: Cập nhật interface và bảng transition**

Thêm vào `interface StateStore` trong `packages/contracts/src/interfaces.ts`, ngay sau `reapExpiredLeases`:

```ts
  assertFencing(stageRunId: string, fencingToken: number): void;
```

Trong `packages/core/src/state/transitions.ts`, sửa hai dòng của `stage_run`:

```ts
    CLAIMED: ["RUNNING", "READY", "FAILED", "CANCEL_REQUESTED"],            // READY/FAILED: lease abandoned
    VERIFYING: ["SUCCEEDED", "FAILED", "WAITING_HUMAN", "READY"],           // READY: lease abandoned during verify
```

- [ ] **Step 2: Thêm helper seed và viết test thất bại**

Thêm vào `packages/core/test/helpers.ts`:

```ts
import { newId, type Run, type StageRun, type RetryPolicy } from "@harness/contracts";

const SHA = "sha256:" + "a".repeat(64);
export function seedStage(store: SqliteStateStore, opts: { key?: string; caps?: string[]; retry?: Partial<RetryPolicy>; runId?: string; depends_on?: string[]; state?: StageRun["state"] } = {}) {
  const now = store.clock.now();
  const runId = opts.runId ?? newId("run");
  if (!opts.runId) {
    const run: Run = {
      schema_version: "harness.run/v1", run_id: runId, project_id: "project-main", portfolio_id: "portfolio-main",
      workflow_release: { id: "sample-three-stage", version: "1.0.0", digest: SHA }, profile_snapshot: { id: "cartoon", revision: 1 },
      state: "READY", effective_config_snapshot: {}, effective_config_digest: SHA, total_cost_usd: 0, created_at: now, updated_at: now,
    };
    store.insertRun(run);
  }
  const stage: StageRun = {
    schema_version: "harness.stage-run/v1", stage_run_id: newId("stage_run"), run_id: runId, stage_key: opts.key ?? "produce",
    executor: { type: "script", script: "fake-stage" }, depends_on: opts.depends_on ?? [], required_capabilities: opts.caps ?? [],
    required_checks: ["schema-valid"], retry: { max_attempts: 3, backoff_seconds: [0, 0, 0], retry_on: ["transient", "abandoned"], ...opts.retry },
    stage_config: {}, state: opts.state ?? "READY", attempt_count: 0, result_failures: 0, ready_at: now, created_at: now, updated_at: now,
  };
  store.insertStageRun(stage);
  return { runId, stage };
}
```

`packages/core/test/state/claim.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { isHarnessError } from "@harness/contracts";
import { addSeconds, FixedClock, MIGRATIONS_DIR, SqliteStateStore } from "../../src/index.js";
import { openTempStore, seedStage } from "../helpers.js";

const claimWith = (store: SqliteStateStore, owner: string, caps: string[] = ["write_workspace"]) =>
  store.claim({ owner, capabilities: caps, now: store.clock.now(), leaseSeconds: 90 });

describe("claim", () => {
  it("lets exactly one connection win each READY stage", () => {
    const { store, dir, clock } = openTempStore();
    seedStage(store, { key: "a" }); seedStage(store, { key: "b" });
    const w1 = new SqliteStateStore(join(dir, "state.db"), clock);
    const w2 = new SqliteStateStore(join(dir, "state.db"), clock);
    const w3 = new SqliteStateStore(join(dir, "state.db"), clock);
    const claims = [claimWith(w1, "w1"), claimWith(w2, "w2"), claimWith(w3, "w3")];
    const won = claims.filter(Boolean);
    expect(won).toHaveLength(2);
    expect(new Set(won.map((c) => c!.stageRun.stage_run_id)).size).toBe(2);
    expect(won.map((c) => c!.lease.fencing_token)).toEqual([1, 1]);
    expect(won[0]!.stageRun.state).toBe("CLAIMED");
    expect(won[0]!.attempt.state).toBe("CLAIMED");
    expect(store.getRun(won[0]!.stageRun.run_id)?.state).toBe("RUNNING");
  });

  it("skips stages whose capabilities the worker lacks or whose not_before is in the future", () => {
    const { store } = openTempStore();
    seedStage(store, { key: "tts", caps: ["call_tts"] });
    expect(claimWith(store, "w", ["write_workspace"])).toBeUndefined();
    expect(claimWith(store, "w", ["write_workspace", "call_tts"])).toBeDefined();
    const { stage } = seedStage(store, { key: "later" });
    store.updateStageRun({ ...stage, not_before: addSeconds(store.clock.now(), 60) });
    expect(claimWith(store, "w")).toBeUndefined();
    (store.clock as FixedClock).advance(61);
    expect(claimWith(store, "w")).toBeDefined();
  });

  it("heartbeats only with the current fencing token", () => {
    const { store } = openTempStore();
    seedStage(store);
    const c = claimWith(store, "w")!;
    const later = addSeconds(store.clock.now(), 90);
    expect(store.heartbeat(c.attempt.attempt_id, 1, later)).toBe(true);
    expect(store.getLease(c.stageRun.stage_run_id)?.expires_at).toBe(later);
    expect(store.heartbeat(c.attempt.attempt_id, 99, later)).toBe(false);
  });

  it("reaps expired leases, requeues the stage and rejects the old token", () => {
    const { store, clock } = openTempStore();
    seedStage(store);
    const first = claimWith(store, "w1")!;
    clock.advance(91);
    const reaped = store.reapExpiredLeases(clock.now());
    expect(reaped).toEqual([{ stage_run_id: first.stageRun.stage_run_id, attempt_id: first.attempt.attempt_id, owner: "w1", requeued: true }]);
    expect(store.getAttempt(first.attempt.attempt_id)?.state).toBe("ABANDONED");
    const stage = store.getStageRun(first.stageRun.stage_run_id)!;
    expect(stage.state).toBe("READY");
    expect(stage.attempt_count).toBe(1);
    expect(stage.last_failure_kind).toBe("abandoned");
    expect(store.getLease(stage.stage_run_id)).toBeUndefined();
    const second = claimWith(store, "w2")!;
    expect(second.lease.fencing_token).toBe(2);
    expect(() => store.assertFencing(stage.stage_run_id, 1)).toThrow();
    try { store.assertFencing(stage.stage_run_id, 1); } catch (e) { expect(isHarnessError(e, "FENCING_REJECTED")).toBe(true); }
    expect(() => store.assertFencing(stage.stage_run_id, 2)).not.toThrow();
  });

  it("fails the stage when abandoned attempts exhaust max_attempts", () => {
    const { store, clock } = openTempStore();
    seedStage(store, { retry: { max_attempts: 1 } });
    claimWith(store, "w1");
    clock.advance(91);
    const [r] = store.reapExpiredLeases(clock.now());
    expect(r?.requeued).toBe(false);
    expect(store.getStageRun(r!.stage_run_id)?.state).toBe("FAILED");
  });

  it("releaseLease removes the lease only for the matching token", () => {
    const { store } = openTempStore();
    seedStage(store);
    const c = claimWith(store, "w")!;
    store.releaseLease(c.stageRun.stage_run_id, 5);
    expect(store.getLease(c.stageRun.stage_run_id)).toBeDefined();
    store.releaseLease(c.stageRun.stage_run_id, 1);
    expect(store.getLease(c.stageRun.stage_run_id)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/core/test/state/claim.test.ts`
Expected: FAIL với `not implemented`.

- [ ] **Step 4: Thay 6 method trong `sqlite-store.ts`**

Import thêm `LeaseSchema` từ `@harness/contracts` và `addSeconds` từ `./clock.js`. Thay khối "implemented in Task 5 and 6" (giữ `transition` của Task 5) bằng:

```ts
  private eventBase(stage: StageRun, attemptId: string | null): Omit<EventInput, "event_type" | "severity" | "payload"> {
    return { run_id: stage.run_id, stage_run_id: stage.stage_run_id, attempt_id: attemptId, project_id: null, portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null };
  }

  claim(params: ClaimParams): ClaimResult | undefined {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT data FROM stage_run WHERE state = 'READY' ORDER BY json_extract(data, '$.ready_at'), id LIMIT 100").all() as Row[];
      for (const row of rows) {
        const stage = StageRunSchema.parse(JSON.parse(row.data));
        if (stage.not_before && stage.not_before > params.now) continue;
        if (!stage.required_capabilities.every((c) => params.capabilities.includes(c))) continue;
        const res = this.db.prepare("UPDATE stage_run SET state = 'CLAIMED' WHERE id = ? AND state = 'READY'").run(stage.stage_run_id);
        if (res.changes === 0) continue;
        const now = this.clock.now();
        const token = (this.db.prepare("SELECT COALESCE(MAX(fencing_token), 0) + 1 AS t FROM attempt WHERE stage_run_id = ?").get(stage.stage_run_id) as { t: number }).t;
        const claimed: StageRun = { ...stage, state: "CLAIMED", attempt_count: stage.attempt_count + 1, updated_at: now };
        this.db.prepare("UPDATE stage_run SET data = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(claimed), now, stage.stage_run_id);
        const attempt: Attempt = {
          schema_version: "harness.attempt/v1", attempt_id: newId("attempt"), stage_run_id: stage.stage_run_id, run_id: stage.run_id,
          lease_owner: params.owner, fencing_token: token, state: "CLAIMED", started_at: now, created_at: now, updated_at: now,
        };
        this.insertAttempt(attempt);
        const lease: Lease = { stage_run_id: stage.stage_run_id, attempt_id: attempt.attempt_id, owner: params.owner, expires_at: addSeconds(now, params.leaseSeconds), fencing_token: token };
        this.db.prepare("INSERT OR REPLACE INTO lease (stage_run_id, attempt_id, owner, expires_at, fencing_token) VALUES (?, ?, ?, ?, ?)").run(lease.stage_run_id, lease.attempt_id, lease.owner, lease.expires_at, lease.fencing_token);
        const run = this.getRun(stage.run_id);
        if (run?.state === "READY") this.transition("run", run.run_id, "READY", "RUNNING", { ...this.eventBase(stage, null), stage_run_id: null, severity: "info", event_type: "run.started", payload: {} });
        this.appendEvent({ ...this.eventBase(stage, attempt.attempt_id), severity: "info", event_type: "attempt.claimed", payload: { owner: params.owner, fencing_token: token } });
        return { stageRun: claimed, attempt, lease };
      }
      return undefined;
    });
  }

  heartbeat(attemptId: string, fencingToken: number, newExpiresAt: string): boolean {
    return this.db.prepare("UPDATE lease SET expires_at = ? WHERE attempt_id = ? AND fencing_token = ?").run(newExpiresAt, attemptId, fencingToken).changes === 1;
  }

  getLease(stageRunId: string): Lease | undefined {
    const row = this.db.prepare("SELECT stage_run_id, attempt_id, owner, expires_at, fencing_token FROM lease WHERE stage_run_id = ?").get(stageRunId);
    return row ? LeaseSchema.parse(row) : undefined;
  }

  releaseLease(stageRunId: string, fencingToken: number): void {
    this.db.prepare("DELETE FROM lease WHERE stage_run_id = ? AND fencing_token = ?").run(stageRunId, fencingToken);
  }

  assertFencing(stageRunId: string, fencingToken: number): void {
    const lease = this.getLease(stageRunId);
    if (!lease || lease.fencing_token !== fencingToken) {
      throw new HarnessError("FENCING_REJECTED", `fencing token ${fencingToken} is not current for ${stageRunId}`, { stageRunId, fencingToken, current: lease?.fencing_token ?? null });
    }
  }

  reapExpiredLeases(now: string): ReapedLease[] {
    return this.transaction(() => {
      const expired = (this.db.prepare("SELECT stage_run_id, attempt_id, owner, expires_at, fencing_token FROM lease WHERE expires_at < ?").all(now) as unknown[]).map((r) => LeaseSchema.parse(r));
      const out: ReapedLease[] = [];
      for (const lease of expired) {
        this.db.prepare("DELETE FROM lease WHERE stage_run_id = ? AND fencing_token = ?").run(lease.stage_run_id, lease.fencing_token);
        const attempt = this.getAttempt(lease.attempt_id);
        const stage = this.getStageRun(lease.stage_run_id);
        if (!attempt || !stage) continue;
        if (attempt.state === "CLAIMED" || attempt.state === "RUNNING") {
          this.transition("attempt", attempt.attempt_id, attempt.state, "ABANDONED", { ...this.eventBase(stage, attempt.attempt_id), severity: "warn", event_type: "attempt.abandoned", payload: { owner: lease.owner } });
        }
        const active = ["CLAIMED", "RUNNING", "VERIFYING"].includes(stage.state);
        const canRetry = active && stage.retry.retry_on.includes("abandoned") && stage.attempt_count < stage.retry.max_attempts;
        if (active) {
          const next = canRetry ? "READY" : "FAILED";
          this.transition("stage_run", stage.stage_run_id, stage.state, next, { ...this.eventBase(stage, attempt.attempt_id), severity: "warn", event_type: "stage.lease_expired", payload: { requeued: canRetry } });
          const fresh = this.getStageRun(stage.stage_run_id)!;
          this.updateStageRun({ ...fresh, last_failure_kind: "abandoned", ready_at: now, not_before: now });
        }
        out.push({ stage_run_id: stage.stage_run_id, attempt_id: attempt.attempt_id, owner: lease.owner, requeued: canRetry });
      }
      return out;
    });
  }
```

Lưu ý: `claim()` là nơi thứ hai (ngoài `transition()`) được phép `UPDATE state`, đúng Global Constraints.

- [ ] **Step 5: Chạy test, xác nhận pass**

Run: `pnpm vitest run packages/core && pnpm --filter @harness/core typecheck`
Expected: PASS toàn bộ; typecheck sạch.

- [ ] **Step 6: Commit**

```bash
git add packages/core packages/contracts
git commit -m "feat(core): add atomic claim, lease heartbeat, fencing assertion and lease reaper

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Digest, config precedence, secret resolver, redaction và logger

**Files:**
- Create: `packages/core/src/artifacts/checksum.ts`, `packages/core/src/config/resolve.ts`, `packages/core/src/config/secrets.ts`, `packages/core/src/observability/redaction.ts`, `packages/core/src/observability/logger.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/artifacts/checksum.test.ts`, `packages/core/test/config/resolve.test.ts`, `packages/core/test/config/secrets.test.ts`, `packages/core/test/observability/redaction.test.ts`

**Interfaces:**
- Produces: `canonicalJson(v): string`, `canonicalDigest(v): Checksum`, `sha256File(path): Promise<{checksum, size_bytes}>`, `sha256String(s): Checksum`; `resolveEffectiveConfig(input: ResolveInput): { snapshot: Record<string, unknown>; digest: Checksum }`; `EnvSecretResolver`; `Redactor` với `redact<T>(v: T): T`; `createLogger(opts): HarnessLogger` (implements `ExecutorContext["logger"]`, thêm `child(bindings)`).

- [ ] **Step 1: Viết test thất bại**

`packages/core/test/artifacts/checksum.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDigest, canonicalJson, sha256File, sha256String } from "../../src/artifacts/checksum.js";

describe("checksum", () => {
  it("canonicalises key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalDigest({ b: 1, a: 2 })).toBe(canonicalDigest({ a: 2, b: 1 }));
    expect(canonicalDigest({})).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it("hashes files and strings identically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-"));
    writeFileSync(join(dir, "f.txt"), "hello");
    const r = await sha256File(join(dir, "f.txt"));
    expect(r).toEqual({ checksum: sha256String("hello"), size_bytes: 5 });
    expect(r.checksum).toBe("sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});
```

`packages/core/test/config/resolve.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HarnessConfigSchema, isHarnessError } from "@harness/contracts";
import { resolveEffectiveConfig } from "../../src/config/resolve.js";

const harness = HarnessConfigSchema.parse({ schema_version: "harness.config/v1" });

describe("resolveEffectiveConfig", () => {
  it("applies precedence system < workflow < profile < channel < run", () => {
    const { snapshot } = resolveEffectiveConfig({
      harness, workflowDefaults: { lease_seconds: 100, default_max_cost_usd: 4 }, profileOverrides: { lease_seconds: 110 },
      channelOverrides: { lease_seconds: 120 }, runOverrides: { lease_seconds: 130 }, profileMaxCostUsd: 5,
    });
    expect(snapshot.lease_seconds).toBe(130);
    expect(snapshot.default_max_cost_usd).toBe(4);
    expect(snapshot.heartbeat_seconds).toBe(30);
  });
  it("rejects unknown keys at any layer", () => {
    try { resolveEffectiveConfig({ harness, workflowDefaults: { leese_seconds: 1 }, profileOverrides: {}, channelOverrides: {}, runOverrides: {}, profileMaxCostUsd: 5 }); throw new Error("no throw"); }
    catch (e) { expect(isHarnessError(e, "UNKNOWN_CONFIG_KEY")).toBe(true); expect((e as Error).message).toContain("leese_seconds"); }
  });
  it("rejects overrides of keys that are not overridable", () => {
    try { resolveEffectiveConfig({ harness, workflowDefaults: {}, profileOverrides: {}, channelOverrides: {}, runOverrides: { heartbeat_seconds: 1 }, profileMaxCostUsd: 5 }); throw new Error("no throw"); }
    catch (e) { expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true); }
  });
  it("clamps max cost to the profile policy and produces a stable digest", () => {
    const a = resolveEffectiveConfig({ harness, workflowDefaults: {}, profileOverrides: {}, channelOverrides: {}, runOverrides: { default_max_cost_usd: 50 }, profileMaxCostUsd: 5 });
    expect(a.snapshot.default_max_cost_usd).toBe(5);
    const b = resolveEffectiveConfig({ harness, workflowDefaults: {}, profileOverrides: {}, channelOverrides: {}, runOverrides: { default_max_cost_usd: 50 }, profileMaxCostUsd: 5 });
    expect(a.digest).toBe(b.digest);
  });
  it("keeps secret references as references", () => {
    const { snapshot } = resolveEffectiveConfig({ harness, workflowDefaults: { tts_account: "secret://tts/main" }, profileOverrides: {}, channelOverrides: {}, runOverrides: {}, profileMaxCostUsd: 5, extraKnownKeys: ["tts_account"] });
    expect(snapshot.tts_account).toBe("secret://tts/main");
  });
});
```

`packages/core/test/config/secrets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isHarnessError } from "@harness/contracts";
import { EnvSecretResolver } from "../../src/config/secrets.js";

describe("EnvSecretResolver", () => {
  it("maps secret refs to env vars and remembers resolved values", () => {
    const r = new EnvSecretResolver({ HARNESS_SECRET_TTS_MAIN: "tok-123", HARNESS_SECRET_YOUTUBE_CHANNEL_01: "yt-456" });
    expect(r.resolve("secret://tts/main")).toBe("tok-123");
    expect(r.resolve("secret://youtube/channel-01")).toBe("yt-456");
    expect(r.resolvedValues()).toEqual(["tok-123", "yt-456"]);
  });
  it("throws SECRET_UNRESOLVED for missing or malformed refs", () => {
    const r = new EnvSecretResolver({});
    for (const ref of ["secret://nope/x", "not-a-ref"]) {
      try { r.resolve(ref); throw new Error("no throw"); } catch (e) { expect(isHarnessError(e, "SECRET_UNRESOLVED")).toBe(true); }
    }
  });
});
```

`packages/core/test/observability/redaction.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Redactor } from "../../src/observability/redaction.js";
import { createLogger } from "../../src/observability/logger.js";

describe("Redactor", () => {
  it("masks secret values anywhere in nested data", () => {
    const r = new Redactor(() => ["tok-123", "yt-456"]);
    expect(r.redact({ a: "Bearer tok-123", b: ["x", "yt-456"], c: { d: "fine" }, n: 1 })).toEqual({ a: "Bearer [REDACTED]", b: ["x", "[REDACTED]"], c: { d: "fine" }, n: 1 });
    expect(r.redact("tok-123 and tok-123")).toBe("[REDACTED] and [REDACTED]");
  });
  it("ignores empty secrets", () => {
    const r = new Redactor(() => [""]);
    expect(r.redact("abc")).toBe("abc");
  });
});

describe("createLogger", () => {
  it("redacts messages and data before writing", () => {
    const lines: string[] = [];
    const log = createLogger({ redactor: new Redactor(() => ["tok-123"]), sink: (line) => lines.push(line), level: "info" });
    log.info("using tok-123", { key: "tok-123", other: 1 });
    log.child({ run_id: "run_x" }).warn("child tok-123");
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("tok-123");
    expect(JSON.parse(lines[0]!)).toMatchObject({ msg: "using [REDACTED]", key: "[REDACTED]", other: 1, level: "info" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ run_id: "run_x", msg: "child [REDACTED]" });
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/core`
Expected: FAIL, thiếu 4 module mới.

- [ ] **Step 3: Viết `checksum.ts`**

`packages/core/src/artifacts/checksum.ts`:

```ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Checksum } from "@harness/contracts";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}
export function sha256String(s: string): Checksum {
  return `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;
}
export function canonicalDigest(value: unknown): Checksum {
  return sha256String(canonicalJson(value));
}
export async function sha256File(path: string): Promise<{ checksum: Checksum; size_bytes: number }> {
  const { size } = await stat(path);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on("data", (c) => hash.update(c)).on("end", resolve).on("error", reject);
  });
  return { checksum: `sha256:${hash.digest("hex")}`, size_bytes: size };
}
```

- [ ] **Step 4: Viết `resolve.ts` và `secrets.ts`**

`packages/core/src/config/resolve.ts`:

```ts
import { HarnessError, type Checksum, type HarnessConfig } from "@harness/contracts";
import { canonicalDigest } from "../artifacts/checksum.js";

export interface ResolveInput {
  harness: HarnessConfig;
  workflowDefaults: Record<string, unknown>;
  profileOverrides: Record<string, unknown>;
  channelOverrides: Record<string, unknown>;
  runOverrides: Record<string, unknown>;
  profileMaxCostUsd: number;
  extraKnownKeys?: string[];
}

const BASE_KEYS = ["lease_seconds", "heartbeat_seconds", "poll_seconds", "default_deadline_seconds", "default_max_cost_usd"] as const;

export function resolveEffectiveConfig(input: ResolveInput): { snapshot: Record<string, unknown>; digest: Checksum } {
  const known = new Set<string>([...BASE_KEYS, ...(input.extraKnownKeys ?? [])]);
  const overridable = new Set<string>([...input.harness.allowed_override_keys, ...(input.extraKnownKeys ?? [])]);
  const snapshot: Record<string, unknown> = Object.fromEntries(BASE_KEYS.map((k) => [k, input.harness[k]]));

  const layers: [string, Record<string, unknown>, boolean][] = [
    ["workflow", input.workflowDefaults, false],
    ["profile", input.profileOverrides, true],
    ["channel", input.channelOverrides, true],
    ["run", input.runOverrides, true],
  ];
  for (const [name, layer, restricted] of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (!known.has(k)) throw new HarnessError("UNKNOWN_CONFIG_KEY", `unknown config key "${k}" in ${name} layer`, { layer: name, key: k });
      if (v === undefined) throw new HarnessError("CONFIG_INVALID", `key "${k}" in ${name} layer must not be undefined`, { layer: name, key: k }); // snapshot and digest must agree (review Task 7)
      if (restricted && !overridable.has(k)) throw new HarnessError("CONFIG_INVALID", `key "${k}" may not be overridden in ${name} layer`, { layer: name, key: k });
      snapshot[k] = v; // lists and objects replace, never merge
    }
  }
  // policy constraints (mandatory, applied last)
  const cost = Number(snapshot.default_max_cost_usd);
  if (Number.isFinite(cost) && cost > input.profileMaxCostUsd) snapshot.default_max_cost_usd = input.profileMaxCostUsd;
  return { snapshot, digest: canonicalDigest(snapshot) };
}
```

`packages/core/src/config/secrets.ts`:

```ts
import { HarnessError, type SecretResolver } from "@harness/contracts";

const REF_RE = /^secret:\/\/([a-z0-9-]+)\/([a-z0-9-]+)$/;

export class EnvSecretResolver implements SecretResolver {
  private readonly seen: string[] = [];
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  static envName(ref: string): string | undefined {
    const m = REF_RE.exec(ref);
    if (!m) return undefined;
    return `HARNESS_SECRET_${m[1]!.toUpperCase().replace(/-/g, "_")}_${m[2]!.toUpperCase().replace(/-/g, "_")}`;
  }
  resolve(ref: string): string {
    const name = EnvSecretResolver.envName(ref);
    const value = name ? this.env[name] : undefined;
    if (!name || value === undefined) throw new HarnessError("SECRET_UNRESOLVED", `cannot resolve ${ref}`, { ref, env: name ?? null });
    if (!this.seen.includes(value)) this.seen.push(value);
    return value;
  }
  resolvedValues(): string[] { return [...this.seen]; }
}
```

- [ ] **Step 5: Viết `redaction.ts` và `logger.ts`**

`packages/core/src/observability/redaction.ts`:

```ts
export class Redactor {
  constructor(private readonly secrets: () => string[]) {}
  redact<T>(value: T): T {
    // longest first: a secret that is a prefix of another must not break the longer match (review Task 7)
    const secrets = this.secrets().filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
    if (secrets.length === 0) return value;
    return walk(value, secrets) as T;
  }
}
function walk(v: unknown, secrets: string[]): unknown {
  if (typeof v === "string") return secrets.reduce((acc, s) => acc.split(s).join("[REDACTED]"), v);
  if (Array.isArray(v)) return v.map((x) => walk(x, secrets));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, secrets)]));
  return v;
}
```

`packages/core/src/observability/logger.ts`:

```ts
import { Redactor } from "./redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface HarnessLogger {
  debug(msg: string, data?: object): void;
  info(msg: string, data?: object): void;
  warn(msg: string, data?: object): void;
  error(msg: string, data?: object): void;
  child(bindings: Record<string, unknown>): HarnessLogger;
}

export interface LoggerOptions { redactor: Redactor; sink?: (line: string) => void; level?: LogLevel; bindings?: Record<string, unknown> }

export function createLogger(opts: LoggerOptions): HarnessLogger {
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + "\n"));
  const level = opts.level ?? "info";
  const bindings = opts.bindings ?? {};
  const write = (lvl: LogLevel, msg: string, data?: object) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const entry = opts.redactor.redact({ level: lvl, time: new Date().toISOString(), ...bindings, ...(data ?? {}), msg });
    sink(JSON.stringify(entry));
  };
  return {
    debug: (m, d) => write("debug", m, d),
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
    child: (b) => createLogger({ ...opts, bindings: { ...bindings, ...b } }),
  };
}
```

Bỏ `pino` khỏi `packages/core/package.json` (logger tự viết đủ nhu cầu, ít phụ thuộc hơn) và chạy `pnpm install`.

Thêm vào `packages/core/src/index.ts`:

```ts
export * from "./artifacts/checksum.js";
export * from "./config/resolve.js";
export * from "./config/secrets.js";
export * from "./observability/redaction.js";
export * from "./observability/logger.js";
```

- [ ] **Step 6: Chạy test, xác nhận pass**

Run: `pnpm vitest run packages/core && pnpm --filter @harness/core typecheck`
Expected: PASS toàn bộ.

- [ ] **Step 7: Commit**

```bash
git add packages/core pnpm-lock.yaml
git commit -m "feat(core): add digests, config precedence resolver, env secret resolver, redaction and logger

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 8: Workspace và artifact registry (commit nguyên tử, chỉ ACCEPTED cho downstream)

**Files:**
- Create: `packages/core/src/environment/workspace.ts`, `packages/core/src/artifacts/registry.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/environment/workspace.test.ts`, `packages/core/test/artifacts/registry.test.ts`

**Interfaces:**
- Consumes: `sha256File`, `SqliteStateStore`, `Artifact`, `StageOutput`, `StageInput`.
- Produces: `workspacePath(dataRoot, runId, stageKey, attemptId): string`, `createWorkspace(...): Promise<string>`, `materializeInputs(workspaceDir, artifacts): Promise<StageInput[]>`, `artifactDir(dataRoot, run, artifactId)`, `class ArtifactRegistry { constructor(store, dataRoot); stageOutputs(params): Promise<StagedOutput[]>; commitAccepted(staged, ctx): Artifact[]; registerRejected(params): Artifact[] }`, `acceptedInputsFor(store, stage): Artifact[]`.

- [ ] **Step 1: Viết test thất bại**

`packages/core/test/environment/workspace.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { newId, type Artifact } from "@harness/contracts";
import { createWorkspace, materializeInputs, workspacePath } from "../../src/environment/workspace.js";

describe("workspace", () => {
  it("creates the standard layout", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    const dir = await createWorkspace(root, "run_A", "produce", "attempt_B");
    expect(dir).toBe(workspacePath(root, "run_A", "produce", "attempt_B"));
    for (const sub of ["input", "output", "logs"]) expect(existsSync(join(dir, sub))).toBe(true);
  });
  it("copies accepted artifacts into input/<artifact_id>/", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    const src = join(root, "script.txt"); writeFileSync(src, "abc");
    const art: Artifact = {
      schema_version: "harness.artifact/v1", artifact_id: newId("artifact"), run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"),
      type: "script_text", status: "ACCEPTED", uri: pathToFileURL(src).href, checksum: "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      size_bytes: 3, mime_type: "text/plain", lineage: { input_artifacts: [], source_items: [] },
      reproducibility: { workflow_release: "w@1.0.0", production_profile: "cartoon@1", channel_config_revision: null, executor_version: "x", model_parameters_digest: null },
      checks: [], created_at: "2026-09-11T00:00:00.000Z", updated_at: "2026-09-11T00:00:00.000Z",
    };
    const dir = await createWorkspace(root, "run_A", "verify", "attempt_C");
    const inputs = await materializeInputs(dir, [art]);
    expect(inputs).toEqual([{ artifact_id: art.artifact_id, checksum: art.checksum, path: `input/${art.artifact_id}/script.txt`, type: "script_text" }]);
    expect(readFileSync(join(dir, inputs[0]!.path), "utf8")).toBe("abc");
  });
});
```

`packages/core/test/artifacts/registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactManifestSchema } from "@harness/contracts";
import { acceptedInputsFor, ArtifactRegistry } from "../../src/artifacts/registry.js";
import { sha256String } from "../../src/artifacts/checksum.js";
import { createWorkspace } from "../../src/environment/workspace.js";
import { openTempStore, seedStage } from "../helpers.js";

async function setup() {
  const { store, dir, clock } = openTempStore();
  const { runId, stage } = seedStage(store);
  const claim = store.claim({ owner: "w", capabilities: [], now: clock.now(), leaseSeconds: 90 })!;
  const ws = await createWorkspace(dir, runId, stage.stage_key, claim.attempt.attempt_id);
  writeFileSync(join(ws, "output", "result.txt"), "hello");
  const registry = new ArtifactRegistry(store, dir);
  const ctx = { run: store.getRun(runId)!, stageRun: store.getStageRun(stage.stage_run_id)!, attempt: claim.attempt, executorVersion: "fake@0.1.0", inputArtifactIds: [], checkResultIds: [] };
  return { store, dir, ws, registry, ctx, stage, claim };
}

describe("ArtifactRegistry", () => {
  it("stages outputs, verifies checksums, moves files and commits ACCEPTED with a manifest", async () => {
    const { store, ws, registry, ctx, stage } = await setup();
    const outputs = [{ path: "output/result.txt", type: "script_text", checksum: sha256String("hello"), size_bytes: 5 }];
    const staged = await registry.stageOutputs({ workspaceDir: ws, outputs, mimeTypes: { script_text: "text/plain" }, ctx });
    expect(staged).toHaveLength(1);
    const [art] = store.transaction(() => registry.commitAccepted(staged, ctx));
    expect(art!.status).toBe("ACCEPTED");
    expect(existsSync(fileURLToPath(art!.uri))).toBe(true);
    expect(existsSync(join(ws, "output", "result.txt"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(fileURLToPath(art!.uri), "..", "manifest.json"), "utf8"));
    expect(ArtifactManifestSchema.parse(manifest).status).toBe("accepted");
    expect(store.listArtifacts({ stage_run_id: stage.stage_run_id, status: "ACCEPTED" })).toHaveLength(1);
    expect(store.listEvents({ run_id: ctx.run.run_id }).map((e) => e.event_type)).toContain("artifact.accepted");
  });
  it("throws CHECKSUM_MISMATCH when a declared checksum is wrong and leaves the output in place", async () => {
    const { ws, registry, ctx } = await setup();
    const outputs = [{ path: "output/result.txt", type: "script_text", checksum: sha256String("wrong"), size_bytes: 5 }];
    await expect(registry.stageOutputs({ workspaceDir: ws, outputs, mimeTypes: {}, ctx })).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
    expect(existsSync(join(ws, "output", "result.txt"))).toBe(true);
  });
  it("registers REJECTED artifacts pointing at the workspace", async () => {
    const { store, ws, registry, ctx, stage } = await setup();
    const outputs = [{ path: "output/result.txt", type: "script_text", checksum: sha256String("wrong"), size_bytes: 5 }];
    const [art] = store.transaction(() => registry.registerRejected({ workspaceDir: ws, outputs, ctx, reason: "checksum mismatch" }));
    expect(art!.status).toBe("REJECTED");
    expect(store.listArtifacts({ stage_run_id: stage.stage_run_id, status: "ACCEPTED" })).toHaveLength(0);
  });
  it("acceptedInputsFor only returns ACCEPTED artifacts of upstream stages", async () => {
    const { store, ws, registry, ctx, stage } = await setup();
    const staged = await registry.stageOutputs({ workspaceDir: ws, outputs: [{ path: "output/result.txt", type: "script_text", checksum: sha256String("hello"), size_bytes: 5 }], mimeTypes: {}, ctx });
    store.transaction(() => registry.commitAccepted(staged, ctx));
    mkdirSync(join(ws, "output"), { recursive: true }); writeFileSync(join(ws, "output", "junk.txt"), "junk");
    store.transaction(() => registry.registerRejected({ workspaceDir: ws, outputs: [{ path: "output/junk.txt", type: "junk", checksum: sha256String("x"), size_bytes: 4 }], ctx, reason: "bad" }));
    const downstream = seedStage(store, { key: "verify", runId: ctx.run.run_id, depends_on: [stage.stage_key], state: "PENDING" });
    const inputs = acceptedInputsFor(store, downstream.stage);
    expect(inputs.map((a) => a.type)).toEqual(["script_text"]);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/core/test/environment packages/core/test/artifacts/registry.test.ts`
Expected: FAIL, thiếu module.

- [ ] **Step 3: Viết `workspace.ts`**

`packages/core/src/environment/workspace.ts`:

```ts
import { copyFile, link, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Artifact, StageInput } from "@harness/contracts";

export function workspacePath(dataRoot: string, runId: string, stageKey: string, attemptId: string): string {
  return join(dataRoot, "workspaces", runId, stageKey, attemptId);
}

export async function createWorkspace(dataRoot: string, runId: string, stageKey: string, attemptId: string): Promise<string> {
  const dir = workspacePath(dataRoot, runId, stageKey, attemptId);
  for (const sub of ["input", "output", "logs"]) await mkdir(join(dir, sub), { recursive: true });
  return dir;
}

async function linkOrCopy(src: string, dest: string): Promise<void> {
  try { await link(src, dest); } catch { await copyFile(src, dest); }
}

export async function materializeInputs(workspaceDir: string, artifacts: Artifact[]): Promise<StageInput[]> {
  const inputs: StageInput[] = [];
  for (const a of artifacts) {
    const src = fileURLToPath(a.uri);
    const rel = join("input", a.artifact_id, basename(src)).split("\\").join("/");
    await mkdir(join(workspaceDir, "input", a.artifact_id), { recursive: true });
    await linkOrCopy(src, join(workspaceDir, rel));
    inputs.push({ artifact_id: a.artifact_id, checksum: a.checksum, path: rel, type: a.type });
  }
  return inputs;
}
```

- [ ] **Step 4: Viết `registry.ts`**

`packages/core/src/artifacts/registry.ts`:

```ts
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { HarnessError, newId, type Artifact, type ArtifactManifest, type Attempt, type Run, type StageOutput, type StageRun, type StateStore } from "@harness/contracts";
import { sha256File } from "./checksum.js";

export interface ArtifactContext {
  run: Run; stageRun: StageRun; attempt: Attempt;
  executorVersion: string; inputArtifactIds: string[]; checkResultIds: string[];
}
export interface StagedOutput { artifact: Artifact; manifestPath: string; manifest: ArtifactManifest }

export function artifactDir(dataRoot: string, run: Run, artifactId: string): string {
  return join(dataRoot, "artifacts", run.content_id ?? run.run_id, run.variant_id ?? run.profile_snapshot.id, artifactId);
}

function buildArtifact(output: StageOutput, uri: string, mime: string, ctx: ArtifactContext, status: Artifact["status"], now: string): Artifact {
  return {
    schema_version: "harness.artifact/v1", artifact_id: newId("artifact"), run_id: ctx.run.run_id, stage_run_id: ctx.stageRun.stage_run_id,
    attempt_id: ctx.attempt.attempt_id, type: output.type, status, uri, checksum: output.checksum, size_bytes: output.size_bytes, mime_type: mime,
    lineage: { input_artifacts: ctx.inputArtifactIds, source_items: ctx.run.source_id ? [ctx.run.source_id] : [] },
    reproducibility: {
      workflow_release: `${ctx.run.workflow_release.id}@${ctx.run.workflow_release.version}`,
      production_profile: `${ctx.run.profile_snapshot.id}@${ctx.run.profile_snapshot.revision}`,
      channel_config_revision: null, executor_version: ctx.executorVersion, model_parameters_digest: null,
    },
    checks: ctx.checkResultIds, created_at: now, updated_at: now,
  };
}

export function toManifest(a: Artifact): ArtifactManifest {
  return {
    schema_version: "harness.artifact/v1", artifact_id: a.artifact_id, type: a.type, status: a.status.toLowerCase() as ArtifactManifest["status"],
    uri: a.uri, checksum: a.checksum, size_bytes: a.size_bytes, mime_type: a.mime_type,
    created_by: { run_id: a.run_id, stage_run_id: a.stage_run_id, attempt_id: a.attempt_id },
    lineage: a.lineage, reproducibility: a.reproducibility, checks: a.checks,
  };
}

export class ArtifactRegistry {
  constructor(private readonly store: StateStore, private readonly dataRoot: string) {}

  /** Async phase: verify every output first (no file moved on any failure), then move files and write PROVISIONAL manifests. No DB writes. (review Task 8) */
  async stageOutputs(p: { workspaceDir: string; outputs: StageOutput[]; mimeTypes: Record<string, string>; ctx: ArtifactContext }): Promise<StagedOutput[]> {
    const now = new Date().toISOString();
    const root = resolve(p.workspaceDir) + sep;
    const verified: { out: StageOutput; src: string }[] = [];
    for (const out of p.outputs) {
      const src = resolve(p.workspaceDir, out.path);
      if (!src.startsWith(root)) throw new HarnessError("IO_ERROR", `output path escapes the workspace: ${out.path}`, { path: out.path });
      const actual = await sha256File(src).catch(() => { throw new HarnessError("IO_ERROR", `output missing: ${out.path}`, { path: out.path }); });
      if (actual.checksum !== out.checksum || actual.size_bytes !== out.size_bytes) {
        throw new HarnessError("CHECKSUM_MISMATCH", `checksum mismatch for ${out.path}`, { path: out.path, declared: out.checksum, actual: actual.checksum });
      }
      verified.push({ out, src });
    }
    const staged: StagedOutput[] = [];
    for (const { out, src } of verified) {
      const id = newId("artifact");
      const dir = artifactDir(this.dataRoot, p.ctx.run, id);
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, basename(src));
      renameSync(src, dest);
      const artifact = { ...buildArtifact(out, pathToFileURL(dest).href, p.mimeTypes[out.type] ?? "application/octet-stream", p.ctx, "PROVISIONAL", now), artifact_id: id };
      const manifestPath = join(dir, "manifest.json");
      const manifest = toManifest(artifact);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      staged.push({ artifact, manifestPath, manifest });
    }
    return staged;
  }

  /** Sync phase: must run inside store.transaction(). PROVISIONAL -> ACCEPTED with event; manifest rewritten to "accepted" only after the DB row is ACCEPTED. */
  commitAccepted(staged: StagedOutput[], ctx: ArtifactContext): Artifact[] {
    return staged.map(({ artifact, manifestPath }) => {
      this.store.insertArtifact(artifact);
      this.store.transition("artifact", artifact.artifact_id, "PROVISIONAL", "ACCEPTED", {
        run_id: ctx.run.run_id, stage_run_id: ctx.stageRun.stage_run_id, attempt_id: ctx.attempt.attempt_id, project_id: ctx.run.project_id,
        portfolio_id: ctx.run.portfolio_id, channel_id: null, content_id: ctx.run.content_id ?? null, variant_id: ctx.run.variant_id ?? null,
        workflow_release: `${ctx.run.workflow_release.id}@${ctx.run.workflow_release.version}`, severity: "info", event_type: "artifact.accepted",
        payload: { artifact_id: artifact.artifact_id, type: artifact.type, checksum: artifact.checksum },
      });
      const accepted = this.store.getArtifact(artifact.artifact_id)!;
      writeFileSync(manifestPath, JSON.stringify(toManifest(accepted), null, 2) + "\n");
      return accepted;
    });
  }

  /** Sync phase inside a transaction: record outputs that failed verification, pointing at the workspace. */
  registerRejected(p: { workspaceDir: string; outputs: StageOutput[]; ctx: ArtifactContext; reason: string }): Artifact[] {
    const now = new Date().toISOString();
    return p.outputs.map((out) => {
      const a = buildArtifact(out, pathToFileURL(join(p.workspaceDir, out.path)).href, "application/octet-stream", p.ctx, "PROVISIONAL", now);
      this.store.insertArtifact(a);
      this.store.transition("artifact", a.artifact_id, "PROVISIONAL", "REJECTED", {
        run_id: p.ctx.run.run_id, stage_run_id: p.ctx.stageRun.stage_run_id, attempt_id: p.ctx.attempt.attempt_id, project_id: p.ctx.run.project_id,
        portfolio_id: p.ctx.run.portfolio_id, channel_id: null, content_id: null, variant_id: null, workflow_release: null,
        severity: "warn", event_type: "artifact.rejected", payload: { artifact_id: a.artifact_id, reason: p.reason },
      });
      return this.store.getArtifact(a.artifact_id)!;
    });
  }
}

/** Downstream stages only ever see ACCEPTED artifacts from the stages they depend on. */
export function acceptedInputsFor(store: StateStore, stage: StageRun): Artifact[] {
  const upstream = store.listStageRuns(stage.run_id).filter((s) => stage.depends_on.includes(s.stage_key));
  return upstream.flatMap((s) => store.listArtifacts({ stage_run_id: s.stage_run_id, status: "ACCEPTED" }));
}
```

Thêm vào `packages/core/src/index.ts`:

```ts
export * from "./environment/workspace.js";
export * from "./artifacts/registry.js";
```

- [ ] **Step 5: Chạy test, xác nhận pass**

Run: `pnpm vitest run packages/core && pnpm --filter @harness/core typecheck`
Expected: PASS toàn bộ.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): add workspace layout, input materialisation and artifact registry with manifests

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Workflow/profile loader, workflow mẫu và Planner (plan, enqueue, advance, cancel)

**Files:**
- Create: `workflows/sample-three-stage/workflow.yaml`, `production-profiles/cartoon/profile.yaml`, `configs/harness.yaml`
- Create: `packages/core/src/orchestration/registry.ts`, `packages/core/src/orchestration/planner.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/orchestration/registry.test.ts`, `packages/core/test/orchestration/planner.test.ts`

**Interfaces:**
- Consumes: `WorkflowDefinitionSchema`, `ProductionProfileSchema`, `HarnessConfigSchema`, `resolveEffectiveConfig`, `canonicalDigest`, `SqliteStateStore`.
- Produces: `HARNESS_ROOT`, `loadWorkflow(harnessRoot, ref: "id@version"): LoadedWorkflow {definition, digest}`, `loadProfile(harnessRoot, id): ProductionProfile`, `loadHarnessConfig(harnessRoot): HarnessConfig`, `class Planner { constructor(store); plan(input: PlanInput): Run; enqueue(runId): void; advance(runId): { released: string[]; runState: string }; cancel(runId): void }`, `eventFor(run, stage?, attempt?, type, severity?, payload?)`.

- [ ] **Step 1: Viết file cấu hình mẫu**

`workflows/sample-three-stage/workflow.yaml`:

```yaml
schema_version: harness.workflow/v1
id: sample-three-stage
version: 1.0.0
defaults:
  lease_seconds: 90
stages:
  - key: produce
    executor: { type: script, script: fake-stage }
    required_capabilities: [write_workspace]
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: script_text, mime_type: text/plain }
    config:
      content: "draft script"
  - key: review
    executor: { type: agent, skill: fake-review, brief: "Review the draft script and produce notes." }
    depends_on: [produce]
    required_capabilities: [read_source]
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: review_notes, mime_type: text/plain }
  - key: finalize
    executor: { type: script, script: fake-stage }
    depends_on: [produce, review]
    required_capabilities: [write_workspace]
    required_checks: [schema-valid, output-exists, checksum-match]
    outputs:
      - { type: final_text, mime_type: text/plain }
    config:
      content: "final"
```

`production-profiles/cartoon/profile.yaml`:

```yaml
schema_version: harness.production-profile/v1
profile_id: cartoon
revision: 1
status: active
workflow_release: sample-three-stage@1.0.0
overrides:
  lease_seconds: 120
verification:
  required_checks: [schema-valid]
limits:
  max_cost_usd_per_variant: 5
  max_concurrency: 2
```

`configs/harness.yaml`:

```yaml
schema_version: harness.config/v1
lease_seconds: 90
heartbeat_seconds: 30
poll_seconds: 2
default_deadline_seconds: 3600
default_max_cost_usd: 5
retention:
  workspace_days: 7
allowed_override_keys: [lease_seconds, default_deadline_seconds, default_max_cost_usd]
```

- [ ] **Step 2: Viết test thất bại**

`packages/core/test/orchestration/registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HARNESS_ROOT, loadHarnessConfig, loadProfile, loadWorkflow } from "../../src/orchestration/registry.js";

describe("registry loaders", () => {
  it("loads the sample workflow with a stable digest", () => {
    const a = loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0");
    const b = loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0");
    expect(a.definition.stages.map((s) => s.key)).toEqual(["produce", "review", "finalize"]);
    expect(a.digest).toBe(b.digest);
    expect(a.definition.stages[0]?.retry.max_attempts).toBe(3);
  });
  it("rejects a version that does not match the file", () => {
    expect(() => loadWorkflow(HARNESS_ROOT, "sample-three-stage@9.9.9")).toThrow(/version/);
  });
  it("loads profile and harness config", () => {
    expect(loadProfile(HARNESS_ROOT, "cartoon").overrides).toEqual({ lease_seconds: 120 });
    expect(loadHarnessConfig(HARNESS_ROOT).lease_seconds).toBe(90);
  });
});
```

`packages/core/test/orchestration/planner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isHarnessError } from "@harness/contracts";
import { HARNESS_ROOT, loadHarnessConfig, loadProfile, loadWorkflow } from "../../src/orchestration/registry.js";
import { Planner } from "../../src/orchestration/planner.js";
import { openTempStore } from "../helpers.js";

function planSample(overrides: Record<string, unknown> = {}) {
  const t = openTempStore();
  const planner = new Planner(t.store);
  const run = planner.plan({
    workflow: loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0"), profile: loadProfile(HARNESS_ROOT, "cartoon"),
    harness: loadHarnessConfig(HARNESS_ROOT), projectId: "project-main", portfolioId: "portfolio-main", runOverrides: overrides,
  });
  return { ...t, planner, run };
}

describe("Planner", () => {
  it("creates a DRAFT run with one PENDING stage per workflow stage and a pinned snapshot", () => {
    const { store, run } = planSample();
    expect(run.state).toBe("DRAFT");
    expect(run.effective_config_snapshot.lease_seconds).toBe(120);
    expect(run.workflow_release.digest).toMatch(/^sha256:/);
    const stages = store.listStageRuns(run.run_id);
    expect(stages.map((s) => [s.stage_key, s.state])).toEqual([["produce", "PENDING"], ["review", "PENDING"], ["finalize", "PENDING"]]);
    expect(stages[0]?.stage_config).toEqual({ content: "draft script" });
    expect(store.listEvents({ run_id: run.run_id }).map((e) => e.event_type)).toEqual(["run.created"]);
  });
  it("fails before creating anything when a run override key is unknown", () => {
    try { planSample({ leese_seconds: 5 }); throw new Error("no throw"); }
    catch (e) { expect(isHarnessError(e, "UNKNOWN_CONFIG_KEY")).toBe(true); }
  });
  it("enqueue readies the run and the root stages only", () => {
    const { store, planner, run } = planSample();
    planner.enqueue(run.run_id);
    expect(store.getRun(run.run_id)?.state).toBe("READY");
    expect(store.listStageRuns(run.run_id).map((s) => s.state)).toEqual(["READY", "PENDING", "PENDING"]);
  });
  it("advance releases dependants when all dependencies succeeded and finishes the run", () => {
    const { store, planner, run, clock } = planSample();
    planner.enqueue(run.run_id);
    const finish = (key: string) => {
      const c = store.claim({ owner: "w", capabilities: ["write_workspace", "read_source"], now: clock.now(), leaseSeconds: 90 })!;
      expect(c.stageRun.stage_key).toBe(key);
      const ev = { run_id: run.run_id, stage_run_id: c.stageRun.stage_run_id, attempt_id: c.attempt.attempt_id, project_id: "p", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info" as const, event_type: "stage.test", payload: {} };
      store.transition("stage_run", c.stageRun.stage_run_id, "CLAIMED", "RUNNING", ev);
      store.transition("stage_run", c.stageRun.stage_run_id, "RUNNING", "VERIFYING", ev);
      store.transition("stage_run", c.stageRun.stage_run_id, "VERIFYING", "SUCCEEDED", ev);
      store.releaseLease(c.stageRun.stage_run_id, c.lease.fencing_token);
      return planner.advance(run.run_id);
    };
    expect(finish("produce")).toEqual({ released: ["review"], runState: "RUNNING" });
    expect(finish("review")).toEqual({ released: ["finalize"], runState: "RUNNING" });
    expect(finish("finalize")).toEqual({ released: [], runState: "SUCCEEDED" });
  });
  it("advance marks the run FAILED when a stage is terminally FAILED and WAITING when a stage needs a human", () => {
    const { store, planner, run, clock } = planSample();
    planner.enqueue(run.run_id);
    const c = store.claim({ owner: "w", capabilities: ["write_workspace"], now: clock.now(), leaseSeconds: 90 })!;
    const ev = { run_id: run.run_id, stage_run_id: c.stageRun.stage_run_id, attempt_id: null, project_id: "p", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info" as const, event_type: "stage.test", payload: {} };
    store.transition("stage_run", c.stageRun.stage_run_id, "CLAIMED", "RUNNING", ev);
    store.transition("stage_run", c.stageRun.stage_run_id, "RUNNING", "WAITING_HUMAN", ev);
    expect(planner.advance(run.run_id).runState).toBe("WAITING");
    store.transition("stage_run", c.stageRun.stage_run_id, "WAITING_HUMAN", "READY", ev);
    expect(planner.advance(run.run_id).runState).toBe("RUNNING");
    const s = store.getStageRun(c.stageRun.stage_run_id)!;
    store.updateStageRun({ ...s, attempt_count: 3 });
    store.transition("stage_run", s.stage_run_id, "READY", "CLAIMED", ev);
    store.transition("stage_run", s.stage_run_id, "CLAIMED", "FAILED", ev);
    expect(planner.advance(run.run_id).runState).toBe("FAILED");
  });
  it("cancel moves READY/PENDING stages to CANCELLED and the run to CANCELLED", () => {
    const { store, planner, run } = planSample();
    planner.enqueue(run.run_id);
    planner.cancel(run.run_id);
    expect(store.getRun(run.run_id)?.state).toBe("CANCELLED");
    expect(new Set(store.listStageRuns(run.run_id).map((s) => s.state))).toEqual(new Set(["CANCELLED"]));
  });
});
```

- [ ] **Step 3: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/core/test/orchestration`
Expected: FAIL, thiếu module.

- [ ] **Step 4: Viết `registry.ts`**

`packages/core/src/orchestration/registry.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { HarnessConfigSchema, HarnessError, ProductionProfileSchema, WorkflowDefinitionSchema, type Checksum, type HarnessConfig, type ProductionProfile, type WorkflowDefinition } from "@harness/contracts";
import { canonicalDigest } from "../artifacts/checksum.js";

export const HARNESS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

export interface LoadedWorkflow { definition: WorkflowDefinition; digest: Checksum }

function readYaml(path: string): unknown {
  if (!existsSync(path)) throw new HarnessError("NOT_FOUND", `file not found: ${path}`, { path });
  return parse(readFileSync(path, "utf8"));
}

export function loadWorkflow(harnessRoot: string, ref: string): LoadedWorkflow {
  const [id, version] = ref.split("@");
  if (!id || !version) throw new HarnessError("WORKFLOW_INVALID", `workflow ref must be id@version, got "${ref}"`, { ref });
  const raw = readYaml(join(harnessRoot, "workflows", id, "workflow.yaml"));
  const parsed = WorkflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) throw new HarnessError("WORKFLOW_INVALID", `workflow ${id} invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`, { issues: parsed.error.issues });
  if (parsed.data.version !== version) throw new HarnessError("WORKFLOW_INVALID", `workflow ${id} has version ${parsed.data.version}, requested ${version}`, { ref });
  return { definition: parsed.data, digest: canonicalDigest(parsed.data) };
}

export function loadProfile(harnessRoot: string, id: string): ProductionProfile {
  return ProductionProfileSchema.parse(readYaml(join(harnessRoot, "production-profiles", id, "profile.yaml")));
}

export function loadHarnessConfig(harnessRoot: string): HarnessConfig {
  return HarnessConfigSchema.parse(readYaml(join(harnessRoot, "configs", "harness.yaml")));
}
```

- [ ] **Step 5: Viết `planner.ts`**

`packages/core/src/orchestration/planner.ts`:

```ts
import { newId, type Attempt, type EventInput, type HarnessConfig, type ProductionProfile, type Run, type StageRun, type StateStore } from "@harness/contracts";
import { resolveEffectiveConfig } from "../config/resolve.js";
import { isTerminal } from "../state/transitions.js";
import type { LoadedWorkflow } from "./registry.js";

export interface PlanInput {
  workflow: LoadedWorkflow; profile: ProductionProfile; harness: HarnessConfig;
  projectId: string; portfolioId: string; runOverrides?: Record<string, unknown>; channelOverrides?: Record<string, unknown>; sourceId?: string;
}

export function eventFor(run: Run, stage: StageRun | null, attempt: Attempt | null, event_type: string, severity: EventInput["severity"] = "info", payload: Record<string, unknown> = {}): EventInput {
  return {
    run_id: run.run_id, stage_run_id: stage?.stage_run_id ?? null, attempt_id: attempt?.attempt_id ?? null, project_id: run.project_id, portfolio_id: run.portfolio_id,
    channel_id: null, content_id: run.content_id ?? null, variant_id: run.variant_id ?? null,
    workflow_release: `${run.workflow_release.id}@${run.workflow_release.version}`, severity, event_type, payload,
  };
}

export class Planner {
  constructor(private readonly store: StateStore) {}

  plan(input: PlanInput): Run {
    const { snapshot, digest } = resolveEffectiveConfig({
      harness: input.harness, workflowDefaults: input.workflow.definition.defaults, profileOverrides: input.profile.overrides,
      channelOverrides: input.channelOverrides ?? {}, runOverrides: input.runOverrides ?? {}, profileMaxCostUsd: input.profile.limits.max_cost_usd_per_variant,
    });
    return this.store.transaction(() => {
      const now = (this.store as { clock?: { now(): string } }).clock?.now() ?? new Date().toISOString();
      const run: Run = {
        schema_version: "harness.run/v1", run_id: newId("run"), project_id: input.projectId, portfolio_id: input.portfolioId,
        workflow_release: { id: input.workflow.definition.id, version: input.workflow.definition.version, digest: input.workflow.digest },
        profile_snapshot: { id: input.profile.profile_id, revision: input.profile.revision },
        ...(input.sourceId ? { source_id: input.sourceId } : {}),
        state: "DRAFT", effective_config_snapshot: snapshot, effective_config_digest: digest, total_cost_usd: 0, created_at: now, updated_at: now,
      };
      this.store.insertRun(run);
      for (const s of input.workflow.definition.stages) {
        const stage: StageRun = {
          schema_version: "harness.stage-run/v1", stage_run_id: newId("stage_run"), run_id: run.run_id, stage_key: s.key, executor: s.executor,
          depends_on: s.depends_on, required_capabilities: s.required_capabilities,
          required_checks: [...new Set([...s.required_checks, ...input.profile.verification.required_checks])],
          retry: s.retry, stage_config: s.config, state: "PENDING", attempt_count: 0, result_failures: 0, created_at: now, updated_at: now,
        };
        this.store.insertStageRun(stage);
      }
      this.store.appendEvent(eventFor(run, null, null, "run.created", "info", { stages: input.workflow.definition.stages.length }));
      return run;
    });
  }

  enqueue(runId: string): void {
    this.store.transaction(() => {
      const run = this.mustRun(runId);
      this.store.transition("run", runId, "DRAFT", "READY", eventFor(run, null, null, "run.enqueued"));
      for (const s of this.store.listStageRuns(runId)) if (s.depends_on.length === 0) this.ready(run, s);
    });
  }

  /** Release dependants whose dependencies all SUCCEEDED; settle the run state. Idempotent. */
  advance(runId: string): { released: string[]; runState: string } {
    return this.store.transaction(() => {
      const run = this.mustRun(runId);
      const stages = this.store.listStageRuns(runId);
      const byKey = new Map(stages.map((s) => [s.stage_key, s]));
      const released: string[] = [];
      for (const s of stages) {
        if (s.state !== "PENDING") continue;
        if (s.depends_on.every((d) => byKey.get(d)?.state === "SUCCEEDED")) { this.ready(run, s); released.push(s.stage_key); }
      }
      const fresh = this.store.listStageRuns(runId);
      const allDone = fresh.every((s) => s.state === "SUCCEEDED");
      const anyFailed = fresh.some((s) => s.state === "FAILED" || s.state === "CANCELLED");
      const anyWaiting = fresh.some((s) => s.state === "WAITING_HUMAN" || s.state === "NEEDS_RECONCILIATION");
      const anyActive = fresh.some((s) => ["READY", "CLAIMED", "RUNNING", "VERIFYING", "WAITING_EXTERNAL"].includes(s.state));
      const current = this.mustRun(runId);
      if (current.state === "RUNNING" && allDone) this.store.transition("run", runId, "RUNNING", "SUCCEEDED", eventFor(run, null, null, "run.succeeded"));
      else if (current.state === "RUNNING" && anyFailed && !anyActive) this.store.transition("run", runId, "RUNNING", "FAILED", eventFor(run, null, null, "run.failed", "error"));
      else if (current.state === "RUNNING" && anyWaiting && !anyActive) this.store.transition("run", runId, "RUNNING", "WAITING", eventFor(run, null, null, "run.waiting", "warn"));
      else if (current.state === "WAITING" && anyActive) this.store.transition("run", runId, "WAITING", "RUNNING", eventFor(run, null, null, "run.resumed"));
      return { released, runState: this.mustRun(runId).state };
    });
  }

  cancel(runId: string): void {
    this.store.transaction(() => {
      const run = this.mustRun(runId);
      for (const s of this.store.listStageRuns(runId)) {
        if (s.state === "PENDING" || s.state === "READY") this.store.transition("stage_run", s.stage_run_id, s.state, "CANCELLED", eventFor(run, s, null, "stage.cancelled", "warn"));
        else if (!isTerminal("stage_run", s.state) && s.state !== "CANCEL_REQUESTED") this.store.transition("stage_run", s.stage_run_id, s.state, "CANCEL_REQUESTED", eventFor(run, s, null, "stage.cancel_requested", "warn"));
      }
      const remaining = this.store.listStageRuns(runId).some((s) => s.state === "CANCEL_REQUESTED");
      if (run.state === "DRAFT") this.store.transition("run", runId, "DRAFT", "CANCELLED", eventFor(run, null, null, "run.cancelled", "warn"));
      else if (!isTerminal("run", run.state)) {
        if (run.state !== "CANCEL_REQUESTED") this.store.transition("run", runId, run.state, "CANCEL_REQUESTED", eventFor(run, null, null, "run.cancel_requested", "warn"));
        if (!remaining) this.store.transition("run", runId, "CANCEL_REQUESTED", "CANCELLED", eventFor(run, null, null, "run.cancelled", "warn"));
      }
    });
  }

  private ready(run: Run, s: StageRun): void {
    this.store.transition("stage_run", s.stage_run_id, "PENDING", "READY", eventFor(run, s, null, "stage.ready"));
    const fresh = this.store.getStageRun(s.stage_run_id)!;
    this.store.updateStageRun({ ...fresh, ready_at: fresh.updated_at });
  }
  private mustRun(runId: string): Run {
    const run = this.store.getRun(runId);
    if (!run) throw new (class extends Error {})(`run not found: ${runId}`);
    return run;
  }
}
```

Sửa dòng `mustRun` để ném `HarnessError("NOT_FOUND", ...)` thay cho class ẩn danh: import `HarnessError` từ `@harness/contracts` và viết `throw new HarnessError("NOT_FOUND", \`run not found: ${runId}\`, { runId })`.

Thêm vào `packages/core/src/index.ts`:

```ts
export * from "./orchestration/registry.js";
export * from "./orchestration/planner.js";
```

- [ ] **Step 6: Chạy test, xác nhận pass**

Run: `pnpm vitest run packages/core && pnpm --filter @harness/core typecheck`
Expected: PASS toàn bộ.

- [ ] **Step 7: Commit**

```bash
git add packages/core workflows production-profiles configs
git commit -m "feat(core): add workflow/profile loaders, sample workflow and planner with DAG release

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 10: Verifier và ba checker

**Files:**
- Create: `packages/core/src/verification/checkers.ts`, `packages/core/src/verification/verifier.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/verification/verifier.test.ts`

**Interfaces:**
- Consumes: `Checker`, `CheckerInput`, `StageResultSchema`, `sha256File`.
- Produces: `schemaValidChecker`, `outputExistsChecker`, `checksumMatchChecker`, `BUILTIN_CHECKERS`, `class Verifier { constructor(checkers: Checker[]); verify(input: CheckerInput, requiredCheckIds: string[]): Promise<VerifyOutcome> }` với `VerifyOutcome = { results: { check_id, checker_version, verdict, evidence }[]; allRequiredPassed: boolean; missing: string[] }`.

- [ ] **Step 1: Viết test thất bại**

`packages/core/test/verification/verifier.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type StageRequest, type StageResult } from "@harness/contracts";
import { sha256String } from "../../src/artifacts/checksum.js";
import { BUILTIN_CHECKERS, Verifier } from "../../src/verification/verifier.js";

const sha = "sha256:" + "a".repeat(64);
function fixture(content: string, declared: string) {
  const ws = mkdtempSync(join(tmpdir(), "vf-"));
  mkdirSync(join(ws, "output")); writeFileSync(join(ws, "output", "r.txt"), content);
  const attempt_id = newId("attempt");
  const request: StageRequest = {
    schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id, project_id: "p", portfolio_id: "pf",
    stage_key: "produce", workflow: { id: "w", version: "1.0.0", digest: sha }, profile_snapshot: { id: "cartoon", revision: 1 }, inputs: [],
    workspace_uri: ws, stage_config: {}, limits: { deadline_at: "2026-09-11T01:00:00.000Z", max_cost_usd: 5, max_attempts: 3 }, capabilities: [], fencing_token: 1,
  };
  const result: StageResult = { schema_version: "harness.stage-result/v1", attempt_id, outcome: "succeeded", outputs: [{ path: "output/r.txt", type: "t", checksum: declared, size_bytes: content.length }], checks: [], usage: { wall_seconds: 1, cost_usd: 0 }, external_operations: [], errors: [] };
  return { ws, request, result };
}

describe("Verifier", () => {
  it("passes all three built-in checks for a good result", async () => {
    const { ws, request, result } = fixture("hello", sha256String("hello"));
    const v = new Verifier(BUILTIN_CHECKERS);
    const out = await v.verify({ request, result, workspaceDir: ws }, ["schema-valid", "output-exists", "checksum-match"]);
    expect(out.allRequiredPassed).toBe(true);
    expect(out.results.map((r) => [r.check_id, r.verdict])).toEqual([["schema-valid", "pass"], ["output-exists", "pass"], ["checksum-match", "pass"]]);
  });
  it("fails checksum-match with evidence and reports missing checkers", async () => {
    const { ws, request, result } = fixture("hello", sha256String("nope"));
    const out = await new Verifier(BUILTIN_CHECKERS).verify({ request, result, workspaceDir: ws }, ["checksum-match", "video-probe"]);
    expect(out.allRequiredPassed).toBe(false);
    expect(out.results.find((r) => r.check_id === "checksum-match")).toMatchObject({ verdict: "fail", evidence: { path: "output/r.txt", declared: sha256String("nope") } });
    expect(out.missing).toEqual(["video-probe"]);
  });
  it("fails output-exists when the file is absent", async () => {
    const { ws, request, result } = fixture("hello", sha256String("hello"));
    const bad = { ...result, outputs: [{ ...result.outputs[0]!, path: "output/missing.txt" }] };
    const out = await new Verifier(BUILTIN_CHECKERS).verify({ request, result: bad, workspaceDir: ws }, ["output-exists"]);
    expect(out.results[0]).toMatchObject({ check_id: "output-exists", verdict: "fail" });
  });
  it("fails schema-valid for a result with an attempt_id mismatch", async () => {
    const { ws, request, result } = fixture("hello", sha256String("hello"));
    const out = await new Verifier(BUILTIN_CHECKERS).verify({ request, result: { ...result, attempt_id: newId("attempt") }, workspaceDir: ws }, ["schema-valid"]);
    expect(out.results[0]).toMatchObject({ check_id: "schema-valid", verdict: "fail" });
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/core/test/verification`
Expected: FAIL, thiếu module.

- [ ] **Step 3: Viết `checkers.ts` và `verifier.ts`**

`packages/core/src/verification/checkers.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { StageResultSchema, type Checker } from "@harness/contracts";
import { sha256File } from "../artifacts/checksum.js";

export const schemaValidChecker: Checker = {
  id: "schema-valid", version: "1.0.0",
  async check({ request, result }) {
    const parsed = StageResultSchema.safeParse(result);
    if (!parsed.success) return { verdict: "fail", evidence: { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
    if (parsed.data.attempt_id !== request.attempt_id) return { verdict: "fail", evidence: { expected: request.attempt_id, actual: parsed.data.attempt_id } };
    return { verdict: "pass", evidence: {} };
  },
};

export const outputExistsChecker: Checker = {
  id: "output-exists", version: "1.0.0",
  async check({ result, workspaceDir }) {
    const missing = result.outputs.filter((o) => !existsSync(join(workspaceDir, o.path))).map((o) => o.path);
    return missing.length ? { verdict: "fail", evidence: { missing } } : { verdict: "pass", evidence: { count: result.outputs.length } };
  },
};

export const checksumMatchChecker: Checker = {
  id: "checksum-match", version: "1.0.0",
  async check({ result, workspaceDir }) {
    for (const o of result.outputs) {
      const path = join(workspaceDir, o.path);
      if (!existsSync(path)) return { verdict: "fail", evidence: { path: o.path, reason: "missing" } };
      const actual = await sha256File(path);
      if (actual.checksum !== o.checksum || actual.size_bytes !== o.size_bytes) {
        return { verdict: "fail", evidence: { path: o.path, declared: o.checksum, actual: actual.checksum, declared_size: o.size_bytes, actual_size: actual.size_bytes } };
      }
    }
    return { verdict: "pass", evidence: { verified: result.outputs.length } };
  },
};

export const BUILTIN_CHECKERS: Checker[] = [schemaValidChecker, outputExistsChecker, checksumMatchChecker];
```

`packages/core/src/verification/verifier.ts`:

```ts
import type { Checker, CheckerInput } from "@harness/contracts";
export { BUILTIN_CHECKERS } from "./checkers.js";

export interface VerifyResult { check_id: string; checker_version: string; verdict: "pass" | "fail" | "skip"; evidence: Record<string, unknown> }
export interface VerifyOutcome { results: VerifyResult[]; allRequiredPassed: boolean; missing: string[] }

export class Verifier {
  private readonly byId: Map<string, Checker>;
  constructor(checkers: Checker[]) { this.byId = new Map(checkers.map((c) => [c.id, c])); }

  async verify(input: CheckerInput, requiredCheckIds: string[]): Promise<VerifyOutcome> {
    const results: VerifyResult[] = [];
    const missing: string[] = [];
    for (const id of requiredCheckIds) {
      const checker = this.byId.get(id);
      if (!checker) { missing.push(id); continue; }
      try {
        const r = await checker.check(input);
        results.push({ check_id: id, checker_version: checker.version, ...r });
      } catch (e) {
        results.push({ check_id: id, checker_version: checker.version, verdict: "fail", evidence: { error: e instanceof Error ? e.message : String(e) } });
      }
    }
    return { results, missing, allRequiredPassed: missing.length === 0 && results.every((r) => r.verdict === "pass") };
  }
}
```

Thêm vào `packages/core/src/index.ts`: `export * from "./verification/verifier.js"; export * from "./verification/checkers.js";` (chỉ export `verifier.js` nếu TypeScript báo trùng tên `BUILTIN_CHECKERS`; khi đó bỏ dòng re-export trong `verifier.ts`).

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `pnpm vitest run packages/core && pnpm --filter @harness/core typecheck`
Expected: PASS toàn bộ.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): add verifier with schema-valid, output-exists and checksum-match checkers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Executor `script`/`agent`, registry, và adapter giả

**Files:**
- Create: `packages/executors/package.json`, `packages/executors/tsconfig.json`, `packages/executors/vitest.config.ts`, `packages/executors/src/index.ts`, `packages/executors/src/script-executor.ts`, `packages/executors/src/agent-executor.ts`, `packages/executors/src/registry.ts`
- Create: `packages/adapters/fake/package.json`, `packages/adapters/fake/tsconfig.json`, `packages/adapters/fake/vitest.config.ts`, `packages/adapters/fake/src/index.ts`, `packages/adapters/fake/src/fake-stage-script.ts`, `packages/adapters/fake/src/fake-agent-runtime.ts`, `packages/adapters/fake/src/fake-provider.ts`
- Test: `packages/executors/test/script-executor.test.ts`, `packages/executors/test/agent-executor.test.ts`, `packages/adapters/fake/test/fake-stage-script.test.ts`

**Interfaces:**
- Consumes: `Executor`, `ExecutorContext`, `AgentRuntime`, `StageRequest`, `StageResult`, `ExternalProvider`.
- Produces: `ScriptExecutor(commands: Record<string, string[]>)`, `AgentExecutor(runtime: AgentRuntime)`, `ExecutorRegistry { register(kind, executor); resolve(ref: ExecutorRef): Executor }`, `FAKE_STAGE_SCRIPT_PATH`, `fakeScriptCommands()`, `FakeAgentRuntime(opts: { provider?: ExternalProvider; journal?: JournalLike })`, `FakeProvider` với `dispatchCount`, `lostAfterDispatch: boolean`. Giao thức script: đọc `stage-request.json`, ghi `stage-result.json` trong cwd; exit code 0 khi có result hợp lệ, khác 0 = lỗi transient.
- Cờ mô phỏng đọc từ `request.stage_config`: `fail_transient_times` (số), `write_bad_checksum` (bool), `sleep_ms` (số), `content` (string), `lose_connection_after_dispatch` (bool, chỉ FakeAgentRuntime).

- [ ] **Step 1: Tạo hai package**

`packages/executors/package.json`:

```json
{
  "name": "@harness/executors", "version": "0.1.0", "type": "module",
  "main": "./dist/index.js", "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.json", "typecheck": "tsc -p tsconfig.json --noEmit" },
  "dependencies": { "@harness/contracts": "workspace:*", "@harness/core": "workspace:*" },
  "devDependencies": { "@harness/adapter-fake": "workspace:*" }
}
```

`packages/adapters/fake/package.json`:

```json
{
  "name": "@harness/adapter-fake", "version": "0.1.0", "type": "module",
  "main": "./dist/index.js", "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.json", "typecheck": "tsc -p tsconfig.json --noEmit" },
  "dependencies": { "@harness/contracts": "workspace:*" }
}
```

Cả hai `tsconfig.json` giống Task 4 (extends base, rootDir `src`, outDir `dist`, `composite: true`); `vitest.config.ts` giống Task 4. Thêm `"composite": true` vào `packages/core/tsconfig.json`. Chạy `pnpm install`.

Lưu ý build: test của `executors` chạy script giả bằng `tsx` trên file `.ts` nguồn để không cần build trước: lệnh là `[process.execPath, "--import", "tsx", FAKE_STAGE_SCRIPT_PATH]`. Ở CLI (Task 15) dùng cùng cách. `tsx` đã là devDependency root và hoist được.

- [ ] **Step 2: Viết test thất bại**

`packages/adapters/fake/test/fake-stage-script.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, StageResultSchema, type StageRequest } from "@harness/contracts";
import { FAKE_STAGE_SCRIPT_PATH } from "../src/index.js";

function run(stage_config: Record<string, unknown>, ws = mkdtempSync(join(tmpdir(), "fs-"))) {
  const attempt_id = newId("attempt");
  const request: StageRequest = {
    schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id, project_id: "p", portfolio_id: "pf",
    stage_key: "produce", workflow: { id: "w", version: "1.0.0", digest: "sha256:" + "a".repeat(64) }, profile_snapshot: { id: "cartoon", revision: 1 },
    inputs: [], workspace_uri: ws, stage_config, limits: { deadline_at: "2026-09-11T01:00:00.000Z", max_cost_usd: 5, max_attempts: 3 }, capabilities: [], fencing_token: 1,
  };
  mkdirSync(join(ws, "output"), { recursive: true });
  writeFileSync(join(ws, "stage-request.json"), JSON.stringify(request));
  const proc = spawnSync(process.execPath, ["--import", "tsx", FAKE_STAGE_SCRIPT_PATH], { cwd: ws, encoding: "utf8" });
  return { ws, proc, attempt_id };
}

describe("fake-stage-script", () => {
  it("writes an output and a valid stage-result.json", () => {
    const { ws, proc, attempt_id } = run({ content: "hello" });
    expect(proc.status, proc.stderr).toBe(0);
    const result = StageResultSchema.parse(JSON.parse(readFileSync(join(ws, "stage-result.json"), "utf8")));
    expect(result.attempt_id).toBe(attempt_id);
    expect(result.outcome).toBe("succeeded");
    expect(readFileSync(join(ws, result.outputs[0]!.path), "utf8")).toBe("hello");
  });
  it("fails transiently N times using a counter next to the workspace", () => {
    const parent = mkdtempSync(join(tmpdir(), "fs-"));
    const ws1 = join(parent, "attempt-1"); mkdirSync(ws1);
    const ws2 = join(parent, "attempt-2"); mkdirSync(ws2);
    const a = run({ fail_transient_times: 1 }, ws1);
    expect(a.proc.status).toBe(1);
    expect(existsSync(join(ws1, "stage-result.json"))).toBe(false);
    const b = run({ fail_transient_times: 1 }, ws2);
    expect(b.proc.status).toBe(0);
  });
  it("can declare a wrong checksum on purpose", () => {
    const { ws, proc } = run({ write_bad_checksum: true });
    expect(proc.status).toBe(0);
    const result = JSON.parse(readFileSync(join(ws, "stage-result.json"), "utf8"));
    expect(result.outputs[0].checksum).toBe("sha256:" + "0".repeat(64));
  });
});
```

`packages/executors/test/script-executor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessError, newId, type StageRequest } from "@harness/contracts";
import { fakeScriptCommands } from "@harness/adapter-fake";
import { ScriptExecutor } from "../src/script-executor.js";

const silent = { info() {}, warn() {}, error() {} };
function request(stage_config: Record<string, unknown>, ws = mkdtempSync(join(tmpdir(), "se-"))): StageRequest {
  mkdirSync(join(ws, "output"), { recursive: true });
  return {
    schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"), project_id: "p", portfolio_id: "pf",
    stage_key: "produce", workflow: { id: "w", version: "1.0.0", digest: "sha256:" + "a".repeat(64) }, profile_snapshot: { id: "cartoon", revision: 1 },
    inputs: [], workspace_uri: ws, stage_config, limits: { deadline_at: new Date(Date.now() + 60_000).toISOString(), max_cost_usd: 5, max_attempts: 3 }, capabilities: [], fencing_token: 1,
  };
}

describe("ScriptExecutor", () => {
  it("runs the registered script and parses stage-result.json", async () => {
    const ex = new ScriptExecutor(fakeScriptCommands());
    const req = request({ content: "abc" });
    const res = await ex.execute(req, { workspaceDir: req.workspace_uri, logger: silent });
    expect(res.outcome).toBe("succeeded");
    expect(res.attempt_id).toBe(req.attempt_id);
  });
  it("maps a non-zero exit to a transient failure result", async () => {
    const ex = new ScriptExecutor(fakeScriptCommands());
    const req = request({ fail_transient_times: 5 });
    const res = await ex.execute(req, { workspaceDir: req.workspace_uri, logger: silent });
    expect(res.outcome).toBe("failed");
    expect(res.errors[0]?.kind).toBe("transient");
  });
  it("kills the script at the deadline and reports EXECUTOR_TIMEOUT as transient", async () => {
    const ex = new ScriptExecutor(fakeScriptCommands());
    const req = { ...request({ sleep_ms: 5000 }), limits: { deadline_at: new Date(Date.now() + 500).toISOString(), max_cost_usd: 5, max_attempts: 3 } };
    const res = await ex.execute(req, { workspaceDir: req.workspace_uri, logger: silent });
    expect(res.outcome).toBe("failed");
    expect(res.errors[0]).toMatchObject({ kind: "transient", details: { code: "EXECUTOR_TIMEOUT" } });
  });
  it("throws NOT_FOUND for an unregistered script", async () => {
    const ex = new ScriptExecutor({});
    const req = request({});
    await ex.execute({ ...req }, { workspaceDir: req.workspace_uri, logger: silent }).catch((e) => expect(isHarnessError(e, "NOT_FOUND")).toBe(true));
  });
});
```

`packages/executors/test/agent-executor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type StageRequest } from "@harness/contracts";
import { FakeAgentRuntime } from "@harness/adapter-fake";
import { AgentExecutor } from "../src/agent-executor.js";
import { ExecutorRegistry } from "../src/registry.js";

const silent = { info() {}, warn() {}, error() {} };
function request(): StageRequest {
  const ws = mkdtempSync(join(tmpdir(), "ae-")); mkdirSync(join(ws, "output"));
  return {
    schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"), project_id: "p", portfolio_id: "pf",
    stage_key: "review", workflow: { id: "w", version: "1.0.0", digest: "sha256:" + "a".repeat(64) }, profile_snapshot: { id: "cartoon", revision: 1 },
    inputs: [], workspace_uri: ws, stage_config: {}, limits: { deadline_at: new Date(Date.now() + 60_000).toISOString(), max_cost_usd: 5, max_attempts: 3 }, capabilities: [], fencing_token: 1,
  };
}

describe("AgentExecutor + FakeAgentRuntime", () => {
  it("runs the skill brief through the runtime and writes an output", async () => {
    const ex = new AgentExecutor(new FakeAgentRuntime());
    const req = request();
    const res = await ex.execute(req, { workspaceDir: req.workspace_uri, logger: silent });
    expect(res.outcome).toBe("succeeded");
    expect(readFileSync(join(req.workspace_uri, res.outputs[0]!.path), "utf8")).toContain("fake-review");
  });
  it("registry resolves by executor ref type", () => {
    const reg = new ExecutorRegistry();
    const agent = new AgentExecutor(new FakeAgentRuntime());
    reg.register("agent", agent);
    expect(reg.resolve({ type: "agent", skill: "x", brief: "" })).toBe(agent);
    expect(() => reg.resolve({ type: "script", script: "x" })).toThrow(/no executor/);
  });
});
```

- [ ] **Step 3: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/executors packages/adapters/fake`
Expected: FAIL, thiếu module.

- [ ] **Step 4: Viết adapter giả**

`packages/adapters/fake/src/fake-stage-script.ts` (chạy như script độc lập với cwd = workspace):

```ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StageRequestSchema, type StageResult } from "@harness/contracts";

const ws = process.cwd();
const request = StageRequestSchema.parse(JSON.parse(readFileSync(join(ws, "stage-request.json"), "utf8")));
const cfg = request.stage_config as { fail_transient_times?: number; write_bad_checksum?: boolean; sleep_ms?: number; content?: string };

if (cfg.sleep_ms) { const end = Date.now() + cfg.sleep_ms; while (Date.now() < end) { /* busy wait keeps the script simple */ } }

// transient failures counted per stage across attempts: counter lives in the parent (stage) directory
const counterPath = join(dirname(ws), "fake-fail-count.json");
const failures = existsSync(counterPath) ? (JSON.parse(readFileSync(counterPath, "utf8")) as { n: number }).n : 0;
if ((cfg.fail_transient_times ?? 0) > failures) {
  writeFileSync(counterPath, JSON.stringify({ n: failures + 1 }));
  console.error(`fake-stage: simulated transient failure ${failures + 1}/${cfg.fail_transient_times}`);
  process.exit(1);
}

const inputSummary = request.inputs.map((i) => `${i.type}:${readFileSync(join(ws, i.path), "utf8").length}`).join(",");
const content = `${cfg.content ?? "fake output"} [stage=${request.stage_key} inputs=${inputSummary}]`;
mkdirSync(join(ws, "output"), { recursive: true });
writeFileSync(join(ws, "output", "result.txt"), content);
const checksum = cfg.write_bad_checksum ? "sha256:" + "0".repeat(64) : `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
const outputType = (request.stage_config.output_type as string | undefined) ?? (request.stage_key === "finalize" ? "final_text" : "script_text");

const result: StageResult = {
  schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outcome: "succeeded",
  outputs: [{ path: "output/result.txt", type: outputType, checksum, size_bytes: Buffer.byteLength(content, "utf8") }],
  checks: [], usage: { wall_seconds: (cfg.sleep_ms ?? 0) / 1000, cost_usd: 0.01 }, external_operations: [], errors: [],
};
writeFileSync(join(ws, "stage-result.json"), JSON.stringify(result, null, 2));
```

`packages/adapters/fake/src/fake-provider.ts`:

```ts
import { HarnessError, type ExternalOperation, type ExternalProvider } from "@harness/contracts";

export class FakeProvider implements ExternalProvider {
  readonly name = "fake-provider";
  dispatchCount = 0;
  lostAfterDispatch = false;
  private readonly receipts = new Map<string, { provider_ref: string; receipt: Record<string, unknown> }>();

  async dispatch(op: ExternalOperation, payload: Record<string, unknown>) {
    this.dispatchCount += 1;
    const r = { provider_ref: `fake-${this.dispatchCount}`, receipt: { accepted_at: new Date().toISOString(), payload } };
    this.receipts.set(op.idempotency_key, r);
    if (this.lostAfterDispatch) throw new HarnessError("CONNECTION_LOST", "connection lost after dispatch", { operation_id: op.operation_id });
    return r;
  }
  async lookup(idempotencyKey: string) {
    const r = this.receipts.get(idempotencyKey);
    return r ? { found: true, ...r } : { found: false };
  }
}
```

`packages/adapters/fake/src/fake-agent-runtime.ts`:

```ts
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isHarnessError, type AgentRuntime, type AgentTask, type ExecutorContext, type ExternalOperation, type StageResult } from "@harness/contracts";

/** Minimal journal contract the runtime needs; implemented by core's ExternalOperationJournal (Task 14). */
export interface JournalLike {
  recordIntent(p: { request: AgentTask["request"]; provider: string; kind: string; target: string; payload: Record<string, unknown> }): ExternalOperation;
  dispatch(op: ExternalOperation, payload: Record<string, unknown>): Promise<ExternalOperation>;
  findConfirmedByKey(key: string): ExternalOperation | undefined;
  keyFor(p: { kind: string; target: string; payload: Record<string, unknown> }): string;
}

export class FakeAgentRuntime implements AgentRuntime {
  readonly name = "fake";
  readonly version = "0.1.0";
  constructor(private readonly opts: { journal?: JournalLike } = {}) {}

  async runTask(task: AgentTask, ctx: ExecutorContext): Promise<StageResult> {
    const { request } = task;
    const externalOps: string[] = [];
    const cfg = request.stage_config as { external_operation?: boolean };
    if (cfg.external_operation && this.opts.journal) {
      const j = this.opts.journal;
      const payload = { skill: task.skill, stage_run_id: request.stage_run_id };
      const existing = j.findConfirmedByKey(j.keyFor({ kind: "fake-publish", target: request.stage_key, payload }));
      if (existing) {
        externalOps.push(existing.operation_id);
        ctx.logger.info("reusing confirmed external operation", { operation_id: existing.operation_id });
      } else {
        const intent = j.recordIntent({ request, provider: "fake-provider", kind: "fake-publish", target: request.stage_key, payload });
        try {
          const done = await j.dispatch(intent, payload);
          externalOps.push(done.operation_id);
        } catch (e) {
          if (isHarnessError(e, "CONNECTION_LOST")) {
            return { schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outcome: "unknown", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [intent.operation_id], errors: [{ kind: "unknown", message: e.message, details: { operation_id: intent.operation_id } }] };
          }
          throw e;
        }
      }
    }
    const content = `notes from ${task.skill}: ${task.brief} | inputs=${request.inputs.map((i) => i.type).join(",")}`;
    mkdirSync(join(task.workspaceDir, "output"), { recursive: true });
    writeFileSync(join(task.workspaceDir, "output", "notes.txt"), content);
    return {
      schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outcome: "succeeded",
      outputs: [{ path: "output/notes.txt", type: "review_notes", checksum: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`, size_bytes: Buffer.byteLength(content, "utf8") }],
      checks: [], usage: { wall_seconds: 0.1, cost_usd: 0.02 }, external_operations: externalOps, errors: [],
    };
  }
}
```

`packages/adapters/fake/src/index.ts`:

```ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export { FakeAgentRuntime, type JournalLike } from "./fake-agent-runtime.js";
export { FakeProvider } from "./fake-provider.js";

export const FAKE_STAGE_SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "fake-stage-script.ts");
/** Script registry entries for the composition root: name -> argv. Uses tsx so no build is required. */
export function fakeScriptCommands(): Record<string, string[]> {
  return { "fake-stage": [process.execPath, "--import", "tsx", FAKE_STAGE_SCRIPT_PATH] };
}
```

Khi package được build ra `dist/`, `FAKE_STAGE_SCRIPT_PATH` trỏ tới `dist/fake-stage-script.ts` không tồn tại. Xử lý: trong `index.ts` kiểm tra `existsSync` của `.ts`; nếu không có thì dùng `.js` cùng thư mục và bỏ `--import tsx`:

```ts
import { existsSync } from "node:fs";
const here = dirname(fileURLToPath(import.meta.url));
export const FAKE_STAGE_SCRIPT_PATH = existsSync(join(here, "fake-stage-script.ts")) ? join(here, "fake-stage-script.ts") : join(here, "fake-stage-script.js");
export function fakeScriptCommands(): Record<string, string[]> {
  return { "fake-stage": FAKE_STAGE_SCRIPT_PATH.endsWith(".ts") ? [process.execPath, "--import", "tsx", FAKE_STAGE_SCRIPT_PATH] : [process.execPath, FAKE_STAGE_SCRIPT_PATH] };
}
```

- [ ] **Step 5: Viết executors**

`packages/executors/src/script-executor.ts`:

```ts
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessError, StageResultSchema, type Executor, type ExecutorContext, type StageRequest, type StageResult } from "@harness/contracts";

export class ScriptExecutor implements Executor {
  readonly version = "script-executor@0.1.0";
  constructor(private readonly commands: Record<string, string[]>) {}

  async execute(request: StageRequest, ctx: ExecutorContext): Promise<StageResult> {
    if (request.stage_config.__executor_script === undefined && !("script" in request.stage_config)) { /* script name comes from stage_config.__script (set by worker) */ }
    const name = String(request.stage_config.__script ?? "");
    const argv = this.commands[name];
    if (!argv || argv.length === 0) throw new HarnessError("NOT_FOUND", `no script registered for "${name}"`, { script: name });
    writeFileSync(join(ctx.workspaceDir, "stage-request.json"), JSON.stringify(request, null, 2));
    const timeoutMs = Math.max(1, Date.parse(request.limits.deadline_at) - Date.now());
    const failed = (kind: "transient" | "result", message: string, details: Record<string, unknown>): StageResult => ({
      schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outcome: "failed", outputs: [], checks: [],
      usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [{ kind, message, details }],
    });
    const started = Date.now();
    const { code, timedOut, stderr } = await new Promise<{ code: number | null; timedOut: boolean; stderr: string }>((resolve) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd: ctx.workspaceDir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HARNESS_STAGE_KEY: request.stage_key } });
      let stderr = ""; let timedOut = false;
      child.stdout.on("data", (d) => ctx.logger.info(String(d).trimEnd(), { stream: "stdout" }));
      child.stderr.on("data", (d) => { stderr += String(d); ctx.logger.warn(String(d).trimEnd(), { stream: "stderr" }); });
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
      ctx.signal?.addEventListener("abort", () => child.kill());
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, timedOut, stderr }); });
    });
    writeFileSync(join(ctx.workspaceDir, "logs", "script-stderr.log"), stderr);
    if (timedOut) return failed("transient", "script exceeded deadline", { code: "EXECUTOR_TIMEOUT", timeout_ms: timeoutMs });
    if (code !== 0) return failed("transient", `script exited with code ${code}`, { code: "EXECUTOR_FAILED", exit_code: code });
    const resultPath = join(ctx.workspaceDir, "stage-result.json");
    if (!existsSync(resultPath)) return failed("result", "script exited 0 but wrote no stage-result.json", { code: "SCHEMA_INVALID" });
    const parsed = StageResultSchema.safeParse(JSON.parse(readFileSync(resultPath, "utf8")));
    if (!parsed.success) return { ...failed("result", "stage-result.json failed schema validation", { code: "SCHEMA_INVALID", issues: parsed.error.issues }), errors: [{ kind: "contract", message: "stage-result.json failed schema validation", details: { issues: parsed.error.issues } }] };
    return { ...parsed.data, usage: { ...parsed.data.usage, wall_seconds: parsed.data.usage.wall_seconds || (Date.now() - started) / 1000 } };
  }
}
```

Bỏ dòng `if (request.stage_config.__executor_script === undefined ...) {}` (dòng rỗng để nhắc quy ước; không cần trong code). Quy ước: worker (Task 13) đặt `stage_config.__script = executor.script` trước khi gọi executor, để `StageRequest` tự đủ thông tin cho script.

`packages/executors/src/agent-executor.ts`:

```ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRuntime, Executor, ExecutorContext, StageRequest, StageResult } from "@harness/contracts";

export class AgentExecutor implements Executor {
  readonly version: string;
  constructor(private readonly runtime: AgentRuntime) { this.version = `agent-executor@0.1.0+${runtime.name}@${runtime.version}`; }
  async execute(request: StageRequest, ctx: ExecutorContext): Promise<StageResult> {
    writeFileSync(join(ctx.workspaceDir, "stage-request.json"), JSON.stringify(request, null, 2));
    const skill = String(request.stage_config.__skill ?? "");
    const brief = String(request.stage_config.__brief ?? "");
    const result = await this.runtime.runTask({ skill, brief, request, workspaceDir: ctx.workspaceDir }, ctx);
    writeFileSync(join(ctx.workspaceDir, "stage-result.json"), JSON.stringify(result, null, 2));
    return result;
  }
}
```

`packages/executors/src/registry.ts`:

```ts
import { HarnessError, type Executor, type ExecutorRef } from "@harness/contracts";

export class ExecutorRegistry {
  private readonly byKind = new Map<ExecutorRef["type"], Executor>();
  register(kind: ExecutorRef["type"], executor: Executor): void { this.byKind.set(kind, executor); }
  resolve(ref: ExecutorRef): Executor {
    const ex = this.byKind.get(ref.type);
    if (!ex) throw new HarnessError("NOT_FOUND", `no executor registered for kind "${ref.type}"`, { kind: ref.type });
    return ex;
  }
}
```

`packages/executors/src/index.ts`:

```ts
export * from "./script-executor.js";
export * from "./agent-executor.js";
export * from "./registry.js";
```

Trong test `script-executor.test.ts`, hàm `request()` phải đặt `stage_config.__script = "fake-stage"`: sửa `request(stage_config)` thành `stage_config: { __script: "fake-stage", ...stage_config }`. Trong `agent-executor.test.ts` thêm `stage_config: { __skill: "fake-review", __brief: "review it" }`.

- [ ] **Step 6: Chạy test, xác nhận pass**

Run: `pnpm vitest run packages/executors packages/adapters/fake && pnpm -r typecheck`
Expected: PASS toàn bộ (test timeout script 5 giây được bảo vệ bởi `testTimeout: 20000`).

- [ ] **Step 7: Commit**

```bash
git add packages/executors packages/adapters pnpm-lock.yaml packages/core/tsconfig.json
git commit -m "feat(executors): add script/agent executors, registry and fake adapters with failure simulation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 12: Controller commit với fencing, phân loại lỗi, retry/backoff và artifact ACCEPTED/REJECTED

**Files:**
- Create: `packages/core/src/orchestration/controller.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/test/helpers.ts`
- Test: `packages/core/test/orchestration/controller.test.ts`

**Interfaces:**
- Consumes: `ArtifactRegistry`, `Planner.advance`, `VerifyOutcome`, `eventFor`, `store.assertFencing`, `addSeconds`.
- Produces: `class Controller { constructor(deps: { store; registry: ArtifactRegistry; planner: Planner; clock: Clock }); commit(p: CommitParams): Promise<CommitOutcome> }`, `CommitParams = { stageRun, attempt, fencingToken, request, result, verify, workspaceDir, executorVersion, inputArtifactIds, mimeTypes }`, `CommitOutcome = { stageState, runState, attemptState, artifacts: Artifact[], failureKind?: FailureKind, retryScheduled: boolean }`, `classifyFailure(result, verify): FailureKind | null`. Helper test `beginAttempt(store, claim)`.

Quy tắc phân loại (spec B.9):

| Điều kiện | `failureKind` | Attempt | StageRun | Retry |
|---|---|---|---|---|
| `outcome=succeeded` và mọi required check pass | null | SUCCEEDED | RUNNING→VERIFYING→SUCCEEDED | không |
| `verify.missing` khác rỗng, hoặc check `schema-valid` fail, hoặc `errors[].kind=contract` | contract | FAILED | RUNNING→VERIFYING→WAITING_HUMAN | không |
| `outcome=unknown` | unknown | FAILED | RUNNING→WAITING_EXTERNAL→NEEDS_RECONCILIATION | không (reconcile trước) |
| `outcome=failed` với `errors[0].kind=transient` | transient | FAILED | RUNNING→FAILED | theo policy |
| còn lại (check fail, outcome failed kind result, deferred) | result | FAILED | RUNNING→VERIFYING→FAILED, artifact REJECTED | theo policy, tăng `result_failures` |

Retry cho phép khi `retry.retry_on` chứa kind và `attempt_count < max_attempts`; khi đó FAILED→READY với `not_before = now + backoff_seconds[min(attempt_count-1, len-1)]`.

- [ ] **Step 1: Thêm helper và viết test thất bại**

Thêm vào `packages/core/test/helpers.ts`:

```ts
import type { ClaimResult } from "@harness/contracts";
export function beginAttempt(store: SqliteStateStore, c: ClaimResult) {
  const ev = { run_id: c.stageRun.run_id, stage_run_id: c.stageRun.stage_run_id, attempt_id: c.attempt.attempt_id, project_id: "project-main", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info" as const, event_type: "attempt.started", payload: {} };
  store.transaction(() => {
    store.transition("attempt", c.attempt.attempt_id, "CLAIMED", "RUNNING", ev);
    store.transition("stage_run", c.stageRun.stage_run_id, "CLAIMED", "RUNNING", ev);
  });
  return { stageRun: store.getStageRun(c.stageRun.stage_run_id)!, attempt: store.getAttempt(c.attempt.attempt_id)! };
}
```

`packages/core/test/orchestration/controller.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isHarnessError, type StageRequest, type StageResult } from "@harness/contracts";
import { ArtifactRegistry, Controller, Planner, HARNESS_ROOT, loadHarnessConfig, loadProfile, loadWorkflow, sha256String, createWorkspace, Verifier, BUILTIN_CHECKERS } from "../../src/index.js";
import { beginAttempt, openTempStore } from "../helpers.js";

async function setup(retry: { backoff_seconds?: number[]; max_attempts?: number } = {}) {
  const t = openTempStore();
  const planner = new Planner(t.store);
  const wf = loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0");
  const run = planner.plan({ workflow: wf, profile: loadProfile(HARNESS_ROOT, "cartoon"), harness: loadHarnessConfig(HARNESS_ROOT), projectId: "project-main", portfolioId: "portfolio-main" });
  planner.enqueue(run.run_id);
  for (const s of t.store.listStageRuns(run.run_id)) t.store.updateStageRun({ ...s, retry: { ...s.retry, ...retry, retry_on: ["transient", "abandoned", "result"] } });
  const claim = t.store.claim({ owner: "w1", capabilities: ["write_workspace"], now: t.clock.now(), leaseSeconds: 90 })!;
  const { stageRun, attempt } = beginAttempt(t.store, claim);
  const ws = await createWorkspace(t.dir, run.run_id, stageRun.stage_key, attempt.attempt_id);
  const registry = new ArtifactRegistry(t.store, t.dir);
  const controller = new Controller({ store: t.store, registry, planner, clock: t.clock });
  const request: StageRequest = {
    schema_version: "harness.stage-request/v1", run_id: run.run_id, stage_run_id: stageRun.stage_run_id, attempt_id: attempt.attempt_id, project_id: "project-main", portfolio_id: "portfolio-main",
    stage_key: stageRun.stage_key, workflow: run.workflow_release, profile_snapshot: run.profile_snapshot, inputs: [], workspace_uri: ws, stage_config: {},
    limits: { deadline_at: "2026-09-11T01:00:00.000Z", max_cost_usd: 5, max_attempts: 3 }, capabilities: ["write_workspace"], fencing_token: claim.lease.fencing_token,
  };
  const write = (content: string, checksum = sha256String(content)): StageResult => {
    writeFileSync(join(ws, "output", "result.txt"), content);
    return { schema_version: "harness.stage-result/v1", attempt_id: attempt.attempt_id, outcome: "succeeded", outputs: [{ path: "output/result.txt", type: "script_text", checksum, size_bytes: content.length }], checks: [], usage: { wall_seconds: 1, cost_usd: 0.5 }, external_operations: [], errors: [] };
  };
  const verifier = new Verifier(BUILTIN_CHECKERS);
  const commit = async (result: StageResult, token = claim.lease.fencing_token) =>
    controller.commit({ stageRun: t.store.getStageRun(stageRun.stage_run_id)!, attempt, fencingToken: token, request, result, verify: await verifier.verify({ request, result, workspaceDir: ws }, stageRun.required_checks), workspaceDir: ws, executorVersion: "fake@0.1.0", inputArtifactIds: [], mimeTypes: { script_text: "text/plain" } });
  return { ...t, run, stageRun, attempt, claim, ws, write, commit };
}

describe("Controller.commit", () => {
  it("success: ACCEPTED artifact, stage/attempt SUCCEEDED, lease released, cost added, dependants released", async () => {
    const { store, run, stageRun, attempt, write, commit } = await setup();
    const out = await commit(write("hello"));
    expect(out).toMatchObject({ stageState: "SUCCEEDED", attemptState: "SUCCEEDED", runState: "RUNNING", retryScheduled: false });
    expect(out.artifacts[0]?.status).toBe("ACCEPTED");
    expect(store.getLease(stageRun.stage_run_id)).toBeUndefined();
    expect(store.getRun(run.run_id)?.total_cost_usd).toBe(0.5);
    expect(store.listStageRuns(run.run_id).find((s) => s.stage_key === "review")?.state).toBe("READY");
    expect(store.listCheckResults(attempt.attempt_id).map((c) => c.verdict)).toEqual(["pass", "pass", "pass"]);
  });
  it("result failure: checksum mismatch rejects the artifact and schedules a retry with backoff", async () => {
    const { store, stageRun, clock, write, commit } = await setup({ backoff_seconds: [30] });
    const out = await commit(write("hello", sha256String("wrong")));
    expect(out).toMatchObject({ failureKind: "result", attemptState: "FAILED", stageState: "READY", retryScheduled: true });
    expect(out.artifacts[0]?.status).toBe("REJECTED");
    const s = store.getStageRun(stageRun.stage_run_id)!;
    expect(s.result_failures).toBe(1);
    expect(Date.parse(s.not_before!) - Date.parse(clock.now())).toBe(30_000);
    expect(store.listArtifacts({ stage_run_id: s.stage_run_id, status: "ACCEPTED" })).toHaveLength(0);
  });
  it("transient failure with retries exhausted fails the stage and the run", async () => {
    const { store, run, attempt, commit } = await setup({ max_attempts: 1 });
    const result: StageResult = { schema_version: "harness.stage-result/v1", attempt_id: attempt.attempt_id, outcome: "failed", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [{ kind: "transient", message: "boom", details: {} }] };
    const out = await commit(result);
    expect(out).toMatchObject({ failureKind: "transient", stageState: "FAILED", runState: "FAILED", retryScheduled: false });
    expect(store.getRun(run.run_id)?.state).toBe("FAILED");
  });
  it("contract failure (attempt_id mismatch) parks the stage for a human and the run WAITING", async () => {
    const { store, run, write, commit } = await setup();
    const out = await commit({ ...write("hello"), attempt_id: "attempt_01J00000000000000000000000" });
    expect(out).toMatchObject({ failureKind: "contract", stageState: "WAITING_HUMAN", runState: "WAITING", retryScheduled: false });
    expect(store.listEvents({ run_id: run.run_id }).some((e) => e.event_type === "stage.waiting_human")).toBe(true);
  });
  it("unknown outcome moves the stage to NEEDS_RECONCILIATION without retry", async () => {
    const { attempt, commit } = await setup();
    const result: StageResult = { schema_version: "harness.stage-result/v1", attempt_id: attempt.attempt_id, outcome: "unknown", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [{ kind: "unknown", message: "lost", details: {} }] };
    expect(await commit(result)).toMatchObject({ failureKind: "unknown", stageState: "NEEDS_RECONCILIATION", runState: "WAITING", retryScheduled: false });
  });
  it("rejects a stale fencing token and writes nothing", async () => {
    const { store, stageRun, clock, write, commit } = await setup();
    clock.advance(91);
    store.reapExpiredLeases(clock.now());
    await commit(write("hello")).then(() => { throw new Error("no throw"); }, (e) => expect(isHarnessError(e, "FENCING_REJECTED")).toBe(true));
    expect(store.listArtifacts({ stage_run_id: stageRun.stage_run_id })).toHaveLength(0);
    expect(store.getStageRun(stageRun.stage_run_id)?.state).toBe("READY");
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/core/test/orchestration/controller.test.ts`
Expected: FAIL, thiếu `Controller`.

- [ ] **Step 3: Viết `controller.ts`**

`packages/core/src/orchestration/controller.ts`:

```ts
import { isHarnessError, newId, type Artifact, type Attempt, type Clock, type FailureKind, type StageRequest, type StageResult, type StageRun, type StateStore } from "@harness/contracts";
import { ArtifactRegistry, type ArtifactContext } from "../artifacts/registry.js";
import { addSeconds } from "../state/clock.js";
import type { VerifyOutcome } from "../verification/verifier.js";
import { eventFor, Planner } from "./planner.js";

export interface CommitParams {
  stageRun: StageRun; attempt: Attempt; fencingToken: number; request: StageRequest; result: StageResult; verify: VerifyOutcome;
  workspaceDir: string; executorVersion: string; inputArtifactIds: string[]; mimeTypes: Record<string, string>;
}
export interface CommitOutcome { stageState: string; runState: string; attemptState: string; artifacts: Artifact[]; failureKind?: FailureKind; retryScheduled: boolean }

export function classifyFailure(result: StageResult, verify: VerifyOutcome): FailureKind | null {
  if (result.outcome === "succeeded" && verify.allRequiredPassed) return null;
  if (verify.missing.length > 0) return "contract";
  if (verify.results.some((r) => r.check_id === "schema-valid" && r.verdict === "fail")) return "contract";
  if (result.errors.some((e) => e.kind === "contract")) return "contract";
  if (result.outcome === "unknown") return "unknown";
  if (result.outcome === "failed" && result.errors[0]?.kind === "transient") return "transient";
  return "result";
}

export class Controller {
  constructor(private readonly deps: { store: StateStore; registry: ArtifactRegistry; planner: Planner; clock: Clock }) {}

  async commit(p: CommitParams): Promise<CommitOutcome> {
    const { store, registry, planner, clock } = this.deps;
    store.assertFencing(p.stageRun.stage_run_id, p.fencingToken);
    const run = store.getRun(p.stageRun.run_id)!;
    const ctx: ArtifactContext = { run, stageRun: p.stageRun, attempt: p.attempt, executorVersion: p.executorVersion, inputArtifactIds: p.inputArtifactIds, checkResultIds: [] };
    let kind = classifyFailure(p.result, p.verify);

    // Async phase (no DB writes): move verified outputs into the artifact store.
    let staged: Awaited<ReturnType<ArtifactRegistry["stageOutputs"]>> = [];
    if (kind === null) {
      try { staged = await registry.stageOutputs({ workspaceDir: p.workspaceDir, outputs: p.result.outputs, mimeTypes: p.mimeTypes, ctx }); }
      catch (e) { if (isHarnessError(e, "CHECKSUM_MISMATCH") || isHarnessError(e, "IO_ERROR")) kind = "result"; else throw e; }
    }

    return store.transaction(() => {
      store.assertFencing(p.stageRun.stage_run_id, p.fencingToken);
      const now = clock.now();
      const stage = store.getStageRun(p.stageRun.stage_run_id)!;
      const attempt = store.getAttempt(p.attempt.attempt_id)!;
      const ev = (type: string, severity: "info" | "warn" | "error" = "info", payload: Record<string, unknown> = {}) => eventFor(run, stage, attempt, type, severity, payload);

      // check results are always recorded
      for (const r of p.verify.results) {
        const id = newId("check_result");
        store.insertCheckResult({ schema_version: "harness.check-result/v1", check_result_id: id, check_id: r.check_id, checker_version: r.checker_version, attempt_id: attempt.attempt_id, artifact_id: null, verdict: r.verdict, evidence: r.evidence, created_at: now });
        ctx.checkResultIds.push(id);
      }
      store.updateRun({ ...store.getRun(run.run_id)!, total_cost_usd: run.total_cost_usd + p.result.usage.cost_usd });

      let artifacts: Artifact[] = [];
      let retryScheduled = false;

      if (kind === null) {
        store.transition("stage_run", stage.stage_run_id, "RUNNING", "VERIFYING", ev("stage.verifying"));
        artifacts = registry.commitAccepted(staged.map((s) => ({ ...s, artifact: { ...s.artifact, checks: ctx.checkResultIds } })), ctx);
        store.transition("attempt", attempt.attempt_id, "RUNNING", "SUCCEEDED", ev("attempt.succeeded", "info", { cost_usd: p.result.usage.cost_usd }));
        store.updateAttempt({ ...store.getAttempt(attempt.attempt_id)!, finished_at: now });
        store.transition("stage_run", stage.stage_run_id, "VERIFYING", "SUCCEEDED", ev("stage.succeeded", "info", { artifacts: artifacts.map((a) => a.artifact_id) }));
      } else if (kind === "unknown") {
        this.failAttempt(attempt, kind, p.result, now);
        store.transition("stage_run", stage.stage_run_id, "RUNNING", "WAITING_EXTERNAL", ev("stage.waiting_external", "warn"));
        store.transition("stage_run", stage.stage_run_id, "WAITING_EXTERNAL", "NEEDS_RECONCILIATION", ev("stage.needs_reconciliation", "warn", { external_operations: p.result.external_operations }));
      } else if (kind === "contract") {
        this.failAttempt(attempt, kind, p.result, now);
        store.transition("stage_run", stage.stage_run_id, "RUNNING", "VERIFYING", ev("stage.verifying"));
        store.transition("stage_run", stage.stage_run_id, "VERIFYING", "WAITING_HUMAN", ev("stage.waiting_human", "error", { missing_checks: p.verify.missing, errors: p.result.errors }));
      } else {
        this.failAttempt(attempt, kind, p.result, now);
        if (kind === "result") {
          store.transition("stage_run", stage.stage_run_id, "RUNNING", "VERIFYING", ev("stage.verifying"));
          artifacts = registry.registerRejected({ workspaceDir: p.workspaceDir, outputs: p.result.outputs, ctx, reason: "verification failed" });
          store.transition("stage_run", stage.stage_run_id, "VERIFYING", "FAILED", ev("stage.failed", "error", { kind, checks: p.verify.results.filter((r) => r.verdict !== "pass") }));
          const s = store.getStageRun(stage.stage_run_id)!;
          store.updateStageRun({ ...s, result_failures: s.result_failures + 1 });
        } else {
          store.transition("stage_run", stage.stage_run_id, "RUNNING", "FAILED", ev("stage.failed", "error", { kind, errors: p.result.errors }));
        }
        retryScheduled = this.scheduleRetry(store.getStageRun(stage.stage_run_id)!, kind, now);
      }

      store.releaseLease(stage.stage_run_id, p.fencingToken);
      const { runState } = planner.advance(run.run_id);
      const outcome: CommitOutcome = { stageState: store.getStageRun(stage.stage_run_id)!.state, runState, attemptState: store.getAttempt(attempt.attempt_id)!.state, artifacts, retryScheduled };
      return kind ? { ...outcome, failureKind: kind } : outcome;
    });
  }

  private failAttempt(attempt: Attempt, kind: FailureKind, result: StageResult, now: string): void {
    const { store } = this.deps;
    const run = store.getRun(attempt.run_id)!;
    const stage = store.getStageRun(attempt.stage_run_id)!;
    store.transition("attempt", attempt.attempt_id, "RUNNING", "FAILED", eventFor(run, stage, attempt, "attempt.failed", "error", { kind, errors: result.errors }));
    store.updateAttempt({ ...store.getAttempt(attempt.attempt_id)!, finished_at: now, failure_kind: kind, error_summary: result.errors[0]?.message ?? `${kind} failure` });
  }

  private scheduleRetry(stage: StageRun, kind: FailureKind, now: string): boolean {
    const { store } = this.deps;
    if (!stage.retry.retry_on.includes(kind) || stage.attempt_count >= stage.retry.max_attempts) return false;
    const run = store.getRun(stage.run_id)!;
    const backoff = stage.retry.backoff_seconds[Math.min(stage.attempt_count - 1, stage.retry.backoff_seconds.length - 1)] ?? 0;
    store.transition("stage_run", stage.stage_run_id, "FAILED", "READY", eventFor(run, stage, null, "stage.retry_scheduled", "warn", { kind, backoff_seconds: backoff, attempt_count: stage.attempt_count }));
    const fresh = store.getStageRun(stage.stage_run_id)!;
    store.updateStageRun({ ...fresh, last_failure_kind: kind, ready_at: now, not_before: addSeconds(now, backoff) });
    return true;
  }
}
```

Thêm vào `packages/core/src/index.ts`: `export * from "./orchestration/controller.js";`

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `pnpm vitest run packages/core && pnpm --filter @harness/core typecheck`
Expected: PASS toàn bộ.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): add controller commit with fencing, failure classification, retry backoff and artifact acceptance

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Worker loop với heartbeat, `--once`, hủy khi nhận tín hiệu

**Files:**
- Create: `packages/worker/package.json`, `packages/worker/tsconfig.json`, `packages/worker/vitest.config.ts`, `packages/worker/src/index.ts`, `packages/worker/src/heartbeat.ts`, `packages/worker/src/worker.ts`
- Test: `packages/worker/test/worker.test.ts`

**Interfaces:**
- Consumes: `SqliteStateStore`, `Planner`, `Controller`, `ArtifactRegistry`, `Verifier`, `ExecutorRegistry`, `createWorkspace`, `materializeInputs`, `acceptedInputsFor`, `HarnessLogger`.
- Produces: `startHeartbeat(opts): HeartbeatHandle { stop(): void; readonly lost: boolean }`, `class Worker { constructor(deps: WorkerDeps); runOnce(): Promise<"idle" | "done" | "lost">; runForever(signal: AbortSignal): Promise<void> }`, `WorkerDeps = { store, planner, controller, registry, verifier, executors, harness: HarnessConfig, project: ProjectConfig, dataRoot, owner, capabilities, logger, clock }`.

- [ ] **Step 1: Tạo package worker**

`packages/worker/package.json`:

```json
{
  "name": "@harness/worker", "version": "0.1.0", "type": "module",
  "main": "./dist/index.js", "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.json", "typecheck": "tsc -p tsconfig.json --noEmit" },
  "dependencies": { "@harness/contracts": "workspace:*", "@harness/core": "workspace:*", "@harness/executors": "workspace:*" },
  "devDependencies": { "@harness/adapter-fake": "workspace:*" }
}
```

`tsconfig.json`, `vitest.config.ts` như Task 4 (thêm `composite: true`; `testTimeout: 30000`). Thêm `composite: true` vào `packages/executors/tsconfig.json`. `pnpm install`.

- [ ] **Step 2: Viết test thất bại**

`packages/worker/test/worker.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectConfigSchema, type Executor, type StageResult } from "@harness/contracts";
import { ArtifactRegistry, BUILTIN_CHECKERS, Controller, FixedClock, HARNESS_ROOT, MIGRATIONS_DIR, Planner, Redactor, SqliteStateStore, Verifier, createLogger, loadHarnessConfig, loadProfile, loadWorkflow } from "@harness/core";
import { AgentExecutor, ExecutorRegistry, ScriptExecutor } from "@harness/executors";
import { FakeAgentRuntime, fakeScriptCommands } from "@harness/adapter-fake";
import { Worker } from "../src/worker.js";

function makeWorld(opts: { scriptExecutor?: Executor; owner?: string; clock?: FixedClock; dir?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "wk-"));
  const clock = opts.clock ?? new FixedClock("2026-09-11T00:00:00.000Z");
  const store = new SqliteStateStore(join(dir, "state.db"), clock);
  store.migrate(MIGRATIONS_DIR);
  const planner = new Planner(store);
  const registry = new ArtifactRegistry(store, dir);
  const controller = new Controller({ store, registry, planner, clock });
  const executors = new ExecutorRegistry();
  executors.register("script", opts.scriptExecutor ?? new ScriptExecutor(fakeScriptCommands()));
  executors.register("agent", new AgentExecutor(new FakeAgentRuntime()));
  const harness = loadHarnessConfig(HARNESS_ROOT);
  const project = ProjectConfigSchema.parse({ schema_version: "harness.project/v1", project_id: "project-main", template_release: "0.1.0", runtime: "claude", data_root: dir, portfolios: [{ portfolio_id: "portfolio-main", display_name: "Main" }] });
  const logger = createLogger({ redactor: new Redactor(() => []), sink: () => {}, level: "error" });
  const worker = new Worker({ store, planner, controller, registry, verifier: new Verifier(BUILTIN_CHECKERS), executors, harness, project, dataRoot: dir, owner: opts.owner ?? "w1", capabilities: ["write_workspace", "read_source"], logger, clock });
  return { dir, clock, store, planner, worker };
}
function planAndEnqueue(w: ReturnType<typeof makeWorld>, stageOverrides: Record<string, Record<string, unknown>> = {}) {
  const run = w.planner.plan({ workflow: loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0"), profile: loadProfile(HARNESS_ROOT, "cartoon"), harness: loadHarnessConfig(HARNESS_ROOT), projectId: "project-main", portfolioId: "portfolio-main" });
  for (const s of w.store.listStageRuns(run.run_id)) {
    const extra = stageOverrides[s.stage_key];
    w.store.updateStageRun({ ...s, retry: { ...s.retry, backoff_seconds: [0, 0, 0] }, ...(extra ? { stage_config: { ...s.stage_config, ...extra } } : {}) });
  }
  w.planner.enqueue(run.run_id);
  return run;
}
async function drain(w: ReturnType<typeof makeWorld>, max = 20) {
  for (let i = 0; i < max; i++) { if ((await w.worker.runOnce()) === "idle") return i; }
  throw new Error("did not drain");
}

describe("Worker", () => {
  it("runs the sample workflow end to end with fake adapters", async () => {
    const w = makeWorld();
    const run = planAndEnqueue(w);
    await drain(w);
    expect(w.store.getRun(run.run_id)?.state).toBe("SUCCEEDED");
    const stages = w.store.listStageRuns(run.run_id);
    expect(stages.map((s) => s.state)).toEqual(["SUCCEEDED", "SUCCEEDED", "SUCCEEDED"]);
    const finalize = stages.find((s) => s.stage_key === "finalize")!;
    const [art] = w.store.listArtifacts({ stage_run_id: finalize.stage_run_id, status: "ACCEPTED" });
    expect(art?.lineage.input_artifacts).toHaveLength(2);
    expect(art?.type).toBe("final_text");
    expect(w.store.getRun(run.run_id)?.total_cost_usd).toBeCloseTo(0.04, 5);
  });
  it("retries a transient failure with a new attempt and workspace", async () => {
    const w = makeWorld();
    const run = planAndEnqueue(w, { produce: { fail_transient_times: 1 } });
    await drain(w);
    const produce = w.store.listStageRuns(run.run_id).find((s) => s.stage_key === "produce")!;
    expect(produce.state).toBe("SUCCEEDED");
    expect(produce.attempt_count).toBe(2);
    const attempts = w.store.listAttempts(produce.stage_run_id);
    expect(attempts.map((a) => a.state)).toEqual(["FAILED", "SUCCEEDED"]);
    expect(attempts[0]!.workspace_uri).not.toBe(attempts[1]!.workspace_uri);
  });
  it("a worker that dies mid-stage loses its lease; a second worker finishes; the first cannot commit", async () => {
    const clock = new FixedClock("2026-09-11T00:00:00.000Z");
    let release!: () => void;
    const hanging: Executor = { version: "hang@1", execute: () => new Promise<StageResult>((resolve) => { release = () => resolve({ schema_version: "harness.stage-result/v1", attempt_id: "attempt_01J00000000000000000000000", outcome: "failed", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [] }); }) };
    const dead = makeWorld({ scriptExecutor: hanging, owner: "dead", clock });
    const run = planAndEnqueue(dead);
    const pending = dead.worker.runOnce();
    await new Promise((r) => setTimeout(r, 50));
    clock.advance(91);
    const alive = makeWorld({ owner: "alive", clock, dir: dead.dir });
    await drain(alive);
    release();
    expect(await pending).toBe("lost");
    expect(alive.store.getRun(run.run_id)?.state).toBe("SUCCEEDED");
    const produce = alive.store.listStageRuns(run.run_id).find((s) => s.stage_key === "produce")!;
    expect(alive.store.listAttempts(produce.stage_run_id).map((a) => [a.lease_owner, a.state])).toEqual([["dead", "ABANDONED"], ["alive", "SUCCEEDED"]]);
    expect(alive.store.listArtifacts({ stage_run_id: produce.stage_run_id, status: "ACCEPTED" })).toHaveLength(1);
  });
  it("cancels the current attempt on abort and requeues the stage", async () => {
    const ac = new AbortController();
    const hanging: Executor = { version: "hang@1", execute: (_r, ctx) => new Promise((_res, rej) => ctx.signal?.addEventListener("abort", () => rej(new Error("aborted")))) };
    const w = makeWorld({ scriptExecutor: hanging });
    const run = planAndEnqueue(w);
    const p = w.worker.runForever(ac.signal);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await p;
    const produce = w.store.listStageRuns(run.run_id).find((s) => s.stage_key === "produce")!;
    expect(produce.state).toBe("READY");
    expect(w.store.listAttempts(produce.stage_run_id)[0]?.state).toBe("CANCELLED");
    expect(w.store.getLease(produce.stage_run_id)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/worker`
Expected: FAIL, thiếu module.

- [ ] **Step 4: Viết `heartbeat.ts`**

`packages/worker/src/heartbeat.ts`:

```ts
import type { Clock, StateStore } from "@harness/contracts";
import { addSeconds } from "@harness/core";

export interface HeartbeatHandle { stop(): void; readonly lost: boolean }

export function startHeartbeat(o: { store: StateStore; attemptId: string; fencingToken: number; leaseSeconds: number; intervalMs: number; clock: Clock; onLost: () => void }): HeartbeatHandle {
  let lost = false;
  const beat = () => {
    if (lost) return;
    const ok = o.store.heartbeat(o.attemptId, o.fencingToken, addSeconds(o.clock.now(), o.leaseSeconds));
    if (!ok) { lost = true; clearInterval(timer); o.onLost(); }
  };
  const timer = setInterval(beat, o.intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), get lost() { return lost; } };
}
```

- [ ] **Step 5: Viết `worker.ts`**

`packages/worker/src/worker.ts`:

```ts
import { pathToFileURL } from "node:url";
import { isHarnessError, type ClaimResult, type Clock, type HarnessConfig, type ProjectConfig, type StageRequest, type StageResult, type StateStore } from "@harness/contracts";
import { acceptedInputsFor, addSeconds, ArtifactRegistry, Controller, createWorkspace, eventFor, materializeInputs, Planner, Verifier, type HarnessLogger } from "@harness/core";
import type { ExecutorRegistry } from "@harness/executors";
import { startHeartbeat } from "./heartbeat.js";

export interface WorkerDeps {
  store: StateStore; planner: Planner; controller: Controller; registry: ArtifactRegistry; verifier: Verifier; executors: ExecutorRegistry;
  harness: HarnessConfig; project: ProjectConfig; dataRoot: string; owner: string; capabilities: string[]; logger: HarnessLogger; clock: Clock;
}

export class Worker {
  constructor(private readonly d: WorkerDeps) {}

  async runForever(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const r = await this.runOnce(signal);
      if (r === "idle") await new Promise((res) => { const t = setTimeout(res, this.d.harness.poll_seconds * 1000); signal.addEventListener("abort", () => { clearTimeout(t); res(undefined); }, { once: true }); });
    }
  }

  async runOnce(signal?: AbortSignal): Promise<"idle" | "done" | "lost"> {
    const { store, clock, logger } = this.d;
    const reaped = store.reapExpiredLeases(clock.now());
    for (const r of reaped) logger.warn("reaped expired lease", r);
    const leaseSeconds = this.d.harness.lease_seconds;
    const claim = store.claim({ owner: this.d.owner, capabilities: this.d.capabilities, now: clock.now(), leaseSeconds });
    if (!claim) return "idle";
    const run = store.getRun(claim.stageRun.run_id)!;
    const log = logger.child({ run_id: run.run_id, stage_run_id: claim.stageRun.stage_run_id, attempt_id: claim.attempt.attempt_id, owner: this.d.owner });
    const ev = (type: string, severity: "info" | "warn" | "error" = "info", payload: Record<string, unknown> = {}) => eventFor(run, claim.stageRun, claim.attempt, type, severity, payload);

    store.transaction(() => {
      store.transition("attempt", claim.attempt.attempt_id, "CLAIMED", "RUNNING", ev("attempt.started"));
      store.transition("stage_run", claim.stageRun.stage_run_id, "CLAIMED", "RUNNING", ev("stage.started"));
    });

    const workspaceDir = await createWorkspace(this.d.dataRoot, run.run_id, claim.stageRun.stage_key, claim.attempt.attempt_id);
    store.updateAttempt({ ...store.getAttempt(claim.attempt.attempt_id)!, workspace_uri: pathToFileURL(workspaceDir).href });
    const inputArtifacts = acceptedInputsFor(store, claim.stageRun);
    const inputs = await materializeInputs(workspaceDir, inputArtifacts);
    const request = this.buildRequest(claim, run.effective_config_snapshot, inputs, workspaceDir);

    const abort = new AbortController();
    signal?.addEventListener("abort", () => abort.abort(), { once: true });
    const hb = startHeartbeat({ store, attemptId: claim.attempt.attempt_id, fencingToken: claim.lease.fencing_token, leaseSeconds, intervalMs: this.d.harness.heartbeat_seconds * 1000, clock, onLost: () => abort.abort() });
    const executor = this.d.executors.resolve(claim.stageRun.executor);
    let result: StageResult;
    try {
      result = await executor.execute(request, { workspaceDir, logger: log, signal: abort.signal });
    } catch (e) {
      const kind = isHarnessError(e, "NOT_FOUND") || isHarnessError(e, "SCHEMA_INVALID") ? "contract" : "transient";
      result = { schema_version: "harness.stage-result/v1", attempt_id: claim.attempt.attempt_id, outcome: "failed", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [{ kind, message: e instanceof Error ? e.message : String(e), details: isHarnessError(e) ? { code: e.code, ...e.details } : {} }] };
    } finally { hb.stop(); }

    if (signal?.aborted && !hb.lost) { this.cancelCurrent(claim, run); return "done"; }
    if (hb.lost || !store.getLease(claim.stageRun.stage_run_id) || store.getLease(claim.stageRun.stage_run_id)!.fencing_token !== claim.lease.fencing_token) {
      log.warn("lease lost during execution; result discarded");
      return "lost";
    }
    const verify = await this.d.verifier.verify({ request, result, workspaceDir }, claim.stageRun.required_checks);
    try {
      const out = await this.d.controller.commit({ stageRun: claim.stageRun, attempt: claim.attempt, fencingToken: claim.lease.fencing_token, request, result, verify, workspaceDir, executorVersion: executor.version, inputArtifactIds: inputArtifacts.map((a) => a.artifact_id), mimeTypes: this.mimeTypesFor(claim) });
      log.info("stage committed", { stage: out.stageState, run: out.runState, failure: out.failureKind ?? null, retry: out.retryScheduled });
      return "done";
    } catch (e) {
      if (isHarnessError(e, "FENCING_REJECTED")) { log.warn("commit rejected by fencing token", e.details); return "lost"; }
      throw e;
    }
  }

  private buildRequest(claim: ClaimResult, cfg: Record<string, unknown>, inputs: StageRequest["inputs"], workspaceDir: string): StageRequest {
    const run = this.d.store.getRun(claim.stageRun.run_id)!;
    const exec = claim.stageRun.executor;
    const stage_config = { ...claim.stageRun.stage_config, ...(exec.type === "script" ? { __script: exec.script } : { __skill: exec.skill, __brief: exec.brief }) };
    return {
      schema_version: "harness.stage-request/v1", run_id: run.run_id, stage_run_id: claim.stageRun.stage_run_id, attempt_id: claim.attempt.attempt_id,
      project_id: run.project_id, portfolio_id: run.portfolio_id, stage_key: claim.stageRun.stage_key, workflow: run.workflow_release, profile_snapshot: run.profile_snapshot,
      inputs, workspace_uri: workspaceDir, stage_config,
      limits: { deadline_at: addSeconds(this.d.clock.now(), Number(cfg.default_deadline_seconds ?? this.d.harness.default_deadline_seconds)), max_cost_usd: Number(cfg.default_max_cost_usd ?? this.d.harness.default_max_cost_usd), max_attempts: claim.stageRun.retry.max_attempts },
      capabilities: this.d.capabilities, fencing_token: claim.lease.fencing_token,
    };
  }

  private mimeTypesFor(_claim: ClaimResult): Record<string, string> {
    return { script_text: "text/plain", review_notes: "text/plain", final_text: "text/plain" };
  }

  private cancelCurrent(claim: ClaimResult, run: ReturnType<StateStore["getRun"]> & object): void {
    const { store } = this.d;
    store.transaction(() => {
      const ev = eventFor(run, claim.stageRun, claim.attempt, "attempt.cancelled", "warn", { owner: this.d.owner });
      store.transition("attempt", claim.attempt.attempt_id, "RUNNING", "CANCELLED", ev);
      store.transition("stage_run", claim.stageRun.stage_run_id, "RUNNING", "READY", { ...ev, event_type: "stage.requeued_after_cancel" });
      const s = store.getStageRun(claim.stageRun.stage_run_id)!;
      store.updateStageRun({ ...s, ready_at: this.d.clock.now(), not_before: this.d.clock.now() });
      store.releaseLease(claim.stageRun.stage_run_id, claim.lease.fencing_token);
    });
  }
}
```

`packages/worker/src/index.ts`:

```ts
export * from "./worker.js";
export * from "./heartbeat.js";
```

Mime type theo `outputs[].type` của stage definition sẽ được đưa vào `stage_run` ở sub-project 2; hiện tại `mimeTypesFor` cố định cho workflow mẫu.

- [ ] **Step 6: Chạy test, xác nhận pass**

Run: `pnpm vitest run packages/worker && pnpm -r typecheck`
Expected: PASS 4 test. Nếu test "dies mid-stage" flake vì heartbeat interval 30 giây không chạy trong test: đúng như thiết kế, vì FixedClock nhảy 91 giây làm lease hết hạn bất kể heartbeat.

- [ ] **Step 7: Commit**

```bash
git add packages/worker packages/executors/tsconfig.json pnpm-lock.yaml
git commit -m "feat(worker): add claim/execute/verify/commit loop with heartbeat, lease-loss handling and cancellation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 14: External operation journal (intent → dispatch → confirm/reconcile) chống chạy trùng

**Files:**
- Modify: `packages/contracts/src/interfaces.ts` (thêm `listExternalOperations`), `packages/core/src/state/sqlite-store.ts`, `packages/core/src/index.ts`
- Create: `packages/core/src/orchestration/journal.ts`, `packages/core/src/orchestration/reconcile.ts`
- Test: `packages/core/test/orchestration/journal.test.ts`, `packages/worker/test/reconcile.test.ts`

**Interfaces:**
- Consumes: `ExternalProvider`, `FakeProvider`, `FakeAgentRuntime({ journal })`, `Worker`, `Planner`.
- Produces: `store.listExternalOperations(filter: { stage_run_id?: string; status?: string }): ExternalOperation[]`; `class ExternalOperationJournal { constructor(store, provider, clock); keyFor(p); recordIntent(p): ExternalOperation; dispatch(op, payload): Promise<ExternalOperation>; findConfirmedByKey(key) }` (tương thích cấu trúc với `JournalLike` của adapter giả); `reconcileOperation(deps, operationId): Promise<{ status; stageState }>`; `reconcileRun(deps, runId): Promise<ReconcileReport[]>` với `deps = { store, provider, planner, clock }`.

- [ ] **Step 1: Thêm `listExternalOperations`**

Trong `interfaces.ts`, sau `updateExternalOperation`: `listExternalOperations(filter: { stage_run_id?: string; status?: string }): ExternalOperation[];`

Trong `sqlite-store.ts`, sau `updateExternalOperation`:

```ts
  listExternalOperations(filter: { stage_run_id?: string; status?: string }): ExternalOperation[] {
    const where: string[] = []; const params: string[] = [];
    if (filter.stage_run_id) { where.push("json_extract(data, '$.stage_run_id') = ?"); params.push(filter.stage_run_id); }
    if (filter.status) { where.push("state = ?"); params.push(filter.status); }
    return this.listDocs(`SELECT data FROM external_operation${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id`, params, (x) => ExternalOperationSchema.parse(x));
  }
```

- [ ] **Step 2: Viết test thất bại**

`packages/core/test/orchestration/journal.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isHarnessError, newId, type ExternalOperation, type ExternalProvider, type StageRequest } from "@harness/contracts";
import { ExternalOperationJournal } from "../../src/orchestration/journal.js";
import { beginAttempt, openTempStore, seedStage } from "../helpers.js";

class Provider implements ExternalProvider {
  readonly name = "p"; dispatchCount = 0; lost = false; receipts = new Map<string, { provider_ref: string; receipt: Record<string, unknown> }>();
  async dispatch(op: ExternalOperation) { this.dispatchCount++; const r = { provider_ref: `ref-${this.dispatchCount}`, receipt: { ok: true } }; this.receipts.set(op.idempotency_key, r); if (this.lost) throw Object.assign(new Error("lost"), { code: "CONNECTION_LOST" }); return r; }
  async lookup(key: string) { const r = this.receipts.get(key); return r ? { found: true, ...r } : { found: false }; }
}
function world() {
  const t = openTempStore();
  seedStage(t.store);
  const claim = t.store.claim({ owner: "w", capabilities: [], now: t.clock.now(), leaseSeconds: 90 })!;
  beginAttempt(t.store, claim);
  const request = { run_id: claim.stageRun.run_id, stage_run_id: claim.stageRun.stage_run_id, attempt_id: claim.attempt.attempt_id } as StageRequest;
  const provider = new Provider();
  return { ...t, claim, request, provider, journal: new ExternalOperationJournal(t.store, provider, t.clock) };
}

describe("ExternalOperationJournal", () => {
  it("records intent before dispatch, then confirms with the provider receipt", async () => {
    const { journal, provider, request, store } = world();
    const intent = journal.recordIntent({ request, provider: "p", kind: "upload", target: "channel-01", payload: { v: 1 } });
    expect(intent.status).toBe("INTENT_RECORDED");
    expect(intent.idempotency_key).toBe(journal.keyFor({ kind: "upload", target: "channel-01", payload: { v: 1 } }));
    const done = await journal.dispatch(intent, { v: 1 });
    expect(done.status).toBe("CONFIRMED");
    expect(done.provider_ref).toBe("ref-1");
    expect(store.listEvents({ run_id: request.run_id }).map((e) => e.event_type)).toEqual(expect.arrayContaining(["external_operation.intent_recorded", "external_operation.dispatched", "external_operation.confirmed"]));
    expect(provider.dispatchCount).toBe(1);
  });
  it("returns the existing operation for the same idempotency key instead of creating a duplicate", () => {
    const { journal, request } = world();
    const a = journal.recordIntent({ request, provider: "p", kind: "upload", target: "c", payload: {} });
    const b = journal.recordIntent({ request, provider: "p", kind: "upload", target: "c", payload: {} });
    expect(b.operation_id).toBe(a.operation_id);
  });
  it("marks NEEDS_RECONCILIATION when the connection drops after dispatch and rethrows", async () => {
    const { journal, provider, request, store } = world();
    provider.lost = true;
    const intent = journal.recordIntent({ request, provider: "p", kind: "upload", target: "c", payload: {} });
    await journal.dispatch(intent, {}).then(() => { throw new Error("no throw"); }, (e) => expect(isHarnessError(e, "CONNECTION_LOST") || (e as { code?: string }).code === "CONNECTION_LOST").toBe(true));
    expect(store.getExternalOperation(intent.operation_id)?.status).toBe("NEEDS_RECONCILIATION");
    expect(journal.findConfirmedByKey(intent.idempotency_key)).toBeUndefined();
  });
});
```

`packages/worker/test/reconcile.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectConfigSchema } from "@harness/contracts";
import { ArtifactRegistry, BUILTIN_CHECKERS, Controller, ExternalOperationJournal, FixedClock, HARNESS_ROOT, MIGRATIONS_DIR, Planner, Redactor, SqliteStateStore, Verifier, createLogger, loadHarnessConfig, loadProfile, loadWorkflow, reconcileRun } from "@harness/core";
import { AgentExecutor, ExecutorRegistry, ScriptExecutor } from "@harness/executors";
import { FakeAgentRuntime, FakeProvider, fakeScriptCommands } from "@harness/adapter-fake";
import { Worker } from "../src/worker.js";

describe("reconcile after a lost connection", () => {
  it("does not dispatch twice and finishes the run after reconciliation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-"));
    const clock = new FixedClock("2026-09-11T00:00:00.000Z");
    const store = new SqliteStateStore(join(dir, "state.db"), clock); store.migrate(MIGRATIONS_DIR);
    const planner = new Planner(store);
    const provider = new FakeProvider(); provider.lostAfterDispatch = true;
    const journal = new ExternalOperationJournal(store, provider, clock);
    const executors = new ExecutorRegistry();
    executors.register("script", new ScriptExecutor(fakeScriptCommands()));
    executors.register("agent", new AgentExecutor(new FakeAgentRuntime({ journal })));
    const project = ProjectConfigSchema.parse({ schema_version: "harness.project/v1", project_id: "project-main", template_release: "0.1.0", runtime: "codex", data_root: dir, portfolios: [{ portfolio_id: "portfolio-main", display_name: "Main" }] });
    const worker = new Worker({ store, planner, controller: new Controller({ store, registry: new ArtifactRegistry(store, dir), planner, clock }), registry: new ArtifactRegistry(store, dir), verifier: new Verifier(BUILTIN_CHECKERS), executors, harness: loadHarnessConfig(HARNESS_ROOT), project, dataRoot: dir, owner: "w", capabilities: ["write_workspace", "read_source"], logger: createLogger({ redactor: new Redactor(() => []), sink: () => {}, level: "error" }), clock });
    const run = planner.plan({ workflow: loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0"), profile: loadProfile(HARNESS_ROOT, "cartoon"), harness: loadHarnessConfig(HARNESS_ROOT), projectId: "project-main", portfolioId: "portfolio-main" });
    for (const s of store.listStageRuns(run.run_id)) store.updateStageRun({ ...s, retry: { ...s.retry, backoff_seconds: [0, 0, 0] }, stage_config: s.stage_key === "review" ? { ...s.stage_config, external_operation: true } : s.stage_config });
    planner.enqueue(run.run_id);
    while ((await worker.runOnce()) !== "idle") { /* drain */ }
    const review = () => store.listStageRuns(run.run_id).find((s) => s.stage_key === "review")!;
    expect(review().state).toBe("NEEDS_RECONCILIATION");
    expect(store.getRun(run.run_id)?.state).toBe("WAITING");
    expect(provider.dispatchCount).toBe(1);
    const report = await reconcileRun({ store, provider, planner, clock }, run.run_id);
    expect(report).toEqual([{ operation_id: expect.stringMatching(/^op_/), status: "CONFIRMED", stage_key: "review", stageState: "READY" }]);
    provider.lostAfterDispatch = false;
    while ((await worker.runOnce()) !== "idle") { /* drain */ }
    expect(store.getRun(run.run_id)?.state).toBe("SUCCEEDED");
    expect(provider.dispatchCount).toBe(1);
    expect(store.listExternalOperations({ stage_run_id: review().stage_run_id })).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/core/test/orchestration/journal.test.ts packages/worker/test/reconcile.test.ts`
Expected: FAIL, thiếu module.

- [ ] **Step 4: Viết `journal.ts`**

`packages/core/src/orchestration/journal.ts`:

```ts
import { HarnessError, isHarnessError, newId, type Clock, type ExternalOperation, type ExternalProvider, type StageRequest, type StateStore } from "@harness/contracts";
import { canonicalJson, sha256String } from "../artifacts/checksum.js";
import { eventFor } from "./planner.js";

export interface IntentInput { request: Pick<StageRequest, "run_id" | "stage_run_id" | "attempt_id">; provider: string; kind: string; target: string; payload: Record<string, unknown> }

export class ExternalOperationJournal {
  constructor(private readonly store: StateStore, private readonly provider: ExternalProvider, private readonly clock: Clock) {}

  keyFor(p: { kind: string; target: string; payload: Record<string, unknown> }): string {
    return sha256String(canonicalJson({ kind: p.kind, target: p.target, payload: p.payload }));
  }

  findConfirmedByKey(key: string): ExternalOperation | undefined {
    const op = this.store.findExternalOperationByKey(key);
    return op?.status === "CONFIRMED" ? op : undefined;
  }

  recordIntent(p: IntentInput): ExternalOperation {
    const key = this.keyFor(p);
    return this.store.transaction(() => {
      const existing = this.store.findExternalOperationByKey(key);
      if (existing && existing.status !== "FAILED") return existing;
      const now = this.clock.now();
      const op: ExternalOperation = {
        schema_version: "harness.external-operation/v1", operation_id: newId("external_operation"), run_id: p.request.run_id, stage_run_id: p.request.stage_run_id,
        attempt_id: p.request.attempt_id, provider: p.provider, kind: p.kind, target: p.target, idempotency_key: key, status: "INTENT_RECORDED",
        provider_ref: null, receipt: null, cost_usd: 0, created_at: now, updated_at: now,
      };
      this.store.insertExternalOperation(op);
      this.store.appendEvent(this.ev(op, "external_operation.intent_recorded", { kind: p.kind, target: p.target, idempotency_key: key }));
      return op;
    });
  }

  async dispatch(op: ExternalOperation, payload: Record<string, unknown>): Promise<ExternalOperation> {
    this.store.transition("external_operation", op.operation_id, "INTENT_RECORDED", "DISPATCHED", this.ev(op, "external_operation.dispatched"));
    try {
      const r = await this.provider.dispatch(op, payload);
      return this.store.transaction(() => {
        const cur = this.store.getExternalOperation(op.operation_id)!;
        this.store.updateExternalOperation({ ...cur, provider_ref: r.provider_ref, receipt: r.receipt });
        this.store.transition("external_operation", op.operation_id, "DISPATCHED", "CONFIRMED", this.ev(op, "external_operation.confirmed", { provider_ref: r.provider_ref }));
        return this.store.getExternalOperation(op.operation_id)!;
      });
    } catch (e) {
      const lost = isHarnessError(e, "CONNECTION_LOST") || (e as { code?: string })?.code === "CONNECTION_LOST";
      if (lost) {
        this.store.transition("external_operation", op.operation_id, "DISPATCHED", "NEEDS_RECONCILIATION", this.ev(op, "external_operation.needs_reconciliation", { reason: (e as Error).message }));
        throw isHarnessError(e) ? e : new HarnessError("CONNECTION_LOST", (e as Error).message, { operation_id: op.operation_id });
      }
      this.store.transition("external_operation", op.operation_id, "DISPATCHED", "FAILED", this.ev(op, "external_operation.failed", { reason: (e as Error).message }));
      throw e;
    }
  }

  private ev(op: ExternalOperation, type: string, payload: Record<string, unknown> = {}) {
    const run = this.store.getRun(op.run_id)!;
    const stage = this.store.getStageRun(op.stage_run_id)!;
    const attempt = this.store.getAttempt(op.attempt_id) ?? null;
    return eventFor(run, stage, attempt, type, type.endsWith("failed") || type.endsWith("reconciliation") ? "warn" : "info", { operation_id: op.operation_id, ...payload });
  }
}
```

- [ ] **Step 5: Viết `reconcile.ts`**

`packages/core/src/orchestration/reconcile.ts`:

```ts
import { HarnessError, type Clock, type ExternalProvider, type StateStore } from "@harness/contracts";
import { eventFor, Planner } from "./planner.js";

export interface ReconcileDeps { store: StateStore; provider: ExternalProvider; planner: Planner; clock: Clock }
export interface ReconcileReport { operation_id: string; status: "CONFIRMED" | "FAILED"; stage_key: string; stageState: string }

export async function reconcileOperation(d: ReconcileDeps, operationId: string): Promise<ReconcileReport> {
  const op = d.store.getExternalOperation(operationId);
  if (!op) throw new HarnessError("NOT_FOUND", `external operation not found: ${operationId}`, { operationId });
  if (op.status !== "NEEDS_RECONCILIATION") throw new HarnessError("RECONCILE_FAILED", `operation ${operationId} is ${op.status}, not NEEDS_RECONCILIATION`, { status: op.status });
  const found = await d.provider.lookup(op.idempotency_key);
  return d.store.transaction(() => {
    const run = d.store.getRun(op.run_id)!;
    const stage = d.store.getStageRun(op.stage_run_id)!;
    const attempt = d.store.getAttempt(op.attempt_id) ?? null;
    const status = found.found ? "CONFIRMED" : "FAILED";
    if (found.found) d.store.updateExternalOperation({ ...op, provider_ref: found.provider_ref ?? null, receipt: found.receipt ?? null });
    d.store.transition("external_operation", op.operation_id, "NEEDS_RECONCILIATION", status, eventFor(run, stage, attempt, `external_operation.reconciled`, found.found ? "info" : "warn", { operation_id: op.operation_id, found: found.found }));
    const remaining = d.store.listExternalOperations({ stage_run_id: stage.stage_run_id, status: "NEEDS_RECONCILIATION" });
    if (stage.state === "NEEDS_RECONCILIATION" && remaining.length === 0) {
      d.store.transition("stage_run", stage.stage_run_id, "NEEDS_RECONCILIATION", "READY", eventFor(run, stage, null, "stage.reconciled", "info", { operation_id: op.operation_id }));
      const fresh = d.store.getStageRun(stage.stage_run_id)!;
      d.store.updateStageRun({ ...fresh, ready_at: d.clock.now(), not_before: d.clock.now() });
      d.planner.advance(run.run_id);
    }
    return { operation_id: op.operation_id, status, stage_key: stage.stage_key, stageState: d.store.getStageRun(stage.stage_run_id)!.state };
  });
}

export async function reconcileRun(d: ReconcileDeps, runId: string): Promise<ReconcileReport[]> {
  const out: ReconcileReport[] = [];
  for (const stage of d.store.listStageRuns(runId)) {
    if (stage.state !== "NEEDS_RECONCILIATION") continue;
    for (const op of d.store.listExternalOperations({ stage_run_id: stage.stage_run_id, status: "NEEDS_RECONCILIATION" })) out.push(await reconcileOperation(d, op.operation_id));
  }
  return out;
}
```

Thêm vào `packages/core/src/index.ts`: `export * from "./orchestration/journal.js"; export * from "./orchestration/reconcile.js";`

- [ ] **Step 6: Chạy test, xác nhận pass**

Run: `pnpm vitest run && pnpm -r typecheck`
Expected: PASS toàn bộ workspace.

- [ ] **Step 7: Commit**

```bash
git add packages
git commit -m "feat(core): add external operation journal with idempotency keys and reconciliation flow

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: CLI `harness` và composition root

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/vitest.config.ts`, `packages/cli/src/main.ts`, `packages/cli/src/composition.ts`, `packages/cli/src/commands/db.ts`, `packages/cli/src/commands/plan.ts`, `packages/cli/src/commands/enqueue.ts`, `packages/cli/src/commands/worker.ts`, `packages/cli/src/commands/status.ts`, `packages/cli/src/commands/retry.ts`, `packages/cli/src/commands/cancel.ts`, `packages/cli/src/commands/reconcile.ts`, `packages/cli/src/commands/leases.ts`, `packages/cli/src/commands/workspaces.ts`, `packages/cli/src/commands/events.ts`
- Create: `fixtures/ops-project-minimal/project.yaml`, `project-template/project.yaml`
- Test: `packages/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: mọi thứ ở trên.
- Produces: `buildContext(opts: { projectDir: string; harnessRoot?: string; owner?: string; capabilities?: string[]; logLevel? }): AppContext` với `AppContext = { store, planner, controller, registry, verifier, executors, journal, provider, harness, project, dataRoot, logger, clock, close() }`; binary `harness` (bin `packages/cli/src/main.ts` qua `tsx`, sau build là `dist/main.js`).
- Quy ước CLI: `--project <dir>` (mặc định `HARNESS_PROJECT` hoặc cwd), `--json` cho máy đọc, exit code 1 khi lỗi, `HarnessError` in `code: message`.

- [ ] **Step 1: Tạo package và fixture**

`packages/cli/package.json`:

```json
{
  "name": "@harness/cli", "version": "0.1.0", "type": "module",
  "bin": { "harness": "./dist/main.js" },
  "scripts": { "build": "tsc -p tsconfig.json", "typecheck": "tsc -p tsconfig.json --noEmit", "dev": "tsx src/main.ts" },
  "dependencies": {
    "@harness/adapter-fake": "workspace:*", "@harness/contracts": "workspace:*", "@harness/core": "workspace:*",
    "@harness/executors": "workspace:*", "@harness/worker": "workspace:*", "commander": "^12.1.0", "yaml": "^2.6.0"
  }
}
```

`tsconfig.json`, `vitest.config.ts` như Task 4 (`testTimeout: 60000`). Thêm `composite: true` cho `packages/worker/tsconfig.json` và `packages/adapters/fake/tsconfig.json`. Thêm script root `"harness": "tsx packages/cli/src/main.ts"` vào `package.json` gốc. `pnpm install`.

`fixtures/ops-project-minimal/project.yaml`:

```yaml
schema_version: harness.project/v1
project_id: project-minimal
template_release: 0.1.0
runtime: claude
data_root: ./data
portfolios:
  - { portfolio_id: portfolio-main, display_name: Minimal portfolio }
```

`project-template/project.yaml`:

```yaml
# Copy this directory to create an operations project, then edit the values below.
schema_version: harness.project/v1
project_id: project-CHANGE-ME
template_release: 0.1.0
runtime: claude            # claude | codex, chosen per machine/project
data_root: ../youtube-operations-data
portfolios:
  - { portfolio_id: portfolio-main, display_name: Main portfolio }
```

- [ ] **Step 2: Viết test thất bại**

`packages/cli/test/cli.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_ROOT } from "@harness/core";

const MAIN = join(HARNESS_ROOT, "packages", "cli", "src", "main.ts");
function cli(project: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", MAIN, "--project", project, ...args], { encoding: "utf8", env: { ...process.env, HARNESS_LOG_LEVEL: "error" } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
function freshProject() {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  cpSync(join(HARNESS_ROOT, "fixtures", "ops-project-minimal"), dir, { recursive: true });
  return dir;
}

describe("harness CLI", () => {
  it("plans, enqueues, works and reports a SUCCEEDED run", () => {
    const p = freshProject();
    expect(cli(p, "db", "migrate").code).toBe(0);
    const plan = cli(p, "plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--json");
    expect(plan.code, plan.err).toBe(0);
    const { run_id } = JSON.parse(plan.out);
    expect(run_id).toMatch(/^run_/);
    expect(cli(p, "enqueue", run_id).code).toBe(0);
    for (let i = 0; i < 6; i++) {
      const w = cli(p, "worker", "--once", "--capabilities", "write_workspace,read_source", "--owner", `w${i}`);
      expect(w.code, w.err).toBe(0);
      if (w.out.includes("idle")) break;
    }
    const status = cli(p, "status", run_id, "--json");
    expect(status.code).toBe(0);
    const s = JSON.parse(status.out);
    expect(s.run.state).toBe("SUCCEEDED");
    expect(s.stages.map((x: { state: string }) => x.state)).toEqual(["SUCCEEDED", "SUCCEEDED", "SUCCEEDED"]);
    expect(s.artifacts.filter((a: { status: string }) => a.status === "ACCEPTED")).toHaveLength(3);
    expect(cli(p, "events", "tail", "--run", run_id).out).toContain("run.succeeded");
  });
  it("fails fast on an unknown config override", () => {
    const p = freshProject();
    cli(p, "db", "migrate");
    const r = cli(p, "plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--override", "leese_seconds=5");
    expect(r.code).toBe(1);
    expect(r.err).toContain("UNKNOWN_CONFIG_KEY");
  });
  it("never leaks a resolved secret into snapshot, events or logs", () => {
    const p = freshProject();
    cli(p, "db", "migrate");
    const r = spawnSync(process.execPath, ["--import", "tsx", MAIN, "--project", p, "plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--override", "default_max_cost_usd=1", "--json"], { encoding: "utf8", env: { ...process.env, HARNESS_SECRET_TTS_MAIN: "super-secret-token", HARNESS_LOG_LEVEL: "debug" } });
    const all = r.stdout + r.stderr;
    expect(all).not.toContain("super-secret-token");
    const { run_id } = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
    const status = cli(p, "status", run_id, "--json");
    expect(status.out + status.err).not.toContain("super-secret-token");
  });
});
```

- [ ] **Step 3: Chạy test, xác nhận fail**

Run: `pnpm vitest run packages/cli`
Expected: FAIL, thiếu `main.ts`.

- [ ] **Step 4: Viết `composition.ts`**

`packages/cli/src/composition.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { HarnessError, ProjectConfigSchema, type ProjectConfig } from "@harness/contracts";
import { ArtifactRegistry, BUILTIN_CHECKERS, Controller, EnvSecretResolver, ExternalOperationJournal, HARNESS_ROOT, Planner, Redactor, SqliteStateStore, SystemClock, Verifier, createLogger, loadHarnessConfig, type HarnessLogger, type LogLevel } from "@harness/core";
import { AgentExecutor, ExecutorRegistry, ScriptExecutor } from "@harness/executors";
import { FakeAgentRuntime, FakeProvider, fakeScriptCommands } from "@harness/adapter-fake";
import { MIGRATIONS_DIR } from "@harness/core";

export interface AppContext {
  store: SqliteStateStore; planner: Planner; controller: Controller; registry: ArtifactRegistry; verifier: Verifier; executors: ExecutorRegistry;
  journal: ExternalOperationJournal; provider: FakeProvider; harness: ReturnType<typeof loadHarnessConfig>; project: ProjectConfig; projectDir: string;
  dataRoot: string; logger: HarnessLogger; clock: SystemClock; secrets: EnvSecretResolver; migrationsDir: string; close(): void;
}

export function loadProject(projectDir: string): ProjectConfig {
  const file = join(projectDir, "project.yaml");
  if (!existsSync(file)) throw new HarnessError("NOT_FOUND", `project.yaml not found in ${projectDir}`, { projectDir });
  return ProjectConfigSchema.parse(parse(readFileSync(file, "utf8")));
}

export function buildContext(o: { projectDir: string; harnessRoot?: string; owner?: string; capabilities?: string[]; logLevel?: LogLevel }): AppContext {
  const harnessRoot = o.harnessRoot ?? HARNESS_ROOT;
  const projectDir = resolve(o.projectDir);
  const project = loadProject(projectDir);
  const dataRoot = isAbsolute(project.data_root) ? project.data_root : resolve(projectDir, project.data_root);
  const harness = loadHarnessConfig(harnessRoot);
  const clock = new SystemClock();
  const secrets = new EnvSecretResolver();
  const redactor = new Redactor(() => secrets.resolvedValues());
  const logger = createLogger({ redactor, level: o.logLevel ?? ((process.env.HARNESS_LOG_LEVEL as LogLevel | undefined) ?? "info"), sink: (l) => process.stderr.write(l + "\n"), bindings: { project_id: project.project_id } });
  const store = new SqliteStateStore(join(dataRoot, "state", "harness.db"), clock);
  const planner = new Planner(store);
  const registry = new ArtifactRegistry(store, dataRoot);
  const controller = new Controller({ store, registry, planner, clock });
  const provider = new FakeProvider();
  const journal = new ExternalOperationJournal(store, provider, clock);
  const executors = new ExecutorRegistry();
  executors.register("script", new ScriptExecutor(fakeScriptCommands()));
  executors.register("agent", new AgentExecutor(new FakeAgentRuntime({ journal })));
  return { store, planner, controller, registry, verifier: new Verifier(BUILTIN_CHECKERS), executors, journal, provider, harness, project, projectDir, dataRoot, logger, clock, secrets, migrationsDir: MIGRATIONS_DIR, close: () => store.close() };
}
```

Trước khi mở DB, `SqliteStateStore` cần thư mục `state/` tồn tại: thêm vào đầu constructor của `SqliteStateStore` (Task 4) dòng `mkdirSync(dirname(dbPath), { recursive: true });` với import `mkdirSync` từ `node:fs`.

- [ ] **Step 5: Viết `main.ts` và các command**

`packages/cli/src/main.ts`:

```ts
#!/usr/bin/env node
import { Command } from "commander";
import { isHarnessError } from "@harness/contracts";
import { registerDb } from "./commands/db.js";
import { registerPlan } from "./commands/plan.js";
import { registerEnqueue } from "./commands/enqueue.js";
import { registerWorker } from "./commands/worker.js";
import { registerStatus } from "./commands/status.js";
import { registerRetry } from "./commands/retry.js";
import { registerCancel } from "./commands/cancel.js";
import { registerReconcile } from "./commands/reconcile.js";
import { registerLeases } from "./commands/leases.js";
import { registerWorkspaces } from "./commands/workspaces.js";
import { registerEvents } from "./commands/events.js";

const program = new Command("harness").description("YouTube Operations Harness control plane").option("--project <dir>", "operations project directory", process.env.HARNESS_PROJECT ?? process.cwd());
for (const reg of [registerDb, registerPlan, registerEnqueue, registerWorker, registerStatus, registerRetry, registerCancel, registerReconcile, registerLeases, registerWorkspaces, registerEvents]) reg(program);

program.parseAsync(process.argv).catch((e: unknown) => {
  if (isHarnessError(e)) process.stderr.write(`${e.code}: ${e.message}\n`);
  else process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
```

Mỗi command là một hàm `register<Name>(program: Command)`. Dùng chung helper trong `packages/cli/src/commands/shared.ts`:

```ts
import type { Command } from "commander";
import { buildContext, type AppContext } from "../composition.js";

export function projectDirOf(cmd: Command): string { return cmd.optsWithGlobals().project as string; }
export async function withContext<T>(cmd: Command, extra: Parameters<typeof buildContext>[0] extends infer P ? Partial<P> : never, fn: (ctx: AppContext) => Promise<T> | T): Promise<T> {
  const ctx = buildContext({ projectDir: projectDirOf(cmd), ...extra });
  try { return await fn(ctx); } finally { ctx.close(); }
}
export function print(json: boolean, data: unknown, text: () => string): void {
  process.stdout.write((json ? JSON.stringify(data) : text()) + "\n");
}
```

`commands/db.ts`:

```ts
import type { Command } from "commander";
import { withContext } from "./shared.js";
export function registerDb(program: Command): void {
  const db = program.command("db").description("state store maintenance");
  db.command("migrate").description("apply pending migrations").action(async (_o, cmd) => {
    await withContext(cmd, {}, (ctx) => { const applied = ctx.store.migrate(ctx.migrationsDir); process.stdout.write(applied.length ? `applied: ${applied.join(", ")}\n` : "up to date\n"); });
  });
}
```

`commands/plan.ts`:

```ts
import type { Command } from "commander";
import { HarnessError } from "@harness/contracts";
import { HARNESS_ROOT, loadProfile, loadWorkflow } from "@harness/core";
import { print, withContext } from "./shared.js";

function parseOverrides(list: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of list) {
    const i = kv.indexOf("=");
    if (i < 1) throw new HarnessError("CONFIG_INVALID", `override must be key=value, got "${kv}"`, { kv });
    const k = kv.slice(0, i); const raw = kv.slice(i + 1);
    out[k] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw === "true" ? true : raw === "false" ? false : raw;
  }
  return out;
}
export function registerPlan(program: Command): void {
  program.command("plan").description("create a DRAFT run from a workflow release and profile")
    .requiredOption("--workflow <id@version>").requiredOption("--profile <id>").option("--source <src_id>").option("--portfolio <id>")
    .option("--override <k=v>", "run override (repeatable)", (v: string, acc: string[]) => [...acc, v], [] as string[]).option("--json", "machine output", false)
    .action(async (o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const run = ctx.planner.plan({ workflow: loadWorkflow(HARNESS_ROOT, o.workflow), profile: loadProfile(HARNESS_ROOT, o.profile), harness: ctx.harness, projectId: ctx.project.project_id, portfolioId: o.portfolio ?? ctx.project.portfolios[0]!.portfolio_id, runOverrides: parseOverrides(o.override), ...(o.source ? { sourceId: o.source } : {}) });
        print(o.json, { run_id: run.run_id, state: run.state, digest: run.effective_config_digest }, () => `${run.run_id} (${run.state}) config ${run.effective_config_digest.slice(0, 19)}`);
      });
    });
}
```

`commands/enqueue.ts`:

```ts
import type { Command } from "commander";
import { withContext } from "./shared.js";
export function registerEnqueue(program: Command): void {
  program.command("enqueue <run_id>").description("mark a DRAFT run READY and release root stages").action(async (runId: string, _o, cmd) => {
    await withContext(cmd, {}, (ctx) => { ctx.planner.enqueue(runId); process.stdout.write(`${runId} READY\n`); });
  });
}
```

`commands/worker.ts`:

```ts
import { hostname } from "node:os";
import type { Command } from "commander";
import { Worker } from "@harness/worker";
import { withContext } from "./shared.js";
export function registerWorker(program: Command): void {
  program.command("worker").description("claim and execute stages")
    .option("--once", "process at most one stage then exit", false).option("--capabilities <list>", "comma separated", "write_workspace,read_source").option("--owner <name>", "lease owner", `${hostname()}-${process.pid}`)
    .action(async (o, cmd) => {
      await withContext(cmd, {}, async (ctx) => {
        const worker = new Worker({ ...ctx, harness: ctx.harness, project: ctx.project, dataRoot: ctx.dataRoot, owner: o.owner, capabilities: String(o.capabilities).split(",").map((s: string) => s.trim()).filter(Boolean), logger: ctx.logger, clock: ctx.clock });
        if (o.once) { process.stdout.write(`${await worker.runOnce()}\n`); return; }
        const ac = new AbortController();
        for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { ctx.logger.warn(`received ${sig}, cancelling current attempt`); ac.abort(); });
        await worker.runForever(ac.signal);
      });
    });
}
```

`commands/status.ts`:

```ts
import type { Command } from "commander";
import { HarnessError } from "@harness/contracts";
import { print, withContext } from "./shared.js";
export function registerStatus(program: Command): void {
  program.command("status <run_id>").option("--json", "machine output", false).description("show run, stages, attempts, artifacts and cost").action(async (runId: string, o, cmd) => {
    await withContext(cmd, {}, (ctx) => {
      const run = ctx.store.getRun(runId);
      if (!run) throw new HarnessError("NOT_FOUND", `run not found: ${runId}`, { runId });
      const stages = ctx.store.listStageRuns(runId).map((s) => ({ ...s, attempts: ctx.store.listAttempts(s.stage_run_id), lease: ctx.store.getLease(s.stage_run_id) ?? null }));
      const artifacts = ctx.store.listArtifacts({ run_id: runId });
      print(o.json, { run, stages, artifacts }, () => [
        `${run.run_id}  ${run.state}  cost=$${run.total_cost_usd.toFixed(2)}  workflow=${run.workflow_release.id}@${run.workflow_release.version}  profile=${run.profile_snapshot.id}@${run.profile_snapshot.revision}`,
        ...stages.map((s) => `  ${s.stage_key.padEnd(12)} ${s.state.padEnd(20)} attempts=${s.attempt_count} failures=${s.result_failures}${s.lease ? ` lease=${s.lease.owner}#${s.lease.fencing_token}` : ""}${s.last_failure_kind ? ` last=${s.last_failure_kind}` : ""}`),
        ...artifacts.map((a) => `  artifact ${a.artifact_id} ${a.status.padEnd(11)} ${a.type} ${a.checksum.slice(0, 19)}`),
      ].join("\n"));
    });
  });
}
```

`commands/retry.ts`:

```ts
import type { Command } from "commander";
import { HarnessError } from "@harness/contracts";
import { eventFor } from "@harness/core";
import { withContext } from "./shared.js";
export function registerRetry(program: Command): void {
  program.command("retry <run_id>").option("--stage <key>").description("move FAILED or WAITING_HUMAN stages back to READY").action(async (runId: string, o, cmd) => {
    await withContext(cmd, {}, (ctx) => {
      const run = ctx.store.getRun(runId);
      if (!run) throw new HarnessError("NOT_FOUND", `run not found: ${runId}`, { runId });
      const moved: string[] = [];
      ctx.store.transaction(() => {
        for (const s of ctx.store.listStageRuns(runId)) {
          if (o.stage && s.stage_key !== o.stage) continue;
          if (s.state !== "FAILED" && s.state !== "WAITING_HUMAN") continue;
          ctx.store.transition("stage_run", s.stage_run_id, s.state, "READY", eventFor(run, s, null, "stage.manual_retry", "warn", { by: "cli" }));
          const fresh = ctx.store.getStageRun(s.stage_run_id)!;
          ctx.store.updateStageRun({ ...fresh, ready_at: ctx.clock.now(), not_before: ctx.clock.now() });
          moved.push(s.stage_key);
        }
        if (run.state === "FAILED" || run.state === "WAITING") { /* run re-enters RUNNING via planner.advance when a worker claims */ }
        if (run.state === "WAITING") ctx.planner.advance(runId);
      });
      if (run.state === "FAILED" && moved.length) throw new HarnessError("INVALID_TRANSITION", "run is FAILED (terminal); plan a new run instead", { runId });
      process.stdout.write(moved.length ? `READY: ${moved.join(", ")}\n` : "nothing to retry\n");
    });
  });
}
```

`commands/cancel.ts`:

```ts
import type { Command } from "commander";
import { withContext } from "./shared.js";
export function registerCancel(program: Command): void {
  program.command("cancel <run_id>").description("cancel a run; running attempts finish via CANCEL_REQUESTED").action(async (runId: string, _o, cmd) => {
    await withContext(cmd, {}, (ctx) => { ctx.planner.cancel(runId); process.stdout.write(`${runId} ${ctx.store.getRun(runId)?.state}\n`); });
  });
}
```

`commands/reconcile.ts`:

```ts
import type { Command } from "commander";
import { reconcileOperation, reconcileRun } from "@harness/core";
import { print, withContext } from "./shared.js";
export function registerReconcile(program: Command): void {
  program.command("reconcile <id>").option("--json", "machine output", false).description("reconcile NEEDS_RECONCILIATION operations for a run_id or a single op_id").action(async (id: string, o, cmd) => {
    await withContext(cmd, {}, async (ctx) => {
      const deps = { store: ctx.store, provider: ctx.provider, planner: ctx.planner, clock: ctx.clock };
      const report = id.startsWith("op_") ? [await reconcileOperation(deps, id)] : await reconcileRun(deps, id);
      print(o.json, report, () => report.length ? report.map((r) => `${r.operation_id} ${r.status} stage=${r.stage_key} -> ${r.stageState}`).join("\n") : "nothing to reconcile");
    });
  });
}
```

`commands/leases.ts`:

```ts
import type { Command } from "commander";
import { withContext } from "./shared.js";
export function registerLeases(program: Command): void {
  const leases = program.command("leases").description("lease maintenance");
  leases.command("reap").description("abandon expired leases and requeue their stages").action(async (_o, cmd) => {
    await withContext(cmd, {}, (ctx) => { const r = ctx.store.reapExpiredLeases(ctx.clock.now()); process.stdout.write(r.length ? r.map((x) => `${x.stage_run_id} owner=${x.owner} requeued=${x.requeued}`).join("\n") + "\n" : "no expired leases\n"); });
  });
}
```

`commands/workspaces.ts`:

```ts
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { withContext } from "./shared.js";
export function registerWorkspaces(program: Command): void {
  const ws = program.command("workspaces").description("workspace maintenance");
  ws.command("prune").option("--days <n>", "override retention.workspace_days").description("delete attempt workspaces older than retention").action(async (o, cmd) => {
    await withContext(cmd, {}, (ctx) => {
      const days = o.days ? Number(o.days) : ctx.harness.retention.workspace_days;
      const cutoff = Date.now() - days * 86_400_000;
      const root = join(ctx.dataRoot, "workspaces");
      let removed = 0;
      for (const run of safeList(root)) for (const stage of safeList(join(root, run))) for (const attempt of safeList(join(root, run, stage))) {
        const dir = join(root, run, stage, attempt);
        if (statSync(dir).mtimeMs < cutoff && !ctx.store.getLease(ctx.store.getAttempt(attempt)?.stage_run_id ?? "")) { rmSync(dir, { recursive: true, force: true }); removed++; }
      }
      process.stdout.write(`removed ${removed} workspace(s) older than ${days} day(s)\n`);
    });
  });
}
function safeList(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }
```

`commands/events.ts`:

```ts
import type { Command } from "commander";
import { withContext } from "./shared.js";
export function registerEvents(program: Command): void {
  const events = program.command("events").description("event log");
  events.command("tail").option("--run <run_id>").option("--limit <n>", "max rows", "50").option("--json", "machine output", false).action(async (o, cmd) => {
    await withContext(cmd, {}, (ctx) => {
      const rows = ctx.store.listEvents({ ...(o.run ? { run_id: o.run } : {}), limit: Number(o.limit) });
      const last = rows.slice(-Number(o.limit));
      process.stdout.write((o.json ? JSON.stringify(last) : last.map((e) => `${e.occurred_at} ${e.severity.padEnd(5)} ${e.event_type.padEnd(36)} ${e.stage_run_id ?? ""} ${JSON.stringify(e.payload)}`).join("\n")) + "\n");
    });
  });
}
```

Trong `worker.ts` command, `Worker` cần `registry`, `verifier`, `executors`, `controller`, `planner`, `store` từ `ctx` (spread `...ctx` đã có đủ các trường trùng tên).

- [ ] **Step 6: Chạy test, xác nhận pass**

Run: `pnpm vitest run packages/cli && pnpm -r typecheck && pnpm build`
Expected: PASS 3 test; build ra `packages/cli/dist/main.js`. Kiểm tra tay: `pnpm harness --project fixtures/ops-project-minimal db migrate` in `applied: 0001_initial.sql` (sau đó xóa `fixtures/ops-project-minimal/data/` và thêm dòng `fixtures/**/data/` vào `.gitignore`).

- [ ] **Step 7: Commit**

```bash
git add packages/cli fixtures project-template package.json pnpm-lock.yaml .gitignore packages/*/tsconfig.json packages/adapters/fake/tsconfig.json packages/core/src/state/sqlite-store.ts
git commit -m "feat(cli): add harness CLI with composition root and fake adapters wired end to end

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 16: Acceptance test cấp hệ thống (blueprint 18.3: mục 1, 2, 3, 5, 10, 11, 15)

**Files:**
- Create: `tests/vitest.config.ts`, `tests/acceptance/helpers.ts`, `tests/acceptance/01-single-claim-across-processes.test.ts`, `tests/acceptance/02-03-crash-resume-fencing.test.ts`, `tests/acceptance/05-provisional-never-visible.test.ts`, `tests/acceptance/10-unknown-config-key.test.ts`, `tests/acceptance/11-secret-never-leaks.test.ts`, `tests/acceptance/15-fresh-worker-from-state.test.ts`

**Interfaces:**
- Consumes: CLI qua child process, `SqliteStateStore`, `Worker`, `FakeAgentRuntime`, `FixedClock`.
- Produces: bộ test chạy bằng `pnpm test`; mỗi file map một mục 18.3 để báo cáo Definition of Done.

- [ ] **Step 1: Cấu hình và helper**

`tests/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["acceptance/**/*.test.ts", "integration/**/*.test.ts"], testTimeout: 120000, hookTimeout: 60000 } });
```

`tests/acceptance/helpers.ts`:

```ts
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_ROOT } from "@harness/core";

export const MAIN = join(HARNESS_ROOT, "packages", "cli", "src", "main.ts");
export function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "acc-"));
  cpSync(join(HARNESS_ROOT, "fixtures", "ops-project-minimal"), dir, { recursive: true });
  spawnSync(process.execPath, ["--import", "tsx", MAIN, "--project", dir, "db", "migrate"], { encoding: "utf8" });
  return dir;
}
export function cli(project: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--import", "tsx", MAIN, "--project", project, ...args], { encoding: "utf8", env: { ...process.env, HARNESS_LOG_LEVEL: "error", ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
export function cliAsync(project: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--import", "tsx", MAIN, "--project", project, ...args], { env: { ...process.env, HARNESS_LOG_LEVEL: "error" } });
    let out = ""; let err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}
export function planRun(project: string): string {
  const r = cli(project, ["plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--json"]);
  const { run_id } = JSON.parse(r.out);
  cli(project, ["enqueue", run_id]);
  return run_id;
}
export function status(project: string, runId: string) {
  return JSON.parse(cli(project, ["status", runId, "--json"]).out) as { run: { state: string }; stages: { stage_key: string; state: string; attempts: { lease_owner: string; state: string }[] }[]; artifacts: { status: string; stage_run_id: string }[] };
}
```

Root `package.json` cần devDependency `"@harness/core": "workspace:*"`, `"@harness/contracts": "workspace:*"`, `"@harness/worker": "workspace:*"`, `"@harness/executors": "workspace:*"`, `"@harness/adapter-fake": "workspace:*"` để `tests/` import được. Chạy `pnpm install`.

- [ ] **Step 2: Viết các acceptance test**

`tests/acceptance/01-single-claim-across-processes.test.ts` (mục 1: ba worker cùng queue, chỉ một claim mỗi stage):

```ts
import { describe, expect, it } from "vitest";
import { cliAsync, freshProject, planRun, status } from "./helpers.js";

describe("18.3 #1 three worker processes compete for one queue", () => {
  it("each stage is executed by exactly one attempt", async () => {
    const p = freshProject();
    const runId = planRun(p);
    // Only `produce` is READY at first; three processes race for it, then the survivors drain the rest.
    const results = await Promise.all(["w1", "w2", "w3"].map((o) => cliAsync(p, ["worker", "--once", "--owner", o, "--capabilities", "write_workspace,read_source"])));
    expect(results.every((r) => r.code === 0)).toBe(true);
    expect(results.filter((r) => r.out.includes("done"))).toHaveLength(1);
    expect(results.filter((r) => r.out.includes("idle"))).toHaveLength(2);
    for (let i = 0; i < 6; i++) { const r = await cliAsync(p, ["worker", "--once", "--owner", "w4"]); if (r.out.includes("idle")) break; }
    const s = status(p, runId);
    expect(s.run.state).toBe("SUCCEEDED");
    for (const st of s.stages) expect(st.attempts.filter((a) => a.state === "SUCCEEDED")).toHaveLength(1);
  });
});
```

`tests/acceptance/02-03-crash-resume-fencing.test.ts` (mục 2 và 3):

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectConfigSchema, type Executor, type StageResult } from "@harness/contracts";
import { ArtifactRegistry, BUILTIN_CHECKERS, Controller, FixedClock, HARNESS_ROOT, MIGRATIONS_DIR, Planner, Redactor, SqliteStateStore, Verifier, createLogger, loadHarnessConfig, loadProfile, loadWorkflow } from "@harness/core";
import { AgentExecutor, ExecutorRegistry, ScriptExecutor } from "@harness/executors";
import { FakeAgentRuntime, fakeScriptCommands } from "@harness/adapter-fake";
import { Worker } from "@harness/worker";

function worker(dir: string, clock: FixedClock, owner: string, script?: Executor) {
  const store = new SqliteStateStore(join(dir, "state.db"), clock); store.migrate(MIGRATIONS_DIR);
  const planner = new Planner(store); const registry = new ArtifactRegistry(store, dir);
  const executors = new ExecutorRegistry();
  executors.register("script", script ?? new ScriptExecutor(fakeScriptCommands())); executors.register("agent", new AgentExecutor(new FakeAgentRuntime()));
  const project = ProjectConfigSchema.parse({ schema_version: "harness.project/v1", project_id: "p", template_release: "0.1.0", runtime: "claude", data_root: dir, portfolios: [{ portfolio_id: "pf", display_name: "x" }] });
  const w = new Worker({ store, planner, controller: new Controller({ store, registry, planner, clock }), registry, verifier: new Verifier(BUILTIN_CHECKERS), executors, harness: loadHarnessConfig(HARNESS_ROOT), project, dataRoot: dir, owner, capabilities: ["write_workspace", "read_source"], logger: createLogger({ redactor: new Redactor(() => []), sink: () => {}, level: "error" }), clock });
  return { store, planner, w };
}

describe("18.3 #2 and #3 worker dies mid-render; lease expires; old worker cannot commit", () => {
  it("second worker reruns safely and the late result is fenced out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acc-")); const clock = new FixedClock("2026-09-11T00:00:00.000Z");
    let finishLate!: () => void;
    const hanging: Executor = { version: "hang", execute: () => new Promise<StageResult>((res) => { finishLate = () => res({ schema_version: "harness.stage-result/v1", attempt_id: "attempt_01J00000000000000000000000", outcome: "succeeded", outputs: [], checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [] }); }) };
    const dead = worker(dir, clock, "dead", hanging);
    const run = dead.planner.plan({ workflow: loadWorkflow(HARNESS_ROOT, "sample-three-stage@1.0.0"), profile: loadProfile(HARNESS_ROOT, "cartoon"), harness: loadHarnessConfig(HARNESS_ROOT), projectId: "p", portfolioId: "pf" });
    for (const s of dead.store.listStageRuns(run.run_id)) dead.store.updateStageRun({ ...s, retry: { ...s.retry, backoff_seconds: [0, 0, 0] } });
    dead.planner.enqueue(run.run_id);
    const late = dead.w.runOnce();
    await new Promise((r) => setTimeout(r, 50));
    expect(dead.store.getLease(dead.store.listStageRuns(run.run_id)[0]!.stage_run_id)?.owner).toBe("dead");
    clock.advance(91);
    const alive = worker(dir, clock, "alive");
    while ((await alive.w.runOnce()) !== "idle") { /* drain */ }
    finishLate();
    expect(await late).toBe("lost");
    const produce = alive.store.listStageRuns(run.run_id).find((s) => s.stage_key === "produce")!;
    expect(alive.store.listAttempts(produce.stage_run_id).map((a) => [a.lease_owner, a.state, a.fencing_token])).toEqual([["dead", "ABANDONED", 1], ["alive", "SUCCEEDED", 2]]);
    expect(alive.store.getRun(run.run_id)?.state).toBe("SUCCEEDED");
    expect(alive.store.listArtifacts({ run_id: run.run_id, status: "ACCEPTED" })).toHaveLength(3);
  });
});
```

`tests/acceptance/05-provisional-never-visible.test.ts` (mục 5):

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type Artifact } from "@harness/contracts";
import { acceptedInputsFor, FixedClock, MIGRATIONS_DIR, SqliteStateStore } from "@harness/core";

describe("18.3 #5 distribution never reads PROVISIONAL artifacts", () => {
  it("acceptedInputsFor filters by ACCEPTED even when PROVISIONAL and REJECTED rows exist upstream", () => {
    const dir = mkdtempSync(join(tmpdir(), "acc-"));
    const store = new SqliteStateStore(join(dir, "state.db"), new FixedClock("2026-09-11T00:00:00.000Z")); store.migrate(MIGRATIONS_DIR);
    const now = "2026-09-11T00:00:00.000Z"; const sha = "sha256:" + "a".repeat(64);
    const runId = newId("run");
    store.insertRun({ schema_version: "harness.run/v1", run_id: runId, project_id: "p", portfolio_id: "pf", workflow_release: { id: "w", version: "1.0.0", digest: sha }, profile_snapshot: { id: "cartoon", revision: 1 }, state: "RUNNING", effective_config_snapshot: {}, effective_config_digest: sha, total_cost_usd: 0, created_at: now, updated_at: now });
    const mk = (key: string, deps: string[]) => { const s = { schema_version: "harness.stage-run/v1" as const, stage_run_id: newId("stage_run"), run_id: runId, stage_key: key, executor: { type: "script" as const, script: "x" }, depends_on: deps, required_capabilities: [], required_checks: [], retry: { max_attempts: 1, backoff_seconds: [0], retry_on: [] }, stage_config: {}, state: "PENDING" as const, attempt_count: 0, result_failures: 0, created_at: now, updated_at: now }; store.insertStageRun(s); return s; };
    const up = mk("produce", []); const down = mk("finalize", ["produce"]);
    const art = (status: Artifact["status"]): Artifact => ({ schema_version: "harness.artifact/v1", artifact_id: newId("artifact"), run_id: runId, stage_run_id: up.stage_run_id, attempt_id: newId("attempt"), type: "t", status, uri: "file:///x", checksum: sha, size_bytes: 1, mime_type: "text/plain", lineage: { input_artifacts: [], source_items: [] }, reproducibility: { workflow_release: "w@1.0.0", production_profile: "cartoon@1", channel_config_revision: null, executor_version: "x", model_parameters_digest: null }, checks: [], created_at: now, updated_at: now });
    for (const s of ["PROVISIONAL", "REJECTED", "ACCEPTED", "STALE"] as const) store.insertArtifact(art(s));
    const visible = acceptedInputsFor(store, down);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.status).toBe("ACCEPTED");
  });
});
```

`tests/acceptance/10-unknown-config-key.test.ts` (mục 10):

```ts
import { describe, expect, it } from "vitest";
import { cli, freshProject } from "./helpers.js";

describe("18.3 #10 unknown config key fails validation before anything runs", () => {
  it("plan exits 1 with UNKNOWN_CONFIG_KEY and creates no run", () => {
    const p = freshProject();
    const r = cli(p, ["plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--override", "lease_secondz=5"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/UNKNOWN_CONFIG_KEY.*lease_secondz/);
    expect(cli(p, ["events", "tail", "--json"]).out).toBe("[]");
  });
});
```

`tests/acceptance/11-secret-never-leaks.test.ts` (mục 11):

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, freshProject, planRun } from "./helpers.js";

describe("18.3 #11 secrets never appear in snapshot, events or logs", () => {
  it("resolved secret value is absent from every persisted and printed surface", () => {
    const p = freshProject();
    const env = { HARNESS_SECRET_YOUTUBE_CHANNEL_01: "yt-secret-value-XYZ", HARNESS_LOG_LEVEL: "debug" };
    const plan = cli(p, ["plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--json"], env);
    const { run_id } = JSON.parse(plan.out.split("\n").at(-1)!);
    cli(p, ["enqueue", run_id], env);
    for (let i = 0; i < 6; i++) { const w = cli(p, ["worker", "--once"], env); expect(w.out + w.err).not.toContain("yt-secret-value-XYZ"); if (w.out.includes("idle")) break; }
    const status = cli(p, ["status", run_id, "--json"], env);
    const events = cli(p, ["events", "tail", "--run", run_id, "--json", "--limit", "1000"], env);
    expect(status.out + status.err + events.out + events.err).not.toContain("yt-secret-value-XYZ");
    const projectYaml = readFileSync(join(p, "project.yaml"), "utf8");
    expect(projectYaml).not.toContain("yt-secret-value-XYZ");
    expect(planRun).toBeDefined();
  });
});
```

`tests/acceptance/15-fresh-worker-from-state.test.ts` (mục 15):

```ts
import { describe, expect, it } from "vitest";
import { cli, freshProject, planRun, status } from "./helpers.js";

describe("18.3 #15 a brand-new scheduled worker needs only project path + capabilities", () => {
  it("each worker --once is a fresh process that takes work from the state store alone", () => {
    const p = freshProject();
    const runId = planRun(p);
    const owners: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = cli(p, ["worker", "--once", "--owner", `sched-${i}`]);
      expect(r.code, r.err).toBe(0);
      if (r.out.includes("idle")) break;
      owners.push(`sched-${i}`);
    }
    expect(owners).toEqual(["sched-0", "sched-1", "sched-2"]);
    const s = status(p, runId);
    expect(s.run.state).toBe("SUCCEEDED");
    expect(s.stages.map((st) => st.attempts[0]!.lease_owner)).toEqual(["sched-0", "sched-1", "sched-2"]);
  });
});
```

- [ ] **Step 3: Chạy toàn bộ, xác nhận pass**

Run: `pnpm test`
Expected: PASS mọi package và `tests/`. Nếu test 01 thấy 0 hoặc 2 "done": kiểm tra `claim()` có nằm trong `BEGIN IMMEDIATE` và `PRAGMA busy_timeout` có được set (Task 4, 6).

- [ ] **Step 4: Commit**

```bash
git add tests package.json pnpm-lock.yaml
git commit -m "test: add system acceptance tests for blueprint 18.3 items 1, 2, 3, 5, 10, 11, 15

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 17: AGENTS.md, CLAUDE.md, README, ADR và báo cáo Definition of Done

**Files:**
- Create: `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/adr/0001-control-plane-baseline.md`, `docs/runbooks/reconcile-and-retry.md`

**Interfaces:**
- Consumes: mọi CLI command Task 15.
- Produces: tài liệu cho agent/người vận hành; không có code.

- [ ] **Step 1: Viết `AGENTS.md`**

```markdown
# AGENTS.md — nguyên tắc cho mọi agent làm việc trong repo này

## Repo này là gì
YouTube Operations Harness: control plane điều phối sản xuất và phân phối video nhiều kênh. Session/agent là **worker tạm thời**; **state store là nguồn sự thật**. Đọc `docs/superpowers/specs/` trước khi đổi kiến trúc.

## Cách tìm việc
- Việc vận hành nằm trong state store của một operations project: `harness --project <dir> status <run_id>` hoặc `harness worker --once`.
- Việc phát triển: `docs/superpowers/plans/*.md`, làm theo từng task, mỗi task một commit.

## Lệnh chuẩn
- Cài: `corepack enable && pnpm install`
- Test: `pnpm test` (toàn bộ), `pnpm vitest run packages/<pkg>` (một package)
- Typecheck: `pnpm -r typecheck` · Build: `pnpm build` · Sinh JSON Schema: `pnpm gen:schemas`
- CLI dev: `pnpm harness --project fixtures/ops-project-minimal <command>`

## Giới hạn quyền
- Không sửa cột `state` ngoài `transition()` và `claim()` trong `packages/core/src/state/`.
- Không import `adapters/*` hay `agent-runtime/*` từ `packages/core`.
- Không ghi giá trị secret vào file, event, log, manifest; chỉ dùng `secret://scope/name`.
- Không gọi mạng hay LLM trong test.
- Không upload/publish thật khi chưa có adapter YouTube ở sub-project 3; mọi thứ hiện là adapter giả.

## Quy tắc artifact
- Worker ghi vào `workspaces/<run>/<stage>/<attempt>/output/`. Controller mới chuyển vào `artifacts/` và đánh dấu ACCEPTED.
- Downstream chỉ đọc artifact ACCEPTED (`acceptedInputsFor`).
- Mọi artifact có `manifest.json` cạnh file, checksum sha256, lineage.

## Cách commit state
- Mọi kết quả stage đi qua `Controller.commit()` với fencing token của attempt hiện tại.
- Kết quả không rõ (mất kết nối sau dispatch) → `NEEDS_RECONCILIATION`; chạy `harness reconcile <run_id>` trước khi retry.

## Định nghĩa hoàn thành cho một task phát triển
1. Test viết trước, fail, rồi pass. 2. `pnpm -r typecheck` sạch. 3. Commit theo Conventional Commits. 4. Không để lại TODO/placeholder.
```

`CLAUDE.md`:

```markdown
Đọc và tuân thủ `AGENTS.md` ở cùng thư mục. File này chỉ là con trỏ để Claude Code nạp cùng nguyên tắc với Codex.
```

- [ ] **Step 2: Viết `README.md`**

```markdown
# YouTube Operations Harness

Control plane cho sản xuất và phân phối video nhiều kênh: state store SQLite, state machine Run/StageRun/Attempt, claim/lease/fencing, artifact manifest, worker, CLI.

## Bắt đầu
```bash
corepack enable && pnpm install
pnpm test
pnpm harness --project fixtures/ops-project-minimal db migrate
pnpm harness --project fixtures/ops-project-minimal plan --workflow sample-three-stage@1.0.0 --profile cartoon
pnpm harness --project fixtures/ops-project-minimal enqueue <run_id>
pnpm harness --project fixtures/ops-project-minimal worker --once
pnpm harness --project fixtures/ops-project-minimal status <run_id>
```

## Tài liệu
- Blueprint: `docs/architecture/YOUTUBE_OPERATIONS_HARNESS_BLUEPRINT_v1.0.md`
- Spec: `docs/superpowers/specs/2026-09-11-harness-structure-and-control-plane-design.md`
- Plan sub-project 1: `docs/superpowers/plans/2026-09-11-control-plane-minimal.md`
- ADR: `docs/adr/`
- Runbook: `docs/runbooks/`

## Trạng thái
Sub-project 1 (control plane, adapter giả). Chưa nối script sản xuất thật, chưa nối YouTube.
```

- [ ] **Step 3: Viết ADR và runbook**

`docs/adr/0001-control-plane-baseline.md`:

```markdown
# ADR-0001: Baseline control plane

**Ngày:** 2026-09-11 · **Trạng thái:** Accepted

## Bối cảnh
Blueprint v1.0 định nghĩa harness đa kênh, đa profile, đa worker. Hệ thống cũ chạy bằng phiên Claude Code tương tác và script Node `.mjs` trên máy khác.

## Quyết định
1. Stack TypeScript/Node 22, pnpm monorepo, Zod, Vitest.
2. State store: SQLite WAL qua `node:sqlite` (có sẵn trong Node 22.13+, không cần build native). `better-sqlite3` là phương án thay sau interface `StateStore`.
3. Mỗi entity một bảng document (`id`, `state`, `data` JSON) cộng bảng `lease`; index theo cột nghiệp vụ cần lọc.
4. Mọi đổi trạng thái đi qua `transition()` (kiểm bảng transition + ghi event, một transaction) hoặc `claim()`.
5. Fencing token tăng theo attempt của một stage; mọi commit kết quả kiểm token.
6. Agent runtime trung lập, chọn theo `project.yaml` (`claude` | `codex`).
7. Profile đặt tên theo phong cách sản xuất: `cartoon`, `avatar`, `footage`.
8. Mỗi máy một state store; không chia sẻ state giữa máy ở v1.
9. Bổ sung so với blueprint §9: `VERIFYING → WAITING_HUMAN` (lỗi hợp đồng), `NEEDS_RECONCILIATION → READY` (reconcile xong thì attempt mới), `CLAIMED|RUNNING|VERIFYING → READY|FAILED` (lease hết hạn).

## Hệ quả
- Script cũ được bọc qua giao thức file `stage-request.json` / `stage-result.json` trong workspace (sub-project 2).
- Chuyển sang Postgres/object storage chỉ cần implementation mới của `StateStore` và `ArtifactRegistry`.
```

`docs/runbooks/reconcile-and-retry.md`:

```markdown
# Runbook: reconcile, retry, lease

## Stage ở NEEDS_RECONCILIATION
1. `harness status <run_id>` để xem stage và external operation.
2. `harness reconcile <run_id>`: hỏi provider theo idempotency key. CONFIRMED → stage về READY, worker sẽ tái sử dụng operation đã confirm, không dispatch lại. FAILED → stage vẫn cần người xem xét; sau đó `harness retry <run_id> --stage <key>`.
3. Không bao giờ `retry` trước khi `reconcile`.

## Stage ở WAITING_HUMAN
Nguyên nhân: kết quả sai schema, checker thiếu, hoặc fencing bị từ chối. Xem `harness events tail --run <run_id>`, sửa nguyên nhân (workflow, checker, script), rồi `harness retry <run_id> --stage <key>`.

## Worker chết giữa chừng
Không cần làm gì: lease hết sau `lease_seconds` (mặc định 90s), worker kế tiếp gọi `reapExpiredLeases` rồi claim lại. Ép ngay: `harness leases reap`.

## Run FAILED
Run FAILED là terminal. Tạo run mới bằng `harness plan`; lineage vẫn truy vết được qua state store.

## Dọn workspace
`harness workspaces prune [--days N]` xóa workspace attempt cũ hơn retention và không còn lease.
```

- [ ] **Step 4: Kiểm tra lại toàn bộ và commit**

Run: `pnpm -r typecheck && pnpm test && pnpm build`
Expected: PASS toàn bộ.

```bash
git add AGENTS.md CLAUDE.md README.md docs/adr docs/runbooks
git commit -m "docs: add AGENTS.md, README, ADR-0001 and reconcile/retry runbook

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 5: Báo cáo Definition of Done (spec B.14)**

Viết báo cáo ngắn trong chat (không cần file) gồm: danh sách file đã tạo theo package; contract đã khóa (28 JSON schema); số test đã chạy và kết quả `pnpm test`; các mục 18.3 đã phủ (1, 2, 3, 5, 10, 11, 15); rủi ro còn lại (mime type cố định trong worker, external operation chỉ có ở agent executor, chưa có scheduler); và xác nhận sub-project 2 chỉ bắt đầu khi tất cả acceptance test pass.

---

## Tự rà soát plan

**Phủ spec (Phần B):**
- B.3 contract → Task 1, 2, 3. B.4 state store → Task 4. B.5 state machine → Task 5 (+ bổ sung Task 6). B.6 claim/lease/fencing → Task 6. B.7 planner/worker/executor/verifier/controller → Task 9, 13, 11, 10, 12. B.8 workspace → Task 8. B.9 xử lý lỗi → Task 12 (bảng phân loại), Task 6 (abandoned), Task 14 (unknown/reconcile). B.10 CLI → Task 15. B.11 config/secret → Task 7, 9, 15. B.12 observability → Task 4 (event), Task 7 (logger/redaction), Task 12 (cost). B.13 kiểm thử → test trong mỗi task + Task 16. B.14 DoD → Task 17.
- Điểm không làm đúng nguyên văn spec: dùng `node:sqlite` thay `better-sqlite3` (spec cho phép ở mục Rủi ro); `pino` bị bỏ vì logger tự viết đủ nhu cầu redaction. Cả hai ghi trong ADR-0001.

**Tính nhất quán tên gọi đã kiểm:** `store.claim/heartbeat/getLease/releaseLease/reapExpiredLeases/assertFencing/listExternalOperations` (Task 6, 14) khớp interface Task 3 sau hai lần bổ sung; `eventFor` (Task 9) dùng ở Task 12, 13, 14, 15; `acceptedInputsFor`, `materializeInputs`, `createWorkspace` (Task 8) dùng ở Task 13; `fakeScriptCommands`, `FakeAgentRuntime({ journal })`, `FakeProvider` (Task 11) dùng ở Task 13, 14, 15; `stage_config.__script/__skill/__brief` do worker đặt (Task 13) và executor đọc (Task 11).

**Placeholder:** không có TBD/TODO. Hai chỗ nói "như Task 4" cho `tsconfig.json`/`vitest.config.ts` là lặp cấu hình đã in đầy đủ ở Task 4 và 11.

**Lưu ý cho người thực thi:**
- Windows: đường dẫn trong test dùng `join()`; `materializeInputs` chuẩn hóa `\\` thành `/` cho `StageInput.path`.
- `node:sqlite` in `ExperimentalWarning` trên Node 22; có thể tắt bằng `NODE_OPTIONS=--no-warnings` khi chạy test.
- Nếu `--import tsx` không hoạt động trong child process, thay bằng `tsx` binary từ `node_modules/.bin/tsx` (giữ cùng argv).
