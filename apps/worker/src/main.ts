/**
 * AG Studio worker: runs the Studio workflows' stages (series plan, episode, shot-cut episode) -- in-process stages, Claude (subscription,
 * `claude -p` structured), gates, and ag-farm jobs -- against the same `studio.db` as apps/api.
 *
 * Required environment variables:
 *   STUDIO_DB_PATH      studio.db shared with apps/api (harness state + Studio tables)
 *   STUDIO_DATA_ROOT    workspaces and artifacts
 *   FARM_URL, FARM_OWNER_KEY
 *   AG_GO_API_URL, AG_GO_SERVICE_KEY           (catalog, acting as the production owner)
 *   STUDIO_R2_ENDPOINT, STUDIO_R2_BUCKET, STUDIO_R2_ACCESS_KEY_ID, STUDIO_R2_SECRET_ACCESS_KEY
 *   CLAUDE_CODE_OAUTH_TOKEN                    (subscription; passed through to `claude` only)
 *
 * Optional:
 *   WORKER_OWNER        lease owner name (default: hostname-pid)
 *   FARM_POLL_MS        farm job polling interval (default 5000)
 *   STUDIO_CLAUDE_MODEL default claude-opus-5-5
 *   STUDIO_CLAUDE_ARGV  JSON array replacing `claude -p ...` (tests: the fake CLI)
 *   STUDIO_CLAUDE_MAX_CONCURRENT  Claude calls at once, 1-100 (default 20); the worker runs that many loops plus
 *                       one per farm/cpu slot, so a farm render never holds up another production
 *   STUDIO_FFMPEG_PATH  ffmpeg for the loudness check of the final render, for cutting thumbnails, and for the
 *                       shot-cut stages (shots, audio for transcription, contact sheets); none = those stages park
 *   STUDIO_FFPROBE_PATH ffprobe for the shot-cut stages (default: ffprobe next to STUDIO_FFMPEG_PATH)
 *   STUDIO_FONTS_DIR    a folder with the thumbnail font (Arial); default: Windows fonts, else fontconfig (Liberation Sans)
 *   YOUTUBE_API_KEY     YouTube Data API v3 key for the market research of a series (none = research skipped)
 *   HARNESS_ROOT        Studio install root (default: this checkout)
 *   STUDIO_FARM_QUEUE_TIMEOUT_MINUTES a farm job no node takes this long is cancelled and its step stops, saying so
 *                       (default 120; 0 = wait to the stage deadline, 4 h)
 *   STUDIO_CLEANUP_HOURS how often the cleanup sweep runs (default 6; 0 = never): workspaces of ended runs, agent
 *                       sessions without a workspace, unused voice lines, production audio and shot frames nothing uses
 *   STUDIO_RETENTION_WORKSPACE_DAYS / _VOICE_DAYS / _AUDIO_DAYS  how old before the sweep removes them (14 / 90 / 7)
 */
