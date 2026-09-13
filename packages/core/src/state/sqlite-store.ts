import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ArtifactSchema, AttemptSchema, CheckResultSchema, ContentItemSchema, ContentVariantSchema, EventSchema, ExternalOperationSchema, HarnessError,
  LeaseSchema, RunSchema, SourceItemSchema, StageRunSchema,
  newId, type Artifact, type Attempt, type CheckResult, type ClaimParams, type ClaimResult, type Clock, type ContentItem, type ContentVariant,
  type Event, type EventInput, type ExternalOperation, type Lease, type ReapedLease, type Run, type SourceItem, type StageRun, type StateStore,
  type TransitionKind,
} from "@harness/contracts";
import { addSeconds, SystemClock } from "./clock.js";
import { assertTransition, STATE_FIELD_BY_KIND, TABLE_BY_KIND } from "./transitions.js";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "migrations");

type Row = { data: string };

export class SqliteStateStore implements StateStore {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  private depth = 0;

  constructor(dbPath: string, clock: Clock = new SystemClock()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.clock = clock;
  }

  migrate(migrationsDir: string): string[] {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const done = new Set(this.db.prepare("SELECT name FROM schema_migrations").all().map((r) => (r as { name: string }).name));
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      this.transaction(() => {
        this.db.exec(readFileSync(join(migrationsDir, f), "utf8"));
        this.db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(f, this.clock.now());
      });
      applied.push(f);
    }
    return applied;
  }

  listAppliedMigrations(): string[] {
    const table = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (!table) return [];
    return (this.db.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  }

  tableNames(): string[] {
    return this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => (r as { name: string }).name);
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      const sp = `sp_${this.depth}`;
      this.db.exec(`SAVEPOINT ${sp}`);
      this.depth++;
      try { const out = fn(); this.db.exec(`RELEASE SAVEPOINT ${sp}`); return out; }
      catch (e) { this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}`); this.db.exec(`RELEASE SAVEPOINT ${sp}`); throw e; }
      finally { this.depth--; }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try { const out = fn(); this.db.exec("COMMIT"); return out; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
    finally { this.depth = 0; }
  }

  /** True while a `transaction()` (or a nested savepoint) is open on this connection. Not part of the
   * `StateStore` contract — it exists so callers/tests can assert that a multi-step sequence really is
   * atomic (e.g. `submitGate`'s transition + targeted claim). */
  inTransaction(): boolean { return this.depth > 0; }

  close(): void { this.db.close(); }

  // ---- generic helpers ----
  private getDoc<T>(table: string, id: string, parse: (x: unknown) => T): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
    return row ? parse(JSON.parse(row.data)) : undefined;
  }
  private listDocs<T>(sql: string, params: (string | number)[], parse: (x: unknown) => T): T[] {
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => parse(JSON.parse(r.data)));
  }

  // ---- run ----
  insertRun(run: Run): void {
    const r = RunSchema.parse(run);
    this.db.prepare("INSERT INTO run (id, state, data, updated_at) VALUES (?, ?, ?, ?)").run(r.run_id, r.state, JSON.stringify(r), r.updated_at);
  }
  getRun(id: string): Run | undefined { return this.getDoc("run", id, (x) => RunSchema.parse(x)); }
  updateRun(run: Run): void {
    const r = RunSchema.parse(run);
    const res = this.db.prepare("UPDATE run SET data = ?, updated_at = ? WHERE id = ? AND state = ?").run(JSON.stringify(r), r.updated_at, r.run_id, r.state);
    if (res.changes === 0) throw new HarnessError("STALE_STATE", `run ${r.run_id} not in state ${r.state}`);
  }
  listRuns(filter: { state?: string; variant_id?: string } = {}): Run[] {
    const where: string[] = []; const params: string[] = [];
    if (filter.state) { where.push("state = ?"); params.push(filter.state); }
    if (filter.variant_id) { where.push("json_extract(data, '$.variant_id') = ?"); params.push(filter.variant_id); }
    return this.listDocs(`SELECT data FROM run${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY rowid`, params, (x) => RunSchema.parse(x));
  }

  // ---- stage_run ----
  insertStageRun(s: StageRun): void {
    const v = StageRunSchema.parse(s);
    this.db.prepare("INSERT INTO stage_run (id, run_id, state, data, updated_at) VALUES (?, ?, ?, ?, ?)").run(v.stage_run_id, v.run_id, v.state, JSON.stringify(v), v.updated_at);
  }
  getStageRun(id: string): StageRun | undefined { return this.getDoc("stage_run", id, (x) => StageRunSchema.parse(x)); }
  updateStageRun(s: StageRun): void {
    const v = StageRunSchema.parse(s);
    const res = this.db.prepare("UPDATE stage_run SET data = ?, updated_at = ? WHERE id = ? AND state = ?").run(JSON.stringify(v), v.updated_at, v.stage_run_id, v.state);
    if (res.changes === 0) throw new HarnessError("STALE_STATE", `stage_run ${v.stage_run_id} not in state ${v.state}`);
  }
  listStageRuns(runId: string): StageRun[] {
    return this.listDocs("SELECT data FROM stage_run WHERE run_id = ? ORDER BY rowid", [runId], (x) => StageRunSchema.parse(x));
  }

  // ---- attempt ----
  insertAttempt(a: Attempt): void {
    const v = AttemptSchema.parse(a);
    this.db.prepare("INSERT INTO attempt (id, stage_run_id, state, fencing_token, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(v.attempt_id, v.stage_run_id, v.state, v.fencing_token, JSON.stringify(v), v.updated_at);
  }
  getAttempt(id: string): Attempt | undefined { return this.getDoc("attempt", id, (x) => AttemptSchema.parse(x)); }
  updateAttempt(a: Attempt): void {
    const v = AttemptSchema.parse(a);
    const res = this.db.prepare("UPDATE attempt SET data = ?, updated_at = ? WHERE id = ? AND state = ?").run(JSON.stringify(v), v.updated_at, v.attempt_id, v.state);
    if (res.changes === 0) throw new HarnessError("STALE_STATE", `attempt ${v.attempt_id} not in state ${v.state}`);
  }
  listAttempts(stageRunId: string): Attempt[] {
    return this.listDocs("SELECT data FROM attempt WHERE stage_run_id = ? ORDER BY fencing_token", [stageRunId], (x) => AttemptSchema.parse(x));
  }

  // ---- artifact ----
  insertArtifact(a: Artifact): void {
    const v = ArtifactSchema.parse(a);
    this.db.prepare("INSERT INTO artifact (id, run_id, stage_run_id, state, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(v.artifact_id, v.run_id, v.stage_run_id, v.status, JSON.stringify(v), v.updated_at);
  }
  getArtifact(id: string): Artifact | undefined { return this.getDoc("artifact", id, (x) => ArtifactSchema.parse(x)); }
  listArtifacts(filter: { stage_run_id?: string; run_id?: string; status?: string }): Artifact[] {
    const where: string[] = []; const params: string[] = [];
    if (filter.stage_run_id) { where.push("stage_run_id = ?"); params.push(filter.stage_run_id); }
    if (filter.run_id) { where.push("run_id = ?"); params.push(filter.run_id); }
    if (filter.status) { where.push("state = ?"); params.push(filter.status); }
    const sql = `SELECT data FROM artifact${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id`;
    return this.listDocs(sql, params, (x) => ArtifactSchema.parse(x));
  }

  // ---- external_operation ----
  insertExternalOperation(op: ExternalOperation): void {
    const v = ExternalOperationSchema.parse(op);
    this.db.prepare("INSERT INTO external_operation (id, idempotency_key, state, data, updated_at) VALUES (?, ?, ?, ?, ?)").run(v.operation_id, v.idempotency_key, v.status, JSON.stringify(v), v.updated_at);
  }
  getExternalOperation(id: string): ExternalOperation | undefined { return this.getDoc("external_operation", id, (x) => ExternalOperationSchema.parse(x)); }
  findExternalOperationByKey(key: string): ExternalOperation | undefined {
    // idempotency_key is not unique: a retry after a FAILED operation records a fresh row with the
    // same key, so the most recently inserted row for a key is the current one.
    const row = this.db.prepare("SELECT data FROM external_operation WHERE idempotency_key = ? ORDER BY rowid DESC LIMIT 1").get(key) as Row | undefined;
    return row ? ExternalOperationSchema.parse(JSON.parse(row.data)) : undefined;
  }
  updateExternalOperation(op: ExternalOperation): void {
    const v = ExternalOperationSchema.parse(op);
    const res = this.db.prepare("UPDATE external_operation SET data = ?, updated_at = ? WHERE id = ? AND state = ?").run(JSON.stringify(v), v.updated_at, v.operation_id, v.status);
    if (res.changes === 0) throw new HarnessError("STALE_STATE", `external_operation ${v.operation_id} not in status ${v.status}`);
  }
  listExternalOperations(filter: { stage_run_id?: string; status?: string }): ExternalOperation[] {
    const where: string[] = []; const params: string[] = [];
    if (filter.stage_run_id) { where.push("json_extract(data, '$.stage_run_id') = ?"); params.push(filter.stage_run_id); }
    if (filter.status) { where.push("state = ?"); params.push(filter.status); }
    return this.listDocs(`SELECT data FROM external_operation${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id`, params, (x) => ExternalOperationSchema.parse(x));
  }

  // ---- check_result ----
  insertCheckResult(c: CheckResult): void {
    const v = CheckResultSchema.parse(c);
    this.db.prepare("INSERT INTO check_result (id, attempt_id, data) VALUES (?, ?, ?)").run(v.check_result_id, v.attempt_id, JSON.stringify(v));
  }
  listCheckResults(attemptId: string): CheckResult[] {
    return this.listDocs("SELECT data FROM check_result WHERE attempt_id = ? ORDER BY id", [attemptId], (x) => CheckResultSchema.parse(x));
  }

  // ---- catalog ----
  insertSourceItem(s: SourceItem): void {
    const v = SourceItemSchema.parse(s);
    this.db.prepare("INSERT INTO source_item (id, checksum, collection, data, updated_at) VALUES (?, ?, ?, ?, ?)").run(v.source_id, v.checksum, v.collection, JSON.stringify(v), v.ingested_at);
  }
  getSourceItem(id: string): SourceItem | undefined { return this.getDoc("source_item", id, (x) => SourceItemSchema.parse(x)); }
  findSourceItemByChecksum(checksum: string): SourceItem | undefined {
    const row = this.db.prepare("SELECT data FROM source_item WHERE checksum = ? ORDER BY rowid LIMIT 1").get(checksum) as Row | undefined;
    return row ? SourceItemSchema.parse(JSON.parse(row.data)) : undefined;
  }
  listSourceItems(filter: { collection?: string } = {}): SourceItem[] {
    return filter.collection
      ? this.listDocs("SELECT data FROM source_item WHERE collection = ? ORDER BY rowid", [filter.collection], (x) => SourceItemSchema.parse(x))
      : this.listDocs("SELECT data FROM source_item ORDER BY rowid", [], (x) => SourceItemSchema.parse(x));
  }
  insertContentItem(c: ContentItem): void {
    const v = ContentItemSchema.parse(c);
    this.db.prepare("INSERT INTO content_item (id, data, updated_at) VALUES (?, ?, ?)").run(v.content_id, JSON.stringify(v), v.created_at);
  }
  getContentItem(id: string): ContentItem | undefined { return this.getDoc("content_item", id, (x) => ContentItemSchema.parse(x)); }
  updateContentItem(c: ContentItem): void {
    const v = ContentItemSchema.parse(c);
    const res = this.db.prepare("UPDATE content_item SET data = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(v), this.clock.now(), v.content_id);
    if (res.changes === 0) throw new HarnessError("NOT_FOUND", `content_item ${v.content_id} not found`);
  }
  listContentItems(): ContentItem[] { return this.listDocs("SELECT data FROM content_item ORDER BY rowid", [], (x) => ContentItemSchema.parse(x)); }
  private variantKey(k: { content_id: string; profile_id: string; profile_revision: number; options_digest: string }): string {
    return `${k.content_id}|${k.profile_id}@${k.profile_revision}|${k.options_digest}`;
  }
  insertContentVariant(variant: ContentVariant): void {
    const v = ContentVariantSchema.parse(variant);
    this.db.prepare("INSERT INTO content_variant (id, content_id, profile_id, variant_key, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(v.variant_id, v.content_id, v.profile_id, this.variantKey(v), JSON.stringify(v), v.created_at);
  }
  getContentVariant(id: string): ContentVariant | undefined { return this.getDoc("content_variant", id, (x) => ContentVariantSchema.parse(x)); }
  findContentVariant(key: { content_id: string; profile_id: string; profile_revision: number; options_digest: string }): ContentVariant | undefined {
    const row = this.db.prepare("SELECT data FROM content_variant WHERE variant_key = ?").get(this.variantKey(key)) as Row | undefined;
    return row ? ContentVariantSchema.parse(JSON.parse(row.data)) : undefined;
  }
  listContentVariants(contentId: string): ContentVariant[] {
    return this.listDocs("SELECT data FROM content_variant WHERE content_id = ? ORDER BY rowid", [contentId], (x) => ContentVariantSchema.parse(x));
  }

  // ---- resources ----
  countLeasedResources(): Record<string, number> {
    const held: Record<string, number> = {};
    for (const r of this.db.prepare("SELECT resources FROM lease").all() as { resources: string }[]) {
      for (const name of JSON.parse(r.resources) as string[]) held[name] = (held[name] ?? 0) + 1;
    }
    return held;
  }

  // ---- event ----
  appendEvent(input: EventInput): Event {
    const e = EventSchema.parse({ ...input, schema_version: "harness.event/v1", event_id: newId("event"), occurred_at: this.clock.now() });
    this.db.prepare("INSERT INTO event (id, run_id, occurred_at, event_type, data) VALUES (?, ?, ?, ?, ?)").run(e.event_id, e.run_id, e.occurred_at, e.event_type, JSON.stringify(e));
    return e;
  }
  listEvents(filter: { run_id?: string; limit?: number; newest?: boolean }): Event[] {
    const limit = filter.limit ?? 1000;
    const order = filter.newest ? "occurred_at DESC, id DESC" : "occurred_at, id";
    const rows = filter.run_id
      ? this.listDocs(`SELECT data FROM event WHERE run_id = ? ORDER BY ${order} LIMIT ?`, [filter.run_id, limit], (x) => EventSchema.parse(x))
      : this.listDocs(`SELECT data FROM event ORDER BY ${order} LIMIT ?`, [limit], (x) => EventSchema.parse(x));
    return filter.newest ? rows.reverse() : rows;
  }

  // ---- implemented in Task 5 and 6 ----
  transition(kind: TransitionKind, id: string, expectedFrom: string, to: string, event: EventInput): void {
    assertTransition(kind, expectedFrom, to);
    this.transaction(() => {
      const table = TABLE_BY_KIND[kind];
      const field = STATE_FIELD_BY_KIND[kind];
      const now = this.clock.now();
      const res = this.db
        .prepare(`UPDATE ${table} SET state = ?, data = json_set(data, '$.${field}', ?, '$.updated_at', ?), updated_at = ? WHERE id = ? AND state = ?`)
        .run(to, to, now, now, id, expectedFrom);
      if (res.changes === 0) throw new HarnessError("STALE_STATE", `${kind} ${id} not in state ${expectedFrom}`, { kind, id, expectedFrom, to });
      this.appendEvent({ ...event, payload: { ...event.payload, from: expectedFrom, to } });
    });
  }
  private eventBase(stage: StageRun, attemptId: string | null): Omit<EventInput, "event_type" | "severity" | "payload"> {
    return { run_id: stage.run_id, stage_run_id: stage.stage_run_id, attempt_id: attemptId, project_id: null, portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null };
  }

  claim(params: ClaimParams): ClaimResult | undefined {
    return this.transaction(() => {
      // rowid (insertion order), not id (a non-monotonic ULID), breaks ties: two stages can share a
      // ready_at and be seeded within the same millisecond, so the id string order is not reliable.
      const rows = params.stageRunId
        ? (this.db.prepare("SELECT data FROM stage_run WHERE state = 'READY' AND id = ?").all(params.stageRunId) as Row[])
        : (this.db.prepare("SELECT data FROM stage_run WHERE state = 'READY' ORDER BY json_extract(data, '$.ready_at'), rowid LIMIT 100").all() as Row[]);
      const held = this.countLeasedResources();
      const cap = params.resourceCapacity ?? {};
      for (const row of rows) {
        const stage = StageRunSchema.parse(JSON.parse(row.data));
        if (stage.not_before && stage.not_before > params.now) continue;
        if (!stage.required_capabilities.every((c) => params.capabilities.includes(c))) continue;
        if (stage.requires_resources.some((r) => (held[r] ?? 0) >= (cap[r] ?? 0))) continue; // no free slot for a required resource
        const res = this.db.prepare("UPDATE stage_run SET state = 'CLAIMED' WHERE id = ? AND state = 'READY'").run(stage.stage_run_id);
        if (res.changes === 0) continue;
        const now = this.clock.now();
        const token = (this.db.prepare("SELECT COALESCE(MAX(fencing_token), 0) + 1 AS t FROM attempt WHERE stage_run_id = ?").get(stage.stage_run_id) as { t: number }).t;
        const claimed: StageRun = { ...stage, state: "CLAIMED", attempt_count: stage.attempt_count + 1, updated_at: now };
        this.db.prepare("UPDATE stage_run SET data = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(claimed), now, stage.stage_run_id);
        const attempt: Attempt = {
          schema_version: "harness.attempt/v1", attempt_id: newId("attempt"), stage_run_id: stage.stage_run_id, run_id: stage.run_id,
          lease_owner: params.owner, fencing_token: token, state: "CLAIMED", started_at: now, created_at: now, updated_at: now,
        };
        this.insertAttempt(attempt);
        const lease: Lease = { stage_run_id: stage.stage_run_id, attempt_id: attempt.attempt_id, owner: params.owner, expires_at: addSeconds(now, params.leaseSeconds), fencing_token: token, resources: stage.requires_resources };
        this.db.prepare("INSERT OR REPLACE INTO lease (stage_run_id, attempt_id, owner, expires_at, fencing_token, resources) VALUES (?, ?, ?, ?, ?, ?)").run(lease.stage_run_id, lease.attempt_id, lease.owner, lease.expires_at, lease.fencing_token, JSON.stringify(lease.resources));
        const run = this.getRun(stage.run_id);
        if (run?.state === "READY") this.transition("run", run.run_id, "READY", "RUNNING", { ...this.eventBase(stage, null), stage_run_id: null, severity: "info", event_type: "run.started", payload: {} });
        this.appendEvent({ ...this.eventBase(stage, attempt.attempt_id), severity: "info", event_type: "attempt.claimed", payload: { owner: params.owner, fencing_token: token } });
        return { stageRun: claimed, attempt, lease };
      }
      return undefined;
    });
  }

  heartbeat(attemptId: string, fencingToken: number, newExpiresAt: string): boolean {
    return this.db.prepare("UPDATE lease SET expires_at = ? WHERE attempt_id = ? AND fencing_token = ?").run(newExpiresAt, attemptId, fencingToken).changes === 1;
  }

  getLease(stageRunId: string): Lease | undefined {
    const row = this.db.prepare("SELECT stage_run_id, attempt_id, owner, expires_at, fencing_token, resources FROM lease WHERE stage_run_id = ?").get(stageRunId) as { resources: string } | undefined;
    return row ? LeaseSchema.parse({ ...row, resources: JSON.parse(row.resources) }) : undefined;
  }

  releaseLease(stageRunId: string, fencingToken: number): void {
    this.db.prepare("DELETE FROM lease WHERE stage_run_id = ? AND fencing_token = ?").run(stageRunId, fencingToken);
  }

  assertFencing(stageRunId: string, fencingToken: number): void {
    const lease = this.getLease(stageRunId);
    if (!lease || lease.fencing_token !== fencingToken) {
      throw new HarnessError("FENCING_REJECTED", `fencing token ${fencingToken} is not current for ${stageRunId}`, { stageRunId, fencingToken, current: lease?.fencing_token ?? null });
    }
  }

  reapExpiredLeases(now: string): ReapedLease[] {
    return this.transaction(() => {
      const expired = (this.db.prepare("SELECT stage_run_id, attempt_id, owner, expires_at, fencing_token, resources FROM lease WHERE expires_at < ?").all(now) as { resources: string }[]).map((r) => LeaseSchema.parse({ ...r, resources: JSON.parse(r.resources) }));
      const out: ReapedLease[] = [];
      for (const lease of expired) {
        this.db.prepare("DELETE FROM lease WHERE stage_run_id = ? AND fencing_token = ?").run(lease.stage_run_id, lease.fencing_token);
        const attempt = this.getAttempt(lease.attempt_id);
        const stage = this.getStageRun(lease.stage_run_id);
        if (!attempt || !stage) continue;
        if (attempt.state === "CLAIMED" || attempt.state === "RUNNING") {
          this.transition("attempt", attempt.attempt_id, attempt.state, "ABANDONED", { ...this.eventBase(stage, attempt.attempt_id), severity: "warn", event_type: "attempt.abandoned", payload: { owner: lease.owner } });
        }
        if (stage.state === "CANCEL_REQUESTED") {
          // the worker that owed the acknowledgement is gone: the reaper completes the cancel, never requeues
          this.transition("stage_run", stage.stage_run_id, "CANCEL_REQUESTED", "CANCELLED", { ...this.eventBase(stage, attempt.attempt_id), severity: "warn", event_type: "stage.cancelled", payload: { requeued: false, reason: "lease_expired" } });
          out.push({ stage_run_id: stage.stage_run_id, run_id: stage.run_id, attempt_id: attempt.attempt_id, owner: lease.owner, requeued: false });
          continue;
        }
        const active = ["CLAIMED", "RUNNING", "VERIFYING"].includes(stage.state);
        const canRetry = active && stage.retry.retry_on.includes("abandoned") && stage.attempt_count < stage.retry.max_attempts;
        if (active) {
          const next = canRetry ? "READY" : "FAILED";
          this.transition("stage_run", stage.stage_run_id, stage.state, next, { ...this.eventBase(stage, attempt.attempt_id), severity: "warn", event_type: "stage.lease_expired", payload: { requeued: canRetry } });
          const fresh = this.getStageRun(stage.stage_run_id)!;
          this.updateStageRun({ ...fresh, last_failure_kind: "abandoned", ready_at: now, not_before: now });
        }
        out.push({ stage_run_id: stage.stage_run_id, run_id: stage.run_id, attempt_id: attempt.attempt_id, owner: lease.owner, requeued: canRetry });
      }
      return out;
    });
  }
}
