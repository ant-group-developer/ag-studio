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
import { cancelLegacyRuns, STUDIO_PORTFOLIO_ID, STUDIO_PROJECT_ID, studioResources, studioWorkflowRefs, type StudioEngineCore } from "./core.js";
import { studioPayloadBuilders } from "./payloads.js";
import { isRunActive, startEpisodeRun } from "./run-control.js";
import { studioStages, type FootageCatalogSource } from "./stages.js";
import { teamGuidesForRun } from "./team-skills.js";
import type { StudioDb } from "./studio-db.js";
import type { ResearchSource } from "./youtube-research.js";
import type { ThumbnailRenderer } from "./thumbnail-render.js";

/** Per-skill model env keys. `STUDIO_CLAUDE_MODEL` overrides all. */
const SKILL_MODEL_ENVS: Record<StudioSkill, string> = {
  "studio-plan-episodes": "STUDIO_CLAUDE_MODEL_PLAN_EPISODES",
  "studio-youtube-kit": "STUDIO_CLAUDE_MODEL_YOUTUBE_KIT",
  "studio-trend-report": "STUDIO_CLAUDE_MODEL_TREND_REPORT",
  "studio-rnd": "STUDIO_CLAUDE_MODEL_RND",
  "studio-branding": "STUDIO_CLAUDE_MODEL_BRANDING",
};
/** The R&D decides the whole series once per production: Opus, like the episode plan. */
const SKILL_DEFAULTS: Record<StudioSkill, string> = {
  "studio-plan-episodes": "claude-opus-5-5",
  "studio-youtube-kit": "claude-sonnet-5-5",
  "studio-trend-report": "claude-sonnet-5-5",
  "studio-rnd": "claude-opus-5-5",
  "studio-branding": "claude-sonnet-5-5",
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
  /** Cuts and draws thumbnails (`thumbnails` stage of episode 1.2.0); without it that stage parks for a person. */
  thumbnails?: ThumbnailRenderer;
  /** Claude calls run at once across this worker's loops; default `DEFAULT_CLAUDE_MAX_CONCURRENT` (20). */
  claudeMaxConcurrent?: number;
}

export function studioLogger(bindings: Record<string, unknown> = {}): HarnessLogger {
  return createLogger({ redactor: new Redactor(() => []), sink: (l) => process.stderr.write(l + "\n"), bindings: { service: "studio-worker", ...bindings } });
}

function buildWorkers(o: StudioWorkerOptions, count: number): Worker[] {
  const { core } = o;
  // Cancel runs from old workflows (segment-based) so they don't block new ones
  cancelLegacyRuns(core);
  const executors = new ExecutorRegistry();
  executors.register("script", new InProcessExecutor(studioStages({
    db: o.db, bucket: o.bucket, footage: o.footage,
    startEpisodeRun: (episodeId) => Promise.resolve(startEpisodeRun(core, o.db, episodeId)),
    isRunActive: (runId) => isRunActive(core, runId),
    ...(o.research ? { research: o.research } : {}),
    ...(o.thumbnails ? { thumbnails: o.thumbnails } : {}),
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
  const resources = studioResources(o.claudeMaxConcurrent);
  const project = {
    schema_version: "harness.project-config/v1", project_id: STUDIO_PROJECT_ID, template_release: "0.1.0", runtime: "claude",
    data_root: core.dataRoot, portfolios: [{ portfolio_id: STUDIO_PORTFOLIO_ID, display_name: "AG Studio" }],
    resources, source: { materialize: "link" }, workflows: studioWorkflowRefs(core.harnessRoot),
  } as unknown as ProjectConfig;
  return Array.from({ length: count }, (_, i) => {
    const owner = count === 1 ? o.owner : `${o.owner}#${i + 1}`;
    return new Worker({
      store: core.store, planner: core.planner, controller: core.controller, registry: core.registry, verifier: core.verifier, executors,
      harness: core.harness, project, dataRoot: core.dataRoot, owner, capabilities: [], logger: o.logger ?? studioLogger({ owner }),
      clock: core.clock, workflows: core.workflows, profiles: core.profiles, resourceCapacity: resources,
    });
  });
}

/** One worker loop: claims and runs one stage at a time. */
export function createStudioWorker(o: StudioWorkerOptions): Worker {
  return buildWorkers(o, 1)[0]!;
}

export interface StudioWorkerPool {
  workers: Worker[];
  runForever(signal: AbortSignal): Promise<void>;
}

/**
 * Enough worker loops to fill every resource at once (`claude` + `farm` + `cpu`), sharing one store and one set of
 * executors. One loop runs one stage at a time and a farm stage holds its loop until the render is done, so a
 * single loop would serialize every production; with a pool, `claude` capacity alone decides how many Claude
 * calls run together. Loops coordinate through `claim()`/leases exactly like separate worker processes.
 */
export function createStudioWorkerPool(o: StudioWorkerOptions): StudioWorkerPool {
  const r = studioResources(o.claudeMaxConcurrent);
  const workers = buildWorkers(o, r.claude + r.farm + r.cpu);
  return { workers, runForever: async (signal) => { await Promise.all(workers.map((w) => w.runForever(signal))); } };
}
