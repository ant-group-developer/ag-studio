import { describe, expect, it } from "vitest";
import { HARNESS_ROOT, loadProfile, loadWorkflow } from "../../src/index.js";

describe("channel-publish@1.0.0", () => {
  const wf = loadWorkflow(HARNESS_ROOT, "channel-publish@1.0.0");
  const profile = loadProfile(HARNESS_ROOT, "channel");

  it("has 5 stages in correct order and type", () => {
    expect(wf.definition.stages.map((s) => `${s.key}:${s.executor.type}`)).toEqual([
      "fetch-library-item:script",
      "package:agent",
      "build-package:script",
      "upload:script",
      "schedule:script",
    ]);
  });

  it("package stage is agent type with skill channel-package", () => {
    const packageStage = wf.definition.stages.find((s) => s.key === "package")!;
    expect(packageStage.executor.type).toBe("agent");
    expect(packageStage.executor.skill).toBe("channel-package");
  });

  it("upload and schedule stages require browser resources", () => {
    const uploadStage = wf.definition.stages.find((s) => s.key === "upload")!;
    const scheduleStage = wf.definition.stages.find((s) => s.key === "schedule")!;
    expect(uploadStage.requires_resources).toEqual(["browser"]);
    expect(scheduleStage.requires_resources).toEqual(["browser"]);
  });

  it("all stages have outputs with name fields", () => {
    for (const s of wf.definition.stages) {
      for (const o of s.outputs) {
        expect(o.name, `${s.key} output ${o.type}`).toBeTruthy();
      }
    }
  });

  it("profile channel parses (its workflow_release now tracks channel-publish@1.1.0, see channel-workflows-1-1.test.ts)", () => {
    expect(profile.workflow_release).toBe("channel-publish@1.1.0");
    expect(profile.reuse).toBe("never");
  });
});
