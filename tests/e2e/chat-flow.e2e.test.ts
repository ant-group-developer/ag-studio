/**
 * Phase 2 E2E (plan 2026-10-06-ag-studio-phase-2-chat, E1): the chat-first series through the real Studio API and
 * worker (dist), stopping before the render — so no farm, no render worker, no Docker.
 *
 *   POST drafts (one message) → Claude asks → answer → start → approve trend report → chat about the R&D → approve
 *   the new version → branding, plan approved → episode → chat about its timeline → apply → approve → the kit waits.
 *
 * Real:  Studio API (dist), Studio worker (dist, stage loops + chat loop).
 * Fake:  Claude (fixtures/fake-studio-claude.mjs), ag-go + Account API + JWKS (one HTTP server), S3 (FakeS3Server).
 *
 * Requires: E2E=1, built dists of ag-studio apps/api + apps/worker (`corepack pnpm -r run build`).
 * Run: E2E=1 corepack pnpm exec vitest run --config tests/e2e/vitest.config.ts tests/e2e/chat-flow.e2e.test.ts
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createSign, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeS3Server } from "./fake-s3.js";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const isE2E = process.env.E2E === "1";
const PORTS = { s3: 9131, api: 3404, agGo: 4405, farm: 3409 };
const S3 = { bucket: "studio-chat-e2e", key: "devkey", secret: "devsecret" };
const AUTH = { issuer: "https://e2e.auth.test/", audience: "studio-chat-e2e", azp: "e2e-chat-web", kid: "e2e-chat-key" };
const OWNER = "auth0|chat-owner-e2e";
const FOLDER = "0c0f0000-0000-4000-8000-00000000c4a7";

const procs: ChildProcess[] = [];
let testDir = "";
let fakeS3: FakeS3Server | null = null;
let agGo: http.Server | null = null;
let jwtKey: KeyObject;
let jwk: Record<string, unknown>;

const ASSETS = Array.from({ length: 4 }, (_, i) => ({
  assetId: `asset-${i + 1}`, name: `kyoto-${i + 1}.mp4`, durationMs: 30_000, orientation: "landscape", hasSpeech: false,
  titleVi: `Kyoto cảnh ${i + 1}`, summaryVi: `Cảnh Kyoto số ${i + 1}`, topics: ["kyoto"], tags: ["kyoto"], quality: 4, usable: true, approved: true,
}));

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
function jwt(sub: string): string {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: AUTH.kid, typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ sub, iss: AUTH.issuer, aud: AUTH.audience, azp: AUTH.azp, iat: now, exp: now + 3600 }));
  return `${header}.${payload}.${b64url(createSign("RSA-SHA256").update(`${header}.${payload}`).sign(jwtKey))}`;
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${PORTS.api}/api${path}`, {
    method, headers: { Authorization: `Bearer ${jwt(OWNER)}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const raw = text ? (JSON.parse(text) as { data?: unknown; success?: boolean; error?: unknown }) : null;
  const unwrapped = raw && typeof raw === "object" && "success" in raw ? (raw.success ? raw.data : raw.error) : raw;
  return { status: res.status, body: unwrapped as T };
}
async function ok<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await api<T>(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown = null;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

interface Turn { id: string; role: string; status: string; action: string | null; text: string }
interface Thread { turns: Turn[]; scope: { stageKey: string; scope: string } | null; current: { turnId: string | null; pendingApply: boolean } | null }
const thread = (prod: string, episodeId?: string) => ok<Thread>("GET", `/productions/${prod}/chat${episodeId ? `?episodeId=${episodeId}` : ""}`);
const atStep = (prod: string, stageKey: string, episodeId?: string) =>
  waitFor(`the chat at ${stageKey}`, async () => { const t = await thread(prod, episodeId); return t.scope?.stageKey === stageKey ? t : null; });
async function say(prod: string, text: string, episodeId?: string): Promise<Turn> {
  const sent = await ok<{ assistant: Turn }>("POST", `/productions/${prod}/chat`, { text, ...(episodeId ? { episodeId } : {}) });
  return waitFor(`a reply to "${text}"`, async () => (await thread(prod, episodeId)).turns.find((t) => t.id === sent.assistant.id && t.status === "done"));
}
async function approve(prod: string, stageKey: string, episodeId?: string): Promise<void> {
  const t = await atStep(prod, stageKey, episodeId);
  await ok("POST", `/productions/${prod}/chat/approve`, { stageKey, turnId: t.current?.turnId ?? undefined, ...(episodeId ? { episodeId } : {}) });
}

function startFakeAgGo(): Promise<void> {
  agGo = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const url = req.url ?? "";
    const json = (status: number, v: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); };
    const wrap = (v: unknown) => json(200, { data: v, requestId: `req-${Date.now()}`, success: true, error: null, timestamp: new Date().toISOString() });
    if (url === "/.well-known/jwks.json") return json(200, { keys: [jwk] });
    if (req.method === "GET" && url.startsWith("/v2/users/me")) return wrap({ userId: OWNER, userType: "USER", permissions: [] });
    if (req.method === "GET" && url.includes("/users")) return wrap({ items: [], total: 0 });
    if (req.headers["x-service-key"] !== "e2e-service-key") return json(401, { message: "no service key" });
    if (req.method === "GET" && url.startsWith("/footage/folders")) {
      return wrap({ folders: [{ id: FOLDER, parentId: null, name: "Kyoto 2025", path: "/Kyoto 2025", analyzedVideos: 4, usableVideos: 4 }] });
    }
    if (req.method === "POST" && url === "/footage/catalog") {
      const b = JSON.parse(body) as { folderIds: string[] };
      return wrap({ items: b.folderIds.includes(FOLDER) ? ASSETS : [], nextCursor: null });
    }
    json(404, { message: `fake ag-go: no ${req.method} ${url}` });
  });
  return new Promise((r) => agGo!.listen(PORTS.agGo, "127.0.0.1", () => r()));
}

function spawnProc(entry: string, env: NodeJS.ProcessEnv, label: string): void {
  const p = spawn(process.execPath, [entry], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const log = join(testDir, `${label}.log`);
  p.stdout?.on("data", (d: Buffer) => writeFileSync(log, d, { flag: "a" }));
  p.stderr?.on("data", (d: Buffer) => writeFileSync(log, d, { flag: "a" }));
  procs.push(p);
}

beforeAll(async () => {
  if (!isE2E) return;
  for (const f of [join(ROOT, "apps/api/dist/main.js"), join(ROOT, "apps/worker/dist/main.js")]) {
    if (!existsSync(f)) throw new Error(`missing ${f} — build it first`);
  }
  testDir = join(tmpdir(), `studio-chat-e2e-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  process.stderr.write(`[e2e] logs in ${testDir}\n`);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  jwtKey = rsa.privateKey;
  jwk = { ...(rsa.publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: AUTH.kid, use: "sig", alg: "RS256" };
  const ticket = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

  fakeS3 = new FakeS3Server(PORTS.s3, join(testDir, "s3"));
  await fakeS3.start();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { S3Client, CreateBucketCommand } = require("@aws-sdk/client-s3") as typeof import("@aws-sdk/client-s3");
  await new S3Client({ endpoint: `http://127.0.0.1:${PORTS.s3}`, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: S3.key, secretAccessKey: S3.secret } })
    .send(new CreateBucketCommand({ Bucket: S3.bucket }));
  await startFakeAgGo();

  const env = {
    STUDIO_DB_PATH: join(testDir, "studio.db"), STUDIO_DATA_ROOT: join(testDir, "harness"),
    AUTH0_ISSUER_URL: AUTH.issuer, AUTH0_AUDIENCE: AUTH.audience, AUTH0_JWKS_URI: `http://127.0.0.1:${PORTS.agGo}/.well-known/jwks.json`,
    AUTH0_ALLOWED_CLIENT_IDS: AUTH.azp, ACCOUNT_API_URL: `http://127.0.0.1:${PORTS.agGo}`,
    AG_GO_API_URL: `http://127.0.0.1:${PORTS.agGo}`, AG_GO_SERVICE_KEY: "e2e-service-key",
    // no farm in this test: nothing reaches render-final
    FARM_URL: `http://127.0.0.1:${PORTS.farm}`, FARM_OWNER_KEY: "unused", FARM_TICKET_PUBLIC_KEY: ticket.publicKey,
    STUDIO_R2_ENDPOINT: `http://127.0.0.1:${PORTS.s3}`, STUDIO_R2_BUCKET: S3.bucket, STUDIO_R2_ACCESS_KEY_ID: S3.key, STUDIO_R2_SECRET_ACCESS_KEY: S3.secret,
    FARM_URL_TTL_SECONDS: "3600", NODE_ENV: "test", STUDIO_CLAUDE_MAX_CONCURRENT: "4",
  };
  spawnProc(join(ROOT, "apps/api/dist/main.js"), { ...env, PORT: String(PORTS.api) }, "studio-api");
  await waitFor("Studio API", async () => (await fetch(`http://127.0.0.1:${PORTS.api}/api/health`)).ok, 60_000);
  spawnProc(join(ROOT, "apps/worker/dist/main.js"), {
    ...env, WORKER_OWNER: "e2e-chat-worker",
    STUDIO_CLAUDE_ARGV: JSON.stringify([process.execPath, join(ROOT, "fixtures", "fake-studio-claude.mjs")]),
  }, "studio-worker");
}, 180_000);

afterAll(async () => {
  for (const p of procs) p.kill();
  await new Promise((r) => setTimeout(r, 500));
  agGo?.close();
  await fakeS3?.stop();
  if (testDir && process.env.E2E_KEEP !== "1") rmSync(testDir, { recursive: true, force: true });
});

describe.skipIf(!isE2E)("chat-first series through the real API and worker (fake Claude)", () => {
  it("one message to an approved timeline", async () => {
    const team = await ok<{ id: string }>("POST", "/teams", { name: "Du lịch E2E" });
    const draft = await ok<{ productionId: string }>("POST", `/teams/${team.id}/drafts`, {
      text: `Làm series vlog từ @[Kyoto 2025](folder:${FOLDER}), giống kênh @meitime`,
    });
    const prod = draft.productionId;
    const asked = await waitFor("Claude's first reply", async () => (await thread(prod)).turns.find((t) => t.role === "assistant" && t.status === "done"));
    expect(asked.text).toBe("Video ngang hay dọc?");
    expect((await say(prod, "Ngang 16:9")).action).toBe("suggest_approve");
    await ok("POST", `/productions/${prod}/start`);

    await approve(prod, "approve-trend-report");
    await atStep(prod, "approve-rnd");
    expect((await say(prod, "Gộp tập 3 và 4")).action).toBe("revise");
    await approve(prod, "approve-rnd");
    await approve(prod, "approve-branding");
    await approve(prod, "approve-plan");

    const episodes = await waitFor("episodes", async () => {
      const r = await ok<{ items: { id: string }[] }>("GET", `/productions/${prod}/episodes`);
      return r.items.length ? r.items : null;
    });
    const ep = episodes[0]!.id;
    await atStep(prod, "approve-timeline", ep);
    const edit = await say(prod, "Thêm chữ \"Kyoto buổi sáng\" ở clip 2", ep);
    expect(edit.action).toBe("revise");
    await ok("POST", `/productions/${prod}/chat/${edit.id}/apply`);
    await approve(prod, "approve-timeline", ep);
    await atStep(prod, "approve-youtube-kit", ep);

    const overview = await ok<{ items: { id: string; group: string }[] }>("GET", "/studio/overview");
    expect(overview.items.find((p) => p.id === prod)?.group).toBe("waiting_you");
    const claude = await ok<{ max: number }>("GET", "/studio/claude");
    expect(claude.max).toBe(4);
  }, 300_000);
});
