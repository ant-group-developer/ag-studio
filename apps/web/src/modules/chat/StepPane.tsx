import { useEffect, useState } from "react";
import { App as AntApp, Modal } from "antd";
import { ArrowLeft } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StoredTimeline } from "@harness/contracts";
import { StudioHttpError, useStudioClient, type StepDocKind, type StepDocView } from "../../api/studio-client";
import { gateProblems } from "../production/gate-problems";
import { useAiTranslation } from "../common/assistant-name";
import { STEP_SHOWS, stepLabelKey, stepOf, type ChatStep } from "./steps";
import { EpisodeOutputs } from "./views/EpisodeOutputs";
import { canEditDoc, StepDocBody, StepDocEditor } from "./views/StepBody";
import { TimelineResult } from "./views/TimelineResult";

interface Props {
  productionId: string;
  episodeId?: string | undefined;
  step: ChatStep;
  workflow?: string | null | undefined;
  /** Producer and up: edit the series' documents, reopen a step. */
  canManage: boolean;
  /** Editor and up: save the YouTube kit in place. */
  canEdit: boolean;
  onBack: () => void;
  /** Something changed (a version saved, a step reopened): the chat and the lists read again. */
  onChanged: () => void;
  onOpenEditor: () => void;
}

/** The steps that run again when a step reopens, by name, in order, each once. */
export function rerunSteps(reruns: readonly string[], workflow: string | null | undefined, label: (s: ChatStep) => string): string {
  const out: string[] = [];
  for (const key of reruns) {
    const s = stepOf(key, workflow);
    if (s && !out.includes(label(s))) out.push(label(s));
  }
  return out.join(" → ");
}

function TimelineStep({ productionId, episodeId, onOpenEditor }: { productionId: string; episodeId: string; onOpenEditor: () => void }) {
  const { t } = useAiTranslation();
  const client = useStudioClient();
  const { data } = useQuery({ queryKey: ["timeline", productionId, episodeId], queryFn: () => client.getTimeline(productionId, episodeId) });
  return (
    <>
      <div className="chat-aside__body">
        {data ? <TimelineResult productionId={productionId} episodeId={episodeId} timeline={data.data as StoredTimeline} proposal={null} /> : null}
      </div>
      <div className="chat-aside__foot">
        <button type="button" className="chat-primary" onClick={onOpenEditor}>{t("chat.stepDoc.openEditor")}</button>
      </div>
    </>
  );
}

/**
 * The result column for a step looked at again (plan 2026-10-07 step history): the version approved (or in use), and
 * Sửa — in place where later steps read it, or reopening the step, after saying what runs again and what is lost.
 */
