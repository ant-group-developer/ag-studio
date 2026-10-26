import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FootageItem, ProjectFootage } from '@ag-studio/engine';
import { AgGoClient, AgGoClientError, type AgGoProjectAccess, type FootageFacets, type FootageFilters, type SearchFootageQuery } from '../ag-go/client';

/**
 * ag-go signs a URL (and asks R2 for the proxy) video by video, so a long list asked at once outlasts the client's
 * timeout: it is asked in lots of this many, a few lots at a time; a lot ag-go answers 502/503 is asked once more.
 */
const CHECK_LOT = 10;
const CHECK_PARALLEL = 4;

/** A video as the Inputs tab's picker shows it. */
export interface PickerFootageItem {
  assetId: string;
  name: string;
  durationMs: number;
  width: number | null;
  height: number | null;
  orientation: string | null;
  hasAudio: boolean | null;
  hasSpeech: boolean | null;
  projectIds: string[];
  projectNames: string[];
  titleVi: string | null;
  summaryVi: string | null;
  thumbnailUrl: string | null;
  analyzedAt: string | null;
  quality: number | null;
  genre: string | null;
  timeOfDay: string | null;
  tags: string[];
  usable: boolean | null;
}

/**
 * Whether a person may add an ag-go project to a Studio project (plan 2026-10-24): `addable` they may download its
 * originals and it has a usable analysed video; `view_only` they see it watermarked only; `no_videos` nothing usable
 * analysed yet; `not_visible` they do not see it.
 */
export type AgGoAddability = 'addable' | 'view_only' | 'no_videos' | 'not_visible';

export function addability(a: AgGoProjectAccess | undefined): AgGoAddability {
  if (!a?.canView) return 'not_visible';
  if (!a.canDownloadOriginals) return 'view_only';
  return a.usableVideos > 0 ? 'addable' : 'no_videos';
}

/**
 * ag-go for a project's inputs (spec 2026-10-10 agent-workspace §4, plan 2026-10-24): its trusted mode for Studio, with
 * the service key alone and bound to the ag-go projects added to the project, whoever asks (a person in the web, the
 * agent, a render). Someone who could download their originals added them, so nothing more is checked. Only whether a
 * person may add an ag-go project is asked as that person. Only the API holds the service key.
 */
@Injectable()
export class ProjectFootageService implements ProjectFootage {
  private readonly agGo: AgGoClient;

  constructor(config: ConfigService) {
    this.agGo = new AgGoClient({
      baseUrl: config.get<string>('AG_GO_API_URL') as string,
      serviceKey: config.get<string>('AG_GO_SERVICE_KEY') as string,
    });
  }

  async search(q: { projectIds: string[]; q?: string; limit?: number; cursor?: string }) {
    const r = await this.agGo.studioSearchFootage(q);
    const items: FootageItem[] = r.items.map((i) => ({
      assetId: i.assetId, name: i.name, durationMs: i.durationMs, width: i.width ?? null, height: i.height ?? null,
      hasAudio: i.hasAudio ?? null, hasSpeech: i.hasSpeech ?? null, projectNames: i.projectNames ?? null, summaryVi: i.summaryVi ?? i.titleVi ?? null,
      thumbnailUrl: i.thumbnailUrl ?? null,
    }));
    return { items, nextCursor: r.nextCursor, total: r.total };
  }

  /**
   * The Inputs tab's video picker: every filter, sort and page ag-go offers, and what the picker shows of each video
   * (the agent's `search` above stays as it is).
   */
  async searchForPicker(q: SearchFootageQuery & { projectIds: string[] }): Promise<{ items: PickerFootageItem[]; nextCursor: string | null; total: number }> {
    const r = await this.agGo.studioSearchFootage(q);
    return {
      items: r.items.map((i) => ({
        assetId: i.assetId, name: i.name, durationMs: i.durationMs, width: i.width ?? null, height: i.height ?? null, orientation: i.orientation ?? null,
        hasAudio: i.hasAudio ?? null, hasSpeech: i.hasSpeech ?? null, projectIds: i.projectIds ?? [], projectNames: i.projectNames ?? [],
        titleVi: i.titleVi || null, summaryVi: i.summaryVi || null, thumbnailUrl: i.thumbnailUrl ?? null, analyzedAt: i.analyzedAt ?? null,
        quality: i.quality ?? null, genre: i.genre || null, timeOfDay: i.timeOfDay || null, tags: i.tags ?? [], usable: i.usable ?? null,
      })),
      nextCursor: r.nextCursor,
      total: r.total,
    };
  }

  facets(filters: FootageFilters & { projectIds: string[] }): Promise<FootageFacets> {
    return this.agGo.studioFootageFacets(filters);
  }

  /** What `userId` may do with each ag-go project, asked as that person. */
  async access(userId: string, projectIds: string[]): Promise<Map<string, AgGoProjectAccess>> {
    const r = await this.agGo.projectAccess(userId, projectIds);
    return new Map(r.items.map((a) => [a.projectId, a]));
  }

  /**
   * Which of these videos belong to one of `projectIds` (ag-go serves them to the project): asked as a preview resolve,
   * whose `missing` are the others. No project: none of them.
   */
  async check(projectIds: string[], assetIds: string[]): Promise<{ ok: string[]; missing: string[] }> {
    if (!projectIds.length || !assetIds.length) return { ok: [], missing: [...assetIds] };
    const lots: string[][] = [];
    for (let i = 0; i < assetIds.length; i += CHECK_LOT) lots.push(assetIds.slice(i, i + CHECK_LOT));
    const ask = (ids: string[]) => this.agGo.studioResolveAssets({ projectIds, assetIds: ids, purpose: 'preview' });
    const missing = new Set<string>();
    let next = 0;
    const lane = async () => {
      for (let i = next++; i < lots.length; i = next++) {
        const lot = lots[i]!;
        const r = await ask(lot).catch((e: unknown) => (e instanceof AgGoClientError && (e.status === 502 || e.status === 503) ? ask(lot) : Promise.reject(e)));
        const served = new Set(r.items.map((x) => x.assetId));
        for (const id of lot) if (!served.has(id) || r.missing?.includes(id)) missing.add(id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHECK_PARALLEL, lots.length) }, lane));
    return { ok: assetIds.filter((id) => !missing.has(id)), missing: assetIds.filter((id) => missing.has(id)) };
  }
}
