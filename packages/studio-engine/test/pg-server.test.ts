/**
 * On a real Postgres server (opt-in: STUDIO_PG_TEST_URL=postgresql://… of a throwaway database, emptied first): two
 * pools stand for the API and the worker. Checks what PGlite (one connection) cannot: migrating from both at once,
 * and write transactions of two processes queuing on the advisory lock.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateStudioDb, PgStudioDb, studioDbFromEnv } from "../src/index.js";

const url = process.env.STUDIO_PG_TEST_URL;

describe.skipIf(!url)("StudioDb on a Postgres server", () => {
  let api: PgStudioDb;
  let worker: PgStudioDb;

  beforeAll(async () => {
    const admin = new PgStudioDb(url!);
    await admin.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await admin.close();
    api = new PgStudioDb(url!);
    worker = new PgStudioDb(url!);
  });
  afterAll(async () => { await api?.close(); await worker?.close(); });

  it("API and worker migrating at the same time apply each migration once", async () => {
    const [a, b] = await Promise.all([migrateStudioDb(api), migrateStudioDb(worker)]);
    expect([...a, ...b]).toEqual(["0001_baseline.sql"]);
  });

  it("reads back the same shapes as PGlite", async () => {
    const at = "2026-10-14T10:20:30.123Z";
    await api.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", ["t1", "T", at, at]);
    await api.run("INSERT INTO user_prefs (user_id, prefs, updated_at) VALUES (?, ?, ?)", ["u1", JSON.stringify({ a: [1] }), at]);
    expect(await worker.get("SELECT created_at, (SELECT COUNT(*) FROM teams) AS n FROM teams")).toEqual({ created_at: at, n: 1 });
    expect(await worker.get("SELECT prefs FROM user_prefs")).toEqual({ prefs: { a: [1] } });
  });

  it("write transactions of two processes run one after another", async () => {
    const at = new Date().toISOString();
    await api.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('c', '0', ?, ?)", [at, at]);
    const bump = (db: PgStudioDb) => db.tx(async () => {
      const r = await db.get<{ name: string }>("SELECT name FROM teams WHERE id = 'c'");
      await new Promise((ok) => setTimeout(ok, 10));
      await db.run("UPDATE teams SET name = ? WHERE id = 'c'", [String(Number(r!.name) + 1)]);
    });
    await Promise.all(Array.from({ length: 10 }, (_, i) => bump(i % 2 ? api : worker)));
    expect(await api.get("SELECT name FROM teams WHERE id = 'c'")).toEqual({ name: "10" });
  });

  it("DATABASE_SCHEMA puts Studio's tables in their own schema, created at the first migration", async () => {
    const admin = new PgStudioDb(url!);
    await admin.exec("DROP SCHEMA IF EXISTS studio_t CASCADE");
    const db = studioDbFromEnv({ DATABASE_URL: url!, DATABASE_SCHEMA: "studio_t" });
    try {
      expect(await migrateStudioDb(db)).toEqual(["0001_baseline.sql"]);
      const at = new Date().toISOString();
      await db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('s', 'S', ?, ?)", [at, at]);
      expect(await admin.get("SELECT COUNT(*) AS n FROM studio_t.teams")).toEqual({ n: 1 });
      expect(await admin.get("SELECT COUNT(*) AS n FROM public.teams WHERE id = 's'")).toEqual({ n: 0 });
      expect(() => studioDbFromEnv({ DATABASE_URL: url!, DATABASE_SCHEMA: "Bad-Name" })).toThrow(/DATABASE_SCHEMA/);
    } finally {
      await db.close();
      await admin.exec("DROP SCHEMA IF EXISTS studio_t CASCADE");
      await admin.close();
    }
  });

  it("a failed transaction leaves nothing and frees its connection", async () => {
    const at = new Date().toISOString();
    for (let i = 0; i < 15; i++) {
      await expect(api.tx(async () => {
        await api.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES (?, 'x', ?, ?)", [`f${i}`, at, at]);
        throw new Error("boom");
      })).rejects.toThrow("boom");
    }
    expect(await api.get("SELECT COUNT(*) AS n FROM teams WHERE id LIKE 'f%'")).toEqual({ n: 0 });
  });
});
