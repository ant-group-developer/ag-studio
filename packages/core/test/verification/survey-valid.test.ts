import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type Checker, type MediaProbe, type MediaProber, type StageRequest, type StageResult } from "@harness/contracts";
import { libraryCheckers } from "../../src/index.js";

const sha = "sha256:" + "a".repeat(64);

class FakeMediaProber implements MediaProber {
  constructor(private readonly probes: Map<string, MediaProbe | null> = new Map()) {}
  async probe(path: string): Promise<MediaProbe | null> {
    return this.probes.get(path) ?? null;
  }
}

function baseRequest(overrides: Partial<StageRequest> = {}): StageRequest {
  return {
    schema_version: "harness.stage-request/v1",
    run_id: newId("run"),
    stage_run_id: newId("stage_run"),
    attempt_id: newId("attempt"),
    project_id: "p",
    portfolio_id: "pf",
    stage_key: "survey",
    workflow: { id: "studio-media", version: "1.0.0", digest: sha },
    profile_snapshot: { id: "studio", revision: 1 },
    inputs: [],
    workspace_uri: "",
    stage_config: {},
    options: {},
    source_items: [],
    resources: [],
    expected_outputs: [],
    policy: {},
    limits: { deadline_at: "2026-09-14T01:00:00.000Z", max_cost_usd: 5, max_attempts: 3 },
    capabilities: [],
    fencing_token: 1,
    ...overrides,
  };
}

function baseResult(outputs: StageResult["outputs"]): StageResult {
  return {
    schema_version: "harness.stage-result/v1",
    attempt_id: newId("attempt"),
    outcome: "succeeded",
    outputs,
    checks: [],
    usage: { wall_seconds: 1, cost_usd: 0 },
    external_operations: [],
    errors: [],
  };
}

function checkerById(checkers: Checker[], id: string): Checker {
  const c = checkers.find((c) => c.id === id);
  if (!c) throw new Error(`no checker ${id}`);
  return c;
}

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "survey-valid-ws-"));
}

function shotsIndexJson(sourceId: string, shots: { shot_id: string; in: number; out: number }[]) {
  return {
    schema_version: "harness.shots/v2",
    sources: [{ source_id: sourceId, index: 0, file_name: "a.mp4", duration_seconds: 10, has_audio: true, shots }],
  };
}

function surveyV2Json(shots: { source_id: string; shot_id: string; in: number; out: number }[]) {
  return {
    schema_version: "harness.survey-index/v2",
    shots: shots.map((s) => ({ ...s, score: 3, tags: [], usable: true, note: "", speech: "talking" })),
  };
}

function surveyV1Json() {
  return {
    schema_version: "harness.survey-index/v1",
    shots: [{ in: 0, out: 2, score: 4, tags: [], usable: true, note: "" }],
  };
}

/** Writes `output/survey.json` (always) and, when `shots` is given, `input/shots.json` plus a matching
 * `type: "shots"` request input -- the two workspace files `survey-valid` reads. */
function fixture(ws: string, o: { survey: unknown; shots?: unknown }): { request: StageRequest; result: StageResult } {
  mkdirSync(join(ws, "input"), { recursive: true });
  mkdirSync(join(ws, "output"), { recursive: true });
  writeFileSync(join(ws, "output", "survey.json"), JSON.stringify(o.survey));

  const inputs: StageRequest["inputs"] = [];
  if (o.shots !== undefined) {
    writeFileSync(join(ws, "input", "shots.json"), JSON.stringify(o.shots));
    inputs.push({ artifact_id: newId("artifact"), checksum: sha, path: "input/shots.json", type: "shots", kind: "file" });
  }

  const request = baseRequest({ inputs });
  const result = baseResult([{ path: "output/survey.json", type: "survey", checksum: sha, size_bytes: 1, kind: "file" }]);
  return { request, result };
}

function checker(): Checker {
  return checkerById(libraryCheckers(new FakeMediaProber()), "survey-valid");
}

