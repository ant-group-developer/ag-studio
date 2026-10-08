/**
 * Call log and training dataset (migration 0013): every Claude call of a stage, and what a person did with the
 * model's answer. The index lives in `llm_calls` / `human_edits`; a call's full content (prompt, raw answer,
 * structured JSON) is one gzip JSON object in the Studio bucket, because a plan prompt carries the whole catalog.
 */
import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { StudioLlmCall } from "@harness/executors";
import type { StudioBucket } from "./bucket.js";
import { episodeForRun, getEpisode, productionForRun, type StudioDb } from "./studio-db.js";

export const LLM_CALL_PAYLOAD_SCHEMA = "studio.llm-call/v1";

export interface LlmCallRow {
  id: string; created_at: string; source: string; production_id: string | null; episode_id: string | null;
  run_id: string; stage_key: string; attempt_id: string; skill: string; model: string; round: number;
  outcome: StudioLlmCall["outcome"]; problems: string; input_tokens: number | null; output_tokens: number | null;
  cost_usd: number; wall_seconds: number; payload_key: string | null;
}

export interface LlmCallPayload {
  schema: typeof LLM_CALL_PAYLOAD_SCHEMA;
  id: string; created_at: string; source: LlmCallSource;
  production_id: string | null; episode_id: string | null; run_id: string; stage_key: string; attempt_id: string;
  skill: string; round: number; outcome: StudioLlmCall["outcome"];
  problems: StudioLlmCall["problems"]; warnings: StudioLlmCall["warnings"];
  model: string; prompt: string; json_schema: string | null; response: string; structured_output: unknown;
  exit_code: number | null; timed_out: boolean; wall_seconds: number; cost_usd: number;
  input_tokens: number | null; output_tokens: number | null;
}

/** `claude`: a stage's call; `claude-chat`: a chat reply (spec local-chat §3.1). */
export type LlmCallSource = "claude" | "claude-chat";

/** `rnd` / `branding`: approved at their gate (before = Claude's proposal); `*_edit`: changed by hand after approval. */
export type HumanEditKind = "trend_report" | "series_plan" | "youtube_kit" | "episode_rerender" | "episode_cancel" | "rnd" | "branding" | "rnd_edit" | "branding_edit" | "thumbnail"
  // shot-cut episodes (phase 5): the scene selection and the edit plan approved at their gates
  | "survey" | "edit_plan"
  // audio the person gave a production, or narration declined (plan optional-audio)
  | "voice" | "music";

export interface HumanEditRow {
  id: string; created_at: string; user_id: string; production_id: string; episode_id: string | null;
  kind: HumanEditKind; llm_call_id: string | null; changed: number; before: string | null; after: string | null;
}

/** `llm-logs/claude/2026/10/01/<id>.json.gz` */
function payloadKey(id: string, at: string): string {
  return `llm-logs/claude/${at.slice(0, 4)}/${at.slice(5, 7)}/${at.slice(8, 10)}/${id}.json.gz`;
}

/** Production / episode of a run: an episode run, else the plan run of a production. */
function ownersOfRun(db: StudioDb, runId: string): { production_id: string | null; episode_id: string | null } {
  const ep = episodeForRun(db, runId);
  if (ep) return { production_id: ep.production_id, episode_id: ep.id };
  return { production_id: productionForRun(db, runId)?.id ?? null, episode_id: null };
}

/**
 * Keeps one call: the payload goes up first; the row is written even when the upload fails (payload_key null),
 * then the upload error is thrown so the caller logs it.
 */
