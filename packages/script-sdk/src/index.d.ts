export interface StageInputLike { artifact_id: string; checksum: string; path: string; type: string; kind: "file" | "directory" }
export interface SourceItemLike { source_id: string; uri: string; checksum: string; mime_type: string; duration_seconds: number | null }
export interface ExpectedOutputLike { type: string; mime_type: string; kind: "file" | "directory"; name?: string; optional?: boolean }
export interface StageRequestLike {
  schema_version: string; run_id: string; stage_run_id: string; attempt_id: string; project_id: string; portfolio_id: string; stage_key: string;
  workflow: { id: string; version: string; digest: string }; profile_snapshot: { id: string; revision: number };
  inputs: StageInputLike[]; workspace_uri: string; stage_config: Record<string, unknown>; options: Record<string, unknown>;
  source_items: SourceItemLike[]; resources: string[]; expected_outputs: ExpectedOutputLike[]; policy: Record<string, unknown>;
  limits: { deadline_at: string; max_cost_usd: number; max_attempts: number }; capabilities: string[]; fencing_token: number;
}
export type FailureKind = "transient" | "result" | "contract";
export interface OperationRecord { operation_id: string; status: string; provider_ref: string | null; receipt: Record<string, unknown> | null }
export interface ScriptContext {
  readonly request: StageRequestLike; readonly workspace: string; readonly options: Record<string, unknown>; readonly sources: SourceItemLike[];
  input(typeOrPath: string): string; inputs(type: string): string[]; hasInput(type: string): boolean; source(i: number): SourceItemLike; hasResource(name: string): boolean;
  out: { file(rel: string, o: { type: string; mime?: string }): Promise<void>; dir(rel: string, o: { type: string }): Promise<void>; clear(): void };
  heartbeat(p?: { percent?: number; message?: string }): void;
  log: { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void; error(msg: string, data?: Record<string, unknown>): void };
  done(o?: { cost_usd?: number; wall_seconds?: number; external_operations?: string[] }): Promise<unknown>;
  fail(kind: FailureKind, message: string, details?: Record<string, unknown>): Promise<unknown>;
  unknown(message: string, external_operations?: string[]): Promise<unknown>;
  op: {
    intent(p: { provider: string; kind: string; target: string; payload?: Record<string, unknown> }): Promise<OperationRecord>;
    confirm(operationId: string, r: { provider_ref: string; receipt?: Record<string, unknown>; cost_usd?: number }): Promise<OperationRecord>;
    lost(operationId: string, reason: string): Promise<OperationRecord>;
  };
}
export interface StartOptions { workspace?: string; env?: Record<string, string | undefined>; io?: { stdout?(line: string): void; exit?(code: number): void } }
export function start(opts?: StartOptions): Promise<ScriptContext>;
export function directoryListing(dir: string): { entries: { path: string; checksum: string; size_bytes: number }[]; checksum: string; size_bytes: number };
