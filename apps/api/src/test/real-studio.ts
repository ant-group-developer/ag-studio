/**
 * A real `studio.db` (every migration applied, as the API does at start) and a real engine core over it, for
 * service tests: queries run against the actual tables, so a wrong table or column name fails the test instead of
 * a mock answering whatever it was told to.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { createStudioEngineCore, StudioDb } from '@ag-studio/engine';
import { StudioDbService } from '../db/studio-db.service';
import type { EngineService } from '../studio/engine.service';

export interface RealStudio {
  db: StudioDbService;
  engine: EngineService;
  close(): void;
}

export async function realStudio(): Promise<RealStudio> {
  const dir = mkdtempSync(join(tmpdir(), 'studio-api-test-'));
  const dbPath = join(dir, 'studio.db');
  const db = new StudioDbService({ get: (k: string, d?: unknown) => (k === 'STUDIO_DB_PATH' ? dbPath : d) } as unknown as ConfigService);
  await db.onModuleInit();
  const core = createStudioEngineCore({ dbPath, dataRoot: join(dir, 'harness') });
  const engine = { core, db: new StudioDb(db.db) } as unknown as EngineService;
  return {
    db,
    engine,
    close() {
      core.close();
      db.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function insertTeam(db: StudioDbService, id: string, ownerId: string): void {
  const now = new Date().toISOString();
  db.run('INSERT INTO teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', [id, `Team ${id}`, now, now]);
  db.run('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', [id, ownerId, 'owner', now]);
}
