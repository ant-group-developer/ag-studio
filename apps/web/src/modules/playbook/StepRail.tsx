import { useState } from "react";
import { App as AntApp, Button, Popover } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Circle, Loader2, Minus, PenLine, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient, type PlaybookStatus, type StepState, type StepStatus } from "../../api/workspace-client";
import { useStepText } from "./step-text";

const ICONS: Record<StepStatus, typeof Check> = {
  done: Check, skipped: Minus, draft: PenLine, invalid: X, stale: RefreshCw, missing: Circle, running: Loader2,
};

export function StepIcon({ status }: { status: StepStatus }) {
  const Icon = ICONS[status];
  return <Icon size={12} className={status === "running" ? "ws-spin" : undefined} aria-hidden />;
}

/** One step: what it is, where it stands, its file, its errors; do it, redo it, revise it; mark it done or skipped. */
function StepCard({ step, titleOf, projectId, videoId, canWrite, onPrompt, onOpenFile, onDone }: {
  step: StepState; titleOf: (key: string) => string; projectId: string; videoId: string | null; canWrite: boolean;
  onPrompt: (text: string) => void; onOpenFile: (path: string) => void; onDone: () => void;
}) {
  const { t } = useTranslation();
  const text = useStepText();
  const outside = (step.outsideRequires ?? []).map(titleOf).join(", ");
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const mark = useMutation({
    mutationFn: (status: "done" | "skipped" | "draft") => client.markStep(projectId, step.key, { status, ...(step.scope === "video" && videoId ? { videoId } : {}) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["playbook", projectId] }); onDone(); },
    onError: (e) => void message.error(e instanceof StudioHttpError ? e.message : t("ws.steps.markFailed")),
  });
  const docStep = step.outputs.some((o) => o.role === "doc");
  const exists = step.outputs[0]?.exists ?? false;
  return (
    <div className="ws-step-card">
      <p className="ws-step-card__desc">{text(step).description}</p>
      <p className="ws-step-card__status">
        <span className={`ws-step ws-step--${step.status}`}><StepIcon status={step.status} />{t(`ws.steps.status.${step.status}`)}</span>
        {step.status === "stale" ? <span>{t("ws.steps.staleBecause", { steps: step.staleBecause.map(titleOf).join(", ") })}</span> : null}
        {step.detail ? <span>{step.detail}</span> : null}
      </p>
      {outside ? <p className="ws-step-card__note">{t(step.scope === "video" ? "ws.steps.outsideChannel" : "ws.steps.outsideVideo", { steps: outside })}</p> : null}
      {exists || step.outputs.some((o) => o.exists) ? (
        <button type="button" className="ws-link" onClick={() => { onOpenFile(step.primary); onDone(); }}>{t("ws.steps.openFile", { file: step.primary })}</button>
      ) : <p className="ws-step-card__file">{step.primary}</p>}
      {step.issues.length ? (
        <ul className="ws-issues">{step.issues.slice(0, 6).map((i, n) => <li key={n} className={`ws-issue ws-issue--${i.level}`}><AlertTriangle size={12} aria-hidden />{i.message}</li>)}</ul>
      ) : null}
      {canWrite ? (
        <div className="ws-step-card__actions">
          <Button size="small" type="primary" onClick={() => { onPrompt(step.prompts.do); onDone(); }}>{t("ws.steps.do")}</Button>
          {exists && step.prompts.redo ? <Button size="small" onClick={() => { onPrompt(step.prompts.redo!); onDone(); }}>{t("ws.steps.redo")}</Button> : null}
          {exists && step.prompts.revise ? <Button size="small" onClick={() => { onPrompt(step.prompts.revise!); onDone(); }}>{t("ws.steps.revise")}</Button> : null}
          {docStep && step.status !== "done" && exists ? <Button size="small" onClick={() => mark.mutate("done")} loading={mark.isPending}>{t("ws.steps.markDone")}</Button> : null}
          {docStep && step.optional && step.status !== "skipped" ? <Button size="small" onClick={() => mark.mutate("skipped")}>{t("ws.steps.skip")}</Button> : null}
          {docStep && (step.status === "done" || step.status === "skipped") ? <Button size="small" onClick={() => mark.mutate("draft")}>{t("ws.steps.reopen")}</Button> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The suggested steps (never enforced) for the channel or this video: each with where it stands; open one to read
 * its file, have the agent do, redo or revise it, or mark it. Going back to an earlier step is just opening it.
 */
export function StepRail({ status, scope, projectId, videoId, canWrite, onPrompt, onOpenFile }: {
  status: PlaybookStatus;
  scope: "project" | "video";
  projectId: string;
  videoId: string | null;
  canWrite: boolean;
  onPrompt: (text: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useTranslation();
  const text = useStepText();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const steps = scope === "video" ? status.video ?? [] : status.project;
  const all = [...status.project, ...(status.video ?? [])];
  const titleOf = (key: string) => { const s = all.find((x) => x.key === key); return s ? text(s).title : key; };
  // only this rail's steps are suggested here (an older API mixed the channel's into a video's)
  const next = new Set(status.next.filter((n) => n.scope === scope).map((n) => n.key));
  const projectOpen = scope === "video"
    ? status.projectOpen ?? status.project.filter((s) => !s.optional && s.status !== "done" && s.status !== "skipped").length
    : 0;
  return (
    <nav className="ws-steps" data-tour="steps" aria-label={t("ws.steps.label")}>
      {steps.map((s) => (
        <Popover key={s.key} trigger="click" placement="bottomLeft" title={text(s).title} destroyOnHidden
          open={openKey === s.key} onOpenChange={(o) => setOpenKey(o ? s.key : null)}
          content={<StepCard step={s} titleOf={titleOf} projectId={projectId} videoId={videoId} canWrite={canWrite} onPrompt={onPrompt} onOpenFile={onOpenFile} onDone={() => setOpenKey(null)} />}>
          <button type="button" className={`ws-step ws-step--${s.status}${next.has(s.key) ? " ws-step--next" : ""}`} title={t(`ws.steps.status.${s.status}`)}>
            <StepIcon status={s.status} />{text(s).title}
          </button>
        </Popover>
      ))}
      {projectOpen ? <span className="ws-steps__note">{t("ws.steps.projectOpen", { count: projectOpen })}</span> : null}
    </nav>
  );
}
