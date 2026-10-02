/**
 * GĐ4 acceptance E2E, research first: `ag-studio-series-plan@2.0.0` (R&D and branding approved before the plan) +
 * `ag-studio-episode@1.2.0` series flow.
 *
 * Series plan API → approve-plan gate → episode spawning →
 * per-episode build-timeline → render (real farm + render worker) → thumbnails (Studio ffmpeg) → export.
 * Episodes have NO human-approval gate; every episode renders automatically after spawning.
 *
 * Real:  ag-farm hub (+ Postgres in Docker), Studio API (dist), Studio worker (dist),
 *        ag-render-worker (dist), ffmpeg (ffmpeg-static).
 * Fake:  Claude (fixtures/fake-studio-claude.mjs via CliAgentRuntime), ag-go (catalog/assets/resolve),
 *        S3 (in-process FakeS3Server).
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
import { StudioYoutubeSchema, type TimelineV3 } from "@harness/contracts";

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

// Ports distinct from farm-render.e2e.test.ts and production.e2e.test.ts to allow running both without conflict
const PORTS = { db: 55433, s3: 9121, hub: 3395, api: 3394, agGo: 4395 };
const S3 = { bucket: "studio-series-e2e", key: "devkey", secret: "devsecret" };
const AUTH = {
  issuer: "https://e2e.auth.test/",
  audience: "studio-series-e2e",
  azp: "e2e-series-web",
  kid: "e2e-series-key",
};
const OWNER = "auth0|series-owner-e2e";
// Two source folders so the test exercises multi-folder catalog
const FOLDER_A = "0c0f0000-0000-4000-8000-00000000f01d";
const FOLDER_B = "0c0f0000-0000-4000-8000-00000000f02d";
const CANVAS = { width: 320, height: 180 };

const procs: ChildProcess[] = [];
let testDir = "";
let fakeS3: FakeS3Server | null = null;
let agGo: http.Server | null = null;
let jwtKey: KeyObject;
let jwk: Record<string, unknown>;
const agGoCalls: { path: string; actAs: string | undefined }[] = [];

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

// ─── fake ag-go footage data ─────────────────────────────────────────────────
// 4 whole-video assets (AgGoFootageVideo format), 2 per folder.
// Backed by 2 real video files uploaded to FakeS3 (asset-a.mp4 and asset-b.mp4).

const VIDEO_DURATION_MS = 8000; // 8 s per asset

// Asset IDs → S3 key mapping (asset-a and asset-c share file-a.mp4, etc.)
const ASSET_FILE_MAP: Record<string, string> = {
  "asset-a": "assets/file-a.mp4",
  "asset-b": "assets/file-b.mp4",
  "asset-c": "assets/file-a.mp4",
  "asset-d": "assets/file-b.mp4",
};

// AgGoFootageVideo items (whole-video catalog)
const ASSETS_FOLDER_A = [
  {
    assetId: "asset-a",
    name: "pho-hanoi-1.mp4",
    durationMs: VIDEO_DURATION_MS,
    orientation: "landscape",
    hasSpeech: false,
    titleVi: "Phở bò Hà Nội buổi sáng",
    summaryVi: "Cảnh quay bát phở bò nóng hổi trên phố Hà Nội",
    topics: ["phở", "ẩm thực"],
    tags: ["pho", "hanoi"],
    quality: 4,
    usable: true,
    approved: true,
  },
  {
    assetId: "asset-b",
    name: "pho-hanoi-2.mp4",
    durationMs: VIDEO_DURATION_MS,
    orientation: "landscape",
    hasSpeech: false,
    titleVi: "Phố Hà Nội lúc 6 giờ sáng",
    summaryVi: "Cảnh quay phố phường Hà Nội buổi sáng sớm",
    topics: ["hanoi", "đường phố"],
    tags: ["hanoi", "street", "morning"],
    quality: 4,
    usable: true,
    approved: true,
  },
];

const ASSETS_FOLDER_B = [
  {
    assetId: "asset-c",
    name: "pho-hanoi-3.mp4",
    durationMs: VIDEO_DURATION_MS,
    orientation: "landscape",
    hasSpeech: false,
    titleVi: "Người bán hàng pha phở",
    summaryVi: "Cảnh quay người bán hàng đang pha phở tại quán",
    topics: ["phở", "con người"],
    tags: ["pho", "vendor"],
    quality: 4,
    usable: true,
    approved: true,
  },
  {
    assetId: "asset-d",
    name: "pho-hanoi-4.mp4",
    durationMs: VIDEO_DURATION_MS,
    orientation: "landscape",
    hasSpeech: false,
    titleVi: "Khách ăn phở buổi sáng",
    summaryVi: "Cảnh quay thực khách đang thưởng thức phở",
    topics: ["phở", "ẩm thực"],
    tags: ["pho", "customer"],
    quality: 4,
    usable: true,
    approved: true,
  },
];

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

    // GET /v2/users/me — called by the Studio API auth middleware with a user's Bearer token
    // (no service key; returns ADMIN so the user can access global /productions endpoint)
    if (req.method === "GET" && url.startsWith("/v2/users/me")) {
      return wrap({ userId: OWNER, userType: "ADMIN", user_type: "ADMIN", permissions: [] });
    }

    if (req.headers["x-service-key"] !== "e2e-service-key")
      return json(401, { message: "no service key" });
    if (actAs !== OWNER)
      return json(403, { message: `act-as ${String(actAs)} rejected` });

    // Folders
    if (req.method === "GET" && url.startsWith("/footage/folders")) {
      return wrap({
        folders: [
          { id: FOLDER_A, parentId: null, name: "Ẩm thực 1", path: "/Ẩm thực 1", analyzedVideos: 2, usableVideos: 2 },
          { id: FOLDER_B, parentId: null, name: "Ẩm thực 2", path: "/Ẩm thực 2", analyzedVideos: 2, usableVideos: 2 },
        ],
      });
    }

    // Whole-asset catalog (GĐ4/v3) — returns AgGoFootageVideo items
    if (req.method === "POST" && url === "/footage/catalog") {
      const b = JSON.parse(body) as { folderIds: string[]; limit?: number };
      // like ag-go's DTO: 1..500 per page
      if (b.limit !== undefined && (b.limit < 1 || b.limit > 500)) return json(400, { message: "limit must not be greater than 500" });
      const items = [
        ...(b.folderIds.includes(FOLDER_A) ? ASSETS_FOLDER_A : []),
        ...(b.folderIds.includes(FOLDER_B) ? ASSETS_FOLDER_B : []),
      ];
      return wrap({ items, nextCursor: null });
    }

    // Whole-asset resolve (GĐ4/v3) — replaces segments/resolve
    if (req.method === "POST" && url === "/footage/assets/resolve") {
      const b = JSON.parse(body) as { assetIds: string[]; purpose: "preview" | "final" };
      const allAssetIds = new Set(Object.keys(ASSET_FILE_MAP));
      const items = b.assetIds
        .filter((id) => allAssetIds.has(id))
        .map((assetId) => ({
          assetId,
          url: `http://127.0.0.1:${PORTS.s3}/${S3.bucket}/${ASSET_FILE_MAP[assetId]}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600`,
          sourceKind: b.purpose === "final" ? "original" : "proxy",
          watermarked: false,
          contentType: "video/mp4",
          sizeBytes: null,
          durationMs: VIDEO_DURATION_MS,
          cacheKey: null,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }));
      const missing = b.assetIds.filter((id) => !allAssetIds.has(id));
      return wrap({ items, missing });
    }

    // Account/user API (for isAdmin checks and act-as resolution)
    if (req.method === "GET" && url.includes("/users/")) {
      return wrap({ userId: actAs ?? "unknown", userType: "USER", name: "Test User", email: "test@example.com", permissions: [] });
    }

    json(404, { message: `fake ag-go: no ${req.method} ${url}` });
  });
  return new Promise((r) => agGo!.listen(PORTS.agGo, "127.0.0.1", () => r()));
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

  // Create 2 real video files (8 s each) and upload to fake S3 under 2 asset IDs
  // asset-a and asset-c share file-a.mp4; asset-b and asset-d share file-b.mp4
  for (const [file, video, freq] of [
    ["file-a.mp4", "testsrc2", 440],
    ["file-b.mp4", "smptebars", 660],
  ] as const) {
    const p = join(testDir, file);
    await lavfiAsset(p, video, freq, VIDEO_DURATION_MS / 1000);
    await s3.send(
      new PutObjectCommand({
        Bucket: S3.bucket,
        Key: `assets/${file}`,
        Body: readFileSync(p),
        ContentType: "video/mp4",
      }),
    );
  }
  process.stderr.write("[e2e] fake S3 ready, 2 video files uploaded\n");

  await startFakeAgGo();
  process.stderr.write("[e2e] fake ag-go ready\n");

  // ag-farm DB migrations first, then start hub
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
  process.stderr.write("[e2e] ag-farm migrations applied\n");

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
    60_000,
  );
  process.stderr.write("[e2e] ag-farm hub ready\n");

  // Register studio farm owner + render node in the DB
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require("pg") as typeof import("pg");
  const pg = new Client({ connectionString: farmDb });
  await pg.connect();
  await pg.query("DELETE FROM farm_jobs WHERE owner = 'studio'");
  await pg.query(
    `INSERT INTO farm_owners (id, key_hash, sign_url, allowed_types, created_at, updated_at)
     VALUES ('studio', $1, $2, $3, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET key_hash = $1, sign_url = $2, allowed_types = $3`,
    [
      createHash("sha256").update(ownerKey).digest("hex"),
      `http://127.0.0.1:${PORTS.api}/api/farm/sign`,
      ["studio.render_preview", "studio.render_final"],
    ],
  );
  const renderToken = randomBytes(24).toString("base64url");
  await pg.query(
    `INSERT INTO farm_nodes
       (id, name, machine, token_hash, kinds, capabilities, status, last_seen_at, created_at, updated_at)
     VALUES ($1, $2, 'e2e', $3, $4, '{}'::jsonb, 'active', NOW(), NOW(), NOW())`,
    [
      randomUUID(),
      `e2e-render-${randomUUID().slice(0, 8)}`,
      createHash("sha256").update(renderToken).digest("hex"),
      ["studio.render_preview", "studio.render_final"],
    ],
  );
  await pg.end();
  process.stderr.write("[e2e] farm owner + render node registered\n");

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
    60_000,
  );
  process.stderr.write("[e2e] Studio API ready\n");

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
  process.stderr.write("[e2e] Studio worker spawned\n");

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
  process.stderr.write("[e2e] render worker spawned\n");
}, 240_000);

afterAll(async () => {
  if (!isE2E) return;
  for (const p of procs) if (!p.killed) p.kill();
  await new Promise((r) => setTimeout(r, 800));
  await new Promise<void>((r) => (agGo ? agGo.close(() => r()) : r()));
  await fakeS3?.stop().catch(() => {});
  // Note: we do not tear down the Postgres container — it was pre-started externally
  // and may be shared with other test runs. Stopping it here would break them.
  if (process.env.E2E_KEEP !== "1") rmSync(testDir, { recursive: true, force: true });
}, 120_000);

// ─── types ───────────────────────────────────────────────────────────────────

type StageView = {
  key: string;
  state: string;
  attempts: number;
  error: string | null;
  failed_checks: unknown[];
};
type RunView = {
  run_id: string;
  state: string;
  waiting_gate: string | null;
  stages: StageView[];
};
type EpisodeSummary = {
  id: string;
  idx: number;
  title: string;
  status: string;
};
type ExportFile = {
  kind: "mp4" | "thumbnail" | "youtube" | "timeline" | "pack";
  url: string;
  sizeBytes: number;
  name: string;
};
type EpisodeDetail = EpisodeSummary & {
  run: RunView | null;
  exportFiles: ExportFile[];
  finalVideoUrl: string | null;
  latestRevision: number | null;
  thumbnails: { url: string; index: number }[];
};
type ProductionView = {
  id: string;
  status: string;
  episodeCounts: { total: number; ready: number; producing: number; failed: number };
};
type PagedEpisodes = { items: EpisodeSummary[]; total: number };

// ─── test ────────────────────────────────────────────────────────────────────

describe.skipIf(!isE2E)(
  "GĐ4 E2E: series-plan → approve-plan → episodes render/export automatically",
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

    it("creates production with v3 fields, 2 source folders, and starts the series plan run", async () => {
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
        maxEpisodes: 2,
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
      expect(fetched.maxEpisodes).toBe(2);
      expect(fetched.keywords).toEqual(["phở", "ẩm thực Hà Nội", "ẩm thực đường phố"]);
      expect(fetched.status).toBe("draft");

      // Add 2 source folders
      await ok("POST", `/productions/${prodId}/sources`, { folderIds: [FOLDER_A, FOLDER_B] });

      // Start the plan run
      await ok("POST", `/productions/${prodId}/run`);

      // Cannot start a second run while one is active
      expect((await api("POST", `/productions/${prodId}/run`)).status).toBe(409);

      // Status is now planning
      const planningProd = await ok<ProductionView>("GET", `/productions/${prodId}`);
      expect(["planning", "waiting_approval"]).toContain(planningProd.status);
    });

    it("approve-rnd and approve-branding: the R&D and branding fake Claude proposes are approved and become the production's", async () => {
      await waitGate("approve-rnd");
      const rnd = await ok<{ schema_version: string; direction: { episode_target_seconds: number } }>(
        "GET",
        `/productions/${prodId}/run/documents/rnd/rnd.json`,
      );
      expect(rnd.schema_version).toBe("studio.rnd/v1");
      expect(rnd.direction.episode_target_seconds).toBe(90); // the hint typed at creation
      expect((await ok<{ accepted: boolean }>("POST", `/productions/${prodId}/run/gates/approve-rnd`, { document: rnd })).accepted).toBe(true);

      await waitGate("approve-branding");
      const branding = await ok<{ schema_version: string }>(
        "GET",
        `/productions/${prodId}/run/documents/branding/branding.json`,
      );
      expect(branding.schema_version).toBe("studio.branding/v1");
      expect((await ok<{ accepted: boolean }>("POST", `/productions/${prodId}/run/gates/approve-branding`, { document: branding })).accepted).toBe(true);
      const saved = await waitFor(
        "branding applied",
        async () => {
          const doc = await ok<{ document: unknown }>("GET", `/productions/${prodId}/branding`);
          return doc.document ? doc : null;
        },
        60_000,
        1000,
      );
      expect(saved.document).toEqual(branding);
    });

    it("approve-plan: fake Claude produces a series plan; plan is approved and episodes spawn", async () => {
      // Wait for plan run to reach the approve-plan gate
      await waitGate("approve-plan");

      // Read the series-plan document from the plan-episodes stage
      const plan = await ok<{ schema_version: string; episodes: unknown[] }>(
        "GET",
        `/productions/${prodId}/run/documents/plan-episodes/series-plan.json`,
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
      const episodes = await ok<PagedEpisodes>("GET", `/productions/${prodId}/episodes`);
      expect(episodes.total).toBeGreaterThanOrEqual(1);
      expect(episodes.items.length).toBe(episodes.total);

      const prodAfter = await ok<ProductionView>("GET", `/productions/${prodId}`);
      expect(prodAfter.episodeCounts.total).toBeGreaterThanOrEqual(1);
    });

    it("all episodes render and export automatically (no gate); assert export files", async () => {
      // Wait for all episodes to reach 'ready' status
      const readyEps = await waitFor(
        "all episodes ready",
        async () => {
          const eps = await ok<PagedEpisodes>("GET", `/productions/${prodId}/episodes`);
          if (eps.total === 0) return null;
          const anyFailed = eps.items.some((e) => e.status === "failed");
          if (anyFailed) {
            // Collect error details
            const details = await Promise.all(
              eps.items
                .filter((e) => e.status === "failed")
                .map((e) =>
                  ok<EpisodeDetail>("GET", `/productions/${prodId}/episodes/${e.id}`).then(
                    (d) => JSON.stringify({ id: e.id, run: d.run?.stages }),
                  ),
                ),
            );
            throw new Fatal(`episodes failed: ${details.join("; ")}`);
          }
          const allReady = eps.items.every((e) => e.status === "ready");
          return allReady ? eps : null;
        },
        900_000,
        3000,
      );
      expect(readyEps.total).toBeGreaterThanOrEqual(1);

      // Assert production status
      const prod = await ok<ProductionView>("GET", `/productions/${prodId}`);
      expect(prod.status).toBe("done");
      expect(prod.episodeCounts.ready).toBe(prod.episodeCounts.total);

      // Assert export files for each episode
      for (const ep of readyEps.items) {
        const detail = await ok<EpisodeDetail>(
          "GET",
          `/productions/${prodId}/episodes/${ep.id}`,
        );

        // exportFiles: mp4, the 3 suggested thumbnails, youtube.json, timeline (no zip: the pack is built on download)
        const kinds = detail.exportFiles.map((f) => f.kind).sort();
        expect(kinds).toEqual(["mp4", "thumbnail", "thumbnail", "thumbnail", "timeline", "youtube"]);

        // MP4: real playable video
        expect(detail.finalVideoUrl).toBeTruthy();
        const mp4Res = await fetch(detail.finalVideoUrl!);
        expect(mp4Res.ok).toBe(true);
        const mp4Path = join(testDir, `ep-${ep.id}.mp4`);
        writeFileSync(mp4Path, Buffer.from(await mp4Res.arrayBuffer()));
        const mp4Info = await probe(mp4Path);
        // as long as the timeline it was rendered from (whole videos back to back)
        const tl = await ok<{ data: TimelineV3 }>("GET", `/productions/${prodId}/episodes/${ep.id}/timeline`);
        const expected = tl.data.clips.reduce((sum, c) => sum + tl.data.assets[c.asset_id]!.duration_s, 0);
        expect(Math.abs(mp4Info.duration - expected)).toBeLessThan(0.5);
        expect(mp4Info.width).toBe(CANVAS.width);
        expect(mp4Info.height).toBe(CANVAS.height);

        // Thumbnails: clean frames cut on the Studio node + 3 suggestions with words, all real 1280×720 JPEGs
        const list = await ok<{ items: { id: string; kind: string; url: string; createdBy: string }[]; selectedId: string | null }>(
          "GET", `/productions/${prodId}/episodes/${ep.id}/thumbnails`,
        );
        const frames = list.items.filter((t) => t.kind === "frame");
        const suggestions = list.items.filter((t) => t.kind === "suggestion");
        expect(frames.length).toBeGreaterThan(0);
        expect(suggestions).toHaveLength(3);
        expect(list.selectedId).toBe(suggestions[0]!.id);
        const thumbFiles = [...suggestions, frames[0]!];
        for (const [i, thumb] of thumbFiles.entries()) {
          const thumbRes = await fetch(thumb.url);
          expect(thumbRes.ok).toBe(true);
          const thumbBuf = Buffer.from(await thumbRes.arrayBuffer());
          // Verify JPEG magic bytes (FFD8FF)
          expect(thumbBuf[0]).toBe(0xff);
          expect(thumbBuf[1]).toBe(0xd8);
          const thumbPath = join(testDir, `thumb-${ep.id}-${i}.jpg`);
          writeFileSync(thumbPath, thumbBuf);
          const thumbInfo = await probe(thumbPath);
          expect(thumbInfo.width).toBe(1280);
          expect(thumbInfo.height).toBe(720);
        }

        // youtube.json: parses with StudioYoutubeSchema
        const ytFile = detail.exportFiles.find((f) => f.kind === "youtube");
        expect(ytFile).toBeTruthy();
        const ytRes = await fetch(ytFile!.url);
        expect(ytRes.ok).toBe(true);
        const ytData = await ytRes.json();
        expect(() => StudioYoutubeSchema.parse(ytData)).not.toThrow();

        // YouTube pack: a zip built on download (picked thumbnail + texts, no video)
        const pack = await ok<{ url: string; name: string; sizeBytes: number }>("POST", `/productions/${prodId}/episodes/${ep.id}/youtube-pack`);
        expect(pack.name).toMatch(/-youtube\.zip$/);
        const packRes = await fetch(pack.url);
        expect(packRes.ok).toBe(true);
        const packBuf = Buffer.from(await packRes.arrayBuffer());
        expect(packBuf.subarray(0, 2).toString("latin1")).toBe("PK");
        expect(packBuf.length).toBe(pack.sizeBytes);

        // Render stage was successful
        const renderStage = detail.run?.stages.find((s) => s.key === "render-final");
        expect(renderStage?.state).toBe("SUCCEEDED");

        // All footage was resolved using the production owner's identity
        const resolvesCalls = agGoCalls.filter(
          (c) => c.path === "/footage/assets/resolve",
        );
        expect(resolvesCalls.length).toBeGreaterThan(0);
      }

      // Every footage API call used the production owner's identity
      // (non-footage calls like /v2/users/me may use a different auth pattern)
      const footageCalls = agGoCalls.filter(
        (c) =>
          c.path.startsWith("/footage/") &&
          c.path !== "/.well-known/jwks.json",
      );
      expect(footageCalls.length).toBeGreaterThan(0);
      const footageActAs = new Set(footageCalls.map((c) => c.actAs));
      expect(footageActAs).toEqual(new Set([OWNER]));
    });

    it("episode 1: save edited timeline (drop one clip), rerender, new video is shorter", async () => {
      const eps = await ok<PagedEpisodes>("GET", `/productions/${prodId}/episodes`);
      const ep1 = eps.items.find((e) => e.idx === 1)!;
      expect(ep1).toBeTruthy();

      // Get current timeline
      const tl = await ok<{ revision: number; data: TimelineV3; issues: unknown[] }>(
        "GET",
        `/productions/${prodId}/episodes/${ep1.id}/timeline`,
      );
      expect(tl.data.schema_version).toBe("studio.timeline/v3");
      expect(tl.issues).toEqual([]);

      // Original video duration
      const ep1Detail = await ok<EpisodeDetail>(
        "GET",
        `/productions/${prodId}/episodes/${ep1.id}`,
      );
      const origMp4Res = await fetch(ep1Detail.finalVideoUrl!);
      const origMp4Path = join(testDir, `ep-${ep1.id}-orig.mp4`);
      writeFileSync(origMp4Path, Buffer.from(await origMp4Res.arrayBuffer()));
      const origDuration = (await probe(origMp4Path)).duration;
      expect(origDuration).toBeGreaterThan(1);

      // Only attempt rerender if the timeline has more than 1 clip to drop
      if (tl.data.clips.length < 2) {
        process.stderr.write(
          `[e2e] episode 1 has only ${tl.data.clips.length} clip(s), skipping rerender edit\n`,
        );
        return;
      }

      // Drop the last clip
      const edited: TimelineV3 = {
        ...tl.data,
        clips: tl.data.clips.slice(0, -1),
      };

      // Save new revision
      const revResult = await ok<{ revision: number; issues: unknown[] }>(
        "POST",
        `/productions/${prodId}/episodes/${ep1.id}/timeline/revisions`,
        { baseRevision: tl.revision, data: edited },
      );
      expect(revResult.revision).toBeGreaterThan(tl.revision);
      expect(revResult.issues).toEqual([]);

      // Trigger rerender
      await ok("POST", `/productions/${prodId}/episodes/${ep1.id}/rerender`);

      // Wait for episode 1 to become ready again
      await waitFor(
        "episode 1 ready after rerender",
        async () => {
          const d = await ok<EpisodeDetail>(
            "GET",
            `/productions/${prodId}/episodes/${ep1.id}`,
          );
          if (d.status === "failed") {
            throw new Fatal(
              `episode 1 failed after rerender: ${JSON.stringify(d.run?.stages)}`,
            );
          }
          return d.status === "ready" ? d : null;
        },
        600_000,
        3000,
      );

      // Verify the new MP4 is shorter
      const newDetail = await ok<EpisodeDetail>(
        "GET",
        `/productions/${prodId}/episodes/${ep1.id}`,
      );
      expect(newDetail.finalVideoUrl).toBeTruthy();
      const newMp4Res = await fetch(newDetail.finalVideoUrl!);
      const newMp4Path = join(testDir, `ep-${ep1.id}-rerendered.mp4`);
      writeFileSync(newMp4Path, Buffer.from(await newMp4Res.arrayBuffer()));
      const newDuration = (await probe(newMp4Path)).duration;

      // New video should be shorter (dropped one clip of VIDEO_DURATION_MS/1000 s)
      expect(newDuration).toBeGreaterThan(0.5);
      expect(newDuration).toBeLessThan(origDuration - 0.5);
    }, 700_000);

    it("GET /productions lists production with correct status and pagination", async () => {
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

      // Team-scoped list
      const teamPaged = await ok<{ items: ProductionView[]; total: number }>(
        "GET",
        `/teams/${teamId}/productions`,
      );
      const teamOur = teamPaged.items.find((p) => p.id === prodId);
      expect(teamOur).toBeTruthy();
      expect(teamOur!.status).toBe("done");
    });

    it("DELETE production archives it", async () => {
      await ok("DELETE", `/productions/${prodId}`);
      const res = await api("GET", `/productions/${prodId}`);
      if (res.status === 200) {
        expect((res.body as { status: string }).status).toBe("archived");
      } else {
        expect(res.status).toBe(404);
      }
    });
  },
);
