import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newId, type ContentRequest, type EditStyle, type LibraryItem } from "@harness/contracts";
import { sha256File, SqliteStateStore } from "@harness/core";
import { hasFfmpeg } from "../media.js";
import { cli, drain, freshLibraryWorld, librarySync, SAMPLE_EDL, SAMPLE_STYLE, status, submitGate, writeActiveStyle, type LibraryWorld } from "./library-helpers.js";

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const requestFile = (lib: string, requestId: string): ContentRequest => readJson(join(lib, "requests", `${requestId}.json`));
const manifest = (lib: string, itemId: string): LibraryItem => readJson(join(lib, "items", itemId, "manifest.json"));

function stageState(project: string, runId: string, key: string): string | undefined {
  return status(project, runId).stages.find((s) => s.stage_key === key)?.state;
}

function plan(project: string, workflow: string, contentId: string, options: string[] = []): { runId: string; skipped: string[] } {
  const args = ["plan", "--workflow", workflow, "--profile", "studio", "--content", contentId, ...options.flatMap((o) => ["--option", o]), "--json"];
  const planned = cli(project, args);
  expect(planned.code, planned.err).toBe(0);
  const { run_id, skipped_stages } = JSON.parse(planned.out) as { run_id: string; skipped_stages: string[] };
  expect(cli(project, ["enqueue", run_id]).code).toBe(0);
  return { runId: run_id, skipped: skipped_stages };
}

/** channel `request create` -> studio `sync` -> `library accept` -> `plan library-production`, i.e. everything
 * scenarios 2 and 3 share before the production gates. */
function acceptedProductionRun(world: LibraryWorld, styleId: string): { requestId: string; sourceId: string; contentId: string; runId: string } {
  const created = cli(world.channel, [
    "library", "request", "create", "--portfolio", "portfolio-channel", "--channel", "channel-one",
    "--topic", "chợ nổi Cái Răng", "--style", styleId, "--voice", "none", "--duration", "1,60", "--json",
  ]);
  expect(created.code, created.err).toBe(0);
  const request = JSON.parse(created.out) as ContentRequest;
  expect(request.status).toBe("open");

  const synced = librarySync(world.studio);
  expect(synced.imported.requests).toContain(request.request_id);
  // the style is visible to the studio either way: freshly imported here, or already in its mirror because
  // this very project's `style-export` put it in the kho (scenario 2 chains onto scenario 1's style)
  const styleShown = cli(world.studio, ["library", "styles", "show", styleId, "--json"]);
  expect(styleShown.code, styleShown.err).toBe(0);

  const ingested = cli(world.studio, ["source", "ingest", world.sample, "--rights", "cleared", "--json"]);
  expect(ingested.code, ingested.err).toBe(0);
  const sourceId = (JSON.parse(ingested.out) as { source_id: string }).source_id;

  const accepted = cli(world.studio, ["library", "accept", "--request", request.request_id, "--source", sourceId, "--json"]);
  expect(accepted.code, accepted.err).toBe(0);
  const contentId = (JSON.parse(accepted.out) as { content_id: string }).content_id;
  // accept is a local planning step only: the request is still open in the kho until `intake` claims it
  expect(requestFile(world.lib, request.request_id).status).toBe("open");

  const { runId, skipped } = plan(world.studio, "library-production@1.0.0", contentId, ["voice=none"]);
  expect(skipped).toContain("tts");
  return { requestId: request.request_id, sourceId, contentId, runId };
}

/** Drives a planned library-production run from `enqueue` to the parked `library-review` gate, submitting the
 * two production gates on the way. Returns the `item_id` `library-export` wrote into the kho. */
