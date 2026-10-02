/**
 * The Studio worker (GĐ2): a harness `Worker` over ag-studio-series-plan and ag-studio-episode
 * with every executor — in-process stages, Claude (structured, subscription), gates, and ag-farm.
 */
import { CliAgentRuntime } from "@harness/adapter-agent-cli";
import { createLogger, Redactor, type HarnessLogger } from "@harness/core";
import { ExecutorRegistry, FarmExecutor, GateExecutor, InProcessExecutor, makeStudioFarmRecorder, StudioAgentExecutor } from "@harness/executors";
import { Worker } from "@harness/worker";
import type { FarmOwnerClient } from "@ag-farm/owner-client";
import type { AgentCallTrace, ProjectConfig, StudioSkill } from "@harness/contracts";
import { farmStorage, type StudioBucket } from "./bucket.js";
import { recordLlmCall } from "./llm-log.js";
import { cancelLegacyRuns, STUDIO_PORTFOLIO_ID, STUDIO_PROJECT_ID, STUDIO_RESOURCES, STUDIO_WORKFLOWS, type StudioEngineCore } from "./core.js";
import { studioPayloadBuilders } from "./payloads.js";
import { isRunActive, startEpisodeRun } from "./run-control.js";
import { studioStages, type FootageCatalogSource } from "./stages.js";
import { teamGuidesForRun } from "./team-skills.js";
import type { StudioDb } from "./studio-db.js";
import type { ResearchSource } from "./youtube-research.js";

/** Per-skill model env keys. `STUDIO_CLAUDE_MODEL` overrides all. */
const SKILL_MODEL_ENVS: Record<StudioSkill, string> = {
  "studio-plan-episodes": "STUDIO_CLAUDE_MODEL_PLAN_EPISODES",
  "studio-youtube-kit": "STUDIO_CLAUDE_MODEL_YOUTUBE_KIT",
  "studio-trend-report": "STUDIO_CLAUDE_MODEL_TREND_REPORT",
};
const SKILL_DEFAULTS: Record<StudioSkill, string> = {
  "studio-plan-episodes": "claude-opus-5-5",
  "studio-youtube-kit": "claude-sonnet-5-5",
  "studio-trend-report": "claude-sonnet-5-5",
};

function modelFor(skill: StudioSkill, override?: string): string {
  if (override) return override;
  const envKey = SKILL_MODEL_ENVS[skill];
  const envVal = envKey ? process.env[envKey] : undefined;
  return envVal ?? SKILL_DEFAULTS[skill];
}

export interface StudioClaudeOptions {
  skillsDir: string;
  /** Global override: applies to all skills when set. */
  model?: string;
  maxTurns?: number;
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
  /** YouTube research for the `research` stage (GĐ5); without it the stage records why nothing was fetched. */
  research?: ResearchSource;
}

export function studioLogger(bindings: Record<string, unknown> = {}): HarnessLogger {
  return createLogger({ redactor: new Redactor(() => []), sink: (l) => process.stderr.write(l + "\n"), bindings: { service: "studio-worker", ...bindings } });
}

export function createStudioWorker(o: StudioWorkerOptions): Worker {
  const { core } = o;
  // Cancel runs from old workflows (segment-based) so they don't block new ones
  cancelLegacyRuns(core);
  const executors = new ExecutorRegistry();
  executors.register("script", new InProcessExecutor(studioStages({
    db: o.db, bucket: o.bucket, footage: o.footage,
    startEpisodeRun: (episodeId) => Promise.resolve(startEpisodeRun(core, o.db, episodeId)),
    isRunActive: (runId) => isRunActive(core, runId),
    ...(o.research ? { research: o.research } : {}),
  })));
  executors.register("agent", new StudioAgentExecutor({
    runtimeFor: (jsonSchema: string, skill?: StudioSkill, onCall?: (trace: AgentCallTrace) => void) => new CliAgentRuntime({
      runtime: "claude", skillsDir: o.claude.skillsDir,
      structured: { jsonSchema, model: modelFor(skill ?? "studio-plan-episodes", o.claude.model), maxTurns: o.claude.maxTurns ?? 3 },
      ...(o.claude.argv ? { argv: o.claude.argv } : {}),
      ...(o.claude.baseEnv ? { baseEnv: o.claude.baseEnv } : {}),
      ...(onCall ? { onCall } : {}),
    }),
    recordCall: async (call) => { await recordLlmCall(o.db, o.bucket, call); },
    teamGuidesFor: (request) => teamGuidesForRun(o.db, request.run_id),
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
    resources: STUDIO_RESOURCES, source: { materialize: "link" }, workflows: Object.values(STUDIO_WORKFLOWS).map((f) => f.workflow),
  } as unknown as ProjectConfig;
  return new Worker({
    store: core.store, planner: core.planner, controller: core.controller, registry: core.registry, verifier: core.verifier, executors,
    harness: core.harness, project, dataRoot: core.dataRoot, owner: o.owner, capabilities: [], logger: o.logger ?? studioLogger({ owner: o.owner }),
    clock: core.clock, workflows: core.workflows, profiles: core.profiles, resourceCapacity: STUDIO_RESOURCES,
  });
}
