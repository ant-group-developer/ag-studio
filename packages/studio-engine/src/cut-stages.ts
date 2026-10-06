/**
 * In-process stages of the shot-cut episode workflow (`ag-studio-episode-cut@1.0.0`, spec local-chat §3.3). They run in
 * the Studio worker and use the pure parts of the harness media pipeline (`buildShots`, `shotId`, …); ffmpeg runs
 * asynchronously through `cut-ffmpeg.ts` — the harness CLI built-ins need an ops project and spawn synchronously
 * (ADR-0001 item 153).
 */
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  CUT_FRAME_WIDTH, CUT_SHEET_COLS, CUT_SHEET_SHOTS, CutProxySetSchema, CutSourcesSchema, CutWatchSchema, HarnessError, ShotsIndexSchema,
  type CutProxySet, type CutSources, type CutWatch, type ExecutorContext, type ShotsIndex, type StageRequest, type Transcript,
} from "@harness/contracts";
import { StudioTranscribePayloadSchema, TRANSCRIBE_MANIFEST_SCHEMA, type StudioTranscribePayload, type TranscribeManifest } from "@ag-farm/protocol";
import { buildShots, inputPath, shotId, STUDIO_TYPES, studioSourceId } from "@harness/core";
import type { FarmPayloadBuild, FarmPayloadBuilder, InProcessStage } from "@harness/executors";
import { productionKey } from "./bucket.js";
import { detectCuts, extractAudio16k, grabFrame, probeMedia, tileSheet } from "./cut-ffmpeg.js";
import { readInput, studioStages, toBuffer, writeEpisodeIntake, writeOutput, type StudioStageDeps } from "./stages.js";

/** Shot detection on the proxies: the harness `media.scene` defaults (ADR-0001 item 113 measured them). */
export const CUT_SCENE = { threshold: 0.3, min_shot_seconds: 1, max_shot_seconds: 20 } as const;
/** faster-whisper model for `studio.transcribe`. */
export const CUT_TRANSCRIBE_MODEL = "large-v3";

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

