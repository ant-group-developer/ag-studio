/**
 * AG Studio worker (spec 2026-10-10 agent-workspace): runs the projects' agent turns (`claude -p` stream-json in the
 * project folder, Studio tools over MCP), their jobs (preparing inputs, crawls, timelines, renders on ag-farm,
 * thumbnails, style) and the cleanup sweep, against the same `studio.db` and workspaces as apps/api.
 *
 * Required environment variables:
 *   STUDIO_DB_PATH      studio.db shared with apps/api
 *   STUDIO_DATA_ROOT    scratch folders of jobs and turns, the voice store
 *   FARM_URL, FARM_OWNER_KEY
 *   AG_GO_API_URL, AG_GO_SERVICE_KEY           (resolving footage, acting as the project owner)
 *   STUDIO_R2_ENDPOINT, STUDIO_R2_BUCKET, STUDIO_R2_ACCESS_KEY_ID, STUDIO_R2_SECRET_ACCESS_KEY
 *   CLAUDE_CODE_OAUTH_TOKEN                    (subscription; passed through to `claude` only)
 *
 * Optional:
 *   WORKER_OWNER        this worker's name in logs (default: hostname-pid)
 *   FARM_POLL_MS        farm job polling interval (default 5000)
 *   STUDIO_CLAUDE_MAX_CONCURRENT  Claude calls at once across workers, 1-100 (default 20; the web setting wins)
 *   STUDIO_FFMPEG_PATH  ffmpeg for preparing inputs, timelines, renders and thumbnails; none = those jobs wait
 *   STUDIO_FFPROBE_PATH ffprobe (default: ffprobe next to STUDIO_FFMPEG_PATH)
 *   STUDIO_FONTS_DIR    a folder with the thumbnail font (Arial); default: Windows fonts, else fontconfig (Liberation Sans)
 *   YOUTUBE_API_KEY     YouTube Data API v3 key for crawls (none: yt-dlp searches YouTube)
 *   YTDLP_PATH / STUDIO_YTDLP_ARGV  yt-dlp (default `yt-dlp` on PATH): crawls without a key, reference videos
 *   STUDIO_REFERENCE_DOWNLOADS=0    never download reference videos from YouTube (uploaded ones are still watched)
 *   HARNESS_ROOT        Studio install root (default: this checkout)
 *   STUDIO_FARM_QUEUE_TIMEOUT_MINUTES a farm job no node takes this long is cancelled and its job says so (default 120)
 *   STUDIO_CLEANUP_HOURS how often the cleanup sweep runs (default 6; 0 = never): unused voice lines, project audio
 *                       nothing points at, scratch folders a crash left, files deleted from projects
 *   STUDIO_RETENTION_WORKSPACE_DAYS / _VOICE_DAYS / _AUDIO_DAYS / _AUDIT_DAYS  how old before the sweep removes them (14 / 90 / 7 / 90)
 *   STUDIO_WORKSPACES_ROOT      project workspaces (default <STUDIO_DATA_ROOT>/workspaces; the API must see the same)
 *   STUDIO_JOB_LANES            project jobs run at once with no idle farm machine (default 2)
 *   STUDIO_JOB_LANES_MAX        project jobs at most: one more per idle farm machine up to this (default 8; ≤ STUDIO_JOB_LANES = fixed)
 *   STUDIO_DECODE_LANES         prepare jobs decoding video on this worker at once (default STUDIO_JOB_LANES; 0 = no limit)
 *
 * Agent turns (run only with STUDIO_AGENT_TOKEN_SECRET):
 *   STUDIO_AGENT_TOKEN_SECRET   signs each turn's token for /api/agent-tools (same value as the API)
 *   STUDIO_API_INTERNAL_URL     where a turn's MCP server reaches the API (default http://127.0.0.1:3100)
 *   STUDIO_AGENT_CLAUDE_CONFIG_DIR  CLAUDE_CONFIG_DIR of agent sessions (default <STUDIO_DATA_ROOT>/agent-claude)
 *   STUDIO_AGENT_MODEL          model alias or name (default sonnet; a project's setting wins)
 *   STUDIO_AGENT_MAX_TURNS      tool rounds a turn may take (default 40)
 *   STUDIO_AGENT_TURN_MINUTES   a turn's deadline (default 20)
 *   STUDIO_AGENT_ARGV           JSON array replacing `claude` (tests: the fake agent CLI)
 *   STUDIO_MCP_ARGV             JSON array starting the Studio MCP server (default node packages/studio-mcp/server.mjs)
 */
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { AgGoClient } from "@ag-studio/ag-go-client";
import {
  agentTools, claudeCap, createSiteNameCache, createStudioEngineCore, createStudioWorkerPool, DEFAULT_RETENTION, fetchAgGoSiteName, FarmOwnerClient, ffmpegThumbnailRenderer, ffprobeBeside,
  httpDownload, mcpToolNames, parseClaudeMaxConcurrent, S3Bucket, StudioDb, studioLogger, ytDlp, type CutMediaDeps,
} from "@ag-studio/engine";
import { HARNESS_ROOT } from "@harness/core";

