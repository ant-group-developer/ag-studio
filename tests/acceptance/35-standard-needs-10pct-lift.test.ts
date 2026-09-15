import { describe, expect, it } from "vitest";
import type { ChannelLearned, StatsOutcome } from "@harness/contracts";
import { cli, freshPublishWorld, seedPublishedEpisode, statsFile, type PublishWorld } from "../integration/publish-helpers.js";

// Acceptance 35 (spec §3.2): a channel standard is sticky on purpose. A new angle only replaces the standing
// one when its lift beats the standing value's *own recorded* lift by at least 10%; a merely-better angle
// leaves the standard exactly where it was, and every real change (and only a real change) pushes one
// `history` entry.
//
// Episodes are hand-seeded (`seedPublishedEpisode`) rather than published for real: this rule is about a
// *sample*, and nine real channel-publish runs would add minutes without touching the rule under test.
// `channel collect` is still the thing that drives it -- a real sweep over the fake Studio numbers, which
// records the snapshots, evaluates every hypothesis and re-learns the standard, exactly as the worker would.
//
// `learnChannelStandard` learns three dimensions at once (angle, title pattern, overlay-line count) and one
// `history` entry covers whatever changed that round, so each episode's `title`/`overlayText` is chosen to
// keep the other two dimensions *out* of the standard for rounds 1 and 2: no title-pattern group ever holds
// two supported episodes, and the one overlay group that does (`0`: vidA1 + vidB2) holds three refuted ones
// as well, which fails `supported > refuted`. That way `history` moves if and only if the angle moves, and
// the counts below mean exactly what they say.

interface Ep { videoId: string; views: number; angle: string; target: number; title: string; overlayText: string[] }

/** Seeds each episode, points the fake Studio at its numbers, then runs one real collect sweep and returns
 * the learned row afterwards. */
function collectRound(world: PublishWorld, startEpisodeNo: number, eps: Ep[]): ChannelLearned {
  const outcomes: Record<string, StatsOutcome> = {};
  eps.forEach((ep, i) => {
    seedPublishedEpisode(world, {
      channelId: "channel-one", episodeNo: startEpisodeNo + i, videoId: ep.videoId,
      title: ep.title, overlayText: ep.overlayText, angle: ep.angle, metric: "views_72h", target: ep.target,
    });
    outcomes[ep.videoId] = { kind: "ok", views: ep.views, impressions: 5000, ctr_pct: 5, avg_view_sec: 30 };
  });
  statsFile(world, outcomes);

  const collect = cli(world.channel, ["channel", "collect", "--channel", "channel-one", "--json"], world.secretsEnv);
  expect(collect.code, collect.err).toBe(0);
  const report = JSON.parse(collect.out) as { collected: unknown[] };
  expect(report.collected, collect.out).toHaveLength(eps.length);

  const learned = cli(world.channel, ["channel", "learned", "channel-one", "--json"], world.secretsEnv);
  expect(learned.code, learned.err).toBe(0);
  return JSON.parse(learned.out) as ChannelLearned;
}

function liftOf(learned: ChannelLearned, angle: string): number {
  const group = learned.winners.angles.find((g) => g.value === angle);
  expect(group, `no angle group "${angle}" in ${JSON.stringify(learned.winners.angles)}`).toBeDefined();
  return group!.lift;
}

