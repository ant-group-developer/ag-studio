import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { newId, type StageRequest } from "@harness/contracts";
import { CliAgentRuntime } from "@harness/adapter-agent-cli";
import { STUDIO_TYPES } from "@harness/core";
import { StudioAgentExecutor } from "../src/studio-agent-executor.js";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const FAKE = join(ROOT, "fixtures", "fake-studio-claude.mjs");
const silent = { info() {}, warn() {}, error() {} };
const wall = { now: () => new Date().toISOString() };

const brief = {
  schema_version: "studio.brief/v1", production_id: "prod-1", run_id: "run_1", owner_user_id: "u1", title: "Phở", topic: "Phở sáng Hà Nội",
  folder_ids: ["f1"], target_seconds: 30, aspect: "16:9", canvas: { width: 1280, height: 720 }, fps: 25, language: "vi",
  voice: { reference: null, reference_text: null, speed: 1 }, music: null,
};
const catalog = {
  schema_version: "studio.catalog/v1", production_id: "prod-1", folder_ids: ["f1"], total_available: 14, truncated: false,
  segments: Array.from({ length: 14 }, (_, i) => ({
    id: `seg-${i + 1}`, asset_id: "a1", start_ms: i * 8000, end_ms: (i + 1) * 8000, duration_s: 8, caption_vi: `cảnh phở ${i + 1}`, caption_en: "", tags: ["pho"],
    keywords_vi: [], subjects: [], actions: [], shot_size: "wide", camera_motion: null, time_of_day: null, setting: null, people_count: null,
    orientation: i === 13 ? "portrait" : "landscape", quality: 4, usable: i !== 12, approved: false,
  })),
};

function stage(skill: string, outType: string, outName: string, inputs: Record<string, unknown>, mode = ""): { req: StageRequest; ex: StudioAgentExecutor } {
  const ws = mkdtempSync(join(tmpdir(), "sae-"));
  mkdirSync(join(ws, "output"));
  const reqInputs = Object.entries(inputs).map(([type, value]) => {
    mkdirSync(join(ws, type), { recursive: true });
    writeFileSync(join(ws, type, `${type}.json`), JSON.stringify(value));
    return { path: `${type}/${type}.json`, type, checksum: `sha256:${"0".repeat(64)}`, size_bytes: 1, kind: "file" as const };
  });
  const req = {
    schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"), project_id: "p", portfolio_id: "pf",
    stage_key: skill, workflow: { id: "ag-studio-production", version: "1.0.0", digest: "sha256:" + "a".repeat(64) }, profile_snapshot: { id: "studio-production", revision: 1 },
    inputs: reqInputs, workspace_uri: ws, stage_config: { __skill: skill, __brief: `Chạy ${skill}` }, options: {}, source_items: [], resources: [],
    expected_outputs: [{ type: outType, mime_type: "application/json", kind: "file", name: outName }],
    limits: { deadline_at: new Date(Date.now() + 60_000).toISOString(), max_cost_usd: 5, max_attempts: 2 }, capabilities: [], fencing_token: 1,
  } as unknown as StageRequest;
  const ex = new StudioAgentExecutor({
    runtimeFor: (jsonSchema) => new CliAgentRuntime({
      runtime: "claude", skillsDir: join(ROOT, "skills"), argv: [process.execPath, FAKE], structured: { jsonSchema },
      baseEnv: { ...process.env, FAKE_STUDIO_MODE: mode },
    }),
    rateLimitBackoffMs: [10],
  });
  return { req, ex };
}

const run = (s: ReturnType<typeof stage>) => s.ex.execute(s.req, { workspaceDir: s.req.workspace_uri, logger: silent, clock: wall });
const out = (s: ReturnType<typeof stage>, name: string) => JSON.parse(readFileSync(join(s.req.workspace_uri, "output", name), "utf8"));

