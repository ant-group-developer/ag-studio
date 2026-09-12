import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, freshProject, planRun } from "./helpers.js";

describe("18.3 #11 secrets never appear in snapshot, events or logs", () => {
  it("resolved secret value is absent from every persisted and printed surface", () => {
    const p = freshProject();
    const env = { HARNESS_SECRET_YOUTUBE_CHANNEL_01: "yt-secret-value-XYZ", HARNESS_LOG_LEVEL: "debug" };
    const plan = cli(p, ["plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--json"], env);
    const { run_id } = JSON.parse(plan.out.split("\n").at(-1)!);
    cli(p, ["enqueue", run_id], env);
    for (let i = 0; i < 6; i++) { const w = cli(p, ["worker", "--once"], env); expect(w.out + w.err).not.toContain("yt-secret-value-XYZ"); if (w.out.includes("idle")) break; }
    const status = cli(p, ["status", run_id, "--json"], env);
    const events = cli(p, ["events", "tail", "--run", run_id, "--json", "--limit", "1000"], env);
    expect(status.out + status.err + events.out + events.err).not.toContain("yt-secret-value-XYZ");
    const projectYaml = readFileSync(join(p, "project.yaml"), "utf8");
    expect(projectYaml).not.toContain("yt-secret-value-XYZ");
    expect(planRun).toBeDefined();
  });
});
