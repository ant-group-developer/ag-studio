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
}

export interface FolderItem {
  id: string;
  parentId: string | null;
  name: string;
  path: string;
  analyzedSegments: number;
  usableSegments: number;
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

export interface SegmentMediaResponse {
  segmentId: string;
  assetId: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  keyframeUrls: string[];
  /** Watermarked preview of the whole asset; play it from startMs to endMs. */
  previewUrl: string | null;
  previewWidth: number | null;
}

export interface ResolveSegmentsBody {
  segmentIds: string[];
  purpose: "preview" | "final";
}

export interface ResolvedSegmentItem {
  segmentId: string;
  assetId: string;
  startMs: number;
  endMs: number;
  url: string;
  sourceKind: "original" | "proxy" | "preview";
  watermarked: boolean;
  contentType: string;
  sizeBytes: number | null;
  cacheKey: string | null;
  expiresAt: string;
}

export interface ResolveSegmentsResponse {
  items: ResolvedSegmentItem[];
}
