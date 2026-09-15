import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { HarnessError, type ChannelLearned, type VideoMetrics } from "@harness/contracts";
import { autoPick, channelDemand, collectStats, importMetrics, planRequestsRun, type LoadedChannel } from "@harness/core";
import type { AppContext } from "../composition.js";
import { durationOfPackage } from "../composition.js";
import { requireLibrary } from "./library-stage.js";
import { print, requireChannelsLoaded, withContext } from "./shared.js";
import { autoPickDepsFor, planRequestsDepsFor } from "./worker.js";

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
        // spec §3.3: `metric_value` was always meant to ride along once `evaluateHypotheses` (Task 3) started
        // writing it -- an oversight left over from before that task landed, fixed here rather than flagged.
        const rows = ctx.store.listChannelPackages({ channel_id: id, status: "committed" }).map((p) => ({
          hypothesis_id: p.hypothesis.hypothesis_id, episode_no: p.episode_no, title: p.hypothesis.chosen.title,
          expected: p.hypothesis.expected, status: p.hypothesis.status, metric_value: p.hypothesis.evaluated?.metric_value ?? null,
        }));
        print(o.json, rows, () => rows.map((r) => `${r.hypothesis_id} ep${r.episode_no} "${r.title}" ${r.status} expect ${r.expected.metric}>=${r.expected.target}@${r.expected.horizon_hours}h metric_value=${r.metric_value ?? "-"}`).join("\n") || "no hypotheses");
      });
    });

  channel.command("stats <id>")
    .option("--json", "machine output", false)
    .description("latest video-metrics snapshot per PUBLISHED job (spec §2.5)")
    .action(async (id: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        requireChannelsLoaded(ctx);
        ctx.channels.get(id); // NOT_FOUND if the channel itself does not exist
        const jobs = ctx.store.listPublicationJobs({ channel_id: id, state: "PUBLISHED" });
        const rows = jobs.map((job) => {
          const pkg = ctx.store.getChannelPackage(job.package_id);
          const metrics = ctx.store.listVideoMetrics({ publication_job_id: job.publication_job_id });
          const latest: VideoMetrics | undefined = metrics.length > 0 ? metrics.reduce((a, b) => (b.age_hours > a.age_hours ? b : a)) : undefined;
          return {
            episode_no: pkg?.episode_no ?? 0, title: pkg?.metadata.title ?? "", publication_job_id: job.publication_job_id,
            age_hours: latest?.age_hours ?? null, views: latest?.views ?? null, impressions: latest?.impressions ?? null,
            ctr_pct: latest?.ctr_pct ?? null, avg_view_sec: latest?.avg_view_sec ?? null, snapshots: metrics.length,
            // where the newest snapshot came from -- `studio` (a real collect sweep) or `manual` (a
            // `channel metrics import` of the legacy register). Without it nothing an operator can run says
            // whether a row is a number the collector actually read or one imported from the old ledger.
            source: latest?.source ?? null,
          };
        }).sort((a, b) => b.episode_no - a.episode_no);
        print(o.json, rows, () => rows.map((r) => `ep${r.episode_no} "${r.title}" snapshots=${r.snapshots} source=${r.source ?? "-"} age_hours=${r.age_hours ?? "-"} views=${r.views ?? "-"} impressions=${r.impressions ?? "-"} ctr_pct=${r.ctr_pct ?? "-"} avg_view_sec=${r.avg_view_sec ?? "-"}`).join("\n") || "no published jobs");
      });
    });

  channel.command("collect")
    .option("--channel <id>", "restrict to one channel")
    .option("--job <id>", "restrict to one publication job")
    .option("--force", "ignore due-time gating; collect every PUBLISHED job (or --job) regardless of horizon", false)
    .option("--json", "machine output", false)
    .description("run one collectStats sweep (spec §2.4)")
    .action(async (o, cmd) => {
      await withContext(cmd, {}, async (ctx) => {
        requireChannelsLoaded(ctx);
        const report = await collectStats(
          { store: ctx.store, collector: ctx.stats, channels: ctx.channels, clock: ctx.clock, batch: ctx.learning.collectBatch, durationOf: durationOfPackage, logger: ctx.logger },
          { ...(o.channel ? { channelId: o.channel } : {}), ...(o.job ? { jobId: o.job } : {}), ...(o.force ? { force: true } : {}) },
        );
        print(o.json, report, () => `collected=${report.collected.length} blocked=${report.blocked.length} failed=${report.failed.length} evaluated=${report.evaluated.length} learned=${report.learned.length}`);
        if (report.failed.length > 0) process.exitCode = 1;
      });
    });

  channel.command("learned <id>")
    .option("--json", "machine output", false)
    .description("show the channel's learned standard (spec §3.2)")
    .action(async (id: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        requireChannelsLoaded(ctx);
        const c = ctx.channels.get(id);
        const learned: ChannelLearned = ctx.store.getChannelLearned(id) ?? {
          schema_version: "harness.channel-learned/v1", channel_id: id, updated_at: ctx.clock.now(), sample_size: 0,
          metric: null, medians: { views_72h: null, ctr_pct: null, avg_view_pct: null },
          winners: { angles: [], title_patterns: [], overlay: [] },
          standard: { note: `cần ≥${c.config.learning.min_samples} giả thuyết supported cùng nhóm; hiện có 0 đã đánh giá` },
          history: [],
        };
        print(o.json, learned, () => [
          `metric=${learned.metric ?? "-"} sample_size=${learned.sample_size}`,
          `medians: views_72h=${learned.medians.views_72h ?? "-"} ctr_pct=${learned.medians.ctr_pct ?? "-"} avg_view_pct=${learned.medians.avg_view_pct ?? "-"}`,
          `standard: angle=${learned.standard.angle ?? "-"} title_pattern=${learned.standard.title_pattern ?? "-"} overlay_lines=${learned.standard.overlay_lines ?? "-"}${learned.standard.note ? ` note="${learned.standard.note}"` : ""}`,
          `top angles: ${learned.winners.angles.slice(0, 3).map((g) => `${g.value}(lift=${g.lift.toFixed(2)})`).join(", ") || "-"}`,
          `top title_patterns: ${learned.winners.title_patterns.slice(0, 3).map((g) => `${g.value}(lift=${g.lift.toFixed(2)})`).join(", ") || "-"}`,
          `top overlay: ${learned.winners.overlay.slice(0, 3).map((g) => `${g.value}(lift=${g.lift.toFixed(2)})`).join(", ") || "-"}`,
        ].join("\n"));
      });
    });

  channel.command("demand <id>")
    .option("--json", "machine output", false)
    .description("this channel's publish-schedule demand (spec §4.1)")
    .action(async (id: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        requireChannelsLoaded(ctx);
        const c = ctx.channels.get(id);
        const library = requireLibrary(ctx);
        const libraryItems = ctx.store.listLibraryItems({ status: "approved" });
        const demand = channelDemand({ store: ctx.store, clock: ctx.clock, channel: c, libraryItems, libraryClaimsOf: (itemId: string) => library.fs.listClaims(itemId) });
        print(o.json, demand, () => `needed=${demand.needed} slots=${demand.slots.length} open_requests=${demand.open_requests}/${demand.max_open_requests}`);
      });
    });

  channel.command("plan-requests <id>")
    .option("--json", "machine output", false)
    .description("run planRequestsRun once for this channel, bypassing its own cadence (spec §4.3)")
    .action(async (id: string, o, cmd) => {
      await withContext(cmd, {}, async (ctx) => {
        requireChannelsLoaded(ctx);
        const c = ctx.channels.get(id);
        const result = await planRequestsRun(planRequestsDepsFor(ctx, c));
        print(o.json, result, () => (result.started ? `started run=${result.started.run_id} needed=${result.started.needed}` : `skipped: ${result.skipped}`));
      });
    });

  channel.command("pick-next <id>")
    .option("--json", "machine output", false)
    .description("run autoPick once for this channel (spec §4.4)")
    .action(async (id: string, o, cmd) => {
      await withContext(cmd, {}, async (ctx) => {
        requireChannelsLoaded(ctx);
        const c = ctx.channels.get(id);
        const result = await autoPick(autoPickDepsFor(ctx, c));
        print(o.json, result, () => (result.picked ? `picked item=${result.picked.item_id} run=${result.picked.run_id}` : `skipped: ${result.skipped}`));
      });
    });

  const metrics = channel.command("metrics").description("video-metrics maintenance commands");
  metrics.command("import <id> <jsonl>")
    .option("--json", "machine output", false)
    .description("import a legacy channel-metrics.jsonl register as manual snapshots (spec §2.5)")
    .action(async (id: string, jsonlPath: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        requireChannelsLoaded(ctx);
        ctx.channels.get(id); // NOT_FOUND if the channel itself does not exist
        const jsonl = readFileSync(resolve(jsonlPath), "utf8");
        const result = importMetrics(ctx.store, { channel_id: id, jsonl, clock: ctx.clock });
        print(o.json, result, () => `imported=${result.imported} skipped=${result.skipped.length}${result.skipped.length ? `\n${result.skipped.map((s) => `  ${s.videoId || "(no videoId)"}: ${s.why}`).join("\n")}` : ""}`);
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
