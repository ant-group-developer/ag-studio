import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type Composition, type LibraryItem, type RenderReport, type Review } from "@harness/contracts";
import { SqliteStateStore } from "@harness/core";
import { hasFfmpeg, systemFontPath } from "../media.js";
import {
  addVoice, artifactPathFor, autoAcceptedRuns, freshLibraryWorld, ingestShoot, requestCreate, requestStatus,
  setBrand, status, studioWorkerUntil, writeActiveStyle,
} from "../integration/library-helpers.js";

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

const CHANNEL_ID = "channel-one";

function stageState(project: string, runId: string, key: string): string | undefined {
  return status(project, runId).stages.find((s) => s.stage_key === key)?.state;
}

/** Which required checks of a stage's last attempt did not pass. */
function failedChecks(project: string, runId: string, stageKey: string): string[] {
  const store = new SqliteStateStore(join(project, "data", "state", "harness.db"));
  try {
    const stage = store.listStageRuns(runId).find((s) => s.stage_key === stageKey);
    if (!stage) return [];
    const attempt = store.listAttempts(stage.stage_run_id).at(-1);
    if (!attempt) return [];
    return store.listCheckResults(attempt.attempt_id).filter((c) => c.verdict !== "pass").map((c) => c.check_id).sort();
  } finally {
    store.close();
  }
}