function requireMedia(d: Pick<StudioStageDeps, "media">): CutMediaDeps {
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

    /**
     * `shots.json` (`harness.shots/v2`): each proxy probed (duration, sound) and cut into shots where the picture
     * changes (`buildShots`: 1–20 s, merged and split as the harness does), numbered `s<source index>-<shot>`. A proxy
     * that cannot be read gets no shots and an `error`; none readable at all is a contract error.
     */
    "studio-media-index": async (request, ctx) => {
      const media = requireMedia(d);
      const sources = readSources(request, ctx.workspaceDir);
      const proxies = readProxies(request, ctx.workspaceDir);
      const out: ShotsIndex["sources"] = [];
      for (const s of sources.sources) {
        const proxy = proxies.byAsset.get(s.asset_id);
        const unusable = (error: string): ShotsIndex["sources"][number] =>
          ({ source_id: s.source_id, index: s.index, file_name: proxy?.file ?? `${s.source_id}.mp4`, duration_seconds: 0, has_audio: false, error, shots: [] });
        if (!proxy) { out.push(unusable("no proxy")); continue; }
        const path = join(proxies.dir, proxy.file);
        const facts = await probeMedia(media.ffprobe, path);
        if (!facts || facts.duration_s === null) {
          ctx.logger.warn("proxy unreadable", { asset_id: s.asset_id });
          out.push(unusable(facts ? "duration unknown" : "probe failed"));
          continue;
        }
        const cuts = await detectCuts(media.ffmpeg, path, CUT_SCENE.threshold);
        const shots = buildShots(cuts, facts.duration_s, CUT_SCENE).map((x, i) => ({ shot_id: shotId(s.index, i), in: x.in, out: x.out }));
        ctx.logger.info("shots found", { asset_id: s.asset_id, shots: shots.length, duration_s: facts.duration_s });
        out.push({ source_id: s.source_id, index: s.index, file_name: proxy.file, duration_seconds: facts.duration_s, has_audio: facts.has_audio, shots });
      }
      if (out.every((s) => s.shots.length === 0)) {
        throw new HarnessError("CONFIG_INVALID", "không đọc được video nào của tập để tìm shot", { sources: out.map((s) => s.source_id) });
      }
      writeOutput(ctx, "shots.json", toBuffer(ShotsIndexSchema.parse({ schema_version: "harness.shots/v2", sources: out })));
    },

    /**
     * What Claude looks at to choose the shots (`watch` directory, `CutWatchSchema`): the middle frame of every shot and
     * contact sheets of them, 16 per sheet in shot order. Each frame also goes to the Studio bucket for the web's shot
     * grid (served only to people who can see the production's folders).
     */
    "studio-watch-source": async (request, ctx) => {
      const media = requireMedia(d);
      const sources = readSources(request, ctx.workspaceDir);
      const proxies = readProxies(request, ctx.workspaceDir);
      const shots = readInput(request, ctx.workspaceDir, STUDIO_TYPES.shots, (v) => ShotsIndexSchema.parse(v));
      const root = join(ctx.workspaceDir, "output", "watch");
      const watched: CutWatch["sources"] = [];
      for (const s of shots.sources) {
        const source = sources.sources.find((x) => x.source_id === s.source_id);
        const proxy = source ? proxies.byAsset.get(source.asset_id) : undefined;
        if (!source || !proxy || s.shots.length === 0) continue;
        const path = join(proxies.dir, proxy.file);
        const frames: CutWatch["sources"][number]["shots"] = [];
        for (const shot of s.shots) {
          const t = Math.round(((shot.in + shot.out) / 2) * 1000) / 1000;
          const frame = `frames/${shot.shot_id}.jpg`;
          await grabFrame(media.ffmpeg, path, t, join(root, frame), CUT_FRAME_WIDTH);
          const bucketKey = productionKey(sources.production_id, `episodes/${sources.episode_id}/shots/${shot.shot_id}.jpg`);
          await d.bucket.putFile(bucketKey, join(root, frame), "image/jpeg");
          frames.push({ shot_id: shot.shot_id, t, frame, bucket_key: bucketKey });
        }
        const sheets: CutWatch["sources"][number]["sheets"] = [];
        for (let k = 0; k < frames.length; k += CUT_SHEET_SHOTS) {
          const group = frames.slice(k, k + CUT_SHEET_SHOTS);
          const file = `sheets/s${String(s.index).padStart(3, "0")}-${String(sheets.length + 1).padStart(2, "0")}.jpg`;
          await tileSheet(media.ffmpeg, group.map((f) => join(root, f.frame)), CUT_SHEET_COLS, join(root, file));
          sheets.push({ file, shots: group.map((f) => f.shot_id) });
        }
        watched.push({ source_id: s.source_id, index: s.index, shots: frames, sheets });
        ctx.logger.info("contact sheets made", { source_id: s.source_id, shots: frames.length, sheets: sheets.length });
      }
      writeOutput(ctx, "watch/watch.json", toBuffer(CutWatchSchema.parse({
        schema_version: "studio.cut-watch/v1", frame_width: CUT_FRAME_WIDTH, sheet_cols: CUT_SHEET_COLS, sources: watched,
      })));
    },
  };
}

/** The `proxy_set` input: its folder and its files by asset. */
function readProxies(request: StageRequest, ws: string): { dir: string; byAsset: Map<string, CutProxySet["proxies"][number]> } {
  const dir = inputPath({ request, workspaceDir: ws }, STUDIO_TYPES.proxySet);
  if (!dir || !existsSync(join(dir, "proxies.json"))) throw new HarnessError("NOT_FOUND", `stage ${request.stage_key} has no proxy_set input`, {});
  const set = CutProxySetSchema.parse(JSON.parse(readFileSync(join(dir, "proxies.json"), "utf8")));
  return { dir, byAsset: new Map(set.proxies.map((p) => [p.asset_id, p])) };
}

