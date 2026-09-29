// Types for ag-go-api footage endpoints

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
