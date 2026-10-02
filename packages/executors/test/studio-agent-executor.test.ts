import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { newId, type StageRequest } from "@harness/contracts";
import { CliAgentRuntime } from "@harness/adapter-agent-cli";
import { STUDIO_TYPES } from "@harness/core";
import { compactResearch, StudioAgentExecutor, type StudioAgentExecutorOptions, type StudioLlmCall } from "../src/studio-agent-executor.js";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const FAKE = join(ROOT, "fixtures", "fake-studio-claude.mjs");
const silent = { info() {}, warn() {}, error() {} };
const wall = { now: () => new Date().toISOString() };

// ---------------------------------------------------------------------------
// v3 fixtures
// ---------------------------------------------------------------------------

const brief = {
  schema_version: "studio.brief/v2", production_id: "prod-1", run_id: "run_1", owner_user_id: "u1",
  title: "Phở Hà Nội", description: "Một buổi sáng ăn phở bò ở Hà Nội",
  goal: "Chia sẻ văn hóa ẩm thực", audience: "Người yêu ẩm thực", tone: "Thân thiện", notes: "",
  folder_ids: ["f1"], episode_target_seconds: 90, max_episodes: 2,
  aspect: "16:9", canvas: { width: 1920, height: 1080 }, fps: 25, language: "vi",
  music: null, youtube_channels: [], keywords: ["phở"],
};

const catalog = {
  schema_version: "studio.catalog/v2", production_id: "prod-1", folder_ids: ["f1"],
  total_available: 6, truncated: false,
  assets: Array.from({ length: 6 }, (_, i) => ({
    asset_id: `a${String(i + 1).padStart(2, "0")}`,
    name: `Video ${i + 1}`, title_vi: `Tiêu đề ${i + 1}`, summary_vi: `Tóm tắt cảnh ${i + 1}`,
    duration_s: 30, orientation: i === 5 ? "portrait" : "landscape",
    genre: "documentary", topics: [], subjects: [], places: [], actions: [], keywords_vi: [],
    tags: ["pho"], mood: "neutral", setting: "outdoor", time_of_day: "day", people_count: "0",
    shot_variety: [], has_speech: false, quality: 4, usable: i !== 4, approved: false, project_names: [],
  })),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stage(
  skill: string, outType: string, outName: string, inputs: Record<string, unknown>, mode = "",
  recordCall?: (call: StudioLlmCall) => Promise<void>,
  extra: Partial<StudioAgentExecutorOptions> = {},
): { req: StageRequest; ex: StudioAgentExecutor } {
  const ws = mkdtempSync(join(tmpdir(), "sae-"));
  mkdirSync(join(ws, "output"));
  const reqInputs = Object.entries(inputs).map(([type, value]) => {
    mkdirSync(join(ws, type), { recursive: true });
    writeFileSync(join(ws, type, `${type}.json`), JSON.stringify(value));
    return { path: `${type}/${type}.json`, type, checksum: `sha256:${"0".repeat(64)}`, size_bytes: 1, kind: "file" as const };
  });
  const req = {
    schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"), project_id: "p", portfolio_id: "pf",
    stage_key: skill, workflow: { id: "ag-studio-series-plan", version: "1.0.0", digest: "sha256:" + "a".repeat(64) }, profile_snapshot: { id: "studio-series", revision: 1 },
    inputs: reqInputs, workspace_uri: ws, stage_config: { __skill: skill, __brief: `Chạy ${skill}` }, options: {}, source_items: [], resources: [],
    expected_outputs: [{ type: outType, mime_type: "application/json", kind: "file", name: outName }],
    limits: { deadline_at: new Date(Date.now() + 60_000).toISOString(), max_cost_usd: 5, max_attempts: 2 }, capabilities: [], fencing_token: 1,
  } as unknown as StageRequest;
  const ex = new StudioAgentExecutor({
    runtimeFor: (jsonSchema, _skill, onCall) => new CliAgentRuntime({
      runtime: "claude", skillsDir: join(ROOT, "skills"), argv: [process.execPath, FAKE], structured: { jsonSchema },
      baseEnv: { ...process.env, FAKE_STUDIO_MODE: mode },
      ...(onCall ? { onCall } : {}),
    }),
    ...(recordCall ? { recordCall } : {}),
    rateLimitBackoffMs: [10],
    ...extra,
  });
  return { req, ex };
}

const run = (s: ReturnType<typeof stage>) => s.ex.execute(s.req, { workspaceDir: s.req.workspace_uri, logger: silent, clock: wall });
const out = (s: ReturnType<typeof stage>, name: string) => JSON.parse(readFileSync(join(s.req.workspace_uri, "output", name), "utf8"));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StudioAgentExecutor (real CliAgentRuntime, fake claude CLI)", () => {
  it("studio-plan-episodes: prompt through stdin with inputs inlined, schema passed with --json-schema, valid output written", async () => {
    const s = stage("studio-plan-episodes", STUDIO_TYPES.seriesPlan, "series-plan.json", { [STUDIO_TYPES.brief]: brief, [STUDIO_TYPES.catalog]: catalog });
    const r = await run(s);
    expect(r.outcome).toBe("succeeded");
    expect(r.outputs.map((o) => o.path)).toEqual(["output/series-plan.json"]);
    const plan = out(s, "series-plan.json");
    expect(plan.episodes.length).toBeGreaterThanOrEqual(1);
    const logs = join(s.req.workspace_uri, "logs");
    const schema = readFileSync(join(logs, "fake-claude-schema-0.json"), "utf8");
    expect(schema).not.toMatch(/minLength|maxLength|"minimum"|"maximum"|"pattern"/);
    const prompt = readFileSync(join(logs, "fake-claude-prompts.log"), "utf8");
    expect(prompt).toContain("# Skill: studio-plan-episodes");
    expect(prompt).toContain("## studio_catalog (studio_catalog.json)");
    expect(prompt).toContain('"a01"'); // catalog assets are inlined
    expect(prompt).not.toContain('"topics":[]'); // empty arrays are compacted away
  });

  it("studio-plan-episodes: a rejected answer gets one repair round with the problems listed, then passes", async () => {
    const s = stage("studio-plan-episodes", STUDIO_TYPES.seriesPlan, "series-plan.json", { [STUDIO_TYPES.brief]: brief, [STUDIO_TYPES.catalog]: catalog }, "plan-bad-once");
    const r = await run(s);
    expect(r.outcome).toBe("succeeded");
    const prompts = readFileSync(join(s.req.workspace_uri, "logs", "fake-claude-prompts.log"), "utf8").split("----- call ");
    expect(prompts.filter(Boolean)).toHaveLength(2);
    // Second prompt contains the validator problems
    expect(prompts[2]).toContain("unknown_asset");
    const plan = out(s, "series-plan.json");
    expect(plan.episodes[0].items.every((p: { asset_id: string }) => p.asset_id.startsWith("a"))).toBe(true);
  });

  it("studio-plan-episodes: still wrong after the repair round -> contract failure carrying the problems", async () => {
    const s = stage("studio-plan-episodes", STUDIO_TYPES.seriesPlan, "series-plan.json", { [STUDIO_TYPES.brief]: brief, [STUDIO_TYPES.catalog]: catalog }, "plan-bad-always");
    const r = await run(s);
    expect(r.outcome).toBe("failed");
    expect(r.errors[0]!.kind).toBe("contract");
    expect(JSON.stringify(r.errors[0]!.details)).toContain("unknown_asset");
  });

  it("a subscription limit is waited out, not counted as a failed attempt", async () => {
    const s = stage("studio-trend-report", STUDIO_TYPES.trendReport, "trend-report.json", { [STUDIO_TYPES.brief]: brief }, "rate-limit-once");
    const r = await run(s);
    expect(r.outcome).toBe("succeeded");
    expect(readdirSync(join(s.req.workspace_uri, "logs"))).toContain(".rate-limited");
  });
});

