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

interface Ep { videoId: string; views: number; angle: string; target: number }

/** Seeds each episode, points the fake Studio at its numbers, then runs one real collect sweep and returns
 * the learned row afterwards. */
function collectRound(world: PublishWorld, startEpisodeNo: number, eps: Ep[]): ChannelLearned {
  const outcomes: Record<string, StatsOutcome> = {};
  eps.forEach((ep, i) => {
    seedPublishedEpisode(world, {
      channelId: "channel-one", episodeNo: startEpisodeNo + i, videoId: ep.videoId,
      title: `Tập ${startEpisodeNo + i} (${ep.angle})`, angle: ep.angle, metric: "views_72h", target: ep.target,
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
  it("angle a at lift 1.5 becomes the standard; a 1.07 angle b does not take it; a 2.53 angle b does", () => {
    const world = freshPublishWorld();

    // ---- round 1: two strong "a" episodes (1500) over three weak "x" ones (1000) ----
    // median of [1500,1500,1000,1000,1000] = 1000 -> group a mean 1500 -> lift 1.5, and it is the only group
    // with 2+ supported and more supported than refuted.
    const round1 = collectRound(world, 15, [
      { videoId: "vidA1", views: 1500, angle: "a", target: 1000 },
      { videoId: "vidA2", views: 1500, angle: "a", target: 1000 },
      { videoId: "vidX1", views: 1000, angle: "x", target: 2000 },
      { videoId: "vidX2", views: 1000, angle: "x", target: 2000 },
      { videoId: "vidX3", views: 1000, angle: "x", target: 2000 },
    ]);
    expect(round1.standard.angle).toBe("a");
    expect(liftOf(round1, "a")).toBeCloseTo(1.5, 6);
    expect(round1.history).toHaveLength(1);
    expect(round1.history[0]!.standard.angle).toBe("a");

    // ---- round 2: two "b" episodes that are better than the channel, but not 10% better than "a" was ----
    // median of [1000,1000,1000,1500,1500,1600,1600] = 1500 -> group b lift 1600/1500 = 1.067, which has to
    // clear round 1's recorded a-lift (1.5) x 1.10 = 1.65 to take over. It does not.
    const round2 = collectRound(world, 20, [
      { videoId: "vidB1", views: 1600, angle: "b", target: 1000 },
      { videoId: "vidB2", views: 1600, angle: "b", target: 1000 },
    ]);
    expect(liftOf(round2, "b")).toBeCloseTo(1600 / 1500, 6);
    expect(round2.standard.angle, "a 6.7% better angle must not take the standard").toBe("a");
    expect(round2.history, "nothing changed, so nothing was pushed to history").toHaveLength(1);

    // ---- round 3: two runaway "b" episodes -- now b really is the channel's angle ----
    // median of [1000,1000,1000,1500,1500,1600,1600,6000,6000] = 1500 -> group b mean 3800 -> lift 2.53,
    // against the a-lift round 2 recorded (1.0) x 1.10 = 1.1.
    const round3 = collectRound(world, 22, [
      { videoId: "vidB3", views: 6000, angle: "b", target: 1000 },
      { videoId: "vidB4", views: 6000, angle: "b", target: 1000 },
    ]);
    expect(liftOf(round3, "b")).toBeCloseTo(3800 / 1500, 6);
    expect(round3.standard.angle).toBe("b");
    expect(round3.history).toHaveLength(2);
    expect(round3.history.at(-1)!.standard.angle).toBe("b");
    expect(round3.sample_size).toBe(9);
  }, 120_000);
});
