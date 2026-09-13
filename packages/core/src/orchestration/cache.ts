import { isHarnessError, type Artifact, type Checksum, type Run, type StageDefinition, type StageRun, type StateStore } from "@harness/contracts";
import { canonicalDigest } from "../artifacts/checksum.js";
import { acceptedInputsFor } from "../artifacts/registry.js";

export function stageDefinitionDigest(def: StageDefinition): Checksum {
  return canonicalDigest({ key: def.key, executor: def.executor, required_checks: def.required_checks, outputs: def.outputs, config: def.config });
}

/** Spec §3.3: definition + inputs + options + effective config + executor version. A new executor build must not hit the cache. */
export function computeCacheKey(p: { stageDefinitionDigest: Checksum; inputChecksums: string[]; optionsDigest: Checksum; effectiveConfigDigest: Checksum; executorVersion: string }): Checksum {
  return canonicalDigest({ d: p.stageDefinitionDigest, i: [...p.inputChecksums].sort(), o: p.optionsDigest, c: p.effectiveConfigDigest, x: p.executorVersion });
}

/**
 * Cache lookup for a PENDING stage that is about to be released, using the inputs it would actually be
 * dispatched with. Plan-time reuse (spec §3.3) cannot see past a gate — a gate is never reused, so every
 * stage below one starts PENDING even when the gate ends up re-committing the very same bytes. Once those
 * inputs are ACCEPTED and byte-identical, the key matches the earlier run's and the stage can be settled
 * from the cache instead of dispatched. Cheap: one digest plus one scan of the variant's runs.
 */
export function tryLateReuse(store: StateStore, run: Run, stage: StageRun): { artifacts: Artifact[]; cacheKey: Checksum } | undefined {
  if (!stage.reuse_eligible || !run.variant_id || !stage.stage_definition_digest || !stage.expected_executor_version) return undefined;
  const variant = store.getContentVariant(run.variant_id);
  if (!variant) return undefined;
  let inputChecksums: string[];
  try {
    inputChecksums = acceptedInputsFor(store, stage).map((a) => a.checksum);
  } catch (e) {
    // an upstream reused artifact stopped being ACCEPTED: leave it to the dispatch path, which reports it
    if (isHarnessError(e, "STALE_STATE")) return undefined;
    throw e;
  }
  const cacheKey = computeCacheKey({
    stageDefinitionDigest: stage.stage_definition_digest, inputChecksums, optionsDigest: variant.options_digest,
    effectiveConfigDigest: run.effective_config_digest, executorVersion: stage.expected_executor_version,
  });
  const artifacts = findReusableArtifacts(store, { variantId: run.variant_id, stageKey: stage.stage_key, cacheKey, excludeRunId: run.run_id });
  return artifacts.length ? { artifacts, cacheKey } : undefined;
}

/** ACCEPTED artifacts of the newest earlier run of the same variant whose stage carries the same cache key. */
export function findReusableArtifacts(store: StateStore, p: { variantId: string; stageKey: string; cacheKey: Checksum; excludeRunId?: string }): Artifact[] {
  const runs = store.listRuns({ variant_id: p.variantId }).filter((r) => r.run_id !== p.excludeRunId).reverse();
  for (const run of runs) {
    const stage = store.listStageRuns(run.run_id).find((s) => s.stage_key === p.stageKey && s.state === "SUCCEEDED" && s.cache_key === p.cacheKey);
    if (!stage) continue;
    const artifacts = stage.reused_artifact_ids
      ? stage.reused_artifact_ids.map((id) => store.getArtifact(id)).filter((a): a is Artifact => !!a && a.status === "ACCEPTED")
      : store.listArtifacts({ stage_run_id: stage.stage_run_id, status: "ACCEPTED" });
    if (artifacts.length) return artifacts;
  }
  return [];
}
