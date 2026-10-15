/**
 * The Studio worker (spec 2026-10-10 agent-workspace): one process running, side by side, the agent loop (turns of the
 * projects' chat threads), the loop of project jobs (preparing inputs, crawls, timelines, renders, thumbnails, style),
 * the cleanup sweep and the footage usage sent to ag-go, against the same database as apps/api.
 */
import { createLogger, Redactor, type HarnessLogger } from "@harness/core";
import type { FarmOwnerClient } from "@ag-farm/owner-client";
import type { StudioBucket } from "./bucket.js";
import { DEFAULT_CLAUDE_MAX_CONCURRENT } from "./core.js";
import { sweepStudioData, type RetentionConfig } from "./cleanup.js";
import { httpDownload } from "./cut-media.js";
import type { CutMediaDeps } from "./media-deps.js";
import { claudeMaxConcurrent } from "./settings.js";
import type { StudioDb } from "./studio-db.js";
import type { ThumbnailRenderer } from "./thumbnail-render.js";
import type { YtDlp } from "./yt-dlp.js";
import { studioResearchCache } from "./youtube-research.js";
import { createAgentRunner, type AgentRunner, type AgentRunnerOptions } from "./agent/runner.js";
import { fitHandler } from "./workspace/fit.js";
import { createJobRunner, type JobHandler, type JobRunner } from "./workspace/job-runner.js";
import type { JobKind } from "./workspace/jobs-db.js";
import type { ProjectFarm } from "./workspace/farm.js";
import { farmLanes } from "./workspace/lanes.js";
import { prepareHandler, type AgGoPreps } from "./workspace/prepare.js";
import { RENDER_KINDS, renderHandler } from "./workspace/renders.js";
import { referenceFetchers } from "./workspace/reference-fetch.js";
import { researchHandler } from "./workspace/research.js";
import { styleWatchHandler } from "./workspace/style-watch.js";
import { startUsageSender, type UsageSink } from "./workspace/usage-send.js";
import { thumbnailHandler } from "./workspace/thumbnails.js";
import { YoutubeCrawler } from "./workspace/youtube-crawl.js";

export interface StudioWorkerOptions {
  db: StudioDb;
  bucket: StudioBucket;
  farm: FarmOwnerClient;
  /** This worker's name in logs. */
  owner: string;
  logger?: HarnessLogger;
  /** `STUDIO_DATA_ROOT`: scratch folders of jobs and turns, the voice store. */
  dataRoot: string;
  farmPollMs?: number;
  /** A farm job taken by no node this long is cancelled and its job says so (default: half an hour). */
  farmQueueTimeoutMs?: number;
  /** ffmpeg, ag-go resolve, downloads, the voice store; without it videos are not rendered. */
  media?: CutMediaDeps;
  /** ag-go's preps of footage (shots, frames, transcript); without it inputs are not prepared. */
  preps?: AgGoPreps;
  /** ag-go's usage events: the outbox is sent every `everyMs` (default 30 s); without it events wait in the outbox. */
  usage?: { sink: UsageSink; everyMs?: number };
  /** Cuts and draws thumbnails; without it the `thumbnail` jobs wait. */
  thumbnails?: ThumbnailRenderer;
  /** yt-dlp: crawls without an API key, reference videos. */
  ytdlp?: YtDlp;
  /** False: reference videos are never downloaded, neither here nor by the farm's machines (`STUDIO_REFERENCE_DOWNLOADS=0`). */
  referenceDownloads?: boolean;
  /** Claude calls at once (the web setting wins); default `DEFAULT_CLAUDE_MAX_CONCURRENT` (20). */
  claudeMaxConcurrent?: number;
  /** YouTube Data API key for crawls (`research` jobs); without it they use yt-dlp when there is one. */
  youtubeApiKey?: string;
  /** What people call the footage library (ag-go's `siteName`): job text and the agent's prompt; default "AG Go". */
  siteName?: () => string;
}

