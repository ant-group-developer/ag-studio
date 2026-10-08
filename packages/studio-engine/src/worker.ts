/**
 * The Studio worker (GĐ2): a harness `Worker` over ag-studio-series-plan and ag-studio-episode
 * with every executor — in-process stages, Claude (structured, subscription), gates, and ag-farm.
 */
import { CliAgentRuntime } from "@harness/adapter-agent-cli";
import { createLogger, Redactor, type HarnessLogger } from "@harness/core";
import { ExecutorRegistry, FarmExecutor, GateExecutor, InProcessExecutor, makeStudioFarmRecorder, StudioAgentExecutor } from "@harness/executors";
import { Worker } from "@harness/worker";
import type { FarmOwnerClient } from "@ag-farm/owner-client";
import { STUDIO_FILE_SKILLS, type AgentCallTrace, type ProjectConfig, type StudioSkill } from "@harness/contracts";
import { farmStorage, type StudioBucket } from "./bucket.js";
import { modelFor } from "./models.js";
import { saveAgentSession } from "./agent-sessions.js";

/** Tools of a files-mode stage: read and write its workspace, nothing else (no Bash, no web). */
export const STUDIO_FILE_TOOLS = ["Read", "Write", "Glob", "Grep"] as const;
/** Turns of a files-mode call: opening a few dozen contact sheets and frames, then writing the answer. */
export const STUDIO_FILES_MAX_TURNS = 60;
import { createChatRunner, type ChatRunner } from "./chat-runner.js";
import { chatFeedback } from "./chat-db.js";
import { recordLlmCall } from "./llm-log.js";
import { cancelLegacyRuns, DEFAULT_CLAUDE_MAX_CONCURRENT, STUDIO_PORTFOLIO_ID, STUDIO_PROJECT_ID, studioResources, studioWorkflowRefs, type StudioEngineCore } from "./core.js";
import { claudeMaxConcurrent } from "./settings.js";
import { renderChoiceRequirements } from "./render-choice.js";
import { studioPayloadBuilders } from "./payloads.js";
import { isRunActive, startEpisodeRun } from "./run-control.js";
import type { FootageCatalogSource } from "./stages.js";
import { cutPayloadBuilders, studioInProcessStages, type CutMediaDeps } from "./cut-stages.js";
import { teamGuidesForRun } from "./team-skills.js";
import { sweepStudioData, type RetentionConfig } from "./cleanup.js";
import { earlierFarmJobs, type StudioDb } from "./studio-db.js";
import type { ResearchSource } from "./youtube-research.js";
import type { ThumbnailRenderer } from "./thumbnail-render.js";

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
  /** ffmpeg, ag-go resolve and downloads for the shot-cut stages; without it those stages park for a person. */
  media?: CutMediaDeps;
  /** A farm job taken by no node this long is cancelled and its stage stops, saying so (none: wait to the deadline). */
  farmQueueTimeoutMs?: number;
  /** Claude calls run at once across this worker's loops; default `DEFAULT_CLAUDE_MAX_CONCURRENT` (20). */
  claudeMaxConcurrent?: number;
}

export function studioLogger(bindings: Record<string, unknown> = {}): HarnessLogger {
  return createLogger({ redactor: new Redactor(() => []), sink: (l) => process.stderr.write(l + "\n"), bindings: { service: "studio-worker", ...bindings } });
}