describe("acceptance 35: a standing standard only flips for a 10%-better lift", () => {
  it("angle a at lift 1.5 becomes the standard; angle b at 1.6 does not take it (needs 1.65); at 2.8 it does", () => {
    const world = freshPublishWorld();

    // ---- round 1: two strong "a" episodes (1500) over three weak "x" ones (1000) ----
    // median of [1500,1500,1000,1000,1000] = 1000 -> group a mean 1500 -> lift 1.5, and it is the only group
    // with 2+ supported and more supported than refuted.
    const round1 = collectRound(world, 15, [
      { videoId: "vidA1", views: 1500, angle: "a", target: 1000, title: "Chợ nổi Cái Răng 5 giờ sáng", overlayText: [] },
      { videoId: "vidA2", views: 1500, angle: "a", target: 1000, title: "Chợ nổi Cái Răng lúc rạng đông", overlayText: ["một dòng"] },
      { videoId: "vidX1", views: 1000, angle: "x", target: 2000, title: "Chợ nổi Cái Răng 6 giờ sáng", overlayText: [] },
      { videoId: "vidX2", views: 1000, angle: "x", target: 2000, title: "Chợ nổi Cái Răng 7 giờ sáng", overlayText: [] },
      { videoId: "vidX3", views: 1000, angle: "x", target: 2000, title: "Chợ nổi Cái Răng 8 giờ sáng", overlayText: [] },
    ]);
    expect(round1.standard.angle).toBe("a");
    expect(liftOf(round1, "a")).toBeCloseTo(1.5, 6);
    expect(round1.history).toHaveLength(1);
    expect(round1.history[0]!.standard.angle).toBe("a");
    // the titles/overlays above deliberately keep every *other* dimension out of the standard (see the
    // `title`/`overlayText` note under the file header), so `history` only ever moves when the angle does
    expect(round1.standard.title_pattern).toBeUndefined();
    expect(round1.standard.overlay_lines).toBeUndefined();

    // ---- round 2: two "b" episodes that are better than the channel, but not 10% better than "a" was ----
    // median of [1000,1000,1000,1500,1500,2400,2400] = 1500 -> group b mean 2400 -> lift exactly 1.6, which
    // has to clear round 1's recorded a-lift (1.5) x 1.10 = 1.65 to take over. 1.6 < 1.65, by 3%: drop the
    // `* 1.10` from `decideDimension` and this round flips to "b" and the assertion below fails.
    const round2 = collectRound(world, 20, [
      { videoId: "vidB1", views: 2400, angle: "b", target: 1000, title: "Có gì ở chợ nổi lúc 6 giờ?", overlayText: ["một", "hai", "ba"] },
      { videoId: "vidB2", views: 2400, angle: "b", target: 1000, title: "Có gì ở chợ nổi lúc rạng đông?", overlayText: [] },
    ]);
    expect(liftOf(round2, "b")).toBeCloseTo(1.6, 6);
    expect(liftOf(round2, "a"), "the a-lift this round records is what round 3 has to beat by 10%").toBeCloseTo(1.0, 6);
    expect(round2.standard.angle, "a 1.6 angle must not take a standard whose own recorded lift was 1.5").toBe("a");
    expect(round2.history, "nothing changed, so nothing was pushed to history").toHaveLength(1);
    expect(round2.standard.title_pattern).toBeUndefined();
    expect(round2.standard.overlay_lines).toBeUndefined();

    // ---- round 3: two runaway "b" episodes -- now b really is the channel's angle ----
    // median of [1000,1000,1000,1500,1500,2400,2400,6000,6000] = 1500 -> group b mean 4200 -> lift 2.8,
    // against the a-lift round 2 recorded (1.0) x 1.10 = 1.1.
    const round3 = collectRound(world, 22, [
      { videoId: "vidB3", views: 6000, angle: "b", target: 1000, title: "Một buổi sáng trọn vẹn ở chợ nổi Cái Răng, từ 4 giờ đến lúc tan chợ", overlayText: ["một", "hai", "ba"] },
      { videoId: "vidB4", views: 6000, angle: "b", target: 1000, title: "Một buổi sáng trọn vẹn ở chợ nổi Cái Răng, từ tinh mơ đến lúc tan chợ", overlayText: [] },
    ]);
    expect(liftOf(round3, "b")).toBeCloseTo(4200 / 1500, 6);
    expect(round3.standard.angle).toBe("b");
    expect(round3.history).toHaveLength(2);
    expect(round3.history.at(-1)!.standard.angle).toBe("b");
    expect(round3.sample_size).toBe(9);
  }, 120_000);
});
