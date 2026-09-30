/**
 * GĐ4 acceptance E2E: `ag-studio-production@1.0.0` from brief to MP4 + SRT, driven only through the Studio
 * API the web uses.
 *
 * Real:  ag-farm hub (+ Postgres in Docker), Studio API (dist), Studio worker (dist), ag-render-worker (dist),
 *        ffmpeg (ffmpeg-static) for renders and the loudness check.
 * Fake:  Claude (fixtures/fake-studio-claude.mjs through the real CliAgentRuntime), ag-go (catalog, folders,
 *        resolve -- same shapes as GĐ2, segments that start mid-file like the real resolve), S3 (in-process),
 *        the TTS engine (an in-test farm worker: real hub claim, real Studio /farm/sign, sine-tone WAVs).
 *
 * Requires E2E=1, Docker, built dists: ag-farm apps/api, ag-render-worker, ag-studio apps/api + apps/worker.
 * Run: E2E=1 corepack pnpm exec vitest run --config tests/e2e/vitest.config.ts tests/e2e/production.e2e.test.ts
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from "node:crypto";
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
/** E2E_RENDER_WORKER_ENTRY: run a release bundle (ag-render-worker scripts/release.mjs) instead of its dist/. */
const RENDER_WORKER_ENTRY = process.env.E2E_RENDER_WORKER_ENTRY ?? join(AG_RENDER_DIR, "dist/main.js");
const EXE = process.platform === "win32" ? ".exe" : "";
const FFMPEG = process.env.FFMPEG_PATH ?? resolve(AG_RENDER_DIR, "node_modules", "ffmpeg-static", "ffmpeg") + EXE;
const FFPROBE = process.env.FFPROBE_PATH ?? resolve(AG_RENDER_DIR, "node_modules", "ffprobe-static", "bin", process.platform, process.arch, "ffprobe") + EXE;
const isE2E = process.env.E2E === "1";
const execFileAsync = promisify(execFile);

const PORTS = { db: 55433, s3: 9120, hub: 3299, api: 3298, agGo: 4299 };
const S3 = { bucket: "studio-e2e", key: "devkey", secret: "devsecret" };
const AUTH = { issuer: "https://e2e.auth.test/", audience: "studio-e2e", azp: "e2e-web", kid: "e2e-key" };
const OWNER = "auth0|owner-e2e";
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

// ---------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------

function spawnProc(cmd: string, args: string[], env: NodeJS.ProcessEnv, label: string): ChildProcess {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const log = join(testDir, `${label}.log`);
  p.stdout?.on("data", (d: Buffer) => writeFileSync(log, d, { flag: "a" }));
  p.stderr?.on("data", (d: Buffer) => writeFileSync(log, d, { flag: "a" }));
  procs.push(p);
  return p;
}

/** Thrown from a `waitFor` probe to stop waiting at once (a stage failed; waiting longer cannot help). */
class Fatal extends Error {}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 120_000, everyMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch (e) { if (e instanceof Fatal) throw e; last = e; }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

function b64url(b: Buffer | string): string { return Buffer.from(b).toString("base64url"); }
function jwt(sub: string): string {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: AUTH.kid, typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ sub, iss: AUTH.issuer, aud: AUTH.audience, azp: AUTH.azp, iat: now, exp: now + 3600 }));
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(jwtKey);
  return `${header}.${payload}.${b64url(sig)}`;
}

/** Unwrap `{ data, success, error, requestId, timestamp }` envelope if present; return data/error as flat body. */
function unwrapEnvelope<T>(raw: unknown): T {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (typeof r.success === "boolean" && "data" in r && typeof r.requestId === "string") {
      if (r.success) return r.data as T;
      // For error envelopes, flatten error fields so toMatchObject({ code, currentRevision }) still works
      if (r.error && typeof r.error === "object" && !Array.isArray(r.error)) {
        const e = r.error as Record<string, unknown>;
        const details = e.details && typeof e.details === "object" && !Array.isArray(e.details)
          ? e.details as Record<string, unknown>
          : {};
        return { ...e, ...details } as T;
      }
    }
  }
  return raw as T;
}