export function studioLogger(bindings: Record<string, unknown> = {}): HarnessLogger {
  return createLogger({ redactor: new Redactor(() => []), sink: (l) => process.stderr.write(l + "\n"), bindings: { service: "studio-worker", ...bindings } });
}

export interface StudioWorkerPool {
  /** The agent loop: turns of the projects' chat threads; absent when not configured. */
  readonly agent: AgentRunner | null;
  /** The loop of project jobs; absent when not configured. */
  readonly jobs: JobRunner | null;
  runForever(signal: AbortSignal): Promise<void>;
}

/** The Claude calls this worker may run at once now (the web setting, else the env). */
export async function claudeCap(o: Pick<StudioWorkerOptions, "db" | "claudeMaxConcurrent">): Promise<number> {
  return (await claudeMaxConcurrent(o.db, o.claudeMaxConcurrent ?? DEFAULT_CLAUDE_MAX_CONCURRENT)).value;
}

export function createStudioWorkerPool(o: StudioWorkerOptions & {
  /** The agent loop's settings (workspaces, API, token secret, CLI); absent: no agent turns run in this worker. */
  agent?: Omit<AgentRunnerOptions, "db" | "bucket" | "logger" | "cap">;
  /**
   * Project jobs: where workspaces are, jobs at once (`lanes`, plus one per idle farm machine up to `maxLanes` when
   * that is above `lanes`); absent: none run in this worker.
   */
  jobs?: { workspacesRoot: string; lanes?: number; maxLanes?: number; pollMs?: number };
  /** The cleanup sweep every `everyMs`, first a minute after start; absent or 0: never. */
  cleanup?: { everyMs: number; retention?: Partial<RetentionConfig> };
}): StudioWorkerPool {
  const agent = o.agent
    ? createAgentRunner({
      ...o.agent, db: o.db, bucket: o.bucket, logger: o.logger ?? studioLogger({ owner: `${o.owner}#agent` }), cap: () => claudeCap(o),
      ...(o.siteName ? { siteName: o.siteName } : {}),
      // while YouTube blocks the server the agent is told whether farm machines fetch reference videos instead
      ...(o.referenceDownloads !== false && !o.agent.referenceFetchers ? { referenceFetchers: referenceFetchers(o.farm) } : {}),
    })
    : null;
  const jobsLog = o.logger ?? studioLogger({ owner: `${o.owner}#jobs` });
  const lanes = o.jobs ? jobLanes(o.farm, o.jobs, jobsLog) : undefined;
  const jobs = o.jobs ? createJobRunner({
    db: o.db, logger: jobsLog, workspacesRoot: o.jobs.workspacesRoot, dataRoot: o.dataRoot,
    handlers: projectJobHandlers(o), ...(lanes ? { lanes } : {}), ...(o.jobs.pollMs ? { pollMs: o.jobs.pollMs } : {}),
  }) : null;
  return {
    agent,
    jobs,
    runForever: async (s) => {
      const sweeps = startCleanup(o);
      const usage = o.usage ? startUsageSender({ db: o.db, sink: o.usage.sink, log: o.logger ?? studioLogger({ owner: `${o.owner}#usage` }), ...(o.usage.everyMs ? { everyMs: o.usage.everyMs } : {}) }) : null;
      const done = [agent?.runForever(s), jobs?.runForever(s)];
      await new Promise<void>((res) => { if (s.aborted) res(); else s.addEventListener("abort", () => res(), { once: true }); });
      sweeps.stop();
      usage?.stop();
      await Promise.all(done);
    },
  };
}