export function StepPane({ productionId, episodeId, step, workflow, canManage, canEdit, onBack, onChanged, onOpenEditor }: Props) {
  const { t } = useAiTranslation();
  const { message } = AntApp.useApp();
  const client = useStudioClient();
  const qc = useQueryClient();
  const shows = STEP_SHOWS[step];
  const kind = shows && shows !== "timeline" && shows !== "outputs" ? (shows as StepDocKind) : null;
  const key = ["step-doc", productionId, episodeId ?? null, kind];
  const { data: view } = useQuery({ queryKey: key, queryFn: () => client.getStepDocument(productionId, kind!, episodeId), enabled: !!kind });
  const [draft, setDraft] = useState<unknown>(null);
  const [choosing, setChoosing] = useState(false);
  useEffect(() => { setDraft(null); setChoosing(false); }, [step, productionId, episodeId]);

  const save = useMutation({
    mutationFn: (reopen: boolean) => client.editStepDocument(productionId, kind!, { document: draft, reopen, episodeId }),
    onSuccess: (r) => {
      setChoosing(false);
      setDraft(null);
      qc.setQueryData(key, r.view);
      onChanged();
      if (r.mode === "reopened") { void message.success(t("chat.stepDoc.reopened")); onBack(); }
      else void message.success(t(kind === "youtube_kit" ? "chat.stepDoc.savedKit" : "chat.stepDoc.savedInPlace"));
    },
    onError: (e) => {
      setChoosing(false);
      const problems = gateProblems(e);
      void message.error(problems.length ? problems.join("\n") : e instanceof StudioHttpError ? e.message : t("chat.page.failed"));
    },
  });

  const label = (s: ChatStep) => t(stepLabelKey(s));
  const head = (badge: string | null, tone = "done") => (
    <div className="chat-aside__head">
      <button type="button" className="chat-page__back chat-aside__back" onClick={onBack}><ArrowLeft size={14} aria-hidden />{t("chat.stepDoc.back")}</button>
      <h2>{label(step)}</h2>
      {badge ? <span className={`chat-badge chat-badge--${tone}`}>{badge}</span> : null}
    </div>
  );

  if (shows === "timeline" && episodeId) {
    return <aside className="chat-aside" aria-label={label(step)}>{head(null)}<TimelineStep productionId={productionId} episodeId={episodeId} onOpenEditor={onOpenEditor} /></aside>;
  }
  if (shows === "outputs" && episodeId) {
    return <aside className="chat-aside" aria-label={label(step)}>{head(null)}<div className="chat-aside__body"><EpisodeOutputs productionId={productionId} episodeId={episodeId} /></div></aside>;
  }
  if (!kind) return null;

  const edit = view?.edit;
  const allowInPlace = !!edit?.inPlace && (kind === "youtube_kit" ? canEdit : canManage);
  const allowReopen = !!edit?.reopen && canManage;
  const editable = view?.state === "approved" && canEditDoc(kind, view.document) && (allowInPlace || allowReopen);
  const why = (code: string | null | undefined) => t(`chat.stepDoc.codes.${code ?? "not_approved_yet"}`);
  const onSave = () => {
    // the kit is only ever saved in place: no question to ask (the toast says to render again)
    if (kind === "youtube_kit" && allowInPlace) save.mutate(false);
    else setChoosing(true);
  };

  return (
    <aside className="chat-aside" aria-label={label(step)}>
      {head(view?.state === "approved" ? t(view.inUse ? "chat.stepDoc.inUse" : "chat.stepDoc.approved") : null, view?.inUse ? "waiting_you" : "done")}
      <div className="chat-aside__body">
        {!view ? null : view.state === "not_yet" ? <p className="chat-doc__note">{t("chat.stepDoc.notYet")}</p>
          : view.state === "waiting" ? <p className="chat-doc__note">{t("chat.stepDoc.waiting")}</p>
            : draft !== null ? <StepDocEditor kind={kind} value={draft} onChange={setDraft} productionId={productionId} episodeId={episodeId} />
              : <StepDocBody kind={kind} doc={view.document} productionId={productionId} episodeId={episodeId} />}
        {view?.state === "approved" && draft === null && !editable && (canManage || canEdit) ? (
          <p className="chat-doc__note">{t("chat.stepDoc.cannotEdit", { why: why(edit?.reopenCode ?? edit?.inPlaceCode) })}</p>
        ) : null}
      </div>
      {view?.state === "approved" ? (
        <div className="chat-aside__foot">
          {draft !== null ? (
            <>
              <button type="button" className="chat-primary" disabled={save.isPending} onClick={onSave}>{t("chat.edit.save")}</button>
              <button type="button" className="chat-card__button chat-button--secondary" onClick={() => setDraft(null)}>{t("chat.edit.cancel")}</button>
            </>
          ) : editable ? (
            <button type="button" className="chat-primary" onClick={() => setDraft(structuredClone(view.document))}>{t("chat.edit.button")}</button>
          ) : <span className="chat-aside__spacer" />}
        </div>
      ) : null}
      <SaveChoice open={choosing} view={view} workflow={workflow} label={label} busy={save.isPending}
        allowInPlace={allowInPlace} allowReopen={allowReopen} onClose={() => setChoosing(false)} onPick={(reopen) => save.mutate(reopen)} />
    </aside>
  );
}

/** Asked before an approved step is saved: keep it as the version in use, or reopen the step — what runs again, what is lost. */
function SaveChoice({ open, view, workflow, label, busy, allowInPlace, allowReopen, onClose, onPick }: {
  open: boolean; view: StepDocView | undefined; workflow: string | null | undefined; label: (s: ChatStep) => string; busy: boolean;
  allowInPlace: boolean; allowReopen: boolean; onClose: () => void; onPick: (reopen: boolean) => void;
}) {
  const { t } = useAiTranslation();
  if (!view) return null;
  const steps = rerunSteps(view.edit.reruns, workflow, label);
  return (
    <Modal open={open} onCancel={onClose} title={t("chat.stepDoc.choiceTitle")} destroyOnClose
      footer={[
        <button key="cancel" type="button" className="chat-card__button chat-button--secondary" onClick={onClose}>{t("chat.edit.cancel")}</button>,
        allowInPlace ? <button key="save" type="button" className="chat-card__button chat-button--secondary" disabled={busy} onClick={() => onPick(false)}>{t("chat.stepDoc.inPlace")}</button> : null,
        allowReopen ? <button key="reopen" type="button" className={view.edit.replacesEpisodes ? "chat-card__button chat-button--danger" : "chat-card__button"} disabled={busy} onClick={() => onPick(true)}>{t("chat.stepDoc.reopen")}</button> : null,
      ]}>
      <div className="chat-choice">
        {allowInPlace ? <p><strong>{t("chat.stepDoc.inPlace")}:</strong> {t("chat.stepDoc.inPlaceHint")}</p> : null}
        {allowReopen ? <p><strong>{t("chat.stepDoc.reopen")}:</strong> {t("chat.stepDoc.reopenHint", { steps })}</p> : null}
        {allowReopen && view.edit.replacesEpisodes ? <p className="chat-reply__problems">{t("chat.stepDoc.replaces")}</p> : null}
        {!allowReopen && view.edit.reopenCode ? <p className="chat-doc__note">{t("chat.stepDoc.cannotReopen", { why: t(`chat.stepDoc.codes.${view.edit.reopenCode}`) })}</p> : null}
        {!allowInPlace && view.edit.inPlaceCode ? <p className="chat-doc__note">{t(`chat.stepDoc.codes.${view.edit.inPlaceCode}`)}</p> : null}
      </div>
    </Modal>
  );
}