/** An empty `transcribe.json`: what the transcription answers when no source has anything to say. */
function emptyTranscribeManifest(productionId: string): TranscribeManifest {
  return { schema: TRANSCRIBE_MANIFEST_SCHEMA, production_id: productionId, engine: { name: "none", version: null }, sources: [] };
}

/**
 * The farm's `transcribe.json` as the harness `transcript.json` the media pipeline reads (`fitEdl`, the survey): one
 * entry per source of the episode, empty for a source that was not sent (no sound, or ag-go says it has no speech).
 */
export function transcriptFromManifest(m: TranscribeManifest, sourceIds: readonly string[]): Transcript {
  const bySource = new Map(m.sources.map((s) => [s.source_id, s]));
  return {
    schema_version: "harness.transcript/v1",
    engine: m.engine.name,
    sources: sourceIds.map((id) => {
      const s = bySource.get(id);
      return s
        ? { source_id: id, language: s.language, alignment: s.alignment, segments: s.segments.map((g) => ({ start: g.start, end: g.end, text: g.text, words: g.words })) }
        : { source_id: id, language: null, alignment: "segment" as const, segments: [] };
    }),
  };
}

/** Farm payload builders of the shot-cut workflow (`stage_config.payload_builder`). */
export function cutPayloadBuilders(d: Pick<StudioStageDeps, "db" | "bucket" | "media">): Record<string, FarmPayloadBuilder> {
  return {
    /**
     * `studio.transcribe`: the sound of every source that has some (and that ag-go does not say is silent of speech),
     * extracted here as 16 kHz mono WAV and uploaded with the job, so the farm node never downloads the footage. No
     * such source: `skip`, with an empty transcription.
     */
    "studio-cut-transcribe": async (request, ctx): Promise<FarmPayloadBuild> => {
      const sources = readSources(request, ctx.workspaceDir);
      const shots = readInput(request, ctx.workspaceDir, STUDIO_TYPES.shots, (v) => ShotsIndexSchema.parse(v));
      const withSound = new Set(shots.sources.filter((s) => s.has_audio && s.shots.length > 0).map((s) => s.source_id));
      const wanted = sources.sources.filter((s) => withSound.has(s.source_id) && s.has_speech !== false);
      if (wanted.length === 0) {
        ctx.logger.info("no source to transcribe", {});
        return { productionId: sources.production_id, payload: null, skip: { files: { "transcribe.json": JSON.stringify(emptyTranscribeManifest(sources.production_id), null, 2) } } };
      }
      const media = requireMedia(d);
      const proxies = readProxies(request, ctx.workspaceDir);
      const extraUploads: NonNullable<FarmPayloadBuild["extraUploads"]> = [];
      const sent: StudioTranscribePayload["sources"] = [];
      for (const s of wanted) {
        const relPath = `audio/${s.source_id}.wav`;
        const localPath = join(ctx.workspaceDir, "transcribe", relPath);
        if (!(await extractAudio16k(media.ffmpeg, join(proxies.dir, proxies.byAsset.get(s.asset_id)!.file), localPath))) continue;
        extraUploads.push({ localPath, relPath });
        sent.push({ source_id: s.source_id, audio: `stage:${relPath}`, language: null });
      }
      if (sent.length === 0) {
        return { productionId: sources.production_id, payload: null, skip: { files: { "transcribe.json": JSON.stringify(emptyTranscribeManifest(sources.production_id), null, 2) } } };
      }
      const payload = StudioTranscribePayloadSchema.parse({ production_id: sources.production_id, model: CUT_TRANSCRIBE_MODEL, sources: sent, align_words: true });
      return { productionId: sources.production_id, payload, extraUploads };
    },
  };
}

/** Every in-process stage the Studio worker runs: the series and whole-video episode stages plus the shot-cut ones. */
export function studioInProcessStages(d: StudioStageDeps): Record<string, InProcessStage> {
  return { ...studioStages(d), ...cutStages(d) };
}
