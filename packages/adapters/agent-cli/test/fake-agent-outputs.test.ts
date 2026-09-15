// Runs `fixtures/fake-agent-cli.mjs` directly (spawned in a hand-built workspace, the same way
// packages/script-sdk/test/sdk.test.ts and tests/integration/studio-wrappers.test.ts exercise their
// scripts) against sub-project 4's five studio skills, and validates the written output against the real
// contract schemas. Spawned directly rather than through CliAgentRuntime: that runtime filters the child
// process env down to a small per-CLI allowlist (`RUNTIME_COMMANDS[...].env_passthrough`, only
// `FAKE_AGENT_MODE` today) meant for real `claude`/`codex` invocations, which would silently swallow the
// `FAKE_STYLE_*`/`FAKE_REVIEW_MODE`/`FAKE_AGENT_FAIL_STAGE` test knobs this file exercises -- that
// allowlist is out of scope for task 6, so the fixture is run the way the brief literally says: `node
// fixtures/fake-agent-cli.mjs` in a workspace with `stage-request.json` + `agent-prompt.md`.
//
// This is the RED/GREEN anchor for task 6: before the fixture grew its `style`/`survey`/`survey_index`/
// `edl`/`edit_plan`/`narration`/`review` branches, every content assertion below failed (the fixture only
// knew `channel_package_draft`; everything else fell through to `{ fake: true }`, which fails every schema).
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EdlSchema, EditStyleSchema, newId, reviewSchema, surveyIndexSchema, type StageRequest } from "@harness/contracts";

const skillsDir = fileURLToPath(new URL("../../../../skills", import.meta.url));
const fixture = fileURLToPath(new URL("../../../../fixtures/fake-agent-cli.mjs", import.meta.url));

const SHA = "sha256:" + "a".repeat(64);

type Input = StageRequest["inputs"][number];
type ExpectedOutput = StageRequest["expected_outputs"][number];

function makeRequest(ws: string, o: { stage_key: string; inputs?: Input[]; expected_outputs: ExpectedOutput[] }): StageRequest {
  return {
    schema_version: "harness.stage-request/v1",
    run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"),
    project_id: "p", portfolio_id: "pf", stage_key: o.stage_key,
    workflow: { id: "w", version: "1.0.0", digest: SHA },
    profile_snapshot: { id: "studio", revision: 1 },
    inputs: o.inputs ?? [],
    workspace_uri: ws,
    stage_config: {},
    expected_outputs: o.expected_outputs,
    limits: { deadline_at: new Date(Date.now() + 60_000).toISOString(), max_cost_usd: 5, max_attempts: 3 },
    capabilities: [], fencing_token: 1,
  };
}

/** Writes `content` at `<ws>/<relPath>` and returns the matching `inputs[]` entry (kind "file"). */
function fileInput(ws: string, relPath: string, content: string, type: string): Input {
  const abs = join(ws, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return { artifact_id: newId("artifact"), checksum: SHA, path: relPath, type, kind: "file" };
}

/** Writes `files` under `<ws>/<relPath>/` and returns the matching `inputs[]` entry (kind "directory"). */
function dirInput(ws: string, relPath: string, files: Record<string, string>, type: string): Input {
  const abs = join(ws, relPath);
  mkdirSync(abs, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(abs, name), content);
  return { artifact_id: newId("artifact"), checksum: SHA, path: relPath, type, kind: "directory" };
}

const SHOTS_JSON = (sourceId: string) => JSON.stringify({
  source_id: sourceId, duration_seconds: 30, shots: [{ in: 0, out: 15 }, { in: 15, out: 30 }], transcript: null,
});

const BRIEF_JSON = (o: { target?: [number, number]; requestNotes?: string } = {}) => JSON.stringify({
  topic: "Chợ nổi miền Tây", style_id: newId("edit_style"), style_revision: 1,
  ...(o.target ? { target_duration_seconds: o.target } : {}),
  voice: "none", language: "vi", request_notes: o.requestNotes ?? "",
});

const STYLE_DRAFT_JSON = (styleId: string) => JSON.stringify({
  schema_version: "harness.edit-style/v1", style_id: styleId, revision: 1, name: "Test style", status: "draft",
  learned_from: [{ label: "s0", notes: "ref" }],
  params: {
    cut_rhythm: "fast", shot_seconds: [1, 3], transitions: ["cut"],
    text_overlay: { style: "bold", density: "medium" }, subtitles: "burn-in",
    music: { mood: "upbeat", ducking: true }, opening: { seconds: 2, structure: "hook" },
    aspect_ratio: "16:9", pace_notes: "",
  },
  evidence: [], created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
});

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "fake-agent-"));
}

