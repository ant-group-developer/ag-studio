import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createStudioEngineCore,
  FarmOwnerClient,
  ffmpegThumbnailRenderer,
  S3Bucket,
  StudioDb,
  type EditorDeps,
  type StudioBucket,
  type StudioEngineCore,
  type ThumbnailRenderer,
} from '@ag-studio/engine';
import { StudioDbService } from '../db/studio-db.service';

/**
 * The Studio engine inside the API process (plan 3.1 "gọi core ngay trong process"): the same harness store,
 * workflow registry and checkers the worker uses, over the same `studio.db`, so a gate submitted from the web
 * is verified exactly like a worker would verify it.
 */
@Injectable()
export class EngineService implements OnModuleInit, OnModuleDestroy {
  private _core?: StudioEngineCore;
  private _db?: StudioDb;
  private _bucket?: StudioBucket;
  private _farm?: FarmOwnerClient;
  private _thumbnails: ThumbnailRenderer | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly dbService: StudioDbService,
  ) {}

  onModuleInit(): void {
    // StudioDbService (a dependency, so initialised first) has already applied every migration.
    const ffmpeg = this.config.get<string>('STUDIO_FFMPEG_PATH');
    this._core = createStudioEngineCore({
      dbPath: this.config.get<string>('STUDIO_DB_PATH', './data/studio.db'),
      dataRoot: this.config.get<string>('STUDIO_DATA_ROOT', './data/harness'),
      ...(ffmpeg ? { ffmpeg } : {}),
    });
    this._db = new StudioDb(this.dbService.db);
    this._bucket = new S3Bucket({
      endpoint: this.config.get<string>('STUDIO_R2_ENDPOINT') as string,
      bucket: this.config.get<string>('STUDIO_R2_BUCKET') as string,
      accessKeyId: this.config.get<string>('STUDIO_R2_ACCESS_KEY_ID') as string,
      secretAccessKey: this.config.get<string>('STUDIO_R2_SECRET_ACCESS_KEY') as string,
    });
    // Thumbnails a person makes (words, captures, uploads) are drawn here with the worker's ffmpeg and font.
    if (ffmpeg) this._thumbnails = ffmpegThumbnailRenderer({ ffmpeg });
    this._farm = new FarmOwnerClient({
      baseUrl: this.config.get<string>('FARM_URL') as string,
      ownerKey: this.config.get<string>('FARM_OWNER_KEY') as string,
    });
  }

  onModuleDestroy(): void {
    this._core?.close();
  }

  get core(): StudioEngineCore { return this.must(this._core); }
  get db(): StudioDb { return this.must(this._db); }
  get bucket(): StudioBucket { return this.must(this._bucket); }
  get editor(): EditorDeps { return { db: this.db, bucket: this.bucket, farm: this.must(this._farm) }; }
  /** Null without STUDIO_FFMPEG_PATH: the thumbnail routes that draw answer 503 then. */
  get thumbnails(): ThumbnailRenderer | null { return this._thumbnails; }
  get browserUrlTtl(): number { return this.config.get<number>('STUDIO_BROWSER_URL_TTL_SECONDS') ?? 3600; }

  private must<T>(v: T | undefined): T {
    if (!v) throw new Error('EngineService used before module init');
    return v;
  }
}
