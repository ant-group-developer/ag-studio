import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createStudioEngineCore,
  FarmOwnerClient,
  referenceFetchNodes,
  S3Bucket,
  type StudioDb,
  type StudioBucket,
  type StudioEngineCore,
} from '@ag-studio/engine';
import { StudioDbService } from '../db/studio-db.service';

const FARM_NODES_TTL_MS = 3000;

/** The farm's machines as the owner API lists them (`GET /v1/owner/nodes`). */
export type FarmNodes = Awaited<ReturnType<FarmOwnerClient['listNodes']>>;

/**
 * Names of the farm machines online now that fetch reference videos (`studio.reference_fetch`): while YouTube blocks
 * the Studio server, a reference download goes through them. A farm out of reach counts none.
 */
export async function referenceFetcherNames(engine: Pick<EngineService, 'farmNodes'>): Promise<string[]> {
  try {
    return referenceFetchNodes((await engine.farmNodes()).nodes).map((n) => n.name);
  } catch {
    return [];
  }
}

/**
 * The Studio engine inside the API process: the same Postgres database (through StudioDbService), bucket and clock
 * the worker uses, and the farm's machine list for the Queue screen.
 */
@Injectable()
export class EngineService implements OnModuleInit {
  private _core?: StudioEngineCore;
  private _bucket?: StudioBucket;
  private _farm?: FarmOwnerClient;
  private nodes: { at: number; value: Promise<FarmNodes> } | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly dbService: StudioDbService,
  ) {}

  onModuleInit(): void {
    // StudioDbService (a dependency, so initialised first) has already connected and applied every migration.
    this._core = createStudioEngineCore({
      dataRoot: this.config.get<string>('STUDIO_DATA_ROOT', './data/harness'),
    });
    this._bucket = new S3Bucket({
      endpoint: this.config.get<string>('STUDIO_R2_ENDPOINT') as string,
      bucket: this.config.get<string>('STUDIO_R2_BUCKET') as string,
      accessKeyId: this.config.get<string>('STUDIO_R2_ACCESS_KEY_ID') as string,
      secretAccessKey: this.config.get<string>('STUDIO_R2_SECRET_ACCESS_KEY') as string,
    });
    this._farm = new FarmOwnerClient({
      baseUrl: this.config.get<string>('FARM_URL') as string,
      ownerKey: this.config.get<string>('FARM_OWNER_KEY') as string,
    });
  }

  get core(): StudioEngineCore { return this.must(this._core); }
  get db(): StudioDb { return this.dbService.db; }
  get bucket(): StudioBucket { return this.must(this._bucket); }
  get browserUrlTtl(): number { return this.config.get<number>('STUDIO_BROWSER_URL_TTL_SECONDS') ?? 3600; }

  /** The farm's machines, cached a few seconds (every open Queue screen polls them); a failure is not cached. */
  farmNodes(now = Date.now()): Promise<FarmNodes> {
    if (this.nodes && now - this.nodes.at < FARM_NODES_TTL_MS) return this.nodes.value;
    const value = this.must(this._farm).listNodes();
    this.nodes = { at: now, value };
    value.catch(() => { if (this.nodes?.value === value) this.nodes = null; });
    return value;
  }

  private must<T>(v: T | undefined): T {
    if (!v) throw new Error('EngineService used before module init');
    return v;
  }
}
