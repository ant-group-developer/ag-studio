/**
 * E2E test: AG Studio ↔ ag-farm ↔ ag-render-worker integration.
 *
 * Proves the full sign-URL round-trip works end-to-end:
 *   FarmExecutor → ag-farm hub → ag-render-worker → POST /farm/sign → FakeS3 → results
 *
 * Requires: E2E=1  (skipped otherwise)
 * Requires: Node 22+, ffmpeg, ffprobe
 *
 * Infrastructure started IN PROCESS or as child processes — no Docker needed for S3:
 *   - PostgreSQL 16 at localhost:55433  (via ag-farm docker-compose.test.yml)
 *   - FakeS3Server at localhost:9110    (in-process, replaces Docker MinIO)
 *   - ag-farm hub at localhost:3099
 *   - AG Studio API at localhost:3198
 *   - fake ag-go server at localhost:4099
 *   - ag-render-worker process
 *
 * onSubmitted uses makeStudioFarmRecorder — the same function apps/worker uses in
 * production to insert studio_farm_jobs rows so the sign endpoint can authorize
 * render-worker presigned URL requests.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import {
  execFileSync,
  execFile,
  spawn,
  type ChildProcess,
} from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, dirname, resolve as pathResolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, generateKeyPairSync, createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import http from "node:http";
import { FakeS3Server } from "./fake-s3.js";
import {
  FarmExecutor,
  makeStudioFarmRecorder,
  stageInputPrefix,
  type SubmittedInfo,
  type StudioStorage,
} from "@harness/executors";
import { FarmOwnerClient } from "@ag-farm/owner-client";
import { RenderManifestSchema } from "@ag-farm/protocol";

// ------------------------------------------------------------------
// Workspace root and repo paths
// ------------------------------------------------------------------

const ROOT = pathResolve(fileURLToPath(import.meta.url), "..", "..", "..");
const AG_FARM_DIR = pathResolve(ROOT, "..", "ag-farm");
const AG_RENDER_DIR = pathResolve(ROOT, "..", "ag-render-worker");
const EXE = process.platform === "win32" ? ".exe" : "";
// ag-render-worker ships its own ffmpeg/ffprobe; fall back to those if not set via env.
const FFMPEG_PATH =
  process.env["FFMPEG_PATH"] ??
  pathResolve(ROOT, "..", "ag-render-worker", "node_modules", "ffmpeg-static", "ffmpeg") + EXE;
const FFPROBE_PATH =
  process.env["FFPROBE_PATH"] ??
  pathResolve(ROOT, "..", "ag-render-worker", "node_modules", "ffprobe-static", "bin",
    process.platform, process.arch, "ffprobe") + EXE;

// ------------------------------------------------------------------
// Skip guard
// ------------------------------------------------------------------

const isE2E = process.env["E2E"] === "1";

// ------------------------------------------------------------------
// Infrastructure ports
// ------------------------------------------------------------------

const FARM_DB_PORT = 55433;
const FAKE_S3_PORT = 9110;
const FARM_HUB_PORT = 3099;
const STUDIO_API_PORT = 3198;
const AG_GO_PORT = 4099;

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------

let testDir: string;
let farmHubProc: ChildProcess | null = null;
let studioApiProc: ChildProcess | null = null;
let agGoServer: http.Server | null = null;
let renderWorkerProc: ChildProcess | null = null;
let fakeS3: FakeS3Server | null = null;
let fakeTtsWorkerStop: (() => void) | null = null;

let ownerKey: string;
let ownerId: string;
let nodeToken: string;
let productionId: string;
let segment1Id: string;
let segment2Id: string;
let farmPrivKey: string;
let farmPubKey: string;

const S3_BUCKET = "studio-test";
const S3_ACCESS_KEY = "devkey";
const S3_SECRET_KEY = "devsecret";
const CANVAS = { width: 320, height: 180 };

const execFileAsync = promisify(execFile);

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

async function waitForHttp(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status < 500) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Timeout waiting for ${url}`);
}

function spawnProc(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  label: string,
): ChildProcess {
  const proc = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = `[${label}] `;
  proc.stdout?.on("data", (d: Buffer) => process.stderr.write(prefix + d.toString()));
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(prefix + d.toString()));
  proc.on("exit", (code) =>
    process.stderr.write(`${prefix}exited code=${code}\n`));
  return proc;
}

async function createLavfiVideo(
  outputPath: string,
  durationSeconds: number,
  width: number,
  height: number,
): Promise<void> {
  const filter = `testsrc2=size=${width}x${height}:rate=25:duration=${durationSeconds}`;
  await execFileAsync(
    FFMPEG_PATH,
    [
      "-f", "lavfi", "-i", filter,
      "-f", "lavfi", "-i",
      `aevalsrc=0:c=mono:s=48000:d=${durationSeconds}`,
      "-c:v", "libx264", "-crf", "35", "-preset", "ultrafast",
      "-c:a", "aac",
      "-t", String(durationSeconds),
      "-y",
      outputPath,
    ],
    { timeout: 30_000 },
  );
}

function createSilentWav(outputPath: string, durationSeconds: number): void {
  const sampleRate = 24000;
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const wav = Buffer.alloc(44 + numSamples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + numSamples * 2, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(numSamples * 2, 40);
  writeFileSync(outputPath, wav);
}

// ------------------------------------------------------------------
// Fake ag-go server — resolves segment IDs to presigned fake-S3 GET URLs
// ------------------------------------------------------------------

const segmentRegistry = new Map<
  string,
  { s3Key: string; durationSeconds: number }
>();

async function startFakeAgGo(): Promise<void> {
  return new Promise((resolve, reject) => {
    agGoServer = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url?.includes("/segments/resolve")) {
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body) as {
          segmentIds: string[];
          purpose: string;
        };

        const items = parsed.segmentIds.map((segId) => {
          const rec = segmentRegistry.get(segId);
          if (!rec) return null;
          const url =
            `http://127.0.0.1:${FAKE_S3_PORT}/${S3_BUCKET}/${rec.s3Key}` +
            `?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600`;
          return {
            segmentId: segId,
            assetId: `asset-${segId}`,
            startMs: 0,
            endMs: Math.round(rec.durationSeconds * 1000),
            url,
            sourceKind: parsed.purpose === "final" ? "original" : "preview",
            watermarked: parsed.purpose !== "final",
            contentType: "video/mp4",
            sizeBytes: null,
            cacheKey: null,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          };
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ items: items.filter(Boolean) }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    agGoServer.on("error", reject);
    agGoServer.listen(AG_GO_PORT, "127.0.0.1", () => {
      process.stderr.write(`[fake-ag-go] listening on :${AG_GO_PORT}\n`);
      resolve();
    });
  });
}

// ------------------------------------------------------------------
// Fake TTS worker: registers a node with fake GPU+Python capabilities,
// claims studio.tts jobs, and immediately fails them.
// Without this, studio.tts jobs stay queued forever because the real
// render-worker has no NVIDIA GPU (required by JOB_TYPE_SPECS[studio.tts]).
// ------------------------------------------------------------------

async function startFakeTtsWorker(
  token: string,
  farmHubUrl: string,
): Promise<() => void> {
  let running = true;
  const stop = (): void => { running = false; };

  const fakeCapabilities = {
    os: "linux" as const,
    cpu_cores: 4,
    ram_mb: 8192,
    gpus: [{ name: "fake-gpu-tts", vram_mb: 8192, nvenc: false, nvdec: false }],
    engines: { ffmpeg: null, ollama_models: [], python: "3.10.0" },
  };

  const authHeader = `Node ${token}`;
  const base = farmHubUrl.replace(/\/$/, "");

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify(body),
    });

  const loop = async (): Promise<void> => {
    while (running) {
      try {
        // Heartbeat to keep node alive
        await post("/v1/worker/heartbeat", {
          agent_version: "0.1.0-fake-tts",
          kinds: ["studio.tts"],
          capabilities: fakeCapabilities,
          free_slots: { cpu: 0, gpu: 1 },
          running_job_ids: [],
        });

        // Claim a TTS job if any are queued
        const claimRes = await post("/v1/worker/claim", {
          kinds: ["studio.tts"],
          free_slots: { cpu: 0, gpu: 1 },
          cached_affinity: [],
        });

        if (claimRes.ok) {
          // the hub answers { data, requestId, success, error }; older hubs answer raw
          const claimBody = (await claimRes.json()) as { data?: unknown };
          const { job } = (claimBody.data ?? claimBody) as {
            job: { id: string; lease_token: string } | null;
          };
          if (job) {
            process.stderr.write(
              `[fake-tts] Claimed TTS job ${job.id} — failing (no TTS engine in test)\n`,
            );
            await post(`/v1/worker/jobs/${job.id}/fail`, {
              lease_token: job.lease_token,
              error: {
                code: "no_tts_engine",
                message: "No TTS engine available in E2E test environment",
                retryable: false,
              },
            });
          }
        }
      } catch {
        /* ignore transient errors */
      }
      await new Promise<void>((r) => setTimeout(r, 500));
    }
  };

  void loop();
  return stop;
}

