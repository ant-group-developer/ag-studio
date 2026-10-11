/**
 * Studio's own tables in the same SQLite file as the harness state (`studio.db`). The API and the worker open it
 * separately; every write is a single statement or an IMMEDIATE transaction so the two processes never interleave
 * half a revision. The tables of projects, videos, chats and jobs are read and written in `workspace/` and `agent/`.
 */
import { DatabaseSync } from "node:sqlite";

type Param = string | number | null;

export class StudioDb {
  readonly db: DatabaseSync;
  constructor(dbOrPath: DatabaseSync | string) {
    this.db = typeof dbOrPath === "string" ? new DatabaseSync(dbOrPath) : dbOrPath;
    this.db.exec("PRAGMA busy_timeout = 5000");
  }
  get<T>(sql: string, params: Param[] = []): T | undefined { return this.db.prepare(sql).get(...params) as T | undefined; }
  all<T>(sql: string, params: Param[] = []): T[] { return this.db.prepare(sql).all(...params) as T[]; }
  run(sql: string, params: Param[] = []): { changes: number } { return this.db.prepare(sql).run(...params) as { changes: number }; }
  immediate<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const out = fn(); this.db.exec("COMMIT"); return out; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
}

/** Thrown when a save's `base_revision` is not the latest revision any more (the API answers 409). */
export class RevisionConflictError extends Error {
  constructor(readonly current: number, readonly base: number) {
    super(`timeline đã có revision ${current}, bản lưu dựa trên revision ${base}`);
    this.name = "RevisionConflictError";
  }
}
