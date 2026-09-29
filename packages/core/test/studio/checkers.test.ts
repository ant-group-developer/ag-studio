import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CheckerInput } from "@harness/contracts";
import { selectionValidChecker, STUDIO_TYPES, timelineValidChecker } from "../../src/verification/studio-checkers.js";
import { buildStudioTimeline } from "../../src/studio/build-timeline.js";
import { setLineText } from "../../src/studio/layout.js";
import { brief, catalog, narration, selection, treatment } from "./fixtures.js";

function workspace(inputs: Record<string, unknown>, outputs: Record<string, unknown>): CheckerInput {
  const ws = mkdtempSync(join(tmpdir(), "studio-check-"));
  mkdirSync(join(ws, "in"), { recursive: true });
  mkdirSync(join(ws, "output"), { recursive: true });
  const req = { inputs: [] as { path: string; type: string }[] };
  for (const [type, v] of Object.entries(inputs)) { writeFileSync(join(ws, "in", `${type}.json`), JSON.stringify(v)); req.inputs.push({ path: `in/${type}.json`, type }); }
  const res = { outputs: [] as { path: string; type: string }[] };
  for (const [type, v] of Object.entries(outputs)) { writeFileSync(join(ws, "output", `${type}.json`), JSON.stringify(v)); res.outputs.push({ path: `output/${type}.json`, type }); }
  return { request: req, result: res, workspaceDir: ws } as unknown as CheckerInput;
}

describe("studio checkers through the Checker interface", () => {
  const inputs = { [STUDIO_TYPES.brief]: brief(), [STUDIO_TYPES.catalog]: catalog(), [STUDIO_TYPES.treatment]: treatment() };

  it("selection-valid passes a good selection and fails with the problem list otherwise", async () => {
    expect((await selectionValidChecker.check(workspace(inputs, { [STUDIO_TYPES.selection]: selection() }))).verdict).toBe("pass");
    const bad = selection();
    bad.beats[0]!.picks[0]!.segment_id = "nope";
    const r = await selectionValidChecker.check(workspace(inputs, { [STUDIO_TYPES.selection]: bad }));
    expect(r.verdict).toBe("fail");
    expect(JSON.stringify(r.evidence)).toContain("unknown_segment");
  });

  it("selection-valid fails (not throws) when an input it needs is missing", async () => {
    const r = await selectionValidChecker.check(workspace({ [STUDIO_TYPES.brief]: brief() }, { [STUDIO_TYPES.selection]: selection() }));
    expect(r).toEqual({ verdict: "fail", evidence: { reason: `missing input ${STUDIO_TYPES.catalog}` } });
  });

  it("timeline-valid blocks a timeline with an unvoiced line", async () => {
    const audio = new Map(narration().lines.map((l) => [l.line_id, { key: `audio/${l.line_id}.wav`, duration: 1.5 }]));
    const t = buildStudioTimeline({ brief: brief(), treatment: treatment(), catalog: catalog().segments, selection: selection(), narration: narration(), audio });
    expect((await timelineValidChecker.check(workspace({ [STUDIO_TYPES.brief]: brief() }, { [STUDIO_TYPES.timeline]: t }))).verdict).toBe("pass");
    const r = await timelineValidChecker.check(workspace({ [STUDIO_TYPES.brief]: brief() }, { [STUDIO_TYPES.timeline]: setLineText(t, "L002", "Câu khác") }));
    expect(r.verdict).toBe("fail");
    expect(JSON.stringify(r.evidence)).toContain("narration_not_voiced");
  });
});
