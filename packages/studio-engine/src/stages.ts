/**
 * Studio's in-process stages of `ag-studio-production@1.0.0` (plan 4.1): `intake`, `catalog`,
 * `build-timeline`, `export`. Each reads its inputs by artifact type and writes its declared outputs under
 * `output/`; `InProcessExecutor` turns that into the stage result.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HarnessError, SelectionSchema, StudioBriefSchema, StudioCatalogSchema, StudioNarrationSchema, TimelineV2Schema, TreatmentSchema,
  type ExecutorContext, type StageRequest, type StudioBrief, type StudioExport, type TimelineV2,
} from "@harness/contracts";
import {
  buildStudioTimeline, cuesFor, cuesToSrt, cuesToVtt, inputPath, layoutTimeline, normalizeCatalogItem, orientationFits, prefilterCatalog,
  STUDIO_TYPES, type AgGoCatalogItem,
} from "@harness/core";
import type { InProcessStage } from "@harness/executors";
import { productionKey, type StudioBucket } from "./bucket.js";
import { productionForRun, productionOwner, productionSources, saveRevision, latestRevision, type StudioDb } from "./studio-db.js";
import { productionVoice } from "./voice.js";

/** What `catalog` needs from ag-go (`AgGoClient` satisfies it). */
export interface FootageCatalogSource {
  getCatalog(actAsUserId: string, body: { folderIds: string[]; filters?: Record<string, unknown>; limit?: number; cursor?: string }): Promise<{ items: AgGoCatalogItem[]; nextCursor: string | null }>;
}

export interface StudioStageDeps {
  db: StudioDb;
  bucket: StudioBucket;
  footage: FootageCatalogSource;
}

export const DEFAULT_CANVAS = { "16:9": { width: 1920, height: 1080 }, "9:16": { width: 1080, height: 1920 } } as const;
/** ag-go pages at most 1000; 20 pages is far above the ~800 Claude will read after the pre-filter. */
const MAX_CATALOG_PAGES = 20;

export function readInput<T>(request: StageRequest, workspaceDir: string, type: string, parse: (v: unknown) => T): T {
  const p = inputPath({ request, workspaceDir }, type);
  if (!p || !existsSync(p)) throw new HarnessError("NOT_FOUND", `stage ${request.stage_key} has no ${type} input`, { type });
  return parse(JSON.parse(readFileSync(p, "utf8")));
}
export const readBrief = (r: StageRequest, ws: string) => readInput(r, ws, STUDIO_TYPES.brief, (v) => StudioBriefSchema.parse(v));

