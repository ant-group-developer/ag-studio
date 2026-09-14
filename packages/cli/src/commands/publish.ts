import type { Command } from "commander";
import { HarnessError } from "@harness/contracts";
import { nextSlot, reconcilePublication, transitionPublication, verifyScheduled } from "@harness/core";
import { print, requireChannelsLoaded, withContext } from "./shared.js";
import { registerPublishStage } from "./publish-stage.js";

const CANCELLABLE_STATES = new Set(["READY", "PROCESSING", "SCHEDULED"]);

/** `harness publish …`: the built-in stage subcommands (Task 8) plus the human-facing ones (Task 9). */
export function registerPublish(program: Command): void {
  const publish = program.command("publish").description("channel-publish commands (spec §3, §4.1)");
  registerPublishStage(publish);

  publish.command("list")
    .option("--channel <id>", "filter to one channel").option("--state <state>", "filter to one PublicationJob state")
    .option("--json", "machine output", false)
    .description("list publication jobs")
    .action(async (o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const jobs = ctx.store.listPublicationJobs({ ...(o.channel ? { channel_id: o.channel } : {}), ...(o.state ? { state: o.state } : {}) });
        print(o.json, jobs, () => jobs.map((j) => `${j.publication_job_id} ${j.state.padEnd(20)} channel=${j.channel_id} video=${j.youtube_video_id ?? "-"} scheduled_at=${j.scheduled_at ?? "-"}`).join("\n") || "no publication jobs");
      });
    });

  publish.command("show <job>")
    .option("--json", "machine output", false)
    .description("show a publication job, its package title/episode, and its events")
    .action(async (jobId: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const job = ctx.store.getPublicationJob(jobId);
        if (!job) throw new HarnessError("NOT_FOUND", `publication job not found: ${jobId}`, { publication_job_id: jobId });
        const pkg = ctx.store.getChannelPackage(job.package_id);
        const events = ctx.store.listEvents({ run_id: job.run_id }).filter((e) => e.payload.publication_job_id === jobId);
        const out = { job, title: pkg?.metadata.title ?? null, episode_no: pkg?.episode_no ?? null, events };
        print(o.json, out, () => [
          `${job.publication_job_id} ${job.state} channel=${job.channel_id}`,
          `title="${pkg?.metadata.title ?? ""}" episode_no=${pkg?.episode_no ?? "-"}`,
          `events: ${events.length}`,
        ].join("\n"));
      });
    });

  publish.command("slots <channel>")
    .option("--days <n>", "how many upcoming slots to compute", "7").option("--json", "machine output", false)
    .description("preview the channel's next free publish slots (does not book anything)")
    .action(async (channelId: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        requireChannelsLoaded(ctx);
        const channel = ctx.channels.get(channelId);
        const n = Number(o.days);
        if (!Number.isInteger(n) || n < 1) throw new HarnessError("CONFIG_INVALID", `--days must be a positive integer, got "${o.days}"`, { days: o.days });
        const taken = ctx.store.listPublicationJobs({ channel_id: channelId })
          .filter((j) => j.state === "SCHEDULED" || j.state === "PUBLISHED")
          .map((j) => j.scheduled_at).filter((at): at is string => at !== null);
        const slots: string[] = [];
        for (let i = 0; i < n; i++) {
          const slot = nextSlot(channel.config.publication, taken, ctx.clock.now());
          slots.push(slot);
          taken.push(slot);
        }
        print(o.json, slots, () => slots.join("\n"));
      });
    });

  publish.command("verify")
    .option("--json", "machine output", false)
    .description("sweep overdue SCHEDULED publication jobs once, settling PUBLISHED or parking NEEDS_RECONCILIATION")
    .action(async (o, cmd) => {
      await withContext(cmd, {}, async (ctx) => {
        const report = await verifyScheduled({ store: ctx.store, publisher: ctx.publisher, channels: ctx.channels, clock: ctx.clock, graceHours: ctx.publication.graceHours });
        print(o.json, report, () => `checked=${report.checked.length} published=${report.published.length} reconcile=${report.reconcile.length} errors=${report.errors.length} warnings=${report.warnings.length}`);
        if (report.errors.length > 0) process.exitCode = 1;
      });
    });

  publish.command("reconcile <job>")
    .option("--json", "machine output", false)
    .description("resolve one publication job stuck in NEEDS_RECONCILIATION by asking the publisher what happened")
    .action(async (jobId: string, o, cmd) => {
      await withContext(cmd, {}, async (ctx) => {
        const report = await reconcilePublication({ store: ctx.store, publisher: ctx.publisher, channels: ctx.channels, journal: ctx.journal, planner: ctx.planner, clock: ctx.clock }, jobId);
        print(o.json, report, () => `${report.job_id} ${report.from} -> ${report.to} video=${report.video_id ?? "-"}${report.note ? `\nnote: ${report.note}` : ""}`);
      });
    });

  publish.command("cancel <job>")
    .requiredOption("--note <text>", "why this job is being cancelled")
    .option("--json", "machine output", false)
    .description("cancel a READY/PROCESSING/SCHEDULED publication job (-> FAILED, with note); never touches YouTube")
    .action(async (jobId: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const job = ctx.store.getPublicationJob(jobId);
        if (!job) throw new HarnessError("NOT_FOUND", `publication job not found: ${jobId}`, { publication_job_id: jobId });
        if (!CANCELLABLE_STATES.has(job.state)) {
          throw new HarnessError("INVALID_TRANSITION", `publication job ${jobId} is ${job.state}; cancel needs one of ${[...CANCELLABLE_STATES].join("/")}`, { publication_job_id: jobId, state: job.state });
        }
        // Transition first, note second, both inside one transaction (mirrors verify.ts's own
        // transition-then-annotate order at packages/core/src/distribution/verify.ts:40-58): if a
        // concurrent writer (e.g. the worker's verify sweep) has already moved the job past `job.state`,
        // `transitionPublication`'s own store.transition throws STALE_STATE and nothing commits -- the
        // note is never written. The previous note-first order (two separate top-level store calls) could
        // leave a "cancelled" note on a job whose state had actually moved on in that same race window.
        const updated = ctx.store.transaction(() => {
          const afterTransition = transitionPublication(ctx.store, jobId, job.state, "FAILED", { reason: o.note });
          const fresh = ctx.store.getPublicationJob(jobId) ?? afterTransition;
          ctx.store.updatePublicationJob({ ...fresh, note: o.note });
          return ctx.store.getPublicationJob(jobId)!;
        });
        print(o.json, updated, () => `${updated.publication_job_id} ${updated.state}`);
      });
    });
}
