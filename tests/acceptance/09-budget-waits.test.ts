import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteStateStore } from "@harness/core";
import { cli, freshProject } from "./helpers.js";

interface StatusJson {
  run: { state: string; total_cost_usd: number; budget_usd?: number };
  stages: { stage_key: string; state: string }[];
}
interface EventRow { event_type: string; payload: Record<string, unknown> }

describe("18.3 #9 exceeding the run's budget parks it WAITING instead of stalling or failing silently", () => {
  it("finalize is held PENDING once spend crosses the budget line; retry --raise-budget releases it to SUCCEEDED", () => {
    const p = freshProject();
    const raw = join(p, "raw.txt");
    writeFileSync(raw, "raw bytes for the budget test");
    const ingest = JSON.parse(cli(p, ["source", "ingest", raw, "--json"]).out) as { source_id: string };
    const content = JSON.parse(cli(p, ["content", "create", "--title", "Ep", "--source", ingest.source_id, "--json"]).out) as { content_id: string };
    const plan = JSON.parse(cli(p, ["plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--content", content.content_id, "--json"]).out) as { run_id: string };
    const runId = plan.run_id;

    // profile cartoon's own budget (max_cost_usd_per_variant: 5) is too generous to exercise this path from
    // the CLI's own surface; go straight at the state store the way an operator's ops tooling would, per
    // the plan brief for this test.
    const store = new SqliteStateStore(join(p, "data", "state", "harness.db"));
    try {
      const run = store.getRun(runId)!;
      store.updateRun({ ...run, budget_usd: 0.015 });
    } finally {
      store.close();
    }

    cli(p, ["enqueue", runId]);

    // produce costs $0.01 (fake-stage): spent 0.01 < 0.015, review releases to READY
    const produceRun = cli(p, ["worker", "--once"]);
    expect(produceRun.out, produceRun.err).toBe("done");
    let s = JSON.parse(cli(p, ["status", runId, "--json"]).out) as StatusJson;
    expect(s.stages.find((st) => st.stage_key === "review")?.state).toBe("READY");
    expect(s.run.total_cost_usd).toBeCloseTo(0.01, 5);

    // review costs $0.02 (fake-review): spent 0.03 >= 0.015, finalize is gated before it ever dispatches
    const reviewRun = cli(p, ["worker", "--once"]);
    expect(reviewRun.out, reviewRun.err).toBe("done");
    s = JSON.parse(cli(p, ["status", runId, "--json"]).out) as StatusJson;
    expect(s.run.total_cost_usd).toBeCloseTo(0.03, 5);
    expect(s.run.state).toBe("WAITING");
    expect(s.stages.find((st) => st.stage_key === "finalize")?.state).toBe("PENDING");

    const events = JSON.parse(cli(p, ["events", "tail", "--run", runId, "--json", "--limit", "50"]).out) as EventRow[];
    const exceeded = events.find((e) => e.event_type === "run.budget_exceeded");
    expect(exceeded).toBeTruthy();
    expect(exceeded?.payload).toMatchObject({ spent: 0.03, budget: 0.015 });

    // nothing to dispatch while the run waits on budget
    const idle = cli(p, ["worker", "--once"]);
    expect(idle.out).toBe("idle");

    const raise = cli(p, ["retry", runId, "--raise-budget", "1"]);
    expect(raise.code, raise.err).toBe(0);
    s = JSON.parse(cli(p, ["status", runId, "--json"]).out) as StatusJson;
    expect(s.run.state).toBe("RUNNING");
    expect(s.stages.find((st) => st.stage_key === "finalize")?.state).toBe("READY");

    const finalizeRun = cli(p, ["worker", "--once"]);
    expect(finalizeRun.out, finalizeRun.err).toBe("done");
    s = JSON.parse(cli(p, ["status", runId, "--json"]).out) as StatusJson;
    expect(s.run.state).toBe("SUCCEEDED");
    expect(s.stages.every((st) => st.state === "SUCCEEDED")).toBe(true);
  });
});
