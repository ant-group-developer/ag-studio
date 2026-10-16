#!/usr/bin/env node
/**
 * One-off: copies Studio's data from the old SQLite `studio.db` into the Postgres database (DATABASE_URL).
 *
 *   DATABASE_URL=postgresql://… node packages/studio-engine/scripts/migrate-sqlite-to-pg.mjs /path/studio.db [--truncate]
 *
 * - Opens the SQLite file read-only (keep its -wal beside it); never writes to it.
 * - Migrates Postgres to the latest schema, then copies the tables Studio uses, parents first, in one transaction:
 *   0/1 → boolean, JSON text → jsonb, ISO text → timestamptz. `seq`/`ord` identity columns follow the old rowid order.
 * - Rows whose parent is gone (SQLite never enforced foreign keys) are dropped when the parent's delete would have
 *   cascaded, or get NULL when it would have set null; the report counts them.
 * - Refuses a database that already has rows, unless --truncate (empties Studio's tables first).
 * - Checks afterwards: row counts per table, and up to 20 rows per table compared column by column.
 * Tables of the legacy harness CLI are not copied; the report lists those that hold rows (they stay in the file).
 * Needs the built engine (dist/) for the CLI; tests import copySqliteToPg directly.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Copy order: every table after the tables it references. `lease` (live Claude slots) starts empty. */
export const TABLE_ORDER = [
  "teams", "team_members", "team_skills",
  "projects", "videos", "video_revisions",
  "project_sources", "prepared_assets", "project_file_versions", "step_marks",
  "agent_threads", "thread_refs", "thread_summaries", "agent_messages", "agent_actions", "lesson_proposals",
  "project_jobs", "project_farm_jobs", "sign_audit_log",
  "llm_calls", "audit_log", "ag_go_usage_outbox",
  "studio_settings", "user_prefs", "music_track", "studio_voice_lines", "youtube_cache",
];
const ALL_STUDIO_TABLES = [...TABLE_ORDER, "lease"];

const qi = (name) => `"${name.replace(/"/g, '""')}"`;

async function pgSchema(db) {
  const cols = await db.all(
    `SELECT table_name, column_name, data_type, is_nullable, is_identity FROM information_schema.columns
     WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`);
  const fks = await db.all(
    `SELECT tc.table_name AS child, kcu.column_name AS col, ccu.table_name AS parent, ccu.column_name AS pcol, rc.delete_rule AS rule
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
     JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
     JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema()`);
  const pks = await db.all(
    `SELECT tc.table_name AS t, kcu.column_name AS col FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = current_schema() ORDER BY kcu.ordinal_position`);
  const tables = new Map();
  for (const c of cols) {
    if (!tables.has(c.table_name)) tables.set(c.table_name, { cols: [], fks: [], pk: [] });
    tables.get(c.table_name).cols.push({ name: c.column_name, type: c.data_type, nullable: c.is_nullable === "YES", identity: c.is_identity === "YES" });
  }
  for (const f of fks) tables.get(f.child)?.fks.push(f);
  for (const p of pks) tables.get(p.t)?.pk.push(p.col);
  return tables;
}

/** A SQLite value as the Postgres column wants it; throws a message for a value that does not fit. */
function convert(v, col) {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") v = Number(v);
  switch (col.type) {
    case "boolean": return Boolean(Number(v));
    case "jsonb": {
      if (v === "") return null;
      const text = typeof v === "string" ? v : JSON.stringify(v);
      JSON.parse(text);
      return text;
    }
    case "timestamp with time zone": {
      if (v === "") return null;
      if (Number.isNaN(Date.parse(String(v)))) throw new Error(`not a time: ${String(v).slice(0, 40)}`);
      return String(v);
    }
    case "integer": case "bigint": case "smallint": case "double precision": case "real": case "numeric": {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`not a number: ${String(v).slice(0, 40)}`);
      return n;
    }
    default: return typeof v === "string" ? v : String(v);
  }
}