/** A non-negative number from the environment, or `fallback` when unset or not a number. */
function numberEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Required env var ${name} is not set`);
  return v;
}

async function main(): Promise<void> {
  const dbPath = requireEnv("STUDIO_DB_PATH");
  const dataRoot = requireEnv("STUDIO_DATA_ROOT");
  const harnessRoot = process.env.HARNESS_ROOT ?? HARNESS_ROOT;
  const owner = process.env.WORKER_OWNER ?? `${hostname()}-${process.pid}`;
  const ffmpeg = process.env.STUDIO_FFMPEG_PATH;
  // migrations of studio.db, the same the API runs
  const core = createStudioEngineCore({ dbPath, dataRoot, harnessRoot });
  const logger = studioLogger({ owner });
  const db = new StudioDb(dbPath);
  const youtubeKey = process.env.YOUTUBE_API_KEY?.trim();
  // yt-dlp: STUDIO_YTDLP_ARGV (JSON array, tests) else YTDLP_PATH else `yt-dlp` on PATH; checked once, below
  const ytdlpArgv = process.env.STUDIO_YTDLP_ARGV ? (JSON.parse(process.env.STUDIO_YTDLP_ARGV) as string[]) : [process.env.YTDLP_PATH?.trim() || "yt-dlp"];
  const ytdlp = ytDlp({ argv: ytdlpArgv, ...(ffmpeg ? { ffmpeg } : {}) });
  const ytdlpVersion = await ytdlp.version();
  const referenceDownloads = process.env.STUDIO_REFERENCE_DOWNLOADS !== "0";
  const claudeMaxConcurrent = parseClaudeMaxConcurrent(process.env.STUDIO_CLAUDE_MAX_CONCURRENT);
  const agGo = new AgGoClient({ baseUrl: requireEnv("AG_GO_API_URL"), serviceKey: requireEnv("AG_GO_SERVICE_KEY") });
  // ag-go's own name for itself (its public settings), for job text and the agent's prompt
  const siteName = createSiteNameCache({ load: () => fetchAgGoSiteName(requireEnv("AG_GO_API_URL")) });
  void siteName.refresh();
  const media: CutMediaDeps | null = ffmpeg ? {
    ffmpeg,
    ffprobe: process.env.STUDIO_FFPROBE_PATH ?? ffprobeBeside(ffmpeg),
    resolveAssets: async (actAs, assetIds, purpose, prefer) => {
      const r = await agGo.resolveAssets(actAs, { assetIds, purpose, ...(prefer ? { prefer } : {}) });
      return { items: r.items, missing: r.missing ?? [] };
    },
    download: (url, dest) => httpDownload(url, dest),
    voiceDir: join(dataRoot, "voice"),
  } : null;
  const workspacesRoot = resolve(process.env.STUDIO_WORKSPACES_ROOT ?? join(dataRoot, "workspaces"));
  const agentSecret = process.env.STUDIO_AGENT_TOKEN_SECRET;
  const agent = agentSecret ? {
    workspacesRoot,
    dataRoot,
    apiUrl: process.env.STUDIO_API_INTERNAL_URL ?? "http://127.0.0.1:3100",
    tokenSecret: agentSecret,
    claudeCommand: process.env.STUDIO_AGENT_ARGV ? (JSON.parse(process.env.STUDIO_AGENT_ARGV) as string[]) : ["claude"],
    mcpCommand: process.env.STUDIO_MCP_ARGV ? (JSON.parse(process.env.STUDIO_MCP_ARGV) as string[]) : [process.execPath, join(harnessRoot, "packages", "studio-mcp", "server.mjs")],
    configDir: resolve(process.env.STUDIO_AGENT_CLAUDE_CONFIG_DIR ?? join(dataRoot, "agent-claude")),
    model: process.env.STUDIO_AGENT_MODEL?.trim() || "sonnet",
    maxTurns: numberEnv("STUDIO_AGENT_MAX_TURNS", 40),
    deadlineMs: numberEnv("STUDIO_AGENT_TURN_MINUTES", 20) * 60_000,
    mcpTools: () => mcpToolNames(agentTools()),
    skills: { builtinDir: join(harnessRoot, "agent-skills"), pluginsRoot: join(dataRoot, "agent-plugins") },
  } : undefined;
  const jobLanes = Math.max(1, numberEnv("STUDIO_JOB_LANES", 2));
  const pool = createStudioWorkerPool({
    db,
    bucket: new S3Bucket({
      endpoint: requireEnv("STUDIO_R2_ENDPOINT"), bucket: requireEnv("STUDIO_R2_BUCKET"),
      accessKeyId: requireEnv("STUDIO_R2_ACCESS_KEY_ID"), secretAccessKey: requireEnv("STUDIO_R2_SECRET_ACCESS_KEY"),
    }),
    farm: new FarmOwnerClient({ baseUrl: requireEnv("FARM_URL"), ownerKey: requireEnv("FARM_OWNER_KEY") }),
    owner,
    logger,
    dataRoot,
    claudeMaxConcurrent,
    siteName: () => siteName.current(),
    ...(agent ? { agent } : {}),
    jobs: { workspacesRoot, lanes: jobLanes, maxLanes: numberEnv("STUDIO_JOB_LANES_MAX", 8) },
    decodeLanes: numberEnv("STUDIO_DECODE_LANES", jobLanes),
    farmPollMs: Number(process.env.FARM_POLL_MS ?? 5000),
    farmQueueTimeoutMs: numberEnv("STUDIO_FARM_QUEUE_TIMEOUT_MINUTES", 120) * 60_000,
    ...(youtubeKey ? { youtubeApiKey: youtubeKey } : {}),
    ...(ytdlpVersion ? { ytdlp } : {}),
    referenceDownloads,
    ...(ffmpeg ? { thumbnails: ffmpegThumbnailRenderer({ ffmpeg }) } : {}),
    ...(media ? { media } : {}),
    cleanup: {
      everyMs: numberEnv("STUDIO_CLEANUP_HOURS", 6) * 3_600_000,
      retention: {
        workspaceDays: numberEnv("STUDIO_RETENTION_WORKSPACE_DAYS", DEFAULT_RETENTION.workspaceDays),
        voiceDays: numberEnv("STUDIO_RETENTION_VOICE_DAYS", DEFAULT_RETENTION.voiceDays),
        audioGraceDays: numberEnv("STUDIO_RETENTION_AUDIO_DAYS", DEFAULT_RETENTION.audioGraceDays),
        auditDays: numberEnv("STUDIO_RETENTION_AUDIT_DAYS", DEFAULT_RETENTION.auditDays),
      },
    },
  });

  logger.info("Studio worker starting", {
    owner, harnessRoot, workspacesRoot, agent_turns: !!agent, youtube_api: !!youtubeKey, ytdlp: ytdlpVersion, ffmpeg: !!ffmpeg,
    reference_downloads: referenceDownloads, claude_max_concurrent: claudeCap({ db, claudeMaxConcurrent }),
  });
  if (!agent) logger.warn("STUDIO_AGENT_TOKEN_SECRET is not set: agent turns do not run in this worker (jobs still do)");
  if (!ffmpeg) logger.warn("STUDIO_FFMPEG_PATH is not set: preparing inputs, timelines, renders and thumbnails wait for a worker that has it");
  if (!youtubeKey && !ytdlpVersion) logger.warn(`neither YOUTUBE_API_KEY nor yt-dlp (${ytdlpArgv[0]}): crawls wait for a worker that has one`);
  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { logger.warn(`received ${sig}, stopping: running jobs go back to the queue, a running turn resumes on the next start`); ac.abort(); });
  }
  await pool.runForever(ac.signal);
  core.close();
}

main().catch((e) => {
  process.stderr.write(`[studio-worker] fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
