import { describe, expect, it } from "vitest";
import { hasFfmpeg } from "../media.js";
import { writeLibraryItem } from "../integration/library-helpers.js";
import { drain, freshPublishWorld, pickAndPlan, status } from "../integration/publish-helpers.js";

// Acceptance 23: a kho item withdrawn after a channel already picked it (a studio catches a rights problem,
// say) must never reach the legacy repo -- `fetch-library-item` reads the manifest straight off the shared
// kho filesystem on every attempt, so rewriting it between `pick` and the stage actually running reproduces
// exactly that race without needing a second process.
describe.skipIf(!hasFfmpeg())("acceptance 23: an item withdrawn after being picked is never fetched", () => {
  it("fetch-library-item fails contract, mentioning the item is withdrawn", () => {
    const world = freshPublishWorld();
    const { runId } = pickAndPlan(world, "channel-one");

    writeLibraryItem(world.lib, { itemId: world.itemId, styleId: world.styleId, status: "withdrawn" });

    drain(world.channel, world.secretsEnv);

    const st = status(world.channel, runId);
    const fetch = st.stages.find((s) => s.stage_key === "fetch-library-item")!;
    // a "contract" failure parks the stage_run WAITING_HUMAN (not FAILED/retried) -- it is a bad input to
    // this run, not a transient executor problem, and only a human re-planning fixes it.
    expect(fetch.state).toBe("WAITING_HUMAN");
    const lastAttempt = fetch.attempts.at(-1)!;
    expect(lastAttempt.state).toBe("FAILED");
    expect(lastAttempt.failure_kind).toBe("contract");
    expect(lastAttempt.error_summary ?? "").toContain("withdrawn");
  }, 300_000);
});
