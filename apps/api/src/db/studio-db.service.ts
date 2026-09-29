import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Use CJS require for node:sqlite since this is CommonJS
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

@Injectable()
export class StudioDbService implements OnModuleInit {
  private readonly logger = new Logger(StudioDbService.name);
  private _db!: InstanceType<typeof DatabaseSync>;

  constructor(private readonly config: ConfigService) {}

  get db(): InstanceType<typeof DatabaseSync> {
    return this._db;
  }

  async onModuleInit(): Promise<void> {
    const dbPath = this.config.get<string>('STUDIO_DB_PATH', './data/studio.db');
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this._db = new DatabaseSync(dbPath);
    this.logger.log(`SQLite DB opened at ${dbPath}`);
    await this.runMigrations();
  }

  private async runMigrations(): Promise<void> {
    // Create schema_migrations tracking table
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

    const migrationsDir = path.resolve(__dirname, '..', '..', '..', '..', 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      this.logger.warn(`Migrations directory not found: ${migrationsDir}`);
      return;
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const version = file.replace('.sql', '');
      const stmt = this._db.prepare('SELECT version FROM schema_migrations WHERE version = ?');
      const existing = stmt.get(version);
      if (existing) {
        continue;
      }
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      try {
        this._db.exec(sql);
        this._db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
          version,
          new Date().toISOString(),
        );
        this.logger.log(`Applied migration: ${file}`);
      } catch (err) {
        this.logger.error(`Failed to apply migration ${file}: ${String(err)}`);
        throw err;
      }
    }
  }

  all<T = Record<string, unknown>>(sql: string, params: (string | number | null)[] = []): T[] {
    const stmt = this._db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, params: (string | number | null)[] = []): T | undefined {
    const stmt = this._db.prepare(sql);
    return stmt.get(...params) as T | undefined;
  }

  run(sql: string, params: (string | number | null)[] = []): { changes: number; lastInsertRowid: number | bigint } {
    const stmt = this._db.prepare(sql);
    return stmt.run(...params) as { changes: number; lastInsertRowid: number | bigint };
  }
}
