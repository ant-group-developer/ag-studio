import type { Artifact, Attempt, CheckResult, Event, ExternalOperation, Lease, Run, StageRun } from "./entities.js";
import type { StageRequest, StageResult } from "./execution.js";

export type TransitionKind = "run" | "stage_run" | "attempt" | "artifact" | "external_operation";

export type EventInput = Omit<Event, "schema_version" | "event_id" | "occurred_at">;

export interface ClaimParams { owner: string; capabilities: string[]; now: string; leaseSeconds: number }
export interface ClaimResult { stageRun: StageRun; attempt: Attempt; lease: Lease }
export interface ReapedLease { stage_run_id: string; run_id: string; attempt_id: string; owner: string; requeued: boolean }

export interface StateStore {
  migrate(migrationsDir: string): string[];
  transaction<T>(fn: () => T): T;
  close(): void;

  insertRun(run: Run): void;
  getRun(id: string): Run | undefined;
  updateRun(run: Run): void;
  listRuns(filter?: { state?: string }): Run[];

  insertStageRun(s: StageRun): void;
  getStageRun(id: string): StageRun | undefined;
  updateStageRun(s: StageRun): void;
  listStageRuns(runId: string): StageRun[];

  insertAttempt(a: Attempt): void;
  getAttempt(id: string): Attempt | undefined;
  updateAttempt(a: Attempt): void;
  listAttempts(stageRunId: string): Attempt[];

  insertArtifact(a: Artifact): void;
  getArtifact(id: string): Artifact | undefined;
  listArtifacts(filter: { stage_run_id?: string; run_id?: string; status?: string }): Artifact[];

  insertExternalOperation(op: ExternalOperation): void;
  getExternalOperation(id: string): ExternalOperation | undefined;
  findExternalOperationByKey(idempotencyKey: string): ExternalOperation | undefined;
  updateExternalOperation(op: ExternalOperation): void;
  listExternalOperations(filter: { stage_run_id?: string; status?: string }): ExternalOperation[];

  insertCheckResult(c: CheckResult): void;
  listCheckResults(attemptId: string): CheckResult[];

  appendEvent(e: EventInput): Event;
  listEvents(filter: { run_id?: string; limit?: number; newest?: boolean }): Event[];

  transition(kind: TransitionKind, id: string, expectedFrom: string, to: string, event: EventInput): void;
  claim(params: ClaimParams): ClaimResult | undefined;
  heartbeat(attemptId: string, fencingToken: number, newExpiresAt: string): boolean;
  getLease(stageRunId: string): Lease | undefined;
  releaseLease(stageRunId: string, fencingToken: number): void;
  reapExpiredLeases(now: string): ReapedLease[];
  assertFencing(stageRunId: string, fencingToken: number): void;
}

export interface ExecutorContext {
  workspaceDir: string;
  logger: { info(msg: string, data?: object): void; warn(msg: string, data?: object): void; error(msg: string, data?: object): void };
  clock: Clock;
  signal?: AbortSignal;
}
export interface Executor { readonly version: string; execute(request: StageRequest, ctx: ExecutorContext): Promise<StageResult> }

export interface AgentTask { skill: string; brief: string; request: StageRequest; workspaceDir: string }
export interface AgentRuntime { readonly name: string; readonly version: string; runTask(task: AgentTask, ctx: ExecutorContext): Promise<StageResult> }

export interface CheckerInput { request: StageRequest; result: StageResult; workspaceDir: string }
export interface Checker { readonly id: string; readonly version: string; check(input: CheckerInput): Promise<{ verdict: "pass" | "fail" | "skip"; evidence: Record<string, unknown> }> }

export interface SecretResolver { resolve(ref: string): string; resolvedValues(): string[] }
export interface Clock { now(): string }

export interface ExternalProvider {
  readonly name: string;
  dispatch(op: ExternalOperation, payload: Record<string, unknown>): Promise<{ provider_ref: string; receipt: Record<string, unknown> }>;
  lookup(idempotencyKey: string): Promise<{ found: boolean; provider_ref?: string; receipt?: Record<string, unknown> }>;
}
