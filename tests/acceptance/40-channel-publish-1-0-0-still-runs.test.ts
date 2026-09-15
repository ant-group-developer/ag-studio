import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_ROOT, loadWorkflow } from "@harness/core";

// Acceptance 40 (spec §7, mirroring acceptance 32 for sub-project 4): production profile `channel` is now
// revision 2 and points `workflow_release` at channel-publish@1.1.0, but channel-publish@1.0.0 -- the
// sub-project 3 release, with no `channel-brief` stage and therefore no learning in the loop -- must keep
// running end to end for any run that names it with `--workflow`. `fixtures/ops-project-channel/project.yaml`
// still lists both releases (task 7) precisely so `doctor` keeps scoping 1.0.0 too.
//
// tests/integration/publish-pipeline.test.ts and acceptance 21-26 already drive 1.0.0 for real (fetch ->
// package -> build-package -> upload -> schedule, two channels, a real legacy repo), all through
// `publish-helpers.ts`'s `pickAndPlan`, which pins `--workflow channel-publish@1.0.0` explicitly rather than
// taking the profile's own release. Re-running that pipeline here would duplicate minutes of ffmpeg work for
// no new coverage, so this file asserts only what their existence does not, by itself, prove to a reader who
// has not opened them: that they exist, that the release they name is still pinned to 1.0.0, and that 1.0.0
// really is the *old* shape (no `channel-brief`), not an accidental re-export of 1.1.0's.
describe("acceptance 40: channel-publish@1.0.0 still runs under the channel rev-2 profile", () => {
  it("loadWorkflow(channel-publish@1.0.0) has the sub-project 3 stages and no channel-brief", () => {
    const workflow = loadWorkflow(HARNESS_ROOT, "channel-publish@1.0.0");
    expect(workflow.definition.version).toBe("1.0.0");
    const keys = workflow.definition.stages.map((s) => s.key);
    expect(keys).toEqual(["fetch-library-item", "package", "build-package", "upload", "schedule"]);
    expect(keys).not.toContain("channel-brief");
    // and the `package` stage still depends only on the item it packages -- no channel_brief input
    const pkg = workflow.definition.stages.find((s) => s.key === "package")!;
    expect(pkg.depends_on).toEqual(["fetch-library-item"]);
  });

  it("channel-publish@1.1.0 is the one that adds channel-brief ahead of package", () => {
    const workflow = loadWorkflow(HARNESS_ROOT, "channel-publish@1.1.0");
    const brief = workflow.definition.stages.find((s) => s.key === "channel-brief");
    expect(brief, "1.1.0 must have the channel-brief stage 1.0.0 lacks").toBeDefined();
    expect(workflow.definition.stages.find((s) => s.key === "package")!.depends_on).toEqual(["fetch-library-item", "channel-brief"]);
  });

  it("the sub-project 3 tests still exist and still pin --workflow channel-publish@1.0.0", () => {
    const pipeline = join(HARNESS_ROOT, "tests", "integration", "publish-pipeline.test.ts");
    expect(existsSync(pipeline)).toBe(true);
    expect(readFileSync(pipeline, "utf8")).toContain("pickAndPlan");

    const helpers = readFileSync(join(HARNESS_ROOT, "tests", "integration", "publish-helpers.ts"), "utf8");
    expect(helpers, "pickAndPlan must keep naming 1.0.0 explicitly, not follow the profile to 1.1.0")
      .toContain('"--workflow", "channel-publish@1.0.0"');
  });
});
