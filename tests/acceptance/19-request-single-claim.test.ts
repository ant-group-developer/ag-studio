import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type ContentRequest } from "@harness/contracts";
import { cli, freshLibraryWorld, librarySync, setResourceCapacity, status, writeActiveStyle } from "../integration/library-helpers.js";

// Acceptance 19: two runs accepted from the same content request race for it; exactly one gets to produce.
// `intake` is the only stage either run reaches here -- the cpu capacity is starved to 0 so `claim()` skips
// `index-source` (the one stage that would need ffmpeg) and keeps handing the worker the two `intake`s.
describe("acceptance 19: only one run ever claims a content request", () => {
  it("lets one intake through and parks the other with a contract failure, leaving the request claimed once", () => {
    const world = freshLibraryWorld({ media: false });
    // cpu: 0 starves `index-source`, the only stage besides `intake` that is ready from the start
    setResourceCapacity(world.studio, "cpu", 0);

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);

    const created = cli(world.channel, [
      "library", "request", "create", "--portfolio", "portfolio-channel", "--channel", "channel-one",
      "--topic", "một yêu cầu, hai run", "--style", styleId, "--voice", "none", "--json",
    ]);
    expect(created.code, created.err).toBe(0);
    const requestId = (JSON.parse(created.out) as ContentRequest).request_id;
    const requestFile = (): ContentRequest => JSON.parse(readFileSync(join(world.lib, "requests", `${requestId}.json`), "utf8")) as ContentRequest;
    expect(requestFile().count).toBe(1);

    expect(librarySync(world.studio).imported.requests).toContain(requestId);

    // a source of some kind is required to accept; nothing ever reads it, since index-source never runs
    const rawPath = join(world.studio, "raw", "notes.txt");
    writeFileSync(rawPath, "stand-in for the footage this request would be cut from\n");
    const ingested = cli(world.studio, ["source", "ingest", rawPath, "--rights", "cleared", "--json"]);
    expect(ingested.code, ingested.err).toBe(0);
    const sourceId = (JSON.parse(ingested.out) as { source_id: string }).source_id;

    // the same open request accepted twice: two ContentItems, each carrying the same request_id in its brief
    const runs = [0, 1].map(() => {
      const accepted = cli(world.studio, ["library", "accept", "--request", requestId, "--source", sourceId, "--json"]);
      expect(accepted.code, accepted.err).toBe(0);
      const contentId = (JSON.parse(accepted.out) as { content_id: string }).content_id;
      const planned = cli(world.studio, ["plan", "--workflow", "library-production@1.0.0", "--profile", "studio", "--content", contentId, "--option", "voice=none", "--json"]);
      expect(planned.code, planned.err).toBe(0);
      const runId = (JSON.parse(planned.out) as { run_id: string }).run_id;
      expect(cli(world.studio, ["enqueue", runId]).code).toBe(0);
      return runId;
    });
    expect(new Set(runs).size).toBe(2);

    const intakeState = (runId: string): string => status(world.studio, runId).stages.find((s) => s.stage_key === "intake")!.state;
    // one `worker --once` claims one stage; loop until neither intake is waiting to be claimed any more
    for (let i = 0; i < 10 && runs.some((r) => intakeState(r) === "READY"); i++) cli(world.studio, ["worker", "--once"]);
    expect(runs.map(intakeState).some((s) => s === "READY")).toBe(false);

    const intakes = runs.map((runId) => ({ runId, stage: status(world.studio, runId).stages.find((s) => s.stage_key === "intake")! }));
    const winners = intakes.filter((i) => i.stage.state === "SUCCEEDED");
    const losers = intakes.filter((i) => i.stage.state !== "SUCCEEDED");
    expect(winners, JSON.stringify(intakes.map((i) => [i.runId, i.stage.state]))).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // the loser is parked for a human with a contract failure, not retried into the ground. (The failure
    // kind lives on the attempt: `stage_run.last_failure_kind` is only written when a retry is *scheduled*,
    // and a contract failure is never retried.)
    expect(losers[0]!.stage.state).toBe("WAITING_HUMAN");
    const lastAttempt = losers[0]!.stage.attempts.at(-1)!;
    expect(lastAttempt.failure_kind).toBe("contract");
    expect(lastAttempt.error_summary).toContain("already claimed");

    // and the kho agrees: claimed exactly once, by the winner
    const claimed = requestFile();
    expect(claimed.status).toBe("claimed");
    expect(claimed.claimed_by_run).toEqual({ project_id: "project-studio", run_id: winners[0]!.runId });

    // the operator's resolution: cancel both runs (the loser is dead, the winner needs its cpu back)
    for (const runId of runs) {
      expect(cli(world.studio, ["cancel", runId]).code, `cancel ${runId}`).toBe(0);
      expect(status(world.studio, runId).run.state).toBe("CANCELLED");
    }
  });
});