export async function recordLlmCall(db: StudioDb, bucket: StudioBucket, call: StudioLlmCall, o: {
  source?: LlmCallSource;
  /** Owners when the run does not tell them (a chat before the production has a run). */
  owners?: { production_id: string; episode_id: string | null };
} = {}): Promise<string> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const source = o.source ?? "claude";
  const owners = o.owners ?? ownersOfRun(db, call.run_id);
  const t = call.trace;
  const payload: LlmCallPayload = {
    schema: LLM_CALL_PAYLOAD_SCHEMA, id, created_at: createdAt, source, ...owners,
    run_id: call.run_id, stage_key: call.stage_key, attempt_id: call.attempt_id, skill: call.skill, round: call.round,
    outcome: call.outcome, problems: call.problems, warnings: call.warnings,
    model: t.model, prompt: t.prompt, json_schema: t.json_schema, response: t.response, structured_output: t.structured_output ?? null,
    exit_code: t.exit_code, timed_out: t.timed_out, wall_seconds: t.wall_seconds, cost_usd: t.cost_usd,
    input_tokens: t.input_tokens, output_tokens: t.output_tokens,
  };
  const key = payloadKey(id, createdAt);
  let uploadError: unknown = null;
  try {
    await bucket.put(key, gzipSync(Buffer.from(JSON.stringify(payload), "utf8")), "application/gzip");
  } catch (e) {
    uploadError = e;
  }
  db.run(
    `INSERT INTO llm_calls (id, created_at, source, production_id, episode_id, run_id, stage_key, attempt_id, skill, model, round, outcome,
       problems, input_tokens, output_tokens, cost_usd, wall_seconds, payload_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, createdAt, source, owners.production_id, owners.episode_id, call.run_id, call.stage_key, call.attempt_id, call.skill, t.model, call.round,
      call.outcome, JSON.stringify(call.problems), t.input_tokens, t.output_tokens, t.cost_usd, t.wall_seconds, uploadError ? null : key],
  );
  if (uploadError) throw uploadError;
  return id;
}

export async function readLlmCallPayload(bucket: StudioBucket, key: string): Promise<LlmCallPayload> {
  return JSON.parse(gunzipSync(await bucket.get(key)).toString("utf8")) as LlmCallPayload;
}

export function getLlmCall(db: StudioDb, id: string): LlmCallRow | null {
  return db.get<LlmCallRow>("SELECT * FROM llm_calls WHERE id = ?", [id]) ?? null;
}

/** Calls of a production (its plan run and every episode), newest first. */
export function listLlmCalls(db: StudioDb, p: { productionId: string; episodeId?: string; page: number; pageSize: number }): { items: LlmCallRow[]; total: number } {
  const where = p.episodeId ? "production_id = ? AND episode_id = ?" : "production_id = ?";
  const params = p.episodeId ? [p.productionId, p.episodeId] : [p.productionId];
  const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM llm_calls WHERE ${where}`, params)?.n ?? 0;
  const items = db.all<LlmCallRow>(`SELECT * FROM llm_calls WHERE ${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
    [...params, p.pageSize, (p.page - 1) * p.pageSize]);
  return { items, total };
}

/** The accepted answer a person is about to judge (the plan, an episode's YouTube kit). */
export function latestAcceptedCall(db: StudioDb, runId: string, stageKey: string): string | null {
  return db.get<{ id: string }>(
    "SELECT id FROM llm_calls WHERE run_id = ? AND stage_key = ? AND outcome = 'accepted' ORDER BY created_at DESC LIMIT 1", [runId, stageKey])?.id ?? null;
}

/** JSON with object keys sorted, so two documents that differ only in key order compare equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v));
}

export function recordHumanEdit(db: StudioDb, p: {
  userId: string; productionId: string; episodeId?: string | null; kind: HumanEditKind;
  before?: unknown; after?: unknown; llmCallId?: string | null;
}): string {
  const id = randomUUID();
  const before = p.before === undefined ? null : canonicalJson(p.before);
  const after = p.after === undefined ? null : canonicalJson(p.after);
  const changed = before === null || after === null ? 1 : before === after ? 0 : 1;
  db.run(
    "INSERT INTO human_edits (id, created_at, user_id, production_id, episode_id, kind, llm_call_id, changed, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, new Date().toISOString(), p.userId, p.productionId, p.episodeId ?? null, p.kind, p.llmCallId ?? null, changed, before, after],
  );
  return id;
}

export function listHumanEdits(db: StudioDb, p: { productionId: string; page: number; pageSize: number }): { items: HumanEditRow[]; total: number } {
  const total = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM human_edits WHERE production_id = ?", [p.productionId])?.n ?? 0;
  const items = db.all<HumanEditRow>("SELECT * FROM human_edits WHERE production_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?",
    [p.productionId, p.pageSize, (p.page - 1) * p.pageSize]);
  return { items, total };
}

// ---------------------------------------------------------------------------
// Dataset export (JSONL, one object per line)
// ---------------------------------------------------------------------------

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

/** Splits the stdin prompt (`# Skill\n…\n\n# Brief\n…`) into a system and a user message. */
export function promptMessages(prompt: string): ChatMessage[] {
  const brief = prompt.indexOf("\n\n# Brief\n");
  if (prompt.startsWith("# Skill\n") && brief > 0) {
    return [
      { role: "system", content: prompt.slice("# Skill\n".length, brief).trim() },
      { role: "user", content: prompt.slice(brief + "\n\n# Brief\n".length).trim() },
    ];
  }
  return [{ role: "user", content: prompt.trim() }];
}

export interface DatasetOptions {
  /** Calls kept: only accepted ones (default) or every outcome. */
  includeRejected?: boolean;
  /** `calls`, `edits` (human edits + timeline edits) or both (default). */
  kinds?: Array<"calls" | "edits">;
  since?: string;
  productionId?: string;
}

/** Streams the dataset line by line through `write`; returns how many lines of each kind it wrote. */
export async function exportLlmDataset(db: StudioDb, bucket: StudioBucket, o: DatasetOptions, write: (line: string) => void): Promise<{ calls: number; edits: number; timelines: number; missingPayloads: number }> {
  const kinds = o.kinds ?? ["calls", "edits"];
  const counts = { calls: 0, edits: 0, timelines: 0, missingPayloads: 0 };
  const filters: string[] = [];
  const params: (string | number)[] = [];
  if (o.since) { filters.push("created_at >= ?"); params.push(o.since); }
  if (o.productionId) { filters.push("production_id = ?"); params.push(o.productionId); }
  const and = (extra: string[]) => { const all = [...filters, ...extra]; return all.length ? `WHERE ${all.join(" AND ")}` : ""; };
  const payloads = new Map<string, LlmCallPayload | null>();
  const payloadOf = async (row: LlmCallRow): Promise<LlmCallPayload | null> => {
    if (payloads.has(row.id)) return payloads.get(row.id)!;
    let p: LlmCallPayload | null = null;
    if (row.payload_key) { try { p = await readLlmCallPayload(bucket, row.payload_key); } catch { p = null; } }
    if (!p) counts.missingPayloads++;
    payloads.set(row.id, p);
    return p;
  };

  if (kinds.includes("calls")) {
    const rows = db.all<LlmCallRow>(`SELECT * FROM llm_calls ${and(o.includeRejected ? [] : ["outcome = 'accepted'"])} ORDER BY created_at`, params);
    for (const row of rows) {
      const p = await payloadOf(row);
      if (!p) continue;
      const answer = p.structured_output !== null && p.structured_output !== undefined ? JSON.stringify(p.structured_output) : p.response;
      write(JSON.stringify({
        id: row.id, source: "claude", kind: "llm_call", skill: row.skill, model: row.model, outcome: row.outcome, round: row.round,
        created_at: row.created_at, production_id: row.production_id, episode_id: row.episode_id, stage_key: row.stage_key,
        messages: [...promptMessages(p.prompt), { role: "assistant", content: answer }],
        json_schema: p.json_schema, problems: p.problems,
        usage: { input_tokens: row.input_tokens, output_tokens: row.output_tokens, cost_usd: row.cost_usd },
      }));
      counts.calls++;
    }
  }

  if (kinds.includes("edits")) {
    const edits = db.all<HumanEditRow>(`SELECT * FROM human_edits ${and([])} ORDER BY created_at`, params);
    for (const e of edits) {
      const call = e.llm_call_id ? db.get<LlmCallRow>("SELECT * FROM llm_calls WHERE id = ?", [e.llm_call_id]) : undefined;
      const p = call ? await payloadOf(call) : null;
      write(JSON.stringify({
        id: e.id, source: "human", kind: e.kind, created_at: e.created_at, production_id: e.production_id, episode_id: e.episode_id,
        user_id: e.user_id, changed: e.changed === 1, llm_call_id: e.llm_call_id, model: call?.model ?? null,
        prompt: p ? promptMessages(p.prompt) : null,
        rejected: e.before ? JSON.parse(e.before) : null,
        chosen: e.after ? JSON.parse(e.after) : null,
      }));
      counts.edits++;
    }

    // Timeline edits: the last revision build-timeline wrote against the latest revision a person saved after it.
    const episodes = db.all<{ id: string; production_id: string }>(
      o.productionId ? "SELECT id, production_id FROM episodes WHERE production_id = ?" : "SELECT id, production_id FROM episodes",
      o.productionId ? [o.productionId] : []);
    for (const ep of episodes) {
      const built = db.get<{ revision: number; data: string; created_at: string }>(
        "SELECT revision, data, created_at FROM episode_revisions WHERE episode_id = ? AND author_id = 'system' ORDER BY revision DESC LIMIT 1", [ep.id]);
      if (!built) continue;
      const edited = db.get<{ revision: number; data: string; author_id: string; created_at: string }>(
        "SELECT revision, data, author_id, created_at FROM episode_revisions WHERE episode_id = ? AND author_id <> 'system' AND revision > ? ORDER BY revision DESC LIMIT 1",
        [ep.id, built.revision]);
      if (!edited || (o.since && edited.created_at < o.since)) continue;
      const before = JSON.parse(built.data) as unknown;
      const after = JSON.parse(edited.data) as unknown;
      write(JSON.stringify({
        id: `${ep.id}:r${edited.revision}`, source: "human", kind: "timeline", created_at: edited.created_at,
        production_id: ep.production_id, episode_id: ep.id, user_id: edited.author_id,
        changed: canonicalJson(before) !== canonicalJson(after), plan: (() => {
          const row = getEpisode(db, ep.id);
          return row?.plan ? JSON.parse(row.plan) : null;
        })(),
        rejected: before, chosen: after,
      }));
      counts.timelines++;
    }
  }
  return counts;
}
