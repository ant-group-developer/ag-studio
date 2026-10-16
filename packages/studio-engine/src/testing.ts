/**
 * Studio's database for tests: PGlite (Postgres compiled to WASM, in the test's own process, no server). Each
 * `testStudioDb()` is a fresh database with every migration applied, loaded from a snapshot taken once per process.
 * Not exported from the package index: `@ag-studio/engine/testing`.
 */
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { migrateStudioDb } from "./migrate.js";
import { pgTimestampToIso, StudioDb, type DbConn } from "./studio-db.js";

const toNumber = (v: string): number => Number(v);
/** Same row shapes as the pg pool of `PgStudioDb`. */
const PARSERS = { 1184: pgTimestampToIso, 20: toNumber, 1700: toNumber };

type Queryable = PGlite | Transaction;

function pgliteConn(q: Queryable): DbConn {
  return {
    async query(sql, params) {
      const r = await q.query(sql, params);
      return { rows: r.rows, changes: r.affectedRows ?? 0 };
    },
    async exec(sql) { await q.exec(sql); },
  };
}

export class PgliteStudioDb extends StudioDb {
  protected readonly base: DbConn;
  constructor(readonly pg: PGlite) {
    super();
    this.base = pgliteConn(pg);
  }
  protected inTransaction<T>(fn: (conn: DbConn) => Promise<T>): Promise<T> {
    return this.pg.transaction((t) => fn(pgliteConn(t)));
  }
  async close(): Promise<void> { if (!this.pg.closed) await this.pg.close(); }
}

let snapshot: Promise<Blob> | null = null;

async function migratedSnapshot(): Promise<Blob> {
  const pg = new PGlite({ parsers: PARSERS });
  const db = new PgliteStudioDb(pg);
  await migrateStudioDb(db);
  const blob = await pg.dumpDataDir("none");
  await db.close();
  return blob;
}

/** A fresh, migrated Studio database in memory. */
export async function testStudioDb(): Promise<PgliteStudioDb> {
  snapshot ??= migratedSnapshot();
  const pg = new PGlite({ parsers: PARSERS, loadDataDir: await snapshot });
  await pg.waitReady;
  return new PgliteStudioDb(pg);
}
