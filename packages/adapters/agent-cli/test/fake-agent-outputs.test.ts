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
import { ChannelPackageDraftSchema, EdlSchema, EditStyleSchema, NarrationSchema, newId, reviewSchema, surveyIndexSchema, TopicProposalSchema, type StageRequest } from "@harness/contracts";

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

const DEMAND_JSON = (needed: number, topicsPerRun = 3) => JSON.stringify({
  schema_version: "harness.demand/v1", channel_id: "c1", needed, slots: [],
  covered: { jobs: 0, runs: 0, items: 0, requests: 0 }, open_requests: 0, max_open_requests: 3, topics_per_run: topicsPerRun,
});

/** A schema-valid `harness.channel-brief/v1` document, shaped just enough to exercise the fake agent's
 * channel-aware branches (sub-project 3B, task 5): `learned.standard`/`metric`/`medians` when given, plus
 * `open_requests`/`hypotheses` titles a `topic_proposal` must not duplicate. */
const CHANNEL_BRIEF_JSON = (o: {
  standard?: { angle?: string; title_pattern?: string; overlay_lines?: "0" | "1-2" | "3" };
  metric?: "ctr" | "views_72h" | "avg_view_pct";
  medians?: Partial<{ views_72h: number; ctr_pct: number; avg_view_pct: number }>;
  openTopics?: string[];
  hypothesisTitles?: string[];
  niche?: string;
} = {}) => JSON.stringify({
  schema_version: "harness.channel-brief/v1",
  generated_at: "2026-09-16T00:00:00.000Z",
  channel: {
    channel_id: "c1", display_name: "Channel One",
    seo: { niche: o.niche ?? "chợ nổi miền Tây", audience: "", angle: "", language: "vi", market: "", keywords: [], title_rules: "", description_template: "" },
    publication: { timezone: "Asia/Ho_Chi_Minh", publish_times: ["09:00"] },
  },
  learned: (o.standard || o.metric || o.medians) ? {
    schema_version: "harness.channel-learned/v1", channel_id: "c1", updated_at: "2026-09-16T00:00:00.000Z", sample_size: 10,
    metric: o.metric ?? "views_72h",
    medians: { views_72h: o.medians?.views_72h ?? null, ctr_pct: o.medians?.ctr_pct ?? null, avg_view_pct: o.medians?.avg_view_pct ?? null },
    winners: { angles: [], title_patterns: [], overlay: [] },
    standard: { ...(o.standard ?? {}), note: "" },
    history: [],
  } : null,
  hypotheses: (o.hypothesisTitles ?? []).map((title, i) => ({
    hypothesis_id: newId("hypothesis"), episode_no: i + 1,
    chosen: { title, angle: "", overlay_text: [] },
    expected: { metric: "views_72h", target: 1000, horizon_hours: 72 },
    status: "open",
  })),
  recent_metrics: [],
  open_requests: (o.openTopics ?? []).map((topic) => ({ request_id: newId("content_request"), topic, status: "open" })),
  item: null,
});

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

const SHOTS_JSON_V2 = (sourceIds: string[]) => JSON.stringify({
  schema_version: "harness.shots/v2",
  sources: sourceIds.map((id, i) => ({
    source_id: id, index: i, file_name: `clip${i}.mp4`, duration_seconds: 20, has_audio: true,
    shots: [
      { shot_id: `s${String(i).padStart(3, "0")}-000`, in: 0, out: 10 },
      { shot_id: `s${String(i).padStart(3, "0")}-001`, in: 10, out: 20 },
    ],
  })),
});

const TRANSCRIPT_JSON = (sourceIds: string[], talkingSourceId: string) => JSON.stringify({
  schema_version: "harness.transcript/v1", engine: "fake",
  sources: sourceIds.map((id) => ({
    source_id: id, language: "vi", alignment: "word",
    segments: id === talkingSourceId ? [{ start: 1, end: 3, text: "xin chào", words: [] }] : [],
  })),
});

