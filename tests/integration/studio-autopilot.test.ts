// Task 8 (sub-project 4): the studio autopilot end to end, on a single shared kho, with a fake agent CLI
// standing in for `claude -p ...` and no human command at the studio beyond `worker --once` (plus the one-
// time setup every scenario needs: ingesting the raw footage/samples, and style-study's own plan/enqueue --
// style-study has no request to auto-accept, so it cannot start any other way). Acceptance 27-32 (a separate
// file each) exercise the branches this file does not: reject-once replanning, the replan-budget exhaustion
// alert, a parked agent stage, watch frame/transcript detail, secret hygiene, and the old 1.0.0 release.
import { describe, expect, it } from "vitest";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EditStyle, LibraryItem } from "@harness/contracts";
import { SqliteStateStore } from "@harness/core";
import { hasFfmpeg } from "../media.js";
import { cli, drain, freshLibraryWorld, librarySync, requestCreate, requestStatus, stageId, status, studioEnv, studioWorkerUntil } from "./library-helpers.js";

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

function stageState(project: string, runId: string, key: string): string | undefined {
  return status(project, runId).stages.find((s) => s.stage_key === key)?.state;
}

/** Every artifact this run produced for `stageKey`, as `{ uri, type }` -- enough to read the file/directory
 * straight off disk the same way `library-pipeline.test.ts` does (`fileURLToPath` on the artifact's `uri`;
 * `status --json`'s artifacts carry it even though `StatusJson` does not declare the field). */
function artifactFor(project: string, runId: string, stageKey: string, type: string): { uri: string } {
  const sid = stageId(project, runId, stageKey);
  const found = status(project, runId).artifacts.find((a) => a.stage_run_id === sid && a.type === type) as unknown as { uri: string } | undefined;
  expect(found, `no ${type} artifact for stage ${stageKey} on run ${runId}`).toBeDefined();
  return found!;
}

interface WatchIndexLike { videos: { label: string; frames: { t: number; kind: string }[] }[] }

