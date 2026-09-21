import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { newId, type Edl, type FitReport, type Transcript } from "@harness/contracts";
import { hasFfmpeg } from "../media.js";
import { artifactPathFor, autoAcceptedRuns, freshLibraryWorld, ingestShoot, requestCreate, status, studioWorkerUntil, writeActiveStyle } from "../integration/library-helpers.js";

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

function stageState(project: string, runId: string, key: string): string | undefined {
  return status(project, runId).stages.find((s) => s.stage_key === key)?.state;
}

/** The entry orders a `fit-report` warning names -- `snapEntry`'s warnings are the documented escape hatch
 * ("no silence within the window, kept as the editor left it"), so those points are exempt below. */
function warnedOrders(report: FitReport): Set<number> {
  const orders = new Set<number>();
  for (const w of report.warnings) {
    const m = w.match(/entry order (\d+)/);
    if (m) orders.add(Number(m[1]));
  }
  return orders;
}

// Acceptance 43 (sub-project 5A §7): with `voice: original` the editor's own cuts are kept, but never in the
// middle of a spoken word -- `media-fit-edl` snaps each in/out into the nearest real silence.
//
// The three clips here are 6/7/8 s of picture over 2.5 s of tone, so the transcript `FakeMediaEngine`
// produces (a 3-word segment every 2 s of AUDIO) stops at 2.51 s and leaves one genuine silence for the rest
// of each clip. Their first scene cuts land at 2.0 s (a word boundary), 2.4 s (inside the last word,
// 2.34-2.51 -- the one that must move) and 2.7 s (already in the silence), so the agent's EDL -- the first
// shot of each source -- exercises all three cases at once.

describe.skipIf(!hasFfmpeg())("acceptance 43: voice original never cuts mid-word", () => {
  it("every in/out of the fitted EDL sits outside every transcribed word of its own source", () => {
    const world = freshLibraryWorld({ media: false, media1_2: true });
    const env = { FAKE_REVIEW_MODE: "approve" };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    ingestShoot(world, "shoot-a", 3, { withAudio: true, audioSeconds: 2.5 });

    const requestId = requestCreate(world, {
      topic: "Giữ tiếng gốc", style: styleId, sourceHint: "shoot-a",
      voice: "original", duration: [1, 120], language: "en",
    });

    let runId: string | undefined;
    studioWorkerUntil(world, () => {
      runId = autoAcceptedRuns(world, requestId)[0]?.run_id;
      return runId !== undefined && stageState(world.studio, runId, "media-fit-edl") === "SUCCEEDED";
    }, 400, env);
    expect(runId, "no run reached media-fit-edl").toBeDefined();

    const transcript = readJson<Transcript>(artifactPathFor(world.studio, runId!, "media-transcribe", "transcript")!);
    const edl = readJson<Edl>(artifactPathFor(world.studio, runId!, "media-fit-edl", "edl")!);
    const report = readJson<FitReport>(artifactPathFor(world.studio, runId!, "media-fit-edl", "fit_report")!);
    expect(report.voice).toBe("original");

    const wordsBySource = new Map(transcript.sources.map((s) => [s.source_id, s.segments.flatMap((seg) => seg.words)]));
    for (const words of wordsBySource.values()) expect(words.length, "the fake transcript produced no words").toBeGreaterThan(0);

    const exempt = warnedOrders(report);
    let checked = 0;
    for (const entry of edl.entries) {
      if (exempt.has(entry.order)) continue;
      const words = wordsBySource.get(entry.source_id) ?? [];
      // An entry whose source produced no words at all is compared against nothing, so it must NOT count
      // towards the non-vacuity guard below -- it would make an empty transcript look like a clean pass.
      if (words.length === 0) continue;
      for (const point of [entry.in, entry.out]) {
        const inside = words.find((w) => w.start < point && point < w.end);
        expect(inside, `entry ${entry.order} (${entry.source_id}) cuts at ${point}s, inside "${inside?.word}" [${inside?.start}, ${inside?.end}]`).toBeUndefined();
        checked++;
      }
    }
    // non-vacuity: the loop above must have compared real cut points against a real word list
    expect(checked, `nothing was compared against words: warnings ${JSON.stringify(report.warnings)}`).toBeGreaterThan(0);
    // ...and at least one cut really moved, which is the behaviour being accepted, not just "nothing broke"
    expect(report.entries.some((e) => e.action === "snapped"), `no entry was snapped: ${JSON.stringify(report.entries)}`).toBe(true);
  }, 300_000);
});