function same(pgValue, value, col) {
  if (value === null || pgValue === null) return value === pgValue;
  if (col.type === "jsonb") return JSON.stringify(sortKeys(pgValue)) === JSON.stringify(sortKeys(JSON.parse(value)));
  if (col.type === "timestamp with time zone") return Date.parse(pgValue) === Date.parse(value);
  if (col.type === "double precision" || col.type === "real") return Math.abs(Number(pgValue) - Number(value)) < 1e-9;
  return pgValue === value;
}
function sortKeys(x) {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys(x[k])]));
  return x;
}

/**
 * Copies `sqlitePath` into `db` (a migrated StudioDb). Answers the report; throws (nothing written) on a value that
 * does not fit its column, or when `db` already has rows and `truncate` is not set.
 */
export async function copySqliteToPg(sqlitePath, db, { truncate = false, log = () => {} } = {}) {
  const lite = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const liteTables = new Set(lite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const schema = await pgSchema(db);
    const report = { tables: [], legacy: [] };
    await db.tx(async () => {
      if (truncate) await db.exec(`TRUNCATE ${ALL_STUDIO_TABLES.map(qi).join(", ")} RESTART IDENTITY CASCADE`);
      for (const t of ALL_STUDIO_TABLES) {
        const has = await db.get(`SELECT 1 AS x FROM ${qi(t)} LIMIT 1`);
        if (has) throw new Error(`Postgres table ${t} already has rows (run again with --truncate to replace them)`);
      }
      const kept = new Map(); // "table.column" → Set of values copied (for children's foreign keys)
      const keep = (t, c, v) => { const k = `${t}.${c}`; if (!kept.has(k)) kept.set(k, new Set()); kept.get(k).add(v); };
      const errors = [];
      for (const t of TABLE_ORDER) {
        const info = schema.get(t);
        if (!info) throw new Error(`Postgres has no table ${t}: is the schema migrated?`);
        const entry = { table: t, read: 0, copied: 0, dropped: 0, nulled: 0, missing: !liteTables.has(t) };
        report.tables.push(entry);
        if (entry.missing) continue;
        const liteCols = new Set(lite.prepare(`PRAGMA table_info(${qi(t)})`).all().map((c) => c.name));
        const cols = info.cols.filter((c) => !c.identity && liteCols.has(c.name));
        const parentCols = new Set(TABLE_ORDER.flatMap((x) => (schema.get(x)?.fks ?? []).filter((f) => f.parent === t).map((f) => f.pcol)));
        const rows = [];
        for (const raw of lite.prepare(`SELECT * FROM ${qi(t)} ORDER BY rowid`).all()) {
          entry.read++;
          const row = {};
          let drop = false;
          for (const c of cols) {
            try { row[c.name] = convert(raw[c.name], c); } catch (e) { errors.push(`${t}.${c.name} (row ${entry.read}): ${e.message}`); }
          }
          for (const f of info.fks) {
            const v = row[f.col];
            if (v === null || v === undefined || kept.get(`${f.parent}.${f.pcol}`)?.has(v)) continue;
            if (f.rule === "SET NULL") { row[f.col] = null; entry.nulled++; } else { drop = true; }
          }
          if (drop) { entry.dropped++; continue; }
          for (const c of cols) if (row[c.name] === null && !c.nullable) errors.push(`${t}.${c.name} (row ${entry.read}): empty but required`);
          for (const c of parentCols) if (row[c] !== null && row[c] !== undefined) keep(t, c, row[c]);
          rows.push(row);
        }
        if (errors.length) continue;
        const per = Math.max(1, Math.floor(30000 / Math.max(1, cols.length)));
        for (let i = 0; i < rows.length; i += per) {
          const chunk = rows.slice(i, i + per);
          const values = chunk.map(() => `(${cols.map(() => "?").join(", ")})`).join(", ");
          await db.run(`INSERT INTO ${qi(t)} (${cols.map((c) => qi(c.name)).join(", ")}) VALUES ${values}`, chunk.flatMap((r) => cols.map((c) => r[c.name])));
        }
        entry.copied = rows.length;
        log(`${t}: ${entry.copied}/${entry.read}${entry.dropped ? `, ${entry.dropped} orphan(s) dropped` : ""}${entry.nulled ? `, ${entry.nulled} link(s) set null` : ""}`);
      }
      if (errors.length) throw new Error(`values that do not fit (nothing copied):\n  ${errors.slice(0, 30).join("\n  ")}${errors.length > 30 ? `\n  … ${errors.length - 30} more` : ""}`);
      await verify(lite, db, schema, report);
    });
    for (const t of [...liteTables].filter((n) => !ALL_STUDIO_TABLES.includes(n) && n !== "schema_migrations" && !n.startsWith("sqlite_")).sort()) {
      const n = lite.prepare(`SELECT COUNT(*) AS c FROM ${qi(t)}`).get().c;
      if (n > 0) report.legacy.push({ table: t, rows: Number(n) });
    }
    return report;
  } finally {
    lite.close();
  }
}

