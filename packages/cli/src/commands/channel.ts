import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { HarnessError } from "@harness/contracts";
import type { LoadedChannel } from "@harness/core";
import type { AppContext } from "../composition.js";
import { print, requireChannelsLoaded, withContext } from "./shared.js";

/** "episode next" for `channel list`: the channel's own `channel_sequence` counter is only readable by
 * mutating it (`store.allocateEpisodeNo`), which a plain `list` must never do -- so this reads it the way
 * `allocateEpisodeNo` itself would compute the value without a row yet: one past the highest episode number
 * already committed for the channel, or `channel.yaml`'s `episode.start` when nothing has been committed. */
function nextEpisodeNo(app: AppContext, channel: LoadedChannel): number {
  const highest = app.store.listChannelPackages({ channel_id: channel.config.channel_id }).reduce((max, p) => Math.max(max, p.episode_no), 0);
  return highest > 0 ? highest + 1 : channel.config.episode.start;
}

function channelSummary(app: AppContext, c: LoadedChannel) {
  return {
    channel_id: c.config.channel_id,
    display_name: c.config.display_name,
    publish_times: c.config.publication.publish_times,
    timezone: c.config.publication.timezone,
    episode_next: nextEpisodeNo(app, c),
  };
}

export function registerChannel(program: Command): void {
  const channel = program.command("channel").description("channel-publish channel commands (spec §3, §4.1)");

  channel.command("list")
    .option("--json", "machine output", false)
    .description("list channels declared under channels/")
    .action(async (o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        requireChannelsLoaded(ctx);
        const rows = ctx.channels.list().map((c) => channelSummary(ctx, c));
        print(o.json, rows, () => rows.map((r) => `${r.channel_id} "${r.display_name}" tz=${r.timezone} times=${r.publish_times.join(",")} next_ep=${r.episode_next}`).join("\n") || "no channels");
      });
    });

  channel.command("show <id>")
    .option("--json", "machine output", false)
    .description("show one channel's config and its publication jobs by state")
    .action(async (id: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        requireChannelsLoaded(ctx);
        const c = ctx.channels.get(id);
        const jobs_by_state: Record<string, number> = {};
        for (const j of ctx.store.listPublicationJobs({ channel_id: id })) jobs_by_state[j.state] = (jobs_by_state[j.state] ?? 0) + 1;
        const out = { config: c.config, config_revision: c.config_revision, jobs_by_state };
        print(o.json, out, () => [
          `${c.config.channel_id} "${c.config.display_name}" rev=${c.config_revision}`,
          ...Object.entries(jobs_by_state).map(([state, n]) => `  ${state}: ${n}`),
        ].join("\n"));
      });
    });

  channel.command("hypotheses <id>")
    .option("--json", "machine output", false)
    .description("list the thumbnail/title hypotheses of this channel's committed packages")
    .action(async (id: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        requireChannelsLoaded(ctx);
        ctx.channels.get(id); // NOT_FOUND if the channel itself does not exist
        const rows = ctx.store.listChannelPackages({ channel_id: id, status: "committed" }).map((p) => ({
          hypothesis_id: p.hypothesis.hypothesis_id, episode_no: p.episode_no, title: p.hypothesis.chosen.title,
          expected: p.hypothesis.expected, status: p.hypothesis.status,
        }));
        print(o.json, rows, () => rows.map((r) => `${r.hypothesis_id} ep${r.episode_no} "${r.title}" ${r.status} expect ${r.expected.metric}>=${r.expected.target}@${r.expected.horizon_hours}h`).join("\n") || "no hypotheses");
      });
    });

  channel.command("login <id>")
    .description("open this channel's Chrome profile for a manual YouTube login (spec §4.1)")
    .action(async (id: string, _o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        requireChannelsLoaded(ctx);
        const c = ctx.channels.get(id);
        const repoDir = resolve(c.config.repo_dir);
        const script = join(repoDir, "scripts", "open-channel-chrome.mjs");
        if (existsSync(script)) {
          const r = spawnSync(process.execPath, [script], { cwd: repoDir, stdio: "inherit" });
          if (r.status !== 0) throw new HarnessError("EXECUTOR_FAILED", `open-channel-chrome.mjs exited with code ${r.status}`, { channel_id: id, status: r.status });
        } else {
          const profileDir = join(repoDir, ".upload-profile");
          process.stdout.write(`No scripts/open-channel-chrome.mjs in ${repoDir}. Open Chrome manually with:\n  chrome --user-data-dir=${profileDir}\n`);
        }
      });
    });
}
