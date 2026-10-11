/**
 * `videos/<id>/sources/index.json` (Studio writes it, the agent reads it): the ag-go videos one video is cut from, in
 * the order they were picked, each with its shots numbered for this video (`s<source>-<shot>`, as the shot-cut
 * pipeline names them) and the files `inputs/<asset>/` has for it. Written again whenever a source is added or removed
 * or one of its videos is prepared.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shotId, studioSourceId } from "@harness/core";
import type { StudioDb } from "../studio-db.js";
import type { InputShots } from "./prepare.js";
import { getPrepared, listSources, videoAssetIds } from "./sources-db.js";

export const VIDEO_INDEX_SCHEMA = "studio.video-sources/v1";
export const videoIndexPath = (videoId: string) => `videos/${videoId}/sources/index.json`;

export interface VideoIndexSource {
  index: number;
  asset_id: string;
  source_id: string;
  name: string;
  /** `ready`: prepared, its shots below; `failed`: preparing failed (see `error`); `missing`: not prepared yet. */
  status: "ready" | "failed" | "missing";
  input: string;
  duration_s: number | null;
  has_audio: boolean | null;
  transcript: string | null;
  error: string | null;
  shots: { shot_id: string; n: number; in: number; out: number; frame: string }[];
}

export interface VideoIndex {
  schema_version: typeof VIDEO_INDEX_SCHEMA;
  video_id: string;
  sources: VideoIndexSource[];
}

function readShots(dir: string, assetId: string): InputShots | null {
  const p = join(dir, "inputs", assetId, "shots.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as InputShots; } catch { return null; }
}

export function buildVideoIndex(db: StudioDb, dir: string, projectId: string, videoId: string): VideoIndex {
  const labels = new Map(listSources(db, projectId, { videoId }).filter((s) => s.kind === "ag_go_asset").map((s) => [s.ref, s.label]));
  const sources = videoAssetIds(db, projectId, videoId).map((assetId, index): VideoIndexSource => {
    const prepared = getPrepared(db, projectId, assetId);
    const shots = prepared?.status === "ready" ? readShots(dir, assetId) : null;
    const input = `inputs/${assetId}/`;
    return {
      index, asset_id: assetId, source_id: studioSourceId(assetId), name: labels.get(assetId) ?? prepared?.name ?? shots?.name ?? assetId,
      status: shots ? "ready" : prepared?.status === "failed" ? "failed" : "missing", input,
      duration_s: prepared?.duration_s ?? null, has_audio: prepared?.has_audio === null || prepared?.has_audio === undefined ? null : prepared.has_audio === 1,
      transcript: shots && existsSync(join(dir, input, "transcript.md")) ? `${input}transcript.md` : null,
      error: prepared?.status === "failed" ? prepared.error : null,
      shots: (shots?.shots ?? []).map((s) => ({ shot_id: shotId(index, s.n - 1), n: s.n, in: s.in, out: s.out, frame: `${input}${s.frame}` })),
    };
  });
  return { schema_version: VIDEO_INDEX_SCHEMA, video_id: videoId, sources };
}

export function writeVideoIndex(db: StudioDb, dir: string, projectId: string, videoId: string): VideoIndex {
  const index = buildVideoIndex(db, dir, projectId, videoId);
  const path = join(dir, videoIndexPath(videoId));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(index, null, 2));
  renameSync(`${path}.tmp`, path);
  return index;
}

/** Every video of the project cut from `assetId` gets its index written again (after the asset was prepared). */
export function writeVideoIndexesFor(db: StudioDb, dir: string, projectId: string, assetId: string): string[] {
  const videos = db.all<{ video_id: string }>(
    "SELECT DISTINCT video_id FROM project_sources WHERE project_id = ? AND kind = 'ag_go_asset' AND ref = ? AND video_id IS NOT NULL", [projectId, assetId],
  ).map((r) => r.video_id);
  for (const v of videos) writeVideoIndex(db, dir, projectId, v);
  return videos;
}
