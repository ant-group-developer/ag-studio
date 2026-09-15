import { describe, expect, it } from "vitest";
import type { ContentRequest, Demand } from "@harness/contracts";
import { cli, freshPublishWorld, setChannelPlanning, withStore } from "../integration/publish-helpers.js";

// Acceptance 37 (spec §4.1, §6): `max_open_requests` is a hard ceiling on how much unfinished work a channel
// may have queued at the studio. Even with slots still uncovered (`needed > 0`), a channel already holding its
// full quota of open requests plans nothing and says `open-cap` -- otherwise a channel with a generous
// lookahead would keep piling requests onto a studio that has not caught up yet.
describe("acceptance 37: max_open_requests blocks planning even while demand is unmet", () => {
  it("needed > 0 but open_requests == max_open_requests -> plan-requests skips with reason open-cap", () => {
    const world = freshPublishWorld();
    // lookahead deliberately *above* the open-request ceiling: that is the only shape in which `needed > 0`
    // and `open_requests >= max_open_requests` can hold at the same time (three open requests cover three of
    // the five slots, so two stay uncovered).
    setChannelPlanning(world.channel, "channel-one", { enabled: true, lookahead_slots: 5, topics_per_run: 3, max_open_requests: 3, check_seconds: 60 });

    const requestIds: string[] = [];
    for (const topic of ["Chợ nổi Cái Răng", "Chợ nổi Phong Điền", "Chợ nổi Ngã Bảy"]) {
      const r = cli(world.channel, [
        "library", "request", "create", "--portfolio", "portfolio-channel", "--channel", "channel-one",
        "--topic", topic, "--style", world.styleId, "--duration", "1,60", "--json",
      ], world.secretsEnv);
      expect(r.code, r.err).toBe(0);
      requestIds.push((JSON.parse(r.out) as ContentRequest).request_id);
    }
    expect(cli(world.channel, ["library", "sync", "--json"], world.secretsEnv).code).toBe(0);

    const demand = JSON.parse(cli(world.channel, ["channel", "demand", "channel-one", "--json"], world.secretsEnv).out) as Demand;
    expect(demand.slots).toHaveLength(5);
    expect(demand.open_requests).toBe(3);
    expect(demand.max_open_requests).toBe(3);
    expect(demand.needed, JSON.stringify(demand)).toBeGreaterThan(0);

    const plan = cli(world.channel, ["channel", "plan-requests", "channel-one", "--json"], world.secretsEnv);
    expect(plan.code, plan.err).toBe(0);
    expect(JSON.parse(plan.out) as { skipped?: string }).toEqual({ skipped: "open-cap" });

    const after = JSON.parse(cli(world.channel, ["library", "list", "requests", "--json"], world.secretsEnv).out) as ContentRequest[];
    expect(after.map((r) => r.request_id).sort()).toEqual([...requestIds].sort());

    const { runs, skipped } = withStore(world.channel, (store) => ({
      runs: store.listRuns({}).filter((r) => r.workflow_release.id === "channel-planning"),
      skipped: store.listEvents({ event_type: "channel.planning_skipped", newest: true }),
    }));
    expect(runs).toEqual([]);
    expect(skipped.map((e) => e.payload)).toEqual([{ channel_id: "channel-one", reason: "open-cap" }]);
  }, 120_000);
});
