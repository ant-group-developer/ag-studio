import { describe, expect, it } from "vitest";
import { TimelineV4Schema, upgradeTimelineV3, type TimelineV3, type TimelineV4 } from "@harness/contracts";
import { getEpisodeRevision, latestEpisodeRevision, replaceEpisodes, saveEpisodeRevision, saveEpisodeTimeline, StudioRunError } from "../src/index.js";
import { seedProduction, world } from "./helpers.js";

const asset = (d: number) => ({ title: "Video", summary_vi: "Clip", duration_s: d, orientation: "landscape" as const });

function v3(episodeId: string): TimelineV3 {
  return {
    schema_version: "studio.timeline/v3", production_id: "p", episode_id: episodeId, canvas: { width: 3840, height: 2160 }, fps: 30, language: "vi",
    clips: [{ clip_id: "C001", asset_id: "a01", section_title: null }],
    texts: [], music: null, source_audio: { muted: false },
    assets: { a01: asset(20) }, alternates: [],
  };
}

function cut(episodeId: string): TimelineV4 {
  const t = upgradeTimelineV3(v3(episodeId));
  return TimelineV4Schema.parse({ ...t, edit_style: "cut", clips: [{ ...t.clips[0]!, in: 2, out: 6 }] });
}

function setup() {
  const { db } = world();
  const prod = seedProduction(db);
  replaceEpisodes(db, prod, [
    { id: "ep-whole", idx: 1, title: "Tập 1", hook: "h", plan: "{}" },
    { id: "ep-cut", idx: 2, title: "Tập 2", hook: "h", plan: "{}" },
  ], "plan-run");
  return db;
}

describe("timeline revisions keep the version of their episode", () => {
  it("a v3 episode stays v3, even when the editor sends the same timeline as v4", () => {
    const db = setup();
    saveEpisodeRevision(db, "ep-whole", { baseRevision: 0, data: v3("ep-whole"), authorId: "system" });
    const edited = { ...upgradeTimelineV3(v3("ep-whole")), texts: [{ text_id: "T001", kind: "title" as const, text: "Hoa Lư", start: 0, duration: 3, position: "top_left" as const }] };
    const r = saveEpisodeRevision(db, "ep-whole", { baseRevision: 1, data: edited, authorId: "editor-1" });
    const stored = getEpisodeRevision(db, "ep-whole", r.revision)!;
    expect(stored.data.schema_version).toBe("studio.timeline/v3");
    expect(stored.data.texts).toHaveLength(1);
    expect(JSON.parse(db.get<{ data: string }>("SELECT data FROM episode_revisions WHERE episode_id = 'ep-whole' AND revision = 2")!.data).schema_version)
      .toBe("studio.timeline/v3");
  });

  it("a v4 edit a v3 episode cannot hold is refused as not_v3", () => {
    const db = setup();
    saveEpisodeRevision(db, "ep-whole", { baseRevision: 0, data: v3("ep-whole"), authorId: "system" });
    const trimmed = { ...cut("ep-whole"), edit_style: "whole" as const };
    let err: unknown;
    try { saveEpisodeTimeline(db, "ep-whole", { baseRevision: 1, data: trimmed, authorId: "editor-1" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(StudioRunError);
    expect((err as StudioRunError).code).toBe("invalid");
    expect(JSON.stringify((err as StudioRunError).details)).toContain("not_v3");
    expect(latestEpisodeRevision(db, "ep-whole")!.revision).toBe(1);
  });

  it("a shot-cut episode stores v4 and reads it back with its trims", () => {
    const db = setup();
    saveEpisodeRevision(db, "ep-cut", { baseRevision: 0, data: cut("ep-cut"), authorId: "system" });
    const saved = saveEpisodeTimeline(db, "ep-cut", { baseRevision: 1, data: cut("ep-cut"), authorId: "editor-1" });
    expect(saved.issues).toEqual([]);
    const latest = latestEpisodeRevision(db, "ep-cut")!;
    expect(latest.data.schema_version).toBe("studio.timeline/v4");
    expect(latest.data.clips[0]).toMatchObject({ in: 2, out: 6 });
  });

  it("a v3 document sent to a shot-cut episode is read as v4", () => {
    const db = setup();
    saveEpisodeRevision(db, "ep-cut", { baseRevision: 0, data: cut("ep-cut"), authorId: "system" });
    saveEpisodeRevision(db, "ep-cut", { baseRevision: 1, data: v3("ep-cut"), authorId: "editor-1" });
    expect(latestEpisodeRevision(db, "ep-cut")!.data.schema_version).toBe("studio.timeline/v4");
  });
});
