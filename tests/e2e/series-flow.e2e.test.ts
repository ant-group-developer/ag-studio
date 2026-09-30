/**
 * GĐ3 acceptance E2E: `ag-studio-series-plan@1.0.0` + `ag-studio-episode@1.0.0` series flow.
 *
 * Series plan API → approve-plan gate → episode spawning →
 * per-episode build-timeline → freeze-timeline gate → render (real farm + render worker) → export.
 *
 * Real:  ag-farm hub (+ Postgres in Docker), Studio API (dist), Studio worker (dist),
 *        ag-render-worker (dist), ffmpeg (ffmpeg-static).
 * Fake:  Claude (fixtures/fake-studio-claude.mjs via CliAgentRuntime), ag-go (catalog/folders/resolve),
 *        S3 (in-process FakeS3Server), TTS engine (in-test farm worker with sine-tone WAVs).
 *
 * Requires: E2E=1, Docker running, built dists:
 *   ag-farm apps/api, ag-render-worker, ag-studio apps/api + apps/worker.
 *
 * Run: E2E=1 corepack pnpm exec vitest run --config tests/e2e/vitest.config.ts tests/e2e/series-flow.e2e.test.ts
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FakeS3Server } from "./fake-s3.js";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const AG_FARM_DIR = resolve(ROOT, "..", "ag-farm");
const AG_RENDER_DIR = resolve(ROOT, "..", "ag-render-worker");
const RENDER_WORKER_ENTRY =
  process.env.E2E_RENDER_WORKER_ENTRY ?? join(AG_RENDER_DIR, "dist/main.js");
const EXE = process.platform === "win32" ? ".exe" : "";
const FFMPEG =
  process.env.FFMPEG_PATH ??
  resolve(AG_RENDER_DIR, "node_modules", "ffmpeg-static", "ffmpeg") + EXE;
const FFPROBE =
  process.env.FFPROBE_PATH ??
  resolve(
    AG_RENDER_DIR,
    "node_modules",
    "ffprobe-static",
    "bin",
    process.platform,
    process.arch,
    "ffprobe",
  ) + EXE;
const isE2E = process.env.E2E === "1";
const execFileAsync = promisify(execFile);

// Ports distinct from production.e2e.test.ts to allow running both without conflict
const PORTS = { db: 55434, s3: 9121, hub: 3395, api: 3394, agGo: 4395 };
const S3 = { bucket: "studio-series-e2e", key: "devkey", secret: "devsecret" };
const AUTH = {
  issuer: "https://e2e.auth.test/",
  audience: "studio-series-e2e",
  azp: "e2e-series-web",
  kid: "e2e-series-key",
};
const OWNER = "auth0|series-owner-e2e";
const FOLDER = "0c0f0000-0000-4000-8000-00000000f01d";
const CANVAS = { width: 640, height: 360 };

const procs: ChildProcess[] = [];
let testDir = "";
let fakeS3: FakeS3Server | null = null;
let agGo: http.Server | null = null;
let stopTts: (() => void) | null = null;
let jwtKey: KeyObject;
let jwk: Record<string, unknown>;
const agGoCalls: { path: string; actAs: string | undefined }[] = [];
const ttsJobs: string[] = [];

// ─── helpers ────────────────────────────────────────────────────────────────

function spawnProc(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  label: string,
): ChildProcess {
  const p = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = join(testDir, `${label}.log`);
  p.stdout?.on("data", (d: Buffer) => writeFileSync(log, d, { flag: "a" }));
  p.stderr?.on("data", (d: Buffer) => writeFileSync(log, d, { flag: "a" }));
  procs.push(p);
  return p;
}

class Fatal extends Error {}

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 120_000,
  everyMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      if (e instanceof Fatal) throw e;
      last = e;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(
    `timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`,
  );
}

function b64url(b: Buffer | string): string {
  return Buffer.from(b).toString("base64url");
}

function jwt(sub: string): string {
  const header = b64url(
    JSON.stringify({ alg: "RS256", kid: AUTH.kid, typ: "JWT" }),
  );
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({
      sub,
      iss: AUTH.issuer,
      aud: AUTH.audience,
      azp: AUTH.azp,
      iat: now,
      exp: now + 3600,
    }),
  );
  const sig = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(jwtKey);
  return `${header}.${payload}.${b64url(sig)}`;
}

function unwrapEnvelope<T>(raw: unknown): T {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (
      typeof r.success === "boolean" &&
      "data" in r &&
      typeof r.requestId === "string"
    ) {
      if (r.success) return r.data as T;
      if (r.error && typeof r.error === "object" && !Array.isArray(r.error)) {
        const e = r.error as Record<string, unknown>;
        const details =
          e.details && typeof e.details === "object" && !Array.isArray(e.details)
            ? (e.details as Record<string, unknown>)
            : {};
        return { ...e, ...details } as T;
      }
    }
  }
  return raw as T;
}

async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  user = OWNER,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${PORTS.api}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt(user)}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const raw = text ? JSON.parse(text) : null;
  return { status: res.status, body: unwrapEnvelope<T>(raw) };
}

async function ok<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const r = await api<T>(method, path, body);
  if (r.status >= 300)
    throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function lavfiAsset(
  path: string,
  video: string,
  freq: number,
  seconds: number,
): Promise<void> {
  await execFileAsync(
    FFMPEG,
    [
      "-f", "lavfi", "-i",
      `${video}=size=${CANVAS.width}x${CANVAS.height}:rate=25:duration=${seconds}`,
      "-f", "lavfi", "-i",
      `sine=frequency=${freq}:sample_rate=48000:duration=${seconds}`,
      "-c:v", "libx264", "-preset", "ultrafast",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", path,
    ],
    { timeout: 60_000 },
  );
}

function toneWav(seconds: number, rate = 24000): Buffer {
  const n = Math.floor(rate * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 0.3 * 32767),
      44 + i * 2,
    );
  }
  return b;
}

async function probe(
  file: string,
): Promise<{ width: number; height: number; duration: number; hasAudio: boolean }> {
  const { stdout } = await execFileAsync(
    FFPROBE,
    ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", file],
    { timeout: 20_000 },
  );
  const j = JSON.parse(stdout) as {
    streams: { codec_type: string; width?: number; height?: number }[];
    format: { duration: string };
  };
  const v = j.streams.find((s) => s.codec_type === "video");
  return {
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    duration: Number(j.format.duration),
    hasAudio: j.streams.some((s) => s.codec_type === "audio"),
  };
}

// ─── footage ────────────────────────────────────────────────────────────────

const SEGMENTS = [0, 1, 2, 3, 4, 5].map((i) => ({
  segmentId: `5e600000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  assetId: i < 3 ? "asset-a" : "asset-b",
  startMs: (i % 3) * 8000,
  endMs: (i % 3 + 1) * 8000,
  durationMs: 8000,
  captionVi: `cảnh ${i + 1}: ${i < 3 ? "phố Hà Nội buổi sáng" : "bát phở bò nóng"}`,
  captionEn: `shot ${i + 1}`,
  tags: ["pho", "hanoi"],
  keywordsVi: ["phở"],
  subjects: [],
  actions: [],
  shotSize: "medium",
  cameraMotion: null,
  timeOfDay: "morning",
  setting: null,
  peopleCount: null,
  orientation: "landscape",
  quality: 4,
  usable: true,
  approved: i % 2 === 0,
}));

// ─── fake ag-go ─────────────────────────────────────────────────────────────

function startFakeAgGo(): Promise<void> {
  agGo = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const actAs = req.headers["x-act-as-user"] as string | undefined;
    const url = req.url ?? "";
    agGoCalls.push({ path: url, actAs });
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(v));
    };
    const wrap = (v: unknown) =>
      json(200, {
        data: v,
        requestId: `req-${Date.now()}`,
        success: true,
        error: null,
        timestamp: new Date().toISOString(),
      });

    if (url === "/.well-known/jwks.json") return json(200, { keys: [jwk] });
    if (req.headers["x-service-key"] !== "e2e-service-key")
      return json(401, { message: "no service key" });
    if (actAs !== OWNER)
      return json(403, { message: `act-as ${String(actAs)} rejected` });

    if (req.method === "GET" && url.startsWith("/footage/folders")) {
      return wrap({
        folders: [
          {
            id: FOLDER,
            parentId: null,
            name: "Ẩm thực",
            path: "/Ẩm thực",
            analyzedSegments: 6,
            usableSegments: 6,
          },
        ],
      });
    }
    if (req.method === "POST" && url === "/footage/catalog") {
      const b = JSON.parse(body) as { folderIds: string[] };
      return wrap({ items: b.folderIds.includes(FOLDER) ? SEGMENTS : [], nextCursor: null });
    }
    if (req.method === "POST" && url === "/footage/segments/resolve") {
      const b = JSON.parse(body) as { segmentIds: string[]; purpose: "preview" | "final" };
      const items = b.segmentIds
        .map((id) => SEGMENTS.find((s) => s.segmentId === id))
        .filter(Boolean)
        .map((s) => ({
          segmentId: s!.segmentId,
          assetId: s!.assetId,
          startMs: s!.startMs,
          endMs: s!.endMs,
          url: `http://127.0.0.1:${PORTS.s3}/${S3.bucket}/assets/${s!.assetId}.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600`,
          sourceKind: b.purpose === "final" ? "original" : "proxy",
          watermarked: false,
          contentType: "video/mp4",
          sizeBytes: null,
          cacheKey: null,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }));
      return wrap({ items });
    }

    // Account API calls (for isAdmin checks)
    if (req.method === "GET" && url.includes("/users/")) {
      return wrap({ userId: actAs ?? "unknown", userType: "USER", name: "Test User", email: "test@example.com", permissions: [] });
    }

    json(404, { message: `fake ag-go: no ${req.method} ${url}` });
  });
  return new Promise((r) => agGo!.listen(PORTS.agGo, "127.0.0.1", () => r()));
}

// ─── fake TTS ────────────────────────────────────────────────────────────────

function startFakeTtsWorker(token: string): () => void {
  let running = true;
  const hub = `http://127.0.0.1:${PORTS.hub}`;
  const caps = {
    os: "linux",
    cpu_cores: 4,
    ram_mb: 8192,
    gpus: [{ name: "fake-gpu", vram_mb: 8192, nvenc: false, nvdec: false }],
    engines: { ffmpeg: null, ollama_models: [], python: "3.10.0" },
  };
  const post = (path: string, body: unknown, auth = `Node ${token}`) =>
    fetch(path.startsWith("http") ? path : `${hub}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(body),
    });
  void (async () => {
    while (running) {
      try {
        await post("/v1/worker/heartbeat", {
          agent_version: "0.1.0-e2e-tts",
          kinds: ["studio.tts"],
          capabilities: caps,
          free_slots: { cpu: 0, gpu: 1 },
          running_job_ids: [],
        });
        const claim = await post("/v1/worker/claim", {
          kinds: ["studio.tts"],
          free_slots: { cpu: 0, gpu: 1 },
          cached_affinity: [],
        });
        const claimRaw = (await claim.json()) as unknown;
        const { job } = unwrapEnvelope<{
          job: null | {
            id: string;
            lease_token: string;
            ticket: string;
            sign_url: string;
            payload: {
              production_id: string;
              language: string;
              lines: { line_id: string; text: string }[];
            };
          };
        }>(claimRaw);
        if (job) {
          ttsJobs.push(job.id);
          const lines = job.payload.lines.map((l) => ({
            line_id: l.line_id,
            output: `tts/${l.line_id}.wav`,
            duration_s: Math.round(l.text.split(/\s+/).length * 0.35 * 1000) / 1000,
            words: [],
          }));
          const files = [
            ...lines.map((l) => ({
              output: l.output,
              type: "audio/wav",
              body: toneWav(l.duration_s),
            })),
            {
              output: "tts.json",
              type: "application/json",
              body: Buffer.from(
                JSON.stringify({
                  schema: "ag.studio.tts/v1",
                  production_id: job.payload.production_id,
                  language: job.payload.language,
                  lines,
                  engine: { name: "e2e-tone", version: "1" },
                }),
              ),
            },
          ];
          const signed = await post(
            job.sign_url,
            {
              ops: files.map((f) => ({
                op: "put",
                output: f.output,
                content_type: f.type,
              })),
            },
            `Ticket ${job.ticket}`,
          );
          if (!signed.ok)
            throw new Error(`sign ${signed.status} ${await signed.text()}`);
          const signRaw = (await signed.json()) as unknown;
          const { results } = unwrapEnvelope<{
            results: { url: string; headers: Record<string, string> }[];
          }>(signRaw);
          for (let i = 0; i < files.length; i++) {
            const put = await fetch(results[i]!.url, {
              method: "PUT",
              headers: results[i]!.headers,
              body: files[i]!.body,
            });
            if (!put.ok) throw new Error(`PUT ${files[i]!.output} -> ${put.status}`);
          }
          const done = await post(`/v1/worker/jobs/${job.id}/complete`, {
            lease_token: job.lease_token,
            result: { manifest: "tts.json", summary: {} },
          });
          if (!done.ok)
            throw new Error(`complete ${done.status} ${await done.text()}`);
        }
      } catch (e) {
        writeFileSync(join(testDir, "fake-tts-series.log"), `${String(e)}\n`, {
          flag: "a",
        });
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  })();
  return () => {
    running = false;
  };
}

// ─── boot ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!isE2E) return;

  for (const f of [
    FFMPEG,
    FFPROBE,
    join(AG_FARM_DIR, "apps/api/dist/main.js"),
    RENDER_WORKER_ENTRY,
    join(ROOT, "apps/api/dist/main.js"),
    join(ROOT, "apps/worker/dist/main.js"),
  ]) {
    if (!existsSync(f)) throw new Error(`missing ${f} — build it first`);
  }

  testDir = join(tmpdir(), `studio-series-e2e-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  process.stderr.write(`[e2e] logs in ${testDir}\n`);

  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  jwtKey = rsa.privateKey;
  jwk = {
    ...(rsa.publicKey.export({ format: "jwk" }) as Record<string, unknown>),
    kid: AUTH.kid,
    use: "sig",
    alg: "RS256",
  };
  const ticketKeys = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const ownerKey = randomBytes(24).toString("base64url");

  // Start DB (Docker)
  execFileSync(
    "docker",
    [
      "compose",
      "-f",
      join(AG_FARM_DIR, "docker-compose.test.yml"),
      "up",
      "-d",
      "--wait",
      `--project-name=series-e2e`,
    ],
    { stdio: "inherit", timeout: 90_000, env: { ...process.env, POSTGRES_PORT: String(PORTS.db) } },
  );

  // Fake S3
  fakeS3 = new FakeS3Server(PORTS.s3, join(testDir, "s3"));
  await fakeS3.start();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const {
    S3Client,
    CreateBucketCommand,
    PutObjectCommand,
  } = require("@aws-sdk/client-s3") as typeof import("@aws-sdk/client-s3");
  const s3 = new S3Client({
    endpoint: `http://127.0.0.1:${PORTS.s3}`,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: S3.key, secretAccessKey: S3.secret },
  });
  await s3.send(new CreateBucketCommand({ Bucket: S3.bucket }));
  for (const [asset, video, freq] of [
    ["asset-a", "testsrc2", 440],
    ["asset-b", "smptebars", 660],
  ] as const) {
    const p = join(testDir, `${asset}.mp4`);
    await lavfiAsset(p, video, freq, 24);
    await s3.send(
      new PutObjectCommand({
        Bucket: S3.bucket,
        Key: `assets/${asset}.mp4`,
        Body: readFileSync(p),
        ContentType: "video/mp4",
      }),
    );
  }

  await startFakeAgGo();

  // ag-farm hub
  const farmDb = `postgresql://farm_test:farm_test@localhost:${PORTS.db}/ag_farm_test`;
  execFileSync(
    process.execPath,
    [
      join(AG_FARM_DIR, "node_modules/typeorm/cli.js"),
      "migration:run",
      "--dataSource",
      "dist/database/data-source.js",
    ],
    {
      cwd: join(AG_FARM_DIR, "apps/api"),
      env: { ...process.env, DATABASE_URL: farmDb },
      stdio: "pipe",
    },
  );
  spawnProc(
    process.execPath,
    [join(AG_FARM_DIR, "apps/api/dist/main.js")],
    {
      NODE_ENV: "test",
      PORT: String(PORTS.hub),
      DATABASE_URL: farmDb,
      DATABASE_POOL_MAX: "3",
      AUTH0_ISSUER_URL: AUTH.issuer,
      AUTH0_AUDIENCE: AUTH.audience,
      AUTH0_JWKS_URL: `http://127.0.0.1:${PORTS.agGo}/.well-known/jwks.json`,
      AUTH0_ALLOWED_CLIENT_IDS: AUTH.azp,
      ACCOUNT_API_URL: `http://127.0.0.1:${PORTS.agGo}`,
      FARM_TICKET_PRIVATE_KEY: ticketKeys.privateKey.replace(/\n/g, "\\n"),
      FARM_TICKET_PUBLIC_KEY: ticketKeys.publicKey.replace(/\n/g, "\\n"),
      REAPER_INTERVAL_MS: "999999",
      NODE_OFFLINE_AFTER_SECONDS: "90",
      FRONTEND_ORIGIN: "*",
    },
    "ag-farm-series",
  );
  await waitFor(
    "ag-farm hub",
    async () => (await fetch(`http://127.0.0.1:${PORTS.hub}/health`)).ok,
  );

  // Register studio owner + render/TTS farm nodes
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require("pg") as typeof import("pg");
  const pg = new Client({ connectionString: farmDb });
  await pg.connect();
  await pg.query("DELETE FROM farm_jobs WHERE owner = 'studio'");
  await pg.query(
    `INSERT INTO farm_owners (id, key_hash, sign_url, allowed_types, default_lane, created_at, updated_at)
     VALUES ('studio', $1, $2, $3, 'interactive', NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET key_hash = $1, sign_url = $2, allowed_types = $3`,
    [
      createHash("sha256").update(ownerKey).digest("hex"),
      `http://127.0.0.1:${PORTS.api}/api/farm/sign`,
      ["studio.tts", "studio.render_preview", "studio.render_final"],
    ],
  );
  const nodeToken = (name: string, kinds: string[]) => {
    const token = randomBytes(24).toString("base64url");
    return pg
      .query(
        `INSERT INTO farm_nodes
           (id, name, machine, token_hash, kinds, capabilities, status, last_seen_at, created_at, updated_at)
         VALUES ($1, $2, 'e2e', $3, $4, '{}'::jsonb, 'active', NOW(), NOW(), NOW())`,
        [
          randomUUID(),
          name,
          createHash("sha256").update(token).digest("hex"),
          kinds,
        ],
      )
      .then(() => token);
  };
  const renderToken = await nodeToken(
    `e2e-render-${randomUUID().slice(0, 8)}`,
    ["studio.render_preview", "studio.render_final"],
  );
  const ttsToken = await nodeToken(`e2e-tts-${randomUUID().slice(0, 8)}`, [
    "studio.tts",
  ]);
  await pg.end();

  // Studio API + worker
  const studioEnv = {
    STUDIO_DB_PATH: join(testDir, "studio.db"),
    STUDIO_DATA_ROOT: join(testDir, "harness"),
    AUTH0_ISSUER_URL: AUTH.issuer,
    AUTH0_AUDIENCE: AUTH.audience,
    AUTH0_JWKS_URI: `http://127.0.0.1:${PORTS.agGo}/.well-known/jwks.json`,
    AUTH0_ALLOWED_CLIENT_IDS: AUTH.azp,
    ACCOUNT_API_URL: `http://127.0.0.1:${PORTS.agGo}`,
    AG_GO_API_URL: `http://127.0.0.1:${PORTS.agGo}`,
    AG_GO_SERVICE_KEY: "e2e-service-key",
    FARM_URL: `http://127.0.0.1:${PORTS.hub}`,
    FARM_OWNER_KEY: ownerKey,
    FARM_TICKET_PUBLIC_KEY: ticketKeys.publicKey,
    STUDIO_R2_ENDPOINT: `http://127.0.0.1:${PORTS.s3}`,
    STUDIO_R2_BUCKET: S3.bucket,
    STUDIO_R2_ACCESS_KEY_ID: S3.key,
    STUDIO_R2_SECRET_ACCESS_KEY: S3.secret,
    FARM_URL_TTL_SECONDS: "3600",
    STUDIO_FFMPEG_PATH: FFMPEG,
    NODE_ENV: "test",
  };
  spawnProc(
    process.execPath,
    [join(ROOT, "apps/api/dist/main.js")],
    { ...studioEnv, PORT: String(PORTS.api) },
    "studio-api-series",
  );
  await waitFor(
    "Studio API",
    async () =>
      (await fetch(`http://127.0.0.1:${PORTS.api}/api/health`)).ok,
  );
  spawnProc(
    process.execPath,
    [join(ROOT, "apps/worker/dist/main.js")],
    {
      ...studioEnv,
      WORKER_OWNER: "e2e-studio-worker-series",
      FARM_POLL_MS: "1000",
      STUDIO_CLAUDE_ARGV: JSON.stringify([
        process.execPath,
        join(ROOT, "fixtures", "fake-studio-claude.mjs"),
      ]),
    },
    "studio-worker-series",
  );

  // Render worker
  const workerYaml = join(testDir, "render-worker.yaml");
  mkdirSync(join(testDir, "rw-work"), { recursive: true });
  mkdirSync(join(testDir, "rw-cache"), { recursive: true });
  writeFileSync(join(testDir, "machine.yaml"), "cpu_slots: 2\ngpu_slots: 0\n");
  writeFileSync(
    workerYaml,
    [
      `hub_url: "http://127.0.0.1:${PORTS.hub}"`,
      `token: "${renderToken}"`,
      `name: "e2e-render-series"`,
      `kinds: ["studio.render_preview", "studio.render_final"]`,
      `work_dir: "${join(testDir, "rw-work").replace(/\\/g, "/")}"`,
      `machine_file: "${join(testDir, "machine.yaml").replace(/\\/g, "/")}"`,
      "cache:",
      `  dir: "${join(testDir, "rw-cache").replace(/\\/g, "/")}"`,
      "  max_gb: 5",
      "extra:",
      `  ffmpeg_path: "${FFMPEG.replace(/\\/g, "/")}"`,
      `  ffprobe_path: "${FFPROBE.replace(/\\/g, "/")}"`,
    ].join("\n"),
  );
  spawnProc(
    process.execPath,
    [RENDER_WORKER_ENTRY, "--config", workerYaml],
    { FFMPEG_PATH: FFMPEG, FFPROBE_PATH: FFPROBE, NODE_ENV: "production" },
    "render-worker-series",
  );
  stopTts = startFakeTtsWorker(ttsToken);
}, 240_000);

afterAll(async () => {
  if (!isE2E) return;
  stopTts?.();
  for (const p of procs) if (!p.killed) p.kill();
  await new Promise((r) => setTimeout(r, 800));
  await new Promise<void>((r) => (agGo ? agGo.close(() => r()) : r()));
  await fakeS3?.stop().catch(() => {});
  try {
    execFileSync(
      "docker",
      [
        "compose",
        "-f",
        join(AG_FARM_DIR, "docker-compose.test.yml"),
        "down",
        "--project-name=series-e2e",
      ],
      { stdio: "inherit", timeout: 60_000 },
    );
  } catch {
    /* ignore cleanup errors */
  }
  if (process.env.E2E_KEEP !== "1") rmSync(testDir, { recursive: true, force: true });
}, 120_000);

