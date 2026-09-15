import { describe, expect, it } from "vitest";
import { newId, type Demand } from "@harness/contracts";
import { cli, freshPublishWorld, librarySync, setChannelPlanning, withStore, writeLibraryItem } from "../integration/publish-helpers.js";

// Acceptance 36 (spec §4.1, §4.3): a channel whose next publish slots are already covered by approved kho
// items does not ask the studio for more work. `channelDemand` returns `needed: 0`, `plan-requests` skips
// with reason `covered` (no run, no request, no agent cost) and says so once a day through
// `channel.planning_skipped`.
describe("acceptance 36: demand already covered -> no planning run, no new request", () => {
  it("channel demand reports needed 0 and plan-requests skips with reason covered", () => {
    const world = freshPublishWorld();
    // planning is off in a plain publish world (see `writeChannelYaml`); this scenario is about the limits,
    // so it turns planning on with the fixture's own numbers rather than paying for a learning world.
    setChannelPlanning(world.channel, "channel-one", { enabled: true, lookahead_slots: 3, topics_per_run: 3, max_open_requests: 3, check_seconds: 60 });

    // `freshPublishWorld` already left one approved item in the kho; two more cover all three lookahead slots.
    for (const titleHint of ["Chợ nổi buổi trưa", "Chợ nổi buổi chiều"]) {
      writeLibraryItem(world.lib, {
        itemId: newId("library_item"), styleId: world.styleId, status: "approved", titleHint,
        extraFiles: [{ path: "thumb-01.png", body: "fake png bytes for thumb 1", mime_type: "image/png" }],
      });
    }
    librarySync(world.channel);

    const demandOut = cli(world.channel, ["channel", "demand", "channel-one", "--json"], world.secretsEnv);
    expect(demandOut.code, demandOut.err).toBe(0);
    const demand = JSON.parse(demandOut.out) as Demand;
    expect(demand.slots).toHaveLength(3);
    expect(demand.covered.items).toBe(3);
    expect(demand.needed, JSON.stringify(demand)).toBe(0);
    expect(demand.open_requests).toBe(0);

    const plan = cli(world.channel, ["channel", "plan-requests", "channel-one", "--json"], world.secretsEnv);
    expect(plan.code, plan.err).toBe(0);
    expect(JSON.parse(plan.out) as { skipped?: string; started?: unknown }).toEqual({ skipped: "covered" });

    const requests = JSON.parse(cli(world.channel, ["library", "list", "requests", "--json"], world.secretsEnv).out) as unknown[];
    expect(requests, "a covered channel must not create requests").toEqual([]);

    const { runs, skipped } = withStore(world.channel, (store) => ({
      runs: store.listRuns({}).filter((r) => r.workflow_release.id === "channel-planning"),
      skipped: store.listEvents({ event_type: "channel.planning_skipped", newest: true }),
    }));
    expect(runs, "a covered channel must not start a channel-planning run").toEqual([]);
    expect(skipped.map((e) => e.payload)).toEqual([{ channel_id: "channel-one", reason: "covered" }]);

    // same day, same reason -> the event is not repeated on every poll
    expect(cli(world.channel, ["channel", "plan-requests", "channel-one", "--json"], world.secretsEnv).code).toBe(0);
    const again = withStore(world.channel, (store) => store.listEvents({ event_type: "channel.planning_skipped", newest: true }));
    expect(again).toHaveLength(1);
  }, 120_000);
});
