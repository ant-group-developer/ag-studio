import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasFfmpeg } from "../media.js";
import { cli, drain, freshPublishWorld, jobs, pickAndPlan, status } from "../integration/publish-helpers.js";

// Acceptance 25: the resolved YouTube account-email secret (and the raw HARNESS_SECRET_* env var name that
// carries it) must never land on disk or in the event log, across a full real run with both the agent CLI
// (env-dump mode: it prints every HARNESS_-prefixed env var it can see) and the upload publisher (whose fake
// legacy script prints the account email to its own stdout on every mode) in play.

const SECRET_VALUE = "owner@example.com";
// The concrete resolved env var names, not the bare "HARNESS_SECRET_" prefix: skills/channel-package/SKILL.md
// (committed, legitimately embedded into every agent-prompt.md) itself warns the agent "không đọc hay ghi
// ... biến HARNESS_SECRET_* nào" -- that generic wildcard mention is the rule, not a leak. A concrete name
// like HARNESS_SECRET_YOUTUBE_CHANNEL_ONE_EMAIL appearing anywhere, on the other hand, only happens if
// something actually dumped this world's real env (e.g. FAKE_AGENT_MODE=env-dump failing to strip it).
const SECRET_NAMES = ["HARNESS_SECRET_YOUTUBE_CHANNEL_ONE_EMAIL", "HARNESS_SECRET_YOUTUBE_CHANNEL_TWO_EMAIL"];

/** Every file under `root`, recursively -- `fs.readdirSync(..., { recursive: true })` (Node >=20). */
function allFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return (readdirSync(root, { recursive: true }) as string[])
    .map((rel) => join(root, rel))
    .filter((p) => statSync(p).isFile());
}

/** `data/workspaces/**\/{logs/*.log,stage-result.json,agent-prompt.md}` plus `data/publications/**\/*.log` --
 * exactly the file set acceptance 25 names. */
function leakCandidates(project: string): string[] {
  const files: string[] = [];
  for (const p of allFiles(join(project, "data", "workspaces"))) {
    const base = p.split(/[\\/]/).pop()!;
    if (base.endsWith(".log") || base === "stage-result.json" || base === "agent-prompt.md") files.push(p);
  }
  for (const p of allFiles(join(project, "data", "publications"))) {
    if (p.endsWith(".log")) files.push(p);
  }
  return files;
}

describe.skipIf(!hasFfmpeg())("acceptance 25: no secret value or HARNESS_SECRET_ name leaks into logs, results, prompts, or events", () => {
  it("a full run with FAKE_AGENT_MODE=env-dump and FAKE_UPLOAD_MODE=ok never writes the secret anywhere checked", () => {
    const world = freshPublishWorld({ uploadMode: "ok", scheduleMode: "ok", agentMode: "env-dump" });
    const { runId } = pickAndPlan(world, "channel-one");
    drain(world.channel, world.secretsEnv);

    // sanity: the run actually exercised the agent (package) and the publisher (upload) end to end.
    const st = status(world.channel, runId);
    expect(st.stages.find((s) => s.stage_key === "package")?.state).toBe("SUCCEEDED");
    expect(jobs(world, "channel-one")[0]?.state).toBe("SCHEDULED");

    const files = leakCandidates(world.channel);
    expect(files.length).toBeGreaterThan(0); // the assertion below would be vacuous over an empty list
    let sawUploadEnvProbe = false;
    for (const f of files) {
      const content = readFileSync(f, "utf8");
      expect(content, `${f} contains the secret value`).not.toContain(SECRET_VALUE);
      for (const name of SECRET_NAMES) expect(content, `${f} contains ${name}`).not.toContain(name);
      // The fixture upload script prints the *names* of every HARNESS_SECRET_* var its own process can see
      // (`[upload] env=<names>`); `PlaywrightPublisher` strips them from the child env, so the list is empty.
      // (the char class stops at the closing quote/escape of the JSON log line the sdk emits around it)
      for (const m of content.matchAll(/\[upload\] env=([^"\\\r\n]*)/g)) {
        sawUploadEnvProbe = true;
        expect(m[1]!.trim(), `${f}: the upload child saw HARNESS_SECRET_* vars`).toBe("");
      }
    }
    expect(sawUploadEnvProbe, "the upload script's env probe never reached any log").toBe(true);

    const events = cli(world.channel, ["events", "tail", "--run", runId, "--limit", "1000", "--json"], world.secretsEnv);
    expect(events.code, events.err).toBe(0);
    expect(events.out).not.toContain(SECRET_VALUE);
    for (const name of SECRET_NAMES) expect(events.out).not.toContain(name);
  }, 300_000);
});
