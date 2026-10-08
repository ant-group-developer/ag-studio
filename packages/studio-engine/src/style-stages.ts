/**
 * The style step of the series plan 3.2.0 (plan 2026-10-08 quality-fixes, ADR-0001 item 175): which reference videos
 * to learn from, watching them (download, measure, frames, delete), and keeping the style a person approved.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessError, StudioResearchSchema, StudioStyleSchema, StyleRefsSchema, type StyleRefs, type StyleWatch } from "@harness/contracts";
import { measureShots, mergeCuts, pickFrameTimes, pickReferenceVideos, STUDIO_TYPES } from "@harness/core";
import type { InProcessStage } from "@harness/executors";
import { productionKey } from "./bucket.js";
import { detectCuts, grabFrame, probeMedia, tileSheet } from "./cut-ffmpeg.js";
import { productionForRun, saveProductionDocument } from "./studio-db.js";
import { readInput, readSeed, toBuffer, writeOutput, type StudioStageDeps } from "./stages.js";

/** Scene detection threshold of the reference videos (the shot-cut footage uses the same). */
const SCENE_THRESHOLD = 0.3;
/** Frames kept per reference video: the opening closely, then scene changes and a mark every `INTERVAL` seconds. */
export const STYLE_FRAMES_PER_VIDEO = 48;
const OPENING_SECONDS = 15;
const OPENING_STEP = 1.5;
const INTERVAL = 10;
const FRAME_WIDTH = 480;
const SHEET_COLS = 4;
const SHEET_FRAMES = 16;
const WATCH_DIR = "style-watch";

const frameName = (t: number) => `f-${t.toFixed(3)}.jpg`;
const tail = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(-300);

/**
 * Watches the reference videos: each one downloaded at ≤480p into a scratch folder outside `output/`, measured
 * (scene changes), its frames kept (≤480 px, also on the bucket under `productions/<p>/style/<video>/`) and tiled into
 * contact sheets, then the video deleted — it is never an artifact. A video that cannot be downloaded or read is noted
 * with its error; with none watched (or no yt-dlp, no ffmpeg, downloads switched off, no pick) the step is skipped,
 * saying why, and the stage still succeeds. Only the bucket failing fails it (transient).
 */
async function watchReferences(d: StudioStageDeps, refs: StyleRefs, out: string, scratch: string, signal?: AbortSignal): Promise<StyleWatch> {
  const watch: StyleWatch = { schema_version: "studio.style-watch/v1", production_id: refs.production_id, skipped_reason: null, measured: null, videos: [] };
  const skip = (why: string) => ({ ...watch, skipped_reason: why });
  if (!refs.picks.length) return skip(refs.skipped_reason ?? "Không có video mẫu để học");
  if (d.referenceDownloads === false) return skip("Tải video mẫu đang tắt (STUDIO_REFERENCE_DOWNLOADS=0)");
  if (!d.ytdlp) return skip("Máy chạy Studio không có yt-dlp để tải video mẫu");
  if (!d.media) return skip("Máy chạy Studio không có ffmpeg để xem video mẫu");
  const { ffmpeg, ffprobe } = d.media;
  const measuredInput: { cuts: number[]; duration: number }[] = [];
  for (const [i, pick] of refs.picks.entries()) {
    const label = `R${i + 1}`;
    const entry: StyleWatch["videos"][number] = { label, video_id: pick.video_id, title: pick.title, duration_s: null, error: null, measured: null, cuts: [], frames: [], sheets: [] };
    watch.videos.push(entry);
    const dir = join(scratch, pick.video_id);
    mkdirSync(dir, { recursive: true });
    try {
      const path = await d.ytdlp.download(pick.video_id, dir, signal);
      const facts = await probeMedia(ffprobe, path);
      if (!facts?.duration_s) throw new Error("không đọc được video đã tải");
      entry.duration_s = Math.round(facts.duration_s * 1000) / 1000;
      entry.cuts = mergeCuts(await detectCuts(ffmpeg, path, SCENE_THRESHOLD, signal), facts.duration_s);
      entry.measured = measureShots([{ cuts: entry.cuts, duration: facts.duration_s }]);
      measuredInput.push({ cuts: entry.cuts, duration: facts.duration_s });
      const opening = Array.from({ length: Math.floor(OPENING_SECONDS / OPENING_STEP) }, (_, k) => Math.round(k * OPENING_STEP * 10) / 10 + 0.5);
      const times = pickFrameTimes({ duration: facts.duration_s, scene: entry.cuts.map((c) => c + 0.2), marks: opening, interval_seconds: INTERVAL, max_frames: STYLE_FRAMES_PER_VIDEO });
      const files: string[] = [];
      for (const f of times) {
        const t = Math.min(f.t, Math.max(0, facts.duration_s - 0.1));
        const rel = `${label}/${frameName(t)}`;
        const local = join(out, rel);
        try { await grabFrame(ffmpeg, path, t, local, FRAME_WIDTH); } catch { continue; }
        files.push(local);
        entry.frames.push({ t, file: rel, kind: t <= OPENING_SECONDS && opening.includes(f.t) ? "opening" : f.kind, key: productionKey(refs.production_id, `style/${pick.video_id}/${frameName(t)}`) });
      }
      for (let s = 0; s * SHEET_FRAMES < files.length; s++) {
        const rel = `${label}/sheet-${String(s + 1).padStart(2, "0")}.jpg`;
        await tileSheet(ffmpeg, files.slice(s * SHEET_FRAMES, (s + 1) * SHEET_FRAMES), SHEET_COLS, join(out, rel));
        entry.sheets.push({ file: rel, frames: entry.frames.slice(s * SHEET_FRAMES, (s + 1) * SHEET_FRAMES).map((f) => f.t) });
      }
    } catch (e) {
      entry.error = tail(e);
      entry.cuts = []; entry.frames = []; entry.sheets = []; entry.measured = null;
    } finally {
      rmSync(dir, { recursive: true, force: true }); // the video itself is never kept
    }
    // the frames the web shows: on the bucket (a failure here is the stage's, not the video's)
    for (const f of entry.frames) await d.bucket.put(f.key, readFileSync(join(out, f.file)), "image/jpeg");
  }
  watch.measured = measureShots(measuredInput);
  if (!watch.measured) return { ...watch, skipped_reason: `Không xem được video mẫu nào: ${watch.videos.map((v) => `${v.video_id}: ${v.error}`).join("; ")}`.slice(0, 1000) };
  return watch;
}