async function api<T = unknown>(method: string, path: string, body?: unknown, user = OWNER): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${PORTS.api}/api${path}`, {
    method, headers: { Authorization: `Bearer ${jwt(user)}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const raw = text ? JSON.parse(text) : null;
  return { status: res.status, body: unwrapEnvelope<T>(raw) };
}
async function ok<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await api<T>(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function lavfiAsset(path: string, video: string, freq: number, seconds: number): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-f", "lavfi", "-i", `${video}=size=${CANVAS.width}x${CANVAS.height}:rate=25:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=${freq}:sample_rate=48000:duration=${seconds}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", path,
  ], { timeout: 60_000 });
}

/** 16-bit mono PCM sine tone: a TTS stand-in with real loudness (silence could never meet the band). */
function toneWav(seconds: number, rate = 24000): Buffer {
  const n = Math.floor(rate * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 0.3 * 32767), 44 + i * 2);
  return b;
}

async function probe(file: string): Promise<{ width: number; height: number; duration: number; hasAudio: boolean }> {
  const { stdout } = await execFileAsync(FFPROBE, ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", file], { timeout: 20_000 });
  const j = JSON.parse(stdout) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };
  const v = j.streams.find((s) => s.codec_type === "video");
  return { width: v?.width ?? 0, height: v?.height ?? 0, duration: Number(j.format.duration), hasAudio: j.streams.some((s) => s.codec_type === "audio") };
}

// ---------------------------------------------------------------------------------------------------------
// fake ag-go: JWKS for the Studio API, footage folders/catalog/resolve like GĐ2 (whole-asset URLs)
// ---------------------------------------------------------------------------------------------------------

/** Two 24 s assets, three 8 s segments each: segments 2/3/5/6 start mid-file, exactly like real footage. */
const SEGMENTS = [0, 1, 2, 3, 4, 5].map((i) => ({
  segmentId: `5e600000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  assetId: i < 3 ? "asset-a" : "asset-b",
  startMs: (i % 3) * 8000, endMs: (i % 3 + 1) * 8000, durationMs: 8000,
  captionVi: `cảnh ${i + 1}: ${i < 3 ? "phố Hà Nội buổi sáng" : "bát phở bò nóng"}`, captionEn: `shot ${i + 1}`,
  tags: ["pho", "hanoi"], keywordsVi: ["phở"], subjects: [], actions: [], shotSize: "medium", cameraMotion: null,
  timeOfDay: "morning", setting: null, peopleCount: null, orientation: "landscape", quality: 4, usable: true, approved: i % 2 === 0,
}));

function startFakeAgGo(): Promise<void> {
  agGo = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const actAs = req.headers["x-act-as-user"] as string | undefined;
    const url = req.url ?? "";
    agGoCalls.push({ path: url, actAs });
    const json = (status: number, v: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); };
    // ag-go-api wraps every answer in its ApiResponseInterceptor envelope; the fake does the same
    const ok = (v: unknown) => json(200, { data: v, requestId: `req-${Date.now()}`, success: true, error: null, timestamp: new Date().toISOString() });
    if (url === "/.well-known/jwks.json") return json(200, { keys: [jwk] });
    // everything else is a Studio service call: service key + act-as a USER (never a production id)
    if (req.headers["x-service-key"] !== "e2e-service-key") return json(401, { message: "no service key" });
    if (actAs !== OWNER) return json(403, { message: `act-as ${String(actAs)} is not a user with scope` });
    if (req.method === "GET" && url.startsWith("/footage/folders")) {
      return ok({ folders: [{ id: FOLDER, parentId: null, name: "Ẩm thực", path: "/Ẩm thực", analyzedSegments: 6, usableSegments: 6 }] });
    }
    if (req.method === "POST" && url === "/footage/catalog") {
      const b = JSON.parse(body) as { folderIds: string[] };
      return ok({ items: b.folderIds.includes(FOLDER) ? SEGMENTS : [], nextCursor: null });
    }
    if (req.method === "POST" && url === "/footage/segments/resolve") {
      const b = JSON.parse(body) as { segmentIds: string[]; purpose: "preview" | "final" };
      const items = b.segmentIds.map((id) => SEGMENTS.find((s) => s.segmentId === id)).filter(Boolean).map((s) => ({
        segmentId: s!.segmentId, assetId: s!.assetId, startMs: s!.startMs, endMs: s!.endMs,
        url: `http://127.0.0.1:${PORTS.s3}/${S3.bucket}/assets/${s!.assetId}.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600`,
        sourceKind: b.purpose === "final" ? "original" : "proxy", watermarked: false, contentType: "video/mp4",
        sizeBytes: null, cacheKey: null, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }));
      return ok({ items });
    }
    json(404, { message: `fake ag-go has no ${req.method} ${url}` });
  });
  return new Promise((r) => agGo!.listen(PORTS.agGo, "127.0.0.1", () => r()));
}