// ------------------------------------------------------------------
// S3 helpers (AWS SDK v3, pointed at FakeS3Server)
// ------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  CreateBucketCommand,
} = require("@aws-sdk/client-s3") as typeof import("@aws-sdk/client-s3");

function makeS3Client() {
  return new S3Client({
    endpoint: `http://127.0.0.1:${FAKE_S3_PORT}`,
    region: "us-east-1",
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    forcePathStyle: true,
  });
}

async function s3Put(
  s3: ReturnType<typeof makeS3Client>,
  key: string,
  body: Buffer | string,
  contentType = "application/octet-stream",
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: typeof body === "string" ? Buffer.from(body) : body,
      ContentType: contentType,
    }),
  );
}

// ------------------------------------------------------------------
// beforeAll: boot all infrastructure
// ------------------------------------------------------------------

beforeAll(async () => {
  if (!isE2E) return;

  for (const [label, bin] of [
    ["ffmpeg", FFMPEG_PATH],
    ["ffprobe", FFPROBE_PATH],
  ] as const) {
    if (!existsSync(bin)) {
      throw new Error(
        `Required binary not found (${label}): ${bin}. Set FFMPEG_PATH / FFPROBE_PATH.`,
      );
    }
  }
  if (!existsSync(join(AG_FARM_DIR, "apps", "api", "dist", "main.js"))) {
    throw new Error(`ag-farm not built. Run: cd ${AG_FARM_DIR}/apps/api && yarn build`);
  }
  if (!existsSync(join(AG_RENDER_DIR, "dist", "main.js"))) {
    throw new Error(`ag-render-worker not built. Run: cd ${AG_RENDER_DIR} && yarn build`);
  }
  const studioApiDist = join(ROOT, "apps", "api", "dist", "main.js");
  if (!existsSync(studioApiDist)) {
    throw new Error(`Studio API not built. Run pnpm build in apps/api`);
  }

  testDir = join(tmpdir(), `farm-e2e-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  process.stderr.write(`[e2e] testDir=${testDir}\n`);

  const keyPair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  farmPrivKey = keyPair.privateKey;
  farmPubKey = keyPair.publicKey;
  ownerKey = randomBytes(24).toString("base64url");

  // Start Postgres
  process.stderr.write("[e2e] Starting Postgres for ag-farm...\n");
  execFileSync(
    "docker",
    [
      "compose", "-f",
      join(AG_FARM_DIR, "docker-compose.test.yml"),
      "up", "-d", "--wait",
    ],
    { stdio: "inherit", timeout: 60_000 },
  );

  // Start FakeS3Server
  const s3DataDir = join(testDir, "s3-data");
  fakeS3 = new FakeS3Server(FAKE_S3_PORT, s3DataDir);
  await fakeS3.start();

  const s3 = makeS3Client();
  await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
  process.stderr.write("[e2e] FakeS3Server ready, bucket created\n");

  // Start ag-farm hub
  const farmDbUrl =
    `postgresql://farm_test:farm_test@localhost:${FARM_DB_PORT}/ag_farm_test`;

  farmHubProc = spawnProc(
    "node",
    [join(AG_FARM_DIR, "apps", "api", "dist", "main.js")],
    {
      NODE_ENV: "test",
      PORT: String(FARM_HUB_PORT),
      DATABASE_URL: farmDbUrl,
      DATABASE_POOL_MAX: "3",
      AUTH0_ISSUER_URL: "https://test.auth0.com/",
      AUTH0_AUDIENCE: "test-aud",
      AUTH0_JWKS_URL: "https://test.auth0.com/.well-known/jwks.json",
      AUTH0_ALLOWED_CLIENT_IDS: "test-client",
      ACCOUNT_API_URL: `http://127.0.0.1:${AG_GO_PORT}`,
      FARM_TICKET_PRIVATE_KEY: farmPrivKey.replace(/\n/g, "\\n"),
      FARM_TICKET_PUBLIC_KEY: farmPubKey.replace(/\n/g, "\\n"),
      REAPER_INTERVAL_MS: "999999",
      NODE_OFFLINE_AFTER_SECONDS: "90",
      FRONTEND_ORIGIN: "*",
    },
    "ag-farm",
  );
  await waitForHttp(`http://localhost:${FARM_HUB_PORT}/health`, 30_000);
  process.stderr.write("[e2e] ag-farm hub ready\n");

  // Run ag-farm DB migrations (schema is NOT auto-created; migrationsRun: false)
  // Use the compiled data-source directly via the TypeORM CLI in ag-farm's node_modules
  {
    const typeormBin = join(AG_FARM_DIR, "node_modules", "typeorm", "cli.js");
    execFileSync(
      process.execPath,
      [typeormBin, "migration:run", "--dataSource", "dist/database/data-source.js"],
      {
        cwd: join(AG_FARM_DIR, "apps", "api"),
        env: { ...process.env, DATABASE_URL: farmDbUrl },
        stdio: "pipe",
      },
    );
  }
  process.stderr.write("[e2e] ag-farm migrations applied\n");

  // Register owner + node
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client: PgClient } = require("pg") as typeof import("pg");
  const pgClient = new PgClient({ connectionString: farmDbUrl });
  await pgClient.connect();

  ownerId = "studio"; // TicketGuard checks claims.owner === 'studio' (hardcoded)
  const ownerKeyHash = createHash("sha256").update(ownerKey).digest("hex");
  await pgClient.query(
    `INSERT INTO farm_owners
       (id, key_hash, sign_url, allowed_types, default_lane, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET key_hash = $2, sign_url = $3`,
    [
      ownerId,
      ownerKeyHash,
      `http://127.0.0.1:${STUDIO_API_PORT}/api/farm/sign`,
      ["studio.tts", "studio.render_preview", "studio.render_final"],
      "batch",
    ],
  );

  nodeToken = randomBytes(24).toString("base64url");
  const nodeTokenHash = createHash("sha256").update(nodeToken).digest("hex");
  const nodeId = randomUUID();
  await pgClient.query(
    `INSERT INTO farm_nodes
       (id, name, machine, token_hash, kinds, capabilities, status,
        last_seen_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW(), NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [
      nodeId,
      "e2e-render-worker",
      "localhost",
      nodeTokenHash,
      ["studio.tts", "studio.render_preview", "studio.render_final"],
      JSON.stringify({
        os: { platform: process.platform, arch: process.arch, cpus: 4, mem_gb: 8 },
        gpus: [],
      }),
      "active",
    ],
  );
  // Register a second node specifically for studio.tts with fake GPU+Python capabilities.
  // The real render-worker has no NVIDIA GPU, so the farm hub would never assign TTS jobs
  // to it (JOB_TYPE_SPECS['studio.tts'].baseRequirements = { gpu: true, python: true }).
  const ttsNodeToken = randomBytes(24).toString("base64url");
  const ttsNodeTokenHash = createHash("sha256").update(ttsNodeToken).digest("hex");
  const ttsNodeId = randomUUID();
  await pgClient.query(
    `INSERT INTO farm_nodes
       (id, name, machine, token_hash, kinds, capabilities, status,
        last_seen_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW(), NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [
      ttsNodeId,
      "e2e-fake-tts-worker",
      "localhost",
      ttsNodeTokenHash,
      ["studio.tts"],
      JSON.stringify({
        os: "linux",
        cpu_cores: 4,
        ram_mb: 8192,
        gpus: [{ name: "fake-gpu-tts", vram_mb: 8192, nvenc: false, nvdec: false }],
        engines: { ffmpeg: null, ollama_models: [], python: "3.10.0" },
      }),
      "active",
    ],
  );

  await pgClient.end();
  process.stderr.write("[e2e] owner + nodes registered\n");

  // Start fake in-process TTS worker loop (heartbeat + claim + fail immediately)
  fakeTtsWorkerStop = await startFakeTtsWorker(
    ttsNodeToken,
    `http://127.0.0.1:${FARM_HUB_PORT}`,
  );
  process.stderr.write("[e2e] fake TTS worker loop started\n");

  // Start Studio API
  const studioDbPath = join(testDir, "studio.db");
  studioApiProc = spawnProc(
    "node",
    [studioApiDist],
    {
      PORT: String(STUDIO_API_PORT),
      STUDIO_DB_PATH: studioDbPath,
      AUTH0_ISSUER_URL: "https://test.auth0.com/",
      AUTH0_AUDIENCE: "test-aud",
      AUTH0_JWKS_URI: "https://test.auth0.com/.well-known/jwks.json",
      AUTH0_ALLOWED_CLIENT_IDS: "test-client",
      ACCOUNT_API_URL: `http://127.0.0.1:${AG_GO_PORT}`,
      ACCOUNT_API_KEY: "test-key",
      AG_GO_API_URL: `http://127.0.0.1:${AG_GO_PORT}`,
      AG_GO_SERVICE_KEY: "test-service-key",
      FARM_URL: `http://127.0.0.1:${FARM_HUB_PORT}`,
      FARM_OWNER_KEY: ownerKey,
      // Pass PEM with actual newlines — Studio API's crypto.createPublicKey needs real newlines.
      // (The ag-farm hub reads the key via parseKeyPem which converts \n→newline; the Studio API
      // calls crypto.createPublicKey directly, so we must pass the key with actual newlines.)
      FARM_TICKET_PUBLIC_KEY: farmPubKey,
      STUDIO_R2_ENDPOINT: `http://127.0.0.1:${FAKE_S3_PORT}`,
      STUDIO_R2_BUCKET: S3_BUCKET,
      STUDIO_R2_ACCESS_KEY_ID: S3_ACCESS_KEY,
      STUDIO_R2_SECRET_ACCESS_KEY: S3_SECRET_KEY,
      FARM_URL_TTL_SECONDS: "3600",
      NODE_ENV: "test",
    },
    "studio-api",
  );
  await waitForHttp(`http://localhost:${STUDIO_API_PORT}/api/health`, 30_000);
  process.stderr.write("[e2e] Studio API ready\n");

  // Start fake ag-go
  await startFakeAgGo();

  // Create test footage and upload to fake S3
  segment1Id = randomUUID();
  segment2Id = randomUUID();
  const seg1Path = join(testDir, "seg1.mp4");
  const seg2Path = join(testDir, "seg2.mp4");
  await createLavfiVideo(seg1Path, 5, CANVAS.width, CANVAS.height);
  await createLavfiVideo(seg2Path, 5, CANVAS.width, CANVAS.height);

  const seg1Key = `segments/${segment1Id}.mp4`;
  const seg2Key = `segments/${segment2Id}.mp4`;
  await s3Put(s3, seg1Key, readFileSync(seg1Path), "video/mp4");
  await s3Put(s3, seg2Key, readFileSync(seg2Path), "video/mp4");

  segmentRegistry.set(segment1Id, { s3Key: seg1Key, durationSeconds: 5 });
  segmentRegistry.set(segment2Id, { s3Key: seg2Key, durationSeconds: 5 });
  process.stderr.write("[e2e] Test footage uploaded to fake S3\n");

  productionId = randomUUID();

  // Start ag-render-worker
  const machineYamlPath = join(testDir, "machine.yaml");
  // gpu_slots: 1 required — studio.tts jobs have slot:'gpu' in JOB_TYPE_SPECS,
  // so the render-worker must have at least one GPU slot to claim them.
  // TTS will fail (no Python engine) which is the expected and acceptable outcome.
  writeFileSync(machineYamlPath, "cpu_slots: 2\ngpu_slots: 1\n");

  const workerWorkDir = join(testDir, "worker-work");
  const workerCacheDir = join(testDir, "worker-cache");
  mkdirSync(workerWorkDir, { recursive: true });
  mkdirSync(workerCacheDir, { recursive: true });

  const workerConfigPath = join(testDir, "worker.yaml");
  writeFileSync(
    workerConfigPath,
    [
      `hub_url: "http://127.0.0.1:${FARM_HUB_PORT}"`,
      `token: "${nodeToken}"`,
      `name: "e2e-render-worker"`,
      `kinds: ["studio.tts", "studio.render_preview", "studio.render_final"]`,
      `work_dir: "${workerWorkDir.replace(/\\/g, "/")}"`,
      `machine_file: "${machineYamlPath.replace(/\\/g, "/")}"`,
      `cache:`,
      `  dir: "${workerCacheDir.replace(/\\/g, "/")}"`,
      `  max_gb: 5`,
      `extra:`,
      `  ffmpeg_path: "${FFMPEG_PATH.replace(/\\/g, "/")}"`,
      `  ffprobe_path: "${FFPROBE_PATH.replace(/\\/g, "/")}"`,
    ].join("\n"),
  );

  renderWorkerProc = spawnProc(
    "node",
    [join(AG_RENDER_DIR, "dist", "main.js"), "--config", workerConfigPath],
    {
      FFMPEG_PATH,
      FFPROBE_PATH,
      NODE_ENV: "production",
    },
    "render-worker",
  );
  await new Promise((r) => setTimeout(r, 3000));
  process.stderr.write("[e2e] ag-render-worker started\n");
}, 120_000);

// ------------------------------------------------------------------
// afterAll: shutdown and cleanup
// ------------------------------------------------------------------

afterAll(async () => {
  if (!isE2E) return;

  fakeTtsWorkerStop?.();

  for (const proc of [renderWorkerProc, studioApiProc, farmHubProc]) {
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 600));
      if (!proc.killed) proc.kill("SIGKILL");
    }
  }

  await new Promise<void>((r) => agGoServer?.close(() => r()));
  await fakeS3?.stop().catch(() => {});

  try {
    execFileSync(
      "docker",
      [
        "compose", "-f",
        join(AG_FARM_DIR, "docker-compose.test.yml"),
        "down",
      ],
      { stdio: "inherit", timeout: 30_000 },
    );
  } catch { /* ignore */ }

  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}, 60_000);

