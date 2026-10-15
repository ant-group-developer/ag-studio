import { afterEach, describe, expect, it } from "vitest";
import { migrateStudioDb, pendingMigrations, pgTimestampToIso, toPgPlaceholders } from "../src/index.js";
import { testStudioDb, type PgliteStudioDb } from "../src/testing.js";

describe("toPgPlaceholders", () => {
  it("numbers ? outside strings, quoted names and comments", () => {
    expect(toPgPlaceholders("SELECT * FROM t WHERE a = ? AND b = '?' AND \"c?\" = ? -- why?\nAND d = ?"))
      .toBe("SELECT * FROM t WHERE a = $1 AND b = '?' AND \"c?\" = $2 -- why?\nAND d = $3");
  });
  it("keeps doubled quotes inside a string", () => {
    expect(toPgPlaceholders("SELECT 'it''s ?', ?")).toBe("SELECT 'it''s ?', $1");
  });
});

describe("pgTimestampToIso", () => {
  it("turns Postgres text into the ISO the code writes", () => {
    expect(pgTimestampToIso("2026-10-14 17:20:30.123456+07")).toBe("2026-10-14T10:20:30.123Z");
    expect(pgTimestampToIso("2026-10-14 10:20:30+00")).toBe("2026-10-14T10:20:30.000Z");
    expect(pgTimestampToIso("2026-10-14 10:20:30.5-03:30")).toBe("2026-10-14T13:50:30.500Z");
  });
});

describe("StudioDb on Postgres (PGlite)", () => {
  let db: PgliteStudioDb;
  afterEach(async () => { await db?.close(); });

  it("comes migrated, and migrating again does nothing", async () => {
    db = await testStudioDb();
    expect(await pendingMigrations(db)).toEqual([]);
    expect(await migrateStudioDb(db)).toEqual([]);
  });

  it("round-trips timestamps, jsonb, booleans and bigints in the shapes the code uses", async () => {
    db = await testStudioDb();
    const at = "2026-10-14T10:20:30.123Z";
    await db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", ["t1", "T", at, at]);
    await db.run("INSERT INTO user_prefs (user_id, prefs, updated_at) VALUES (?, ?, ?)", ["u1", JSON.stringify({ tour: true, n: [1, 2] }), at]);
    await db.run("INSERT INTO studio_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)", ["k", JSON.stringify(20), at, "u1"]);
    expect(await db.get("SELECT created_at FROM teams WHERE id = ?", ["t1"])).toEqual({ created_at: at });
    expect(await db.get("SELECT prefs FROM user_prefs")).toEqual({ prefs: { tour: true, n: [1, 2] } });
    expect(await db.get("SELECT value FROM studio_settings")).toEqual({ value: 20 });
    expect(await db.get("SELECT COUNT(*) AS n FROM teams")).toEqual({ n: 1 });
    expect(await db.get("SELECT created_at < ? AS before FROM teams", ["2026-10-15T00:00:00.000Z"])).toEqual({ before: true });
  });

  it("run answers the rows changed", async () => {
    db = await testStudioDb();
    const at = new Date().toISOString();
    await db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)", ["a", "A", at, at, "b", "B", at, at]);
    expect(await db.run("UPDATE teams SET name = ?", ["X"])).toEqual({ changes: 2 });
  });

  it("tx rolls everything back when it throws, and nested tx joins the open one", async () => {
    db = await testStudioDb();
    const at = new Date().toISOString();
    await expect(db.tx(async () => {
      await db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", ["a", "A", at, at]);
      await db.tx(async () => { await db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", ["b", "B", at, at]); });
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(await db.all("SELECT id FROM teams")).toEqual([]);
    await db.tx(async () => {
      expect(db.inTx).toBe(true);
      await db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", ["c", "C", at, at]);
    });
    expect(await db.all("SELECT id FROM teams")).toEqual([{ id: "c" }]);
  });

  it("transactions run one after another", async () => {
    db = await testStudioDb();
    const at = new Date().toISOString();
    await db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", ["a", "0", at, at]);
    const bump = () => db.tx(async () => {
      const r = await db.get<{ name: string }>("SELECT name FROM teams WHERE id = 'a'");
      await new Promise((ok) => setTimeout(ok, 5));
      await db.run("UPDATE teams SET name = ? WHERE id = 'a'", [String(Number(r!.name) + 1)]);
    });
    await Promise.all([bump(), bump(), bump(), bump()]);
    expect(await db.get("SELECT name FROM teams WHERE id = 'a'")).toEqual({ name: "4" });
  });
});
