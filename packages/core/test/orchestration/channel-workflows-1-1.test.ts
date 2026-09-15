import { describe, expect, it } from "vitest";
import { HARNESS_ROOT, loadProfile, loadWorkflow } from "../../src/index.js";

describe("channel-planning@1.0.0", () => {
  const wf = loadWorkflow(HARNESS_ROOT, "channel-planning@1.0.0");
  const profile = loadProfile(HARNESS_ROOT, "channel-planning");

  it("has 4 stages in spec order and type, no gate", () => {
    expect(wf.definition.stages.map((s) => `${s.key}:${s.executor.type}`)).toEqual([
      "channel-brief:script",
      "demand:script",
      "propose-topics:agent",
      "create-requests:script",
    ]);
  });

  it("propose-topics is an agent stage using channel-plan, depends on channel-brief and demand, keeps topics-valid", () => {
    const s = wf.definition.stages.find((st) => st.key === "propose-topics")!;
    expect(s.executor).toMatchObject({ type: "agent", skill: "channel-plan" });
    expect(s.depends_on.sort()).toEqual(["channel-brief", "demand"]);
    expect(s.required_checks).toContain("topics-valid");
    expect(s.retry).toEqual({ max_attempts: 2, backoff_seconds: [60], retry_on: ["transient", "abandoned"] });
  });

  it("create-requests depends on propose-topics, demand, and channel-brief, and outputs requests_receipt", () => {
    const s = wf.definition.stages.find((st) => st.key === "create-requests")!;
    expect(s.executor).toEqual({ type: "script", script: "publish-create-requests" });
    expect(s.depends_on.sort()).toEqual(["channel-brief", "demand", "propose-topics"]);
    expect(s.outputs.some((o) => o.type === "requests_receipt")).toBe(true);
  });

  it("channel-brief and demand are script stages with no dependencies", () => {
    const brief = wf.definition.stages.find((st) => st.key === "channel-brief")!;
    const demand = wf.definition.stages.find((st) => st.key === "demand")!;
    expect(brief.executor).toEqual({ type: "script", script: "publish-channel-brief" });
    expect(brief.depends_on).toEqual([]);
    expect(demand.executor).toEqual({ type: "script", script: "publish-demand" });
    expect(demand.depends_on).toEqual([]);
    expect(brief.outputs.some((o) => o.type === "channel_brief")).toBe(true);
    expect(demand.outputs.some((o) => o.type === "demand")).toBe(true);
  });

  it("profile channel-planning points at channel-planning@1.0.0, reuse never", () => {
    expect(profile.workflow_release).toBe("channel-planning@1.0.0");
    expect(profile.revision).toBe(1);
    expect(profile.reuse).toBe("never");
  });
});

describe("channel-publish@1.1.0", () => {
  const wf = loadWorkflow(HARNESS_ROOT, "channel-publish@1.1.0");
  const profile = loadProfile(HARNESS_ROOT, "channel");

  it("has 6 stages, channel-brief inserted right after fetch-library-item and before package", () => {
    expect(wf.definition.stages.map((s) => `${s.key}:${s.executor.type}`)).toEqual([
      "fetch-library-item:script",
      "channel-brief:script",
      "package:agent",
      "build-package:script",
      "upload:script",
      "schedule:script",
    ]);
  });

  it("channel-brief depends on fetch-library-item and outputs channel_brief", () => {
    const s = wf.definition.stages.find((st) => st.key === "channel-brief")!;
    expect(s.executor).toEqual({ type: "script", script: "publish-channel-brief" });
    expect(s.depends_on).toEqual(["fetch-library-item"]);
    expect(s.outputs.some((o) => o.type === "channel_brief")).toBe(true);
  });

  it("package now depends on both fetch-library-item and channel-brief, and its brief mentions reading channel-brief.json first", () => {
    const s = wf.definition.stages.find((st) => st.key === "package")!;
    expect(s.executor).toMatchObject({ type: "agent", skill: "channel-package" });
    expect(s.depends_on.sort()).toEqual(["channel-brief", "fetch-library-item"]);
    expect(s.executor.type === "agent" && s.executor.brief).toContain("channel-brief.json");
  });

  it("profile channel points at channel-publish@1.1.0, revision 2, reuse never", () => {
    expect(profile.workflow_release).toBe("channel-publish@1.1.0");
    expect(profile.revision).toBe(2);
    expect(profile.reuse).toBe("never");
  });
});

describe("channel-publish@1.0.0 is untouched by the 1.1.0 release", () => {
  it("still has its original 5 stages, no channel-brief", () => {
    const wf = loadWorkflow(HARNESS_ROOT, "channel-publish@1.0.0");
    expect(wf.definition.stages.map((s) => s.key)).toEqual([
      "fetch-library-item",
      "package",
      "build-package",
      "upload",
      "schedule",
    ]);
  });
});
