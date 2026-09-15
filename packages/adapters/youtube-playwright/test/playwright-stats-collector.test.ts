import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PublisherChannel } from "@harness/contracts";
import { PlaywrightStatsCollector } from "../src/index.js";

function channel(repoDir = "D:/legacy-channel-a"): PublisherChannel {
  return { channel_id: "channel-a", repo_dir: repoDir, legacy_project_id: "project-01", expected_channel_id: "UCfake000000000000000001" };
}

/** A fake `collect-stats.mjs` stand-in driven by `FAKE_STATS_EXIT` (the real script only gets `node
 * --check`'d in tests — no Chrome). Always prints the names of any `HARNESS_SECRET_*` env vars it can
 * see, so a test can assert the child never receives one. */
function fakeScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-collect-stats-"));
  const path = join(dir, "collect-stats.mjs");
  writeFileSync(
    path,
    [
      'const mode = process.env.FAKE_STATS_EXIT || "0";',
      'const secretKeys = Object.keys(process.env).filter((k) => k.toUpperCase().startsWith("HARNESS_SECRET_"));',
      "console.log(`[collect] env=${secretKeys.join(\",\")}`);",
      "async function main() {",
      '  if (mode === "hang") { await new Promise((r) => setTimeout(r, 5000)); process.exit(0); }',
      '  if (mode === "0") { console.log(JSON.stringify({ kind: "ok", views: 42, impressions: 100, ctr_pct: 5.5, avg_view_sec: 61 })); process.exit(0); }',
      '  if (mode === "no-views") { console.log(JSON.stringify({ kind: "no-views" })); process.exit(0); }',
      '  if (mode === "2") { console.error("blocked: verify it\'s you"); process.exit(2); }',
      '  if (mode === "3") { console.error("boom: page crashed"); process.exit(3); }',
      '  if (mode === "broken") { console.log("{not json"); process.exit(0); }',
      '  process.exit(1);',
      "}",
      "main();",
    ].join("\n") + "\n",
  );
  return path;
}

/** A fake script that echoes back the `--profile`/`--video` argv it was invoked with, as the `reason` of
 * an `error` outcome, so a test can assert the collector's spawn arguments. */
function argvEchoScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "argv-echo-"));
  const path = join(dir, "collect-stats.mjs");
  writeFileSync(
    path,
    [
      "const arg = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };",
      "console.error(JSON.stringify({ profile: arg('--profile'), video: arg('--video') }));",
      "process.exit(3);",
    ].join("\n") + "\n",
  );
  return path;
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

describe("PlaywrightStatsCollector.collect (spawning a fake collect-stats.mjs)", () => {
  it("exit 0 with ok JSON -> the parsed StatsOutcome", async () => {
    const collector = new PlaywrightStatsCollector({ script: fakeScript() });
    await withEnv({ FAKE_STATS_EXIT: "0" }, async () => {
      const outcome = await collector.collect({ channel: channel(), video_id: "vid-1", timeout_seconds: 10 });
      expect(outcome).toEqual({ kind: "ok", views: 42, impressions: 100, ctr_pct: 5.5, avg_view_sec: 61 });
    });
  });

  it("exit 0 with no-views JSON -> no-views", async () => {
    const collector = new PlaywrightStatsCollector({ script: fakeScript() });
    await withEnv({ FAKE_STATS_EXIT: "no-views" }, async () => {
      const outcome = await collector.collect({ channel: channel(), video_id: "vid-1", timeout_seconds: 10 });
      expect(outcome).toEqual({ kind: "no-views" });
    });
  });

  it("exit 2 -> blocked", async () => {
    const collector = new PlaywrightStatsCollector({ script: fakeScript() });
    await withEnv({ FAKE_STATS_EXIT: "2" }, async () => {
      const outcome = await collector.collect({ channel: channel(), video_id: "vid-1", timeout_seconds: 10 });
      expect(outcome).toEqual({ kind: "blocked", reason: expect.any(String) });
    });
  });

  it("exit 3 -> error", async () => {
    const collector = new PlaywrightStatsCollector({ script: fakeScript() });
    await withEnv({ FAKE_STATS_EXIT: "3" }, async () => {
      const outcome = await collector.collect({ channel: channel(), video_id: "vid-1", timeout_seconds: 10 });
      expect(outcome).toEqual({ kind: "error", reason: expect.any(String) });
    });
  });

  it("exit 0 with malformed JSON -> error, never throws", async () => {
    const collector = new PlaywrightStatsCollector({ script: fakeScript() });
    await withEnv({ FAKE_STATS_EXIT: "broken" }, async () => {
      const outcome = await collector.collect({ channel: channel(), video_id: "vid-1", timeout_seconds: 10 });
      expect(outcome.kind).toBe("error");
    });
  });

  it("a 1-second timeout against a hanging script (sleeps ~5s) -> error, well before the script's own sleep", async () => {
    const collector = new PlaywrightStatsCollector({ script: fakeScript() });
    await withEnv({ FAKE_STATS_EXIT: "hang" }, async () => {
      const startedAt = Date.now();
      const outcome = await collector.collect({ channel: channel(), video_id: "vid-1", timeout_seconds: 1 });
      const elapsedMs = Date.now() - startedAt;
      expect(outcome).toEqual({ kind: "error", reason: expect.any(String) });
      expect(elapsedMs).toBeLessThan(4000);
    });
  });

  it("a repo_dir/script combo that fails to spawn (ENOENT) -> error, without crashing the process", async () => {
    const collector = new PlaywrightStatsCollector({ script: join(mkdtempSync(join(tmpdir(), "gone-")), "missing.mjs") });
    const outcome = await collector.collect({ channel: channel(), video_id: "vid-1", timeout_seconds: 10 });
    expect(outcome.kind).toBe("error");
  });

  it("passes every stdout/stderr line through redact before it reaches log()", async () => {
    const seen: string[] = [];
    const collector = new PlaywrightStatsCollector({ script: argvEchoScript(), redact: (s) => s.replaceAll("legacy-channel-a", "[REDACTED]") });
    await collector.collect({ channel: channel(), video_id: "vid-1", timeout_seconds: 10, log: (line) => seen.push(line) });
    expect(seen.join("\n")).not.toContain("legacy-channel-a");
    expect(seen.join("\n")).toContain("[REDACTED]");
  });

  it("never passes HARNESS_SECRET_* to the child, but keeps the rest of the environment", async () => {
    const seen: string[] = [];
    const collector = new PlaywrightStatsCollector({ script: fakeScript() });
    await withEnv({ FAKE_STATS_EXIT: "0", HARNESS_SECRET_YOUTUBE_C1_EMAIL: "owner@example.com" }, async () => {
      const outcome = await collector.collect({ channel: channel(), video_id: "vid-1", timeout_seconds: 10, log: (line) => seen.push(line) });
      expect(outcome.kind, seen.join("\n")).toBe("ok");
      const envLine = seen.find((l) => l.includes("[collect] env="));
      expect(envLine, seen.join("\n")).toBe("[collect] env=");
    });
  });

  it("invokes the script with --profile <repo>/.upload-profile and --video <video_id>", async () => {
    const collector = new PlaywrightStatsCollector({ script: argvEchoScript() });
    const outcome = await collector.collect({ channel: channel("D:/legacy-channel-a"), video_id: "vid-42", timeout_seconds: 10 });
    expect(outcome.kind).toBe("error");
    const reason = (outcome as { reason: string }).reason;
    const parsed = JSON.parse(reason) as { profile: string; video: string };
    expect(parsed.profile).toBe(join("D:/legacy-channel-a", ".upload-profile"));
    expect(parsed.video).toBe("vid-42");
  });
});

