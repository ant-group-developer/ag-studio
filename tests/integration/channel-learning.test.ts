import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newId, type ChannelBrief, type ChannelLearned, type LibraryItem, type PublicationJob, type Run } from "@harness/contracts";
import { hasFfmpeg } from "../media.js";
import {
  backdatePublished, channelRequests, channelWorkerUntil, cli, freshPublishWorld, jobs, librarySync, packageFor, statsFile,
  status, studioWorkerUntil, withStore, writeLibraryItem, writeLookup, type PublishWorld,
} from "./publish-helpers.js";

// Task 7 (sub-project 3B): the channel learning loop end to end across the two machines, with no human
// command on either beyond `worker --once` (plus the one-time studio setup every SP4 scenario needs: the raw
// footage, and the active kho style that stands in for a finished style-study). One empty channel plans its
// own topics through `channel-planning@1.0.0`, the studio autopilot (SP4) builds an episode per request, the
// channel auto-picks and publishes each one through `channel-publish@1.1.0`, the collect sweep reads faked
// Studio numbers, hypotheses are judged against them, and a channel standard emerges and feeds the *next*
// package. Acceptance 33-40 cover the branches this file does not.
//
// Everything here runs on the real clock, which constrains the shape of the scenario in two ways worth
// spelling out, because both look like arbitrary choices otherwise:
//
//  * Planning is once per channel per UTC day (`planRequestsRun`'s `planning <channel_id> <YYYY-MM-DD>`
//    content title): the *first* planning run has to produce every request this test consumes, so the channel
//    is configured for `lookahead_slots 3` / `topics_per_run 3` / `max_open_requests 3` -> exactly 3 requests,
//    and the fourth episode's item is hand-written into the kho instead of planned.
//  * A channel standard needs >= 2 supported hypotheses in one group whose mean metric beats the *channel
//    median* (`learnChannelStandard`). With only two published episodes the median of two samples IS their
//    mean, so a two-episode channel can never clear `lift > 1` no matter how good the numbers are -- hence a
//    third, deliberately weak episode (a different angle, refuted) to give the median something below the
//    winning pair.

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

/** Every run of `workflowId` in the channel project, oldest first. */
function runsOf(project: string, workflowId: string): Run[] {
  return withStore(project, (store) => store.listRuns({}).filter((r) => r.workflow_release.id === workflowId));
}

/** First file named `name` anywhere under `root`. Finds an *input* file inside a stage attempt's workspace:
 * `materializeInputs` writes each input to `input/<artifact_id>/<basename>`, and the artifact id is only
 * knowable after the fact. */
function findFile(root: string, name: string): string | undefined {
  if (!existsSync(root)) return undefined;
  for (const rel of readdirSync(root, { recursive: true }) as string[]) {
    const p = join(root, rel);
    if (rel.split(/[\\/]/).pop() === name && statSync(p).isFile()) return p;
  }
  return undefined;
}

/** The `channel-brief.json` the `package` agent stage of `runId` actually read, out of that attempt's own
 * workspace -- proof the brief reached the agent, not merely that the `channel-brief` stage produced one. */
function briefSeenByPackage(world: PublishWorld, runId: string): ChannelBrief {
  const stage = status(world.channel, runId).stages.find((s) => s.stage_key === "package");
  expect(stage, `run ${runId} has no package stage`).toBeDefined();
  const workspaceUri = stage!.attempts.at(-1)?.workspace_uri;
  expect(workspaceUri, `package stage of ${runId} has no attempt workspace`).toBeDefined();
  const path = findFile(fileURLToPath(workspaceUri!), "channel-brief.json");
  expect(path, `no channel-brief.json in the package workspace of ${runId}`).toBeDefined();
  return readJson<ChannelBrief>(path!);
}

/** Approved items in the kho, read straight off the shared filesystem (no `library sync` in the way). */
function approvedItems(world: PublishWorld): LibraryItem[] {
  const itemsDir = join(world.lib, "items");
  if (!existsSync(itemsDir)) return [];
  return readdirSync(itemsDir)
    .map((id) => join(itemsDir, id, "manifest.json"))
    .filter((p) => existsSync(p))
    .map((p) => readJson<LibraryItem>(p))
    .filter((i) => i.status === "approved");
}

function channelJobs(world: PublishWorld): PublicationJob[] {
  return jobs(world, "channel-one");
}

function snapshotCount(world: PublishWorld, jobId: string): number {
  return withStore(world.channel, (store) => store.listVideoMetrics({ publication_job_id: jobId }).length);
}

function learned(world: PublishWorld): ChannelLearned {
  const r = cli(world.channel, ["channel", "learned", "channel-one", "--json"], world.secretsEnv);
  expect(r.code, r.err).toBe(0);
  return JSON.parse(r.out) as ChannelLearned;
}

