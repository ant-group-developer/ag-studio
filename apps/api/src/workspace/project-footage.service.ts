import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FootageItem, ProjectFootage } from '@ag-studio/engine';
import { AgGoClient } from '../ag-go/client';

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
    }));
    return { items, nextCursor: r.nextCursor, total: r.total };
  }

  /** Asks ag-go to resolve the videos for a preview as the user: what it cannot serve is `missing`. */
  async check(actAs: string, assetIds: string[]) {
    const r = await this.agGo.resolveAssets(actAs, { assetIds, purpose: 'preview' });
    const served = new Set(r.items.map((i) => i.assetId));
    const missing = assetIds.filter((id) => !served.has(id) || (r.missing ?? []).includes(id));
    return { ok: assetIds.filter((id) => !missing.includes(id)), missing };
  }
}
