import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import * as E from "../src/entities.js";
import * as X from "../src/execution.js";
import * as C from "../src/config.js";
import * as L from "../src/library.js";
import { EdlSchema } from "../src/edl.js";

export const ALL_SCHEMAS: Record<string, ZodTypeAny> = {
  run: E.RunSchema, "stage-run": E.StageRunSchema, attempt: E.AttemptSchema, artifact: E.ArtifactSchema,
  "external-operation": E.ExternalOperationSchema, "check-result": E.CheckResultSchema, event: E.EventSchema, lease: E.LeaseSchema,
  project: E.ProjectSchema, portfolio: E.PortfolioSchema, channel: E.ChannelSchema, "source-item": E.SourceItemSchema,
  "content-item": E.ContentItemSchema, "production-profile-ref": E.ProductionProfileRefSchema, "content-variant": E.ContentVariantSchema,
  "distribution-plan": E.DistributionPlanSchema, "channel-package": E.ChannelPackageSchema, "publication-job": E.PublicationJobSchema,
  "workflow-release": E.WorkflowReleaseSchema, incident: E.IncidentSchema,
  "stage-request": X.StageRequestSchema, "stage-result": X.StageResultSchema, "artifact-manifest": X.ArtifactManifestSchema,
  workflow: C.WorkflowDefinitionSchema, "production-profile": C.ProductionProfileSchema, "channel-config": C.ChannelConfigSchema,
  "project-config": C.ProjectConfigSchema, "harness-config": C.HarnessConfigSchema,
  edl: EdlSchema, scripts: C.ScriptsRegistrySchema, sources: C.SourcesRegistrySchema,
  "edit-style": L.EditStyleSchema, "content-request": L.ContentRequestSchema,
  "library-item": L.LibraryItemSchema, "library-claim": L.LibraryClaimSchema,
};

export function toJsonSchema(name: string, schema: ZodTypeAny) {
  return zodToJsonSchema(schema, { name, $refStrategy: "none" });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
  mkdirSync(out, { recursive: true });
  for (const [name, schema] of Object.entries(ALL_SCHEMAS)) {
    writeFileSync(join(out, `${name}.json`), JSON.stringify(toJsonSchema(name, schema), null, 2) + "\n");
  }
  console.log(`wrote ${Object.keys(ALL_SCHEMAS).length} schemas to ${out}`);
}
