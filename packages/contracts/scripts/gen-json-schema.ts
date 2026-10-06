import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import * as E from "../src/entities.js";
import * as X from "../src/execution.js";
import * as C from "../src/config.js";
import * as L from "../src/library.js";
import * as M from "../src/media.js";
import * as ME from "../src/media-engine.js";
import * as CM from "../src/composition.js";
import * as D from "../src/distribution.js";
import * as G from "../src/learning.js";
import { EdlSchema } from "../src/edl.js";
import * as S from "../src/studio.js";
import * as SC from "../src/studio-chat.js";

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
  review: L.reviewSchema, "survey-index": L.surveyIndexSchema, "survey-index-v2": L.surveyIndexSchemaV2,
  watch: M.WatchIndexSchema,
  hypothesis: D.HypothesisSchema, "channel-package-draft": D.ChannelPackageDraftSchema,
  "package-receipt": D.PackageReceiptSchema, "upload-receipt": D.UploadReceiptSchema, "schedule-receipt": D.ScheduleReceiptSchema,
  "video-metrics": G.VideoMetricsSchema, "channel-learned": G.ChannelLearnedSchema,
  "channel-brief": G.ChannelBriefSchema, "topic-proposal": G.TopicProposalSchema,
  demand: G.DemandSchema, "requests-receipt": G.RequestsReceiptSchema,
  shots: ME.ShotsIndexSchema, transcript: ME.TranscriptSchema, narration: ME.NarrationSchema,
  "narration-timing": ME.NarrationTimingSchema, "fit-report": ME.FitReportSchema, timeline: ME.TimelineSchema,
  voice: ME.VoiceProfileSchema,
  overlays: CM.OverlaysSchema, brand: CM.BrandProfileSchema, "music-track": CM.MusicTrackSchema,
  "caption-cue": CM.CaptionCueSchema, "text-event": CM.TextEventSchema, composition: CM.CompositionSchema,
  "render-report": CM.RenderReportSchema,
  "studio-brief": S.StudioBriefSchema, "studio-research": S.StudioResearchSchema, "studio-trend-report": S.TrendReportSchema,
  "studio-catalog": S.StudioCatalogSchema, "studio-series-plan": S.SeriesPlanSchema, "studio-episodes": S.SpawnedEpisodesSchema,
  "studio-episode": S.StudioEpisodeSchema, "studio-timeline-v3": S.TimelineV3Schema, "studio-timeline-v4": S.TimelineV4Schema, "studio-youtube-kit": S.YoutubeKitSchema,
  "studio-youtube": S.StudioYoutubeSchema, "studio-export": S.StudioExportSchema,
  "studio-seed": S.StudioSeedSchema, "studio-rnd": S.StudioRndSchema, "studio-branding": S.StudioBrandingSchema,
  "studio-thumbnails": S.StudioThumbnailsSchema,
  "studio-intake-draft": SC.IntakeDraftSchema, "studio-timeline-chat": SC.TimelineChatProposalSchema,
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