describe.skipIf(!hasFfmpeg())("studio autopilot: style-study@1.1.0 and library-production@1.1.0 with no human at the studio", () => {
  it("collects+learns a style end to end, then fulfills a channel request into an approved item using only worker --once at the studio", async () => {
    const world = freshLibraryWorld({ media: true, autopilot: true });
    const env = studioEnv(world);

    // ---- (1) style-study@1.1.0: a local sample plus a URL collect-samples fakes downloading (FAKE_YTDLP=1) ----
    appendFileSync(world.samplesTxt, "https://example.invalid/v1\n");
    const ingestedSamples = cli(world.studio, ["source", "ingest", world.samplesTxt, "--rights", "cleared", "--json"], env);
    expect(ingestedSamples.code, ingestedSamples.err).toBe(0);
    const samplesSourceId = (JSON.parse(ingestedSamples.out) as { source_id: string }).source_id;

    const created = cli(world.studio, ["content", "create", "--title", "Học style chợ nổi (autopilot)", "--source", samplesSourceId, "--json"], env);
    expect(created.code, created.err).toBe(0);
    const contentId = (JSON.parse(created.out) as { content_id: string }).content_id;

    const planned = cli(world.studio, ["plan", "--workflow", "style-study@1.1.0", "--profile", "studio", "--content", contentId, "--json"], env);
    expect(planned.code, planned.err).toBe(0);
    const { run_id: styleRunId } = JSON.parse(planned.out) as { run_id: string };
    expect(cli(world.studio, ["enqueue", styleRunId], env).code).toBe(0);

    drain(world.studio, env);

    const styleFinal = status(world.studio, styleRunId);
    expect(styleFinal.run.state).toBe("SUCCEEDED");
    for (const s of styleFinal.stages) expect(s.state, s.stage_key).toBe("SUCCEEDED");
    // no gate anywhere in 1.1.0's style-study: analyze-style/style-review are agent stages the fake CLI cleared
    expect(styleFinal.stages.find((s) => s.stage_key === "analyze-style")!.attempts.every((a) => a.state === "SUCCEEDED")).toBe(true);

    const styleIds = readdirSync(join(world.lib, "styles"));
    expect(styleIds).toHaveLength(1);
    const styleId = styleIds[0]!;
    const style = readJson<EditStyle>(join(world.lib, "styles", styleId, "style.json"));
    expect(style.status).toBe("active");
    expect(style.style_id).toBe(styleId);

    // watch-samples watched both videos (the local file and the faked download), each with real frames
    const watchSamplesArtifact = artifactFor(world.studio, styleRunId, "watch-samples", "watch");
    const watchSamplesIndex = readJson<WatchIndexLike>(join(fileURLToPath(watchSamplesArtifact.uri), "watch.json"));
    expect(watchSamplesIndex.videos).toHaveLength(2);
    for (const v of watchSamplesIndex.videos) expect(v.frames.length, v.label).toBeGreaterThan(0);

    // ---- (2) a channel request, fulfilled with no studio command beyond worker --once from here on ----
    expect(librarySync(world.channel).imported.styles).toContain(styleId);

    const sourceIngested = cli(world.studio, ["source", "ingest", world.sample, "--rights", "cleared", "--json"], env);
    expect(sourceIngested.code, sourceIngested.err).toBe(0);

    const requestId = requestCreate(world, { topic: "Chợ nổi buổi sáng", style: styleId, sourceHint: "main", voice: "none" });
    expect(requestStatus(world, requestId).status).toBe("open");

    studioWorkerUntil(world, () => requestStatus(world, requestId).status === "fulfilled", 250, { FAKE_REVIEW_MODE: "approve" });
    const fulfilled = requestStatus(world, requestId);
    expect(fulfilled.status, JSON.stringify(fulfilled)).toBe("fulfilled");
    expect(fulfilled.item_ids).toHaveLength(1);
    const itemId = fulfilled.item_ids[0]!;

    const manifest = readJson<LibraryItem>(join(world.lib, "items", itemId, "manifest.json"));
    expect(manifest.status).toBe("approved");
    const runId = manifest.lineage.run_id;

    const final = status(world.studio, runId);
    expect(final.run.state).toBe("SUCCEEDED");
    // 13 stages defined, minus `tts` (`when: options.voice == "tts"`, and this request's voice is "none")
    expect(final.stages).toHaveLength(12);
    for (const s of final.stages) expect(s.state, s.stage_key).toBe("SUCCEEDED");

    // watch/ of the source and the assembled episode: real frames, capped at each mode's max_frames
    const watchSource = readJson<WatchIndexLike>(join(fileURLToPath(artifactFor(world.studio, runId, "watch-source", "watch").uri), "watch.json"));
    expect(watchSource.videos).toHaveLength(1);
    expect(watchSource.videos[0]!.frames.length).toBeLessThanOrEqual(120);
    expect(watchSource.videos[0]!.frames.length).toBeGreaterThan(0);

    const watchEpisode = readJson<WatchIndexLike>(join(fileURLToPath(artifactFor(world.studio, runId, "watch-episode", "watch").uri), "watch.json"));
    expect(watchEpisode.videos).toHaveLength(1);
    expect(watchEpisode.videos[0]!.frames.length).toBeLessThanOrEqual(80);
    expect(watchEpisode.videos[0]!.frames.length).toBeGreaterThan(0);

    // request.auto_accepted fired once, replan_no 0 (this is the first and only run for this request)
    const store = new SqliteStateStore(join(world.studio, "data", "state", "harness.db"));
    try {
      const acceptedEvents = store.listEvents({ event_type: "request.auto_accepted" }).filter((e) => e.payload.request_id === requestId);
      expect(acceptedEvents).toHaveLength(1);
      expect(acceptedEvents[0]!.payload).toMatchObject({ request_id: requestId, run_id: runId, replan_no: 0 });
    } finally {
      store.close();
    }

    // a channel can now pick the approved item (first time this channel has ever synced it)
    expect(librarySync(world.channel).imported.items).toContain(itemId);
    const picked = cli(world.channel, ["library", "pick", itemId, "--channel", "channel-one", "--json"]);
    expect(picked.code, picked.err).toBe(0);
    expect((JSON.parse(picked.out) as { content_id: string }).content_id).toMatch(/^content_/);

    // ---- (3) doctor: library:auto_accept is ok on this studio project ----
    const doctorRows = JSON.parse(cli(world.studio, ["doctor", "--json"], env).out) as { check: string; ok: boolean; detail: string }[];
    const autoAcceptRow = doctorRows.find((r) => r.check === "library:auto_accept");
    expect(autoAcceptRow, JSON.stringify(doctorRows)).toBeDefined();
    expect(autoAcceptRow!.ok, autoAcceptRow!.detail).toBe(true);
  }, 600_000);
});
