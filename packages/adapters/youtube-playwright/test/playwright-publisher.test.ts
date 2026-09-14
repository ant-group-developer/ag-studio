import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PublisherChannel } from "@harness/contracts";
import { PlaywrightPublisher } from "../src/index.js";

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

  it("fetchImpl returns 404 and lookupScript isn't available -> found:false", async () => {
    const repoDir = prepFixture();
    const fetchImpl = (async () => ({ status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    const publisher = new PlaywrightPublisher({ fetchImpl, lookupScript: join(repoDir, "missing.mjs") });
    const outcome = await publisher.lookup({ channel: channel(repoDir), video_id: "yt-1" });
    expect(outcome.found).toBe(false);
  });
});
