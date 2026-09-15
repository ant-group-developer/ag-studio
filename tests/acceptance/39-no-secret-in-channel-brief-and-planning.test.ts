import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cli, drain, freshPublishWorld, setChannelPlanning, status } from "../integration/publish-helpers.js";

const SECRET_VALUE = "s3cret";
const SECRET_NAME = "HARNESS_SECRET_X_Y";
/** The value behind `channels/channel-one/channel.yaml`'s `youtube.account_email_ref` -- resolvable in this
 * world (it is in `secretsEnv`), and just as forbidden from any file or event as the anonymous secret above. */
const ACCOUNT_EMAIL = "owner@example.com";

/** Every file under `root`, recursively (mirrors acceptance 25/31's own `allFiles`). */
function allFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return (readdirSync(root, { recursive: true }) as string[]).map((rel) => join(root, rel)).filter((p) => statSync(p).isFile());
}

// Acceptance 39 (spec §6, ADR-0001 §71/§77): the channel-planning run is the first thing in sub-project 3B
// that hands a *channel's* own context (SEO, learned standard, recent numbers, open requests) to an agent, so
// it is the first thing that could leak one. `HARNESS_SECRET_X_Y=s3cret` sits in the ambient env of every
// command here, and the channel's YouTube account email is a resolvable secret of this very channel -- neither
// may appear in `channel-brief.json`, in the prompt the agent reads, in any stage log, or in the event log.
describe("acceptance 39: no secret leaks out of a channel-planning run", () => {
  it("HARNESS_SECRET_X_Y / the channel account email appear in no artifact, prompt, log or event", () => {
    const world = freshPublishWorld();
    setChannelPlanning(world.channel, "channel-one", { enabled: true, lookahead_slots: 3, topics_per_run: 3, max_open_requests: 3, check_seconds: 60 });
    const env = { ...world.secretsEnv, [SECRET_NAME]: SECRET_VALUE };

    const plan = cli(world.channel, ["channel", "plan-requests", "channel-one", "--json"], env);
    expect(plan.code, plan.err).toBe(0);
    const started = (JSON.parse(plan.out) as { started?: { run_id: string } }).started;
    expect(started, plan.out).toBeDefined();

    drain(world.channel, env);
    const st = status(world.channel, started!.run_id);
    expect(st.run.state, JSON.stringify(st.stages)).toBe("SUCCEEDED");
    for (const s of st.stages) expect(s.state, s.stage_key).toBe("SUCCEEDED");

    // data/workspaces holds every attempt's agent-prompt.md, logs/*.log and stage-result.json;
    // data/artifacts holds the committed channel-brief.json / demand.json / topics.json.
    const files = [...allFiles(join(world.channel, "data", "workspaces")), ...allFiles(join(world.channel, "data", "artifacts"))];
    expect(files.some((f) => f.endsWith("channel-brief.json")), "no channel-brief.json anywhere: the scan below would be vacuous").toBe(true);
    expect(files.some((f) => f.endsWith("agent-prompt.md")), "no agent prompt anywhere: the scan below would be vacuous").toBe(true);
    expect(files.some((f) => f.endsWith(".log")), "no stage log anywhere: the scan below would be vacuous").toBe(true);

    for (const f of files) {
      const content = readFileSync(f, "utf8");
      expect(content, `${f} contains the secret value`).not.toContain(SECRET_VALUE);
      expect(content, `${f} contains ${SECRET_NAME}`).not.toContain(SECRET_NAME);
      expect(content, `${f} contains the channel account email`).not.toContain(ACCOUNT_EMAIL);
    }

    const events = cli(world.channel, ["events", "tail", "--limit", "2000", "--json"], env);
    expect(events.code, events.err).toBe(0);
    expect(events.out).not.toContain(SECRET_VALUE);
    expect(events.out).not.toContain(SECRET_NAME);
    expect(events.out).not.toContain(ACCOUNT_EMAIL);
  }, 120_000);
});
