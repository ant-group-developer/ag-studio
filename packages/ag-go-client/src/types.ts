// Types for ag-go-api footage endpoints

/**
 * GĐ2 whole-asset record returned by ag-go `/footage/catalog` (v3).
 * Every AI field is optional/nullable — the scan worker may not have analysed all fields yet.
 */
export interface FootageVideo {
  assetId: string;
  name: string;
  projectNames?: string[] | null;
  durationMs: number;
  orientation?: string | null;
  hasSpeech?: boolean | null;
  titleVi?: string | null;
  summaryVi?: string | null;
  genre?: string | null;
  topics?: string[] | null;
  subjects?: string[] | null;
  places?: string[] | null;
  actions?: string[] | null;
  keywordsVi?: string[] | null;
  tags?: string[] | null;
  mood?: string | null;
  setting?: string | null;
  timeOfDay?: string | null;
  peopleCount?: string | null;
  shotVariety?: string[] | null;
  quality?: number | null;
  usable?: boolean | null;
  approved?: boolean | null;
}

export interface FootageVideoResponse {
  items: FootageVideo[];
  nextCursor: string | null;
}

/**
 * GĐ2 asset media returned by ag-go `/footage/assets/:id/media`.
 */
export interface AssetMediaResponse {
  assetId: string;
  previewUrl: string | null;
  previewWidth: number | null;
  previewHeight: number | null;
  watermarked: boolean;
  posterUrl: string | null;
  keyframes: { url: string; tMs: number }[];
  contactSheetUrl: string | null;
  durationMs: number;
  expiresAt: string;
}

/**
 * GĐ2 asset resolve request body (`POST /footage/assets/resolve`).
 * Used by `/farm/sign` when a render worker requests `asset:<id>` inputs.
 */
export interface ResolveAssetsBody {
  assetIds: string[];
  purpose: "preview" | "final";
  /**
   * The rendition wanted when several are servable (spec agent-workspace §P7): a clean one first, then the short edge
   * nearest `short_edge`. An ag-go without the field ignores it (its `ValidationPipe` only strips unknown fields).
   */
  prefer?: { short_edge?: number; clean?: boolean };
}

/** Query of ag-go `GET /footage/search` (service key + `X-Act-As-User`): the analysed videos the user can reach. */
export interface SearchFootageQuery {
  projectIds?: string[];
  folderIds?: string[];
  q?: string;
  /** 1–100, ag-go default 40. */
  limit?: number;
  cursor?: string;
}

export interface SearchFootageResponse {
  items: (FootageVideo & { score?: number; width?: number | null; height?: number | null; hasAudio?: boolean | null; thumbnailUrl?: string | null })[];
  nextCursor: string | null;
  total: number;
}

export interface ResolvedAssetItem {
  assetId: string;
  url: string;
  sourceKind: "original" | "proxy" | "preview";
  watermarked: boolean;
  contentType: string;
  sizeBytes: number | null;
  cacheKey: string | null;
  expiresAt: string;
}

export interface ResolveAssetsResponse {
  items: ResolvedAssetItem[];
  /** Asset ids ag-go could not serve to this user (no servable file, no access). */
  missing?: string[];
}

export interface FolderItem {
  id: string;
  parentId: string | null;
  name: string;
  path: string;
  analyzedVideos: number;
  usableVideos: number;
}

export interface GetFoldersResponse {
  folders: FolderItem[];
}

/** Mirrors ag-go `CatalogFiltersDto` (GĐ2). */
export interface FootageCatalogFilters {
  /** Default true on the ag-go side. */
  usableOnly?: boolean;
  minQuality?: number;
  orientations?: string[];
  shotSizes?: string[];
  q?: string;
}

export interface FootageCatalogBody {
  folderIds: string[];
  filters?: FootageCatalogFilters;
  limit?: number;
  cursor?: string;
}

/** Mirrors ag-go `CatalogItem` (GĐ2 footage.service.ts): every field the scan AI fills may be null. */
export interface CatalogItem {
  segmentId: string;
  assetId: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  captionVi: string | null;
  captionEn: string | null;
  tags: string[] | null;
  keywordsVi: string[] | null;
  subjects: string[] | null;
  actions: string[] | null;
  shotSize: string | null;
  cameraMotion: string | null;
  timeOfDay: string | null;
  setting: string | null;
  peopleCount: string | null;
  orientation: string | null;
  quality: number | null;
  usable: boolean | null;
  approved: boolean;
}

export interface CatalogResponse {
  items: CatalogItem[];
  nextCursor: string | null;
}

/** Where the prep of one footage stands at ag-go (`POST /footage/assets/prep`, contract H2 of plan 2026-10-13). */
export type AssetPrepState = "ready" | "running" | "missing" | "failed";
/** What a running prep does: waits for a farm machine, cuts shots, or reads what is said. */
export type AssetPrepPhase = "queued" | "cutting" | "transcribing";
/** `none`: no sound; `skipped`: the scan said nobody speaks; `failed`: the transcription failed (the shots stand). */
export type AssetPrepTranscriptStatus = "none" | "skipped" | "done" | "failed";

/** The raw WhisperX transcript ag-go keeps (Studio cleans it when it writes `transcript.json`). */
export interface AssetPrepTranscript {
  language: string | null;
  alignment: "word" | "segment";
  engine: string;
  segments: { start: number; end: number; text: string; words: { word: string; start: number; end: number; score?: number }[] }[];
}

/** A ready prep: shots by Studio's rules, a 480 px frame per shot and contact sheets (signed GET urls), the transcript. */
export interface AssetPrep {
  prepId: string;
  preparedAt: string;
  durationS: number;
  width: number;
  height: number;
  fps: number | null;
  hasAudio: boolean;
  sourceKind: string;
  watermarked: boolean;
  scene: { threshold: number; minShotS: number; maxShotS: number };
  shots: { n: number; in: number; out: number; frame: string; url: string }[];
  sheets: { file: string; shots: number[]; url: string }[];
  transcriptStatus: AssetPrepTranscriptStatus;
  transcript: AssetPrepTranscript | null;
}

export interface AssetPrepItem {
  assetId: string;
  state: AssetPrepState;
  /** While running. */
  phase: AssetPrepPhase | null;
  /** 0..1 while running, when the farm tells it. */
  progress: number | null;
  /** When failed. */
  error: string | null;
  /** When ready. */
  prep: AssetPrep | null;
}

export interface AssetPrepsResponse {
  items: AssetPrepItem[];
}

/** One use of footage in Studio (`POST /usage/studio-events`, contract H3); `eventKey` makes a resend count once. */
export interface StudioUsageEvent {
  eventKey: string;
  kind: "source_added" | "source_removed" | "final_render" | "premiere_export";
  occurredAt: string;
  assetId: string | null;
  agGoProjectId: string | null;
  studioProjectId: string;
  studioProjectName: string;
  studioVideoId: string | null;
  studioVideoTitle: string | null;
  studioUserId: string | null;
}

export interface StudioUsageEventsResponse {
  accepted: number;
  duplicates: number;
}
