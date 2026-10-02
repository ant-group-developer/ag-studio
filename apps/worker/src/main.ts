/**
 * AG Studio worker: runs `ag-studio-production@1.0.0` stages -- in-process stages, Claude (subscription,
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
 *   STUDIO_FFMPEG_PATH  ffmpeg for the loudness check of the final render and for cutting thumbnails
 *   STUDIO_FONTS_DIR    a folder with the thumbnail font (Arial); default: Windows fonts, else fontconfig (Liberation Sans)
 *   YOUTUBE_API_KEY     YouTube Data API v3 key for the market research of a series (none = research skipped)
 *   HARNESS_ROOT        Studio install root (default: this checkout)
 */
import { hostname } from "node:os";
import { join } from "node:path";
import { AgGoClient } from "@ag-studio/ag-go-client";
import {
  createStudioEngineCore, createStudioWorker, FarmOwnerClient, ffmpegThumbnailRenderer, S3Bucket, StudioDb, studioLogger, studioResearchCache,
  YoutubeResearchSource,
} from "@ag-studio/engine";
import { HARNESS_ROOT } from "@harness/core";

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
  const worker = createStudioWorker({
    core,
    db,
    dbPath,
    bucket: new S3Bucket({
      endpoint: requireEnv("STUDIO_R2_ENDPOINT"), bucket: requireEnv("STUDIO_R2_BUCKET"),
      accessKeyId: requireEnv("STUDIO_R2_ACCESS_KEY_ID"), secretAccessKey: requireEnv("STUDIO_R2_SECRET_ACCESS_KEY"),
    }),
    footage: new AgGoClient({ baseUrl: requireEnv("AG_GO_API_URL"), serviceKey: requireEnv("AG_GO_SERVICE_KEY") }),
    farm: new FarmOwnerClient({ baseUrl: requireEnv("FARM_URL"), ownerKey: requireEnv("FARM_OWNER_KEY") }),
    claude: {
      skillsDir: join(harnessRoot, "skills"),
      ...(process.env.STUDIO_CLAUDE_MODEL ? { model: process.env.STUDIO_CLAUDE_MODEL } : {}),
      ...(argv ? { argv } : {}),
    },
    owner,
    logger,
    farmPollMs: Number(process.env.FARM_POLL_MS ?? 5000),
    ...(youtubeKey ? { research: new YoutubeResearchSource({ apiKey: youtubeKey, cache: studioResearchCache(db) }) } : {}),
    ...(ffmpeg ? { thumbnails: ffmpegThumbnailRenderer({ ffmpeg }) } : {}),
  });

  logger.info("Studio worker starting", { owner, harnessRoot, youtube_research: !!youtubeKey });
  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { logger.warn(`received ${sig}, stopping after the current stage`); ac.abort(); });
  }
  await worker.runForever(ac.signal);
  core.close();
}

main().catch((e) => {
  process.stderr.write(`[studio-worker] fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
