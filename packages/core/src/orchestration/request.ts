import { isHarnessError, type Attempt, type Clock, type HarnessConfig, type Lease, type ProductionProfile, type Run, type SourceItem, type StageDefinition, type StageInput, type StageRequest, type StageRun, type StateStore, type VerificationPolicy } from "@harness/contracts";
import { addSeconds } from "../state/clock.js";
import type { LoadedWorkflow } from "./registry.js";

export interface RequestDeps { store: StateStore; clock: Clock; harness: HarnessConfig; profiles: (id: string) => ProductionProfile; workflows: (ref: string) => LoadedWorkflow }

export function stageDefinitionFor(workflows: RequestDeps["workflows"], run: Run, stageKey: string): StageDefinition | undefined {
  return workflows(`${run.workflow_release.id}@${run.workflow_release.version}`).definition.stages.find((s) => s.key === stageKey);
}
export function mimeTypesFor(def: StageDefinition | undefined): Record<string, string> {
  return Object.fromEntries((def?.outputs ?? []).map((o) => [o.type, o.mime_type]));
}
export function policyFor(profile: ProductionProfile): VerificationPolicy {
  return { ...(profile.content.target_duration_seconds ? { target_duration_seconds: profile.content.target_duration_seconds } : {}), ...(profile.content.max_silence_ratio !== undefined ? { max_silence_ratio: profile.content.max_silence_ratio } : {}) };
}

export function buildStageRequest(d: RequestDeps, p: { run: Run; stageRun: StageRun; attempt: Attempt; lease: Lease; inputs: StageInput[]; workspaceDir: string; capabilities: string[] }): StageRequest {
  const { run, stageRun } = p;
  const cfg = run.effective_config_snapshot;
  const exec = stageRun.executor;
  const stage_config = { ...stageRun.stage_config, ...(exec.type === "script" ? { __script: exec.script } : exec.type === "agent" ? { __skill: exec.skill, __brief: exec.brief } : { __brief: exec.brief }) };
  const content = run.content_id ? d.store.getContentItem(run.content_id) : undefined;
  const source_items = (content?.source_ids ?? []).map((id) => d.store.getSourceItem(id)).filter((s): s is SourceItem => !!s)
    .map((s) => ({ source_id: s.source_id, uri: s.uri, checksum: s.checksum, mime_type: s.mime_type, duration_seconds: s.duration_seconds }));
  const def = stageDefinitionFor(d.workflows, run, stageRun.stage_key);
  let policy: VerificationPolicy = {};
  try { policy = policyFor(d.profiles(run.profile_snapshot.id)); } catch (e) { if (!isHarnessError(e, "NOT_FOUND")) throw e; /* profile file gone: verify without thresholds */ }
  return {
    schema_version: "harness.stage-request/v1", run_id: run.run_id, stage_run_id: stageRun.stage_run_id, attempt_id: p.attempt.attempt_id,
    project_id: run.project_id, portfolio_id: run.portfolio_id, stage_key: stageRun.stage_key, workflow: run.workflow_release, profile_snapshot: run.profile_snapshot,
    inputs: p.inputs, workspace_uri: p.workspaceDir, stage_config, options: run.options, source_items, resources: p.lease.resources,
    // `optional` is carried through only when the workflow actually set it (sub-project 5B): every other
    // stage request keeps exactly the shape it had before, byte for byte.
    expected_outputs: (def?.outputs ?? []).map((o) => ({ type: o.type, mime_type: o.mime_type, kind: o.kind, ...(o.name ? { name: o.name } : {}), ...(o.optional ? { optional: true } : {}) })),
    policy,
    limits: { deadline_at: addSeconds(d.clock.now(), Number(cfg.default_deadline_seconds ?? d.harness.default_deadline_seconds)), max_cost_usd: Number(cfg.default_max_cost_usd ?? d.harness.default_max_cost_usd), max_attempts: stageRun.retry.max_attempts },
    capabilities: p.capabilities, fencing_token: p.lease.fencing_token,
  };
}