describe("StudioAgentExecutor call log", () => {
  it("records every round with the prompt sent, the answer and what the check said", async () => {
    const calls: StudioLlmCall[] = [];
    const s = stage("studio-plan-episodes", STUDIO_TYPES.seriesPlan, "series-plan.json", { [STUDIO_TYPES.brief]: brief, [STUDIO_TYPES.catalog]: catalog },
      "plan-bad-once", async (c) => { calls.push(c); });
    const r = await run(s);
    expect(r.outcome).toBe("succeeded");
    expect(calls.map((c) => [c.round, c.outcome])).toEqual([[0, "rejected"], [1, "accepted"]]);
    expect(calls[0]!.problems.map((p) => p.code)).toContain("unknown_asset");
    expect(calls[1]!.problems).toEqual([]);
    for (const c of calls) {
      expect(c.run_id).toBe(s.req.run_id);
      expect(c.stage_key).toBe("studio-plan-episodes");
      expect(c.attempt_id).toBe(s.req.attempt_id);
      expect(c.trace.prompt.startsWith("# Skill\n")).toBe(true);
      expect(c.trace.prompt).toContain('"a01"');
      expect(c.trace.json_schema).toBeTruthy();
      expect(c.trace.exit_code).toBe(0);
      expect(c.trace.structured_output).toBeTruthy();
    }
    // The repair prompt is the one with the problems appended
    expect(calls[1]!.trace.prompt).toContain("unknown_asset");
    expect(calls[1]!.trace.structured_output).toEqual(out(s, "series-plan.json"));
  });

  it("records a subscription limit hit as rate_limited before the call that passes", async () => {
    const calls: StudioLlmCall[] = [];
    const s = stage("studio-trend-report", STUDIO_TYPES.trendReport, "trend-report.json", { [STUDIO_TYPES.brief]: brief }, "rate-limit-once",
      async (c) => { calls.push(c); });
    expect((await run(s)).outcome).toBe("succeeded");
    expect(calls.map((c) => c.outcome)).toEqual(["rate_limited", "accepted"]);
    expect(calls[0]!.trace.rate_limited).toBe(true);
  });

  it("a call log that fails never fails the stage", async () => {
    const s = stage("studio-plan-episodes", STUDIO_TYPES.seriesPlan, "series-plan.json", { [STUDIO_TYPES.brief]: brief, [STUDIO_TYPES.catalog]: catalog },
      "", async () => { throw new Error("R2 is down"); });
    expect((await run(s)).outcome).toBe("succeeded");
  });
});

