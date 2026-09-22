import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { newId, type Composition, type Edl, type LibraryItem, type RenderReport } from "@harness/contracts";
import { frameStdDev, hasFfmpeg, systemFontPath } from "../media.js";
import {
  addTrack, addVoice, artifactPathFor, freshLibraryWorld, ingestShoot, requestCreate, requestStatus, setBrand,
  status, studioWorkerUntil, writeActiveStyle,
} from "../integration/library-helpers.js";

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

const CHANNEL_ID = "channel-one";
/** Default brand `safe_margin_px`; `final-graph.ts` overlays the logo at half of it from both edges. */
const SAFE_MARGIN_PX = 120;

// Acceptance 47 (sub-project 5B §8): the headline promise of 5B -- one branded 4K episode with burned-in
// karaoke subtitles, a title on screen, a logo in the corner and ducked music, produced end to end by the
// studio autopilot with no human command. The assertions here are the ones a probe alone cannot make: that
// the ASS document really carries a branded `Title` dialogue, that the logo corner of a real frame is
// actually painted (not just that a filter was in the argv), and that the `clip_set` the thumbnail stage
// consumes has exactly one file per timeline segment.
//
// NVENC is unavailable on this machine (driver too old), so the encoder is CPU and nothing here pins it.
describe.skipIf(!hasFfmpeg() || !systemFontPath())("acceptance 47: a branded 4K episode with karaoke captions", () => {
  it("burns the brand's title and subtitles in, paints the logo corner, and cuts one clip per segment", () => {
    const world = freshLibraryWorld({ media: false, media1_3: true });
    const env = { FAKE_REVIEW_MODE: "approve" };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    const voiceId = addVoice(world);
    addTrack(world, "calm-01", { mood: ["calm"], seconds: 8, loopOk: true });
    expect(setBrand(world, CHANNEL_ID, { withLogo: true, tracks: ["calm-01"], subtitles: "karaoke" })).toBe(true);
    ingestShoot(world, "shoot-a", 3, { withAudio: true });

    const requestId = requestCreate(world, {
      topic: "Tập có thương hiệu", style: styleId, sourceHint: "shoot-a",
      voice: "tts", voiceId, duration: [5, 120], language: "en",
    });

    studioWorkerUntil(world, () => requestStatus(world, requestId).status === "fulfilled", 400, env);
    const fulfilled = requestStatus(world, requestId);
    expect(fulfilled.status, JSON.stringify(fulfilled)).toBe("fulfilled");

    const manifest = readJson<LibraryItem>(join(world.lib, "items", fulfilled.item_ids[0]!, "manifest.json"));
    expect(manifest.status).toBe("approved");
    const runId = manifest.lineage.run_id;
    expect(status(world.studio, runId).run.state).toBe("SUCCEEDED");

    const composition = readJson<Composition>(artifactPathFor(world.studio, runId, "media-compose", "composition")!);
    const report = readJson<RenderReport>(artifactPathFor(world.studio, runId, "media-render", "render_report")!);
    expect(report.brand).toBe("present");
    expect(composition.captions.mode).toBe("karaoke");

    // ---- the ASS document really styles a branded title, not just a subtitle track ----
    const ass = readFileSync(artifactPathFor(world.studio, runId, "media-compose", "overlay_ass")!, "utf8");
    const dialogues = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    const titleDialogues = dialogues.filter((l) => l.split(",")[3] === "Title");
    expect(titleDialogues.length, `no Title dialogue among ${dialogues.length} lines`).toBeGreaterThanOrEqual(1);
    expect(composition.text_events.some((e) => e.kind === "title")).toBe(true);
    // karaoke really is karaoke: `\kf` word timing, which only the `SubHi` style path emits
    expect(dialogues.some((l) => l.includes("{\\kf"))).toBe(true);

    // ---- the logo corner of a mid-episode frame is painted, measured on the pixels ----
    const episode = artifactPathFor(world.studio, runId, "media-render", "episode_video")!;
    // The window is derived the way `render-valid`'s own `logoCrop()` derives it (fix wave, I1) rather than
    // copied from a constant: a `2 x height_px` square anchored at `safe_margin_px / 2` from the corner.
    const corner = composition.logo!.corner;
    const probe = composition.logo!.height_px * 2;
    const m = SAFE_MARGIN_PX / 2;
    const stddev = frameStdDev(episode, composition.total_seconds / 2, {
      w: probe, h: probe, x: corner === "left" ? m : 3840 - m - probe, y: m,
    });
    expect(stddev, "ffmpeg could not extract the mid-episode frame").not.toBeNull();
    expect(stddev!, `the ${corner} logo corner is a flat fill: nothing was drawn there`).toBeGreaterThan(4);

    // ---- cuts/: exactly one file per timeline segment, plus the manifest ----
    const edl = readJson<Edl>(artifactPathFor(world.studio, runId, "media-fit-edl", "edl")!);
    const cutsDir = artifactPathFor(world.studio, runId, "media-render", "clip_set")!;
    const clips = readdirSync(cutsDir).filter((f) => f.endsWith(".mp4")).sort();
    expect(clips).toEqual(edl.entries.map((e) => `${String(e.order).padStart(3, "0")}.mp4`).sort());
    expect(clips).toHaveLength(composition.segments.length);
    expect(readdirSync(cutsDir)).toContain("manifest.json");
  }, 600_000);
});