/** Counts per table, and up to 20 rows per table read back and compared with the SQLite values. */
async function verify(lite, db, schema, report) {
  for (const entry of report.tables) {
    if (entry.missing) continue;
    const n = (await db.get(`SELECT COUNT(*) AS n FROM ${qi(entry.table)}`)).n;
    if (n !== entry.copied) throw new Error(`check failed: ${entry.table} has ${n} rows in Postgres, ${entry.copied} were copied`);
    const info = schema.get(entry.table);
    if (!info.pk.length || !entry.copied) continue;
    const liteCols = new Set(lite.prepare(`PRAGMA table_info(${qi(entry.table)})`).all().map((c) => c.name));
    const cols = info.cols.filter((c) => !c.identity && liteCols.has(c.name));
    const sample = await db.all(`SELECT * FROM ${qi(entry.table)} ORDER BY random() LIMIT 20`);
    for (const pgRow of sample) {
      const raw = lite.prepare(`SELECT * FROM ${qi(entry.table)} WHERE ${info.pk.map((c) => `${qi(c)} = ?`).join(" AND ")}`).get(...info.pk.map((c) => pgRow[c]));
      if (!raw) throw new Error(`check failed: ${entry.table} row ${info.pk.map((c) => pgRow[c]).join("/")} is not in SQLite`);
      for (const c of cols) {
        const fk = info.fks.find((f) => f.col === c.name && f.rule === "SET NULL");
        if (fk && pgRow[c.name] === null) continue;
        if (!same(pgRow[c.name], convert(raw[c.name], c), c)) throw new Error(`check failed: ${entry.table}.${c.name} differs for ${info.pk.map((k) => pgRow[k]).join("/")}`);
      }
    }
    entry.checked = sample.length;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file || !existsSync(file)) {
    process.stderr.write("usage: DATABASE_URL=postgresql://… node migrate-sqlite-to-pg.mjs /path/studio.db [--truncate]\n");
    process.exit(2);
  }
  const { migrateStudioDb, studioDbFromEnv } = await import("../dist/index.js");
  const db = studioDbFromEnv();
  try {
    const applied = await migrateStudioDb(db);
    if (applied.length) process.stdout.write(`schema: applied ${applied.join(", ")}\n`);
    const report = await copySqliteToPg(file, db, { truncate: args.includes("--truncate"), log: (l) => process.stdout.write(`  ${l}\n`) });
    const total = report.tables.reduce((s, t) => s + t.copied, 0);
    process.stdout.write(`\ncopied ${total} rows into ${report.tables.filter((t) => !t.missing).length} tables; counts and samples checked\n`);
    const missing = report.tables.filter((t) => t.missing).map((t) => t.table);
    if (missing.length) process.stdout.write(`not in the SQLite file (left empty): ${missing.join(", ")}\n`);
    if (report.legacy.length) process.stdout.write(`not copied (legacy tables, still in ${file}): ${report.legacy.map((l) => `${l.table} ${l.rows}`).join(", ")}\n`);
  } finally {
    await db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { process.stderr.write(`migrate-sqlite-to-pg: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
}
