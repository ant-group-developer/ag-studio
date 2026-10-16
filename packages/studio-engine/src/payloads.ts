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
  },
): Promise<{ productionId: string; payload: StudioRenderPayload; extraUploads: { localPath: string; relPath: string }[]; renderLevel: number }> {
  const voice = narrationUploads(p.timeline, p.voiceDir);
  const composition = timelineToComposition(p.timeline);
  if (p.textStyle === false) delete composition.text_style;
  const compPath = join(workDir, "render-plan", "composition.json");
  mkdirSync(dirname(compPath), { recursive: true });
  writeFileSync(compPath, JSON.stringify(composition, null, 2));
  return {
    productionId: p.productionId,
    payload: {
      production_id: p.productionId, revision: p.revision, composition: "stage:composition.json", canvas: p.timeline.canvas,
      handle_seconds: 0, output: p.output, thumbnails: p.thumbnails, ...(p.inspect ? { inspect: true } : {}),
    },
    extraUploads: [{ localPath: compPath, relPath: "composition.json" }, ...voice],
    renderLevel: Math.max(compositionFeatureLevel(composition), p.inspect ? RENDER_INSPECT_LEVEL : 0),
  };
}