interface Episode { job: PublicationJob; runId: string }

describe.skipIf(!hasFfmpeg())("channel learning loop: planning -> studio -> auto-pick -> publish -> stats -> standard", () => {
  it("closes the loop with no human command on either machine beyond `worker --once`", () => {
    const world = freshPublishWorld({ uploadMode: "ok", scheduleMode: "ok", learning: true });
    const studioExtra = { FAKE_REVIEW_MODE: "approve" };
    const lookup: Record<string, unknown> = {};

    /** Drives one episode from "an approved item is waiting in the kho" to SCHEDULED, entirely through the
     * channel worker's own auto-pick + channel-publish sweeps. */
    const publishNextEpisode = (o: { angle?: string; publishedJobs: number }): Episode => {
      const env: Record<string, string> = o.angle === undefined ? {} : { FAKE_ANGLE: o.angle };
      channelWorkerUntil(world, () => channelJobs(world).some((j) => j.state === "SCHEDULED"), 40, env);
      const job = channelJobs(world).find((j) => j.state === "SCHEDULED");
      expect(job, JSON.stringify(channelJobs(world))).toBeDefined();
      expect(channelJobs(world).filter((j) => j.state === "PUBLISHED")).toHaveLength(o.publishedJobs);
      const runId = runsOf(world.channel, "channel-publish").at(-1)!.run_id;
      const st = status(world.channel, runId);
      for (const s of st.stages) expect(s.state, `${s.stage_key}: ${JSON.stringify(s.attempts.at(-1))}`).toBe("SUCCEEDED");
      return { job: job!, runId };
    };

    /** Ages the episode past the channel's 72h learning horizon, tells the fake publisher it went public at
     * that same moment and the fake Studio what its numbers are, then lets the worker's verify + collect
     * sweeps settle it PUBLISHED and record one `video_metrics` snapshot. */
    const collectEpisode = (ep: Episode, outcome: { views: number; impressions: number; ctr_pct: number; avg_view_sec: number }): void => {
      const videoId = ep.job.youtube_video_id!;
      expect(videoId, JSON.stringify(ep.job)).toBeTruthy();
      statsFile(world, { [videoId]: { kind: "ok", ...outcome } });
      const publishedAt = backdatePublished(world, ep.job.publication_job_id, 80);
      lookup[videoId] = { found: true, video_id: videoId, visibility: "public", publish_at: publishedAt };
      writeLookup(world, lookup);

      channelWorkerUntil(world, () => snapshotCount(world, ep.job.publication_job_id) > 0, 10);
      const after = channelJobs(world).find((j) => j.publication_job_id === ep.job.publication_job_id)!;
      expect(after.state).toBe("PUBLISHED");
      expect(snapshotCount(world, ep.job.publication_job_id)).toBeGreaterThan(0);
    };

    // one-time studio setup (see the file header)
    const ingested = cli(world.studio, ["source", "ingest", world.sample, "--rights", "cleared", "--json"]);
    expect(ingested.code, ingested.err).toBe(0);

    // ---- (1) an empty channel plans its own topics: channel-planning@1.0.0 -> requests in the kho ----
    channelWorkerUntil(world, () => channelRequests(world).length > 0, 20);

    const requests = channelRequests(world);
    expect(requests, JSON.stringify(requests)).toHaveLength(3); // topics_per_run 3 / max_open_requests 3
    for (const r of requests) {
      expect(r.requested_by.channel_id).toBe("channel-one");
      expect(r.notes, JSON.stringify(r)).toContain("auto-plan");
      expect(r.status).toBe("open");
    }
    const planningRuns = runsOf(world.channel, "channel-planning");
    expect(planningRuns).toHaveLength(1);
    const planningStatus = status(world.channel, planningRuns[0]!.run_id);
    expect(planningStatus.run.state, JSON.stringify(planningStatus.stages)).toBe("SUCCEEDED");
    for (const s of planningStatus.stages) expect(s.state, s.stage_key).toBe("SUCCEEDED");

    // ---- (2) the studio autopilot picks the first request up on its own and builds it ----
    studioWorkerUntil(world, () => approvedItems(world).length >= 1, 250, studioExtra);
    expect(approvedItems(world).length, "studio built no approved item for the first planned request").toBeGreaterThanOrEqual(1);

    // ---- (3) the channel auto-picks that item and publishes it through channel-publish@1.1.0 ----
    const ep1 = publishNextEpisode({ angle: "chợ nổi", publishedJobs: 0 });
    expect(runsOf(world.channel, "channel-publish").at(-1)!.workflow_release.version).toBe("1.1.0");

    const brief1 = briefSeenByPackage(world, ep1.runId);
    expect(brief1.channel.channel_id).toBe("channel-one");
    expect(brief1.channel.seo.niche).toBe("du lịch miền Tây"); // straight from channels/channel-one/channel.yaml
    expect(brief1.learned, "an as-yet-unlearned channel must brief the agent with learned: null").toBeNull();
    expect(brief1.item?.item_id).toBe(packageFor(world.channel, ep1.job.publication_job_id).library_item_id);

    // ---- (4) stats: 80h old, public, 1200 views -> the hypothesis (target 1000 from the fake agent) holds ----
    collectEpisode(ep1, { views: 1200, impressions: 5000, ctr_pct: 6, avg_view_sec: 3 });

    const hyp1 = packageFor(world.channel, ep1.job.publication_job_id).hypothesis;
    expect(hyp1.expected.metric).toBe("views_72h");
    expect(hyp1.expected.target).toBe(1000); // no medians yet -> the fake agent's own fallback target
    expect(hyp1.status, JSON.stringify(hyp1)).toBe("supported");
    expect(hyp1.evaluated?.metric_value).toBe(1200);
    expect(learned(world).medians.views_72h).toBe(1200);

    // ---- repeat (2)-(4) for a second episode on the same angle, then a weaker third on another angle ----
    studioWorkerUntil(world, () => approvedItems(world).length >= 2, 250, studioExtra);
    expect(approvedItems(world).length).toBeGreaterThanOrEqual(2);
    const ep2 = publishNextEpisode({ angle: "chợ nổi", publishedJobs: 1 });
    const hyp2Target = packageFor(world.channel, ep2.job.publication_job_id).hypothesis.expected.target;
    expect(hyp2Target).toBeCloseTo(1320, 6); // medians.views_72h (1200) x 1.1, straight out of channel-brief.json
    collectEpisode(ep2, { views: 3000, impressions: 9000, ctr_pct: 7, avg_view_sec: 4 });
    expect(packageFor(world.channel, ep2.job.publication_job_id).hypothesis.status).toBe("supported");

    studioWorkerUntil(world, () => approvedItems(world).length >= 3, 250, studioExtra);
    expect(approvedItems(world).length).toBeGreaterThanOrEqual(3);
    const ep3 = publishNextEpisode({ angle: "flycam", publishedJobs: 2 });
    collectEpisode(ep3, { views: 600, impressions: 2000, ctr_pct: 2, avg_view_sec: 1 });
    expect(packageFor(world.channel, ep3.job.publication_job_id).hypothesis.status).toBe("refuted");

    // two supported "chợ nổi" hypotheses (1200, 3000) against a channel median of 1200 -> lift 1.75
    const standard = learned(world);
    expect(standard.sample_size).toBe(3);
    expect(standard.medians.views_72h).toBe(1200);
    expect(standard.standard.angle, JSON.stringify(standard.winners.angles)).toBe("chợ nổi");
    expect(standard.history.at(-1)!.standard.angle).toBe("chợ nổi");
    const learnedEvents = withStore(world.channel, (store) => store.listEvents({ event_type: "channel.learned_updated", newest: true }));
    expect(learnedEvents.length).toBeGreaterThan(0);

    // ---- (5) the next package follows the standard: channel-brief carries it, the draft cites it ----
    // The item is hand-written rather than planned because a channel only plans once per UTC day (file
    // header) -- everything downstream of "an approved item is sitting in the kho" is the real loop again.
    const extraItemId = newId("library_item");
    writeLibraryItem(world.lib, {
      itemId: extraItemId, styleId: world.styleId, status: "approved", titleHint: "Chợ nổi Cái Răng lúc rạng sáng",
      extraFiles: [{ path: "thumb-01.png", body: "fake png bytes for thumb 1", mime_type: "image/png" }],
    });
    librarySync(world.channel);

    const ep4 = publishNextEpisode({ publishedJobs: 3 }); // no FAKE_ANGLE: the agent follows the learned standard
    const brief4 = briefSeenByPackage(world, ep4.runId);
    expect(brief4.learned, "the fourth package must be briefed with the learned standard").not.toBeNull();
    expect(brief4.learned!.standard.angle).toBe("chợ nổi");
    expect(brief4.hypotheses.length).toBeGreaterThanOrEqual(3);
    expect(brief4.recent_metrics.length).toBeGreaterThanOrEqual(3);

    const hyp4 = packageFor(world.channel, ep4.job.publication_job_id).hypothesis;
    expect(hyp4.chosen.angle).toBe("chợ nổi");
    expect(hyp4.basis.map((b) => b.kind)).toContain("channel");
  }, 900_000);
});
