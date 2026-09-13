import { describe, expect, it } from "vitest";
import { HARNESS_ROOT, loadHarnessConfig, loadProfile, loadWorkflow, Planner, resolveStageGraph } from "../../src/index.js";
import { openTempStore } from "../helpers.js";

describe("footage-production@1.0.0", () => {
  const wf = loadWorkflow(HARNESS_ROOT, "footage-production@1.0.0");
  const profile = loadProfile(HARNESS_ROOT, "footage");
  it("has the ten stages of the spec in topological order with gates where the LLM would be", () => {
    expect(wf.definition.stages.map((s) => `${s.key}:${s.executor.type}`)).toEqual(["index-source:script", "select-topic:gate", "write-script:gate", "edit-plan:gate", "tts:script", "avatar:script", "cut:script", "assemble:script", "thumbnail-render:script", "thumbnail-qc:gate"]);
    for (const s of wf.definition.stages) if (s.executor.type === "gate") for (const o of s.outputs) expect(o.name, `${s.key} output ${o.type}`).toBeTruthy();
    expect(profile.workflow_release).toBe("footage-production@1.0.0");
  });
  it("voice=original,avatar=none drops tts and avatar and rewires assemble to cut only", () => {
    const g = resolveStageGraph(wf.definition.stages, { voice: "original", avatar: "none", subtitles: "false" });
    expect(g.skipped.sort()).toEqual(["avatar", "tts"]);
    const assemble = g.kept.find((k) => k.def.key === "assemble")!;
    expect(assemble.depends_on).toEqual(["cut"]); expect(assemble.depends_on_optional).toEqual([]);
  });
  it("voice=tts,avatar=heygen keeps all ten and assemble waits for tts and avatar", () => {
    const { store } = openTempStore();
    const run = new Planner(store).plan({ workflow: wf, profile, harness: loadHarnessConfig(HARNESS_ROOT), projectId: "p", portfolioId: "pf" }); // defaults: none/none
    expect(store.listStageRuns(run.run_id)).toHaveLength(8);
    const g = resolveStageGraph(wf.definition.stages, { voice: "tts", avatar: "heygen", subtitles: "true" });
    expect(g.skipped).toEqual([]);
    const assemble = g.kept.find((k) => k.def.key === "assemble")!;
    expect(assemble.depends_on_optional.sort()).toEqual(["avatar", "tts"]);
    expect(g.kept.find((k) => k.def.key === "tts")!.def.requires_resources).toEqual(["gpu"]);
  });
});
