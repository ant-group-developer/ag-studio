import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type Checker, type Edl, type MediaProbe, type MediaProber, type Narration, type Overlays, type StageRequest, type StageResult } from "@harness/contracts";
import { compositionCheckers } from "../../src/index.js";

const sha = "sha256:" + "a".repeat(64);
const SRC_A = "src_01JAAAAAAAAAAAAAAAAAAAAAAA";

class FakeMediaProber implements MediaProber {
  async probe(): Promise<MediaProbe | null> {
    return null;
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
    stage_key: "plan-edit",
    workflow: { id: "library-production", version: "1.3.0", digest: sha },
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
  return mkdtempSync(join(tmpdir(), "overlays-valid-ws-"));
}

function narrationJson(): Narration {
  // Long enough that the default density (medium, vi cps=14) allows at least 2 items: 400 chars / 14 = ~28.6s
  // spoken, floor(28.6 / 8) = 3.
  return {
    schema_version: "harness.narration/v1",
    language: "en",
    lines: [
      { line_id: "L001", edl_order: 0, text: "hello there world ".repeat(11).trim() },
      { line_id: "L002", edl_order: 1, text: "second line of narration ".repeat(8).trim() },
    ],
  };
}

function edlJson(orders: number[]): Edl {
  return { schema_version: "harness.edl/v1", entries: orders.map((order) => ({ source_id: SRC_A, in: order * 5, out: order * 5 + 5, order, overlay: null, note: "" })) };
}

function overlaysJson(items: Overlays["items"], transitions: Overlays["transitions"] = []): Overlays {
  return { schema_version: "harness.overlays/v1", items, transitions };
}

/** Writes `output/overlays.json` (optional, type `overlays`) plus the plan-edit stage's own `output/narration.json`
 * and `output/edl.json` (type `narration`/`edl`) -- `overlays-valid` reads all three from the SAME stage result,
 * per spec §3 (there is no `timeline.json` yet at `plan-edit`). */
function fixture(ws: string, o: { overlays?: Overlays; narration?: Narration; edl?: Edl; editStyleDensity?: "none" | "low" | "medium" | "high"; language?: string }): { request: StageRequest; result: StageResult } {
  mkdirSync(join(ws, "input"), { recursive: true });
  mkdirSync(join(ws, "output"), { recursive: true });

  const outputs: StageResult["outputs"] = [];
  if (o.overlays !== undefined) {
    writeFileSync(join(ws, "output", "overlays.json"), JSON.stringify(o.overlays));
    outputs.push({ path: "output/overlays.json", type: "overlays", checksum: sha, size_bytes: 1, kind: "file" });
  }
  const narration = o.narration ?? narrationJson();
  writeFileSync(join(ws, "output", "narration.json"), JSON.stringify(narration));
  outputs.push({ path: "output/narration.json", type: "narration", checksum: sha, size_bytes: 1, kind: "file" });

  const edl = o.edl ?? edlJson([0, 1]);
  writeFileSync(join(ws, "output", "edl.json"), JSON.stringify(edl));
  outputs.push({ path: "output/edl.json", type: "edl", checksum: sha, size_bytes: 1, kind: "file" });

  const inputs: StageRequest["inputs"] = [];
  if (o.editStyleDensity !== undefined) {
    const editStyle = {
      schema_version: "harness.edit-style/v1",
      style_id: newId("edit_style"),
      revision: 1,
      name: "style",
      status: "active",
      learned_from: [],
      params: {
        cut_rhythm: "medium",
        shot_seconds: [2, 6],
        transitions: [],
        text_overlay: { style: "clean", density: o.editStyleDensity },
        subtitles: "burn-in",
        music: { mood: "calm", ducking: true },
        opening: { seconds: 3, structure: "hook" },
        aspect_ratio: "16:9",
        pace_notes: "",
      },
      evidence: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    writeFileSync(join(ws, "input", "edit-style.json"), JSON.stringify(editStyle));
    inputs.push({ artifact_id: newId("artifact"), checksum: sha, path: "input/edit-style.json", type: "edit_style", kind: "file" });
  }
  if (o.language !== undefined) {
    const brief = { topic: "t", style_id: newId("edit_style"), style_revision: 1, voice: "tts", language: o.language };
    writeFileSync(join(ws, "input", "brief.json"), JSON.stringify(brief));
    inputs.push({ artifact_id: newId("artifact"), checksum: sha, path: "input/brief.json", type: "brief", kind: "file" });
  }

  return { request: baseRequest({ inputs }), result: baseResult(outputs) };
}

function checker(): Checker {
  return checkerById(compositionCheckers({ prober: new FakeMediaProber() }), "overlays-valid");
}

describe("overlays-valid", () => {
  it("skips when there is no overlays output", async () => {
    const ws = tmpWorkspace();
    const { request, result } = fixture(ws, {});
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome).toEqual({ verdict: "skip", evidence: { reason: "no matching output" } });
    rmSync(ws, { recursive: true, force: true });
  });

  it("passes a well-formed overlays.json", async () => {
    const ws = tmpWorkspace();
    const overlays = overlaysJson(
      [
        { id: "OV01", kind: "title", text: "Tieu de", anchor: { line_id: "L001" } },
        { id: "OV02", kind: "callout", text: "42%", anchor: { edl_order: 1 } },
      ],
      [{ before_order: 1, kind: "dissolve" }],
    );
    const { request, result } = fixture(ws, { overlays });
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("pass");
    rmSync(ws, { recursive: true, force: true });
  });

  it("fails with the offending id when a callout exceeds its 24-char limit", async () => {
    const ws = tmpWorkspace();
    const overlays = overlaysJson([{ id: "OV01", kind: "callout", text: "a".repeat(30), anchor: { edl_order: 0 } }]);
    const { request, result } = fixture(ws, { overlays });
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.evidence.id).toBe("OV01");
    rmSync(ws, { recursive: true, force: true });
  });

  it("fails when two titles resolve to the same edl_order", async () => {
    const ws = tmpWorkspace();
    const overlays = overlaysJson([
      { id: "OV01", kind: "title", text: "First", anchor: { line_id: "L001" } }, // L001 -> edl_order 0
      { id: "OV02", kind: "title", text: "Second", anchor: { edl_order: 0 } },
    ]);
    const { request, result } = fixture(ws, { overlays });
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.evidence.reason).toBe("more than one title per edl_order");
    rmSync(ws, { recursive: true, force: true });
  });

