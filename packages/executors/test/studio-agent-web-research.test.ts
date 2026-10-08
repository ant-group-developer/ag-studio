/** The web research of plan 3.2.0 through the real runtime and the fake Claude CLI. */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { newId, type StageRequest } from "@harness/contracts";
import { CliAgentRuntime } from "@harness/adapter-agent-cli";
import { STUDIO_TYPES } from "@harness/core";
import { StudioAgentExecutor, type StudioLlmCall } from "../src/studio-agent-executor.js";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const FAKE = join(ROOT, "fixtures", "fake-studio-claude.mjs");
const silent = { info() {}, warn() {}, error() {} };
const wall = { now: () => new Date().toISOString() };

const seed = {
  schema_version: "studio.seed/v1", production_id: "prod-1", run_id: "run_1", owner_user_id: "u1", title: "Ninh Bình chậm", folder_ids: ["f1"],
  channels: [{ url: "@meitime", role: "reference" }, { url: "@mine", role: "own" }], keywords: ["ninh bình vlog"],
  aspect: "16:9", canvas: { width: 1920, height: 1080 }, fps: 25, language: "vi", music: null,
  hints: { description: "", goal: "", audience: "", tone: "", notes: "", episode_target_seconds: null, max_episodes: null },
};
const video = { video_id: "U_17EqTHUIo", channel_id: "UC1", channel_title: "Mine", title: "x", published_at: "2026-01-01T00:00:00Z", duration_s: 600, views: 1, likes: null, comments: null, tags: [], views_per_day: 1, outlier: false };
const research = (over: Record<string, unknown>) => ({
  schema_version: "studio.research/v1", production_id: "prod-1", fetched_at: "2026-10-08T00:00:00Z", quota_units: 3, skipped_reason: null,
  channels: [], keywords: [], insights: { top_title_terms: [], top_tags: [], duration_buckets: [], frequent_channels: [] }, ...over,
});
const channel = (input: string, role: string, error: string | null) => ({ input, role, channel_id: error ? null : "UC1", title: null, subscribers: null, error, videos: error ? [] : [video], stats: null });

function stage(researchApi: unknown, mode = "", recordCall?: (c: StudioLlmCall) => Promise<void>) {
  const ws = mkdtempSync(join(tmpdir(), "webres-"));
  mkdirSync(join(ws, "output"));
  const inputs = Object.entries({ [STUDIO_TYPES.seed]: seed, [STUDIO_TYPES.researchApi]: researchApi }).map(([type, value]) => {
    mkdirSync(join(ws, type), { recursive: true });
    writeFileSync(join(ws, type, `${type}.json`), JSON.stringify(value));
    return { path: `${type}/${type}.json`, type, checksum: `sha256:${"0".repeat(64)}`, size_bytes: 1, kind: "file" as const };
  });
  const req = {
    schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"), project_id: "p", portfolio_id: "pf",
    stage_key: "research-web", workflow: { id: "ag-studio-series-plan", version: "3.2.0", digest: "sha256:" + "a".repeat(64) }, profile_snapshot: { id: "studio-production", revision: 1 },
    inputs, workspace_uri: ws, stage_config: { __skill: "studio-web-research", __brief: "Tìm trên web" }, options: {}, source_items: [], resources: [],
    expected_outputs: [{ type: STUDIO_TYPES.webFinds, mime_type: "application/json", kind: "file", name: "web-finds.json" }],
    limits: { deadline_at: new Date(Date.now() + 60_000).toISOString(), max_cost_usd: 5, max_attempts: 2 }, capabilities: [], fencing_token: 1,
  } as unknown as StageRequest;
  const ex = new StudioAgentExecutor({
    runtimeFor: (jsonSchema, _skill, onCall) => new CliAgentRuntime({
      runtime: "claude", skillsDir: join(ROOT, "skills"), argv: [process.execPath, FAKE], structured: { jsonSchema, tools: ["WebSearch", "WebFetch"] },
      baseEnv: { ...process.env, FAKE_STUDIO_MODE: mode }, ...(onCall ? { onCall } : {}),
    }),
    ...(recordCall ? { recordCall } : {}),
    rateLimitBackoffMs: [10],
  });
  return { req, ex, ws };
}
const run = (s: ReturnType<typeof stage>) => s.ex.execute(s.req, { workspaceDir: s.ws, logger: silent, clock: wall });
const out = (s: ReturnType<typeof stage>) => JSON.parse(readFileSync(join(s.ws, "output", "web-finds.json"), "utf8"));

describe("studio-web-research", () => {
  it("nothing missing: skipped without calling Claude", async () => {
    const calls: StudioLlmCall[] = [];
    const s = stage(research({ channels: [channel("@meitime", "reference", null), channel("@mine", "own", null)], keywords: [{ keyword: "ninh bình vlog", error: null, videos: [video] }] }), "", async (c) => { calls.push(c); });
    expect((await run(s)).outcome).toBe("succeeded");
    expect(out(s)).toMatchObject({ skipped: true, channels: [], keywords: [] });
    expect(calls).toHaveLength(0);
  });

  it("no API key: Claude is asked only for the gaps, and answers with YouTube links for them", async () => {
    const s = stage(research({ skipped_reason: "Chưa cấu hình YOUTUBE_API_KEY cho Studio worker", fetched_at: null }));
    const res = await run(s);
    expect(res.outcome, JSON.stringify(res.errors)).toBe("succeeded");
    const finds = out(s);
    expect(finds.skipped).toBe(false);
    expect(finds.channels.map((c: { input: string }) => c.input)).toEqual(["@meitime", "@mine"]);
    expect(finds.keywords[0].videos.length).toBeGreaterThan(0);
    const prompt = readFileSync(join(s.ws, "logs", "fake-claude-prompts.log"), "utf8");
    expect(prompt).toContain("## research_gaps");
    expect(prompt).not.toContain("## studio_research_api");
  });

  it("one channel refused: only that one is asked; a link that is not YouTube goes back for one repair", async () => {
    const s = stage(research({ channels: [channel("@meitime", "reference", "quotaExceeded"), channel("@mine", "own", null)], keywords: [{ keyword: "ninh bình vlog", error: null, videos: [video] }] }), "web-research-bad-once");
    const res = await run(s);
    expect(res.outcome, JSON.stringify(res.errors)).toBe("succeeded");
    const finds = out(s);
    expect(finds.channels.map((c: { input: string }) => c.input)).toEqual(["@meitime"]);
    expect(finds.keywords).toEqual([]);
  });
});
