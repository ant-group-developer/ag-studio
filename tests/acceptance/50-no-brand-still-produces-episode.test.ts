import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type Composition, type LibraryItem, type Overlays, type RenderReport } from "@harness/contracts";
import { hasFfmpeg } from "../media.js";
import {
  addVoice, artifactPathFor, freshLibraryWorld, ingestShoot, requestCreate, requestStatus, status,
  studioWorkerUntil, writeActiveStyle,
} from "../integration/library-helpers.js";

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

// Acceptance 50 (sub-project 5B §2.1/§7): a channel with no brand is not an error. The episode is built
// plain -- no text on screen, no logo, no music, no burned-in subtitles -- and still ships, with the reasons
// recorded rather than thrown. The agent's `overlays.json` is still written and still valid; it simply has
// nothing to be rendered with, which is a warning (`overlays_ignored_no_brand`), not a failure.
//
// This is also the one 5B acceptance that needs no font at all, precisely because there is no brand.
describe.skipIf(!hasFfmpeg())("acceptance 50: a channel with no brand still produces an episode", () => {
  it("ships a plain episode: brand absent, captions mode none, overlays ignored with a warning", () => {
    const world = freshLibraryWorld({ media: false, media1_3: true });
    const env = { FAKE_REVIEW_MODE: "approve" };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    const voiceId = addVoice(world);
    ingestShoot(world, "shoot-a", 2, { withAudio: true });
    // No `setBrand` anywhere: `brands/channel-one/` never exists in this kho.
    expect(existsSync(join(world.lib, "brands", "channel-one"))).toBe(false);

    const requestId = requestCreate(world, {
      topic: "Kênh chưa có thương hiệu", style: styleId, sourceHint: "shoot-a",
      voice: "tts", voiceId, duration: [1, 120], language: "en",
    });

    studioWorkerUntil(world, () => requestStatus(world, requestId).status === "fulfilled", 400, env);
    const fulfilled = requestStatus(world, requestId);
    expect(fulfilled.status, JSON.stringify(fulfilled)).toBe("fulfilled");

    const itemId = fulfilled.item_ids[0]!;
    const manifest = readJson<LibraryItem>(join(world.lib, "items", itemId, "manifest.json"));
    expect(manifest.status).toBe("approved");
    const runId = manifest.lineage.run_id;
    expect(status(world.studio, runId).run.state).toBe("SUCCEEDED");

    const report = readJson<RenderReport>(artifactPathFor(world.studio, runId, "media-render", "render_report")!);
    expect(report.brand).toBe("absent");
    expect(report.captions.mode).toBe("none");
    expect(report.music.track_id).toBeNull();
    expect(report.music.reason).toBe("no_brand");
    expect(report.text_events.total).toBe(0);

    const composition = readJson<Composition>(artifactPathFor(world.studio, runId, "media-compose", "composition")!);
    expect(composition.brand).toBeNull();
    expect(composition.logo).toBeNull();
    expect(composition.text_events).toEqual([]);
    expect(composition.warnings, JSON.stringify(composition.warnings)).toContain("overlays_ignored_no_brand");

    // The agent really did plan text; it was the missing brand that made it unrenderable, not a missing plan.
    const overlays = readJson<Overlays>(artifactPathFor(world.studio, runId, "plan-edit", "overlays")!);
    expect(overlays.items.length).toBeGreaterThanOrEqual(1);

    // Captions are still produced and still exported -- only the BURN-IN is off (spec §2.1: a brandless
    // channel gets no font, so nothing can be drawn, but the sidecar files are the same files).
    const srtPath = join(world.lib, "items", itemId, "captions.srt");
    expect(existsSync(srtPath), `${srtPath} missing from the exported item`).toBe(true);
    expect(existsSync(join(world.lib, "items", itemId, "captions.vtt"))).toBe(true);
    const blocks = readFileSync(srtPath, "utf8").trim().split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0);
    expect(blocks.length).toBe(composition.captions.cues.length);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  }, 600_000);
});
