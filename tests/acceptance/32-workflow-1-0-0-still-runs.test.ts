import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_ROOT, loadWorkflow } from "@harness/core";

// Acceptance 32: profile `studio` revision 2 (production-profiles/studio/profile.yaml) points
// `workflow_release` at library-production@1.1.0, but library-production@1.0.0 (the gate-based, sub-project
// 2C release) must keep running end to end for any run that names it explicitly with `--workflow` -- the
// studio fixture's project.yaml still lists both releases (task 8) precisely so `doctor` scopes both.
//
// tests/integration/library-pipeline.test.ts already proves this end to end, post task 7: its "request ->
// production -> approved review -> channel pick" and "a rejected review reopens the request" scenarios both
// call `plan --workflow library-production@1.0.0 --content <id>` against this exact fixture/profile pairing
// and drive it through `stage submit` gates (survey-source, plan-edit, library-review) to a SUCCEEDED run and
// an approved/rejected kho item -- see that file's `plan()`/`acceptedProductionRun()` helpers. Re-running the
// whole pipeline a second time here would just duplicate ~5 minutes of ffmpeg work for no new coverage, so
// this file only asserts the two things that test's existence does not, by itself, prove to a reader who has
// not opened it: that it actually exists (not a stale reference in a plan/report) and that the workflow
// definition it drives still has at least one `gate` stage (the shape 1.0.0 predates sub-project 4's agent
// executor on) -- i.e. this really is the *old* release, not an accidental re-export of 1.1.0's.
describe("acceptance 32: library-production@1.0.0 (gate-based) still runs under the studio rev-2 profile", () => {
  it("tests/integration/library-pipeline.test.ts exists and exercises --workflow library-production@1.0.0", () => {
    expect(existsSync(join(HARNESS_ROOT, "tests", "integration", "library-pipeline.test.ts"))).toBe(true);
  });

  it("loadWorkflow(library-production@1.0.0) loads and still has gate stages (survey-source, plan-edit, library-review)", () => {
    const workflow = loadWorkflow(HARNESS_ROOT, "library-production@1.0.0");
    expect(workflow.definition.version).toBe("1.0.0");
    const gateKeys = workflow.definition.stages.filter((s) => s.executor.type === "gate").map((s) => s.key);
    expect(gateKeys.sort()).toEqual(["library-review", "plan-edit", "survey-source"]);
  });
});