/** Writes `agent-prompt.md` (required to exist, unused by these output branches) + `stage-request.json`,
 * then spawns the fixture with `cwd = ws`, exactly like the harness core's `CliAgentRuntime` does. */
function run(ws: string, req: StageRequest, env: Record<string, string> = {}): { status: number | null; out: string; err: string } {
  writeFileSync(join(ws, "agent-prompt.md"), "fake prompt for tests\n");
  writeFileSync(join(ws, "stage-request.json"), JSON.stringify(req, null, 2));
  const r = spawnSync(process.execPath, [fixture], { cwd: ws, env: { ...process.env, ...env }, encoding: "utf8" });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

describe("fake-agent-cli.mjs: studio skill outputs", () => {
  it("style-analyze (type 'style'/'style_evidence'): writes a schema-valid draft style.json with learned_from from samples.json, plus evidence/notes.md covering every params.* field", () => {
    const ws = tmpWorkspace();
    const sampleSet = dirInput(ws, "inputs/samples", {
      "samples.json": JSON.stringify([{ index: 0, label: "s0", path: "a.mp4", frames: [] }, { index: 1, label: "s1", path: "b.mp4", frames: [] }]),
    }, "sample_set");
    const req = makeRequest(ws, {
      stage_key: "analyze-style",
      inputs: [sampleSet],
      expected_outputs: [
        { type: "style", mime_type: "application/json", kind: "file", name: "style.json" },
        { type: "style_evidence", mime_type: "application/x-directory", kind: "directory", name: "evidence" },
      ],
    });
    const r = run(ws, req);
    expect(r.status, `stderr: ${r.err}`).toBe(0);

    const style = JSON.parse(readFileSync(join(ws, "output", "style.json"), "utf8"));
    const parsed = EditStyleSchema.safeParse(style);
    expect(parsed.success, JSON.stringify(parsed.success ? undefined : parsed.error.issues)).toBe(true);
    expect(style.status).toBe("draft");
    expect(style.learned_from).toEqual([
      { label: "s0", notes: "fake agent: no real analysis" },
      { label: "s1", notes: "fake agent: no real analysis" },
    ]);

    const notes = readFileSync(join(ws, "output", "evidence", "notes.md"), "utf8");
    for (const key of Object.keys(style.params)) expect(notes).toContain(`- ${key}:`);
  });

  it("style-review (type 'style' with a style input): reviewing a draft defaults status to active, round-trips style_id", () => {
    const ws = tmpWorkspace();
    const styleId = newId("edit_style");
    const styleInput = fileInput(ws, "inputs/style.json", STYLE_DRAFT_JSON(styleId), "style");
    const req = makeRequest(ws, {
      stage_key: "style-review",
      inputs: [styleInput],
      expected_outputs: [
        { type: "style", mime_type: "application/json", kind: "file", name: "style.json" },
        { type: "review_notes", mime_type: "text/markdown", kind: "file", name: "review-notes.md" },
      ],
    });
    const r = run(ws, req);
    expect(r.status, `stderr: ${r.err}`).toBe(0);

    const style = JSON.parse(readFileSync(join(ws, "output", "style.json"), "utf8"));
    expect(EditStyleSchema.safeParse(style).success).toBe(true);
    expect(style.status).toBe("active");
    expect(style.style_id).toBe(styleId);
    expect(readFileSync(join(ws, "output", "review-notes.md"), "utf8")).toContain("cut_rhythm");
  });

  it("style-review: FAKE_STYLE_REVIEW=keep-draft keeps status draft", () => {
    const ws = tmpWorkspace();
    const styleId = newId("edit_style");
    const styleInput = fileInput(ws, "inputs/style.json", STYLE_DRAFT_JSON(styleId), "style");
    const req = makeRequest(ws, {
      stage_key: "style-review",
      inputs: [styleInput],
      expected_outputs: [
        { type: "style", mime_type: "application/json", kind: "file", name: "style.json" },
        { type: "review_notes", mime_type: "text/markdown", kind: "file", name: "review-notes.md" },
      ],
    });
    const r = run(ws, req, { FAKE_STYLE_REVIEW: "keep-draft" });
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    const style = JSON.parse(readFileSync(join(ws, "output", "style.json"), "utf8"));
    expect(style.status).toBe("draft");
  });

  it("source-survey (type 'survey_index'): covers every shot from shots.json, score 4, usable true", () => {
    const ws = tmpWorkspace();
    const sourceId = newId("source_item");
    const shotsInput = fileInput(ws, "inputs/shots.json", SHOTS_JSON(sourceId), "shots");
    const briefInput = fileInput(ws, "inputs/brief.json", BRIEF_JSON(), "brief");
    const req = makeRequest(ws, {
      stage_key: "survey-source",
      inputs: [shotsInput, briefInput],
      expected_outputs: [
        { type: "survey", mime_type: "text/markdown", kind: "file", name: "survey.md" },
        { type: "survey_index", mime_type: "application/json", kind: "file", name: "survey.json" },
      ],
    });
    const r = run(ws, req);
    expect(r.status, `stderr: ${r.err}`).toBe(0);

    const survey = JSON.parse(readFileSync(join(ws, "output", "survey.json"), "utf8"));
    const parsed = surveyIndexSchema.safeParse(survey);
    expect(parsed.success, JSON.stringify(parsed.success ? undefined : parsed.error.issues)).toBe(true);
    expect(survey.shots).toHaveLength(2);
    for (const shot of survey.shots) { expect(shot.score).toBe(4); expect(shot.usable).toBe(true); }
    expect(readFileSync(join(ws, "output", "survey.md"), "utf8").length).toBeGreaterThan(0);
  });

  it("edit-plan (type 'edl'): trims to brief.target_duration_seconds, edit_plan.json and empty narration.txt also written", () => {
    const ws = tmpWorkspace();
    const sourceId = newId("source_item");
    const shotsInput = fileInput(ws, "inputs/shots.json", SHOTS_JSON(sourceId), "shots"); // two 15s shots, 30s total
    const briefInput = fileInput(ws, "inputs/brief.json", BRIEF_JSON({ target: [1, 20] }), "brief");
    const req = makeRequest(ws, {
      stage_key: "plan-edit",
      inputs: [shotsInput, briefInput],
      expected_outputs: [
        { type: "edl", mime_type: "application/json", kind: "file", name: "edl.json" },
        { type: "edit_plan", mime_type: "application/json", kind: "file", name: "edit-plan.json" },
        { type: "narration", mime_type: "text/plain", kind: "file", name: "narration.txt" },
      ],
    });
    const r = run(ws, req);
    expect(r.status, `stderr: ${r.err}`).toBe(0);

    const edl = JSON.parse(readFileSync(join(ws, "output", "edl.json"), "utf8"));
    const parsed = EdlSchema.safeParse(edl);
    expect(parsed.success, JSON.stringify(parsed.success ? undefined : parsed.error.issues)).toBe(true);
    const total = edl.entries.reduce((n: number, e: { in: number; out: number }) => n + (e.out - e.in), 0);
    expect(total).toBeGreaterThanOrEqual(1);
    expect(total).toBeLessThanOrEqual(20);
    for (const e of edl.entries) expect(e.source_id).toBe(sourceId);

    const editPlan = JSON.parse(readFileSync(join(ws, "output", "edit-plan.json"), "utf8"));
    expect(editPlan.schema_version).toBe("harness.edit-plan/v1");
    expect(readFileSync(join(ws, "output", "narration.txt"), "utf8")).toBe("");
  });

  it("edit-plan: source shorter than the target minimum writes everything the source has (no padding)", () => {
    const ws = tmpWorkspace();
    const sourceId = newId("source_item");
    const shotsInput = fileInput(ws, "inputs/shots.json", SHOTS_JSON(sourceId), "shots"); // 30s total
    const briefInput = fileInput(ws, "inputs/brief.json", BRIEF_JSON({ target: [60, 180] }), "brief");
    const req = makeRequest(ws, {
      stage_key: "plan-edit",
      inputs: [shotsInput, briefInput],
      expected_outputs: [{ type: "edl", mime_type: "application/json", kind: "file", name: "edl.json" }],
    });
    const r = run(ws, req);
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    const edl = JSON.parse(readFileSync(join(ws, "output", "edl.json"), "utf8"));
    expect(EdlSchema.safeParse(edl).success).toBe(true);
    const total = edl.entries.reduce((n: number, e: { in: number; out: number }) => n + (e.out - e.in), 0);
    expect(total).toBe(30); // shorter than the 60s minimum: the whole source is kept, nothing padded
  });

  it("library-review (type 'review'): FAKE_REVIEW_MODE=reject-once rejects when brief.request_notes is empty (first run)", () => {
    const ws = tmpWorkspace();
    const briefInput = fileInput(ws, "inputs/brief.json", BRIEF_JSON({ requestNotes: "" }), "brief");
    const req = makeRequest(ws, {
      stage_key: "library-review",
      inputs: [briefInput],
      expected_outputs: [{ type: "review", mime_type: "application/json", kind: "file", name: "review.json" }],
    });
    const r = run(ws, req, { FAKE_REVIEW_MODE: "reject-once" });
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    const review = JSON.parse(readFileSync(join(ws, "output", "review.json"), "utf8"));
    expect(reviewSchema.safeParse(review).success).toBe(true);
    expect(review.decision).toBe("rejected");
    expect(review.checks).toHaveLength(6);
    expect(review.checks.map((c: { id: string }) => c.id)).toEqual([
      "duration_in_range", "no_black_or_frozen_over_2s", "opening_matches_style", "text_not_clipped", "audio_present", "thumbnails_textless",
    ]);
    expect(review.checks.some((c: { pass: boolean }) => !c.pass)).toBe(true);
  });

  it("library-review: FAKE_REVIEW_MODE=reject-once approves when brief.request_notes carries a prior rejection (replan)", () => {
    const ws = tmpWorkspace();
    const briefInput = fileInput(ws, "inputs/brief.json", BRIEF_JSON({ requestNotes: "review từ chối: thời lượng quá dài" }), "brief");
    const req = makeRequest(ws, {
      stage_key: "library-review",
      inputs: [briefInput],
      expected_outputs: [{ type: "review", mime_type: "application/json", kind: "file", name: "review.json" }],
    });
    const r = run(ws, req, { FAKE_REVIEW_MODE: "reject-once" });
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    const review = JSON.parse(readFileSync(join(ws, "output", "review.json"), "utf8"));
    expect(review.decision).toBe("approved");
    expect(review.checks.every((c: { pass: boolean }) => c.pass)).toBe(true);
  });

  it("library-review: default FAKE_REVIEW_MODE (approve) approves regardless of request_notes", () => {
    const ws = tmpWorkspace();
    const briefInput = fileInput(ws, "inputs/brief.json", BRIEF_JSON(), "brief");
    const req = makeRequest(ws, {
      stage_key: "library-review",
      inputs: [briefInput],
      expected_outputs: [{ type: "review", mime_type: "application/json", kind: "file", name: "review.json" }],
    });
    const r = run(ws, req);
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    const review = JSON.parse(readFileSync(join(ws, "output", "review.json"), "utf8"));
    expect(review.decision).toBe("approved");
  });

  it("library-review: FAKE_REVIEW_MODE=reject-always always rejects", () => {
    const ws = tmpWorkspace();
    const briefInput = fileInput(ws, "inputs/brief.json", BRIEF_JSON({ requestNotes: "đã sửa" }), "brief");
    const req = makeRequest(ws, {
      stage_key: "library-review",
      inputs: [briefInput],
      expected_outputs: [{ type: "review", mime_type: "application/json", kind: "file", name: "review.json" }],
    });
    const r = run(ws, req, { FAKE_REVIEW_MODE: "reject-always" });
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    const review = JSON.parse(readFileSync(join(ws, "output", "review.json"), "utf8"));
    expect(review.decision).toBe("rejected");
  });

  it("FAKE_AGENT_FAIL_STAGE targets one stage_key: matching stage writes no output, other stages are unaffected", () => {
    const ws1 = tmpWorkspace();
    const req1 = makeRequest(ws1, {
      stage_key: "survey-source",
      expected_outputs: [{ type: "survey", mime_type: "text/markdown", kind: "file", name: "survey.md" }],
    });
    const r1 = run(ws1, req1, { FAKE_AGENT_FAIL_STAGE: "survey-source" });
    expect(r1.status, `stderr: ${r1.err}`).toBe(0); // exits clean, like FAKE_AGENT_MODE=no-output -- just writes nothing
    expect(existsSync(join(ws1, "output", "survey.md"))).toBe(false);

    const ws2 = tmpWorkspace();
    const briefInput2 = fileInput(ws2, "inputs/brief.json", BRIEF_JSON(), "brief");
    const req2 = makeRequest(ws2, {
      stage_key: "library-review",
      inputs: [briefInput2],
      expected_outputs: [{ type: "review", mime_type: "application/json", kind: "file", name: "review.json" }],
    });
    const r2 = run(ws2, req2, { FAKE_AGENT_FAIL_STAGE: "survey-source" });
    expect(r2.status, `stderr: ${r2.err}`).toBe(0);
    expect(existsSync(join(ws2, "output", "review.json"))).toBe(true);
  });
});

describe("studio skill docs (skills/<name>/SKILL.md)", () => {
  const REQUIRED_HEADINGS = ["## Mục tiêu", "## Input", "## Ngân sách khung", "## Quy trình", "## Cấu trúc", "## Tiêu chí tự kiểm", "## Điều cấm"];
  const skills = ["style-analyze", "style-review", "source-survey", "edit-plan", "library-review"];

  for (const skill of skills) {
    it(`${skill}/SKILL.md exists, has every required section, and is 80-120 lines`, () => {
      const content = readFileSync(join(skillsDir, skill, "SKILL.md"), "utf8");
      for (const heading of REQUIRED_HEADINGS) expect(content).toContain(heading);
      const lineCount = content.split("\n").length;
      expect(lineCount).toBeGreaterThanOrEqual(80);
      expect(lineCount).toBeLessThanOrEqual(120);
    });
  }

  // Final-review finding I-1: `style-analyze` (and `channel-package` before it) told the agent it could leave
  // `style_id`/`hypothesis_id`/`created_at`/`updated_at` blank because "harness sẽ điền lại nếu thiếu".
  // Nothing backfills them -- `EditStyleSchema`/`HypothesisSchema` require a well-formed id and an ISO-8601
  // UTC timestamp on the way in -- so an agent that follows that sentence fails `schema-valid` on its first
  // real run. Guard every skill doc (not just the five studio ones) against the claim coming back.
  const BACKFILL_CLAIMS = ["điền lại nếu thiếu", "harness điền nếu thiếu"];
  it("no skills/*/SKILL.md claims the harness backfills a missing field", () => {
    const docs = readdirSync(skillsDir)
      .map((name) => join(skillsDir, name, "SKILL.md"))
      .filter((path) => existsSync(path));
    expect(docs.length).toBeGreaterThan(0);
    const offenders = docs.filter((path) => {
      const content = readFileSync(path, "utf8");
      return BACKFILL_CLAIMS.some((claim) => content.includes(claim));
    });
    expect(offenders).toEqual([]);
  });
});
