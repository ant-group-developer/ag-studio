import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FootageItem, ProjectFootage } from '@ag-studio/engine';
import { AgGoClient, AgGoClientError, type FootageFacets, type FootageFilters, type SearchFootageQuery } from '../ag-go/client';

/**
 * ag-go signs a URL (and asks R2 for the proxy) video by video, so a long timeline asked at once outlasts the client's
 * timeout: it is asked in lots of this many, a few lots at a time.
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
 * ag-go for a project's inputs (spec 2026-10-10 agent-workspace §4), with the service key acting as a user (the
 * project's owner for the agent's tools, the person themself in the web): the analysed videos of ag-go projects, and
 * whether ag-go serves a video to that user. Only the API holds the service key.
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

  async search(actAs: string, q: { projectIds: string[]; q?: string; limit?: number; cursor?: string }) {
    const r = await this.agGo.searchFootage(actAs, q);
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
  async searchForPicker(actAs: string, q: SearchFootageQuery & { projectIds: string[] }): Promise<{ items: PickerFootageItem[]; nextCursor: string | null; total: number }> {
    const r = await this.agGo.searchFootage(actAs, q);
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

  facets(actAs: string, filters: FootageFilters): Promise<FootageFacets> {
    return this.agGo.getFootageFacets(actAs, filters);
  }

  /**
   * Asks ag-go to resolve the videos for a preview as the user: what it cannot serve is `missing`. A lot ag-go could not
   * answer fails the whole check, before one it answered 404 (a video out of the user's scope).
   */
  async check(actAs: string, assetIds: string[]) {
    const lots: string[][] = [];
    for (let i = 0; i < assetIds.length; i += CHECK_LOT) lots.push(assetIds.slice(i, i + CHECK_LOT));
    const settled: PromiseSettledResult<{ served: string[]; missing: string[] }>[] = new Array(lots.length);
    let next = 0;
    const lane = async () => {
      for (let i = next++; i < lots.length; i = next++) {
        settled[i] = await this.agGo.resolveAssets(actAs, { assetIds: lots[i]!, purpose: 'preview' }).then(
          (r) => ({ status: 'fulfilled' as const, value: { served: r.items.map((x) => x.assetId), missing: r.missing ?? [] } }),
          (reason: unknown) => ({ status: 'rejected' as const, reason }),
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHECK_PARALLEL, lots.length) }, lane));
    const failed = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected').map((s) => s.reason);
    if (failed.length) throw failed.find((e) => !(e instanceof AgGoClientError && e.status === 404)) ?? failed[0];
    const served = new Set(settled.flatMap((s) => (s.status === 'fulfilled' ? s.value.served : [])));
    const flagged = new Set(settled.flatMap((s) => (s.status === 'fulfilled' ? s.value.missing : [])));
    const missing = assetIds.filter((id) => !served.has(id) || flagged.has(id));
    return { ok: assetIds.filter((id) => !missing.includes(id)), missing };
  }
}