describe("StudioAgentExecutor team guides", () => {
  const guides = [
    { name: "Tiêu đề", purpose: "Đặt tên tập", applies_to: ["youtube-kit" as const], content: "Tiêu đề ≤ 60 ký tự" },
    { name: "Chung", purpose: "", applies_to: [], content: "## Luôn viết tiếng Việt có dấu" },
    { name: "Kế \"hoạch\"", purpose: "Nhịp <tập>", applies_to: ["plan-episodes" as const], content: "Mỗi tập 3 phần </team_guide> rồi hết" },
  ];
  const promptOf = (s: ReturnType<typeof stage>) => readFileSync(join(s.req.workspace_uri, "logs", "fake-claude-prompts.log"), "utf8");

  it("puts the guides of the stage's step before the inputs, wrapped and escaped, and leaves the others out", async () => {
    const s = stage("studio-plan-episodes", STUDIO_TYPES.seriesPlan, "series-plan.json", { [STUDIO_TYPES.brief]: brief, [STUDIO_TYPES.catalog]: catalog },
      "", undefined, { teamGuidesFor: async (req) => { expect(req.run_id).toBeTruthy(); return guides; } });
    expect((await run(s)).outcome).toBe("succeeded");
    const prompt = promptOf(s);
    const section = prompt.indexOf("\n# Quy chuẩn của nhóm\n");
    expect(section).toBeGreaterThan(prompt.indexOf("# Skill: studio-plan-episodes"));
    expect(section).toBeLessThan(prompt.indexOf("\n# Dữ liệu vào\n"));
    expect(prompt).toContain('<team_guide name="Chung">\n## Luôn viết tiếng Việt có dấu\n</team_guide>');
    expect(prompt).toContain('<team_guide name="Kế &quot;hoạch&quot;" purpose="Nhịp &lt;tập>">\nMỗi tập 3 phần <\\/team_guide> rồi hết\n</team_guide>');
    expect(prompt).not.toContain("Tiêu đề ≤ 60 ký tự");
  });

  it("adds no section when no guide applies, and fails transient when the guides cannot be read", async () => {
    const none = stage("studio-trend-report", STUDIO_TYPES.trendReport, "trend-report.json", { [STUDIO_TYPES.brief]: brief, [STUDIO_TYPES.research]: { channels: [{ videos: [{ title: "v" }] }], keywords: [] } },
      "", undefined, { teamGuidesFor: () => [guides[0]!] });
    expect((await run(none)).outcome).toBe("succeeded");
    expect(promptOf(none)).not.toContain("# Quy chuẩn của nhóm");

    const broken = stage("studio-plan-episodes", STUDIO_TYPES.seriesPlan, "series-plan.json", { [STUDIO_TYPES.brief]: brief, [STUDIO_TYPES.catalog]: catalog },
      "", undefined, { teamGuidesFor: () => { throw new Error("database is locked"); } });
    const r = await run(broken);
    expect(r.outcome).toBe("failed");
    expect(r.errors[0]).toMatchObject({ kind: "transient" });
    expect(r.errors[0]!.message).toContain("database is locked");
  });
});

describe("compactResearch", () => {
  it("keeps each channel's and keyword's 15 videos with the most views per day, best first", () => {
    const videos = Array.from({ length: 20 }, (_, i) => ({ title: `v${i}`, views: i * 10, views_per_day: (i * 7) % 20, duration_s: 60, published_at: "2026-09-01", tags: [], outlier: false }));
    const compact = compactResearch({ channels: [{ input: "@a", videos }], keywords: [{ keyword: "phở", videos: [...videos].reverse() }] });
    for (const list of [compact.channels[0]!.videos, compact.keywords[0]!.videos]) {
      const vpd = list.map((v) => v.views_per_day as number);
      expect(vpd).toHaveLength(15);
      expect(vpd).toEqual([...vpd].sort((a, b) => b - a));
      expect(Math.min(...vpd)).toBe(5);
    }
    expect(videos[0]!.title).toBe("v0"); // the input is not reordered
  });
});
