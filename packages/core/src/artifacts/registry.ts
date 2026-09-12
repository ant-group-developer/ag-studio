import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { HarnessError, newId, type Artifact, type ArtifactManifest, type Attempt, type Run, type StageOutput, type StageRun, type StateStore } from "@harness/contracts";
import { sha256File } from "./checksum.js";

export interface ArtifactContext {
  run: Run; stageRun: StageRun; attempt: Attempt;
  executorVersion: string; inputArtifactIds: string[]; checkResultIds: string[];
}
export interface StagedOutput { artifact: Artifact; manifestPath: string; manifest: ArtifactManifest }

export function artifactDir(dataRoot: string, run: Run, artifactId: string): string {
  return join(dataRoot, "artifacts", run.content_id ?? run.run_id, run.variant_id ?? run.profile_snapshot.id, artifactId);
}

function buildArtifact(output: StageOutput, uri: string, mime: string, ctx: ArtifactContext, status: Artifact["status"], now: string): Artifact {
  return {
    schema_version: "harness.artifact/v1", artifact_id: newId("artifact"), run_id: ctx.run.run_id, stage_run_id: ctx.stageRun.stage_run_id,
    attempt_id: ctx.attempt.attempt_id, type: output.type, status, uri, checksum: output.checksum, size_bytes: output.size_bytes, mime_type: mime,
    lineage: { input_artifacts: ctx.inputArtifactIds, source_items: ctx.run.source_id ? [ctx.run.source_id] : [] },
    reproducibility: {
      workflow_release: `${ctx.run.workflow_release.id}@${ctx.run.workflow_release.version}`,
      production_profile: `${ctx.run.profile_snapshot.id}@${ctx.run.profile_snapshot.revision}`,
      channel_config_revision: null, executor_version: ctx.executorVersion, model_parameters_digest: null,
    },
    checks: ctx.checkResultIds, created_at: now, updated_at: now,
  };
}

export function toManifest(a: Artifact): ArtifactManifest {
  return {
    schema_version: "harness.artifact-manifest/v1", artifact_id: a.artifact_id, type: a.type, status: a.status.toLowerCase() as ArtifactManifest["status"],
    uri: a.uri, checksum: a.checksum, size_bytes: a.size_bytes, mime_type: a.mime_type,
    created_by: { run_id: a.run_id, stage_run_id: a.stage_run_id, attempt_id: a.attempt_id },
    lineage: a.lineage, reproducibility: a.reproducibility, checks: a.checks,
  };
}

export class ArtifactRegistry {
  constructor(private readonly store: StateStore, private readonly dataRoot: string) {}

  /** Async phase: verify every output first (no file moved on any failure), then move files and write PROVISIONAL manifests. No DB writes. */
  async stageOutputs(p: { workspaceDir: string; outputs: StageOutput[]; mimeTypes: Record<string, string>; ctx: ArtifactContext }): Promise<StagedOutput[]> {
    const now = new Date().toISOString();
    const root = resolve(p.workspaceDir) + sep;
    const verified: { out: StageOutput; src: string }[] = [];
    for (const out of p.outputs) {
      const src = resolve(p.workspaceDir, out.path);
      if (!src.startsWith(root)) throw new HarnessError("IO_ERROR", `output path escapes the workspace: ${out.path}`, { path: out.path });
      const actual = await sha256File(src).catch(() => { throw new HarnessError("IO_ERROR", `output missing: ${out.path}`, { path: out.path }); });
      if (actual.checksum !== out.checksum || actual.size_bytes !== out.size_bytes) {
        throw new HarnessError("CHECKSUM_MISMATCH", `checksum mismatch for ${out.path}`, { path: out.path, declared: out.checksum, actual: actual.checksum });
      }
      verified.push({ out, src });
    }
    const staged: StagedOutput[] = [];
    for (const { out, src } of verified) {
      const id = newId("artifact");
      const dir = artifactDir(this.dataRoot, p.ctx.run, id);
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, basename(src));
      renameSync(src, dest);
      const artifact = { ...buildArtifact(out, pathToFileURL(dest).href, p.mimeTypes[out.type] ?? "application/octet-stream", p.ctx, "PROVISIONAL", now), artifact_id: id };
      const manifestPath = join(dir, "manifest.json");
      const manifest = toManifest(artifact);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      staged.push({ artifact, manifestPath, manifest });
    }
    return staged;
  }

  /** Sync phase: must run inside store.transaction(). PROVISIONAL -> ACCEPTED with event. */
  commitAccepted(staged: StagedOutput[], ctx: ArtifactContext): Artifact[] {
    return staged.map(({ artifact, manifestPath }) => {
      this.store.insertArtifact(artifact);
      this.store.transition("artifact", artifact.artifact_id, "PROVISIONAL", "ACCEPTED", {
        run_id: ctx.run.run_id, stage_run_id: ctx.stageRun.stage_run_id, attempt_id: ctx.attempt.attempt_id, project_id: ctx.run.project_id,
        portfolio_id: ctx.run.portfolio_id, channel_id: null, content_id: ctx.run.content_id ?? null, variant_id: ctx.run.variant_id ?? null,
        workflow_release: `${ctx.run.workflow_release.id}@${ctx.run.workflow_release.version}`, severity: "info", event_type: "artifact.accepted",
        payload: { artifact_id: artifact.artifact_id, type: artifact.type, checksum: artifact.checksum },
      });
      const accepted = this.store.getArtifact(artifact.artifact_id)!;
      writeFileSync(manifestPath, JSON.stringify(toManifest(accepted), null, 2) + "\n");
      return accepted;
    });
  }

  /** Sync phase inside a transaction: record outputs that failed verification, pointing at the workspace. */
  registerRejected(p: { workspaceDir: string; outputs: StageOutput[]; ctx: ArtifactContext; reason: string }): Artifact[] {
    const now = new Date().toISOString();
    return p.outputs.map((out) => {
      const a = buildArtifact(out, pathToFileURL(join(p.workspaceDir, out.path)).href, "application/octet-stream", p.ctx, "PROVISIONAL", now);
      this.store.insertArtifact(a);
      this.store.transition("artifact", a.artifact_id, "PROVISIONAL", "REJECTED", {
        run_id: p.ctx.run.run_id, stage_run_id: p.ctx.stageRun.stage_run_id, attempt_id: p.ctx.attempt.attempt_id, project_id: p.ctx.run.project_id,
        portfolio_id: p.ctx.run.portfolio_id, channel_id: null, content_id: null, variant_id: null, workflow_release: null,
        severity: "warn", event_type: "artifact.rejected", payload: { artifact_id: a.artifact_id, reason: p.reason },
      });
      return this.store.getArtifact(a.artifact_id)!;
    });
  }
}

/** Downstream stages only ever see ACCEPTED artifacts from the stages they depend on. */
export function acceptedInputsFor(store: StateStore, stage: StageRun): Artifact[] {
  const upstream = store.listStageRuns(stage.run_id).filter((s) => stage.depends_on.includes(s.stage_key));
  return upstream.flatMap((s) => store.listArtifacts({ stage_run_id: s.stage_run_id, status: "ACCEPTED" }));
}
