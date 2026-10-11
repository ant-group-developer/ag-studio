/**
 * The media tools a Studio worker has (ffmpeg, ag-go resolve, downloads, the voice store), wired by `apps/worker`,
 * and the shot detection settings the inputs of a project are prepared with (`workspace/prepare.ts`).
 */

/** Shot detection on a video: the harness `media.scene` defaults (ADR-0001 item 113 measured them). */
export const CUT_SCENE = { threshold: 0.3, min_shot_seconds: 1, max_shot_seconds: 20 } as const;
/** faster-whisper model for `studio.transcribe`. */
export const CUT_TRANSCRIBE_MODEL = "large-v3";

/** One video ag-go resolved to a short-lived URL. */
export interface ResolvedFootage {
  assetId: string;
  url: string;
  sourceKind: "original" | "proxy" | "preview";
  watermarked: boolean;
}

export interface CutMediaDeps {
  /** ffmpeg / ffprobe executables (`STUDIO_FFMPEG_PATH`, `STUDIO_FFPROBE_PATH`). */
  ffmpeg: string;
  ffprobe: string;
  /** ag-go `POST /footage/assets/resolve` acting as `actAs` (the project's owner); `prefer`: the rendition wanted. */
  resolveAssets(actAs: string, assetIds: string[], purpose: "preview" | "final", prefer?: { short_edge?: number; clean?: boolean }): Promise<{ items: ResolvedFootage[]; missing: string[] }>;
  /** Downloads `url` to the local file `dest`; throws on any HTTP or network error. */
  download(url: string, dest: string): Promise<void>;
  /** The voice store (`<STUDIO_DATA_ROOT>/voice`), shared with the API. */
  voiceDir: string;
}
export type MediaDeps = CutMediaDeps;
