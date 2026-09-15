import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@harness/contracts";
import { hasFfmpeg } from "../media.js";
import { cli, freshLibraryWorld, requestCreate, requestStatus, studioWorkerUntil, writeActiveStyle } from "../integration/library-helpers.js";

const SECRET_VALUE = "s3cret";
const SECRET_NAME = "HARNESS_SECRET_X_Y";

/** Every file under `root`, recursively (mirrors acceptance 25's own `allFiles`). */
function allFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return (readdirSync(root, { recursive: true }) as string[]).map((rel) => join(root, rel)).filter((p) => statSync(p).isFile());
}

/** `data/workspaces/**\/{logs/*.log,stage-result.json,agent-prompt.md}` -- exactly what acceptance 31 names. */
function leakCandidates(project: string): string[] {
  return allFiles(join(project, "data", "workspaces")).filter((p) => {
    const base = p.split(/[\\/]/).pop()!;
    return base.endsWith(".log") || base === "stage-result.json" || base === "agent-prompt.md";
  });
}

// Acceptance 31: `HARNESS_SECRET_X_Y` (a name not declared anywhere in this fixture's scripts.yaml -- deliberately,
// same convention as the cli-agent-runtime unit test's own "env-dump" case) sits in the ambient env of every
// `worker --once` call across a full autopilot run: three agent stages (survey-source, plan-edit,
// library-review) each spawn the fake agent CLI. `agentChildEnv` (packages/adapters/agent-cli/src/cli-agent-runtime.ts)
// strips any `HARNESS_SECRET_*` key by name prefix regardless of `env_passthrough` -- this is the same
// protection the task-8 fix commit had to preserve while adding FAKE_REVIEW_MODE/FAKE_AGENT_FAIL_STAGE/
// FAKE_STYLE_STATUS/FAKE_STYLE_REVIEW to that allow-list, proven here end to end through the real composition
// root instead of only at the unit level.
describe.skipIf(!hasFfmpeg())("acceptance 31: no secret leaks out of a studio autopilot run", () => {
  it("HARNESS_SECRET_X_Y=s3cret never appears in a workspace log/prompt/result or the event log", () => {
    const world = freshLibraryWorld({ media: true, autopilot: true });
    const env = { FAKE_REVIEW_MODE: "approve", HARNESS_SECRET_X_Y: SECRET_VALUE };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    const ingested = cli(world.studio, ["source", "ingest", world.sample, "--rights", "cleared", "--json"], env);
    expect(ingested.code, ingested.err).toBe(0);

    const requestId = requestCreate(world, { topic: "Không rò rỉ secret", style: styleId, sourceHint: "main", voice: "none" });
    studioWorkerUntil(world, () => requestStatus(world, requestId).status === "fulfilled", 250, env);
    expect(requestStatus(world, requestId).status).toBe("fulfilled");

    const files = leakCandidates(world.studio);
    expect(files.length).toBeGreaterThan(0); // the loop below would be vacuous over an empty list
    for (const f of files) {
      const content = readFileSync(f, "utf8");
      expect(content, `${f} contains the secret value`).not.toContain(SECRET_VALUE);
      expect(content, `${f} contains ${SECRET_NAME}`).not.toContain(SECRET_NAME);
    }

    const events = cli(world.studio, ["events", "tail", "--limit", "2000", "--json"], env);
    expect(events.code, events.err).toBe(0);
    expect(events.out).not.toContain(SECRET_VALUE);
    expect(events.out).not.toContain(SECRET_NAME);
  }, 300_000);
});