const FIT_REPORT_JSON = (o: { shortfalls?: { line_ids: string[]; missing_seconds: number; reused_seconds?: number; uncovered_seconds?: number }[]; reused_seconds?: number; within_target?: boolean } = {}) => JSON.stringify({
  schema_version: "harness.fit-report/v1", voice: "tts", entries: [],
  shortfalls: o.shortfalls ?? [], reused_seconds: o.reused_seconds ?? 0, warnings: [], total_seconds: 12,
  within_target: o.within_target ?? true,
});

// Sub-project 5A task 8: the multi-source survey/edl/narration shapes and the fit_report-aware review, kept
// separate from the sub-project 4 studio block above (which exercises the unchanged single-source v1 shapes).
describe("fake-agent-cli.mjs: sub-project 5A task 8 (multi-source survey/edl/narration, fit_report review)", () => {
  it("source-survey with a v2 shots.json (multi-source) writes a v2 survey.json: every shot usable, score 3, speech from transcript overlap", () => {
    const ws = tmpWorkspace();
    const sourceIds = [newId("source_item"), newId("source_item")];
    const shotsInput = fileInput(ws, "inputs/shots.json", SHOTS_JSON_V2(sourceIds), "shots");
    const transcriptInput = fileInput(ws, "inputs/transcript.json", TRANSCRIPT_JSON(sourceIds, sourceIds[0]!), "transcript");
    const briefInput = fileInput(ws, "inputs/brief.json", BRIEF_JSON(), "brief");
    const req = makeRequest(ws, {
      stage_key: "survey-source",
      inputs: [shotsInput, transcriptInput, briefInput],
      expected_outputs: [
        { type: "survey", mime_type: "text/markdown", kind: "file", name: "survey.md" },
        { type: "survey_index", mime_type: "application/json", kind: "file", name: "survey.json" },
      ],
    });
    const r = run(ws, req);
    expect(r.status, `stderr: ${r.err}`).toBe(0);

    const survey = JSON.parse(readFileSync(join(ws, "output", "survey.json"), "utf8"));
    expect(survey.schema_version).toBe("harness.survey-index/v2");
    expect(survey.shots).toHaveLength(4); // 2 sources x 2 shots
    for (const shot of survey.shots) { expect(shot.usable).toBe(true); expect(shot.score).toBe(3); }
    // sourceIds[0]'s shots overlap the transcript segment [1,3); sourceIds[1] has no segments at all.
    const talking = survey.shots.filter((s: { source_id: string; speech: string }) => s.source_id === sourceIds[0] && s.speech === "talking");
    expect(talking.length).toBeGreaterThan(0);
    for (const shot of survey.shots.filter((s: { source_id: string }) => s.source_id === sourceIds[1])) {
      expect(shot.speech).toBe("none");
    }
  });

  it("edit-plan with a v2 shots.json + brief.voice tts: writes narration.json (harness.narration/v1) with lines keyed to real edl_order values", () => {
    const ws = tmpWorkspace();
    const sourceIds = [newId("source_item"), newId("source_item")];
    const shotsInput = fileInput(ws, "inputs/shots.json", SHOTS_JSON_V2(sourceIds), "shots");
    const briefJson = JSON.stringify({ topic: "test", style_id: newId("edit_style"), style_revision: 1, voice: "tts", language: "vi", request_notes: "" });
    const briefInput = fileInput(ws, "inputs/brief.json", briefJson, "brief");
    const req = makeRequest(ws, {
      stage_key: "plan-edit",
      inputs: [shotsInput, briefInput],
      expected_outputs: [
        { type: "edl", mime_type: "application/json", kind: "file", name: "edl.json" },
        { type: "edit_plan", mime_type: "application/json", kind: "file", name: "edit-plan.json" },
        { type: "narration", mime_type: "application/json", kind: "file", name: "narration.json" },
      ],
    });
    const r = run(ws, req);
    expect(r.status, `stderr: ${r.err}`).toBe(0);

    const edl = JSON.parse(readFileSync(join(ws, "output", "edl.json"), "utf8"));
    expect(EdlSchema.safeParse(edl).success).toBe(true);
    expect(edl.entries.map((e: { source_id: string }) => e.source_id).sort()).toEqual([...sourceIds].sort());

    const narration = JSON.parse(readFileSync(join(ws, "output", "narration.json"), "utf8"));
    const parsed = NarrationSchema.safeParse(narration);
    expect(parsed.success, JSON.stringify(parsed.success ? undefined : parsed.error.issues)).toBe(true);
    expect(narration.lines.length).toBe(edl.entries.length);
    const knownOrders = new Set(edl.entries.map((e: { order: number }) => e.order));
    for (const line of narration.lines) expect(knownOrders.has(line.edl_order)).toBe(true);
    // FAKE_NARRATION_CHARS default 40
    for (const line of narration.lines) expect(line.text.length).toBe(40);
  });

  it("edit-plan: FAKE_NARRATION_CHARS overrides the placeholder line length", () => {
    const ws = tmpWorkspace();
    const sourceIds = [newId("source_item")];
    const shotsInput = fileInput(ws, "inputs/shots.json", SHOTS_JSON_V2(sourceIds), "shots");
    const briefJson = JSON.stringify({ topic: "test", style_id: newId("edit_style"), style_revision: 1, voice: "tts", language: "vi", request_notes: "" });
    const briefInput = fileInput(ws, "inputs/brief.json", briefJson, "brief");
    const req = makeRequest(ws, {
      stage_key: "plan-edit",
      inputs: [shotsInput, briefInput],
      expected_outputs: [{ type: "narration", mime_type: "application/json", kind: "file", name: "narration.json" }],
    });
    const r = run(ws, req, { FAKE_NARRATION_CHARS: "90" });
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    const narration = JSON.parse(readFileSync(join(ws, "output", "narration.json"), "utf8"));
    expect(narration.lines[0].text.length).toBe(90);
  });

  it("edit-plan: brief.request_notes containing \"thiếu\" (a prior shortfall rejection) shortens the line to 20 chars regardless of FAKE_NARRATION_CHARS", () => {
    const ws = tmpWorkspace();
    const sourceIds = [newId("source_item")];
    const shotsInput = fileInput(ws, "inputs/shots.json", SHOTS_JSON_V2(sourceIds), "shots");
    const briefJson = JSON.stringify({ topic: "test", style_id: newId("edit_style"), style_revision: 1, voice: "tts", language: "vi", request_notes: "fake agent: thiếu 4.2 s ở L001" });
    const briefInput = fileInput(ws, "inputs/brief.json", briefJson, "brief");
    const req = makeRequest(ws, {
      stage_key: "plan-edit",
      inputs: [shotsInput, briefInput],
      expected_outputs: [{ type: "narration", mime_type: "application/json", kind: "file", name: "narration.json" }],
    });
    const r = run(ws, req, { FAKE_NARRATION_CHARS: "90" });
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    const narration = JSON.parse(readFileSync(join(ws, "output", "narration.json"), "utf8"));
    expect(narration.lines[0].text.length).toBe(20);
  });

  it("library-review: a fit_report with shortfalls rejects unconditionally (FAKE_REVIEW_MODE=approve is overridden), note names the line_ids and missing seconds", () => {
    const ws = tmpWorkspace();
    const briefInput = fileInput(ws, "inputs/brief.json", BRIEF_JSON(), "brief");
    const fitReportInput = fileInput(ws, "inputs/fit-report.json", FIT_REPORT_JSON({ shortfalls: [{ line_ids: ["L001", "L002"], missing_seconds: 4.2, reused_seconds: 0, uncovered_seconds: 4.2 }] }), "fit_report");
    const req = makeRequest(ws, {
      stage_key: "library-review",
      inputs: [briefInput, fitReportInput],
      expected_outputs: [{ type: "review", mime_type: "application/json", kind: "file", name: "review.json" }],
    });
    const r = run(ws, req, { FAKE_REVIEW_MODE: "approve" });
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    const review = JSON.parse(readFileSync(join(ws, "output", "review.json"), "utf8"));
    expect(reviewSchema.safeParse(review).success).toBe(true);
    expect(review.decision).toBe("rejected");
    expect(review.note).toContain("thiếu");
    expect(review.note).toContain("L001");
    expect(review.note).toContain("L002");
    expect(review.note).toContain("4.2");
  });

  it("library-review: a fit_report with reused_seconds > 5 rejects even with no shortfalls rows", () => {
    const ws = tmpWorkspace();
    const briefInput = fileInput(ws, "inputs/brief.json", BRIEF_JSON(), "brief");
    const fitReportInput = fileInput(ws, "inputs/fit-report.json", FIT_REPORT_JSON({ shortfalls: [{ line_ids: ["L001"], missing_seconds: 6, reused_seconds: 6, uncovered_seconds: 0 }], reused_seconds: 6 }), "fit_report");
    const req = makeRequest(ws, {
      stage_key: "library-review",
      inputs: [briefInput, fitReportInput],
      expected_outputs: [{ type: "review", mime_type: "application/json", kind: "file", name: "review.json" }],
    });
    const r = run(ws, req, { FAKE_REVIEW_MODE: "approve" });
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    const review = JSON.parse(readFileSync(join(ws, "output", "review.json"), "utf8"));
    expect(review.decision).toBe("rejected");
  });

  it("library-review: a fit_report with within_target: false rejects even with no shortfalls", () => {
    const ws = tmpWorkspace();
    const briefInput = fileInput(ws, "inputs/brief.json", BRIEF_JSON(), "brief");
    const fitReportInput = fileInput(ws, "inputs/fit-report.json", FIT_REPORT_JSON({ within_target: false }), "fit_report");
    const req = makeRequest(ws, {
      stage_key: "library-review",
      inputs: [briefInput, fitReportInput],
      expected_outputs: [{ type: "review", mime_type: "application/json", kind: "file", name: "review.json" }],
    });
    const r = run(ws, req, { FAKE_REVIEW_MODE: "approve" });
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    const review = JSON.parse(readFileSync(join(ws, "output", "review.json"), "utf8"));
    expect(review.decision).toBe("rejected");
  });

  it("library-review: a fit_report with no shortfalls, reused_seconds <= 5, within_target true does not force rejection", () => {
    const ws = tmpWorkspace();
    const briefInput = fileInput(ws, "inputs/brief.json", BRIEF_JSON(), "brief");
    const fitReportInput = fileInput(ws, "inputs/fit-report.json", FIT_REPORT_JSON({}), "fit_report");
    const req = makeRequest(ws, {
      stage_key: "library-review",
      inputs: [briefInput, fitReportInput],
      expected_outputs: [{ type: "review", mime_type: "application/json", kind: "file", name: "review.json" }],
    });
    const r = run(ws, req);
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    const review = JSON.parse(readFileSync(join(ws, "output", "review.json"), "utf8"));
    expect(review.decision).toBe("approved");
  });
});

