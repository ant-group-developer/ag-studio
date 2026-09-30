/**
 * The Studio worker: a harness `Worker` over `ag-studio-production@1.0.0` with every executor the workflow
 * uses -- in-process stages, Claude (structured, subscription), gates, and ag-farm.
 */
import { CliAgentRuntime } from "@harness/adapter-agent-cli";
import { createLogger, Redactor, type HarnessLogger } from "@harness/core";
import { ExecutorRegistry, FarmExecutor, GateExecutor, InProcessExecutor, makeStudioFarmRecorder, StudioAgentExecutor } from "@harness/executors";
import { Worker } from "@harness/worker";
import type { FarmOwnerClient } from "@ag-farm/owner-client";
import type { ProjectConfig } from "@harness/contracts";
import { farmStorage, type StudioBucket } from "./bucket.js";
import { STUDIO_FLOWS, STUDIO_PORTFOLIO_ID, STUDIO_PROJECT_ID, STUDIO_RESOURCES, type StudioEngineCore } from "./core.js";
import { studioPayloadBuilders } from "./payloads.js";
import { studioStages, type FootageCatalogSource } from "./stages.js";
import type { StudioDb } from "./studio-db.js";

export interface StudioClaudeOptions {
  /** `skills/` of the Studio install. */
  skillsDir: string;
  /** Default `claude-opus-5-5`. */
  model?: string;
  maxTurns?: number;
  /** Test seam: replaces `claude -p ...` (the `--json-schema` argument is still appended). */
  argv?: string[];
  baseEnv?: Record<string, string | undefined>;
  rateLimitBackoffMs?: number[];
}

export interface StudioWorkerOptions {
  core: StudioEngineCore;
  db: StudioDb;
  dbPath: string;
  bucket: StudioBucket;
  footage: FootageCatalogSource;
  farm: FarmOwnerClient;
  claude: StudioClaudeOptions;
  owner: string;
  logger?: HarnessLogger;
  farmPollMs?: number;
}

export function studioLogger(bindings: Record<string, unknown> = {}): HarnessLogger {
  return createLogger({ redactor: new Redactor(() => []), sink: (l) => process.stderr.write(l + "\n"), bindings: { service: "studio-worker", ...bindings } });
}

export function createStudioWorker(o: StudioWorkerOptions): Worker {
  const { core } = o;
  const executors = new ExecutorRegistry();
  executors.register("script", new InProcessExecutor(studioStages({ db: o.db, bucket: o.bucket, footage: o.footage })));
  executors.register("agent", new StudioAgentExecutor({
    runtimeFor: (jsonSchema) => new CliAgentRuntime({
      runtime: "claude", skillsDir: o.claude.skillsDir,
      structured: { jsonSchema, model: o.claude.model ?? "claude-opus-5-5", maxTurns: o.claude.maxTurns ?? 3 },
      ...(o.claude.argv ? { argv: o.claude.argv } : {}),
      ...(o.claude.baseEnv ? { baseEnv: o.claude.baseEnv } : {}),
    }),
    ...(o.claude.rateLimitBackoffMs ? { rateLimitBackoffMs: o.claude.rateLimitBackoffMs } : {}),
  }));
  executors.register("gate", new GateExecutor());
  executors.register("farm", new FarmExecutor({
    client: o.farm,
    storage: farmStorage(o.bucket),
    onSubmitted: makeStudioFarmRecorder(o.dbPath),
    payloadBuilders: studioPayloadBuilders({ db: o.db, bucket: o.bucket }),
    pollIntervalMs: o.farmPollMs ?? 5000,
  }));
  const project = {
    schema_version: "harness.project-config/v1", project_id: STUDIO_PROJECT_ID, template_release: "0.1.0", runtime: "claude",
    data_root: core.dataRoot, portfolios: [{ portfolio_id: STUDIO_PORTFOLIO_ID, display_name: "AG Studio" }],
    resources: STUDIO_RESOURCES, source: { materialize: "link" }, workflows: Object.values(STUDIO_FLOWS).map((f) => f.workflow),
  } as unknown as ProjectConfig;
  return new Worker({
    store: core.store, planner: core.planner, controller: core.controller, registry: core.registry, verifier: core.verifier, executors,
    harness: core.harness, project, dataRoot: core.dataRoot, owner: o.owner, capabilities: [], logger: o.logger ?? studioLogger({ owner: o.owner }),
    clock: core.clock, workflows: core.workflows, profiles: core.profiles, resourceCapacity: STUDIO_RESOURCES,
  });
}
