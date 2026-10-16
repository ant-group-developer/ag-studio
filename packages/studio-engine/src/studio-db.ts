/**
 * Studio's database: Postgres (`DATABASE_URL`), tables in the schema `DATABASE_SCHEMA` (default public, set as every
 * connection's search_path, so SQL never names it). The API and the worker each keep a pool on it.
 *
 * Every write of more than one statement, and every read-then-write, runs in `tx()`. A transaction also takes one
 * advisory lock, so write transactions of the two processes run one after another. Inside `tx()` every query of this
 * `StudioDb` goes to the transaction's connection, whoever makes it (AsyncLocalStorage), and a nested `tx()` joins
 * the open one.
 *
 * SQL is written with `?` placeholders, turned into `$1, $2…` here. Rows come back with timestamptz as ISO strings
 * (`2026-10-14T10:20:30.123Z`, the way the code writes them), bigint/numeric as numbers, jsonb parsed, boolean as
 * boolean. JSON is written as a string (`JSON.stringify(v)`), never as an object or array.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

export type Param = string | number | boolean | null;
export interface RunResult { changes: number }

/** One connection (or the pool) the statements go to. */
export interface DbConn {
  query(sql: string, params: Param[]): Promise<{ rows: unknown[]; changes: number }>;
  /** Several statements, no parameters (migrations). */
  exec(sql: string): Promise<void>;
}

/** Key of the advisory lock every `tx()` takes (a constant: one lock for all of Studio's write transactions). */
export const WRITE_LOCK_KEY = 7_340_301;

const converted = new Map<string, string>();

/** `?` → `$n`, leaving `?` inside quoted strings, quoted identifiers and comments alone. */
export function toPgPlaceholders(sql: string): string {
  const hit = converted.get(sql);
  if (hit !== undefined) return hit;
  let out = "";
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      const end = sql.indexOf(c, i + 1);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop + 1);
      i = stop;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop - 1;
    } else if (c === "?") {
      out += `$${++n}`;
    } else {
      out += c;
    }
  }
  if (converted.size < 5000) converted.set(sql, out);
  return out;
}

/** Postgres timestamptz text (`2026-10-14 17:20:30.123456+07`) → ISO in UTC with milliseconds. */
export function pgTimestampToIso(v: string): string {
  const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(\.\d+)?([+-]\d\d)(?::?(\d\d))?(?::?(\d\d))?$/.exec(v);
  if (!m) return v;
  const ms = (m[3] ?? ".000").slice(0, 4).padEnd(4, "0");
  return new Date(`${m[1]}T${m[2]}${ms}${m[4]}:${m[5] ?? "00"}`).toISOString();
}

const toNumber = (v: string): number => Number(v);

/** A Postgres schema name Studio accepts (`DATABASE_SCHEMA`): lower case letters, digits, underscores. */
export const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export abstract class StudioDb {
  private readonly current = new AsyncLocalStorage<DbConn>();

  /** The Postgres schema Studio's tables live in (every connection's search_path). */
  constructor(readonly schema = "public") {
    if (!SCHEMA_NAME.test(schema)) throw new Error(`DATABASE_SCHEMA must be lower case letters, digits and _ (got "${schema}")`);
  }

  /** The pool (or the single connection) used outside transactions. */
  protected abstract readonly base: DbConn;
  /** Runs `fn` on one connection between BEGIN and COMMIT (ROLLBACK when it throws). */
  protected abstract inTransaction<T>(fn: (conn: DbConn) => Promise<T>): Promise<T>;
  abstract close(): Promise<void>;

  private conn(): DbConn { return this.current.getStore() ?? this.base; }

  async get<T>(sql: string, params: Param[] = []): Promise<T | undefined> {
    return (await this.conn().query(toPgPlaceholders(sql), params)).rows[0] as T | undefined;
  }
  async all<T>(sql: string, params: Param[] = []): Promise<T[]> {
    return (await this.conn().query(toPgPlaceholders(sql), params)).rows as T[];
  }
  async run(sql: string, params: Param[] = []): Promise<RunResult> {
    return { changes: (await this.conn().query(toPgPlaceholders(sql), params)).changes };
  }
  /** Several statements without parameters, in the open transaction if there is one. */
  async exec(sql: string): Promise<void> { await this.conn().exec(sql); }

  /** True inside `tx()`. */
  get inTx(): boolean { return this.current.getStore() !== undefined; }

  /**
   * All of `fn`'s statements land, or none; write transactions of every Studio process on this schema run one at a
   * time (the lock is per schema, so a Studio in another schema of the same database does not wait on this one).
   */
  async tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.current.getStore()) return fn();
    return this.inTransaction((conn) => this.current.run(conn, async () => {
      await conn.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [WRITE_LOCK_KEY, this.schema]);
      return fn();
    }));
  }
}

/** Parsers of the pg pool: same row shapes as `PgliteStudioDb` (testing.ts). */
const PG_TYPES = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === 1184) return pgTimestampToIso;
    if (oid === 20 || oid === 1700) return toNumber;
    return pg.types.getTypeParser(oid, format as "text");
  },
};

export interface PgStudioDbOptions {
  /** Schema of Studio's tables (`DATABASE_SCHEMA`, default public); `migrateStudioDb` creates it when missing. */
  schema?: string;
  /** Most connections the pool opens (`STUDIO_DB_POOL_MAX`, default 10). */
  max?: number;
  onError?: (e: Error) => void;
}

/** Studio's database on a Postgres server. */
export class PgStudioDb extends StudioDb {
  readonly pool: pg.Pool;
  protected readonly base: DbConn;

  constructor(connectionString: string, o: PgStudioDbOptions = {}) {
    super(o.schema);
    // search_path set at connect: every unqualified table name is Studio's schema
    this.pool = new pg.Pool({ connectionString, max: o.max ?? 10, types: PG_TYPES as never, options: `-c search_path=${this.schema}` });
    // an idle client losing its connection must not crash the process; the next query opens a new one
    this.pool.on("error", (e) => o.onError?.(e));
    this.base = pgConn(this.pool);
  }

  protected async inTransaction<T>(fn: (conn: DbConn) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(pgConn(client));
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> { await this.pool.end(); }
}

function pgConn(q: pg.Pool | pg.PoolClient): DbConn {
  return {
    async query(sql, params) {
      const r = await q.query(sql, params);
      return { rows: r.rows, changes: r.rowCount ?? 0 };
    },
    async exec(sql) { await q.query(sql); },
  };
}

/** `DATABASE_URL` (+ `DATABASE_SCHEMA`, `STUDIO_DB_POOL_MAX`) from the environment; refuses to start without it. */
export function studioDbFromEnv(env: NodeJS.ProcessEnv = process.env, onError?: (e: Error) => void): PgStudioDb {
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set (postgresql://user:password@host:5432/ag_studio)");
  const schema = env.DATABASE_SCHEMA?.trim() || "public";
  const max = Number(env.STUDIO_DB_POOL_MAX);
  return new PgStudioDb(url, { schema, ...(Number.isInteger(max) && max > 0 ? { max } : {}), ...(onError ? { onError } : {}) });
}

/** Thrown when a save's `base_revision` is not the latest revision any more (the API answers 409). */
export class RevisionConflictError extends Error {
  constructor(readonly current: number, readonly base: number) {
    super(`timeline đã có revision ${current}, bản lưu dựa trên revision ${base}`);
    this.name = "RevisionConflictError";
  }
}
