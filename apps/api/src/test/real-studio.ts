/**
 * A real Studio database (Postgres in PGlite, every migration applied, as the API does at start) and a real engine
 * core over it, for service tests: queries run against the actual tables, so a wrong table or column name fails the
 * test instead of a mock answering whatever it was told to.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioEngineCore } from '@ag-studio/engine';
import { testStudioDb } from '@ag-studio/engine/testing';
import { StudioDbService } from '../db/studio-db.service';
import type { AccountDirectoryService } from '../auth/account-directory.service';
import type { EngineService } from '../studio/engine.service';

export interface RealStudio {
  db: StudioDbService;
  engine: EngineService;
  close(): Promise<void>;
}

export async function realStudio(): Promise<RealStudio> {
  const dir = mkdtempSync(join(tmpdir(), 'studio-api-test-'));
  const studioDb = await testStudioDb();
  const db = StudioDbService.over(studioDb);
  const core = createStudioEngineCore({ dataRoot: join(dir, 'harness') });
  const engine = { core, db: studioDb } as unknown as EngineService;
  return {
    db,
    engine,
    async close() {
      await studioDb.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function insertTeam(db: StudioDbService, id: string, ownerId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.run('INSERT INTO teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', [id, `Team ${id}`, now, now]);
  await db.run('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', [id, ownerId, 'owner', now]);
}

/** An Account API that knows nobody (tests never call the network): every person shows as their id. */
export const NO_DIRECTORY = { summaries: async () => new Map() } as unknown as AccountDirectoryService;
