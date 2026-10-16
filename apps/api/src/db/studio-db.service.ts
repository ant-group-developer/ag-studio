import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { migrateStudioDb, studioDbFromEnv, type Param, type RunResult, type StudioDb } from '@ag-studio/engine';

/**
 * Studio's Postgres database (`DATABASE_URL`) in the API process: opened and migrated at start, before the engine
 * service (which uses the same `StudioDb`). The worker keeps its own pool on the same database.
 */
@Injectable()
export class StudioDbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StudioDbService.name);
  private _db?: StudioDb;

  constructor(private readonly config: ConfigService) {}

  /** A service over a database opened elsewhere (tests: `testStudioDb()`). */
  static over(db: StudioDb): StudioDbService {
    const s = new StudioDbService(undefined as unknown as ConfigService);
    s._db = db;
    return s;
  }

  get db(): StudioDb {
    if (!this._db) throw new Error('StudioDbService used before module init');
    return this._db;
  }

  async onModuleInit(): Promise<void> {
    if (this._db) return;
    const env = {
      DATABASE_URL: this.config.get<string>('DATABASE_URL'),
      DATABASE_SCHEMA: this.config.get<string>('DATABASE_SCHEMA'),
      STUDIO_DB_POOL_MAX: this.config.get<string>('STUDIO_DB_POOL_MAX'),
    };
    this._db = studioDbFromEnv(env, (e) => this.logger.warn(`Postgres pool: ${e.message}`));
    const applied = await migrateStudioDb(this._db);
    for (const name of applied) this.logger.log(`Applied migration: ${name}`);
    this.logger.log('Postgres connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this._db?.close();
  }

  get<T = Record<string, unknown>>(sql: string, params: Param[] = []): Promise<T | undefined> { return this.db.get<T>(sql, params); }
  all<T = Record<string, unknown>>(sql: string, params: Param[] = []): Promise<T[]> { return this.db.all<T>(sql, params); }
  run(sql: string, params: Param[] = []): Promise<RunResult> { return this.db.run(sql, params); }
  /** All of `fn`'s writes land, or none (the worker writes the same database). */
  tx<T>(fn: () => Promise<T>): Promise<T> { return this.db.tx(fn); }
}
