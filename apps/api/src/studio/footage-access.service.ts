import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgGoClient, type AssetMediaResponse } from '../ag-go/client';
import { StudioDbService } from '../db/studio-db.service';

/**
 * Plan decision 9: sharing a production never widens anyone's footage scope. Anything in the Studio bucket
 * that carries footage pixels (render previews, the final MP4) is handed only to a member whose own ag-go
 * scope covers every source folder of the production; everyone else sees text (treatment, narration,
 * catalog captions) and hears the narration.
 */
@Injectable()
export class FootageAccessService {
  private readonly agGo: AgGoClient;
  private readonly cache = new Map<string, { at: number; folders: Set<string> }>();
  private readonly ttlMs = 60_000;

  constructor(
    config: ConfigService,
    private readonly db: StudioDbService,
  ) {
    this.agGo = new AgGoClient({
      baseUrl: config.get<string>('AG_GO_API_URL') as string,
      serviceKey: config.get<string>('AG_GO_SERVICE_KEY') as string,
    });
  }

  async coversProduction(userId: string, productionId: string): Promise<boolean> {
    const sources = this.db
      .all<{ source_id: string }>('SELECT source_id FROM production_sources WHERE production_id = ?', [productionId])
      .map((r) => r.source_id);
    if (!sources.length) return false;
    let entry = this.cache.get(userId);
    if (!entry || Date.now() - entry.at > this.ttlMs) {
      try {
        const res = await this.agGo.getFolders(userId);
        entry = { at: Date.now(), folders: new Set(res.folders.map((f) => f.id)) };
        this.cache.set(userId, entry);
      } catch {
        return false; // cannot tell -> do not hand out footage
      }
    }
    return sources.every((s) => entry!.folders.has(s));
  }

  /** Preview, poster and keyframe URLs of one video, signed by ag-go for the caller's own footage scope. */
  assetMedia(userId: string, assetId: string): Promise<AssetMediaResponse> {
    return this.agGo.getAssetMedia(userId, assetId);
  }
}
