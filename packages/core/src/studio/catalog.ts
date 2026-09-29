import type { CatalogSegment } from "@harness/contracts";

/** One item as ag-go `/footage/catalog` returns it (GĐ2 `CatalogItem`): every AI field may be null. */
export interface AgGoCatalogItem {
  segmentId: string; assetId: string; startMs: number; endMs: number; durationMs: number;
  captionVi: string | null; captionEn: string | null; tags: string[] | null; keywordsVi: string[] | null;
  subjects: string[] | null; actions: string[] | null; shotSize: string | null; cameraMotion: string | null;
  timeOfDay: string | null; setting: string | null; peopleCount: string | number | null; orientation: string | null;
  quality: number | null; usable: boolean | null; approved: boolean;
}

export function normalizeCatalogItem(i: AgGoCatalogItem): CatalogSegment {
  return {
    id: i.segmentId, asset_id: i.assetId, start_ms: i.startMs, end_ms: i.endMs,
    duration_s: Math.round((i.endMs - i.startMs)) / 1000,
    caption_vi: i.captionVi ?? "", caption_en: i.captionEn ?? "",
    tags: i.tags ?? [], keywords_vi: i.keywordsVi ?? [], subjects: i.subjects ?? [], actions: i.actions ?? [],
    shot_size: i.shotSize, camera_motion: i.cameraMotion, time_of_day: i.timeOfDay, setting: i.setting,
    people_count: i.peopleCount === null || i.peopleCount === undefined ? null : String(i.peopleCount),
    orientation: i.orientation, quality: i.quality, usable: i.usable === true, approved: i.approved,
  };
}

/** Above this many segments the catalog is pre-filtered before Claude reads it (plan 4.1). */
export const CATALOG_LIMIT = 800;

function words(s: string): string[] {
  return s.toLocaleLowerCase("vi").normalize("NFC").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
}

/**
 * Keep at most `limit` segments: unusable ones go first, then the rest are ranked by how many words of the
 * brief they share with the caption/tags/keywords, then by quality, then by being approved. Ties keep ag-go's
 * order so the result is stable for the same input.
 */
export function prefilterCatalog(segments: CatalogSegment[], brief: { topic: string; title: string }, limit = CATALOG_LIMIT): { segments: CatalogSegment[]; truncated: boolean } {
  if (segments.length <= limit) return { segments, truncated: false };
  const query = new Set(words(`${brief.title} ${brief.topic}`));
  const scored = segments.map((s, order) => {
    const text = new Set(words([s.caption_vi, s.caption_en, ...s.tags, ...s.keywords_vi, ...s.subjects, ...s.actions].join(" ")));
    let hits = 0;
    for (const w of query) if (text.has(w)) hits++;
    return { s, order, usable: s.usable ? 1 : 0, hits, quality: s.quality ?? 0, approved: s.approved ? 1 : 0 };
  });
  scored.sort((a, b) => b.usable - a.usable || b.hits - a.hits || b.quality - a.quality || b.approved - a.approved || a.order - b.order);
  return { segments: scored.slice(0, limit).map((x) => x.s), truncated: true };
}
