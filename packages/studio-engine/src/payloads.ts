/**
 * Farm payloads built at run time (`stage_config.payload_builder`), and the same render plan for the
 * editor's "Render preview" (which runs outside the workflow).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StudioNarrationSchema, TimelineV2Schema, type TimelineV2 } from "@harness/contracts";
import { STUDIO_TYPES, timelineIssues, timelineToComposition } from "@harness/core";
import type { FarmPayloadBuild, FarmPayloadBuilder } from "@harness/executors";
import type { StudioRenderPayload, StudioTtsPayload } from "@ag-farm/protocol";
import { productionKey, type StudioBucket } from "./bucket.js";
import { readBrief, readInput } from "./stages.js";
import { latestRevision, type StudioDb } from "./studio-db.js";

export function ttsPayload(p: { productionId: string; language: string; voice: StudioTtsPayload["voice"]; lines: { line_id: string; text: string }[] }): StudioTtsPayload {
  return {
    production_id: p.productionId, language: p.language, voice: p.voice,
    lines: p.lines.map((l) => ({ line_id: l.line_id, text: l.text, pause_seconds: null })),
    align_words: false,
  };
}

/**
 * Write `composition.json` for a timeline into `workDir` and fetch every narration WAV it uses from the
 * bucket next to it: the render worker can only sign `stage:` names under the job's own input prefix, so
 * everything the composition points at is uploaded with the job.
 */
export async function prepareRender(bucket: StudioBucket, workDir: string, p: { productionId: string; timeline: TimelineV2; revision: number; output: string; final: boolean }): Promise<FarmPayloadBuild & { payload: StudioRenderPayload }> {
  const composition = timelineToComposition(p.timeline, { audioInput: (key) => `stage:${key}` });
  const extraUploads: { localPath: string; relPath: string }[] = [];
  const compPath = join(workDir, "render-plan", "composition.json");
  mkdirSync(dirname(compPath), { recursive: true });
  writeFileSync(compPath, JSON.stringify(composition, null, 2));
  extraUploads.push({ localPath: compPath, relPath: "composition.json" });
  for (const key of new Set(p.timeline.narration.flatMap((l) => (l.audio ? [l.audio.key] : [])))) {
    const local = join(workDir, "render-plan", key);
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, await bucket.get(productionKey(p.productionId, key)));
    extraUploads.push({ localPath: local, relPath: key });
  }
  return {
    productionId: p.productionId,
    payload: {
      production_id: p.productionId, revision: p.revision, composition: "stage:composition.json",
      canvas: p.timeline.canvas, handle_seconds: p.final ? 1 : 0.5, output: p.output,
    },
    extraUploads,
  };
}

export function studioPayloadBuilders(d: { db: StudioDb; bucket: StudioBucket }): Record<string, FarmPayloadBuilder> {
  return {
    "studio-tts": async (request, ctx) => {
      const brief = readBrief(request, ctx.workspaceDir);
      const narration = readInput(request, ctx.workspaceDir, STUDIO_TYPES.narration, (v) => StudioNarrationSchema.parse(v));
      return { productionId: brief.production_id, payload: ttsPayload({ productionId: brief.production_id, language: narration.language, voice: brief.voice, lines: narration.lines }) };
    },
    "studio-render-final": async (request, ctx) => {
      const brief = readBrief(request, ctx.workspaceDir);
      const timeline = readInput(request, ctx.workspaceDir, STUDIO_TYPES.timeline, (v) => TimelineV2Schema.parse(v));
      const errors = timelineIssues(timeline).filter((i) => i.severity === "error");
      if (errors.length) throw new Error(`timeline still has errors: ${errors.map((e) => e.message).join("; ")}`);
      const revision = latestRevision(d.db, brief.production_id)?.revision ?? 0;
      const output = `renders/final-${request.attempt_id}.mp4`;
      const build = await prepareRender(d.bucket, ctx.workspaceDir, { productionId: brief.production_id, timeline, revision, output, final: true });
      return { ...build, rename: { [output]: "final.mp4" } };
    },
  };
}
