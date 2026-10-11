/** buildEpisodeTimeline: the plan's titles may be longer than an on-screen text (64 chars). */
import { describe, expect, it } from "vitest";
import { buildEpisodeTimeline, type BuildTimelineInput } from "../../src/studio/build-timeline.js";

const brief = { music: null, canvas: { width: 1920, height: 1080 }, fps: 30, language: "vi", aspect: "16:9" } as unknown as BuildTimelineInput["brief"];
const asset = (title: string) => ({ title, summary_vi: "", duration_s: 20, orientation: null });

function input(title: string, sections: [string | null, string | null]): BuildTimelineInput {
  return {
    brief,
    episode: {
      idx: 1, title, hook: "h", logline: "l", target_seconds: 40,
      items: [{ asset_id: "a1", reason: "r", section_title: sections[0] }, { asset_id: "a2", reason: "r", section_title: sections[1] }],
      alternates: [], texts_suggested: [],
      production_id: "p", episode_id: "e", assets: { a1: asset("A"), a2: asset("B") },
    } as unknown as BuildTimelineInput["episode"],
  };
}

describe("buildEpisodeTimeline", () => {
  it("shortens an episode title and a section title longer than 64 chars at a word, with an ellipsis", () => {
    const long = "Một ngày dạo bộ quanh phố cổ Hội An lúc hoàng hôn, đèn lồng và những con thuyền trên sông Hoài";
    expect(long.length).toBeGreaterThan(64);
    const t = buildEpisodeTimeline(input(long, ["Mở đầu", long]));

    expect(t.texts.map((x) => x.kind)).toEqual(["title", "lower_third"]);
    for (const x of t.texts) {
      expect(x.text.length).toBeLessThanOrEqual(64);
      expect(x.text.endsWith("…")).toBe(true);
      expect(long.startsWith(x.text.slice(0, -1).trimEnd())).toBe(true);
      expect(x.text.slice(0, -1)).not.toMatch(/\s$/);
    }
  });

  it("keeps a title of 64 chars or fewer as it is", () => {
    const t = buildEpisodeTimeline(input("Phố cổ Hội An", [null, null]));
    expect(t.texts[0]!.text).toBe("Phố cổ Hội An");
  });
});