function produceUntilReview(world: LibraryWorld, runId: string, sourceId: string, styleId: string): string {
  drain(world.studio);
  expect(stageState(world.studio, runId, "intake")).toBe("SUCCEEDED");
  expect(stageState(world.studio, runId, "index-source")).toBe("SUCCEEDED");
  expect(stageState(world.studio, runId, "survey-source")).toBe("WAITING_HUMAN");

  submitGate(world.studio, runId, "survey-source", { "survey.md": "# Khảo sát\n\n- shot 0-2.5s: hợp mở bài\n- shot 2.5-5s: dùng cho thân bài\n" });
  drain(world.studio);
  expect(stageState(world.studio, runId, "plan-edit")).toBe("WAITING_HUMAN");

  submitGate(world.studio, runId, "plan-edit", {
    "edl.json": SAMPLE_EDL(sourceId),
    "edit-plan.json": JSON.stringify({ style_id: styleId, notes: "cắt nhanh, chữ đậm ở mở bài" }, null, 2),
    "narration.txt": "Không lồng tiếng cho tập này.\n",
  });
  drain(world.studio);

  expect(stageState(world.studio, runId, "cut")).toBe("SUCCEEDED");
  expect(stageState(world.studio, runId, "assemble")).toBe("SUCCEEDED");
  expect(stageState(world.studio, runId, "thumbnail-candidates")).toBe("SUCCEEDED");
  expect(stageState(world.studio, runId, "library-export")).toBe("SUCCEEDED");
  expect(stageState(world.studio, runId, "library-review")).toBe("WAITING_HUMAN");

  const items = JSON.parse(cli(world.studio, ["library", "list", "items", "--json"]).out) as LibraryItem[];
  const item = items.find((i) => i.lineage.run_id === runId);
  expect(item, `no library item for run ${runId}`).toBeDefined();
  expect(item!.status).toBe("pending_review");
  return item!.item_id;
}