function writeOutput(ctx: ExecutorContext, name: string, body: string | Buffer): string {
  const path = join(ctx.workspaceDir, "output", name);
  mkdirSync(join(ctx.workspaceDir, "output"), { recursive: true });
  writeFileSync(path, body);
  return path;
}
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export function studioStages(d: StudioStageDeps): Record<string, InProcessStage> {
  return {
    "studio-intake": async (request, ctx) => {
      const p = productionForRun(d.db, request.run_id);
      if (!p) throw new HarnessError("NOT_FOUND", `no production is linked to run ${request.run_id}`, { run_id: request.run_id });
      const owner = productionOwner(d.db, p);
      if (!owner) throw new HarnessError("CONFIG_INVALID", `production ${p.id} has no owner to act as towards ag-go`, { production_id: p.id });
      const folders = productionSources(d.db, p.id);
      if (!p.target_seconds) throw new HarnessError("CONFIG_INVALID", `production ${p.id} has no target duration`, { production_id: p.id });
      const aspect = (p.aspect ?? "16:9") as StudioBrief["aspect"];
      const brief = StudioBriefSchema.parse({
        schema_version: "studio.brief/v1", production_id: p.id, run_id: request.run_id, owner_user_id: owner,
        title: p.title, topic: p.brief?.trim() || p.title, folder_ids: folders, target_seconds: p.target_seconds, aspect,
        canvas: p.canvas ? JSON.parse(p.canvas) : DEFAULT_CANVAS[aspect], fps: 25, language: p.language ?? "vi",
        voice: productionVoice(p.voice),
        music: p.music ? JSON.parse(p.music) : null,
      });
      writeOutput(ctx, "brief.json", JSON.stringify(brief, null, 2));
    },

    "studio-catalog": async (request, ctx) => {
      const brief = readBrief(request, ctx.workspaceDir);
      const items: AgGoCatalogItem[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
        const res = await d.footage.getCatalog(brief.owner_user_id, { folderIds: brief.folder_ids, filters: { usableOnly: true }, limit: 1000, ...(cursor ? { cursor } : {}) });
        items.push(...res.items);
        if (!res.nextCursor) break;
        cursor = res.nextCursor;
      }
      const all = items.map(normalizeCatalogItem);
      const framed = all.filter((s) => s.usable && orientationFits(s.orientation, brief.aspect) && s.duration_s > 0);
      const { segments, truncated } = prefilterCatalog(framed, brief);
      if (!segments.length) throw new HarnessError("CONFIG_INVALID", "the chosen folders have no usable analysed footage for this frame", { folder_ids: brief.folder_ids, aspect: brief.aspect });
      const catalog = StudioCatalogSchema.parse({
        schema_version: "studio.catalog/v1", production_id: brief.production_id, folder_ids: brief.folder_ids,
        total_available: all.length, truncated, segments,
      });
      ctx.logger.info("catalog built", { returned: all.length, framed: framed.length, kept: segments.length, truncated });
      writeOutput(ctx, "catalog.json", JSON.stringify(catalog));
    },

    "studio-build-timeline": async (request, ctx) => {
      const ws = ctx.workspaceDir;
      const brief = readBrief(request, ws);
      const treatment = readInput(request, ws, STUDIO_TYPES.treatment, (v) => TreatmentSchema.parse(v));
      const catalog = readInput(request, ws, STUDIO_TYPES.catalog, (v) => StudioCatalogSchema.parse(v));
      const selection = readInput(request, ws, STUDIO_TYPES.selection, (v) => SelectionSchema.parse(v));
      // The montage flow (ag-studio-montage) has no narration and no TTS: every beat lasts its treatment seconds
      // and the footage keeps its own sound.
      const narrated = !!inputPath({ request, workspaceDir: ws }, STUDIO_TYPES.narration);
      const narration = narrated ? readInput(request, ws, STUDIO_TYPES.narration, (v) => StudioNarrationSchema.parse(v)) : null;
      // Content-addressed keys: a revision keeps pointing at the audio it was saved with, whatever is
      // synthesized later for the same line id.
      const audio = new Map<string, { key: string; duration: number }>();
      if (narrated) {
        const manifest = readInput(request, ws, STUDIO_TYPES.ttsManifest, (v) => v as { lines: { line_id: string; output: string; duration_s: number }[] });
        const voiceDir = inputPath({ request, workspaceDir: ws }, STUDIO_TYPES.voiceSet);
        if (!voiceDir) throw new HarnessError("NOT_FOUND", "build-timeline has no voice_set input", {});
        for (const line of manifest.lines) {
          const rel = line.output.replace(/^tts\//, "");
          const local = join(voiceDir, rel);
          if (!existsSync(local)) throw new HarnessError("NOT_FOUND", `tts output ${line.output} is missing`, { line_id: line.line_id });
          const bytes = readFileSync(local);
          const key = `audio/${sha256(bytes)}.wav`;
          if (!(await d.bucket.exists(productionKey(brief.production_id, key)))) await d.bucket.put(productionKey(brief.production_id, key), bytes, "audio/wav");
          audio.set(line.line_id, { key, duration: line.duration_s });
        }
      }
      const timeline = buildStudioTimeline({ brief, treatment, catalog: catalog.segments, selection, narration, audio });
      writeOutput(ctx, "timeline.json", JSON.stringify(timeline, null, 2));
      // The draft becomes the editor's next revision (the web always opens the latest one).
      const base = latestRevision(d.db, brief.production_id)?.revision ?? 0;
      const saved = saveRevision(d.db, brief.production_id, { baseRevision: base, data: timeline, authorId: "system", label: `build-timeline ${request.run_id}` });
      ctx.logger.info("timeline draft saved", { revision: saved.revision, clips: timeline.clips.length });
    },

    "studio-export": async (request, ctx) => {
      const ws = ctx.workspaceDir;
      const brief = readBrief(request, ws);
      const timeline = readInput(request, ws, STUDIO_TYPES.timeline, (v) => TimelineV2Schema.parse(v));
      const videoPath = inputPath({ request, workspaceDir: ws }, STUDIO_TYPES.finalVideo);
      const manifest = readInput(request, ws, STUDIO_TYPES.renderManifest, (v) => v as { watermarked?: boolean; duration_s?: number });
      if (!videoPath || !existsSync(videoPath)) throw new HarnessError("NOT_FOUND", "export has no final video input", {});
      const cues = cuesFor(layoutTimeline(timeline));
      const srt = Buffer.from(cuesToSrt(cues), "utf8");
      const vtt = Buffer.from(cuesToVtt(cues), "utf8");
      writeOutput(ctx, "captions.srt", srt);
      writeOutput(ctx, "captions.vtt", vtt);
      const prefix = `exports/${request.run_id}`;
      const video = readFileSync(videoPath);
      const files: StudioExport["files"] = [];
      const upload = async (kind: StudioExport["files"][number]["kind"], name: string, body: Buffer, type: string) => {
        const key = productionKey(brief.production_id, `${prefix}/${name}`);
        await d.bucket.put(key, body, type);
        files.push({ kind, key, size_bytes: body.length, checksum: `sha256:${sha256(body)}` });
      };
      const slug = brief.title.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "video";
      await upload("mp4", `${slug}.mp4`, video, "video/mp4");
      await upload("srt", `${slug}.srt`, srt, "application/x-subrip");
      await upload("vtt", `${slug}.vtt`, vtt, "text/vtt");
      await upload("timeline", "timeline.json", Buffer.from(JSON.stringify(timeline)), "application/json");
      const exp: StudioExport = {
        schema_version: "studio.export/v1", production_id: brief.production_id, run_id: request.run_id,
        duration_seconds: manifest.duration_s ?? layoutTimeline(timeline).duration, files, watermarked: manifest.watermarked === true,
      };
      writeOutput(ctx, "export.json", JSON.stringify(exp, null, 2));
      ctx.logger.info("export uploaded", { files: files.map((f) => f.key), bytes: statSync(videoPath).size });
    },
  };
}

export type { TimelineV2 };
