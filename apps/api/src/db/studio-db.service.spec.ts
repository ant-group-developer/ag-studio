/**
 * StudioDbService over a real Studio database (Postgres in PGlite, migrated): get/all/run/tx go to the same database,
 * a failed `tx` leaves nothing behind, and the API refuses to start without DATABASE_URL.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { testStudioDb } from '@ag-studio/engine/testing';
import { StudioDbService } from './studio-db.service';

describe('StudioDbService', () => {
  let db: StudioDbService;
  beforeEach(async () => { db = StudioDbService.over(await testStudioDb()); });
  afterEach(() => db.onModuleDestroy());

  const team = (id: string) => {
    const now = new Date().toISOString();
    return db.run('INSERT INTO teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', [id, `Team ${id}`, now, now]);
  };

  it('reads and writes the migrated tables', async () => {
    expect(await team('t1')).toEqual({ changes: 1 });
    await team('t2');
    expect(await db.get<{ name: string }>('SELECT name FROM teams WHERE id = ?', ['t1'])).toEqual({ name: 'Team t1' });
    expect(await db.get('SELECT id FROM teams WHERE id = ?', ['missing'])).toBeUndefined();
    expect((await db.all<{ id: string }>('SELECT id FROM teams ORDER BY id')).map((r) => r.id)).toEqual(['t1', 't2']);
    expect(await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM teams')).toEqual({ n: 2 });
    expect(await db.run('DELETE FROM teams')).toEqual({ changes: 2 });
  });

  it('a tx lands whole or not at all', async () => {
    await db.tx(async () => { await team('t1'); await team('t2'); });
    await expect(db.tx(async () => { await team('t3'); await team('t1'); })).rejects.toMatchObject({ code: '23505' });
    expect((await db.all<{ id: string }>('SELECT id FROM teams ORDER BY id')).map((r) => r.id)).toEqual(['t1', 't2']);
  });

  it('refuses to start without DATABASE_URL', async () => {
    const svc = new StudioDbService({ get: () => undefined } as unknown as ConfigService);
    await expect(svc.onModuleInit()).rejects.toThrow(/DATABASE_URL/);
    expect(() => svc.db).toThrow(/before module init/);
  });
});
