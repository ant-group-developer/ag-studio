/**
 * Farm payloads built at run time (`stage_config.payload_builder`), and the same render plan for the
 * editor's "Render preview" (which runs outside the workflow).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HarnessError, parseStoredYoutubeKit, StudioEpisodeSchema, type StoredTimeline } from "@harness/contracts";
import { isTimelineV4, layoutTimeline, STUDIO_TYPES, thumbnailTimes, timelineIssues, timelineToComposition } from "@harness/core";
import type { FarmPayloadBuild, FarmPayloadBuilder } from "@harness/executors";
import type { StudioRenderPayload } from "@ag-farm/protocol";
import { productionKey, type StudioBucket } from "./bucket.js";
import { readBrief, readInput, readTimelineInput } from "./stages.js";
import { episodeForRun, latestEpisodeRevision, type StudioDb } from "./studio-db.js";
import { voicePath } from "./voice-store.js";

/**
 * The WAV of every narration line the composition plays, from the voice store, uploaded with the job as
 * `voice/<line_id>.wav` (the composition reads `stage:voice/<line_id>.wav`). A v3 timeline has none.
 * Used by renders and by the Premiere export.
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
 * Write `composition.json` for a timeline (v3 or v4) into `workDir`.
 * The render worker resolves `asset:<id>` inputs via Studio's `/farm/sign` endpoint. A shot-cut timeline's narration
 * goes with the job from `voiceDir` (the voice store).
 */
export async function prepareEpisodeRender(
  workDir: string,
  p: {
    timeline: StoredTimeline; revision: number; productionId: string; episodeId: string; output: string; thumbnails: { t_s: number; text: string }[]; voiceDir?: string;
    /**
     * false: the composition leaves out the timeline's text look (`studio-episode-render-v4`, cut 1.0.0, renders as it
     * always did on any worker). Default: kept (a worker that cannot draw it refuses the composition).
     */
    textStyle?: boolean;
  },
): Promise<FarmPayloadBuild & { payload: StudioRenderPayload }> {
  const voice = narrationUploads(p.timeline, p.voiceDir);
  const composition = timelineToComposition(p.timeline);
  if (p.textStyle === false) delete composition.text_style;
  const compPath = join(workDir, "render-plan", "composition.json");
  mkdirSync(dirname(compPath), { recursive: true });
  writeFileSync(compPath, JSON.stringify(composition, null, 2));
  return {
    productionId: p.productionId,
    payload: {
      production_id: p.productionId,
      revision: p.revision,
      composition: "stage:composition.json",
      canvas: p.timeline.canvas,
      handle_seconds: 0,
      output: p.output,
      thumbnails: p.thumbnails,
    },
    extraUploads: [{ localPath: compPath, relPath: "composition.json" }, ...voice],
  };
}

export function studioPayloadBuilders(d: { db: StudioDb; bucket: StudioBucket }): Record<string, FarmPayloadBuilder> {
  return {
    "studio-episode-render": async (request, ctx) => {
      const brief = readBrief(request, ctx.workspaceDir);
      const episode = readInput(request, ctx.workspaceDir, STUDIO_TYPES.episode, (v) => StudioEpisodeSchema.parse(v));
      const timeline = readTimelineInput(request, ctx.workspaceDir);
      const errors = timelineIssues(timeline).filter((i) => i.severity === "error");
      if (errors.length) throw new Error(`timeline still has errors: ${errors.map((e) => e.message).join("; ")}`);
      // Use episodes.youtube override if set, else the workflow's youtube-kit output
      const ep = episodeForRun(d.db, request.run_id);
      const kitRaw = ep?.youtube
        ? parseStoredYoutubeKit(JSON.parse(ep.youtube))
        : readInput(request, ctx.workspaceDir, STUDIO_TYPES.youtubeKit, parseStoredYoutubeKit);
      const revision = latestEpisodeRevision(d.db, episode.episode_id)?.revision ?? 0;
      const output = `episodes/${episode.episode_id}/renders/final-${request.attempt_id}.mp4`;
      const build = await prepareEpisodeRender(ctx.workspaceDir, {
        timeline, revision,
        productionId: brief.production_id, episodeId: episode.episode_id,
        output,
        thumbnails: thumbnailTimes(timeline, kitRaw),
      });
      return {
        ...build,
        rename: {
          [output]: "final.mp4",
          [`${output.replace(/\.mp4$/, ".thumb-1.jpg")}`]: "thumb-1.jpg",
          [`${output.replace(/\.mp4$/, ".thumb-2.jpg")}`]: "thumb-2.jpg",
          [`${output.replace(/\.mp4$/, ".thumb-3.jpg")}`]: "thumb-3.jpg",
        },
      };
    },

    /**
     * ag-studio-episode@1.2.0 on: the video only. Thumbnails are cut afterwards on this node (`thumbnails` stage), from
     * the final video, clean of words, so the render worker draws none.
     */
    "studio-episode-render-v2": async (request, ctx) => {
      const brief = readBrief(request, ctx.workspaceDir);
      const episode = readInput(request, ctx.workspaceDir, STUDIO_TYPES.episode, (v) => StudioEpisodeSchema.parse(v));
      const timeline = readTimelineInput(request, ctx.workspaceDir);
      const errors = timelineIssues(timeline).filter((i) => i.severity === "error");
      if (errors.length) throw new Error(`timeline still has errors: ${errors.map((e) => e.message).join("; ")}`);
      const revision = latestEpisodeRevision(d.db, episode.episode_id)?.revision ?? 0;
      const output = `episodes/${episode.episode_id}/renders/final-${request.attempt_id}.mp4`;
      const build = await prepareEpisodeRender(ctx.workspaceDir, {
        timeline, revision, productionId: brief.production_id, episodeId: episode.episode_id, output, thumbnails: [],
      });
      return { ...build, rename: { [output]: "final.mp4" } };
    },
  };
}

// Re-export for the editor's preview job
export { prepareEpisodeRender as prepareRender };
export type { StudioBucket };
