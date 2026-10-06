/**
 * In-process stages of the shot-cut episode workflow (`ag-studio-episode-cut@1.0.0`, spec local-chat §3.3). They run in
 * the Studio worker and call the harness media pipeline (`@harness/core` media functions) directly — the harness CLI
 * built-ins need an ops project and are not used (ADR-0001 item 153).
 */
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  CutProxySetSchema, CutSourcesSchema, HarnessError,
  type CutProxySet, type CutSources, type ExecutorContext, type StageRequest,
} from "@harness/contracts";
import { STUDIO_TYPES, studioSourceId } from "@harness/core";
import type { InProcessStage } from "@harness/executors";
import { readInput, studioStages, toBuffer, writeEpisodeIntake, writeOutput, type StudioStageDeps } from "./stages.js";

/** What a shot-cut episode is read with when its plan says nothing (plans written before the field existed). */
export const DEFAULT_CUT_NARRATION = "tts" as const;
/** Proxies fetched at once. */
const PROXY_DOWNLOADS_AT_ONCE = 3;

/** One video ag-go resolved to a short-lived URL. */
export interface ResolvedFootage {
  assetId: string;
  url: string;
  sourceKind: "original" | "proxy" | "preview";
  watermarked: boolean;
}

/** The tools the shot-cut stages need on the worker; wired by `apps/worker`. */
export interface CutMediaDeps {
  /** ffmpeg / ffprobe executables (`STUDIO_FFMPEG_PATH`, `STUDIO_FFPROBE_PATH`). */
  ffmpeg: string;
  ffprobe: string;
  /** ag-go `POST /footage/assets/resolve` acting as `actAs` (the production owner). */
  resolveAssets(actAs: string, assetIds: string[], purpose: "preview" | "final"): Promise<{ items: ResolvedFootage[]; missing: string[] }>;
  /** Downloads `url` to the local file `dest`; throws on any HTTP or network error. */
  download(url: string, dest: string): Promise<void>;
}

function requireMedia(d: StudioStageDeps): CutMediaDeps {
  if (!d.media) throw new HarnessError("CONFIG_INVALID", "Studio worker này không có công cụ media (ffmpeg, ag-go) để dựng tập cắt theo shot", {});
  return d.media;
}

const OwnerSchema = z.object({ owner_user_id: z.string().min(1) }).passthrough();
const readSources = (r: StageRequest, ws: string) => readInput(r, ws, STUDIO_TYPES.cutSources, (v) => CutSourcesSchema.parse(v));

/** Runs `fn` over `items` with at most `n` at once, keeping the input order in the result. */
async function inBatches<T, R>(items: readonly T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
  return out;
}

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

    /**
     * The 720p proxy of every video (ag-go `resolve purpose=preview`, as the production owner), for the shot detection,
     * the transcription and the contact sheets. A video ag-go cannot serve is a contract error; a failed download (an
     * expired URL, the network) is retried.
     */
    "studio-cut-proxies": async (request, ctx) => {
      const media = requireMedia(d);
      const sources = readSources(request, ctx.workspaceDir);
      const { owner_user_id } = readInput(request, ctx.workspaceDir, STUDIO_TYPES.brief, (v) => OwnerSchema.parse(v));
      const ids = sources.sources.map((s) => s.asset_id);
      const resolved = await media.resolveAssets(owner_user_id, ids, "preview");
      const byId = new Map(resolved.items.map((i) => [i.assetId, i]));
      const missing = ids.filter((id) => resolved.missing.includes(id) || !byId.has(id));
      if (missing.length > 0) {
        throw new HarnessError("CONFIG_INVALID", `ag-go không trả được video: ${missing.join(", ")}`, { missing });
      }
      const dir = join(ctx.workspaceDir, "output", "proxies");
      mkdirSync(dir, { recursive: true });
      const proxies = await inBatches(sources.sources, PROXY_DOWNLOADS_AT_ONCE, async (s): Promise<CutProxySet["proxies"][number]> => {
        const item = byId.get(s.asset_id)!;
        const file = `${s.source_id}.mp4`;
        await media.download(item.url, join(dir, file));
        const bytes = statSync(join(dir, file)).size;
        ctx.logger.info("proxy fetched", { asset_id: s.asset_id, source_kind: item.sourceKind, bytes });
        return { index: s.index, asset_id: s.asset_id, source_id: s.source_id, file, source_kind: item.sourceKind, watermarked: item.watermarked, bytes };
      });
      writeOutput(ctx, "proxies/proxies.json", toBuffer(CutProxySetSchema.parse({ schema_version: "studio.cut-proxies/v1", proxies })));
    },
  };
}

/** Every in-process stage the Studio worker runs: the series and whole-video episode stages plus the shot-cut ones. */
export function studioInProcessStages(d: StudioStageDeps): Record<string, InProcessStage> {
  return { ...studioStages(d), ...cutStages(d) };
}