  it("fails when an anchor's line_id does not exist in the narration output", async () => {
    const ws = tmpWorkspace();
    const overlays = overlaysJson([{ id: "OV01", kind: "title", text: "Hi", anchor: { line_id: "L999" } }]);
    const { request, result } = fixture(ws, { overlays });
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.evidence.reason).toBe("anchor line_id not found");
    rmSync(ws, { recursive: true, force: true });
  });

  it("fails with the limit when the item count exceeds the density limit for medium (default)", async () => {
    const ws = tmpWorkspace();
    // narration totals 300 chars (150 + 150); en cps 15 -> 20s spoken; medium spacing 8 -> floor(20/8) = 2.
    const narration: Narration = {
      schema_version: "harness.narration/v1",
      language: "en",
      lines: [
        { line_id: "L001", edl_order: 0, text: "a".repeat(150) },
        { line_id: "L002", edl_order: 1, text: "b".repeat(150) },
      ],
    };
    const edl = edlJson(Array.from({ length: 20 }, (_, i) => i));
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `OV${String(i + 1).padStart(2, "0")}`, kind: "callout" as const, text: "x", anchor: { edl_order: i } }));
    const overlays = overlaysJson(items);
    const { request, result } = fixture(ws, { overlays, narration, edl, language: "en" });
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.evidence.reason).toBe("overlay density exceeds limit");
    expect(outcome.evidence.limit).toBe(2);
    rmSync(ws, { recursive: true, force: true });
  });
});
