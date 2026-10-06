import { describe, expect, it } from "vitest";
import { changesUnder, diffDoc, listDiff } from "./diff-doc";
import { EPISODE_STEPS, PLAN_STEPS, stepOf, stepPosition } from "./steps";

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
