import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PublisherChannel } from "@harness/contracts";
import { FakeStatsCollector } from "../src/index.js";

function channel(): PublisherChannel {
  return { channel_id: "channel-a", repo_dir: "D:/legacy-channel-a", legacy_project_id: "project-01", expected_channel_id: "UCfake000000000000000001" };
}

function tempFile(data: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-stats-"));
  const path = join(dir, "stats.json");
  writeFileSync(path, JSON.stringify(data));
  return path;
}

describe("FakeStatsCollector", () => {
  it("defaults to a fixed ok outcome when nothing else is configured", async () => {
    const collector = new FakeStatsCollector();
    const outcome = await collector.collect({ channel: channel(), video_id: "vid-1", timeout_seconds: 10 });
    expect(outcome).toEqual({ kind: "ok", views: 100, impressions: 500, ctr_pct: 5, avg_view_sec: 60 });
  });

  it("a custom `default` overrides the fixed default", async () => {
    const collector = new FakeStatsCollector({ default: { kind: "no-views" } });
    const outcome = await collector.collect({ channel: channel(), video_id: "vid-1", timeout_seconds: 10 });
    expect(outcome).toEqual({ kind: "no-views" });
  });

  it("outcomes[video_id] wins over both the file and the default", async () => {
    const file = tempFile({ "vid-1": { kind: "no-views" } });
    const collector = new FakeStatsCollector({
      outcomes: { "vid-1": { kind: "ok", views: 1 } },
      file,
      default: { kind: "blocked", reason: "should not be used" },
    });
    const outcome = await collector.collect({ channel: channel(), video_id: "vid-1", timeout_seconds: 10 });
    expect(outcome).toEqual({ kind: "ok", views: 1 });
  });

  it("falls back to file[video_id] when outcomes has no entry", async () => {
    const file = tempFile({ "vid-2": { kind: "blocked", reason: "verify it's you" } });
    const collector = new FakeStatsCollector({ file, default: { kind: "no-views" } });
    const outcome = await collector.collect({ channel: channel(), video_id: "vid-2", timeout_seconds: 10 });
    expect(outcome).toEqual({ kind: "blocked", reason: "verify it's you" });
  });

  it("falls back to default when neither outcomes nor the file has an entry", async () => {
    const file = tempFile({ "vid-other": { kind: "no-views" } });
    const collector = new FakeStatsCollector({ file, default: { kind: "error", reason: "fallback" } });
    const outcome = await collector.collect({ channel: channel(), video_id: "vid-2", timeout_seconds: 10 });
    expect(outcome).toEqual({ kind: "error", reason: "fallback" });
  });

  it("the file is re-read on every call (a test can change the scenario mid-run)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-stats-"));
    const path = join(dir, "stats.json");
    writeFileSync(path, JSON.stringify({ "vid-1": { kind: "ok", views: 1 } }));
    const collector = new FakeStatsCollector({ file: path });
    const first = await collector.collect({ channel: channel(), video_id: "vid-1", timeout_seconds: 10 });
    expect(first).toEqual({ kind: "ok", views: 1 });
    writeFileSync(path, JSON.stringify({ "vid-1": { kind: "no-views" } }));
    const second = await collector.collect({ channel: channel(), video_id: "vid-1", timeout_seconds: 10 });
    expect(second).toEqual({ kind: "no-views" });
  });

  it("records every video_id passed to collect, in order", async () => {
    const collector = new FakeStatsCollector();
    await collector.collect({ channel: channel(), video_id: "vid-a", timeout_seconds: 10 });
    await collector.collect({ channel: channel(), video_id: "vid-b", timeout_seconds: 10 });
    await collector.collect({ channel: channel(), video_id: "vid-a", timeout_seconds: 10 });
    expect(collector.calls).toEqual(["vid-a", "vid-b", "vid-a"]);
  });

  it("a missing/corrupt file falls back to the default instead of throwing", async () => {
    const collector = new FakeStatsCollector({ file: join(mkdtempSync(join(tmpdir(), "fake-stats-")), "missing.json"), default: { kind: "no-views" } });
    const outcome = await collector.collect({ channel: channel(), video_id: "vid-1", timeout_seconds: 10 });
    expect(outcome).toEqual({ kind: "no-views" });
  });

  it("name is fake-stats", () => {
    expect(new FakeStatsCollector().name).toBe("fake-stats");
  });
});
