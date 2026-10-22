/**
 * The render plan of a timeline for the farm (`studio.render_*`, `studio.export_premiere`): its composition, and the
 * narration WAVs that go with the job from the voice store. Used by the video renders of `workspace/renders.ts`.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HarnessError, type StoredTimeline } from "@harness/contracts";
import { compositionFeatureLevel, isTimelineV4, layoutTimeline, RENDER_INSPECT_LEVEL, timelineToComposition } from "@harness/core";
import type { StudioRenderPayload } from "@ag-farm/protocol";
import { voicePath } from "./voice-store.js";

/** The frame size a final render can be made at, by its short edge: 1080p (the timeline's own) or 4K UHD. */
export const RENDER_RESOLUTIONS = ["1080p", "4k"] as const;
export type RenderResolution = (typeof RENDER_RESOLUTIONS)[number];
const SHORT_EDGE: Record<RenderResolution, number> = { "1080p": 1080, "4k": 2160 };

/**
 * The timeline's canvas brought to a resolution's short edge, its aspect kept (16:9 4K: 3840×2160, 9:16: 2160×3840).
 * Sides stay even for yuv420p. Text and subtitles follow: the overlay sizes them by the canvas' short edge.
 */
export function renderCanvas(canvas: { width: number; height: number }, resolution: RenderResolution): { width: number; height: number } {
  const k = SHORT_EDGE[resolution] / Math.min(canvas.width, canvas.height);
  const even = (n: number) => 2 * Math.round((n * k) / 2);
  return { width: even(canvas.width), height: even(canvas.height) };
}

/**
 * The WAV of every narration line the composition plays, from the voice store, uploaded with the job as
 * `voice/<line_id>.wav` (the composition reads `stage:voice/<line_id>.wav`). A v3 timeline has none.
 */
export function narrationUploads(t: StoredTimeline, voiceDir: string | undefined): { localPath: string; relPath: string }[] {
  if (!isTimelineV4(t) || t.narration.voice !== "tts") return [];
  const audio = new Map(t.narration.lines.map((l) => [l.line_id, l.audio]));
  return layoutTimeline(t).lines.map((l) => {
    const a = audio.get(l.line_id);
    if (!a) throw new HarnessError("CONFIG_INVALID", `lời dẫn ${l.line_id} chưa được đọc`, { line_id: l.line_id });
    if (!voiceDir) throw new HarnessError("CONFIG_INVALID", "the voice store is not configured here: a narrated timeline cannot be rendered", {});
    const localPath = voicePath(voiceDir, a.key);
    if (!existsSync(localPath)) throw new HarnessError("CONFIG_INVALID", `lời dẫn ${l.line_id}: WAV không còn trong kho giọng`, { line_id: l.line_id, key: a.key });
    return { localPath, relPath: `voice/${l.line_id}.wav` };
  });
}

/**
 * Writes `composition.json` for a timeline into `workDir` and answers the render payload and the files to upload with
 * the job. The render worker resolves `asset:<id>` inputs through Studio's `/farm/sign`.
 */
export async function prepareRender(
  workDir: string,
  p: {
    timeline: StoredTimeline; revision: number; productionId: string; episodeId: string; output: string; thumbnails: { t_s: number; text: string }[];
    voiceDir?: string;
    /** false: the composition leaves out the timeline's text look. Default: kept. */
    textStyle?: boolean;
    /** true: the render worker inspects the file it renders (`inspect.json`, contact sheets), which needs a worker at
     * `RENDER_INSPECT_LEVEL`. */
    inspect?: boolean;
    /** The frame size of the render; none: the timeline's canvas. */
    resolution?: RenderResolution;
    /** Assets whose file has no audio stream (`silentAssetIds`): their clips are silent. */
    silentAssets?: ReadonlySet<string>;
  },
): Promise<{ productionId: string; payload: StudioRenderPayload; extraUploads: { localPath: string; relPath: string }[]; renderLevel: number }> {
  const voice = narrationUploads(p.timeline, p.voiceDir);
  const timeline = p.resolution ? { ...p.timeline, canvas: renderCanvas(p.timeline.canvas, p.resolution) } : p.timeline;
  const composition = timelineToComposition(timeline, p.silentAssets ? { silentAssets: p.silentAssets } : {});
  if (p.textStyle === false) delete composition.text_style;
  const compPath = join(workDir, "render-plan", "composition.json");
  mkdirSync(dirname(compPath), { recursive: true });
  writeFileSync(compPath, JSON.stringify(composition, null, 2));
  return {
    productionId: p.productionId,
    payload: {
      production_id: p.productionId, revision: p.revision, composition: "stage:composition.json", canvas: timeline.canvas,
      handle_seconds: 0, output: p.output, thumbnails: p.thumbnails, ...(p.inspect ? { inspect: true } : {}),
    },
    extraUploads: [{ localPath: compPath, relPath: "composition.json" }, ...voice],
    renderLevel: Math.max(compositionFeatureLevel(composition), p.inspect ? RENDER_INSPECT_LEVEL : 0),
  };
}