describe("PlaywrightStatsCollector.collect (statsFile test hook)", () => {
  it("statsFile set -> answers from the file, keyed by video_id, without spawning anything", async () => {
    const filePath = join(mkdtempSync(join(tmpdir(), "stats-file-")), "stats.json");
    writeFileSync(filePath, JSON.stringify({ "vid-1": { kind: "ok", views: 7 } }));
    // Point `script` at a path that does not exist: if the collector still tried to spawn it, the
    // outcome would be an ENOENT error rather than the file's {kind:"ok",views:7}.
    const collector = new PlaywrightStatsCollector({ statsFile: filePath, script: join(mkdtempSync(join(tmpdir(), "gone-")), "missing.mjs") });
    const outcome = await collector.collect({ channel: channel(), video_id: "vid-1", timeout_seconds: 10 });
    expect(outcome).toEqual({ kind: "ok", views: 7 });
  });

  it("statsFile set -> a video_id missing from the file is an error naming the video_id", async () => {
    const filePath = join(mkdtempSync(join(tmpdir(), "stats-file-")), "stats.json");
    writeFileSync(filePath, JSON.stringify({}));
    const collector = new PlaywrightStatsCollector({ statsFile: filePath });
    const outcome = await collector.collect({ channel: channel(), video_id: "vid-9", timeout_seconds: 10 });
    expect(outcome).toEqual({ kind: "error", reason: "no fake outcome for vid-9" });
  });

  it("statsFile is read fresh on every call (a test can change the scenario mid-run)", async () => {
    const filePath = join(mkdtempSync(join(tmpdir(), "stats-file-")), "stats.json");
    writeFileSync(filePath, JSON.stringify({ "vid-1": { kind: "ok", views: 1 } }));
    const collector = new PlaywrightStatsCollector({ statsFile: filePath });
    const first = await collector.collect({ channel: channel(), video_id: "vid-1", timeout_seconds: 10 });
    expect(first).toEqual({ kind: "ok", views: 1 });
    writeFileSync(filePath, JSON.stringify({ "vid-1": { kind: "no-views" } }));
    const second = await collector.collect({ channel: channel(), video_id: "vid-1", timeout_seconds: 10 });
    expect(second).toEqual({ kind: "no-views" });
  });

  it("HARNESS_FAKE_STATS_FILE env var sets statsFile the same way the constructor option does", async () => {
    const filePath = join(mkdtempSync(join(tmpdir(), "stats-file-")), "stats.json");
    writeFileSync(filePath, JSON.stringify({ "vid-1": { kind: "ok", views: 3 } }));
    await withEnv({ HARNESS_FAKE_STATS_FILE: filePath }, async () => {
      const collector = new PlaywrightStatsCollector({});
      const outcome = await collector.collect({ channel: channel(), video_id: "vid-1", timeout_seconds: 10 });
      expect(outcome).toEqual({ kind: "ok", views: 3 });
    });
  });
});
