import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type FitReport, type LibraryItem, type Narration, type NarrationTiming, type Review } from "@harness/contracts";
import { SqliteStateStore } from "@harness/core";
import { hasFfmpeg } from "../media.js";
import { addVoice, artifactPathFor, autoAcceptedRuns, freshLibraryWorld, ingestShoot, requestCreate, requestStatus, status, studioWorkerUntil, writeActiveStyle } from "../integration/library-helpers.js";

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

function stageState(project: string, runId: string, key: string): string | undefined {
  return status(project, runId).stages.find((s) => s.stage_key === key)?.state;
}

// Acceptance 42 (sub-project 5A §7), two halves of the same promise -- "picture follows voice, and the voice
// is only synthesized once per sentence":
//  1. a script far longer than the footage does NOT fail `media-fit-edl`; it lands in `fit-report.shortfalls`,
//     `library-review` rejects on it (whatever FAKE_REVIEW_MODE says), and the SP4 replan loop re-runs the
//     SAME request on the SAME shoot (the collection-mode own-request exemption) with a shorter script that
//     is approved.
//  2. the TTS cache is content-addressed, not run-addressed: the same line text read by the same voice in a
//     LATER run of a DIFFERENT request never reaches the engine again.
describe.skipIf(!hasFfmpeg())("acceptance 42: a script longer than the footage is rejected and replanned", () => {
  it("run 1 records a shortfall and is rejected; the replan writes shorter lines and is approved", () => {
    const world = freshLibraryWorld({ media: false, media1_2: true });
    // FAKE_NARRATION_CHARS applies to run 1 only: once the rejection note ("thiếu ...") is carried into the
    // replanned brief's request_notes, the fake edit-plan writes 20-char lines regardless of this value.
    //
    // 1200 is the CONTRACT maximum for a narration line (`edl-valid`, spec §3.3), not an arbitrary number:
    // anything above it makes `plan-edit` fail schema validation outright, so the run would never reach
    // `media-fit-edl` and there would be no rejection to replan from (task-10 brief said 2000 -- see report).
    // At 1200 chars the fake TTS reads ~80 s of script over a single 6 s clip, which is the shortfall.
    const env = { FAKE_REVIEW_MODE: "approve", FAKE_NARRATION_CHARS: "1200" };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    const voiceId = addVoice(world);
    ingestShoot(world, "shoot-a", 1, { withAudio: true });

    const requestId = requestCreate(world, {
      topic: "Lời dài hơn hình", style: styleId, sourceHint: "shoot-a",
      voice: "tts", voiceId, duration: [1, 120], language: "en",
    });

    studioWorkerUntil(world, () => requestStatus(world, requestId).status === "fulfilled", 500, env);
    const fulfilled = requestStatus(world, requestId);
    expect(fulfilled.status, JSON.stringify(fulfilled)).toBe("fulfilled");

    const runs = autoAcceptedRuns(world, requestId);
    expect(runs.map((r) => r.replan_no), "expected exactly one replan (run 1 rejected, run 2 approved)").toEqual([0, 1]);
    const [first, second] = runs as [{ run_id: string }, { run_id: string }];

    // ---- run 1: a real shortfall, a rejection that names it, and no stage failure ----
    expect(stageState(world.studio, first.run_id, "media-fit-edl")).toBe("SUCCEEDED");
    const firstReport = readJson<FitReport>(artifactPathFor(world.studio, first.run_id, "media-fit-edl", "fit_report")!);
    expect(firstReport.shortfalls.length, JSON.stringify(firstReport.shortfalls)).toBeGreaterThan(0);
    expect(firstReport.shortfalls.every((s) => s.line_ids.length > 0 && s.missing_seconds > 0)).toBe(true);

    const firstReview = readJson<Review>(artifactPathFor(world.studio, first.run_id, "library-review", "review")!);
    expect(firstReview.decision).toBe("rejected");
    expect(firstReview.note, firstReview.note).toContain("thiếu");

    const firstItem = new SqliteStateStore(join(world.studio, "data", "state", "harness.db"));
    try {
      const rejected = firstItem.listLibraryItems({}).find((i) => i.lineage.run_id === first.run_id);
      expect(rejected?.status, "run 1's exported item should have been rejected").toBe("rejected");
    } finally {
      firstItem.close();
    }

    // ---- run 2: the same request on the same shoot, shorter lines, approved ----
    const secondNarration = readJson<Narration>(artifactPathFor(world.studio, second.run_id, "plan-edit", "narration")!);
    expect(secondNarration.lines.length).toBeGreaterThan(0);
    for (const l of secondNarration.lines) expect(l.text).toHaveLength(20);

    const secondReport = readJson<FitReport>(artifactPathFor(world.studio, second.run_id, "media-fit-edl", "fit_report")!);
    expect(secondReport.shortfalls).toEqual([]);
    expect(secondReport.within_target).toBe(true);

    // brand new text, so nothing the first run synthesized can serve it
    const secondTiming = readJson<NarrationTiming>(artifactPathFor(world.studio, second.run_id, "media-tts", "narration_timing")!);
    expect(secondTiming.lines.length).toBe(secondNarration.lines.length);
    expect(secondTiming.lines.map((l) => l.cached)).toEqual(secondTiming.lines.map(() => false));

    const manifest = readJson<LibraryItem>(join(world.lib, "items", fulfilled.item_ids[0]!, "manifest.json"));
    expect(manifest.status).toBe("approved");
    expect(manifest.lineage.run_id).toBe(second.run_id);
  }, 600_000);

  it("a later run of a different request reuses every cached line instead of calling the engine again", () => {
    const world = freshLibraryWorld({ media: false, media1_2: true });
    const env = { FAKE_REVIEW_MODE: "approve" }; // default 40-char lines, identical in both requests

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    const voiceId = addVoice(world);
    ingestShoot(world, "shoot-b", 1, { withAudio: true });
    ingestShoot(world, "shoot-c", 1, { withAudio: true });

    const firstId = requestCreate(world, { topic: "Tập một", style: styleId, sourceHint: "shoot-b", voice: "tts", voiceId, duration: [1, 120], language: "en" });
    studioWorkerUntil(world, () => requestStatus(world, firstId).status === "fulfilled", 400, env);
    expect(requestStatus(world, firstId).status).toBe("fulfilled");

    const firstRun = autoAcceptedRuns(world, firstId)[0]!.run_id;
    const firstTiming = readJson<NarrationTiming>(artifactPathFor(world.studio, firstRun, "media-tts", "narration_timing")!);
    expect(firstTiming.lines.length).toBeGreaterThan(0);
    expect(firstTiming.lines.some((l) => l.cached), "the very first run cannot have hit the cache").toBe(false);

    // Same topic-independent line text ("x" * 40), same voice, same language: a different request, a
    // different shoot, and still the same cache entries.
    const secondId = requestCreate(world, { topic: "Tập hai", style: styleId, sourceHint: "shoot-c", voice: "tts", voiceId, duration: [1, 120], language: "en" });
    let secondRun: string | undefined;
    studioWorkerUntil(world, () => {
      secondRun = autoAcceptedRuns(world, secondId)[0]?.run_id;
      return secondRun !== undefined && stageState(world.studio, secondRun, "media-tts") === "SUCCEEDED";
    }, 400, env);
    expect(secondRun, "no run was planned for the second request").toBeDefined();

    const secondTiming = readJson<NarrationTiming>(artifactPathFor(world.studio, secondRun!, "media-tts", "narration_timing")!);
    expect(secondTiming.lines.length).toBe(firstTiming.lines.length);
    expect(secondTiming.lines.map((l) => l.cached)).toEqual(secondTiming.lines.map(() => true));

    const store = new SqliteStateStore(join(world.studio, "data", "state", "harness.db"));
    try {
      const done = store.listEvents({ event_type: "media.tts_done" }).find((e) => e.payload.run_id === secondRun);
      expect(done, "no media.tts_done event for the second run").toBeDefined();
      expect(done!.payload.cached).toBe(done!.payload.lines);
    } finally {
      store.close();
    }
  }, 600_000);
});