/** Makes worker loops that share one set of executors; `next()` names each new loop after the last one. */
function workerFactory(o: StudioWorkerOptions, single: boolean): { next: () => Worker; capacity: () => { claude: number; farm: number; cpu: number } } {
  const { core } = o;
  // Cancel runs from old workflows (segment-based) so they don't block new ones
  cancelLegacyRuns(core);
  const executors = new ExecutorRegistry();
  executors.register("script", new InProcessExecutor(studioInProcessStages({
    db: o.db, bucket: o.bucket, footage: o.footage,
    startEpisodeRun: (episodeId, workflow) => Promise.resolve(startEpisodeRun(core, o.db, episodeId, { workflow })),
    isRunActive: (runId) => isRunActive(core, runId),
    ...(o.research ? { research: o.research } : {}),
    ...(o.thumbnails ? { thumbnails: o.thumbnails } : {}),
    ...(o.media ? { media: o.media } : {}),
  })));
  executors.register("agent", new StudioAgentExecutor({
    runtimeFor: (jsonSchema: string, skill?: StudioSkill, onCall?: (trace: AgentCallTrace) => void, files?: { resume?: string }) => {
      const model = modelFor(skill ?? "studio-plan-episodes", o.claude.model);
      // the scene selection looks at contact sheets: files mode, session kept (ADR item 155); every other skill: no tools
      const mode = skill && STUDIO_FILE_SKILLS.has(skill)
        ? { files: { model, maxTurns: STUDIO_FILES_MAX_TURNS, tools: [...STUDIO_FILE_TOOLS], ...(files?.resume ? { resume: files.resume } : {}) } }
        : { structured: { jsonSchema, model, maxTurns: o.claude.maxTurns ?? 3 } };
      return new CliAgentRuntime({
        runtime: "claude", skillsDir: o.claude.skillsDir, ...mode,
        ...(o.claude.argv ? { argv: o.claude.argv } : {}),
        ...(o.claude.baseEnv ? { baseEnv: o.claude.baseEnv } : {}),
        ...(onCall ? { onCall } : {}),
      });
    },
    onSession: (request, sessionId) => saveAgentSession(o.db, {
      runId: request.run_id, stageKey: request.stage_key, attemptId: request.attempt_id, sessionId, cwd: request.workspace_uri,
    }, core.clock.now()),
    recordCall: async (call) => { await recordLlmCall(o.db, o.bucket, call); },
    teamGuidesFor: (request) => teamGuidesForRun(o.db, request.run_id),
    feedbackFor: (request) => chatFeedback(o.db, request.run_id, request.stage_key),
    ...(o.claude.rateLimitBackoffMs ? { rateLimitBackoffMs: o.claude.rateLimitBackoffMs } : {}),
  }));
  executors.register("gate", new GateExecutor());
  executors.register("farm", new FarmExecutor({
    client: o.farm,
    storage: farmStorage(o.bucket),
    onSubmitted: makeStudioFarmRecorder(o.dbPath),
    payloadBuilders: { ...studioPayloadBuilders({ db: o.db, bucket: o.bucket }), ...cutPayloadBuilders({ db: o.db, bucket: o.bucket, ...(o.media ? { media: o.media } : {}) }) },
    pollIntervalMs: o.farmPollMs ?? 5000,
    // the machine type picked for this run's render (phase 3); none picked: the farm executor's default
    requirementsFor: (request) => renderChoiceRequirements(o.db, request.run_id, request.stage_key),
    ...(o.farmQueueTimeoutMs ? { queueTimeoutMsFor: () => o.farmQueueTimeoutMs } : {}),
    // what an abandoned attempt left on the farm (the worker restarted mid-job) is cancelled, not run for nobody
    earlierJobsFor: (request) => earlierFarmJobs(o.db, { runId: request.run_id, stageKey: request.stage_key, attemptId: request.attempt_id }),
  }));
  const capacity = () => studioResources(claudeMaxConcurrent(o.db, o.claudeMaxConcurrent ?? DEFAULT_CLAUDE_MAX_CONCURRENT).value);
  const project = {
    schema_version: "harness.project-config/v1", project_id: STUDIO_PROJECT_ID, template_release: "0.1.0", runtime: "claude",
    data_root: core.dataRoot, portfolios: [{ portfolio_id: STUDIO_PORTFOLIO_ID, display_name: "AG Studio" }],
    resources: capacity(), source: { materialize: "link" }, workflows: studioWorkflowRefs(core.harnessRoot),
  } as unknown as ProjectConfig;
  let made = 0;
  const next = () => {
    made += 1;
    const owner = single ? o.owner : `${o.owner}#${made}`;
    return new Worker({
      store: core.store, planner: core.planner, controller: core.controller, registry: core.registry, verifier: core.verifier, executors,
      harness: core.harness, project, dataRoot: core.dataRoot, owner, capabilities: [], logger: o.logger ?? studioLogger({ owner }),
      clock: core.clock, workflows: core.workflows, profiles: core.profiles, resourceCapacity: capacity,
    });
  };
  return { next, capacity };
}

/** One worker loop: claims and runs one stage at a time. */
export function createStudioWorker(o: StudioWorkerOptions): Worker {
  return workerFactory(o, true).next();
}