/** The job runner's lanes: fixed, or growing with the farm's idle machines when `maxLanes` is above `lanes`. */
function jobLanes(farm: ProjectFarm, j: { lanes?: number; maxLanes?: number }, log: HarnessLogger): number | (() => number) | undefined {
  if (!j.maxLanes || j.maxLanes <= (j.lanes ?? 2)) return j.lanes;
  let warned = false;
  return farmLanes({
    farm, base: j.lanes ?? 2, max: j.maxLanes,
    onError: (e) => { if (!warned) { warned = true; log.warn("farm machines not read: jobs keep the worker's own lanes", { error: e instanceof Error ? e.message : String(e) }); } },
  });
}

/** What each kind of project job runs with on this worker: preparing needs ag-go's preps, rendering ffmpeg and ag-go (`media`). */
export function projectJobHandlers(o: StudioWorkerOptions): Partial<Record<JobKind, JobHandler>> {
  const handlers: Partial<Record<JobKind, JobHandler>> = {};
  const media = o.media;
  const farmWait = { pollMs: o.farmPollMs ?? 3000, ...(o.farmQueueTimeoutMs ? { queueTimeoutMs: o.farmQueueTimeoutMs } : {}) };
  // ag-go prepares each video once; the job copies its shots, frames and transcript into the project
  if (o.preps) {
    handlers.prepare_asset = prepareHandler({
      db: o.db, preps: o.preps, download: (url, dest, signal) => httpDownload(url, dest, signal), ...(o.siteName ? { siteName: o.siteName } : {}),
    });
  }
  if (media) {
    // a video's timeline from its edit plan (narration read on the farm into the voice store)
    handlers.fit = fitHandler({ db: o.db, bucket: o.bucket, farm: o.farm, voiceDir: media.voiceDir, ...farmWait });
    // renders of a project's videos: preview, final, Premiere (the narration comes from the voice store)
    for (const kind of RENDER_KINDS) handlers[kind] = renderHandler(kind, { db: o.db, bucket: o.bucket, farm: o.farm, voiceDir: media.voiceDir, ...farmWait });
  }
  if (o.thumbnails) handlers.thumbnail = thumbnailHandler({ db: o.db, bucket: o.bucket, renderer: o.thumbnails });
  // reference videos: uploaded ones (style_from_files), and YouTube ones a person agreed to download (a
  // reference_download card: watched, measured, deleted) unless downloads are turned off: fetched by a farm machine
  // taking studio.reference_fetch when one is online (YouTube blocks the server, not the office), else this worker's yt-dlp
  if (media) {
    const downloads = o.referenceDownloads !== false;
    handlers.style_watch = styleWatchHandler({
      db: o.db, ytdlp: downloads ? o.ytdlp ?? null : null, ffmpeg: media.ffmpeg, ffprobe: media.ffprobe,
      farm: downloads ? { client: o.farm, bucket: o.bucket, fetchers: referenceFetchers(o.farm), pollMs: farmWait.pollMs, queueTimeoutMs: o.farmQueueTimeoutMs ?? 30 * 60_000 } : null,
    });
  }
  const crawler = new YoutubeCrawler({ apiKey: o.youtubeApiKey ?? null, ytdlp: o.ytdlp ?? null, cache: studioResearchCache(o.db) });
  if (crawler.source) handlers.research = researchHandler({ db: o.db, crawler });
  return handlers;
}

/** Runs the cleanup sweep on a timer, one at a time; a failed sweep is logged and tried again next time. */
function startCleanup(o: StudioWorkerOptions & {
  jobs?: { workspacesRoot: string }; agent?: { workspacesRoot: string }; cleanup?: { everyMs: number; retention?: Partial<RetentionConfig> };
}): { stop: () => void } {
  const every = o.cleanup?.everyMs ?? 0;
  if (every <= 0) return { stop: () => {} };
  const log = o.logger ?? studioLogger({ owner: `${o.owner}#cleanup` });
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const report = await sweepStudioData(
        { db: o.db, bucket: o.bucket, dataRoot: o.dataRoot, workspacesRoot: o.jobs?.workspacesRoot ?? o.agent?.workspacesRoot, voiceDir: o.media?.voiceDir },
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
