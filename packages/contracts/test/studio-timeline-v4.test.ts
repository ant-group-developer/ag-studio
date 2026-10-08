import { describe, expect, it } from "vitest";
import {
  AnyTimelineSchema, downgradeTimelineV4, readTimeline, StoredTimelineSchema, timelineAsVersion, TimelineV3Schema, TimelineV4Schema,
  TimelineVersionError, timelineVersion, upgradeTimelineV3, type TimelineV3, type TimelineV4,
} from "../src/studio.js";

const V3: TimelineV3 = TimelineV3Schema.parse({
  schema_version: "studio.timeline/v3",
  production_id: "p1",
  episode_id: "e1",
  canvas: { width: 3840, height: 2160 },
  fps: 30,
  language: "vi",
  clips: [
    { clip_id: "C001", asset_id: "a1", section_title: "Mở đầu" },
    { clip_id: "C002", asset_id: "a2", section_title: null },
  ],
  texts: [{ text_id: "T001", kind: "title", text: "Hội An", start: 0.5, duration: 3.5, position: "top_left" }],
  music: { track: "library:music/calm.mp3", gain_db: -18, ducking: true },
  source_audio: { muted: false },
  assets: {
    a1: { title: "Phố đèn lồng", summary_vi: "…", duration_s: 12.5, orientation: "landscape" },
    a2: { title: "Sông Hoài", summary_vi: "…", duration_s: 9, orientation: null },
  },
  alternates: [{ asset_id: "a2", reason: "dự phòng" }],
});

function cutTimeline(over: Partial<TimelineV4> = {}): TimelineV4 {
  const t = upgradeTimelineV3(V3);
  return TimelineV4Schema.parse({
    ...t,
    edit_style: "cut",
    clips: [
      { ...t.clips[0]!, in: 2.4, out: 4.4, shot_id: "s000-001", line_id: "L001", transition_out: { kind: "dissolve", seconds: 0.4 } },
      { ...t.clips[1]!, in: 0, out: null, shot_id: null, line_id: null, transition_out: { kind: "cut", seconds: 0 } },
    ],
    narration: {
      voice: "tts",
      lead_seconds: 0.3,
      lines: [{ line_id: "L001", text: "Khi đèn lồng sáng.", audio: { key: "a".repeat(64), duration_s: 1.8, words: [{ word: "Khi", start: 0, end: 0.3 }] } }],
    },
    captions: { mode: "burn-in" },
    ...over,
  });
}

describe("timeline v4", () => {
  it("reads a v3 timeline as v4: whole clips, cuts, no narration", () => {
    const t = upgradeTimelineV3(V3);
    expect(t.schema_version).toBe("studio.timeline/v4");
    expect(t.edit_style).toBe("whole");
    expect(t.clips[0]).toEqual({
      clip_id: "C001", asset_id: "a1", section_title: "Mở đầu",
      in: 0, out: null, shot_id: null, line_id: null, transition_out: { kind: "cut", seconds: 0 },
    });
    expect(t.narration).toEqual({ voice: "none", lead_seconds: 0.3, lines: [] });
    expect(t.captions).toEqual({ mode: "none" });
    expect(TimelineV4Schema.safeParse(t).success).toBe(true);
  });

  it("writes an upgraded v3 back byte for byte", () => {
    expect(JSON.stringify(downgradeTimelineV4(upgradeTimelineV3(V3)))).toBe(JSON.stringify(V3));
  });

  it("refuses to write a v4 timeline that v3 cannot hold", () => {
    const base = upgradeTimelineV3(V3);
    const lossy: TimelineV4[] = [
      { ...base, edit_style: "cut" },
      { ...base, clips: [{ ...base.clips[0]!, in: 1 }, base.clips[1]!] },
      { ...base, clips: [{ ...base.clips[0]!, out: 5 }, base.clips[1]!] },
      { ...base, clips: [{ ...base.clips[0]!, shot_id: "s000-001" }, base.clips[1]!] },
      { ...base, clips: [{ ...base.clips[0]!, line_id: "L001" }, base.clips[1]!] },
      { ...base, clips: [{ ...base.clips[0]!, transition_out: { kind: "dissolve", seconds: 0.4 } }, base.clips[1]!] },
      { ...base, narration: { voice: "tts", lead_seconds: 0.3, lines: [] } },
      { ...base, narration: { ...base.narration, lead_seconds: 0.5 } },
      { ...base, captions: { mode: "karaoke" } },
      { ...base, clips: [{ ...base.clips[0]!, muted: true }, base.clips[1]!] },
    ];
    for (const t of lossy) {
      expect(() => downgradeTimelineV4(t)).toThrow(TimelineVersionError);
    }
    try { downgradeTimelineV4(lossy[0]!); } catch (e) { expect((e as TimelineVersionError).code).toBe("not_v3"); }
  });

  it("reads either version and tells which one it was", () => {
    const cut = cutTimeline();
    expect(readTimeline(V3)).toEqual(upgradeTimelineV3(V3));
    expect(readTimeline(cut)).toEqual(cut);
    expect(AnyTimelineSchema.parse(V3)).toEqual(upgradeTimelineV3(V3));
    expect(timelineVersion(V3)).toBe(3);
    expect(timelineVersion(cut)).toBe(4);
    expect(timelineVersion({ schema_version: "studio.timeline/v2" })).toBeNull();
    expect(timelineVersion(null)).toBeNull();
    expect(() => readTimeline({ schema_version: "studio.timeline/v2" })).toThrow();
  });

  it("keeps a stored timeline in its own version, and converts on request", () => {
    const cut = cutTimeline();
    expect(StoredTimelineSchema.parse(V3)).toEqual(V3);
    expect(StoredTimelineSchema.parse(cut)).toEqual(cut);
    expect(timelineAsVersion(V3, 3)).toBe(V3);
    expect(timelineAsVersion(upgradeTimelineV3(V3), 3)).toEqual(V3);
    expect(timelineAsVersion(V3, 4)).toEqual(upgradeTimelineV3(V3));
    expect(() => timelineAsVersion(cut, 3)).toThrow(TimelineVersionError);
  });

  it("checks a clip's range, its narration line and its transition", () => {
    const t = cutTimeline();
    const clip = t.clips[0]!;
    const withClip = (c: object) => ({ ...t, clips: [c, t.clips[1]] });
    expect(TimelineV4Schema.safeParse(withClip({ ...clip, line_id: "L1" })).success).toBe(false);
    expect(TimelineV4Schema.safeParse(withClip({ ...clip, shot_id: "s1-1" })).success).toBe(false);
    expect(TimelineV4Schema.safeParse(withClip({ ...clip, in: 4.4, out: 4.4 })).success).toBe(false);
    expect(TimelineV4Schema.safeParse(withClip({ ...clip, in: -1 })).success).toBe(false);
    expect(TimelineV4Schema.safeParse(withClip({ ...clip, transition_out: { kind: "dissolve", seconds: 1.5 } })).success).toBe(false);
    expect(TimelineV4Schema.safeParse(withClip({ ...clip, transition_out: { kind: "wipe", seconds: 0.4 } })).success).toBe(false);
    expect(TimelineV4Schema.safeParse({ ...t, narration: { ...t.narration, lines: [{ line_id: "L001", text: "", audio: null }] } }).success).toBe(false);
    expect(TimelineV4Schema.safeParse({ ...t, narration: { ...t.narration, lines: [{ ...t.narration.lines[0]!, audio: { key: "xyz", duration_s: 1, words: [] } }] } }).success).toBe(false);
    expect(TimelineV4Schema.safeParse({ ...t, extra: 1 }).success).toBe(false);
  });
});
