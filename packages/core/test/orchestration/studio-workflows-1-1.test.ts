import { describe, expect, it } from "vitest";
import { HARNESS_ROOT, loadProfile, loadWorkflow, resolveStageGraph } from "../../src/index.js";

describe("style-study@1.1.0", () => {
  const wf = loadWorkflow(HARNESS_ROOT, "style-study@1.1.0");

  it("loads with five stages in order, agent stages carrying the right skill", () => {
    expect(wf.definition.stages.map((s) => `${s.key}:${s.executor.type}`)).toEqual([
      "collect-samples:script",
      "watch-samples:script",
      "analyze-style:agent",
      "style-review:agent",
      "style-export:script",
    ]);
    const analyze = wf.definition.stages.find((s) => s.key === "analyze-style")!;
    expect(analyze.executor).toMatchObject({ type: "agent", skill: "style-analyze" });
    const review = wf.definition.stages.find((s) => s.key === "style-review")!;
    expect(review.executor).toMatchObject({ type: "agent", skill: "style-review" });
    for (const s of wf.definition.stages) expect(s.executor.type).not.toBe("gate");
  });

  it("agent stages carry the spec retry policy", () => {
    for (const key of ["analyze-style", "style-review"]) {
      const s = wf.definition.stages.find((st) => st.key === key)!;
      expect(s.retry).toEqual({ max_attempts: 2, backoff_seconds: [60], retry_on: ["transient", "abandoned"] });
    }
  });
});

describe("library-production@1.1.0", () => {
  const wf = loadWorkflow(HARNESS_ROOT, "library-production@1.1.0");
  const profile = loadProfile(HARNESS_ROOT, "studio");

  it("has the thirteen stages of spec order, none of them a gate", () => {
    expect(wf.definition.stages.map((s) => s.key)).toEqual([
      "intake",
      "index-source",
      "watch-source",
      "survey-source",
      "plan-edit",
      "tts",
      "cut",
      "assemble",
      "watch-episode",
      "thumbnail-candidates",
      "library-export",
      "library-review",
      "library-apply-review",
    ]);
    for (const s of wf.definition.stages) expect(s.executor.type, s.key).not.toBe("gate");
  });

  it("survey-source is an agent stage using source-survey, no gate deadline, and depends on watch-source", () => {
    const s = wf.definition.stages.find((st) => st.key === "survey-source")!;
    expect(s.executor).toMatchObject({ type: "agent", skill: "source-survey" });
    expect(s.gate_deadline_seconds).toBeUndefined();
    expect(s.depends_on.sort()).toEqual(["index-source", "intake", "watch-source"]);
    expect(s.retry).toEqual({ max_attempts: 2, backoff_seconds: [60], retry_on: ["transient", "abandoned"] });
    expect(s.outputs.some((o) => o.type === "survey_index")).toBe(true);
  });

  it("plan-edit is an agent stage using edit-plan and keeps edl-valid in required_checks", () => {
    const s = wf.definition.stages.find((st) => st.key === "plan-edit")!;
    expect(s.executor).toMatchObject({ type: "agent", skill: "edit-plan" });
    expect(s.depends_on.sort()).toEqual(["index-source", "intake", "survey-source", "watch-source"]);
    expect(s.required_checks).toContain("edl-valid");
    expect(s.retry).toEqual({ max_attempts: 2, backoff_seconds: [60], retry_on: ["transient", "abandoned"] });
  });

  it("watch-episode runs after assemble and library-review watches it", () => {
    const watchEpisode = wf.definition.stages.find((st) => st.key === "watch-episode")!;
    expect(watchEpisode.executor).toEqual({ type: "script", script: "watch-episode" });
    expect(watchEpisode.depends_on).toEqual(["assemble"]);
    expect(watchEpisode.outputs.some((o) => o.type === "watch")).toBe(true);
    // ffmpeg-bound like every other watch stage (`watch-source` here, `watch-samples` in style-study@1.1.0):
    // it must contend for `cpu` too, or it is the one stage that can pile on top of a saturated machine.
    expect(watchEpisode.requires_resources).toEqual(["cpu"]);

    const review = wf.definition.stages.find((st) => st.key === "library-review")!;
    expect(review.executor).toMatchObject({ type: "agent", skill: "library-review" });
    expect(review.gate_deadline_seconds).toBeUndefined();
    expect(review.depends_on.sort()).toEqual(["intake", "library-export", "plan-edit", "watch-episode"]);
    expect(review.retry).toEqual({ max_attempts: 2, backoff_seconds: [60], retry_on: ["transient", "abandoned"] });
  });

  it("assemble is unchanged: still requires brief-duration and depends on intake", () => {
    const assemble = wf.definition.stages.find((s) => s.key === "assemble")!;
    expect(assemble.required_checks).toContain("brief-duration");
    expect(assemble.depends_on).toContain("intake");
  });

  it("voice=none drops tts and keeps the rest of the graph resolvable", () => {
    const g = resolveStageGraph(wf.definition.stages, { voice: "none", subtitles: "false" });
    expect(g.skipped).toEqual(["tts"]);
  });

  it("profile studio itself has since moved to library-production@1.2.0, revision 3 (sub-project 5A task 8); --workflow still resolves this 1.1.0 release directly, see library-production-1-2.test.ts for the current profile pointer", () => {
    expect(profile.workflow_release).toBe("library-production@1.2.0");
    expect(profile.revision).toBe(3);
    expect(profile.limits.max_cost_usd_per_variant).toBe(8);
  });
});

describe("library-production@1.0.0 is untouched by the 1.1.0 release", () => {
  it("still has its gate stages", () => {
    const wf = loadWorkflow(HARNESS_ROOT, "library-production@1.0.0");
    expect(wf.definition.stages.map((s) => `${s.key}:${s.executor.type}`)).toEqual([
      "intake:script",
      "index-source:script",
      "survey-source:gate",
      "plan-edit:gate",
      "tts:script",
      "cut:script",
      "assemble:script",
      "thumbnail-candidates:script",
      "library-export:script",
      "library-review:gate",
      "library-apply-review:script",
    ]);
  });
});
