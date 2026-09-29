/**
 * AG Studio Farm Worker
 *
 * Runs a harness Worker that delegates farm-type stages to ag-farm via
 * FarmExecutor.  After each successful job submission, it records the job in
 * studio_farm_jobs (in the same SQLite DB as apps/api) via
 * makeStudioFarmRecorder — so the ag-farm sign endpoint can later authorise
 * presigned-URL requests from the render worker.
 *
 * Required environment variables:
 *   HARNESS_DATA_ROOT   - path to harness data directory (contains state/harness.db)
 *   STUDIO_DB_PATH      - path to studio.db (shared with apps/api)
 *   FARM_URL            - ag-farm hub base URL
 *   FARM_OWNER_KEY      - ag-farm owner API key
 *   STUDIO_R2_ENDPOINT  - S3-compatible storage endpoint URL
 *   STUDIO_R2_BUCKET    - bucket name
 *   STUDIO_R2_ACCESS_KEY_ID
 *   STUDIO_R2_SECRET_ACCESS_KEY
 *
 * Optional:
 *   WORKER_OWNER        - lease owner name (default: hostname-pid)
 *   WORKER_POLL_SECONDS - harness poll interval (default: from harness.yaml or 5)
 *   FARM_POLL_MS        - farm job polling interval ms (default: 5000)
 *   HARNESS_ROOT        - harness installation root (default: built-in)
 */
import { hostname } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  SqliteStateStore,
  Planner,
  Controller,
  ArtifactRegistry,
  Verifier,
  SystemClock,
  HARNESS_ROOT,
  MIGRATIONS_DIR,
  loadHarnessConfig,
  createLogger,
} from "@harness/core";
import { ExecutorRegistry, FarmExecutor, makeStudioFarmRecorder, type StudioStorage } from "@harness/executors";
import { FarmOwnerClient } from "@ag-farm/owner-client";
import { Worker } from "@harness/worker";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Required env var ${name} is not set`);
  return v;
}

function optEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

// ---------------------------------------------------------------------------
// S3-backed StudioStorage
// ---------------------------------------------------------------------------

function makeS3Storage(opts: {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): StudioStorage {
  const s3 = new S3Client({
    endpoint: opts.endpoint,
    region: "auto",
    credentials: {
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
    },
    forcePathStyle: true,
  });
  const bucket = opts.bucket;

  return {
    async upload(localPath, objectKey) {
      const body = readFileSync(localPath);
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: body }),
      );
      const name = objectKey.split("/").pop() ?? objectKey;
      return `stage:${name}`;
    },

    async download(url, localPath) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      mkdirSync(join(localPath, ".."), { recursive: true });
      writeFileSync(localPath, buf);
    },

    async downloadOutput(productionId, relPath, localPath) {
      const key = `productions/${productionId}/${relPath}`;
      const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!resp.Body) throw new Error(`no body for key ${key}`);
      const buf = Buffer.from(await resp.Body.transformToByteArray());
      mkdirSync(join(localPath, ".."), { recursive: true });
      writeFileSync(localPath, buf);
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dataRoot = requireEnv("HARNESS_DATA_ROOT");
  const studioDbPath = requireEnv("STUDIO_DB_PATH");
  const farmUrl = requireEnv("FARM_URL");
  const farmOwnerKey = requireEnv("FARM_OWNER_KEY");
  const s3Endpoint = requireEnv("STUDIO_R2_ENDPOINT");
  const s3Bucket = requireEnv("STUDIO_R2_BUCKET");
  const s3KeyId = requireEnv("STUDIO_R2_ACCESS_KEY_ID");
  const s3Secret = requireEnv("STUDIO_R2_SECRET_ACCESS_KEY");
  const owner = optEnv("WORKER_OWNER", `${hostname()}-${process.pid}`);
  const harnessRoot = optEnv("HARNESS_ROOT", HARNESS_ROOT);
  const farmPollMs = parseInt(optEnv("FARM_POLL_MS", "5000"), 10);

  const logger = createLogger({
    level: (process.env["HARNESS_LOG_LEVEL"] as "info" | "warn" | "error" | undefined) ?? "info",
    sink: (l) => process.stderr.write(l + "\n"),
    bindings: { service: "studio-worker" },
  });

  // Ensure data directory
  mkdirSync(join(dataRoot, "state"), { recursive: true });

  const clock = new SystemClock();
  const store = new SqliteStateStore(join(dataRoot, "state", "harness.db"), clock);
  const planner = new Planner(store);
  const registry = new ArtifactRegistry(store, dataRoot);
  const controller = new Controller({ store, registry, planner, clock });
  const verifier = new Verifier(store);

  // Create FarmExecutor with shared studio.db recorder
  const farmClient = new FarmOwnerClient({ baseUrl: farmUrl, ownerKey: farmOwnerKey });
  const storage = makeS3Storage({
    endpoint: s3Endpoint,
    bucket: s3Bucket,
    accessKeyId: s3KeyId,
    secretAccessKey: s3Secret,
  });
  const farmExecutor = new FarmExecutor({
    client: farmClient,
    storage,
    onSubmitted: makeStudioFarmRecorder(studioDbPath),
    pollIntervalMs: farmPollMs,
  });

  const executors = new ExecutorRegistry();
  executors.register("farm", farmExecutor);

  const harness = loadHarnessConfig(harnessRoot);

  const worker = new Worker({
    store,
    planner,
    controller,
    registry,
    verifier,
    executors,
    harness,
    // project and workflows are not used by the farm executor — supply minimal stubs
    project: {
      project_id: "studio",
      data_root: dataRoot,
      resources: {},
    } as never,
    workflows: () => { throw new Error("no workflows in studio worker"); },
    profiles: () => { throw new Error("no profiles in studio worker"); },
    dataRoot,
    owner,
    capabilities: ["farm"],
    logger,
    clock,
    resourceCapacity: {},
  });

  logger.info("Studio farm worker starting", { owner, farmUrl, dataRoot });

  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      logger.warn(`received ${sig}, stopping`);
      ac.abort();
      store.close();
    });
  }

  await worker.runForever(ac.signal);
  store.close();
}

main().catch((e) => {
  process.stderr.write(`[studio-worker] fatal: ${String(e)}\n`);
  process.exit(1);
});
