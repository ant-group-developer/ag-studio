import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { newId, type StageRequest, type StageResult } from "@harness/contracts";
import { compositionCheckers, HARNESS_ROOT, NullMediaProber, sha256File } from "@harness/core";

// Task-8 fix round 1, item 2: the fake agent's OWN `overlays.json`/`narration.json`/`edl.json` run through
// the real `overlays-valid` checker, in the same workspace, exactly as the Verifier sees them at
// `plan-edit`. `fake-agent-outputs.test.ts` only asserts the fixture's output SHAPE (it lives in the
// agent-cli package, which does not depend on `@harness/core`); this closes the loop -- if a fixture mode
// and the checker ever drift apart, integration test 48's replan path silently stops meaning anything.
// It lives in the cli package because that is where both `@harness/core` and the fixture are reachable.

const FIXTURE = join(HARNESS_ROOT, "fixtures", "fake-agent-cli.mjs");
const SHA = "sha256:" + "a".repeat(64);

const PLAN_EDIT_OUTPUTS = [
  { type: "edl", mime_type: "application/json", kind: "file" as const, name: "edl.json" },
  { type: "edit_plan", mime_type: "application/json", kind: "file" as const, name: "edit-plan.json" },
  { type: "narration", mime_type: "application/json", kind: "file" as const, name: "narration.json" },
  { type: "overlays", mime_type: "application/json", kind: "file" as const, name: "overlays.json", optional: true },
];

/** A `harness.shots/v2` document with `sources.length` sources, each one shot of `shotSeconds` -- the EDL
 * the fixture builds from it is one entry per source, so `sources * shotSeconds` is the density budget's
 * screen time. */
function shotsV2(sourceIds: string[], shotSeconds: number): string {
  return JSON.stringify({
    schema_version: "harness.shots/v2",
    sources: sourceIds.map((id, i) => ({
      source_id: id, index: i, file_name: `clip${i}.mp4`, duration_seconds: shotSeconds * 2, has_audio: true,
      shots: [{ shot_id: `s${String(i).padStart(3, "0")}-000`, in: 0, out: shotSeconds }],
    })),
  });
}