describe("StudioAgentExecutor (real CliAgentRuntime, fake claude CLI)", () => {
  it("treatment: prompt through stdin with inputs inlined, schema passed with --json-schema, valid output written", async () => {
    const s = stage("studio-treatment", STUDIO_TYPES.treatment, "treatment.json", { [STUDIO_TYPES.brief]: brief, [STUDIO_TYPES.catalog]: catalog });
    const r = await run(s);
    expect(r.outcome).toBe("succeeded");
    expect(r.outputs.map((o) => o.path)).toEqual(["output/treatment.json"]);
    expect(out(s, "treatment.json").beats.reduce((a: number, b: { seconds: number }) => a + b.seconds, 0)).toBeCloseTo(30, 3);
    const logs = join(s.req.workspace_uri, "logs");
    const schema = readFileSync(join(logs, "fake-claude-schema-0.json"), "utf8");
    expect(schema).not.toMatch(/minLength|maxLength|"minimum"|"maximum"|"pattern"/);
    const prompt = readFileSync(join(logs, "fake-claude-prompts.log"), "utf8");
    expect(prompt).toContain("# Skill: studio-treatment");
    expect(prompt).toContain("## studio_catalog (studio_catalog.json)");
    expect(prompt).toContain("\"id\":\"seg-1\"");
    expect(prompt).not.toContain("\"camera_motion\""); // empty fields are dropped from the catalog
  });

  it("select-shots: a rejected answer gets one repair round with the problems listed, then passes", async () => {
    const t = { schema_version: "studio.treatment/v1", title: "Phở", logline: "x", beats: [
      { beat_id: "B01", purpose: "a", seconds: 15, visual_idea: "phở", narration_idea: "x" },
      { beat_id: "B02", purpose: "b", seconds: 15, visual_idea: "phở", narration_idea: "y" },
    ] };
    const s = stage("studio-select-shots", STUDIO_TYPES.selection, "selection.json", { [STUDIO_TYPES.brief]: brief, [STUDIO_TYPES.catalog]: catalog, [STUDIO_TYPES.treatment]: t }, "select-bad-once");
    const r = await run(s);
    expect(r.outcome).toBe("succeeded");
    const prompts = readFileSync(join(s.req.workspace_uri, "logs", "fake-claude-prompts.log"), "utf8").split("----- call ");
    expect(prompts.filter(Boolean)).toHaveLength(2);
    expect(prompts[2]).toContain("[unknown_segment]");
    expect(prompts[2]).toContain("[duplicate_segment]");
    const sel = out(s, "selection.json");
    expect(sel.beats[0].picks.every((p: { segment_id: string }) => p.segment_id.startsWith("seg-"))).toBe(true);
  });

  it("select-shots: still wrong after the repair round -> contract failure carrying the problems", async () => {
    const t = { schema_version: "studio.treatment/v1", title: "Phở", logline: "x", beats: [
      { beat_id: "B01", purpose: "a", seconds: 15, visual_idea: "phở", narration_idea: "x" },
      { beat_id: "B02", purpose: "b", seconds: 15, visual_idea: "phở", narration_idea: "y" },
    ] };
    const s = stage("studio-select-shots", STUDIO_TYPES.selection, "selection.json", { [STUDIO_TYPES.brief]: brief, [STUDIO_TYPES.catalog]: catalog, [STUDIO_TYPES.treatment]: t }, "select-bad-always");
    const r = await run(s);
    expect(r.outcome).toBe("failed");
    expect(r.errors[0]!.kind).toBe("contract");
    expect(JSON.stringify(r.errors[0]!.details)).toContain("unknown_segment");
  });

  it("a subscription limit is waited out, not counted as a failed attempt", async () => {
    const s = stage("studio-treatment", STUDIO_TYPES.treatment, "treatment.json", { [STUDIO_TYPES.brief]: brief, [STUDIO_TYPES.catalog]: catalog }, "rate-limit-once");
    const r = await run(s);
    expect(r.outcome).toBe("succeeded");
    expect(readdirSync(join(s.req.workspace_uri, "logs"))).toContain(".rate-limited");
  });
});
