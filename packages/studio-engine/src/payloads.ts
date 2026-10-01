/**
 * Farm payloads built at run time (`stage_config.payload_builder`), and the same render plan for the
 * editor's "Render preview" (which runs outside the workflow).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseStoredYoutubeKit, StudioEpisodeSchema, TimelineV3Schema } from "@harness/contracts";
import { STUDIO_TYPES, thumbnailTimes, timelineIssues, timelineToComposition } from "@harness/core";
import type { FarmPayloadBuild, FarmPayloadBuilder } from "@harness/executors";
import type { StudioRenderPayload } from "@ag-farm/protocol";
import { productionKey, type StudioBucket } from "./bucket.js";
import { readBrief, readInput } from "./stages.js";
import { episodeForRun, latestEpisodeRevision, type StudioDb } from "./studio-db.js";

/**
 * Write `composition.json` for a v3 timeline into `workDir`.
 * The render worker resolves `asset:<id>` inputs via Studio's `/farm/sign` endpoint.
 */
export async function prepareEpisodeRender(
  workDir: string,
  p: { timeline: ReturnType<typeof TimelineV3Schema.parse>; revision: number; productionId: string; episodeId: string; output: string; thumbnails: { t_s: number; text: string }[] },
): Promise<FarmPayloadBuild & { payload: StudioRenderPayload }> {
  const composition = timelineToComposition(p.timeline);
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
    extraUploads: [{ localPath: compPath, relPath: "composition.json" }],
  };
}

export function studioPayloadBuilders(d: { db: StudioDb; bucket: StudioBucket }): Record<string, FarmPayloadBuilder> {
  return {
    "studio-episode-render": async (request, ctx) => {
      const brief = readBrief(request, ctx.workspaceDir);
      const episode = readInput(request, ctx.workspaceDir, STUDIO_TYPES.episode, (v) => StudioEpisodeSchema.parse(v));
      const timeline = readInput(request, ctx.workspaceDir, STUDIO_TYPES.timeline, (v) => TimelineV3Schema.parse(v));
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
  };
}

// Re-export for the editor's preview job
export { prepareEpisodeRender as prepareRender };
export type { StudioBucket };
