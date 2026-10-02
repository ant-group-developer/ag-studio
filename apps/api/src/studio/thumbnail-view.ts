import { fileSlug, madeByPerson, type EpisodeRecord, type EpisodeThumbnail, type ThumbnailStyle } from '@ag-studio/engine';
import type { EngineService } from './engine.service';

export interface ThumbnailView {
  id: string; kind: EpisodeThumbnail['kind']; tS: number | null; assetId: string | null; parentId: string | null;
  text: string | null; style: ThumbnailStyle | null; width: number; height: number; sizeBytes: number;
  createdBy: string; createdAt: string; url: string; downloadUrl: string; deletable: boolean; drawable: boolean;
  /** The caller opened a Canva design for it (so "Lấy bản từ Canva" applies). */
  inCanva: boolean;
}

/** A thumbnail for the browser: signed URLs to show it and to save it under a readable name. */
export async function thumbnailView(engine: EngineService, ep: EpisodeRecord, t: EpisodeThumbnail, inCanva = false): Promise<ThumbnailView> {
  const ttl = engine.browserUrlTtl;
  const name = `${fileSlug(ep.title)}-${t.kind}-${t.id.slice(0, 8)}.jpg`;
  return {
    id: t.id, kind: t.kind, tS: t.t_s, assetId: t.asset_id, parentId: t.parent_id, text: t.text, style: t.style,
    width: t.width, height: t.height, sizeBytes: t.size_bytes, createdBy: t.created_by, createdAt: t.created_at,
    url: await engine.bucket.signedGetUrl(t.image_key, ttl),
    downloadUrl: await engine.bucket.signedGetUrl(t.image_key, ttl, { downloadName: name }),
    deletable: madeByPerson(t),
    // words go on a clean picture (a frame, an upload, the frame under a suggestion or drawn picture); a Canva
    // design has its own words, and a picture from before 1.2.0 has them burnt in with no clean frame kept
    drawable: t.kind !== 'canva' && t.base_key !== null,
    inCanva,
  };
}