export interface StudioWorkerPool {
  /** The chat loop running next to the stage loops (people's messages to Claude). */
  readonly chat: ChatRunner;
  /** The loops in use now (loops let go after the cap dropped are no longer listed, though they may finish a stage). */
  readonly workers: Worker[];
  /** Matches the number of loops to the capacity now (`claude` from the web setting or env, + farm + cpu). */
  resize(): void;
  runForever(signal: AbortSignal): Promise<void>;
}

/** How often a running pool reads the capacity again to add or let go loops. */
export const STUDIO_POOL_RESIZE_MS = 10_000;

/**
 * Enough worker loops to fill every resource at once (`claude` + `farm` + `cpu`), sharing one store and one set of
 * executors. One loop runs one stage at a time and a farm stage holds its loop until the render is done, so a
 * single loop would serialize every production; with a pool, `claude` capacity alone decides how many Claude
 * calls run together. Loops coordinate through `claim()`/leases exactly like separate worker processes.
 * The `claude` cap can change on the web while running: claims read it every time, and the pool adds loops or lets
 * extra ones go after their current stage (never cutting a stage short).
 */
export function createStudioWorkerPool(o: StudioWorkerOptions & {
  resizeEveryMs?: number; chatPollMs?: number;
  /** The cleanup sweep (`cleanup.ts`) every `everyMs`, first a minute after start; absent or 0: never. */
  cleanup?: { everyMs: number; retention?: Partial<RetentionConfig> };
}): StudioWorkerPool {
  const factory = workerFactory(o, false);
  const chat = createChatRunner({
    core: o.core, db: o.db, bucket: o.bucket, claude: o.claude, logger: o.logger ?? studioLogger({ owner: `${o.owner}#chat` }),
    cap: () => factory.capacity().claude, ...(o.chatPollMs ? { pollMs: o.chatPollMs } : {}),
  });
  const loops: { worker: Worker; drain: AbortController; done?: Promise<void> }[] = [];
  let signal: AbortSignal | undefined;
  const start = (l: (typeof loops)[number]) => { if (signal && !l.done) l.done = l.worker.runForever(signal, { drain: l.drain.signal }); };
  const retired: Promise<void>[] = [];
  const resize = () => {
    const c = factory.capacity();
    const want = c.claude + c.farm + c.cpu;
    while (loops.length < want) { const l = { worker: factory.next(), drain: new AbortController() }; loops.push(l); start(l); }
    while (loops.length > want) { const l = loops.pop()!; l.drain.abort(); if (l.done) retired.push(l.done); }
  };
  resize();
  return {
    get workers() { return loops.map((l) => l.worker); },
    chat,
    resize,
    runForever: async (s) => {
      signal = s;
      for (const l of loops) start(l);
      const timer = setInterval(resize, o.resizeEveryMs ?? STUDIO_POOL_RESIZE_MS);
      const sweeps = startCleanup(o);
      const chatDone = chat.runForever(s);
      await new Promise<void>((res) => { if (s.aborted) res(); else s.addEventListener("abort", () => res(), { once: true }); });
      clearInterval(timer);
      sweeps.stop();
      await Promise.all([...loops.map((l) => l.done), ...retired, chatDone]);
    },
  };
}

/** Runs the cleanup sweep on a timer, one at a time; a failed sweep is logged and tried again next time. */
function startCleanup(o: StudioWorkerOptions & { cleanup?: { everyMs: number; retention?: Partial<RetentionConfig> } }): { stop: () => void } {
  const every = o.cleanup?.everyMs ?? 0;
  if (every <= 0) return { stop: () => {} };
  const log = o.logger ?? studioLogger({ owner: `${o.owner}#cleanup` });
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const report = await sweepStudioData(
        { core: o.core, db: o.db, bucket: o.bucket, voiceDir: o.media?.voiceDir },
        { now: new Date(), ...(o.cleanup?.retention ? { retention: o.cleanup.retention } : {}) },
      );
      log.info("cleanup swept", { ...report });
    } catch (e) {
      log.warn("cleanup failed", { error: e instanceof Error ? e.message : String(e) });
    } finally { running = false; }
  };
  const first = setTimeout(() => void sweep(), Math.min(60_000, every));
  const timer = setInterval(() => void sweep(), every);
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}
