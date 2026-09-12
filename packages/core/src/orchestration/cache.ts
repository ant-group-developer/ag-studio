import type { Artifact, Checksum, StageDefinition, StateStore } from "@harness/contracts";
import { canonicalDigest } from "../artifacts/checksum.js";

export function stageDefinitionDigest(def: StageDefinition): Checksum {
  return canonicalDigest({ key: def.key, executor: def.executor, required_checks: def.required_checks, outputs: def.outputs, config: def.config });
}

/** Spec §3.3: definition + inputs + options + effective config + executor version. A new executor build must not hit the cache. */
export function computeCacheKey(p: { stageDefinitionDigest: Checksum; inputChecksums: string[]; optionsDigest: Checksum; effectiveConfigDigest: Checksum; executorVersion: string }): Checksum {
  return canonicalDigest({ d: p.stageDefinitionDigest, i: [...p.inputChecksums].sort(), o: p.optionsDigest, c: p.effectiveConfigDigest, x: p.executorVersion });
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
