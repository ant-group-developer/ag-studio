/**
 * In-process stages of the shot-cut episode workflow (`ag-studio-episode-cut@1.0.0`, spec local-chat §3.3). They run in
 * the Studio worker and call the harness media pipeline (`@harness/core` media functions) directly — the harness CLI
 * built-ins need an ops project and are not used (ADR-0001 item 153).
 */
import { CutSourcesSchema, HarnessError, type CutSources, type ExecutorContext, type StageRequest } from "@harness/contracts";
import { studioSourceId } from "@harness/core";
import type { InProcessStage } from "@harness/executors";
import { studioStages, toBuffer, writeEpisodeIntake, writeOutput, type StudioStageDeps } from "./stages.js";

/** What a shot-cut episode is read with when its plan says nothing (plans written before the field existed). */
export const DEFAULT_CUT_NARRATION = "tts" as const;

/** `sources.json`: the videos of the episode in plan order, each with its source number and stable source id. */
export function cutSources(episode: ReturnType<typeof writeEpisodeIntake>["episode"], language: string): CutSources {
  return CutSourcesSchema.parse({
    schema_version: "studio.cut-sources/v1",
    production_id: episode.production_id,
    episode_id: episode.episode_id,
    language,
    narration: episode.narration ?? DEFAULT_CUT_NARRATION,
    sources: episode.items.map((item, index) => {
      const asset = episode.assets[item.asset_id];
      if (!asset) throw new HarnessError("CONFIG_INVALID", `episode ${episode.episode_id}: video ${item.asset_id} has no catalog entry`, { asset_id: item.asset_id });
      const hints = episode.asset_hints?.[item.asset_id] ?? null;
      return {
        index, asset_id: item.asset_id, source_id: studioSourceId(item.asset_id),
        title: asset.title, duration_s: asset.duration_s, has_speech: hints?.has_speech ?? null, hints,
      };
    }),
  });
}

export function cutStages(d: StudioStageDeps): Record<string, InProcessStage> {
  return {
    /** Episode intake of a shot-cut episode: what every episode intake writes, plus the videos it is cut from. */
    "studio-cut-intake": async (request: StageRequest, ctx: ExecutorContext) => {
      const { brief, episode } = writeEpisodeIntake(d, request, ctx);
      writeOutput(ctx, "sources.json", toBuffer(cutSources(episode, brief.language)));
    },
  };
}

/** Every in-process stage the Studio worker runs: the series and whole-video episode stages plus the shot-cut ones. */
export function studioInProcessStages(d: StudioStageDeps): Record<string, InProcessStage> {
  return { ...studioStages(d), ...cutStages(d) };
}
