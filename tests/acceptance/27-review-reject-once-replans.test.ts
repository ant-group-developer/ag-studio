import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { newId, type LibraryItem } from "@harness/contracts";
import { SqliteStateStore } from "@harness/core";
import { hasFfmpeg } from "../media.js";
import { cli, freshLibraryWorld, requestCreate, requestStatus, stageId, status, studioWorkerUntil, writeActiveStyle } from "../integration/library-helpers.js";

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

/** `output/brief.json` the `intake` stage of `runId` wrote, read straight off its committed artifact (same
 * `fileURLToPath(artifact.uri)` trick `studio-autopilot.test.ts`/`library-pipeline.test.ts` use). */
function briefOf(project: string, runId: string): { request_notes?: string } {
  const sid = stageId(project, runId, "intake");
  const artifact = status(project, runId).artifacts.find((a) => a.stage_run_id === sid && a.type === "brief") as unknown as { uri: string } | undefined;
  expect(artifact, `no brief artifact for intake on run ${runId}`).toBeDefined();
  return readJson(fileURLToPath(artifact!.uri));
}

// Acceptance 27: FAKE_REVIEW_MODE=reject-once (fixtures/fake-agent-cli.mjs's buildReview) rejects a run's
// first pass and approves its second, once the reopened request carries the rejection note forward as
// `request_notes` -- proving the studio autopilot loop actually replans instead of just retrying the same
// run (library-apply-review always ends the run SUCCEEDED either way; it is `library-review`'s *decision*
// that differs between the two runs).
describe.skipIf(!hasFfmpeg())("acceptance 27: a rejected review reopens the request and the studio auto-replans it", () => {
  it("run 1 is rejected, run 2 (replan_no 1) is approved, and run 2's brief carries the rejection note forward", () => {
    const world = freshLibraryWorld({ media: true, autopilot: true });
    const env = { FAKE_REVIEW_MODE: "reject-once" };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    const ingested = cli(world.studio, ["source", "ingest", world.sample, "--rights", "cleared", "--json"], env);
    expect(ingested.code, ingested.err).toBe(0);

    const requestId = requestCreate(world, { topic: "Một yêu cầu bị từ chối một lần", style: styleId, sourceHint: "main", voice: "none" });

    studioWorkerUntil(world, () => requestStatus(world, requestId).status === "fulfilled", 250, env);
    const fulfilled = requestStatus(world, requestId);
    expect(fulfilled.status, JSON.stringify(fulfilled)).toBe("fulfilled");

    const store = new SqliteStateStore(join(world.studio, "data", "state", "harness.db"));
    let run0Id: string; let run1Id: string;
    try {
      const acceptedEvents = store.listEvents({ event_type: "request.auto_accepted" }).filter((e) => e.payload.request_id === requestId);
      expect(acceptedEvents).toHaveLength(2);
      const byReplan = new Map(acceptedEvents.map((e) => [e.payload.replan_no as number, e.payload.run_id as string]));
      expect([...byReplan.keys()].sort()).toEqual([0, 1]);
      run0Id = byReplan.get(0)!;
      run1Id = byReplan.get(1)!;
      expect(store.getRun(run0Id)?.state).toBe("SUCCEEDED");
      expect(store.getRun(run1Id)?.state).toBe("SUCCEEDED");
    } finally {
      store.close();
    }

    // two items in the kho: the rejected one from run 0, the approved one from run 1
    const itemIds = readdirSync(join(world.lib, "items"));
    expect(itemIds).toHaveLength(2);
    const manifests = itemIds.map((id) => readJson<LibraryItem>(join(world.lib, "items", id, "manifest.json")));
    const byRun = new Map(manifests.map((m) => [m.lineage.run_id, m]));
    expect(byRun.get(run0Id!)?.status).toBe("rejected");
    expect(byRun.get(run1Id!)?.status).toBe("approved");
    expect(fulfilled.item_ids).toEqual([byRun.get(run1Id!)!.item_id]);

    // run 2's brief carries the rejection note forward (intake copies request.notes into brief.request_notes)
    const brief1 = briefOf(world.studio, run1Id!);
    expect(brief1.request_notes, JSON.stringify(brief1)).toBeTruthy();
    expect(brief1.request_notes!.length).toBeGreaterThan(0);
  }, 600_000);
});
