/**
 * Catalog normalisation and pre-filter for GĐ2.
 *
 * ag-go returns `FootageVideo` (whole-asset records with AI analysis); we normalise each field to the
 * CatalogAsset shape the contracts define (camelCase in -> snake_case out, nulls for missing AI fields)
 * and then pre-filter down to the `limit` most relevant assets before Claude reads them.
 */
import type { CatalogAsset, StudioBrief } from "@harness/contracts";

/** @deprecated GĐ4 segment shape, kept only for archive reads of ag-studio-production@1.0.0. */
export interface CatalogSegment {
  id: string; asset_id: string; start_ms: number; end_ms: number; duration_s: number;
  caption_vi: string; caption_en: string; tags: string[]; keywords_vi: string[];
  subjects: string[]; actions: string[]; shot_size: string | null; camera_motion: string | null;
  time_of_day: string | null; setting: string | null; people_count: string | null;
  orientation: string | null; quality: number | null; usable: boolean; approved: boolean;
}

/** What ag-go `/footage/catalog` returns for one video (camelCase, every AI field may be null/undefined). */
export interface AgGoFootageVideo {
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

export function normalizeCatalogVideo(v: AgGoFootageVideo): CatalogAsset {
  return {
    asset_id: v.assetId,
    name: v.name,
    title_vi: v.titleVi ?? "",
    summary_vi: v.summaryVi ?? "",
    duration_s: v.durationMs / 1000,
    orientation: v.orientation ?? null,
    genre: v.genre ?? "",
    topics: v.topics ?? [],
    subjects: v.subjects ?? [],
    places: v.places ?? [],
    actions: v.actions ?? [],
    keywords_vi: v.keywordsVi ?? [],
    tags: v.tags ?? [],
    mood: v.mood ?? "",
    setting: v.setting ?? "",
    time_of_day: v.timeOfDay ?? "",
    people_count: v.peopleCount ?? "",
    shot_variety: v.shotVariety ?? [],
    has_speech: v.hasSpeech ?? null,
    quality: v.quality ?? null,
    usable: v.usable === true,
    approved: v.approved === true,
    project_names: v.projectNames ?? [],
  };
}

/** How many assets we pass to Claude before truncation (GĐ2 whole-asset flows). */
export const CATALOG_LIMIT = 300;

function words(s: string): string[] {
  return s.toLocaleLowerCase("vi").normalize("NFC").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
}

/** Orientations that fit a canvas: `null`/`square` fit both. */
export function orientationFits(orientation: string | null, aspect: StudioBrief["aspect"]): boolean {
  if (!orientation || orientation === "square") return true;
  return aspect === "9:16" ? orientation === "portrait" : orientation === "landscape";
}

/**
 * Pre-filter up to `limit` catalog assets (GĐ2 whole-asset):
 * 1. Drop unusable, wrong-orientation, zero-duration first (hard filter; callers may already have done some of
 *    this but we recheck to be safe).
 * 2. Rank remaining by word overlap with brief (title+description+goal+keywords), then quality, then approved;
 *    ties keep ag-go order (stable sort).
 */
export function prefilterCatalog(
  assets: CatalogAsset[],
  brief: Pick<StudioBrief, "title" | "description" | "goal" | "keywords" | "aspect">,
  limit = CATALOG_LIMIT,
): { assets: CatalogAsset[]; truncated: boolean } {
  const eligible = assets.filter(
    (a) => a.usable && a.duration_s > 0 && orientationFits(a.orientation, brief.aspect),
  );
  if (eligible.length <= limit) return { assets: eligible, truncated: false };

  const query = new Set(
    words([brief.title, brief.description, brief.goal, ...brief.keywords].join(" ")),
  );
  const scored = eligible.map((a, order) => {
    const text = new Set(
      words([a.title_vi, a.summary_vi, a.genre, ...a.topics, ...a.subjects, ...a.places, ...a.actions, ...a.keywords_vi, ...a.tags].join(" ")),
    );
    let hits = 0;
    for (const w of query) if (text.has(w)) hits++;
    return { a, order, hits, quality: a.quality ?? 0, approved: a.approved ? 1 : 0 };
  });
  scored.sort((x, y) => y.hits - x.hits || y.quality - x.quality || y.approved - x.approved || x.order - y.order);
  return { assets: scored.slice(0, limit).map((x) => x.a), truncated: true };
}

// ---------------------------------------------------------------------------
// Legacy GĐ4 segment-based normalisation (archived productions only)
// ---------------------------------------------------------------------------

/** @deprecated segment-based; used only for ag-studio-production@1.0.0 archive paths */
export interface AgGoCatalogItem {
  segmentId: string; assetId: string; startMs: number; endMs: number; durationMs: number;
  captionVi: string | null; captionEn: string | null; tags: string[] | null; keywordsVi: string[] | null;
  subjects: string[] | null; actions: string[] | null; shotSize: string | null; cameraMotion: string | null;
  timeOfDay: string | null; setting: string | null; peopleCount: string | number | null; orientation: string | null;
  quality: number | null; usable: boolean | null; approved: boolean;
}

/** @deprecated use normalizeCatalogVideo for GĐ2 whole-asset flows */
export function normalizeCatalogItem(i: AgGoCatalogItem): CatalogSegment {
  return {
    id: i.segmentId, asset_id: i.assetId, start_ms: i.startMs, end_ms: i.endMs,
    duration_s: Math.round(i.endMs - i.startMs) / 1000,
    caption_vi: i.captionVi ?? "", caption_en: i.captionEn ?? "",
    tags: i.tags ?? [], keywords_vi: i.keywordsVi ?? [], subjects: i.subjects ?? [], actions: i.actions ?? [],
    shot_size: i.shotSize, camera_motion: i.cameraMotion, time_of_day: i.timeOfDay, setting: i.setting,
    people_count: i.peopleCount === null || i.peopleCount === undefined ? null : String(i.peopleCount),
    orientation: i.orientation, quality: i.quality, usable: i.usable === true, approved: i.approved,
  };
}
