/** The media tools a Studio worker has (ffmpeg, ag-go resolve, downloads, the voice store), wired by `apps/worker`. */

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
  /**
   * ag-go `POST /footage/studio/assets/resolve`: videos of `projectIds` (the ag-go projects added to the project), whoever
   * asks; others are `missing`. `prefer`: the rendition wanted.
   */
  resolveAssets(projectIds: string[], assetIds: string[], purpose: "preview" | "final", prefer?: { short_edge?: number; clean?: boolean }): Promise<{ items: ResolvedFootage[]; missing: string[] }>;
  /** Downloads `url` to the local file `dest`; throws on any HTTP or network error. */
  download(url: string, dest: string): Promise<void>;
  /** The voice store (`<STUDIO_DATA_ROOT>/voice`), shared with the API. */
  voiceDir: string;
}
export type MediaDeps = CutMediaDeps;