// Acceptance 48 (sub-project 5B §8): a bad overlay plan must not reach a channel -- and the studio must fix
// it by itself.
//
// The task brief expected `FAKE_OVERLAYS=dense` (an `overlays-valid` failure at `plan-edit`) to drive the
// SP4 replan loop the way an `edl-valid` failure does. It does not, and the first test here pins exactly
// why: BOTH of them fail the STAGE, which fails the RUN, and a FAILED run is not something anything reopens.
// `intake` is the only place a request moves `open -> claimed`, and `library-apply-review` is the only place
// anything moves it back; a run that dies at `plan-edit` never reaches `library-apply-review`, so the request
// sits at `claimed` forever and `autoAccept` (which only ever looks at `open` requests) never sees it again.
// That is a pre-existing property of sub-project 4's loop, identical for `edl-valid`, not something 5B
// introduced -- `packages/cli/test/composition-stages.test.ts` already proved the two checks land the run in
// the same state, and `tests/integration/studio-media.test.ts` documents the same dead end for 5A.
//
// So the replanned half of the acceptance runs down the route the brief names as the fallback: a plan that
// PASSES `overlays-valid` and only falls apart at `media-compose` (`FAKE_OVERLAYS=unresolvable`, a
// `speech_index` anchor the checker deliberately cannot resolve pre-fit), which lands in
// `render-report.text_events.dropped`, which `library-review` rejects on -- and that rejection note carries
// "chữ" into the replanned brief, where the fake `edit-plan` falls back to a safe `medium` plan.
describe.skipIf(!hasFfmpeg())("acceptance 48: an overlay plan that is too dense fails the stage and does not replan", () => {
  it("FAKE_OVERLAYS=dense fails plan-edit on overlays-valid, and leaves the request claimed with no second run", () => {
    const world = freshLibraryWorld({ media: false, media1_3: true });
    const env = { FAKE_REVIEW_MODE: "approve", FAKE_OVERLAYS: "dense" };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    ingestShoot(world, "shoot-a", 2, { withAudio: true });

    const requestId = requestCreate(world, {
      topic: "Chữ quá dày", style: styleId, sourceHint: "shoot-a",
      voice: "none", duration: [1, 120], language: "en",
    });

    studioWorkerUntil(world, () => {
      const runId = autoAcceptedRuns(world, requestId)[0]?.run_id;
      return runId !== undefined && status(world.studio, runId).run.state === "FAILED";
    }, 200, env);

    const runs = autoAcceptedRuns(world, requestId);
    expect(runs, "the autopilot never planned a run").toHaveLength(1);
    const runId = runs[0]!.run_id;

    expect(status(world.studio, runId).run.state).toBe("FAILED");
    expect(stageState(world.studio, runId, "plan-edit")).toBe("FAILED");
    expect(failedChecks(world.studio, runId, "plan-edit")).toEqual(["overlays-valid"]);

    // The dead end this test exists to pin: nothing reopens a request whose run FAILED, so the replan loop
    // never gets a second chance at the overlay plan. Keep polling to prove it is not just slow.
    studioWorkerUntil(world, () => false, 10, env);
    expect(requestStatus(world, requestId).status).toBe("claimed");
    expect(autoAcceptedRuns(world, requestId), "a FAILED run must not have been replanned").toHaveLength(1);
  }, 600_000);

  it.skipIf(!systemFontPath())("an overlay dropped at media-compose is rejected by review and replanned into a clean episode", () => {
    const world = freshLibraryWorld({ media: false, media1_3: true });
    // `approve` on purpose: the rejection below has to come from the render report, not from the review mode.
    const env = { FAKE_REVIEW_MODE: "approve", FAKE_OVERLAYS: "unresolvable" };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    const voiceId = addVoice(world);
    // No music tracks on the brand (so `music: null` is `brand_no_tracks`, not a rejection reason) and no
    // burned-in subtitles (nothing here is about captions) -- the brand exists purely so the overlay plan is
    // renderable at all.
    expect(setBrand(world, CHANNEL_ID, { subtitles: "none" })).toBe(true);
    ingestShoot(world, "shoot-a", 2, { withAudio: true });

    const requestId = requestCreate(world, {
      topic: "Chữ neo vào chỗ không có", style: styleId, sourceHint: "shoot-a",
      voice: "tts", voiceId, duration: [1, 120], language: "en",
    });

    studioWorkerUntil(world, () => requestStatus(world, requestId).status === "fulfilled", 400, env);
    const fulfilled = requestStatus(world, requestId);
    expect(fulfilled.status, JSON.stringify(fulfilled)).toBe("fulfilled");

    const runs = autoAcceptedRuns(world, requestId);
    expect(runs.map((r) => r.replan_no), "expected exactly one replan (run 1 rejected, run 2 approved)").toEqual([0, 1]);
    const first = runs[0]!;
    const second = runs[1]!;

    // ---- run 1: the plan passed `overlays-valid` and only died at composition ----
    expect(stageState(world.studio, first.run_id, "plan-edit")).toBe("SUCCEEDED");
    expect(status(world.studio, first.run_id).run.state).toBe("SUCCEEDED");
    const firstComposition = readJson<Composition>(artifactPathFor(world.studio, first.run_id, "media-compose", "composition")!);
    expect(firstComposition.text_events).toEqual([]);
    expect(firstComposition.text_dropped.map((d) => d.id)).toEqual(["OV01"]);
    const firstReport = readJson<RenderReport>(artifactPathFor(world.studio, first.run_id, "media-render", "render_report")!);
    expect(firstReport.text_events.dropped.map((d) => d.id)).toEqual(["OV01"]);

    const firstReview = readJson<Review>(artifactPathFor(world.studio, first.run_id, "library-review", "review")!);
    expect(firstReview.decision).toBe("rejected");
    expect(firstReview.note, firstReview.note).toContain("chữ");

    const rejected = new SqliteStateStore(join(world.studio, "data", "state", "harness.db"));
    try {
      expect(rejected.listLibraryItems({}).find((i) => i.lineage.run_id === first.run_id)?.status).toBe("rejected");
    } finally {
      rejected.close();
    }

    // ---- run 2: the rejection note reached the replanned brief, and the new plan composes cleanly ----
    const secondBrief = readJson<{ request_notes?: string }>(artifactPathFor(world.studio, second.run_id, "intake", "brief")!);
    expect(secondBrief.request_notes ?? "", secondBrief.request_notes).toContain("chữ");

    const secondComposition = readJson<Composition>(artifactPathFor(world.studio, second.run_id, "media-compose", "composition")!);
    expect(secondComposition.text_dropped).toEqual([]);
    expect(secondComposition.text_events.length).toBeGreaterThanOrEqual(1);

    const manifest = readJson<LibraryItem>(join(world.lib, "items", fulfilled.item_ids[0]!, "manifest.json"));
    expect(manifest.status).toBe("approved");
    expect(manifest.lineage.run_id).toBe(second.run_id);
  }, 600_000);
});