export function styleStages(d: StudioStageDeps): Record<string, InProcessStage> {
  return {
    /** The reference videos to learn from (`references.json`), or why there are none. */
    "studio-pick-references": async (request, ctx) => {
      const seed = readSeed(request, ctx.workspaceDir);
      const research = readInput(request, ctx.workspaceDir, STUDIO_TYPES.research, (v) => StudioResearchSchema.parse(v));
      const picked = pickReferenceVideos(research, { aspect: seed.aspect, targetSeconds: seed.hints.episode_target_seconds });
      const refs: StyleRefs = { schema_version: "studio.style-refs/v1", production_id: seed.production_id, ...picked };
      writeOutput(ctx, "references.json", toBuffer(refs));
      ctx.logger.info("reference videos picked", { picks: refs.picks.map((p) => p.video_id), skipped: refs.skipped_reason });
    },

    /** The reference videos watched (`style-watch/`): frames, contact sheets and what their scene changes measure. */
    "studio-watch-references": async (request, ctx) => {
      const refs = readInput(request, ctx.workspaceDir, STUDIO_TYPES.styleRefs, (v) => StyleRefsSchema.parse(v));
      const out = join(ctx.workspaceDir, "output", WATCH_DIR);
      const scratch = join(ctx.workspaceDir, "references");
      mkdirSync(out, { recursive: true });
      try {
        const watch = await watchReferences(d, refs, out, scratch, ctx.signal);
        writeFileSync(join(out, "watch.json"), JSON.stringify(watch, null, 2));
        ctx.logger.info("reference videos watched", {
          watched: watch.videos.filter((v) => !v.error).map((v) => v.video_id), failed: watch.videos.filter((v) => v.error).map((v) => `${v.video_id}: ${v.error}`),
          skipped: watch.skipped_reason, median_shot_s: watch.measured?.shot_seconds.median ?? null,
        });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },

    /** The style the person approved becomes the production's (a skipped one too: the series has no style). */
    "studio-apply-style": async (request, ctx) => {
      const style = readInput(request, ctx.workspaceDir, STUDIO_TYPES.style, (v) => StudioStyleSchema.parse(v));
      const p = productionForRun(d.db, request.run_id);
      if (!p) throw new HarnessError("NOT_FOUND", `no production is linked to run ${request.run_id}`, { run_id: request.run_id });
      saveProductionDocument(d.db, p.id, "style", style, `gate:${request.run_id}`);
      ctx.logger.info("approved style applied to the production", { production_id: p.id, skipped: style.skipped });
    },
  };
}
