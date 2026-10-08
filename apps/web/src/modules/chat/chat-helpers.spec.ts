import { describe, expect, it } from "vitest";
import i18n from "../../i18n/config";
import { cutHeader } from "../../pages/ChatProductionPage";
import { changesUnder, diffDoc, listDiff } from "./diff-doc";
import { CUT_EPISODE_STEPS, EPISODE_STEPS, episodeStepsFor, isCutWorkflow, PLAN_STEPS, planHasStyle, planStepsFor, resumeStageOf, stepOf, stepPosition } from "./steps";

describe("stepOf", () => {
  it.each([
    ["intake", "intake"], ["trend-report", "research"], ["approve-trend-report", "research"], ["approve-rnd", "rnd"],
    ["apply-branding", "branding"], ["approve-plan", "plan"], ["spawn-episodes", "episodes"], ["build-timeline", "draft"],
    ["approve-timeline", "timeline"], ["timeline", "timeline"], ["approve-youtube-kit", "kit"], ["render-final", "render"], ["export", "export"],
  ])("%s -> %s", (stage, step) => expect(stepOf(stage)).toBe(step));
  it("knows nothing of other keys", () => {
    expect(stepOf("something")).toBeNull();
    expect(stepOf(null)).toBeNull();
    expect(stepPosition("rnd", PLAN_STEPS)).toBe(1);
    expect(stepPosition("rnd", EPISODE_STEPS)).toBe(-1);
  });
});

describe("steps of a shot-cut episode (ag-studio-episode-cut)", () => {
  const CUT = "ag-studio-episode-cut@1.0.0";
  it.each([
    ["episode-intake", "footage"], ["fetch-proxies", "footage"], ["media-index", "footage"], ["transcribe", "footage"], ["clean-transcript", "footage"], ["watch-source", "footage"],
    ["source-survey", "survey"], ["approve-survey", "survey"],
    ["plan-edit", "editPlan"], ["approve-edit-plan", "editPlan"], ["tts", "editPlan"], ["fit-timeline", "editPlan"],
    ["approve-timeline", "timeline"], ["timeline", "timeline"], ["approve-youtube-kit", "kit"],
    ["freeze-timeline", "render"], ["render-final", "render"], ["thumbnails", "render"], ["export", "render"],
  ])("%s -> %s", (stage, step) => expect(stepOf(stage, CUT)).toBe(step));

  it("the episode header says how it is cut, how long, and its voice", async () => {
    await i18n.changeLanguage("vi");
    const t = i18n.t.bind(i18n) as (k: string, o?: Record<string, unknown>) => string;
    expect(cutHeader({ edit_style: "cut", target_seconds: 600, narration: "tts" }, t)).toBe("cắt theo shot · khoảng 10 phút · có lời dẫn");
    expect(cutHeader({ edit_style: "cut", target_seconds: 45, narration: "original" }, t)).toBe("cắt theo shot · khoảng 45 giây · giữ tiếng gốc");
    expect(cutHeader({ edit_style: "whole", target_seconds: 600 }, t)).toBeNull();
    expect(cutHeader(null, t)).toBeNull();
  });

  it("a whole-video episode (or none known yet) keeps the old steps", () => {
    expect(isCutWorkflow(CUT)).toBe(true);
    expect(isCutWorkflow("ag-studio-episode@1.3.0")).toBe(false);
    expect(isCutWorkflow(null)).toBe(false);
    expect(episodeStepsFor(CUT)).toEqual(CUT_EPISODE_STEPS);
    expect(CUT_EPISODE_STEPS).toEqual(["footage", "survey", "editPlan", "timeline", "kit", "render"]);
    expect(episodeStepsFor("ag-studio-episode@1.3.0")).toEqual(EPISODE_STEPS);
    expect(episodeStepsFor(undefined)).toEqual(EPISODE_STEPS);
    expect(stepOf("episode-intake", "ag-studio-episode@1.3.0")).toBe("draft");
    expect(stepOf("export")).toBe("export");
  });
});

describe("diffDoc", () => {
  it("lists changed, added and removed fields by path", () => {
    const before = { summary: "a", direction: { episode_count: 4, tone: "yên" }, keywords: ["x", "y"], episodes: [{ title: "T1" }, { title: "T2" }] };
    const after = { summary: "a", direction: { episode_count: 3, tone: "yên", note: "mới" }, keywords: ["x"], episodes: [{ title: "T1" }] };
    expect(diffDoc(before, after)).toEqual([
      { path: "direction.episode_count", kind: "changed", before: 4, after: 3 },
      { path: "direction.note", kind: "added", after: "mới" },
      { path: "keywords", kind: "changed", before: ["x", "y"], after: ["x"] },
      { path: "episodes.1", kind: "removed", before: { title: "T2" } },
    ]);
    expect(diffDoc(before, before)).toEqual([]);
    expect(changesUnder(diffDoc(before, after), "direction").map((c) => c.path)).toEqual(["direction.episode_count", "direction.note"]);
  });

  it("tells what a plain list gained and lost", () => {
    const d = listDiff(["kyoto vlog", "kyoto food"], ["kyoto vlog", "arashiyama"]);
    expect([...d.added]).toEqual(["arashiyama"]);
    expect(d.removed).toEqual(["kyoto food"]);
  });
});

describe("the style step of series plan 3.2.0", () => {
  it("shows beside the research only for plan 3.2.0 on", () => {
    expect(planHasStyle("ag-studio-series-plan@3.2.0")).toBe(true);
    expect(planHasStyle("ag-studio-series-plan@4.0.0")).toBe(true);
    expect(planHasStyle("ag-studio-series-plan@3.1.0")).toBe(false);
    expect(planHasStyle(null)).toBe(false);
    expect(planStepsFor("ag-studio-series-plan@3.2.0")).toEqual(["research", "style", "rnd", "branding", "plan", "episodes"]);
    expect(planStepsFor("ag-studio-series-plan@3.1.0")).toEqual(PLAN_STEPS);
  });

  it("groups its stages and the research's new ones; runs again from the API and from picking the references", () => {
    for (const k of ["pick-references", "watch-references", "analyze-style", "approve-style", "apply-style"]) expect(stepOf(k)).toBe("style");
    expect(stepOf("research-api")).toBe("research");
    expect(stepOf("research-web")).toBe("research");
    expect(resumeStageOf("research", { episode: false, workflow: "ag-studio-series-plan@3.2.0" })).toBe("research-api");
    expect(resumeStageOf("style", { episode: false, workflow: "ag-studio-series-plan@3.2.0" })).toBe("pick-references");
    expect(resumeStageOf("research", { episode: false, workflow: "ag-studio-series-plan@3.1.0" })).toBe("research");
  });
});
