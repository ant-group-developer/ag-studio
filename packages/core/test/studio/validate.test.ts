import { describe, expect, it } from "vitest";
import { validateNarration, validateSelection, validateTreatment } from "../../src/studio/validate.js";
import { brief, catalog, narration, seg, selection, treatment } from "./fixtures.js";

const ctx = () => ({ brief: brief(), catalog: catalog(), treatment: treatment() });
const codes = (r: { problems: { code: string }[] }) => r.problems.map((p) => p.code);

describe("selection-valid", () => {
  it("passes a selection that covers every beat with distinct, usable, well-framed footage", () => {
    const r = validateSelection(selection(), ctx());
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("rejects an id that is not in the catalog (unknown id)", () => {
    const s = selection();
    s.beats[0]!.picks[1]!.segment_id = "does-not-exist";
    const r = validateSelection(s, ctx());
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(expect.objectContaining({ code: "unknown_segment", segment_id: "does-not-exist", beat_id: "B01" }));
  });

  it("rejects the same segment picked twice (duplicate id), even across beats", () => {
    const s = selection();
    s.beats[2]!.picks[0]!.segment_id = "s01";
    const r = validateSelection(s, ctx());
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(expect.objectContaining({ code: "duplicate_segment", segment_id: "s01", beat_id: "B03" }));
  });

  it("rejects a selection whose footage cannot fill a beat or the brief (wrong duration)", () => {
    const c = catalog([seg("short1", 2), seg("short2", 2)]);
    const s = selection();
    s.beats[1]!.picks = [{ segment_id: "short1", reason: "x" }, { segment_id: "short2", reason: "x" }];
    const r = validateSelection(s, { ...ctx(), catalog: c });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("beat_too_short");
    // 10 + 4 + 10 = 24 s deliverable against a 30 s brief: outside ±10 %
    expect(codes(r)).toContain("duration");
  });

  it("rejects a total outside ±10 % even when every beat is covered", () => {
    const r = validateSelection(selection(), { ...ctx(), brief: brief({ target_seconds: 40 }) });
    expect(codes(r)).toEqual(["duration"]);
  });

  it("rejects unusable footage and footage that does not fit the frame", () => {
    const c = catalog([seg("bad", 8, { usable: false }), seg("tall", 8, { orientation: "portrait" })]);
    const s = selection();
    s.beats[0]!.picks = [{ segment_id: "bad", reason: "x" }, { segment_id: "tall", reason: "x" }];
    const r = validateSelection(s, { ...ctx(), catalog: c });
    expect(codes(r)).toEqual(expect.arrayContaining(["not_usable", "orientation"]));
  });

  it("requires every treatment beat and no stranger ones", () => {
    const s = selection();
    s.beats[2]!.beat_id = "B09";
    const r = validateSelection(s, ctx());
    expect(codes(r)).toEqual(expect.arrayContaining(["unknown_beat", "missing_beat"]));
  });

  it("asks for 3 alternates per beat, but only as many as the catalog can still offer", () => {
    const s = selection();
    s.beats[0]!.alternates = s.beats[0]!.alternates.slice(0, 1);
    expect(codes(validateSelection(s, ctx()))).toContain("too_few_alternates");
    // a catalog of exactly the six picks + one spare: one alternate is all that can be asked
    const tiny = { ...catalog(), segments: catalog().segments.slice(0, 7) };
    const s2 = selection();
    for (const b of s2.beats) b.alternates = [{ segment_id: "s07", reason: "x" }];
    expect(codes(validateSelection(s2, { ...ctx(), catalog: tiny }))).not.toContain("too_few_alternates");
  });

  it("reports schema problems with a path instead of throwing", () => {
    const r = validateSelection({ schema_version: "studio.selection/v1", beats: [{ beat_id: "B1", picks: [] }] }, ctx());
    expect(r.ok).toBe(false);
    expect(r.problems.every((p) => p.code === "schema")).toBe(true);
    expect(r.problems.map((p) => p.message).join("\n")).toMatch(/beats\.0\.beat_id/);
  });
});

describe("treatment-valid / narration-valid", () => {
  it("treatment: beats must add up to the brief ±10 % and have unique ids", () => {
    expect(validateTreatment(treatment(), brief()).ok).toBe(true);
    const t = treatment();
    t.beats[2]!.beat_id = "B01";
    t.beats[0]!.seconds = 20;
    expect(codes(validateTreatment(t, brief()))).toEqual(expect.arrayContaining(["duplicate_beat", "duration"]));
  });

  it("narration: flags a beat whose lines read longer than the beat, and beats left silent", () => {
    expect(validateNarration(narration(), { brief: brief(), treatment: treatment() }).ok).toBe(true);
    const n = narration();
    n.lines[0]!.text = Array.from({ length: 60 }, () => "phở").join(" ");
    n.lines = n.lines.filter((l) => l.beat_id !== "B03");
    const r = validateNarration(n, { brief: brief(), treatment: treatment() });
    expect(r.problems).toContainEqual(expect.objectContaining({ code: "too_long", beat_id: "B01" }));
    expect(r.problems).toContainEqual(expect.objectContaining({ code: "missing_beat", beat_id: "B03" }));
  });
});
