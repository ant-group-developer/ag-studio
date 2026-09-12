import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, freshProject } from "./helpers.js";

// SCOPE NOTE (sub-project 1): no adapter in this control plane resolves a secret:// reference yet, so this
// test proves that the resolved value cannot leak through plan/enqueue/worker/status/events by construction.
// The Redactor + logger chain is covered by packages/core/test/observability/redaction.test.ts.
// Sub-project 3 (YouTube/TTS adapters) must add an end-to-end case where a resolved secret is actually used
// by an executor and shown to be redacted in logs and events.
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
  });
});
