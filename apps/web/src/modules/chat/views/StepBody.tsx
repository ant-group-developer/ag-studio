import type { EditPlan, StudioSurvey } from "@harness/contracts";
import type { StepDocKind } from "../../../api/studio-client";
import { EditPlanEditor, SurveyEditor } from "./CutEditors";
import { DocEditor } from "./DocEditor";
import { DocView } from "./DocView";
import { EditPlanResult } from "./EditPlanResult";
import { SurveyResult } from "./SurveyResult";

interface Where { productionId: string; episodeId?: string | undefined }

/** A step's document as people read it, what changed since `previous` marked. */
export function StepDocBody({ kind, doc, previous, names, productionId, episodeId }: Where & {
  kind: StepDocKind; doc: unknown; previous?: unknown; names?: Record<string, string>;
}) {
  if (kind === "survey") return <SurveyResult productionId={productionId} episodeId={episodeId!} survey={doc as StudioSurvey} previous={previous as StudioSurvey | undefined} />;
  if (kind === "edit_plan") return <EditPlanResult plan={doc as EditPlan} previous={previous as EditPlan | undefined} />;
  return <DocView kind={kind} doc={doc} previous={previous} {...(names ? { names } : {})} />;
}

/** A trend report skipped for want of research has nothing to edit. */
export function canEditDoc(kind: StepDocKind, doc: unknown): boolean {
  return !(kind === "trend_report" && (doc as { skipped?: boolean } | null)?.skipped);
}

/** A step's document as a form (the same for a step waiting and one looked at again). */
export function StepDocEditor({ kind, value, onChange, productionId, episodeId }: Where & {
  kind: StepDocKind; value: unknown; onChange: (v: unknown) => void;
}) {
  if (kind === "survey") return <SurveyEditor productionId={productionId} episodeId={episodeId!} value={value as StudioSurvey} onChange={onChange} />;
  if (kind === "edit_plan") return <EditPlanEditor value={value as EditPlan} onChange={onChange} />;
  return <DocEditor kind={kind} value={value} onChange={onChange} />;
}
