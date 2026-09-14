import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PublisherChannel } from "@harness/contracts";
import { PlaywrightPublisher, publisherChildEnv } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "..", "..", "..", "..", "fixtures", "legacy-channel-repo");

function channel(repoDir: string): PublisherChannel {
  return { channel_id: "channel-a", repo_dir: repoDir, legacy_project_id: "project-01", expected_channel_id: "UCfake000000000000000001" };
}

/** Copies the fixture repo into a fresh temp dir; never touches the committed fixture. */
function prepFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "youtube-playwright-"));
  const repoDir = join(root, "legacy-channel-repo");
  cpSync(FIXTURE_DIR, repoDir, { recursive: true });
  return repoDir;
}

function episodeDir(repoDir: string, nn = "15"): string {
  return join(repoDir, "outputs", "project-01", "episodes", `episode-${nn}`);
}

function withManifest(repoDir: string, nn = "15"): void {
  const dir = join(episodeDir(repoDir, nn), "publish");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `episode-${nn}-upload-manifest.json`), JSON.stringify({ title: `Episode ${nn}` }));
}

function shortlyBefore(): string {
  return new Date(Date.now() - 5000).toISOString();
}

async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("publisherChildEnv", () => {
  it("drops every HARNESS_SECRET_* key (any casing) and keeps everything else", () => {
    const env = publisherChildEnv({
      PATH: "/bin", USERPROFILE: "C:/Users/x", FAKE_UPLOAD_MODE: "ok",
      HARNESS_SECRET_YOUTUBE_C1_EMAIL: "owner@example.com", harness_secret_lower_case: "also-secret",
      HARNESS_WORKSPACE: "/ws", HARNESS_CLI_ARGV: "[]",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.USERPROFILE).toBe("C:/Users/x");
    expect(env.FAKE_UPLOAD_MODE).toBe("ok");
    expect(env.HARNESS_WORKSPACE).toBe("/ws"); // not an allow-list: only secrets are stripped
    expect(env.HARNESS_CLI_ARGV).toBe("[]");
    expect(env).not.toHaveProperty("HARNESS_SECRET_YOUTUBE_C1_EMAIL");
    expect(env).not.toHaveProperty("harness_secret_lower_case");
  });
});

describe("PlaywrightPublisher.upload", () => {
  it("ok -> uploaded, with a video_id matching the queue line", async () => {
    const repoDir = prepFixture();
    withManifest(repoDir);
    const publisher = new PlaywrightPublisher();
    await withEnv({ FAKE_UPLOAD_MODE: "ok" }, async () => {
      const outcome = await publisher.upload({ channel: channel(repoDir), episode_no: 15, episode_dir: episodeDir(repoDir), intent_at: shortlyBefore(), timeout_seconds: 30 });
      expect(outcome.kind).toBe("uploaded");
      if (outcome.kind !== "uploaded") return;
      expect(outcome.video_id).toMatch(/^fk[a-z0-9]{9}$/);
      expect(outcome.receipt.exit_code).toBe(0);
      const queue = JSON.parse(readFileSync(join(repoDir, "outputs", "project-01", "publish-queue.json"), "utf8"));
      expect(queue).toHaveLength(1);
      expect(queue[0].videoId).toBe(outcome.video_id);
    });
  });

  it("lost -> unknown, but the queue keeps the line for a later reconciliation pass", async () => {
    const repoDir = prepFixture();
    withManifest(repoDir);
    const publisher = new PlaywrightPublisher();
    await withEnv({ FAKE_UPLOAD_MODE: "lost" }, async () => {
      const outcome = await publisher.upload({ channel: channel(repoDir), episode_no: 15, episode_dir: episodeDir(repoDir), intent_at: shortlyBefore(), timeout_seconds: 30 });
      expect(outcome.kind).toBe("unknown");
      const queue = JSON.parse(readFileSync(join(repoDir, "outputs", "project-01", "publish-queue.json"), "utf8"));
      expect(queue).toHaveLength(1);
      expect(queue[0].ep).toBe("15");
    });
  });

  it("refused -> refused", async () => {
    const repoDir = prepFixture();
    withManifest(repoDir);
    const publisher = new PlaywrightPublisher();
    await withEnv({ FAKE_UPLOAD_MODE: "refused" }, async () => {
      const outcome = await publisher.upload({ channel: channel(repoDir), episode_no: 15, episode_dir: episodeDir(repoDir), intent_at: shortlyBefore(), timeout_seconds: 30 });
      expect(outcome).toEqual({ kind: "refused", reason: expect.any(String) });
    });
  });

  it("busy -> busy", async () => {
    const repoDir = prepFixture();
    withManifest(repoDir);
    const publisher = new PlaywrightPublisher();
    await withEnv({ FAKE_UPLOAD_MODE: "busy" }, async () => {
      const outcome = await publisher.upload({ channel: channel(repoDir), episode_no: 15, episode_dir: episodeDir(repoDir), intent_at: shortlyBefore(), timeout_seconds: 30 });
      expect(outcome).toEqual({ kind: "busy", reason: expect.any(String) });
    });
  });

  it("a 1-second timeout against a hanging script (FAKE_UPLOAD_MODE=hang, sleeps ~5s) -> unknown", async () => {
    const repoDir = prepFixture();
    withManifest(repoDir);
    const publisher = new PlaywrightPublisher();
    await withEnv({ FAKE_UPLOAD_MODE: "hang" }, async () => {
      const outcome = await publisher.upload({ channel: channel(repoDir), episode_no: 15, episode_dir: episodeDir(repoDir), intent_at: shortlyBefore(), timeout_seconds: 1 });
      expect(outcome.kind).toBe("unknown");
    });
  });

  it("passes every stdout/stderr line through redact before it reaches log() and log_tail", async () => {
    const repoDir = prepFixture();
    withManifest(repoDir);
    const seen: string[] = [];
    const publisher = new PlaywrightPublisher({ redact: (s) => s.replaceAll("owner@example.com", "[REDACTED]") });
    await withEnv({ FAKE_UPLOAD_MODE: "ok" }, async () => {
      const outcome = await publisher.upload({
        channel: channel(repoDir), episode_no: 15, episode_dir: episodeDir(repoDir), intent_at: shortlyBefore(), timeout_seconds: 30,
        log: (line) => seen.push(line),
      });
      expect(outcome.kind).toBe("uploaded");
      if (outcome.kind !== "uploaded") return;
      const combined = [...seen, ...(outcome.receipt.log_tail as string[])].join("\n");
      expect(combined).toContain("[REDACTED]");
      expect(combined).not.toContain("owner@example.com");
    });
  });

  it("never passes HARNESS_SECRET_* to the legacy script, but keeps the rest of the environment", async () => {
    const repoDir = prepFixture();
    withManifest(repoDir);
    const seen: string[] = [];
    const publisher = new PlaywrightPublisher();
    await withEnv({ FAKE_UPLOAD_MODE: "ok", HARNESS_SECRET_YOUTUBE_C1_EMAIL: "owner@example.com" }, async () => {
      const outcome = await publisher.upload({
        channel: channel(repoDir), episode_no: 15, episode_dir: episodeDir(repoDir), intent_at: shortlyBefore(), timeout_seconds: 30,
        log: (line) => seen.push(line),
      });
      expect(outcome.kind, seen.join("\n")).toBe("uploaded"); // FAKE_UPLOAD_MODE (a non-secret var) still reached the child
      const envLine = seen.find((l) => l.includes("[upload] env="));
      expect(envLine, seen.join("\n")).toBe("[upload] env=");
    });
  });

  it("a repo_dir that does not exist (spawn ENOENT) -> busy, without crashing the process", async () => {
    const publisher = new PlaywrightPublisher();
    const missingRepo = join(mkdtempSync(join(tmpdir(), "gone-repo-")), "not-mounted");
    const outcome = await publisher.upload({ channel: channel(missingRepo), episode_no: 15, episode_dir: episodeDir(missingRepo), intent_at: shortlyBefore(), timeout_seconds: 30 });
    expect(outcome).toEqual({ kind: "busy", reason: expect.stringContaining("spawn failed") });
  });

  it("missing upload manifest -> refused (exit 3), same as an explicit refusal", async () => {
    const repoDir = prepFixture(); // no withManifest(): the manifest file is absent
    const publisher = new PlaywrightPublisher();
    const outcome = await publisher.upload({ channel: channel(repoDir), episode_no: 15, episode_dir: episodeDir(repoDir), intent_at: shortlyBefore(), timeout_seconds: 30 });
    expect(outcome).toEqual({ kind: "refused", reason: expect.any(String) });
  });
});

describe("PlaywrightPublisher.schedule", () => {
  it("ok -> scheduled, and writes outputs/<pid>/schedules/<videoId>.json", async () => {
    const repoDir = prepFixture();
    const publisher = new PlaywrightPublisher();
    const outcome = await publisher.schedule({ channel: channel(repoDir), video_id: "yt-1", at: "2026-09-20T13:00:00.000Z", timeout_seconds: 30 });
    expect(outcome).toEqual({ kind: "scheduled" });
    const written = JSON.parse(readFileSync(join(repoDir, "outputs", "project-01", "schedules", "yt-1.json"), "utf8"));
    expect(written).toEqual({ videoId: "yt-1", at: "2026-09-20T13:00:00.000Z" });
  });

  it("refused -> refused", async () => {
    const repoDir = prepFixture();
    const publisher = new PlaywrightPublisher();
    await withEnv({ FAKE_SCHEDULE_MODE: "refused" }, async () => {
      const outcome = await publisher.schedule({ channel: channel(repoDir), video_id: "yt-1", at: "2026-09-20T13:00:00.000Z", timeout_seconds: 30 });
      expect(outcome).toEqual({ kind: "refused", reason: expect.any(String) });
    });
  });

  it("busy -> busy", async () => {
    const repoDir = prepFixture();
    const publisher = new PlaywrightPublisher();
    await withEnv({ FAKE_SCHEDULE_MODE: "busy" }, async () => {
      const outcome = await publisher.schedule({ channel: channel(repoDir), video_id: "yt-1", at: "2026-09-20T13:00:00.000Z", timeout_seconds: 30 });
      expect(outcome).toEqual({ kind: "busy", reason: expect.any(String) });
    });
  });

  it("a repo_dir that does not exist (spawn ENOENT) -> busy, not a throw", async () => {
    const publisher = new PlaywrightPublisher();
    const missingRepo = join(mkdtempSync(join(tmpdir(), "gone-repo-")), "not-mounted");
    const outcome = await publisher.schedule({ channel: channel(missingRepo), video_id: "yt-1", at: "2026-09-20T13:00:00.000Z", timeout_seconds: 30 });
    expect(outcome).toEqual({ kind: "busy", reason: expect.stringContaining("spawn failed") });
  });

  it("crash -> throws a transient EXECUTOR_FAILED HarnessError", async () => {
    const repoDir = prepFixture();
    const publisher = new PlaywrightPublisher();
    await withEnv({ FAKE_SCHEDULE_MODE: "crash" }, async () => {
      await expect(publisher.schedule({ channel: channel(repoDir), video_id: "yt-1", at: "2026-09-20T13:00:00.000Z", timeout_seconds: 30 })).rejects.toMatchObject({
        name: "HarnessError",
        code: "EXECUTOR_FAILED",
      });
    });
  });
});

describe("PlaywrightPublisher.lookup", () => {
  it("lookupFile set -> answers from the file, keyed by video_id, without touching the network", async () => {
    const repoDir = prepFixture();
    const lookupFile = join(mkdtempSync(join(tmpdir(), "lookup-")), "lookup.json");
    writeFileSync(lookupFile, JSON.stringify({ "yt-9": { found: true, video_id: "yt-9", visibility: "public" } }));
    const fetchImpl = vi.fn();
    const publisher = new PlaywrightPublisher({ lookupFile, fetchImpl: fetchImpl as unknown as typeof fetch });
    const outcome = await publisher.lookup({ channel: channel(repoDir), video_id: "yt-9" });
    expect(outcome).toEqual({ found: true, video_id: "yt-9", visibility: "public" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lookupFile set -> falls back to a title:<title> key when video_id doesn't match", async () => {
    const repoDir = prepFixture();
    const lookupFile = join(mkdtempSync(join(tmpdir(), "lookup-")), "lookup.json");
    writeFileSync(lookupFile, JSON.stringify({ "title:My Episode": { found: true, video_id: "yt-10", visibility: "unlisted" } }));
    const publisher = new PlaywrightPublisher({ lookupFile });
    const outcome = await publisher.lookup({ channel: channel(repoDir), title: "My Episode" });
    expect(outcome).toEqual({ found: true, video_id: "yt-10", visibility: "unlisted" });
  });

  it("lookupFile set -> found:false for a key that isn't in the file", async () => {
    const repoDir = prepFixture();
    const lookupFile = join(mkdtempSync(join(tmpdir(), "lookup-")), "lookup.json");
    writeFileSync(lookupFile, JSON.stringify({}));
    const publisher = new PlaywrightPublisher({ lookupFile });
    expect(await publisher.lookup({ channel: channel(repoDir), video_id: "yt-1" })).toEqual({ found: false });
  });

  it("fetchImpl returns 200 -> found:true, visibility public", async () => {
    const repoDir = prepFixture();
    const fetchImpl = (async () => ({ status: 200, json: async () => ({ title: "A Title" }) })) as unknown as typeof fetch;
    const publisher = new PlaywrightPublisher({ fetchImpl });
    const outcome = await publisher.lookup({ channel: channel(repoDir), video_id: "yt-1" });
    expect(outcome).toEqual({ found: true, video_id: "yt-1", visibility: "public", title: "A Title" });
  });

  it("lookupFile entry {found:false} is a definitive not-found, not an error", async () => {
    const repoDir = prepFixture();
    const lookupFile = join(mkdtempSync(join(tmpdir(), "lookup-")), "lookup.json");
    writeFileSync(lookupFile, JSON.stringify({ "yt-1": { found: false, reason: "no matching video row in Studio's upload list" } }));
    const publisher = new PlaywrightPublisher({ lookupFile });
    const outcome = await publisher.lookup({ channel: channel(repoDir), video_id: "yt-1" });
    expect(outcome).toEqual({ found: false, reason: "no matching video row in Studio's upload list" });
    expect((outcome as { error?: boolean }).error).toBeUndefined();
  });

  it("fetchImpl returns 404 and lookupScript isn't available -> error:true (could not ask), not a not-found", async () => {
    const repoDir = prepFixture();
    const fetchImpl = (async () => ({ status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    const publisher = new PlaywrightPublisher({ fetchImpl, lookupScript: join(repoDir, "missing.mjs") });
    const outcome = await publisher.lookup({ channel: channel(repoDir), video_id: "yt-1" });
    expect(outcome).toEqual({ found: false, error: true, reason: expect.stringContaining("lookup script not found") });
  });

  it("fetchImpl throws (no network) and the Studio fallback cannot run -> error:true", async () => {
    const repoDir = prepFixture();
    const fetchImpl = (async () => { throw new Error("getaddrinfo ENOTFOUND www.youtube.com"); }) as unknown as typeof fetch;
    const publisher = new PlaywrightPublisher({ fetchImpl, lookupScript: join(repoDir, "missing.mjs") });
    const outcome = await publisher.lookup({ channel: channel(repoDir), video_id: "yt-1" });
    expect(outcome).toMatchObject({ found: false, error: true });
    expect((outcome as { reason: string }).reason).toContain("ENOTFOUND");
  });

  it("fetchImpl returns a non-200 that is not 401/403/404 -> error:true, without touching the Studio script", async () => {
    const repoDir = prepFixture();
    const fetchImpl = (async () => ({ status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    const publisher = new PlaywrightPublisher({ fetchImpl, lookupScript: join(repoDir, "missing.mjs") });
    const outcome = await publisher.lookup({ channel: channel(repoDir), video_id: "yt-1" });
    expect(outcome).toEqual({ found: false, error: true, reason: "oembed returned 503" });
  });

  it("a lookupScript that exits 0 with {found:false} is a definitive not-found; one that exits non-zero is an error", async () => {
    const repoDir = prepFixture();
    const scriptDir = mkdtempSync(join(tmpdir(), "lookup-script-"));
    const okScript = join(scriptDir, "definitive.mjs");
    writeFileSync(okScript, 'console.log(JSON.stringify({ found: false, reason: "not in the upload list" }));\n');
    const badScript = join(scriptDir, "broken.mjs");
    writeFileSync(badScript, 'console.log(JSON.stringify({ found: false, error: true, reason: "playwright not installed" }));\nprocess.exit(2);\n');
    const fetchImpl = (async () => ({ status: 404, json: async () => ({}) })) as unknown as typeof fetch;

    const definitive = await new PlaywrightPublisher({ fetchImpl, lookupScript: okScript }).lookup({ channel: channel(repoDir), video_id: "yt-1" });
    expect(definitive).toEqual({ found: false, reason: "not in the upload list" });

    const errored = await new PlaywrightPublisher({ fetchImpl, lookupScript: badScript }).lookup({ channel: channel(repoDir), video_id: "yt-1" });
    expect(errored).toMatchObject({ found: false, error: true });
  });

  it("a hanging lookupScript is killed at lookupTimeoutMs -> found:false with a timeout reason, well before the script's own 5s sleep", async () => {
    const repoDir = prepFixture();
    const scriptDir = mkdtempSync(join(tmpdir(), "hang-lookup-"));
    const hangScript = join(scriptDir, "hang-lookup.mjs");
    writeFileSync(hangScript, "setTimeout(() => process.exit(0), 5000);\n");
    const fetchImpl = (async () => ({ status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    const publisher = new PlaywrightPublisher({ fetchImpl, lookupScript: hangScript, lookupTimeoutMs: 500 });
    const startedAt = Date.now();
    const outcome = await publisher.lookup({ channel: channel(repoDir), video_id: "yt-1" });
    const elapsedMs = Date.now() - startedAt;
    expect(outcome).toEqual({ found: false, error: true, reason: expect.stringContaining("timed out") });
    expect(elapsedMs).toBeLessThan(4000);
  });
});
