/**
 * Studio's schema: `packages/studio-engine/migrations/*.sql`, applied once each in name order and recorded in
 * `schema_migrations`. The API and the worker both migrate at start; `tx()`'s lock makes the second one wait and find
 * nothing left to do.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StudioDb } from "./studio-db.js";

/** src/ and dist/ both sit one level under the package, beside `migrations/`. */
export const STUDIO_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Applies the migrations not applied yet, in `db.schema` (created when missing); answers their names. */
export async function migrateStudioDb(db: StudioDb, dir = STUDIO_MIGRATIONS_DIR, now = () => new Date().toISOString()): Promise<string[]> {
  return db.tx(async () => {
    if (db.schema !== "public") await db.exec(`CREATE SCHEMA IF NOT EXISTS ${db.schema}`);
    await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL)");
    const done = new Set((await db.all<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
    const applied: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
      if (done.has(f)) continue;
      await db.exec(readFileSync(join(dir, f), "utf8"));
      await db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", [f, now()]);
      applied.push(f);
    }
    return applied;
  });
}

/** Names of the migrations not applied yet (health checks). */
export async function pendingMigrations(db: StudioDb, dir = STUDIO_MIGRATIONS_DIR): Promise<string[]> {
  const table = await db.get("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'schema_migrations'");
  const done = new Set(table ? (await db.all<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name) : []);
  return readdirSync(dir).filter((n) => n.endsWith(".sql") && !done.has(n)).sort();
}
