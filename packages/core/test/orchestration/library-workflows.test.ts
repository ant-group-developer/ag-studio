import { describe, expect, it } from "vitest";
import { HARNESS_ROOT, loadProfile, loadWorkflow, resolveStageGraph } from "../../src/index.js";

describe("style-study@1.0.0", () => {
  const wf = loadWorkflow(HARNESS_ROOT, "style-study@1.0.0");
  it("loads with the four stages of spec §3.1 in order", () => {
    expect(wf.definition.stages.map((s) => `${s.key}:${s.executor.type}`)).toEqual([
      "collect-samples:script",
      "analyze-style:gate",
      "style-review:gate",
      "style-export:script",
    ]);
    for (const s of wf.definition.stages) if (s.executor.type === "gate") for (const o of s.outputs) expect(o.name, `${s.key} output ${o.type}`).toBeTruthy();
  });
});

describe("library-production@1.0.0", () => {
  const wf = loadWorkflow(HARNESS_ROOT, "library-production@1.0.0");
  const profile = loadProfile(HARNESS_ROOT, "studio");

  it("has the eleven stages of spec §3.2 in topological order with gates where the LLM would be", () => {
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
    for (const s of wf.definition.stages) if (s.executor.type === "gate") for (const o of s.outputs) expect(o.name, `${s.key} output ${o.type}`).toBeTruthy();
  });

  it("profile studio parses (its workflow_release now tracks library-production@1.1.0, see studio-workflows-1-1.test.ts)", () => {
    expect(profile.workflow_release).toBe("library-production@1.1.0");
  });

  it("voice=none drops tts and rewires assemble/library-export to skip the optional tts edge", () => {
    const g = resolveStageGraph(wf.definition.stages, { voice: "none", subtitles: "false" });
    expect(g.skipped).toEqual(["tts"]);
    const assemble = g.kept.find((k) => k.def.key === "assemble")!;
    expect(assemble.depends_on.sort()).toEqual(["cut", "intake"]);
    expect(assemble.depends_on_optional).toEqual([]);
    const libraryExport = g.kept.find((k) => k.def.key === "library-export")!;
    expect(libraryExport.depends_on_optional).toEqual([]);
  });

  it("voice=tts keeps tts and wires the optional edges to assemble and library-export", () => {
    const g = resolveStageGraph(wf.definition.stages, { voice: "tts", subtitles: "false" });
    expect(g.skipped).toEqual([]);
    const assemble = g.kept.find((k) => k.def.key === "assemble")!;
    expect(assemble.depends_on_optional).toEqual(["tts"]);
    const libraryExport = g.kept.find((k) => k.def.key === "library-export")!;
    expect(libraryExport.depends_on_optional).toEqual(["tts"]);
  });

  it("library-export requires the stages producing its inputs and asks for library-export-valid", () => {
    const libraryExport = wf.definition.stages.find((s) => s.key === "library-export")!;
    expect(libraryExport.depends_on.sort()).toEqual(["assemble", "intake", "plan-edit", "thumbnail-candidates"]);
    expect(libraryExport.required_checks).toContain("library-export-valid");
    expect(libraryExport.executor).toEqual({ type: "script", script: "library-export" });
  });

  it("library-apply-review depends on library-review and library-export", () => {
    const applyReview = wf.definition.stages.find((s) => s.key === "library-apply-review")!;
    expect(applyReview.depends_on.sort()).toEqual(["library-export", "library-review"]);
    expect(applyReview.executor).toEqual({ type: "script", script: "library-apply-review" });
  });

  it("assemble requires brief-duration and depends on intake for the brief input", () => {
    const assemble = wf.definition.stages.find((s) => s.key === "assemble")!;
    expect(assemble.required_checks).toContain("brief-duration");
    expect(assemble.depends_on).toContain("intake");
  });
});
