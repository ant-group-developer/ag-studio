import { describe, expect, it } from "vitest";
import { cliAsync, freshProject, planRun, status } from "./helpers.js";

describe("18.3 #1 three worker processes compete for one queue", () => {
  it("each stage is executed by exactly one attempt", async () => {
    const p = freshProject();
    const runId = planRun(p);
    // Only `produce` is READY at first; three processes race for it, then the survivors drain the rest.
    // racing workers can only claim `produce`: `review` needs read_source and `finalize` depends on it, so exactly one `done` is possible regardless of process timing
    const results = await Promise.all(["w1", "w2", "w3"].map((o) => cliAsync(p, ["worker", "--once", "--owner", o, "--capabilities", "write_workspace"])));
    expect(results.every((r) => r.code === 0)).toBe(true);
    expect(results.filter((r) => r.out.includes("done"))).toHaveLength(1);
    expect(results.filter((r) => r.out.includes("idle"))).toHaveLength(2);
    for (let i = 0; i < 6; i++) { const r = await cliAsync(p, ["worker", "--once", "--owner", "w4"]); if (r.out.includes("idle")) break; }
    const s = status(p, runId);
    expect(s.run.state).toBe("SUCCEEDED");
    for (const st of s.stages) expect(st.attempts.filter((a) => a.state === "SUCCEEDED")).toHaveLength(1);
  });
});
