import { describe, expect, it } from "vitest";
import { cli, freshProject, planRun, status } from "./helpers.js";

describe("18.3 #15 a brand-new scheduled worker needs only project path + capabilities", () => {
  it("each worker --once is a fresh process that takes work from the state store alone", () => {
    const p = freshProject();
    const runId = planRun(p);
    const owners: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = cli(p, ["worker", "--once", "--owner", `sched-${i}`]);
      expect(r.code, r.err).toBe(0);
      if (r.out.includes("idle")) break;
      owners.push(`sched-${i}`);
    }
    expect(owners).toEqual(["sched-0", "sched-1", "sched-2"]);
    const s = status(p, runId);
    expect(s.run.state).toBe("SUCCEEDED");
    expect(s.stages.map((st) => st.attempts[0]!.lease_owner)).toEqual(["sched-0", "sched-1", "sched-2"]);
  });
});
