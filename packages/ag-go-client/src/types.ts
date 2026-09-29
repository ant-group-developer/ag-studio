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

export interface FootageCatalogFilters {
  usable?: boolean;
  minQuality?: number;
}

export interface FootageCatalogBody {
  folderIds: string[];
  filters?: FootageCatalogFilters;
  limit?: number;
  cursor?: string;
}

export interface CatalogItem {
  segmentId: string;
  assetId: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  captionVi: string;
  captionEn: string;
  tags: string[];
  keywordsVi: string[];
  subjects: string[];
  actions: string[];
  shotSize: string;
  cameraMotion: string;
  timeOfDay: string;
  setting: string;
  peopleCount: number;
  orientation: string;
  quality: number;
  usable: boolean;
  approved: boolean;
}

export interface CatalogResponse {
  items: CatalogItem[];
  nextCursor: string | null;
}

export interface SegmentMediaResponse {
  segmentId: string;
  keyframes: string[];
  previewUrl: string | null;
  startMs: number;
  endMs: number;
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