function fileInput(ws: string, relPath: string, content: string, type: string) {
  const abs = join(ws, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return { artifact_id: newId("artifact"), checksum: SHA, path: relPath, type, kind: "file" as const };
}

function makeRequest(ws: string, inputs: StageRequest["inputs"]): StageRequest {
  return {
    schema_version: "harness.stage-request/v1",
    run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"),
    project_id: "project-studio", portfolio_id: "portfolio-studio", stage_key: "plan-edit",
    workflow: { id: "library-production", version: "1.3.0", digest: SHA },
    profile_snapshot: { id: "studio", revision: 4 },
    inputs, workspace_uri: ws, stage_config: {}, options: {}, source_items: [], resources: [],
    expected_outputs: PLAN_EDIT_OUTPUTS, policy: {},
    limits: { deadline_at: new Date(Date.now() + 600_000).toISOString(), max_cost_usd: 5, max_attempts: 3 },
    capabilities: [], fencing_token: 1,
  };
}

/** Spawns the fixture, then collects whatever it actually wrote into a `StageResult` -- the same way
 * `CliAgentRuntime` does, including skipping an absent OPTIONAL output. */
async function runPlanEdit(o: { env?: Record<string, string>; sources?: number; shotSeconds?: number; voice?: "none" | "tts" }): Promise<{ ws: string; request: StageRequest; result: StageResult }> {
  const ws = mkdtempSync(join(tmpdir(), "fake-overlays-"));
  const sourceIds = Array.from({ length: o.sources ?? 2 }, () => newId("source_item"));
  const inputs = [
    fileInput(ws, "inputs/shots.json", shotsV2(sourceIds, o.shotSeconds ?? 10), "shots"),
    fileInput(ws, "inputs/brief.json", JSON.stringify({
      request_id: newId("content_request"), topic: "chợ nổi", style_id: newId("edit_style"), style_revision: 1,
      voice: o.voice ?? "tts", language: "vi", request_notes: "",
    }), "brief"),
  ];
  const request = makeRequest(ws, inputs);
  writeFileSync(join(ws, "agent-prompt.md"), "fake prompt for tests\n");
  writeFileSync(join(ws, "stage-request.json"), JSON.stringify(request, null, 2));
  const spawned = spawnSync(process.execPath, [FIXTURE], { cwd: ws, env: { ...process.env, ...(o.env ?? {}) }, encoding: "utf8" });
  expect(spawned.status, `stderr: ${spawned.stderr}`).toBe(0);

  const outputs: StageResult["outputs"] = [];
  for (const eo of PLAN_EDIT_OUTPUTS) {
    const rel = `output/${eo.name}`;
    const abs = join(ws, rel);
    if (!existsSync(abs)) {
      expect(eo.optional, `agent wrote no ${rel} but it is not optional`).toBe(true);
      continue;
    }
    outputs.push({ path: rel, type: eo.type, ...(await sha256File(abs)), kind: "file" });
  }
  const result: StageResult = {
    schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outcome: "succeeded",
    outputs, checks: [], usage: { wall_seconds: 1, cost_usd: 0 }, external_operations: [], errors: [],
  };
  return { ws, request, result };
}

function overlaysValid() {
  const checker = compositionCheckers({ prober: new NullMediaProber(), available: false, ffmpeg: "ffmpeg" }).find((c) => c.id === "overlays-valid");
  if (!checker) throw new Error("overlays-valid checker not registered");
  return checker;
}

describe("fake-agent-cli.mjs plan-edit outputs through the real overlays-valid checker", () => {
  it("FAKE_OVERLAYS=medium (default) passes", async () => {
    const { ws, request, result } = await runPlanEdit({});
    const outcome = await overlaysValid().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict, JSON.stringify(outcome.evidence)).toBe("pass");
    // 2 sources x 10 s = 20 s of picture -> medium spacing 8 -> limit 2, which is what `medium` writes.
    const overlays = JSON.parse(readFileSync(join(ws, "output", "overlays.json"), "utf8")) as { items: unknown[] };
    expect(overlays.items).toHaveLength(2);
  });

  it("FAKE_OVERLAYS=medium passes on a voice: none plan too (empty narration.json scores the EDL, not zero)", async () => {
    const { ws, request, result } = await runPlanEdit({ voice: "none" });
    const narration = JSON.parse(readFileSync(join(ws, "output", "narration.json"), "utf8")) as { lines: unknown[] };
    expect(narration.lines).toEqual([]);
    const outcome = await overlaysValid().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict, JSON.stringify(outcome.evidence)).toBe("pass");
  });

  // The density ruling in the fix round: three short clips give a budget of exactly 1, and `medium` now
  // drops the callout rather than writing a plan the checker must reject.
  it("FAKE_OVERLAYS=medium trims itself to the density budget on a short shoot", async () => {
    const { ws, request, result } = await runPlanEdit({ sources: 3, shotSeconds: 2.5 });
    const overlays = JSON.parse(readFileSync(join(ws, "output", "overlays.json"), "utf8")) as { items: unknown[] };
    expect(overlays.items).toHaveLength(1);
    const outcome = await overlaysValid().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict, JSON.stringify(outcome.evidence)).toBe("pass");
  });

  it("FAKE_OVERLAYS=dense fails, naming the density limit it blew past", async () => {
    const { ws, request, result } = await runPlanEdit({ env: { FAKE_OVERLAYS: "dense" } });
    const outcome = await overlaysValid().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.evidence.reason).toBe("overlay density exceeds limit");
    expect(outcome.evidence.limit).toBe(2);
    expect(outcome.evidence.actual).toBe(30);
  });

  it("FAKE_OVERLAYS=invalid fails, naming the line_id no narration has", async () => {
    const { ws, request, result } = await runPlanEdit({ env: { FAKE_OVERLAYS: "invalid" } });
    const outcome = await overlaysValid().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.evidence.reason).toBe("anchor line_id not found");
    expect(outcome.evidence.line_id).toBe("L999");
  });

  it("FAKE_OVERLAYS=none writes no overlays.json at all, so the checker SKIPS (a plan with no text is legitimate)", async () => {
    const { ws, request, result } = await runPlanEdit({ env: { FAKE_OVERLAYS: "none" } });
    expect(existsSync(join(ws, "output", "overlays.json"))).toBe(false);
    expect(result.outputs.map((o) => o.type)).not.toContain("overlays");
    const outcome = await overlaysValid().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("skip");
  });
});