describe.skipIf(!hasFfmpeg())("the content library across a studio and a channel ops project", () => {
  /** Scenario 1 leaves a real, `style-export`ed style in a real kho; scenario 2 requests *that* style instead
   * of a hand-written one, so DoD bullet 2 ("a style the studio learned is what a channel can request and a
   * production run consumes") is proven end-to-end rather than in two halves. Scenario 2 fails loudly if
   * scenario 1 did not get that far. */
  let learned: { world: LibraryWorld; styleId: string } | undefined;

  it("style-study: collected samples, two gates and style-export put an active style in the kho the channel can see", async () => {
    const world = freshLibraryWorld();

    const ingested = cli(world.studio, ["source", "ingest", world.samplesTxt, "--rights", "cleared", "--json"]);
    expect(ingested.code, ingested.err).toBe(0);
    const sourceId = (JSON.parse(ingested.out) as { source_id: string }).source_id;

    const created = cli(world.studio, ["content", "create", "--title", "Học style chợ nổi", "--source", sourceId, "--json"]);
    expect(created.code, created.err).toBe(0);
    const contentId = (JSON.parse(created.out) as { content_id: string }).content_id;

    const { runId } = plan(world.studio, "style-study@1.0.0", contentId);
    drain(world.studio);

    expect(stageState(world.studio, runId, "collect-samples")).toBe("SUCCEEDED");
    expect(stageState(world.studio, runId, "analyze-style")).toBe("WAITING_HUMAN");

    const styleId = newId("edit_style");
    submitGate(world.studio, runId, "analyze-style", {
      "style.json": SAMPLE_STYLE(styleId, "draft"),
      "evidence/note.md": "# Vì sao\n\nNhịp cắt nhanh ở 10 giây đầu, chữ đậm, nhạc dồn.\n",
    });
    drain(world.studio);
    expect(stageState(world.studio, runId, "style-review")).toBe("WAITING_HUMAN");

    submitGate(world.studio, runId, "style-review", { "style.json": SAMPLE_STYLE(styleId, "active") });
    drain(world.studio);

    const final = status(world.studio, runId);
    expect(final.run.state).toBe("SUCCEEDED");
    for (const s of final.stages) expect(s.state, s.stage_key).toBe("SUCCEEDED");
    expect(final.artifacts.some((a) => a.type === "sample_set" && a.status === "ACCEPTED")).toBe(true);
    expect(final.artifacts.some((a) => a.type === "export_receipt" && a.status === "ACCEPTED")).toBe(true);

    // the kho holds the *reviewed* style, not the draft the analyze-style gate produced, plus its evidence
    const styleFile = join(world.lib, "styles", styleId, "style.json");
    const style = readJson<EditStyle>(styleFile);
    expect(style.status).toBe("active");
    expect(style.style_id).toBe(styleId);
    expect(style.evidence.map((e) => e.path)).toEqual(["evidence/note.md"]);
    expect(existsSync(join(world.lib, "styles", styleId, "evidence", "note.md"))).toBe(true);

    // the samples themselves: three frames for the one listed video, plus the index the wrapper wrote
    const sampleSet = final.artifacts.find((a) => a.type === "sample_set") as unknown as { uri: string };
    const sampleDir = fileURLToPath(sampleSet.uri);
    expect(readdirSync(sampleDir).sort()).toEqual(["0-end.png", "0-mid.png", "0-start.png", "samples.json"]);
    const samples = readJson<{ index: number; path: string; frames: string[] }[]>(join(sampleDir, "samples.json"));
    expect(samples).toHaveLength(1);
    expect(samples[0]!.frames).toHaveLength(3);

    // a channel on the same kho sees the style after one sync
    const channelSync = librarySync(world.channel);
    expect(channelSync.imported.styles).toContain(styleId);
    const listed = cli(world.channel, ["library", "list", "styles", "--json"]);
    expect(listed.code, listed.err).toBe(0);
    expect((JSON.parse(listed.out) as EditStyle[]).map((s) => s.style_id)).toContain(styleId);
    const shown = cli(world.channel, ["library", "styles", "show", styleId, "--json"]);
    expect(shown.code, shown.err).toBe(0);
    expect((JSON.parse(shown.out) as EditStyle).status).toBe("active");

    learned = { world, styleId };
  }, 300_000);

  it("request -> production -> approved review -> channel pick, with the unapproved pick refused", async () => {
    expect(learned, "scenario 1 (style-study) must run first: scenario 2 requests the style it exported").toBeDefined();
    const { world, styleId } = learned!;

    const { requestId, sourceId, runId } = acceptedProductionRun(world, styleId);
    const itemId = produceUntilReview(world, runId, sourceId, styleId);

    // intake claimed the request for this run and only this run
    const claimed = requestFile(world.lib, requestId);
    expect(claimed.status).toBe("claimed");
    expect(claimed.claimed_by_run).toEqual({ project_id: "project-studio", run_id: runId });

    // the episode and its thumbnails are in the kho, still pending_review
    expect(manifest(world.lib, itemId).status).toBe("pending_review");
    expect(existsSync(join(world.lib, "items", itemId, "episode.mp4"))).toBe(true);
    expect(manifest(world.lib, itemId).files.map((f) => f.path)).toEqual(expect.arrayContaining(["episode.mp4", "thumbnail-01.png", "edit-plan.json"]));

    // a channel may not pick anything that has not been approved
    expect(librarySync(world.channel).imported.items).toContain(itemId);
    const early = cli(world.channel, ["library", "pick", itemId, "--channel", "channel-one"]);
    expect(early.code).toBe(1);
    expect(early.err).toContain("INVALID_TRANSITION");
    expect(existsSync(join(world.lib, "items", itemId, "claims", "channel-one.json"))).toBe(false);

    submitGate(world.studio, runId, "library-review", { "review.json": JSON.stringify({ decision: "approved", note: "đạt yêu cầu" }, null, 2) });
    drain(world.studio);

    const final = status(world.studio, runId);
    expect(final.run.state).toBe("SUCCEEDED");
    for (const s of final.stages) expect(s.state, s.stage_key).toBe("SUCCEEDED");
    const exportStageRunId = final.stages.find((s) => s.stage_key === "library-export")!.stage_run_id;
    const receipt = final.artifacts.find((a) => a.type === "export_receipt" && a.stage_run_id === exportStageRunId);
    expect(receipt?.status).toBe("ACCEPTED");

    const approved = manifest(world.lib, itemId);
    expect(approved.status).toBe("approved");
    expect(approved.review.note).toBe("đạt yêu cầu");
    const fulfilled = requestFile(world.lib, requestId);
    expect(fulfilled.status).toBe("fulfilled");
    expect(fulfilled.item_ids).toEqual([itemId]);

    // channel: sync, then pick the approved item into a local ContentItem
    expect(librarySync(world.channel).updated.items).toContain(itemId);
    const picked = cli(world.channel, ["library", "pick", itemId, "--channel", "channel-one", "--json"]);
    expect(picked.code, picked.err).toBe(0);
    const pickedContentId = (JSON.parse(picked.out) as { content_id: string }).content_id;
    expect(pickedContentId).toMatch(/^content_/);
    expect(existsSync(join(world.lib, "items", itemId, "claims", "channel-one.json"))).toBe(true);

    const store = new SqliteStateStore(join(world.channel, "data", "state", "harness.db"));
    try {
      const content = store.getContentItem(pickedContentId)!;
      expect(content.library_item_id).toBe(itemId);
      expect(content.source_ids).toEqual([]);
    } finally {
      store.close();
    }

    // the bytes a channel would publish are exactly the ones the manifest vouches for
    const episodeEntry = approved.files.find((f) => f.path === "episode.mp4")!;
    const onDisk = await sha256File(join(world.lib, "items", itemId, "episode.mp4"));
    expect(onDisk.checksum).toBe(episodeEntry.checksum);
    expect(onDisk.size_bytes).toBe(episodeEntry.size_bytes);
  }, 300_000);

  it("a rejected review reopens the request with the note, and the studio accepts it again on a fresh run", async () => {
    const world = freshLibraryWorld();
    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);

    const { requestId, sourceId, contentId, runId } = acceptedProductionRun(world, styleId);
    const itemId = produceUntilReview(world, runId, sourceId, styleId);

    const note = "nhịp cắt chưa đúng style, làm lại phần mở bài";
    submitGate(world.studio, runId, "library-review", { "review.json": JSON.stringify({ decision: "rejected", note }, null, 2) });
    drain(world.studio);

    // the run itself still succeeds: rejecting is a normal outcome of the review stage, not a failure
    const final = status(world.studio, runId);
    expect(final.run.state).toBe("SUCCEEDED");
    expect(stageState(world.studio, runId, "library-apply-review")).toBe("SUCCEEDED");

    expect(manifest(world.lib, itemId).status).toBe("rejected");
    expect(manifest(world.lib, itemId).review.note).toBe(note);

    const reopened = requestFile(world.lib, requestId);
    expect(reopened.status).toBe("open");
    expect(reopened.notes).toContain(note);
    expect(reopened.claimed_by_run).toBeUndefined();
    expect(reopened.item_ids).toEqual([]);

    // `retry --stage plan-edit` cannot redo the edit on this run: retry only moves FAILED or WAITING_HUMAN
    // stages back to READY, and every stage of a rejected run is SUCCEEDED. The reopened request is what
    // carries the work forward -- spec §6's other option, "plan run mới".
    const retried = cli(world.studio, ["retry", runId, "--stage", "plan-edit"]);
    expect(retried.code, retried.err).toBe(0);
    expect(retried.out).toContain("nothing to retry");

    // the reopened request can be accepted again, producing a second content and a second run
    librarySync(world.studio);
    const accepted = cli(world.studio, ["library", "accept", "--request", requestId, "--source", sourceId, "--json"]);
    expect(accepted.code, accepted.err).toBe(0);
    const secondContentId = (JSON.parse(accepted.out) as { content_id: string }).content_id;
    expect(secondContentId).not.toBe(contentId);

    const { runId: secondRunId } = plan(world.studio, "library-production@1.0.0", secondContentId, ["voice=none"]);
    drain(world.studio);

    expect(stageState(world.studio, secondRunId, "intake")).toBe("SUCCEEDED");
    expect(stageState(world.studio, secondRunId, "plan-edit")).toBe("PENDING");
    expect(stageState(world.studio, secondRunId, "survey-source")).toBe("WAITING_HUMAN");
    const reclaimed = requestFile(world.lib, requestId);
    expect(reclaimed.status).toBe("claimed");
    expect(reclaimed.claimed_by_run).toEqual({ project_id: "project-studio", run_id: secondRunId });
  }, 300_000);
});
