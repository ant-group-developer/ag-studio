import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JS one-off script
import { copySqliteToPg } from "../scripts/migrate-sqlite-to-pg.mjs";
import { testStudioDb, type PgliteStudioDb } from "../src/testing.js";
import { ROOT } from "./helpers.js";

/** An old `studio.db`: the SQLite schema of the root migrations/ (as the API last applied it), with a few rows. */
function oldStudioDb(): string {
  const file = join(mkdtempSync(join(tmpdir(), "sqlite-import-")), "studio.db");
  // as the old API opened it, but without foreign keys enforced so the file can hold orphans like an older one
  const lite = new DatabaseSync(file, { enableForeignKeyConstraints: false });
  const dir = join(ROOT, "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) lite.exec(readFileSync(join(dir, f), "utf8"));
  const at = "2026-10-10T08:00:00.000Z";
  const run = (sql: string, ...p: (string | number | null)[]) => lite.prepare(sql).run(...p);
  run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('t1', 'Team', ?, ?)", at, at);
  run("INSERT INTO projects (id, team_id, name, settings, owner_user_id, created_by, created_at, updated_at, voice) VALUES ('p1', 't1', 'P', '{\"style\":\"calm\"}', 'u1', 'u1', ?, ?, NULL)", at, at);
  run("INSERT INTO videos (id, project_id, idx, title, created_by, created_at, updated_at) VALUES ('v1', 'p1', 1, 'V', 'u1', ?, ?)", at, at);
  run("INSERT INTO agent_threads (id, project_id, video_id, kind, title, claude_session_id, session_started, use_lessons, created_by, created_at, updated_at) VALUES ('th1', 'p1', 'v1', 'video', 'Chat', 's1', 1, 0, 'u1', ?, ?)", at, at);
  run("INSERT INTO agent_messages (id, thread_id, seq, role, status, text, parts, cancel_requested, created_at, updated_at) VALUES ('m1', 'th1', 1, 'user', 'done', 'xin chào', NULL, 0, ?, ?)", at, at);
  run("INSERT INTO agent_messages (id, thread_id, seq, role, status, text, parts, cost_usd, created_at, updated_at) VALUES ('m2', 'th1', 2, 'assistant', 'done', 'chào', '[{\"type\":\"text\",\"text\":\"chào\"}]', 0.05, ?, ?)", at, at);
  // orphans: a message of a deleted thread, a job pointing at a deleted thread
  run("INSERT INTO agent_messages (id, thread_id, seq, role, status, created_at, updated_at) VALUES ('m3', 'gone', 1, 'user', 'done', ?, ?)", at, at);
  run("INSERT INTO project_jobs (id, project_id, thread_id, kind, status, title, request, cancel_requested, continue_agent, created_by, created_at, updated_at) VALUES ('j1', 'p1', 'gone', 'tts', 'done', 'TTS', '{}', 0, 1, 'u1', ?, ?)", at, at);
  run("INSERT INTO project_file_versions (id, project_id, path, sha256, size, author_kind, created_at) VALUES ('f1', 'p1', 'a.md', 'x', 3, 'user', ?)", at);
  run("INSERT INTO project_file_versions (id, project_id, path, sha256, size, author_kind, created_at) VALUES ('f2', 'p1', 'a.md', 'y', 4, 'agent', ?)", at);
  run("INSERT INTO studio_settings (key, value, updated_at, updated_by) VALUES ('claude_max_concurrent', '12', ?, 'u1')", at);
  run("INSERT INTO lease (stage_run_id, attempt_id, owner, expires_at, fencing_token) VALUES ('agent:x', 'a', 'agent:x', ?, 1)", at);
  run("INSERT INTO run (id, data, state, updated_at) VALUES ('r1', '{}', 'done', ?)", at);
  lite.close();
  return file;
}

describe("copySqliteToPg", () => {
  let db: PgliteStudioDb;
  afterEach(async () => { await db?.close(); });

  it("copies Studio's tables with Postgres types, drops orphans, skips legacy tables and live slots", async () => {
    db = await testStudioDb();
    const report = await copySqliteToPg(oldStudioDb(), db);
    const byTable = Object.fromEntries(report.tables.map((t: { table: string }) => [t.table, t]));
    expect(byTable.agent_messages).toMatchObject({ read: 3, copied: 2, dropped: 1, checked: 2 });
    expect(byTable.project_jobs).toMatchObject({ read: 1, copied: 1, nulled: 1 });
    expect(report.legacy).toEqual(expect.arrayContaining([{ table: "run", rows: 1 }]));
    expect(await db.get("SELECT session_started, use_lessons, created_at FROM agent_threads")).toEqual({ session_started: true, use_lessons: false, created_at: "2026-10-10T08:00:00.000Z" });
    expect(await db.get("SELECT parts, cost_usd FROM agent_messages WHERE id = 'm2'")).toEqual({ parts: [{ type: "text", text: "chào" }], cost_usd: 0.05 });
    expect(await db.get("SELECT thread_id, continue_agent FROM project_jobs")).toEqual({ thread_id: null, continue_agent: true });
    expect(await db.get("SELECT settings FROM projects")).toEqual({ settings: { style: "calm" } });
    expect(await db.get("SELECT value FROM studio_settings")).toEqual({ value: 12 });
    expect(await db.all("SELECT id, seq FROM project_file_versions ORDER BY seq")).toEqual([{ id: "f1", seq: 1 }, { id: "f2", seq: 2 }]);
    expect(await db.get("SELECT COUNT(*) AS n FROM lease")).toEqual({ n: 0 });
  });

  it("refuses a database that has rows, and --truncate replaces them", async () => {
    db = await testStudioDb();
    const file = oldStudioDb();
    await copySqliteToPg(file, db);
    await expect(copySqliteToPg(file, db)).rejects.toThrow(/already has rows/);
    await copySqliteToPg(file, db, { truncate: true });
    expect(await db.get("SELECT COUNT(*) AS n FROM agent_messages")).toEqual({ n: 2 });
  });

  it("writes nothing when a value does not fit its column", async () => {
    db = await testStudioDb();
    const file = oldStudioDb();
    const lite = new DatabaseSync(file);
    lite.prepare("UPDATE projects SET settings = 'not json'").run();
    lite.close();
    await expect(copySqliteToPg(file, db)).rejects.toThrow(/projects\.settings/);
    expect(await db.get("SELECT COUNT(*) AS n FROM teams")).toEqual({ n: 0 });
  });
});