// ---------------------------------------------------------------------------------------------------------
// fake TTS engine: a farm worker that claims studio.tts from the REAL hub and signs through the REAL Studio API
// ---------------------------------------------------------------------------------------------------------

function startFakeTtsWorker(token: string): () => void {
  let running = true;
  const hub = `http://127.0.0.1:${PORTS.hub}`;
  const caps = { os: "linux", cpu_cores: 4, ram_mb: 8192, gpus: [{ name: "fake-gpu", vram_mb: 8192, nvenc: false, nvdec: false }], engines: { ffmpeg: null, ollama_models: [], python: "3.10.0" } };
  const post = (path: string, body: unknown, auth = `Node ${token}`) => fetch(path.startsWith("http") ? path : `${hub}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: auth }, body: JSON.stringify(body),
  });
  void (async () => {
    while (running) {
      try {
        await post("/v1/worker/heartbeat", { agent_version: "0.1.0-e2e-tts", kinds: ["studio.tts"], capabilities: caps, free_slots: { cpu: 0, gpu: 1 }, running_job_ids: [] });
        const claim = await post("/v1/worker/claim", { kinds: ["studio.tts"], free_slots: { cpu: 0, gpu: 1 }, cached_affinity: [] });
        // Accept both enveloped { data: { job } } and raw { job } bodies (ag-farm hub may be updated by another agent)
        const claimRaw = (await claim.json()) as unknown;
        const { job } = unwrapEnvelope<{ job: null | { id: string; lease_token: string; ticket: string; sign_url: string; payload: { production_id: string; language: string; lines: { line_id: string; text: string }[] } } }>(claimRaw);
        if (job) {
          ttsJobs.push(job.id);
          const lines = job.payload.lines.map((l) => ({ line_id: l.line_id, output: `tts/${l.line_id}.wav`, duration_s: Math.round(l.text.split(/\s+/).length * 0.35 * 1000) / 1000, words: [] }));
          const files = [...lines.map((l) => ({ output: l.output, type: "audio/wav", body: toneWav(l.duration_s) })),
            { output: "tts.json", type: "application/json", body: Buffer.from(JSON.stringify({ schema: "ag.studio.tts/v1", production_id: job.payload.production_id, language: job.payload.language, lines, engine: { name: "e2e-tone", version: "1" } })) }];
          const signed = await post(job.sign_url, { ops: files.map((f) => ({ op: "put", output: f.output, content_type: f.type })) }, `Ticket ${job.ticket}`);
          if (!signed.ok) throw new Error(`sign ${signed.status} ${await signed.text()}`);
          // Studio /api/farm/sign now returns the envelope; unwrap to get { results }
          const signRaw = (await signed.json()) as unknown;
          const { results } = unwrapEnvelope<{ results: { url: string; headers: Record<string, string> }[] }>(signRaw);
          for (let i = 0; i < files.length; i++) {
            const put = await fetch(results[i]!.url, { method: "PUT", headers: results[i]!.headers, body: files[i]!.body });
            if (!put.ok) throw new Error(`PUT ${files[i]!.output} -> ${put.status}`);
          }
          const done = await post(`/v1/worker/jobs/${job.id}/complete`, { lease_token: job.lease_token, result: { manifest: "tts.json", summary: {} } });
          if (!done.ok) throw new Error(`complete ${done.status} ${await done.text()}`);
        }
      } catch (e) {
        writeFileSync(join(testDir, "fake-tts.log"), `${String(e)}\n`, { flag: "a" });
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  })();
  return () => { running = false; };
}

// ---------------------------------------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------------------------------------

beforeAll(async () => {
  if (!isE2E) return;
  for (const f of [FFMPEG, FFPROBE, join(AG_FARM_DIR, "apps/api/dist/main.js"), RENDER_WORKER_ENTRY, join(ROOT, "apps/api/dist/main.js"), join(ROOT, "apps/worker/dist/main.js")]) {
    if (!existsSync(f)) throw new Error(`missing ${f} (build it first)`);
  }
  testDir = join(tmpdir(), `studio-prod-e2e-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  process.stderr.write(`[e2e] logs in ${testDir}\n`);

  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  jwtKey = rsa.privateKey;
  jwk = { ...(rsa.publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: AUTH.kid, use: "sig", alg: "RS256" };
  const ticketKeys = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const ownerKey = randomBytes(24).toString("base64url");

  execFileSync("docker", ["compose", "-f", join(AG_FARM_DIR, "docker-compose.test.yml"), "up", "-d", "--wait"], { stdio: "inherit", timeout: 90_000 });
  fakeS3 = new FakeS3Server(PORTS.s3, join(testDir, "s3"));
  await fakeS3.start();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { S3Client, CreateBucketCommand, PutObjectCommand } = require("@aws-sdk/client-s3") as typeof import("@aws-sdk/client-s3");
  const s3 = new S3Client({ endpoint: `http://127.0.0.1:${PORTS.s3}`, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: S3.key, secretAccessKey: S3.secret } });
  await s3.send(new CreateBucketCommand({ Bucket: S3.bucket }));
  for (const [asset, video, freq] of [["asset-a", "testsrc2", 440], ["asset-b", "smptebars", 660]] as const) {
    const p = join(testDir, `${asset}.mp4`);
    await lavfiAsset(p, video, freq, 24);
    await s3.send(new PutObjectCommand({ Bucket: S3.bucket, Key: `assets/${asset}.mp4`, Body: readFileSync(p), ContentType: "video/mp4" }));
  }
  await startFakeAgGo();

  const farmDb = `postgresql://farm_test:farm_test@localhost:${PORTS.db}/ag_farm_test`;
  execFileSync(process.execPath, [join(AG_FARM_DIR, "node_modules/typeorm/cli.js"), "migration:run", "--dataSource", "dist/database/data-source.js"],
    { cwd: join(AG_FARM_DIR, "apps/api"), env: { ...process.env, DATABASE_URL: farmDb }, stdio: "pipe" });
  spawnProc(process.execPath, [join(AG_FARM_DIR, "apps/api/dist/main.js")], {
    NODE_ENV: "test", PORT: String(PORTS.hub), DATABASE_URL: farmDb, DATABASE_POOL_MAX: "3",
    AUTH0_ISSUER_URL: AUTH.issuer, AUTH0_AUDIENCE: AUTH.audience, AUTH0_JWKS_URL: `http://127.0.0.1:${PORTS.agGo}/.well-known/jwks.json`,
    AUTH0_ALLOWED_CLIENT_IDS: AUTH.azp, ACCOUNT_API_URL: `http://127.0.0.1:${PORTS.agGo}`,
    FARM_TICKET_PRIVATE_KEY: ticketKeys.privateKey.replace(/\n/g, "\\n"), FARM_TICKET_PUBLIC_KEY: ticketKeys.publicKey.replace(/\n/g, "\\n"),
    REAPER_INTERVAL_MS: "999999", NODE_OFFLINE_AFTER_SECONDS: "90", FRONTEND_ORIGIN: "*",
  }, "ag-farm");
  await waitFor("ag-farm hub", async () => (await fetch(`http://127.0.0.1:${PORTS.hub}/health`)).ok);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require("pg") as typeof import("pg");
  const pg = new Client({ connectionString: farmDb });
  await pg.connect();
  await pg.query("DELETE FROM farm_jobs WHERE owner = 'studio'");
  await pg.query(
    `INSERT INTO farm_owners (id, key_hash, sign_url, allowed_types, default_lane, created_at, updated_at) VALUES ('studio', $1, $2, $3, 'interactive', NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET key_hash = $1, sign_url = $2, allowed_types = $3`,
    [createHash("sha256").update(ownerKey).digest("hex"), `http://127.0.0.1:${PORTS.api}/api/farm/sign`, ["studio.tts", "studio.render_preview", "studio.render_final"]]);
  const nodeToken = (name: string, kinds: string[]) => {
    const token = randomBytes(24).toString("base64url");
    return pg.query(
      `INSERT INTO farm_nodes (id, name, machine, token_hash, kinds, capabilities, status, last_seen_at, created_at, updated_at)
       VALUES ($1, $2, 'e2e', $3, $4, '{}'::jsonb, 'active', NOW(), NOW(), NOW())`,
      [randomUUID(), name, createHash("sha256").update(token).digest("hex"), kinds]).then(() => token);
  };
  const renderToken = await nodeToken(`e2e-render-${randomUUID().slice(0, 8)}`, ["studio.render_preview", "studio.render_final"]);
  const ttsToken = await nodeToken(`e2e-tts-${randomUUID().slice(0, 8)}`, ["studio.tts"]);
  await pg.end();

  const studioEnv = {
    STUDIO_DB_PATH: join(testDir, "studio.db"), STUDIO_DATA_ROOT: join(testDir, "harness"),
    AUTH0_ISSUER_URL: AUTH.issuer, AUTH0_AUDIENCE: AUTH.audience, AUTH0_JWKS_URI: `http://127.0.0.1:${PORTS.agGo}/.well-known/jwks.json`,
    AUTH0_ALLOWED_CLIENT_IDS: AUTH.azp, ACCOUNT_API_URL: `http://127.0.0.1:${PORTS.agGo}`,
    AG_GO_API_URL: `http://127.0.0.1:${PORTS.agGo}`, AG_GO_SERVICE_KEY: "e2e-service-key",
    FARM_URL: `http://127.0.0.1:${PORTS.hub}`, FARM_OWNER_KEY: ownerKey, FARM_TICKET_PUBLIC_KEY: ticketKeys.publicKey,
    STUDIO_R2_ENDPOINT: `http://127.0.0.1:${PORTS.s3}`, STUDIO_R2_BUCKET: S3.bucket, STUDIO_R2_ACCESS_KEY_ID: S3.key, STUDIO_R2_SECRET_ACCESS_KEY: S3.secret,
    FARM_URL_TTL_SECONDS: "3600", STUDIO_FFMPEG_PATH: FFMPEG, NODE_ENV: "test",
  };
  spawnProc(process.execPath, [join(ROOT, "apps/api/dist/main.js")], { ...studioEnv, PORT: String(PORTS.api) }, "studio-api");
  await waitFor("Studio API", async () => (await fetch(`http://127.0.0.1:${PORTS.api}/api/health`)).ok);
  spawnProc(process.execPath, [join(ROOT, "apps/worker/dist/main.js")], {
    ...studioEnv, WORKER_OWNER: "e2e-studio-worker", FARM_POLL_MS: "1000",
    STUDIO_CLAUDE_ARGV: JSON.stringify([process.execPath, join(ROOT, "fixtures", "fake-studio-claude.mjs")]),
    FAKE_STUDIO_MODE: "select-bad-once",
  }, "studio-worker");

  const workerYaml = join(testDir, "render-worker.yaml");
  mkdirSync(join(testDir, "rw-work"), { recursive: true });
  mkdirSync(join(testDir, "rw-cache"), { recursive: true });
  writeFileSync(join(testDir, "machine.yaml"), "cpu_slots: 2\ngpu_slots: 0\n");
  writeFileSync(workerYaml, [
    `hub_url: "http://127.0.0.1:${PORTS.hub}"`, `token: "${renderToken}"`, `name: "e2e-render"`,
    `kinds: ["studio.render_preview", "studio.render_final"]`,
    `work_dir: "${join(testDir, "rw-work").replace(/\\/g, "/")}"`, `machine_file: "${join(testDir, "machine.yaml").replace(/\\/g, "/")}"`,
    "cache:", `  dir: "${join(testDir, "rw-cache").replace(/\\/g, "/")}"`, "  max_gb: 5",
    "extra:", `  ffmpeg_path: "${FFMPEG.replace(/\\/g, "/")}"`, `  ffprobe_path: "${FFPROBE.replace(/\\/g, "/")}"`,
  ].join("\n"));
  spawnProc(process.execPath, [RENDER_WORKER_ENTRY, "--config", workerYaml], { FFMPEG_PATH: FFMPEG, FFPROBE_PATH: FFPROBE, NODE_ENV: "production" }, "render-worker");
  stopTts = startFakeTtsWorker(ttsToken);
}, 240_000);

