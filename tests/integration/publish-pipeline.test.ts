import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasFfmpeg } from "../media.js";
import {
  backdateScheduled, cli, drain, freshPublishWorld, jobs, packageFor, pickAndPlan, readQueue, setVerifyGraceHours, status,
} from "./publish-helpers.js";

// Task 11 step 1: the full channel-publish pipeline end to end across two channels sharing one kho item --
// real fetch-library-item/build-package/upload/schedule stages, a real `package` agent stage driven by
// fixtures/fake-agent-cli.mjs, and PlaywrightPublisher against the legacy-channel-repo fixture scripts.
//
// `fetch-library-item`'s `media-probe` required check needs a decodable video file (a fake-text episode.mp4
// fails it outright when ffprobe is on PATH -- see `writeLibraryItem`'s own doc comment), so this whole file
// mirrors `tests/integration/library-pipeline.test.ts` (sub-project 2C) and skips without ffmpeg/ffprobe.
describe.skipIf(!hasFfmpeg())("channel-publish pipeline across two channels sharing one kho item", () => {
  it("channel-one: fetch -> package -> build-package -> upload -> schedule, all real", () => {
    const world = freshPublishWorld({ uploadMode: "ok", scheduleMode: "ok" });
    const { runId } = pickAndPlan(world, "channel-one");

    const results = drain(world.channel, world.secretsEnv);
    expect(results.at(-1), JSON.stringify(results)).toContain("idle");

    const st = status(world.channel, runId);
    for (const stage of st.stages) expect(stage.state, `${stage.stage_key}: ${JSON.stringify(stage)}`).toBe("SUCCEEDED");

    const allJobs = jobs(world, "channel-one");
    expect(allJobs).toHaveLength(1);
    const job = allJobs[0]!;
    expect(job.state).toBe("SCHEDULED");
    expect(job.scheduled_at).toBeTruthy();
    // channel-one's publish_times is ["20:00"] in Asia/Bangkok (UTC+7) -> always 13:00 UTC, whichever day.
    expect(job.scheduled_at).toMatch(/T13:00:00\.000Z$/);

    const repo = world.repos["channel-one"]!;
    const episodeDir = join(repo, "outputs", "project-01", "episodes", "episode-15");
    expect(existsSync(join(episodeDir, "full-episode", "episode-15-full-episode.mp4"))).toBe(true);
    expect(existsSync(join(episodeDir, "thumbnails", "opt1.png"))).toBe(true);

    const manifestPath = join(episodeDir, "publish", "episode-15-upload-manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { visibility: string; title: string };
    expect(manifest.visibility).toBe("private");
    expect(manifest.title.length).toBeGreaterThan(0);

    const queue = readQueue(repo);
    expect(queue).toHaveLength(1);

    const scheduleFile = join(repo, "outputs", "project-01", "schedules", `${queue[0]!.videoId}.json`);
    expect(existsSync(scheduleFile)).toBe(true);
    const onDisk = JSON.parse(readFileSync(scheduleFile, "utf8")) as { at: string };
    expect(onDisk.at).toBe(job.scheduled_at);

    const pkg = packageFor(world.channel, job.publication_job_id);
    expect(pkg.hypothesis.basis.length).toBeGreaterThanOrEqual(1);
    expect(manifest.title).toBe(pkg.metadata.title);

    const publicationManifest = join(world.channel, "data", "publications", "channel-one", job.publication_job_id, "package-manifest.json");
    expect(existsSync(publicationManifest)).toBe(true);

    const snap = cli(world.channel, ["dashboard", "snapshot", "--json"], world.secretsEnv);
    expect(snap.code, snap.err).toBe(0);
    const snapshot = JSON.parse(snap.out) as { channels: { channel_id: string; episodes_count: number }[] };
    const chOne = snapshot.channels.find((c) => c.channel_id === "channel-one");
    expect(chOne?.episodes_count).toBe(1);

    // Step 1.2: the same kho item, picked again for channel-two -- a second, independent job.
    const { runId: runId2 } = pickAndPlan(world, "channel-two");
    const results2 = drain(world.channel, world.secretsEnv);
    expect(results2.at(-1), JSON.stringify(results2)).toContain("idle");

    const st2 = status(world.channel, runId2);
    for (const stage of st2.stages) expect(stage.state, `${stage.stage_key}: ${JSON.stringify(stage)}`).toBe("SUCCEEDED");

    const allJobsTwo = jobs(world, "channel-two");
    expect(allJobsTwo).toHaveLength(1);
    const job2 = allJobsTwo[0]!;
    expect(job2.state).toBe("SCHEDULED");
    expect(job2.idempotency_key).not.toBe(job.idempotency_key);

    const pkg2 = packageFor(world.channel, job2.publication_job_id);
    expect(pkg2.episode_no).toBe(3); // channel-two's episode.start

    const everyJob = jobs(world);
    expect(everyJob).toHaveLength(2);

    // Step 1.3: verify sweep settles both SCHEDULED jobs to PUBLISHED. Both were just booked at a genuine
    // *future* `nextSlot()`, so backdate them a few minutes into the past (still "today" in either channel's
    // timezone) and zero out the grace window so `publish verify` treats them as due right now.
    setVerifyGraceHours(world.channel, 0);
    const almostNow = new Date(Date.now() - 5 * 60_000).toISOString();
    backdateScheduled(world.channel, job.publication_job_id, almostNow);
    backdateScheduled(world.channel, job2.publication_job_id, almostNow);

    const lookupFile = world.secretsEnv.HARNESS_PUBLISHER_LOOKUP_FILE!;
    const videoIdOne = readQueue(world.repos["channel-one"]!)[0]!.videoId;
    const videoIdTwo = readQueue(world.repos["channel-two"]!)[0]!.videoId;
    writeFileSync(lookupFile, JSON.stringify({
      [videoIdOne]: { found: true, video_id: videoIdOne, visibility: "public" },
      [videoIdTwo]: { found: true, video_id: videoIdTwo, visibility: "public" },
    }));

    const verify = cli(world.channel, ["publish", "verify", "--json"], world.secretsEnv);
    expect(verify.code, verify.err).toBe(0);
    const report = JSON.parse(verify.out) as { published: string[]; errors: unknown[] };
    expect(report.published.sort()).toEqual([job.publication_job_id, job2.publication_job_id].sort());
    expect(report.errors).toEqual([]);

    const jobsAfter = jobs(world);
    expect(jobsAfter.every((j) => j.state === "PUBLISHED")).toBe(true);

    const snap2 = cli(world.channel, ["dashboard", "snapshot", "--json"], world.secretsEnv);
    const snapshot2 = JSON.parse(snap2.out) as { channels: { channel_id: string; today: { published: number } }[] };
    const chOneAfter = snapshot2.channels.find((c) => c.channel_id === "channel-one");
    const chTwoAfter = snapshot2.channels.find((c) => c.channel_id === "channel-two");
    expect(chOneAfter?.today.published).toBeGreaterThanOrEqual(1);
    expect(chTwoAfter?.today.published).toBeGreaterThanOrEqual(1);
  }, 300_000);
});
