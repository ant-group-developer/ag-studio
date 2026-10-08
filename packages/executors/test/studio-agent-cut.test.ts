/** The shot-cut skills end to end with the fake Claude CLI: files-mode scene selection (with a resumed repair) and the edit plan. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { newId, STUDIO_FILE_SKILLS, type AgentCallTrace, type StageRequest, type StudioSkill } from "@harness/contracts";
import { CliAgentRuntime } from "@harness/adapter-agent-cli";
import { validateEditPlan, validateStudioSurvey } from "@harness/core";
import { StudioAgentExecutor } from "../src/studio-agent-executor.js";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const FAKE = join(ROOT, "fixtures", "fake-studio-claude.mjs");
const silent = { info() {}, warn() {}, error() {} };
const wall = { now: () => new Date().toISOString() };
const SRC = "src_0000000000000000000000000A";

const shots = {
  schema_version: "harness.shots/v2",
  sources: [{ source_id: SRC, index: 0, file_name: "a.mp4", duration_seconds: 30, has_audio: true, shots: [
    { shot_id: "s000-000", in: 0, out: 5 }, { shot_id: "s000-001", in: 5, out: 12 }, { shot_id: "s000-002", in: 12, out: 20 }, { shot_id: "s000-003", in: 20, out: 30 },
  ] }],
};
const sources = { schema_version: "studio.cut-sources/v1", production_id: "p", episode_id: "ep-1", language: "vi", narration: "tts",
  sources: [{ index: 0, asset_id: "a", source_id: SRC, title: "Phố cổ", duration_s: 30, has_speech: null, hints: null }] };

function executor(sessions: string[], calls: { skill?: StudioSkill; resume?: string }[]) {
  return new StudioAgentExecutor({
    runtimeFor: (jsonSchema, skill, onCall, files) => {
      calls.push({ ...(skill ? { skill } : {}), ...(files?.resume ? { resume: files.resume } : {}) });
      const model = "fake";
      return new CliAgentRuntime({
        runtime: "claude", skillsDir: join(ROOT, "skills"), argv: [process.execPath, FAKE],
        ...(skill && STUDIO_FILE_SKILLS.has(skill)
          ? { files: { model, tools: ["Read", "Write", "Glob", "Grep"], ...(files?.resume ? { resume: files.resume } : {}) } }
          : { structured: { jsonSchema, model } }),
        ...(onCall ? { onCall: (t: AgentCallTrace) => onCall(t) } : {}),
      });
    },
    onSession: (_r, id) => { sessions.push(id); },
  });
}

function request(skill: string, outType: string, outName: string, inputs: Record<string, unknown>): StageRequest {
  const ws = mkdtempSync(join(tmpdir(), "sae-cut-"));
  mkdirSync(join(ws, "in", "watch"), { recursive: true });
  writeFileSync(join(ws, "in", "watch", "watch.json"), "{}");
  const files = Object.entries(inputs).map(([type, v]) => {
    writeFileSync(join(ws, "in", `${type}.json`), JSON.stringify(v));
    return { path: `in/${type}.json`, type, checksum: `sha256:${"0".repeat(64)}`, size_bytes: 1, kind: "file" as const };
  });
  return {
    schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"), project_id: "p", portfolio_id: "pf",
    stage_key: skill, workflow: { id: "ag-studio-episode-cut", version: "1.0.0", digest: "sha256:" + "a".repeat(64) }, profile_snapshot: { id: "studio-production", revision: 1 },
    inputs: [...files, { path: "in/watch", type: "watch", checksum: `sha256:${"0".repeat(64)}`, size_bytes: 1, kind: "directory" as const }],
    workspace_uri: ws, stage_config: { __skill: skill, __brief: "Tập Hoa Lư" }, options: {}, source_items: [], resources: [],
    expected_outputs: [{ type: outType, mime_type: "application/json", kind: "file", name: outName }],
    limits: { deadline_at: new Date(Date.now() + 60_000).toISOString(), max_cost_usd: 1, max_attempts: 1 }, capabilities: [], fencing_token: 1,
  } as unknown as StageRequest;
}

describe("shot-cut skills with the fake Claude", () => {
  afterEach(() => { delete process.env.FAKE_STUDIO_MODE; });

  it("scene selection: a file written in files mode; an incomplete one is repaired in the resumed session", async () => {
    process.env.FAKE_STUDIO_MODE = "survey-bad-once";
    const sessions: string[] = [];
    const calls: { skill?: StudioSkill; resume?: string }[] = [];
    const req = request("studio-source-survey", "survey_index", "survey.json", { shots, cut_sources: sources });
    const res = await executor(sessions, calls).execute(req, { workspaceDir: req.workspace_uri, logger: silent, clock: wall });
    expect(res.outcome, JSON.stringify(res.errors)).toBe("succeeded");
    expect(calls.map((c) => c.resume ?? null)).toEqual([null, sessions[0]]);
    expect(sessions).toHaveLength(2);
    const survey = JSON.parse(readFileSync(join(req.workspace_uri, "output", "survey.json"), "utf8"));
    expect(validateStudioSurvey(survey, { shots: shots as never }).ok).toBe(true);
    expect(survey.shots[0]).toMatchObject({ shot_id: "s000-000", usable: false });
  });

  it("edit plan: structured, from the approved selection, passes its check", async () => {
    const survey = { schema_version: "harness.survey-index/v2", shots: shots.sources[0]!.shots.map((x, i) => ({ source_id: SRC, shot_id: x.shot_id, in: x.in, out: x.out, score: 4, tags: [], usable: i !== 0, note: "ok", speech: "ambient" })) };
    const req = request("studio-edit-plan", "studio_edit_plan", "edit-plan.json", {
      survey_index: survey, shots, cut_sources: sources,
      studio_episode: { schema_version: "studio.episode/v1", episode_id: "ep-1", title: "Phố cổ Hoa Lư", target_seconds: 12 },
    });
    const res = await executor([], []).execute(req, { workspaceDir: req.workspace_uri, logger: silent, clock: wall });
    expect(res.outcome, JSON.stringify(res.errors)).toBe("succeeded");
    const plan = JSON.parse(readFileSync(join(req.workspace_uri, "output", "edit-plan.json"), "utf8"));
    expect(validateEditPlan(plan, { survey: survey as never, shots: shots as never }).ok).toBe(true);
    expect(plan.shots.map((x: { shot_id: string }) => x.shot_id)).toEqual(["s000-001", "s000-002", "s000-003"]);
    expect(plan.lines.length).toBeGreaterThan(0);
  });

  it("cut 1.1.0: an edit plan off the style's shot length goes back once (style_shot_length) and follows it", async () => {
    process.env.FAKE_STUDIO_MODE = "edit-plan-ignore-style-once";
    const long = { ...shots, sources: [{ ...shots.sources[0]!, duration_seconds: 60, shots: Array.from({ length: 6 }, (_, i) => ({ shot_id: `s000-00${i}`, in: i * 10, out: i * 10 + 10 })) }] };
    const survey = { schema_version: "harness.survey-index/v2", shots: long.sources[0]!.shots.map((x) => ({ source_id: SRC, shot_id: x.shot_id, in: x.in, out: x.out, score: 4, tags: [], usable: true, note: "ok", speech: "ambient" })) };
    const style = { schema_version: "studio.style/v1", skipped: false, skipped_reason: null, name: "Nhanh", summary: "", references: [], measured: null,
      params: { cut_rhythm: "fast", shot_seconds: { min: 1.5, max: 2.5 }, transitions: ["cut"], opening: { seconds: 5, structure: "" },
        text_overlay: { density: "low", style: "" }, subtitles: "none", voice: "unknown", music: { mood: "", ducking: null }, visual: "", pace_notes: "" },
      do: [], dont: [], evidence: [] };
    const req = request("studio-edit-plan", "studio_edit_plan", "edit-plan.json", {
      survey_index: survey, shots: long, cut_sources: sources, studio_style: style,
      studio_episode: { schema_version: "studio.episode/v1", episode_id: "ep-1", title: "Phố cổ", target_seconds: 40 },
    });
    const res = await executor([], []).execute(req, { workspaceDir: req.workspace_uri, logger: silent, clock: wall });
    expect(res.outcome, JSON.stringify(res.errors)).toBe("succeeded");
    const prompts = readFileSync(join(req.workspace_uri, "logs", "fake-claude-prompts.log"), "utf8");
    expect(prompts).toContain("## studio_style (studio_style.json)");
    // the repair round: what the check refused
    expect(prompts.split("----- call ").length - 1).toBe(2);
    expect(prompts).toContain("[style_shot_length]");
    const plan = JSON.parse(readFileSync(join(req.workspace_uri, "output", "edit-plan.json"), "utf8"));
    expect(plan.shots.every((x: { in: number; out: number }) => x.out - x.in === 2)).toBe(true);
  });

  it("the style stays out of the scene selection's prompt", async () => {
    const req = request("studio-source-survey", "survey_index", "survey.json", { shots, cut_sources: sources, studio_style: { schema_version: "studio.style/v1" } });
    const res = await executor([], []).execute(req, { workspaceDir: req.workspace_uri, logger: silent, clock: wall });
    expect(res.outcome, JSON.stringify(res.errors)).toBe("succeeded");
    expect(readFileSync(join(req.workspace_uri, "logs", "fake-claude-prompts.log"), "utf8")).not.toContain("studio_style");
  });
});