afterAll(async () => {
  if (!isE2E) return;
  stopTts?.();
  for (const p of procs) if (!p.killed) p.kill();
  await new Promise((r) => setTimeout(r, 800));
  await new Promise<void>((r) => (agGo ? agGo.close(() => r()) : r()));
  await fakeS3?.stop().catch(() => {});
  try { execFileSync("docker", ["compose", "-f", join(AG_FARM_DIR, "docker-compose.test.yml"), "down"], { stdio: "inherit", timeout: 60_000 }); } catch { /* ignore */ }
  if (process.env.E2E_KEEP !== "1") rmSync(testDir, { recursive: true, force: true });
}, 120_000);

// ---------------------------------------------------------------------------------------------------------
// the production
// ---------------------------------------------------------------------------------------------------------

type RunView = { state: string; waiting_gate: string | null; stages: { key: string; state: string; attempts: number; error: string | null; failed_checks: unknown[] }[] };
type Timeline = { narration: { line_id: string; text: string; audio: { key: string; duration: number } | null }[]; clips: { clip_id: string; segment_id: string; src_in: number; src_out: number }[]; [k: string]: unknown };

// NOTE: ag-studio-production@1.0.0 was deleted in GĐ3 (superseded by ag-studio-series-plan@1.0.0).
// This test is archived. Use tests/e2e/series-flow.e2e.test.ts for the current series flow.
describe.skip("GĐ4 E2E (ARCHIVED — workflow deleted): brief -> Claude (fake) -> gates -> editor -> farm renders -> MP4 + SRT", () => {
  let prodId = "";
  const run = () => ok<RunView>("GET", `/productions/${prodId}/run`);
  const waitGate = (gate: string, ms = 240_000) => waitFor(`gate ${gate}`, async () => {
    const v = await run();
    const stuck = v.stages.find((s) => s.state === "FAILED" || (s.state === "WAITING_HUMAN" && !["approve-treatment", "shot-board", "edit"].includes(s.key)));
    if (stuck) throw new Fatal(`stage ${stuck.key} ${stuck.state}: ${stuck.error} ${JSON.stringify(stuck.failed_checks)}`);
    return v.waiting_gate === gate ? v : null;
  }, ms, 1000);

  it("creates the production over the API and starts the run", async () => {
    const team = await ok<{ id: string }>("POST", "/teams", { name: "Nhóm E2E" });
    const prod = await ok<{ id: string; ownerUserId: string }>("POST", `/teams/${team.id}/productions`, {
      title: "Phở sáng Hà Nội", brief: "Một video ngắn về bát phở buổi sáng ở Hà Nội", canvas: CANVAS, targetSeconds: 12, aspect: "16:9", language: "vi",
    });
    prodId = prod.id;
    expect(prod.ownerUserId).toBe(OWNER);
    await ok("POST", `/productions/${prodId}/sources`, { folderIds: [FOLDER] });
    // a stranger is not a member of the team
    expect((await api("GET", `/productions/${prodId}/run`, undefined, "auth0|stranger")).status).toBe(403);
    await ok("POST", `/productions/${prodId}/run`);
    expect((await api("POST", `/productions/${prodId}/run`)).status).toBe(409);
  });

  it("approve-treatment: a bad edit is refused with problems, the good one passes", async () => {
    await waitGate("approve-treatment");
    const treatment = await ok<{ beats: { seconds: number; purpose: string }[] }>("GET", `/productions/${prodId}/run/documents/treatment/treatment.json`);
    const bad = await api<{ failed: { check_id: string }[] }>("POST", `/productions/${prodId}/run/gates/approve-treatment`, { document: { ...treatment, beats: treatment.beats.map((b) => ({ ...b, seconds: b.seconds * 4 })) } });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).toContain("treatment-valid");
    treatment.beats[0]!.purpose = "Mở đầu: phố cổ thức dậy";
    await ok("POST", `/productions/${prodId}/run/gates/approve-treatment`, { document: treatment });
  });

  it("shot-board: Claude's first selection was repaired; one pick is swapped for an alternate", async () => {
    await waitGate("shot-board");
    const v = await run();
    expect(v.stages.find((s) => s.key === "select-shots")!.attempts).toBe(1); // repaired inside the attempt
    const sel = await ok<{ beats: { beat_id: string; picks: { segment_id: string; reason: string }[]; alternates: { segment_id: string; reason: string }[] }[] }>("GET", `/productions/${prodId}/run/documents/select-shots/selection.json`);
    const known = new Set(SEGMENTS.map((s) => s.segmentId));
    expect(sel.beats.flatMap((b) => b.picks).every((p) => known.has(p.segment_id))).toBe(true);
    const b1 = sel.beats[1]!;
    const alt = b1.alternates[0]!;
    sel.beats[1] = { ...b1, picks: [alt, ...b1.picks.slice(1)], alternates: [b1.picks[0]!, ...b1.alternates.slice(1)] };
    await ok("POST", `/productions/${prodId}/run/gates/shot-board`, { document: sel });
    (globalThis as { swapped?: string }).swapped = alt.segment_id;
  });

  it("editor: autosave revisions, 409 on a stale base, one-line TTS, render preview through the farm", async () => {
    await waitGate("edit");
    expect(ttsJobs.length).toBe(1);
    const latest = await ok<{ revision: number; data: Timeline; issues: { severity: string }[] }>("GET", `/productions/${prodId}/timeline`);
    expect(latest.revision).toBe(1);
    expect(latest.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(latest.data.clips.map((c) => c.segment_id)).toContain((globalThis as { swapped?: string }).swapped);

    // edit: trim the first clip, change one sentence (its audio goes away)
    const t: Timeline = JSON.parse(JSON.stringify(latest.data));
    t.clips[0]!.src_out = Math.round((t.clips[0]!.src_out + 0.5) * 1000) / 1000;
    const newText = "Hà Nội thức dậy trong mùi phở thơm";
    t.narration[0] = { ...t.narration[0]!, text: newText, audio: null };
    const r2 = await ok<{ revision: number; issues: { code: string }[] }>("POST", `/productions/${prodId}/timeline/revisions`, { baseRevision: 1, data: t });
    expect(r2.revision).toBe(2);
    expect(r2.issues.map((i) => i.code)).toContain("narration_not_voiced");
    const stale = await api<{ code: string; currentRevision: number }>("POST", `/productions/${prodId}/timeline/revisions`, { baseRevision: 1, data: latest.data });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "revision_conflict", currentRevision: 2 });

    // re-TTS only that sentence
    const job = await ok<{ id: string }>("POST", `/productions/${prodId}/editor/tts`, { lineId: t.narration[0]!.line_id, text: newText });
    const done = await waitFor("line TTS", async () => {
      const j = await ok<{ status: string; result: { key: string; duration: number; text: string } | null; error: string | null }>("GET", `/productions/${prodId}/editor/jobs/${job.id}`);
      if (j.status === "failed") throw new Fatal(`tts failed: ${j.error}`);
      return j.status === "completed" ? j : null;
    }, 120_000, 1000);
    expect(ttsJobs.length).toBe(2);
    expect(done.result!.text).toBe(newText);
    t.narration[0] = { ...t.narration[0]!, audio: { key: done.result!.key, duration: done.result!.duration } };
    const r3 = await ok<{ revision: number; issues: { severity: string }[] }>("POST", `/productions/${prodId}/timeline/revisions`, { baseRevision: 2, data: t });
    expect(r3.revision).toBe(3);
    expect(r3.issues.filter((i) => i.severity === "error")).toEqual([]);

    // render preview of revision 3 on the real render worker
    const pv = await ok<{ id: string }>("POST", `/productions/${prodId}/editor/previews`, { revision: 3 });
    const pvDone = await waitFor("render preview", async () => {
      const j = await ok<{ status: string; url?: string; error: string | null }>("GET", `/productions/${prodId}/editor/jobs/${pv.id}`);
      if (j.status === "failed") throw new Fatal(`preview failed: ${j.error}`);
      return j.status === "completed" ? j : null;
    }, 240_000, 2000);
    expect(pvDone.url).toBeTruthy();
    const file = join(testDir, "preview.mp4");
    writeFileSync(file, Buffer.from(await (await fetch(pvDone.url!)).arrayBuffer()));
    const p = await probe(file);
    expect([p.width, p.height]).toEqual([CANVAS.width, CANVAS.height]);
  });

  it("finishing the edit renders the final on the farm, checks it, and exports MP4 + SRT", async () => {
    await ok("POST", `/productions/${prodId}/run/gates/edit`);
    const final = await waitFor("run SUCCEEDED", async () => {
      const v = await run();
      const bad = v.stages.find((s) => s.state === "FAILED" || (s.state === "WAITING_HUMAN" && s.key !== "edit"));
      if (bad || v.state === "FAILED") throw new Fatal(`stage ${bad?.key} ${bad?.state}: ${bad?.error} ${JSON.stringify(bad?.failed_checks)}`);
      return v.state === "SUCCEEDED" ? v : null;
    }, 300_000, 2000);
    expect(final.stages.every((s) => s.state === "SUCCEEDED")).toBe(true);

    const exp = await ok<{ durationSeconds: number; files: { kind: string; name: string; url: string | null }[] }>("GET", `/productions/${prodId}/exports`);
    expect(exp.files.map((f) => f.kind).sort()).toEqual(["mp4", "srt", "timeline", "vtt"]);
    const mp4 = join(testDir, "final.mp4");
    writeFileSync(mp4, Buffer.from(await (await fetch(exp.files.find((f) => f.kind === "mp4")!.url!)).arrayBuffer()));
    const p = await probe(mp4);
    expect([p.width, p.height]).toEqual([CANVAS.width, CANVAS.height]);
    expect(p.hasAudio).toBe(true);
    const tl = await ok<{ data: Timeline }>("GET", `/productions/${prodId}/timeline`);
    const expected = (tl.data.clips as { src_in: number; src_out: number }[]).reduce((s, c) => s + c.src_out - c.src_in, 0);
    expect(Math.abs(p.duration - expected)).toBeLessThan(0.5);
    const srt = await (await fetch(exp.files.find((f) => f.kind === "srt")!.url!)).text();
    expect(srt).toMatch(/^1\r?\n00:00:00,000 --> 00:00:0\d,\d{3}/);
    expect(srt).toContain("Hà Nội thức dậy trong mùi phở thơm");

    // every footage call was made as the production owner (never as a production id)
    const resolves = agGoCalls.filter((c) => c.path === "/footage/segments/resolve");
    expect(resolves.length).toBeGreaterThan(0);
    expect(new Set(agGoCalls.filter((c) => c.path !== "/.well-known/jwks.json").map((c) => c.actAs))).toEqual(new Set([OWNER]));
  });
});
