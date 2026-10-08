/**
 * The style step of the series plan 3.2.0 (plan 2026-10-08 quality-fixes, ADR-0001 item 175): which reference videos
 * to learn from, watching them (download, measure, frames, delete), and keeping the style a person approved.
 */
import { HarnessError, StudioResearchSchema, StudioStyleSchema, type StyleRefs } from "@harness/contracts";
import { pickReferenceVideos, STUDIO_TYPES } from "@harness/core";
import type { InProcessStage } from "@harness/executors";
import { productionForRun, saveProductionDocument } from "./studio-db.js";
import { readInput, readSeed, toBuffer, writeOutput, type StudioStageDeps } from "./stages.js";

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