import { hostname } from "node:os";
import { join } from "node:path";
import { AgGoClient } from "@ag-studio/ag-go-client";
import {
  claudeMaxConcurrent as studioClaudeMaxConcurrent, createStudioEngineCore, ffprobeBeside, httpDownload, type CutMediaDeps, createStudioWorkerPool, FarmOwnerClient, parseClaudeMaxConcurrent, ffmpegThumbnailRenderer, S3Bucket, StudioDb, studioLogger, studioResearchCache,
  YoutubeResearchSource, DEFAULT_RETENTION,
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
  const harnessRoot = process.env.HARNESS_ROOT ?? HARNESS_ROOT;
  const owner = process.env.WORKER_OWNER ?? `${hostname()}-${process.pid}`;
  const ffmpeg = process.env.STUDIO_FFMPEG_PATH;
  const core = createStudioEngineCore({ dbPath, dataRoot: requireEnv("STUDIO_DATA_ROOT"), harnessRoot, ...(ffmpeg ? { ffmpeg } : {}) });
  const logger = studioLogger({ owner });
  const argv = process.env.STUDIO_CLAUDE_ARGV ? (JSON.parse(process.env.STUDIO_CLAUDE_ARGV) as string[]) : undefined;
  const db = new StudioDb(dbPath);
  const youtubeKey = process.env.YOUTUBE_API_KEY?.trim();
  const claudeMaxConcurrent = parseClaudeMaxConcurrent(process.env.STUDIO_CLAUDE_MAX_CONCURRENT);
  const agGo = new AgGoClient({ baseUrl: requireEnv("AG_GO_API_URL"), serviceKey: requireEnv("AG_GO_SERVICE_KEY") });
  const media: CutMediaDeps | null = ffmpeg ? {
    ffmpeg,
    ffprobe: process.env.STUDIO_FFPROBE_PATH ?? ffprobeBeside(ffmpeg),
    resolveAssets: async (actAs, assetIds, purpose) => {
      const r = await agGo.resolveAssets(actAs, { assetIds, purpose });
      return { items: r.items, missing: r.missing ?? [] };
    },
    download: (url, dest) => httpDownload(url, dest),
    voiceDir: join(requireEnv("STUDIO_DATA_ROOT"), "voice"),
  } : null;
  const pool = createStudioWorkerPool({
    core,
    db,
    dbPath,
    bucket: new S3Bucket({
      endpoint: requireEnv("STUDIO_R2_ENDPOINT"), bucket: requireEnv("STUDIO_R2_BUCKET"),
      accessKeyId: requireEnv("STUDIO_R2_ACCESS_KEY_ID"), secretAccessKey: requireEnv("STUDIO_R2_SECRET_ACCESS_KEY"),
    }),
    footage: agGo,
    farm: new FarmOwnerClient({ baseUrl: requireEnv("FARM_URL"), ownerKey: requireEnv("FARM_OWNER_KEY") }),
    claude: {
      skillsDir: join(harnessRoot, "skills"),
      ...(process.env.STUDIO_CLAUDE_MODEL ? { model: process.env.STUDIO_CLAUDE_MODEL } : {}),
      ...(argv ? { argv } : {}),
    },
    owner,
    logger,
    claudeMaxConcurrent,
    farmPollMs: Number(process.env.FARM_POLL_MS ?? 5000),
    farmQueueTimeoutMs: numberEnv("STUDIO_FARM_QUEUE_TIMEOUT_MINUTES", 120) * 60_000,
    ...(youtubeKey ? { research: new YoutubeResearchSource({ apiKey: youtubeKey, cache: studioResearchCache(db) }) } : {}),
    ...(ffmpeg ? { thumbnails: ffmpegThumbnailRenderer({ ffmpeg }) } : {}),
    ...(media ? { media } : {}),
    cleanup: {
      everyMs: numberEnv("STUDIO_CLEANUP_HOURS", 6) * 3_600_000,
      retention: {
        workspaceDays: numberEnv("STUDIO_RETENTION_WORKSPACE_DAYS", DEFAULT_RETENTION.workspaceDays),
        voiceDays: numberEnv("STUDIO_RETENTION_VOICE_DAYS", DEFAULT_RETENTION.voiceDays),
        audioGraceDays: numberEnv("STUDIO_RETENTION_AUDIO_DAYS", DEFAULT_RETENTION.audioGraceDays),
      },
    },
  });

  const claudeCap = studioClaudeMaxConcurrent(db, claudeMaxConcurrent);
  logger.info("Studio worker starting", { owner, harnessRoot, youtube_research: !!youtubeKey, claude_max_concurrent: claudeCap.value, claude_max_concurrent_from: claudeCap.source, loops: pool.workers.length });
  if (!youtubeKey) {
    logger.warn("YOUTUBE_API_KEY is not set for this worker: series research will be skipped and the trend report will say so (a direct run reads apps/api/.env)");
  }
  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { logger.warn(`received ${sig}, stopping: running stages go back to the queue and their farm jobs stay for the next attempt`); ac.abort(); });
  }
  await pool.runForever(ac.signal);
  core.close();
}

main().catch((e) => {
  process.stderr.write(`[studio-worker] fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