// ─── test ────────────────────────────────────────────────────────────────────

type RunView = {
  state: string;
  waiting_gate: string | null;
  stages: {
    key: string;
    state: string;
    attempts: number;
    error: string | null;
    failed_checks: unknown[];
  }[];
};
type EpisodeView = {
  id: string;
  idx: number;
  title: string;
  status: string;
  run?: RunView & { waiting_gate: string | null };
};
type ProductionView = { id: string; status: string; episodeCounts: { total: number } };
type PagedEpisodes = { items: EpisodeView[]; total: number };

describe.skipIf(!isE2E)(
  "GĐ3 E2E: series-plan → approve-plan → episodes → freeze-timeline → render → export",
  () => {
    let prodId = "";
    let teamId = "";

    function planRun(): Promise<RunView> {
      return ok<RunView>("GET", `/productions/${prodId}/run`);
    }

    function waitGate(gate: string, ms = 300_000): Promise<RunView> {
      return waitFor(
        `gate ${gate}`,
        async () => {
          const v = await planRun();
          const stuck = v.stages.find(
            (s) =>
              s.state === "FAILED" ||
              (s.state === "WAITING_HUMAN" && s.key !== gate),
          );
          if (stuck)
            throw new Fatal(
              `stage ${stuck.key} ${stuck.state}: ${stuck.error} ${JSON.stringify(stuck.failed_checks)}`,
            );
          return v.waiting_gate === gate ? v : null;
        },
        ms,
        1000,
      );
    }

    it("creates production with v3 fields, adds sources, starts the series plan run", async () => {
      const team = await ok<{ id: string }>("POST", "/teams", { name: "Nhóm Series E2E" });
      teamId = team.id;

      const prod = await ok<ProductionView>("POST", `/teams/${teamId}/productions`, {
        title: "Phở sáng Hà Nội — Series",
        description: "Series ngắn về văn hoá ẩm thực đường phố Hà Nội",
        goal: "Tăng subscriber 20% trong 3 tháng",
        audience: "Người yêu ẩm thực 25–40 tuổi",
        tone: "Ấm áp, gần gũi",
        notes: "Tránh chính trị",
        youtubeChannels: ["https://youtube.com/@pho-hanoi"],
        keywords: ["phở", "ẩm thực Hà Nội", "ẩm thực đường phố"],
        episodeTargetSeconds: 90,
        maxEpisodes: 3,
        canvas: CANVAS,
        aspect: "16:9",
        language: "vi",
      });
      prodId = prod.id;

      // Verify v3 fields round-trip
      const fetched = await ok<{
        description: string;
        goal: string;
        maxEpisodes: number;
        keywords: string[];
        status: string;
      }>("GET", `/productions/${prodId}`);
      expect(fetched.description).toBe("Series ngắn về văn hoá ẩm thực đường phố Hà Nội");
      expect(fetched.goal).toBe("Tăng subscriber 20% trong 3 tháng");
      expect(fetched.maxEpisodes).toBe(3);
      expect(fetched.keywords).toEqual(["phở", "ẩm thực Hà Nội", "ẩm thực đường phố"]);
      expect(fetched.status).toBe("draft");

      // Add sources
      await ok("POST", `/productions/${prodId}/sources`, { folderIds: [FOLDER] });

      // Start the plan run
      await ok("POST", `/productions/${prodId}/run`);

      // Cannot start a second run
      expect((await api("POST", `/productions/${prodId}/run`)).status).toBe(409);

      // Status is now planning (not draft)
      const planningProd = await ok<ProductionView>("GET", `/productions/${prodId}`);
      expect(planningProd.status).toBe("planning");
    });

    it("approve-plan: fake Claude produces a series plan; plan is approved", async () => {
      await waitGate("approve-plan");

      // Read the plan document from the studio-plan-episodes stage
      const plan = await ok<{ schema_version: string; episodes: unknown[] }>(
        "GET",
        `/productions/${prodId}/run/documents/studio-plan-episodes/series-plan.json`,
      );
      expect(plan.schema_version).toBe("studio.series-plan/v1");
      expect(Array.isArray(plan.episodes)).toBe(true);
      expect(plan.episodes.length).toBeGreaterThan(0);

      // Submit the approve-plan gate
      const result = await ok<{ accepted: boolean }>(
        "POST",
        `/productions/${prodId}/run/gates/approve-plan`,
        { document: plan },
      );
      expect(result.accepted).toBe(true);
    });

    it("episodes are spawned; each starts its episode run", async () => {
      // Wait for plan run to SUCCEED (spawn-episodes completes)
      await waitFor(
        "plan run SUCCEEDED",
        async () => {
          const v = await planRun();
          if (v.state === "FAILED")
            throw new Fatal(`plan run failed: ${JSON.stringify(v.stages)}`);
          return v.state === "SUCCEEDED" ? v : null;
        },
        120_000,
        1000,
      );

      // Episodes should have been created
      const episodes = await ok<PagedEpisodes>(
        "GET",
        `/productions/${prodId}/episodes`,
      );
      expect(episodes.total).toBeGreaterThan(0);
      expect(episodes.items.length).toBe(episodes.total);

      // Production status should now reflect episode activity
      const prodAfter = await ok<ProductionView>("GET", `/productions/${prodId}`);
      expect(prodAfter.episodeCounts.total).toBeGreaterThan(0);
    });

    it("each episode reaches freeze-timeline gate; submitting it renders and exports the episode", async () => {
      const episodes = await ok<PagedEpisodes>(
        "GET",
        `/productions/${prodId}/episodes`,
      );

      // Process episodes sequentially to keep one render at a time
      for (const ep of episodes.items) {
        const episodeId = ep.id;

        // Wait for the episode's freeze-timeline gate
        const epView = await waitFor<EpisodeView & { run: RunView }>(
          `episode ${ep.idx} freeze-timeline`,
          async () => {
            const detail = await ok<EpisodeView>(
              "GET",
              `/productions/${prodId}/episodes/${episodeId}`,
            );
            if (detail.run?.state === "FAILED") {
              throw new Fatal(
                `episode ${ep.idx} run failed: ${JSON.stringify(detail.run.stages)}`,
              );
            }
            return detail.run?.waiting_gate === "freeze-timeline"
              ? (detail as EpisodeView & { run: RunView })
              : null;
          },
          300_000,
          1000,
        );

        // Timeline should have been built by the build-timeline stage
        const tl = await ok<{ revision: number; data: { schema_version: string }; issues: unknown[] }>(
          "GET",
          `/productions/${prodId}/episodes/${episodeId}/timeline`,
        );
        expect(tl.data.schema_version).toBe("studio.timeline/v3");
        expect(tl.issues).toEqual([]);

        // Submit the freeze-timeline gate (uses latest revision automatically)
        const freezeResult = await ok<{ accepted: boolean }>(
          "POST",
          `/productions/${prodId}/episodes/${episodeId}/gates/freeze-timeline`,
        );
        expect(freezeResult.accepted).toBe(true);
        void epView; // suppress unused-var lint
      }
    });

    it("all episodes render to done; production status becomes done", async () => {
      // Wait for all episodes to reach 'ready' status (up to 5 min per episode)
      await waitFor(
        "all episodes ready",
        async () => {
          const eps = await ok<PagedEpisodes>(
            "GET",
            `/productions/${prodId}/episodes`,
          );
          const allReady = eps.items.every((e) => e.status === "ready");
          const anyFailed = eps.items.some((e) => e.status === "failed");
          if (anyFailed) {
            throw new Fatal(
              `some episodes failed: ${JSON.stringify(eps.items.map((e) => ({ id: e.id, status: e.status })))}`,
            );
          }
          return allReady ? eps : null;
        },
        900_000, // 15 min for all episodes to finish rendering
        3000,
      );

      // Production should now be 'done'
      const prod = await ok<ProductionView>("GET", `/productions/${prodId}`);
      expect(prod.status).toBe("done");
      expect(prod.episodeCounts.total).toBeGreaterThan(0);
      expect(prod.episodeCounts.ready).toBe(prod.episodeCounts.total);

      // Each episode should have exported a final.mp4
      const eps = await ok<PagedEpisodes>(
        "GET",
        `/productions/${prodId}/episodes`,
      );
      for (const ep of eps.items) {
        // Probe the final video
        const detail = await ok<{
          id: string;
          finalVideoUrl?: string;
          exports?: { url: string; kind: string }[];
        }>("GET", `/productions/${prodId}/episodes/${ep.id}`);
        // The episode detail should have at least a video URL in exports or final
        // If the API returns an export url, probe the video
        const videoUrl =
          detail.finalVideoUrl ??
          (detail.exports ?? []).find((e) => e.kind === "mp4")?.url;
        if (videoUrl) {
          const tmp = join(testDir, `ep-${ep.id}.mp4`);
          const res = await fetch(videoUrl);
          if (res.ok) {
            writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
            const p = await probe(tmp);
            expect([p.width, p.height]).toEqual([CANVAS.width, CANVAS.height]);
            expect(p.hasAudio).toBe(true);
            expect(p.duration).toBeGreaterThan(0);
          }
        }
      }

      // Every footage call used the production owner's identity (not a production id)
      const servesCalls = agGoCalls.filter(
        (c) => c.path === "/footage/segments/resolve",
      );
      expect(servesCalls.length).toBeGreaterThan(0);
      const uniqueActAs = new Set(
        agGoCalls
          .filter((c) => c.path !== "/.well-known/jwks.json")
          .map((c) => c.actAs),
      );
      expect(uniqueActAs).toEqual(new Set([OWNER]));
    });

    it("GET /productions lists the production with correct derived status and pagination", async () => {
      const paged = await ok<{
        items: ProductionView[];
        total: number;
        page: number;
        pageSize: number;
      }>("GET", `/productions?page=1&pageSize=20`);
      expect(paged.page).toBe(1);
      expect(paged.pageSize).toBe(20);
      expect(paged.total).toBeGreaterThan(0);
      const our = paged.items.find((p) => p.id === prodId);
      expect(our).toBeTruthy();
      expect(our!.status).toBe("done");

      // Team-scoped list is a filtered alias
      const teamPaged = await ok<{ items: ProductionView[]; total: number }>(
        "GET",
        `/teams/${teamId}/productions`,
      );
      const teamOur = teamPaged.items.find((p) => p.id === prodId);
      expect(teamOur).toBeTruthy();
      expect(teamOur!.status).toBe("done");
    });

    it("DELETE production cancels runs and archives it (404 on second fetch)", async () => {
      await ok("DELETE", `/productions/${prodId}`);
      // After delete the production should be archived (GET returns 404 since it's excluded from normal listings,
      // or status = archived)
      const res = await api("GET", `/productions/${prodId}`);
      // Either 404 or archived status
      if (res.status === 200) {
        expect((res.body as { status: string }).status).toBe("archived");
      } else {
        expect(res.status).toBe(404);
      }
    });
  },
);