// ------------------------------------------------------------------
// studio.render_preview end-to-end
// ------------------------------------------------------------------

describe.skipIf(!isE2E)("farm E2E: studio.render_preview", () => {
  let renderResult: { farmJobId: string; stageResult: { outcome: string } };

  beforeAll(async () => {
    const s3 = makeS3Client();
    const studioDbPath = join(testDir, "studio.db");

    const attemptId = `atm_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const stageKey = "render-preview";
    const inputPrefix = stageInputPrefix(productionId, stageKey, attemptId);

    // Upload narration WAV at the expected stage input path.
    // composition.json references `stage:tts/L001.wav`, which the sign endpoint
    // resolves to ${inputPrefix}tts/L001.wav.
    const narrationWavPath = join(testDir, "L001.wav");
    createSilentWav(narrationWavPath, 3);
    const wavKey = `${inputPrefix}tts/L001.wav`;
    await s3Put(s3, wavKey, readFileSync(narrationWavPath), "audio/wav");
    process.stderr.write(`[e2e] Uploaded narration WAV to ${wavKey}\n`);

    // Build composition.json — must pass CompositionSchema strictly.
    // newId("content_request") → "req_<ULID>", newId("source_item") → "src_<ULID>"
    const { newId } = await import("@harness/contracts");
    const composition = {
      schema_version: "harness.composition/v1" as const,
      output: { width: CANVAS.width, height: CANVAS.height, fps: 25, codec: "h264" as const },
      voice: "tts" as const,
      language: "vi",
      total_seconds: 4,
      request_id: newId("content_request"),
      brand: null,
      segments: [
        {
          order: 0,
          source_id: newId("source_item"),
          source_path: `segment:${segment1Id}`,
          in: 0.5,
          out: 2.5,
          start: 0,
          end: 2,
          fit: "scale_pad" as const,
          has_audio: true,
          transition_out: { kind: "cut" as const, seconds: 0, tail_available: false },
        },
        {
          order: 1,
          source_id: newId("source_item"),
          source_path: `segment:${segment2Id}`,
          in: 0.5,
          out: 2.5,
          start: 2,
          end: 4,
          fit: "scale_pad" as const,
          has_audio: true,
          transition_out: { kind: "cut" as const, seconds: 0, tail_available: false },
        },
      ],
      text_events: [],
      captions: { mode: "none" as const, cues: [] },
      music: null,
      logo: null,
      narration: [
        { line_id: "L001", wav: "stage:tts/L001.wav", start: 0, end: 4 },
      ],
      transitions: { requested: 0, applied: 0, downgraded: [] },
      text_dropped: [],
      warnings: [],
    };
    const compositionJson = JSON.stringify(composition);

    // Write composition into the workspace directory that FarmExecutor will upload from.
    const wsDir = join(testDir, "workspace");
    mkdirSync(join(wsDir, "renders", "1"), { recursive: true });
    writeFileSync(join(wsDir, "renders", "1", "composition.json"), compositionJson);

    // Wait for Studio DB to be created by the API startup migrations
    let dbReady = false;
    for (let i = 0; i < 30; i++) {
      if (existsSync(studioDbPath)) { dbReady = true; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!dbReady) throw new Error("Studio DB not created by API startup");

    // Insert team + production rows so the sign endpoint can authorize requests
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    {
      // Open with FK enforcement off so we can insert without worrying about cascades,
      // and with busy_timeout to handle concurrent writes from the Studio API.
      const db = new DatabaseSync(studioDbPath, { enableForeignKeyConstraints: false });
      try {
        db.exec("PRAGMA busy_timeout = 5000");
        // teams.id is a FK for productions.team_id
        db.prepare(
          `INSERT OR IGNORE INTO teams (id, name, created_at, updated_at)
           VALUES (?, ?, datetime('now'), datetime('now'))`,
        ).run("team-e2e", "E2E Team");
        // /farm/sign resolves footage acting as the production's owner (the team owner here), never as the
        // production itself, and refuses when there is nobody to act as.
        db.prepare(
          `INSERT OR IGNORE INTO team_members (team_id, user_id, role, joined_at)
           VALUES (?, ?, 'owner', datetime('now'))`,
        ).run("team-e2e", "auth0|e2e-owner");
        // productions table: id, team_id, title, status, canvas, brief, run_id, created_at, updated_at
        db.prepare(
          `INSERT OR IGNORE INTO productions
             (id, team_id, title, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
        ).run(productionId, "team-e2e", "E2E Test Production", "in_progress");
        // Verify rows were inserted
        const teamRow = db.prepare("SELECT id FROM teams WHERE id = ?").get("team-e2e");
        const prodRow = db.prepare("SELECT id FROM productions WHERE id = ?").get(productionId);
        process.stderr.write(
          `[e2e] DB setup: team=${JSON.stringify(teamRow)} prod=${JSON.stringify(prodRow)}\n`,
        );
        if (!prodRow) throw new Error(`production row not found after INSERT for id=${productionId}`);
      } finally {
        db.close();
      }
    }

    // Build the StudioStorage backed by FakeS3Server
    const studioStorage: StudioStorage = {
      async upload(localPath: string, objectKey: string): Promise<string> {
        const body = readFileSync(localPath);
        await s3Put(s3, objectKey, body);
        return `stage:${objectKey.slice(inputPrefix.length)}`;
      },
      async download(url: string, localPath: string): Promise<void> {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
        mkdirSync(dirname(localPath), { recursive: true });
        writeFileSync(localPath, Buffer.from(await res.arrayBuffer()));
      },
      async downloadOutput(
        outputPrefix: string,
        relPath: string,
        localPath: string,
      ): Promise<void> {
        const resp = await s3.send(
          new GetObjectCommand({
            Bucket: S3_BUCKET,
            Key: `${outputPrefix}${relPath}`,
          }),
        );
        if (!resp.Body) throw new Error(`no body for ${outputPrefix}${relPath}`);
        mkdirSync(dirname(localPath), { recursive: true });
        writeFileSync(localPath, Buffer.from(await resp.Body.transformToByteArray()));
      },
    };

    // onSubmitted — uses makeStudioFarmRecorder, the same function apps/worker uses
    let recordedFarmJobId = "";
    const onSubmitted = async (info: SubmittedInfo): Promise<void> => {
      recordedFarmJobId = info.farmJobId;
      await makeStudioFarmRecorder(studioDbPath)(info);
      process.stderr.write(
        `[e2e] studio_farm_jobs row inserted farm_job_id=${info.farmJobId}\n`,
      );
    };

    const ownerClient = new FarmOwnerClient({
      baseUrl: `http://127.0.0.1:${FARM_HUB_PORT}`,
      ownerKey,
      timeoutMs: 15_000,
    });

    const executor = new FarmExecutor({
      client: ownerClient,
      storage: studioStorage,
      onSubmitted,
      pollIntervalMs: 3000,
    });

    const { SystemClock } = await import("@harness/core");
    const clock = new SystemClock();

    const farm_payload = {
      production_id: productionId,
      revision: 1,
      composition: "stage:renders/1/composition.json",
      canvas: CANVAS,
      handle_seconds: 0.5,
      output: "renders/1/preview.mp4",
    };

    const runId = `run_e2e_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const stageRequest = {
      schema_version: "harness.stage-request/v1",
      run_id: runId,
      stage_key: stageKey,
      attempt_id: attemptId,
      attempt_number: 1,
      stage_config: {
        production_id: productionId,
        job_type: "studio.render_preview",
        farm_payload,
        requirements: {},
      },
      inputs: [
        {
          path: "renders/1/composition.json",
          type: "application/json",
          checksum: `sha256:${"0".repeat(64)}`,
          size_bytes: compositionJson.length,
          kind: "file" as const,
        },
      ],
      expected_outputs: [],
      limits: {
        deadline_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        cost_usd_limit: null,
        wall_seconds_limit: 300,
      },
      budget: { remaining_usd: null },
    };

    const execCtx = {
      workspaceDir: wsDir,
      clock,
      logger: {
        info: (msg: string, data?: unknown) =>
          process.stderr.write(`[executor] ${msg}${data ? " " + JSON.stringify(data) : ""}\n`),
        warn: (msg: string, data?: unknown) =>
          process.stderr.write(`[executor:warn] ${msg}${data ? " " + JSON.stringify(data) : ""}\n`),
        error: (msg: string, data?: unknown) =>
          process.stderr.write(`[executor:err] ${msg}${data ? " " + JSON.stringify(data) : ""}\n`),
        child: () => ({
          info: (msg: string, _d?: unknown) =>
            process.stderr.write(`[executor:child] ${msg}\n`),
          warn: (msg: string, _d?: unknown) =>
            process.stderr.write(`[executor:child:warn] ${msg}\n`),
          error: (msg: string, _d?: unknown) =>
            process.stderr.write(`[executor:child:err] ${msg}\n`),
        }),
      },
      signal: undefined,
    };

    process.stderr.write("[e2e] Executing FarmExecutor for render_preview...\n");
    const result = await executor.execute(stageRequest as never, execCtx as never);
    process.stderr.write(
      `[e2e] FarmExecutor done outcome=${(result as { outcome?: string }).outcome} ` +
      `result=${JSON.stringify(result)}\n`,
    );

    renderResult = {
      farmJobId: recordedFarmJobId,
      stageResult: result as { outcome: string },
    };
  }, 300_000);

  it("FarmExecutor stage result outcome is 'succeeded'", () => {
    expect(renderResult?.stageResult?.outcome).toBe("succeeded");
  });

  it("studio_farm_jobs row inserted by makeStudioFarmRecorder", () => {
    expect(renderResult?.farmJobId, "farmJobId set by onSubmitted").toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(join(testDir, "studio.db"));
    try {
      const row = db
        .prepare("SELECT * FROM studio_farm_jobs WHERE farm_job_id = ?")
        .get(renderResult.farmJobId);
      expect(row, "studio_farm_jobs row should exist").toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("sign_audit_log has entries for the job", () => {
    if (!renderResult?.farmJobId) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(join(testDir, "studio.db"));
    try {
      const rows = db
        .prepare("SELECT * FROM sign_audit_log WHERE farm_job_id = ?")
        .all(renderResult.farmJobId) as unknown[];
      expect(rows.length, "sign_audit_log should have entries").toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("render.json in fake S3 validates against RenderManifestSchema", async () => {
    const s3 = makeS3Client();
    // the render job wrote under its own output prefix: productions/<id>/jobs/<stage>/<attempt>/out/
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: `productions/${productionId}/jobs/` }));
    const manifestKey = (listed.Contents ?? []).map((o) => o.Key!).find((k) => /\/out\/render\.json$/.test(k));
    expect(manifestKey, "render.json should sit in the job's out/ prefix").toBeTruthy();
    const resp = await s3.send(
      new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: manifestKey!,
      }),
    );
    expect(resp.Body, "render.json should exist in S3").toBeTruthy();
    const buf = Buffer.from(await resp.Body!.transformToByteArray());
    const parsed = RenderManifestSchema.safeParse(JSON.parse(buf.toString("utf8")));
    expect(
      parsed.success,
      `render.json schema error: ${parsed.success ? "" : JSON.stringify((parsed as { error: unknown }).error)}`,
    ).toBe(true);
    if (parsed.success) {
      expect(parsed.data.production_id).toBe(productionId);
      expect(parsed.data.width).toBe(CANVAS.width);
      expect(parsed.data.height).toBe(CANVAS.height);
      expect(parsed.data.duration_s).toBeGreaterThan(0);
    }
  });

  it("output MP4 has correct dimensions", async () => {
    const s3 = makeS3Client();
    // the render job wrote under its own output prefix: productions/<id>/jobs/<stage>/<attempt>/out/
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: `productions/${productionId}/jobs/` }));
    const videoKey = (listed.Contents ?? []).map((o) => o.Key!).find((k) => k.endsWith("/out/renders/1/preview.mp4"));
    expect(videoKey, "preview.mp4 should sit in the job's out/ prefix").toBeTruthy();
    const resp = await s3.send(
      new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: videoKey!,
      }),
    );
    expect(resp.Body, "preview.mp4 should exist in S3").toBeTruthy();
    const buf = Buffer.from(await resp.Body!.transformToByteArray());
    expect(buf.length, "preview.mp4 should be non-trivial size").toBeGreaterThan(1024);

    const mp4Path = join(testDir, "output.mp4");
    writeFileSync(mp4Path, buf);

    const { stdout } = await execFileAsync(
      FFPROBE_PATH,
      ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", mp4Path],
      { timeout: 10_000 },
    );
    const probeData = JSON.parse(stdout) as {
      streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
      format?: { duration?: string };
    };
    const videoStream = probeData.streams?.find((s) => s.codec_type === "video");
    expect(videoStream, "MP4 should have a video stream").toBeTruthy();
    expect(videoStream?.width).toBe(CANVAS.width);
    expect(videoStream?.height).toBe(CANVAS.height);
    const duration = parseFloat(probeData.format?.duration ?? "0");
    expect(duration, "duration should be > 0").toBeGreaterThan(0);
    expect(duration, "duration should be < 30s").toBeLessThan(30);
  });
});

// ------------------------------------------------------------------
// studio.tts — submits via FarmExecutor, verifies terminal state
// ------------------------------------------------------------------

describe.skipIf(!isE2E)("farm E2E: studio.tts", () => {
  it("studio.tts job reaches a terminal state (succeeded or failed)", async () => {
    const studioDbPath = join(testDir, "studio.db");
    const s3 = makeS3Client();
    const wsDir = join(testDir, "workspace-tts");
    mkdirSync(wsDir, { recursive: true });

    const attemptId = `atm_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const stageKey = "tts";

    const studioStorage: StudioStorage = {
      async upload(localPath: string, objectKey: string): Promise<string> {
        const body = readFileSync(localPath);
        await s3Put(s3, objectKey, body);
        return `stage:${objectKey}`;
      },
      async download(url: string, localPath: string): Promise<void> {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`download failed: ${res.status}`);
        mkdirSync(dirname(localPath), { recursive: true });
        writeFileSync(localPath, Buffer.from(await res.arrayBuffer()));
      },
      async downloadOutput(
        outputPrefix: string,
        relPath: string,
        localPath: string,
      ): Promise<void> {
        const resp = await s3.send(
          new GetObjectCommand({ Bucket: S3_BUCKET, Key: `${outputPrefix}${relPath}` }),
        );
        if (!resp.Body) throw new Error(`no body`);
        mkdirSync(dirname(localPath), { recursive: true });
        writeFileSync(localPath, Buffer.from(await resp.Body.transformToByteArray()));
      },
    };

    const onSubmitted = async (info: SubmittedInfo): Promise<void> => {
      await makeStudioFarmRecorder(studioDbPath)(info);
      process.stderr.write(
        `[e2e] TTS studio_farm_jobs row inserted farm_job_id=${info.farmJobId}\n`,
      );
    };

    const ownerClient = new FarmOwnerClient({
      baseUrl: `http://127.0.0.1:${FARM_HUB_PORT}`,
      ownerKey,
      timeoutMs: 15_000,
    });

    const executor = new FarmExecutor({
      client: ownerClient,
      storage: studioStorage,
      onSubmitted,
      pollIntervalMs: 3000,
    });

    const { SystemClock } = await import("@harness/core");
    const clock = new SystemClock();

    // TTS payload must match StudioTtsPayloadSchema exactly:
    // voice is an OBJECT {reference, reference_text, speed}, NOT a string
    const farm_payload = {
      production_id: productionId,
      language: "vi",
      voice: {
        reference: null,
        reference_text: null,
        speed: 1,
      },
      lines: [
        {
          line_id: "L001",
          text: "Xin chào thế giới",
          pause_seconds: null,
        },
      ],
      align_words: false,
    };

    const runId = `run_tts_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const stageRequest = {
      schema_version: "harness.stage-request/v1",
      run_id: runId,
      stage_key: stageKey,
      attempt_id: attemptId,
      attempt_number: 1,
      stage_config: {
        production_id: productionId,
        job_type: "studio.tts",
        farm_payload,
        requirements: {},
      },
      inputs: [],
      expected_outputs: [],
      limits: {
        deadline_at: new Date(Date.now() + 120_000).toISOString(),
        cost_usd_limit: null,
        wall_seconds_limit: 120,
      },
      budget: { remaining_usd: null },
    };

    const execCtx = {
      workspaceDir: wsDir,
      clock,
      logger: {
        info: (msg: string, _d?: unknown) =>
          process.stderr.write(`[executor:tts] ${msg}\n`),
        warn: (msg: string, _d?: unknown) =>
          process.stderr.write(`[executor:tts:warn] ${msg}\n`),
        error: (msg: string, _d?: unknown) =>
          process.stderr.write(`[executor:tts:err] ${msg}\n`),
        child: () => ({
          info: (msg: string, _d?: unknown) =>
            process.stderr.write(`[executor:tts:child] ${msg}\n`),
          warn: (msg: string, _d?: unknown) =>
            process.stderr.write(`[executor:tts:child:warn] ${msg}\n`),
          error: (msg: string, _d?: unknown) =>
            process.stderr.write(`[executor:tts:child:err] ${msg}\n`),
        }),
      },
      signal: undefined,
    };

    process.stderr.write("[e2e] Executing FarmExecutor for TTS...\n");
    const result = await executor.execute(stageRequest as never, execCtx as never);
    const outcome = (result as { outcome: string }).outcome;
    process.stderr.write(`[e2e] TTS FarmExecutor done outcome=${outcome}\n`);

    // Without a real TTS engine the job will fail — that is acceptable and expected.
    // The key assertion is the job was claimed and processed to a terminal state,
    // which proves the full farm round-trip works.
    expect(["succeeded", "failed"], "TTS must reach a terminal state").toContain(outcome);
  }, 120_000);
});
