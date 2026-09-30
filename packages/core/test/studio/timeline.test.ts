import { describe, expect, it } from "vitest";
import { CompositionSchema, TimelineV3Schema, type TimelineV3 } from "@harness/contracts";
import {
  addClip, ensureAsset, layoutTimeline, moveClip, removeClip, replaceClipAsset,
  setSectionTitle, addText, updateText, removeText, setMusic, setSourceMuted,
  timelineIssues, TimelineOpError,
} from "../../src/studio/layout.js";
import { timelineToComposition, thumbnailTimes } from "../../src/studio/render-plan.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const PROD = "prod-1";
const EP   = "ep-1";

function makeAsset(durationS = 8) {
  return { title: "Video", summary_vi: "Clip", duration_s: durationS, orientation: "landscape" as const };
}

/** Minimal valid v3 timeline with 3 clips of 8 s each. */
function tl(): TimelineV3 {
  return {
    schema_version: "studio.timeline/v3",
    production_id: PROD,
    episode_id: EP,
    canvas: { width: 1920, height: 1080 },
    fps: 25,
    language: "vi",
    clips: [
      { clip_id: "C001", asset_id: "a01", section_title: "Chương 1" },
      { clip_id: "C002", asset_id: "a02", section_title: null },
      { clip_id: "C003", asset_id: "a03", section_title: "Chương 2" },
    ],
    texts: [],
    music: null,
    source_audio: { muted: false },
    assets: {
      a01: makeAsset(8),
      a02: makeAsset(10),
      a03: makeAsset(6),
    },
    alternates: [],
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("TimelineV3Schema", () => {
  it("validates the fixture and rejects clip IDs not matching /^C\\d{3,4}$/", () => {
    expect(TimelineV3Schema.safeParse(tl()).success).toBe(true);
    const bad = { ...tl(), clips: [{ clip_id: "clip-1", asset_id: "a01", section_title: null }] };
    expect(TimelineV3Schema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

describe("layoutTimeline", () => {
  it("accumulates clip starts from asset durations and builds section list", () => {
    const layout = layoutTimeline(tl());
    expect(layout.duration).toBe(24); // 8+10+6
    expect(layout.clips[0]!.start).toBe(0);
    expect(layout.clips[1]!.start).toBe(8);
    expect(layout.clips[2]!.start).toBe(18);
    expect(layout.sections.map((s) => s.title)).toEqual(["Chương 1", "Chương 2"]);
    expect(layout.sections[1]!.start).toBe(18);
  });

  it("treats an unknown asset_id as duration 0", () => {
    const t: TimelineV3 = { ...tl(), clips: [{ clip_id: "C001", asset_id: "unknown", section_title: null }] };
    expect(layoutTimeline(t).duration).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Timeline issues
// ---------------------------------------------------------------------------

describe("timelineIssues", () => {
  it("returns no issues for a valid timeline", () => {
    expect(timelineIssues(tl())).toEqual([]);
  });

  it("reports no_clips when clips array is empty", () => {
    const t: TimelineV3 = { ...tl(), clips: [] };
    expect(timelineIssues(t).map((i) => i.code)).toContain("no_clips");
  });

  it("reports duplicate_id for repeated clip_id", () => {
    const t: TimelineV3 = { ...tl(), clips: [...tl().clips, { clip_id: "C001", asset_id: "a01", section_title: null }] };
    expect(timelineIssues(t).map((i) => i.code)).toContain("duplicate_id");
  });

  it("reports unknown_asset and duplicate_asset", () => {
    // Unknown asset
    const t1: TimelineV3 = { ...tl(), clips: [{ clip_id: "C001", asset_id: "missing", section_title: null }] };
    expect(timelineIssues(t1).map((i) => i.code)).toContain("unknown_asset");

    // Same asset used twice
    const t2: TimelineV3 = { ...tl(), clips: [
      { clip_id: "C001", asset_id: "a01", section_title: null },
      { clip_id: "C002", asset_id: "a01", section_title: null },
    ]};
    expect(timelineIssues(t2).map((i) => i.code)).toContain("duplicate_asset");
  });
});

// ---------------------------------------------------------------------------
// Edit operations
// ---------------------------------------------------------------------------

describe("editing operations (what the web reducer dispatches)", () => {
  it("addClip inserts at the given index and removeClip removes it", () => {
    const t0 = tl();
    const t1 = addClip(t0, "a03", 0); // insert at front — a03 was already there, but assets is a record
    // a03 is already in assets; addClip allows re-using an asset (duplicate_asset issue, but op succeeds)
    expect(t1.clips[0]!.clip_id).toMatch(/^C\d{3,4}$/);
    const added = t1.clips[0]!;
    const t2 = removeClip(t1, added.clip_id);
    expect(t2.clips.length).toBe(t0.clips.length);
  });

  it("addClip throws when asset is not registered", () => {
    expect(() => addClip(tl(), "not-registered", 0)).toThrow(TimelineOpError);
  });

  it("removeClip throws when clip not found", () => {
    expect(() => removeClip(tl(), "C999")).toThrow(TimelineOpError);
  });

  it("moveClip reorders clips", () => {
    const t = moveClip(tl(), 0, 2); // move C001 to position 2
    expect(t.clips.map((c) => c.clip_id)).toEqual(["C002", "C003", "C001"]);
    expect(moveClip(tl(), 1, 1).clips).toEqual(tl().clips); // no-op
  });

  it("replaceClipAsset swaps the asset and adds the old one to alternates", () => {
    const t0 = tl();
    const t = replaceClipAsset(t0, "C001", "a02");
    expect(t.clips[0]!.asset_id).toBe("a02");
    expect(t.alternates.some((a) => a.asset_id === "a01")).toBe(true);
    // removing new asset from alternates: a02 was not in alternates, so length unchanged at 1
    expect(t.clips[0]!.clip_id).toBe("C001");
  });

  it("replaceClipAsset throws on unknown clip or unknown new asset", () => {
    expect(() => replaceClipAsset(tl(), "C999", "a02")).toThrow(TimelineOpError);
    expect(() => replaceClipAsset(tl(), "C001", "unknown")).toThrow(TimelineOpError);
  });

  it("setSectionTitle sets and clears a section title", () => {
    const t = setSectionTitle(tl(), "C002", "Phần giữa");
    expect(t.clips[1]!.section_title).toBe("Phần giữa");
    const t2 = setSectionTitle(t, "C002", null);
    expect(t2.clips[1]!.section_title).toBeNull();
  });

  it("addText / updateText / removeText manage text items", () => {
    const t0 = tl();
    const t1 = addText(t0, { kind: "title", text: "Phở bò", start: 1, duration: 3, position: "bottom_center" });
    expect(t1.texts[0]!.text_id).toBe("T001");
    const t2 = updateText(t1, "T001", { text: "Phở bò Hà Nội" });
    expect(t2.texts[0]!.text).toBe("Phở bò Hà Nội");
    const t3 = removeText(t2, "T001");
    expect(t3.texts).toHaveLength(0);
  });

  it("setMusic / setSourceMuted update audio settings", () => {
    const t = setMusic(tl(), { track: "library:calm.mp3", gain_db: -18, ducking: true });
    expect(t.music!.track).toBe("library:calm.mp3");
    const t2 = setMusic(t, null);
    expect(t2.music).toBeNull();
    const t3 = setSourceMuted(tl(), true);
    expect(t3.source_audio.muted).toBe(true);
  });

  it("ensureAsset adds a new asset and is a no-op for existing ones", () => {
    const t0 = tl();
    const newAsset = makeAsset(12);
    const t1 = ensureAsset(t0, "a04", newAsset);
    expect(t1.assets["a04"]).toEqual(newAsset);
    const t2 = ensureAsset(t1, "a04", makeAsset(5));
    expect(t2.assets["a04"]).toEqual(newAsset); // no-op: keeps original
  });
});

// ---------------------------------------------------------------------------
// Render plan
// ---------------------------------------------------------------------------

describe("render plan", () => {
  it("produces a composition the render worker accepts", () => {
    const t = setMusic(tl(), { track: "library:calm.mp3", gain_db: -18, ducking: true });
    const comp = timelineToComposition(t);
    expect(CompositionSchema.safeParse(comp).success).toBe(true);
    expect(comp.total_seconds).toBeCloseTo(24, 3); // 8+10+6
    // Each clip plays from in=0 to its full duration
    expect(comp.segments[0]!.in).toBe(0);
    expect(comp.segments[0]!.out).toBeCloseTo(8, 3);
    expect(comp.segments[0]!.source_path).toBe("asset:a01");
    // Source ids are stable across calls (mezzanine cache)
    expect(timelineToComposition(t).segments[0]!.source_id).toBe(comp.segments[0]!.source_id);
  });

  it("thumbnailTimes returns 3 moments from the kit's asset clips", () => {
    const kit = {
      schema_version: "studio.youtube-kit/v1" as const,
      titles: ["T1", "T2", "T3"],
      description: "D",
      tags: [],
      hashtags: [],
      thumbnails: [
        { asset_id: "a01", text: "Clip 1" },
        { asset_id: "a02", text: "Clip 2" },
        { asset_id: "a03", text: "Clip 3" },
      ],
      playlist: "P",
    };
    const times = thumbnailTimes(tl(), kit);
    expect(times).toHaveLength(3);
    // a01 plays 0→8, midpoint = 4
    expect(times[0]!.t_s).toBeCloseTo(4, 3);
    // a02 plays 8→18, midpoint = 13
    expect(times[1]!.t_s).toBeCloseTo(13, 3);
    // a03 plays 18→24, midpoint = 21
    expect(times[2]!.t_s).toBeCloseTo(21, 3);
  });
});