describe("survey-valid", () => {
  it("skips when there is no survey output", async () => {
    const ws = tmpWorkspace();
    const request = baseRequest();
    const result = baseResult([{ path: "output/thumb.png", type: "thumbnail", checksum: sha, size_bytes: 1, kind: "file" }]);
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome).toEqual({ verdict: "skip", evidence: { reason: "no matching output" } });
    rmSync(ws, { recursive: true, force: true });
  });

  it("v1: passes without needing a shots input (schema-1.1.0 behavior unchanged)", async () => {
    const ws = tmpWorkspace();
    const { request, result } = fixture(ws, { survey: surveyV1Json() });
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome).toEqual({ verdict: "pass", evidence: { checked: ["output/survey.json"] } });
    rmSync(ws, { recursive: true, force: true });
  });

  it("v2: passes when every shot matches the shots input (shot_id present, source_id matches, in/out exact)", async () => {
    const ws = tmpWorkspace();
    const sourceId = newId("source_item");
    const shots = shotsIndexJson(sourceId, [{ shot_id: "s000-000", in: 0, out: 2 }]);
    const survey = surveyV2Json([{ source_id: sourceId, shot_id: "s000-000", in: 0, out: 2 }]);
    const { request, result } = fixture(ws, { survey, shots });
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome).toEqual({ verdict: "pass", evidence: { checked: ["output/survey.json"] } });
    rmSync(ws, { recursive: true, force: true });
  });

  it("v2: passes when in/out drift is within the 0.05s tolerance (0.04s off)", async () => {
    const ws = tmpWorkspace();
    const sourceId = newId("source_item");
    const shots = shotsIndexJson(sourceId, [{ shot_id: "s000-000", in: 0, out: 2 }]);
    const survey = surveyV2Json([{ source_id: sourceId, shot_id: "s000-000", in: 0.04, out: 2 }]);
    const { request, result } = fixture(ws, { survey, shots });
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome).toEqual({ verdict: "pass", evidence: { checked: ["output/survey.json"] } });
    rmSync(ws, { recursive: true, force: true });
  });

  it("v2: fails with 'in/out mismatch' when in/out drift exceeds the 0.05s tolerance (0.2s off)", async () => {
    const ws = tmpWorkspace();
    const sourceId = newId("source_item");
    const shots = shotsIndexJson(sourceId, [{ shot_id: "s000-000", in: 0, out: 2 }]);
    const survey = surveyV2Json([{ source_id: sourceId, shot_id: "s000-000", in: 0.2, out: 2 }]);
    const { request, result } = fixture(ws, { survey, shots });
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.evidence.reason).toBe("in/out mismatch");
    expect(outcome.evidence.shot_id).toBe("s000-000");
    rmSync(ws, { recursive: true, force: true });
  });

  it("v2: fails with 'unknown shot_id' when the survey references a shot_id absent from shots.json", async () => {
    const ws = tmpWorkspace();
    const sourceId = newId("source_item");
    const shots = shotsIndexJson(sourceId, [{ shot_id: "s000-000", in: 0, out: 2 }]);
    const survey = surveyV2Json([{ source_id: sourceId, shot_id: "s000-999", in: 0, out: 2 }]);
    const { request, result } = fixture(ws, { survey, shots });
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.evidence.reason).toBe("unknown shot_id");
    expect(outcome.evidence.shot_id).toBe("s000-999");
    rmSync(ws, { recursive: true, force: true });
  });

  it("v2: fails with 'source_id mismatch' when a known shot_id belongs to a different source", async () => {
    const ws = tmpWorkspace();
    const realOwnerId = newId("source_item");
    const wrongOwnerId = newId("source_item");
    const shots = shotsIndexJson(realOwnerId, [{ shot_id: "s000-000", in: 0, out: 2 }]);
    const survey = surveyV2Json([{ source_id: wrongOwnerId, shot_id: "s000-000", in: 0, out: 2 }]);
    const { request, result } = fixture(ws, { survey, shots });
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.evidence.reason).toBe("source_id mismatch");
    expect(outcome.evidence.shot_id).toBe("s000-000");
    expect(outcome.evidence.expected).toBe(realOwnerId);
    expect(outcome.evidence.actual).toBe(wrongOwnerId);
    rmSync(ws, { recursive: true, force: true });
  });

  it("v2: fails with 'no shots input' when the run has no shots input at all", async () => {
    const ws = tmpWorkspace();
    const sourceId = newId("source_item");
    const survey = surveyV2Json([{ source_id: sourceId, shot_id: "s000-000", in: 0, out: 2 }]);
    const { request, result } = fixture(ws, { survey });
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome).toEqual({ verdict: "fail", evidence: { reason: "no shots input" } });
    rmSync(ws, { recursive: true, force: true });
  });

  it("fails with 'invalid survey' when survey.json does not match either schema shape", async () => {
    const ws = tmpWorkspace();
    const { request, result } = fixture(ws, { survey: { schema_version: "harness.survey-index/v1", shots: [] } });
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.evidence.reason).toBe("invalid survey");
    rmSync(ws, { recursive: true, force: true });
  });

  it("v2: fails with 'invalid shots input' when shots.json does not parse against ShotsIndexSchema", async () => {
    const ws = tmpWorkspace();
    const sourceId = newId("source_item");
    const survey = surveyV2Json([{ source_id: sourceId, shot_id: "s000-000", in: 0, out: 2 }]);
    const { request, result } = fixture(ws, { survey, shots: { schema_version: "harness.shots/v2", sources: [] } });
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.evidence.reason).toBe("invalid shots input");
    rmSync(ws, { recursive: true, force: true });
  });
});
