import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type Edl, type FitReport, type LibraryItem, type ShotsIndex } from "@harness/contracts";
import { hasFfmpeg } from "../media.js";
import { addVoice, artifactPathFor, freshLibraryWorld, ingestShoot, requestCreate, requestStatus, studioWorkerUntil, writeActiveStyle } from "../integration/library-helpers.js";

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

// Acceptance 41 (sub-project 5A §7): one episode cut from a whole shoot, not from one clip. The agent's own
// EDL already names one shot per source, so "uses >= 2 sources" would be true even without `media-fit-edl`;
// what this pins is that the FITTED edl.json -- the one `cut` actually renders, since `cut` depends only on
// `media-fit-edl` in 1.2.0 -- still spans the shoot after fitting, and that fitting really happened (at least
// one entry trimmed/extended/appended rather than every entry passed through as `kept`).
//
// The request carries NO `--source-hint` on purpose: that drives the production default end to end through
// the real CLI wiring -- `library.auto_accept.source_collections: ["shoot-*"]` -> `pickSources` case 3, "the
// newest collection matching the patterns that is neither busy nor already used". Two shoots exist so the
// choice is real, and `shoot-b` is ingested second, which makes it unambiguously the newest.
describe.skipIf(!hasFfmpeg())("acceptance 41: a multi-clip shoot becomes one episode", () => {
  it("picks the newest shoot-* collection with no hint, and its fitted EDL spans at least two of its sources", () => {
    const world = freshLibraryWorld({ media: false, media1_2: true });
    const env = { FAKE_REVIEW_MODE: "approve" };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    const voiceId = addVoice(world);
    ingestShoot(world, "shoot-a", 2, { withAudio: true });
    const newest = ingestShoot(world, "shoot-b", 3, { withAudio: true }); // ingested last => newest

    const requestId = requestCreate(world, {
      topic: "Một buổi quay, một tập", style: styleId,
      voice: "tts", voiceId, duration: [5, 120], language: "en",
    });

    studioWorkerUntil(world, () => requestStatus(world, requestId).status === "fulfilled", 400, env);
    const fulfilled = requestStatus(world, requestId);
    expect(fulfilled.status, JSON.stringify(fulfilled)).toBe("fulfilled");

    const manifest = readJson<LibraryItem>(join(world.lib, "items", fulfilled.item_ids[0]!, "manifest.json"));
    expect(manifest.status).toBe("approved");
    const runId = manifest.lineage.run_id;

    // the autopilot chose the newest shoot with no hint, and took the WHOLE shoot, not one clip of it
    const shots = readJson<ShotsIndex>(artifactPathFor(world.studio, runId, "media-index", "shots")!);
    expect(shots.sources.map((s) => s.source_id).sort()).toEqual([...newest].sort());

    const edl = readJson<Edl>(artifactPathFor(world.studio, runId, "media-fit-edl", "edl")!);
    const sourceIds = new Set(edl.entries.map((e) => e.source_id));
    expect(sourceIds.size, `fitted EDL uses only ${[...sourceIds].join(", ")}`).toBeGreaterThanOrEqual(2);

    const report = readJson<FitReport>(artifactPathFor(world.studio, runId, "media-fit-edl", "fit_report")!);
    const reshaping = report.entries.filter((e) => e.action === "appended" || e.action === "extended" || e.action === "trimmed");
    expect(reshaping.length, `every fit-report entry was "kept": ${JSON.stringify(report.entries)}`).toBeGreaterThan(0);
    // approved means the fit covered the script: no shortfall rows and the episode landed in the brief range
    expect(report.shortfalls).toEqual([]);
    expect(report.within_target).toBe(true);
  }, 300_000);
});