describe("fake-agent-cli.mjs: sub-project 3B channel-planning/channel-package outputs", () => {
  it("channel-plan (type 'topic_proposal'): reads demand.needed and channel_brief, avoids duplicating open_requests[].topic and hypotheses[].chosen.title", () => {
    const ws = tmpWorkspace();
    const demandInput = fileInput(ws, "inputs/demand.json", DEMAND_JSON(2), "demand");
    const briefInput = fileInput(ws, "inputs/channel-brief.json", CHANNEL_BRIEF_JSON({
      standard: { angle: "flycam" },
      openTopics: ["Chủ đề tự động 1 về chợ nổi miền Tây"],
      hypothesisTitles: ["Chủ đề tự động 2 về chợ nổi miền Tây"],
    }), "channel_brief");
    const req = makeRequest(ws, {
      stage_key: "propose-topics",
      inputs: [demandInput, briefInput],
      expected_outputs: [{ type: "topic_proposal", mime_type: "application/json", kind: "file", name: "topics.json" }],
    });
    const r = run(ws, req);
    expect(r.status, `stderr: ${r.err}`).toBe(0);

    const proposal = JSON.parse(readFileSync(join(ws, "output", "topics.json"), "utf8"));
    const parsed = TopicProposalSchema.safeParse(proposal);
    expect(parsed.success, JSON.stringify(parsed.success ? undefined : parsed.error.issues)).toBe(true);
    expect(proposal.topics).toHaveLength(2); // min(needed=2, 3)
    const topics = proposal.topics.map((t: { topic: string }) => t.topic.toLowerCase());
    expect(topics).not.toContain("chủ đề tự động 1 về chợ nổi miền tây"); // duplicates open_requests[].topic
    expect(topics).not.toContain("chủ đề tự động 2 về chợ nổi miền tây"); // duplicates hypotheses[].chosen.title
    for (const t of proposal.topics as { angle: string; why: string }[]) {
      expect(t.angle).toBe("flycam"); // follows learned.standard.angle
      expect(t.why.length).toBeGreaterThan(0);
    }
  });

  it("channel-plan: without demand/channel_brief inputs, still writes a schema-valid single-topic proposal", () => {
    const ws = tmpWorkspace();
    const req = makeRequest(ws, {
      stage_key: "propose-topics",
      expected_outputs: [{ type: "topic_proposal", mime_type: "application/json", kind: "file", name: "topics.json" }],
    });
    const r = run(ws, req);
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    const proposal = JSON.parse(readFileSync(join(ws, "output", "topics.json"), "utf8"));
    expect(TopicProposalSchema.safeParse(proposal).success).toBe(true);
    expect(proposal.topics).toHaveLength(1);
  });

  it("channel-plan: caps the proposal count at demand.topics_per_run, not just needed", () => {
    const ws = tmpWorkspace();
    const demandInput = fileInput(ws, "inputs/demand.json", DEMAND_JSON(5, 2), "demand"); // needed=5, topics_per_run=2
    const req = makeRequest(ws, {
      stage_key: "propose-topics",
      inputs: [demandInput],
      expected_outputs: [{ type: "topic_proposal", mime_type: "application/json", kind: "file", name: "topics.json" }],
    });
    const r = run(ws, req);
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    const proposal = JSON.parse(readFileSync(join(ws, "output", "topics.json"), "utf8"));
    expect(TopicProposalSchema.safeParse(proposal).success).toBe(true);
    expect(proposal.topics).toHaveLength(2); // min(needed=5, topics_per_run=2, 3)
  });

  it("channel-plan: FAKE_ANGLE overrides the proposed topics' angle", () => {
    const ws = tmpWorkspace();
    const demandInput = fileInput(ws, "inputs/demand.json", DEMAND_JSON(1), "demand");
    const briefInput = fileInput(ws, "inputs/channel-brief.json", CHANNEL_BRIEF_JSON({ standard: { angle: "flycam" } }), "channel_brief");
    const req = makeRequest(ws, {
      stage_key: "propose-topics",
      inputs: [demandInput, briefInput],
      expected_outputs: [{ type: "topic_proposal", mime_type: "application/json", kind: "file", name: "topics.json" }],
    });
    const r = run(ws, req, { FAKE_ANGLE: "override-angle" });
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    const proposal = JSON.parse(readFileSync(join(ws, "output", "topics.json"), "utf8"));
    expect(proposal.topics[0].angle).toBe("override-angle");
  });

  it("channel-package_draft (channel-aware): a channel_brief with a learned standard adds a 'channel' basis entry, follows the standard's angle, and prices expected off the matching median", () => {
    const ws = tmpWorkspace();
    const thumbSet = dirInput(ws, "inputs/thumbnails", { "thumb-01.png": "x" }, "thumbnail_set");
    const briefInput = fileInput(ws, "inputs/channel-brief.json", CHANNEL_BRIEF_JSON({
      standard: { angle: "flycam", title_pattern: "question" }, metric: "ctr", medians: { ctr_pct: 5 },
    }), "channel_brief");
    const req = makeRequest(ws, {
      stage_key: "package",
      inputs: [thumbSet, briefInput],
      expected_outputs: [{ type: "channel_package_draft", mime_type: "application/json", kind: "file", name: "package.json" }],
    });
    const r = run(ws, req);
    expect(r.status, `stderr: ${r.err}`).toBe(0);

    const draft = JSON.parse(readFileSync(join(ws, "output", "package.json"), "utf8"));
    expect(ChannelPackageDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft.hypothesis.chosen.angle).toBe("flycam");
    expect(draft.hypothesis.basis).toEqual(expect.arrayContaining([{ kind: "channel", note: "theo chuẩn kênh (fake)" }]));
    expect(draft.hypothesis.expected.metric).toBe("ctr");
    expect(draft.hypothesis.expected.target).toBeCloseTo(5.5); // medians.ctr_pct (5) * 1.1
  });

  it("channel_package_draft: no channel_brief input keeps the pre-3B behavior (manual basis only, empty angle, views_72h/1000 default)", () => {
    const ws = tmpWorkspace();
    const thumbSet = dirInput(ws, "inputs/thumbnails", { "thumb-01.png": "x" }, "thumbnail_set");
    const req = makeRequest(ws, {
      stage_key: "package",
      inputs: [thumbSet],
      expected_outputs: [{ type: "channel_package_draft", mime_type: "application/json", kind: "file", name: "package.json" }],
    });
    const r = run(ws, req);
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    const draft = JSON.parse(readFileSync(join(ws, "output", "package.json"), "utf8"));
    expect(draft.hypothesis.basis).toEqual([{ kind: "manual", note: "fake agent: no live research performed" }]);
    expect(draft.hypothesis.chosen.angle).toBe("");
    expect(draft.hypothesis.expected).toEqual({ metric: "views_72h", target: 1000, horizon_hours: 72 });
  });

  it("channel_package_draft: FAKE_ANGLE and FAKE_METRIC override the draft even without a channel_brief input", () => {
    const ws = tmpWorkspace();
    const thumbSet = dirInput(ws, "inputs/thumbnails", { "thumb-01.png": "x" }, "thumbnail_set");
    const req = makeRequest(ws, {
      stage_key: "package",
      inputs: [thumbSet],
      expected_outputs: [{ type: "channel_package_draft", mime_type: "application/json", kind: "file", name: "package.json" }],
    });
    const r = run(ws, req, { FAKE_ANGLE: "custom-angle", FAKE_METRIC: "avg_view_pct" });
    expect(r.status, `stderr: ${r.err}`).toBe(0);
    const draft = JSON.parse(readFileSync(join(ws, "output", "package.json"), "utf8"));
    expect(draft.hypothesis.chosen.angle).toBe("custom-angle");
    expect(draft.hypothesis.expected.metric).toBe("avg_view_pct");
  });
});

describe("channel-plan/SKILL.md (sub-project 3B, task 5)", () => {
  it("exists, mirrors channel-package's section outline, and is 80-110 lines", () => {
    const content = readFileSync(join(skillsDir, "channel-plan", "SKILL.md"), "utf8");
    for (const heading of ["## Mục tiêu", "## Input", "## Quy trình", "## Cấu trúc", "## Quy tắc", "## Điều cấm", "## Tự kiểm"]) {
      expect(content).toContain(heading);
    }
    const lineCount = content.split("\n").length;
    expect(lineCount).toBeGreaterThanOrEqual(80);
    expect(lineCount).toBeLessThanOrEqual(110);
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
