/**
 * Plan 3.2.0, `watch-references`: the reference videos downloaded (fake yt-dlp: 10 s of 2 s black/white scenes),
 * measured, their frames kept and the videos deleted. Needs ffmpeg + ffprobe (FFMPEG_PATH / FFPROBE_PATH).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { StyleWatchSchema, type StyleRefs, type StyleWatch } from "@harness/contracts";
import { STUDIO_TYPES } from "@harness/core";
import { studioInProcessStages, ytDlp, type CutMediaDeps, type StudioStageDeps } from "../src/index.js";
import { hasFfmpeg } from "../../../tests/media.js";
import { fakeFootage, ROOT, world } from "./helpers.js";
import { runStage, stageWorkspace } from "./stage-harness.js";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
const FAKE_YTDLP = [process.execPath, join(ROOT, "fixtures", "fake-yt-dlp.mjs")];

const pick = (video_id: string) => ({
  video_id, url: `https://www.youtube.com/watch?v=${video_id}`, channel_id: "UCmei", channel_title: "Mei Time", title: `Video ${video_id}`,
  duration_s: 10, views: 10, views_per_day: 1, published_at: "2026-06-01T00:00:00Z", reason: "test",
});
const refs = (ids: string[], skipped_reason: string | null = null): StyleRefs => ({ schema_version: "studio.style-refs/v1", production_id: "prod-1", target_seconds: 600, skipped_reason, picks: ids.map(pick) });

function setup(o: { referenceDownloads?: boolean; withoutYtdlp?: boolean } = {}) {
  const w = world();
  const media = { ffmpeg: FFMPEG, ffprobe: FFPROBE } as CutMediaDeps;
  const d: StudioStageDeps = {
    db: w.db, bucket: w.bucket, footage: fakeFootage(), startEpisodeRun: async () => ({ runId: "x" }), media,
    ...(o.withoutYtdlp ? {} : { ytdlp: ytDlp({ argv: FAKE_YTDLP, ffmpeg: FFMPEG }) }),
    ...(o.referenceDownloads !== undefined ? { referenceDownloads: o.referenceDownloads } : {}),
  };
  return { w, stage: studioInProcessStages(d)["studio-watch-references"] };
}
async function watch(s: ReturnType<typeof setup>, r: StyleRefs) {
  const run = stageWorkspace({ runId: "run_plan", inputs: [{ type: STUDIO_TYPES.styleRefs, name: "references.json", json: r }] });
  await runStage(s.stage, run);
  return { run, watch: StyleWatchSchema.parse(run.json<StyleWatch>("style-watch/watch.json")) };
}
/** Every file under `dir`, recursively. */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
}

describe.skipIf(!hasFfmpeg())("watch-references (needs ffmpeg + ffprobe)", () => {
  it("measures each video, keeps its frames and sheets (and on the bucket), notes the one YouTube refused, deletes the videos", async () => {
    const s = setup();
    const { run, watch: w } = await watch(s, refs(["U_17EqTHUIo", "ERRgone0000"]));
    expect(w.skipped_reason).toBeNull();
    const [ok, bad] = w.videos;
    expect(ok).toMatchObject({ label: "R1", video_id: "U_17EqTHUIo", error: null, cuts: [2, 4, 6, 8] });
    expect(ok!.measured).toMatchObject({ videos: 1, shots: 5, shot_seconds: { median: 2 } });
    expect(ok!.frames.length).toBeGreaterThan(5);
    expect(ok!.frames.some((f) => f.kind === "opening")).toBe(true);
    expect(ok!.sheets.length).toBeGreaterThan(0);
    expect(bad).toMatchObject({ label: "R2", video_id: "ERRgone0000", frames: [], measured: null });
    expect(bad!.error).toMatch(/Video unavailable/);
    expect(w.measured).toEqual(ok!.measured);
    expect(await s.w.bucket.exists(ok!.frames[0]!.key)).toBeTruthy();
    expect(ok!.frames[0]!.key).toMatch(/^productions\/prod-1\/style\/U_17EqTHUIo\/f-/);
    expect(files(run.ctx.workspaceDir).filter((f) => f.endsWith(".mp4"))).toEqual([]);
  });

  it("none could be watched: skipped, saying why", async () => {
    const { watch: w } = await watch(setup(), refs(["ERRgone0000"]));
    expect(w.skipped_reason).toMatch(/Không xem được video mẫu nào: ERRgone0000: .*Video unavailable/);
    expect(w.measured).toBeNull();
  });
});

describe("watch-references skipped without downloading", () => {
  it("no pick, no yt-dlp, or downloads switched off: skipped with the reason, the stage still succeeds", async () => {
    expect((await watch(setup(), refs([], "Chưa nhập kênh tham khảo"))).watch.skipped_reason).toBe("Chưa nhập kênh tham khảo");
    expect((await watch(setup({ withoutYtdlp: true }), refs(["U_17EqTHUIo"]))).watch.skipped_reason).toMatch(/không có yt-dlp/);
    expect((await watch(setup({ referenceDownloads: false }), refs(["U_17EqTHUIo"]))).watch.skipped_reason).toMatch(/STUDIO_REFERENCE_DOWNLOADS=0/);
  });
});
