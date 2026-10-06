/**
 * Claude sessions of the files-mode stages (migration 0022, ADR-0001 item 155): the session a scene selection ran in,
 * and the folder it ran in, so a repair round or a chat turn can `claude --resume` it with the frames it saw.
 */
import type { StudioDb } from "./studio-db.js";

export interface AgentSession { attemptId: string; sessionId: string; cwd: string; createdAt: string }

export function saveAgentSession(db: StudioDb, s: { runId: string; stageKey: string; attemptId: string; sessionId: string; cwd: string }, now: string): void {
  db.run(
    `INSERT INTO studio_agent_sessions (run_id, stage_key, attempt_id, session_id, cwd, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, stage_key) DO UPDATE SET attempt_id = excluded.attempt_id, session_id = excluded.session_id, cwd = excluded.cwd, created_at = excluded.created_at`,
    [s.runId, s.stageKey, s.attemptId, s.sessionId, s.cwd, now],
  );
}

export function agentSessionFor(db: StudioDb, runId: string, stageKey: string): AgentSession | null {
  const row = db.get<{ attempt_id: string; session_id: string; cwd: string; created_at: string }>(
    "SELECT attempt_id, session_id, cwd, created_at FROM studio_agent_sessions WHERE run_id = ? AND stage_key = ?", [runId, stageKey]);
  return row ? { attemptId: row.attempt_id, sessionId: row.session_id, cwd: row.cwd, createdAt: row.created_at } : null;
}
