import { useEffect, useState } from "react";
import { Dropdown, Popover, type MenuProps } from "antd";
import { MoreHorizontal } from "lucide-react";
import type { StoredTimeline } from "@harness/contracts";
import type { ChatThreadView, ChatTurn, FarmNode, RenderMachine, StepDocKind } from "../../api/studio-client";
import { RenderMachinePicker } from "../render/RenderMachinePicker";
import { KIT_GATE, type CardOptions } from "./ChatThread";
import { diffDoc } from "./diff-doc";
import { isCutWorkflow, stepLabelKey, stepOf } from "./steps";
import { DocView } from "./views/DocView";
import { docKindOf } from "./views/doc-specs";
import { EpisodeOutputs } from "./views/EpisodeOutputs";
import { canEditDoc, StepDocBody, StepDocEditor } from "./views/StepBody";
import { TimelineResult } from "./views/TimelineResult";
import { KitThumbnails } from "./views/KitThumbnails";
import { ProductionAudioPanel } from "./views/ProductionAudioPanel";
import { useAiTranslation } from "../common/assistant-name";

/** `rerunStep`: run again a machine step that stopped (`blocked.code = stage_failed`). */
export type ResultAction = "approve" | "start" | "apply" | "retry" | "rerunStep" | "renderAgain";
export type MenuAction = "editor" | "preview" | "finalRender" | "export" | "rerunSurvey" | "rerunEditPlan" | "rerunFrom" | "cancelRun" | "log" | "oldScreen";

interface Props {
  productionId: string;
  episodeId?: string | undefined;
  thread: ChatThreadView;
  /** The kit's Duyệt adds the machine type of the final render it starts. */
  onPrimary: (action: ResultAction, options?: CardOptions) => void;
  onMenu: (action: MenuAction) => void;
  busy?: boolean | undefined;
  /** The person may approve, start and run again (producer and up). */
  canApprove?: boolean | undefined;
  /** Where the machine picker starts (the episode's `render.defaultMachine`). */
  renderDefault?: RenderMachine | undefined;
  /** The farm machines a final render may be pinned to. */
  renderNodes?: FarmNode[] | undefined;
  /** ⋯ → Render bản cuối… can start now (the episode is not producing). */
  canRenderFinal?: boolean | undefined;
  /** The episode run's workflow (`id@version`). */
  workflow?: string | null | undefined;
  /** Sửa at a waiting gate: the edited document becomes the version on show (a manual-edit turn). */
  onSaveEdit?: ((stageKey: string, document: unknown) => Promise<unknown>) | undefined;
  /** The production's voice or music changed (the thread may have moved on: an episode waiting for a voice runs). */
  onAudioChanged?: (() => void) | undefined;
}

/** Duyệt on the YouTube kit: it starts the final render, so it confirms the machine type first (spec §2.5, §3.4). */
function ApproveAndRender({ disabled, initial, nodes, onConfirm }: {
  disabled: boolean; initial: RenderMachine; nodes?: FarmNode[] | undefined; onConfirm: (m: RenderMachine, node: string | null) => void;
}) {
  const { t } = useAiTranslation();
  const [open, setOpen] = useState(false);
  const [machine, setMachine] = useState<RenderMachine>(initial);
  const [node, setNode] = useState<string | null>(null);
  const content = (
    <div className="chat-card chat-card--column chat-card--popover">
      <span>{t("chat.cards.approveRender.question")}</span>
      <RenderMachinePicker value={machine} onChange={setMachine} nodes={nodes} node={node} onNode={setNode} />
      <button type="button" className="chat-card__button" onClick={() => { setOpen(false); onConfirm(machine, node); }}>{t("chat.cards.approveRender.button")}</button>
    </div>
  );
  return (
    <Popover open={open} onOpenChange={(o) => { if (o) { setMachine(initial); setNode(null); } setOpen(o); }} trigger="click" placement="topLeft" content={content}>
      <button type="button" className="chat-primary" disabled={disabled}>{t("chat.result.primary.approve")}</button>
    </Popover>
  );
}

/** What still blocks Bắt đầu, from the intake draft (same rules as the API: `intakeMissing`). */
export function intakeMissing(d: { title?: string | null; folder_ids?: string[]; aspect?: string | null; language?: string | null; channels?: unknown[]; keywords?: string[] } | null): string[] {
  if (!d) return ["title", "folder_ids", "aspect", "language", "research"];
  const out: string[] = [];
  if (!d.title) out.push("title");
  if (!d.folder_ids?.length) out.push("folder_ids");
  if (!d.aspect) out.push("aspect");
  if (!d.language) out.push("language");
  if (!d.channels?.length && !d.keywords?.length) out.push("research");
  return out;
}

/** "Bản n" of the document on show (the stage's draft is 1) and the version before it. */
export function versionOf(thread: ChatThreadView): { n: number; previous: unknown } {
  const scope = thread.scope;
  const current = thread.current;
  if (!scope || !current) return { n: 1, previous: undefined };
  const versions = thread.turns.filter((t: ChatTurn) => t.stage_key === scope.stageKey && t.proposal !== null && t.proposal !== undefined);
  const at = current.turnId ? versions.findIndex((t) => t.id === current.turnId) : -1;
  if (at < 0) return { n: 1, previous: undefined };
  return { n: at + 2, previous: at === 0 ? current.draft : versions[at - 1]!.proposal };
}

/** Names of folders a message tagged, to show ids as names in the intake summary. */
function folderNames(thread: ChatThreadView): Record<string, string> {
  return Object.fromEntries(thread.turns.flatMap((t) => t.mentions.map((m) => [m.id, m.name] as const)));
}

function Problems({ problems }: { problems: { code: string; message: string }[] }) {
  const { t } = useAiTranslation();
  if (!problems.length) return null;
  return (
    <section className="chat-reply__problems">
      <p>{t("chat.result.problems")}</p>
      <ol>{problems.map((p, i) => <li key={i}>{p.message}</li>)}</ol>
    </section>
  );
}

/** The result column (spec local-chat §2.3–2.4): the step's document, readable, changes marked; one main button; ⋯. */
export function ResultPane({ productionId, episodeId, thread, onPrimary, onMenu, busy, canApprove = true, renderDefault = "any", renderNodes, canRenderFinal = false, workflow, onSaveEdit, onAudioChanged }: Props) {
  const { t } = useAiTranslation();
  const scope = thread.scope;
  // An episode whose run ended (rendered, or stopped at the render): its render and files, not the timeline. The chat
  // still edits the timeline; a change waiting for Áp dụng shows it again.
  const ended = !!episodeId && scope?.scope === "timeline" && !!scope.runId && !thread.current?.pendingApply;
  const stopped = ended ? thread.stopped ?? null : null;
  const stageKey = ended ? stopped?.stage ?? "render-final" : scope?.stageKey ?? thread.blocked?.stage ?? null;
  const step = stepOf(stageKey, workflow);
  const kind = scope ? docKindOf(scope.stageKey) : null;
  const isTimeline = !!episodeId && !ended && (scope?.stageKey === "approve-timeline" || scope?.scope === "timeline");
  const cut = !!episodeId && isCutWorkflow(workflow);
  // shot-cut episodes (phase 5): the scene selection shot by shot
  const isSurvey = !!episodeId && scope?.scope === "gate" && scope.stageKey === "approve-survey";
  const isEditPlan = !!episodeId && scope?.scope === "gate" && scope.stageKey === "approve-edit-plan";
  const versioned = !!kind || isSurvey || isEditPlan;
  const { n, previous } = versionOf(thread);
  const doc = thread.current?.document;
  const changes = previous !== undefined && versioned ? diffDoc(previous, doc).length : 0;
  // Sửa in place at a waiting gate: every document but the timeline (its editor) and the intake (its own flow)
  const editKind: StepDocKind | null = scope?.scope !== "gate" ? null
    : isSurvey ? "survey" : isEditPlan ? "edit_plan" : kind && kind !== "intake" ? kind : null;
  const canEditHere = !!editKind && !!doc && !!onSaveEdit && canApprove && canEditDoc(editKind, doc);
  const [draft, setDraft] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(null); }, [scope?.stageKey, thread.current?.turnId]);
  const saveDraft = async () => {
    if (!scope || !onSaveEdit) return;
    setSaving(true);
    try { await onSaveEdit(scope.stageKey, draft); setDraft(null); } catch { /* the page says what went wrong; the form stays */ } finally { setSaving(false); }
  };

  let badge: string | null = null;
  let primary: ResultAction | null = null;
  if (scope?.scope === "intake") {
    const missing = intakeMissing(doc as Parameters<typeof intakeMissing>[0]);
    badge = missing.length ? t("chat.result.missing", { n: missing.length }) : t("chat.result.ready");
    primary = "start";
  } else if (scope?.scope === "gate") {
    badge = t("chat.result.waiting");
    primary = thread.current?.pendingApply ? "apply" : "approve";
  } else if (scope?.scope === "failed") {
    badge = t("chat.result.failed");
    primary = "retry";
  } else if (stopped) {
    badge = t("chat.result.failed");
    primary = "renderAgain";
  } else if (scope?.scope === "timeline") {
    primary = thread.current?.pendingApply ? "apply" : null;
  } else if (thread.blocked?.code === "needs_voice") {
    badge = t("chat.result.needsVoice");
  } else if (thread.blocked?.code === "stage_failed") {
    badge = t("chat.result.failed");
    primary = "rerunStep";
  } else if (thread.blocked?.code === "busy") {
    badge = t("chat.result.running");
  }
  const startDisabled = primary === "start" && intakeMissing(doc as Parameters<typeof intakeMissing>[0]).length > 0;
  const halted = !!stopped || thread.blocked?.code === "needs_voice" || thread.blocked?.code === "stage_failed";
  const badgeTone = scope?.scope === "failed" || halted ? "needs_attention" : scope?.scope === "intake" && !startDisabled ? "done" : scope ? "waiting_you" : "running";

  const runEnded = episodeId ? scope?.scope === "timeline" && !!scope.runId : thread.blocked?.code === "nothing_to_chat";
  const runActive = (!!scope && (scope.scope === "gate" || scope.scope === "failed"))
    || ["busy", "needs_voice", "stage_failed"].includes(thread.blocked?.code ?? "");
  const menu: MenuProps["items"] = [
    ...(episodeId ? [
      { key: "editor", label: t("chat.menu.editor") },
      { key: "preview", label: t("chat.menu.preview") },
      { key: "finalRender", label: t("chat.menu.finalRender"), disabled: !canRenderFinal || !canApprove },
      { key: "export", label: t("chat.menu.export") },
      ...(cut ? [
        { key: "rerunSurvey", label: t("chat.menu.rerunSurvey"), disabled: !canApprove },
        { key: "rerunEditPlan", label: t("chat.menu.rerunEditPlan"), disabled: !canApprove },
      ] : []),
    ] : []),
    // the run ended: go again from a step; the run going: stop it
    ...(runEnded ? [{ key: "rerunFrom", label: t("chat.menu.rerunFrom"), disabled: !canApprove }] : []),
    ...(runActive ? [{ key: "cancelRun", label: t("chat.menu.cancelRun"), disabled: !canApprove, danger: true }] : []),
    { key: "log", label: t("chat.menu.log") },
    { key: "oldScreen", label: t("chat.menu.oldScreen") },
  ];

  let body: React.ReactNode = null;
  if (draft !== null && editKind) {
    body = <StepDocEditor kind={editKind} value={draft} onChange={setDraft} productionId={productionId} episodeId={episodeId} />;
  } else if ((isSurvey || isEditPlan) && doc) {
    body = <StepDocBody kind={isSurvey ? "survey" : "edit_plan"} doc={doc} previous={previous} productionId={productionId} episodeId={episodeId} />;
  } else if (ended) {
    body = (
      <>
        {stopped ? <><Problems problems={stopped.problems} /><p className="chat-doc__note">{t("chat.result.renderStopped")}</p></> : null}
        <EpisodeOutputs productionId={productionId} episodeId={episodeId!} />
      </>
    );
  } else if (isTimeline && doc) {
    const pending = thread.current?.pendingApply ? thread.turns.find((x) => x.id === thread.current?.turnId) : undefined;
    body = <TimelineResult productionId={productionId} episodeId={episodeId!} timeline={doc as StoredTimeline}
      proposal={(pending?.proposal as { timeline?: StoredTimeline } | undefined)?.timeline ?? null} />;
  } else if (kind && doc) {
    body = (
      <>
        {scope?.scope === "failed" ? <Problems problems={thread.current?.problems ?? []} /> : null}
        <DocView kind={kind} doc={doc} previous={previous} names={folderNames(thread)} />
        {episodeId && scope?.stageKey === KIT_GATE ? (
          <KitThumbnails productionId={productionId} episodeId={episodeId} canEdit={canApprove}
            ideas={(doc as { thumbnails?: { asset_id: string; text: string }[] }).thumbnails ?? []} />
        ) : null}
        {scope?.scope === "intake" ? (
          <ProductionAudioPanel productionId={productionId} canEdit={canApprove} onChanged={onAudioChanged}
            suggested={(doc as { audio_links?: { voice?: string | null; music?: string | null } }).audio_links} />
        ) : null}
      </>
    );
  } else if (scope?.scope === "failed") {
    body = <><Problems problems={thread.current?.problems ?? []} /><p className="chat-doc__note">{t("chat.result.failedNoDoc")}</p></>;
  } else if (thread.blocked?.code === "needs_voice") {
    body = <ProductionAudioPanel productionId={productionId} episodeId={episodeId} canEdit={canApprove} needsVoice onChanged={onAudioChanged} />;
  } else if (thread.blocked?.code === "stage_failed") {
    body = <><Problems problems={thread.blocked.problems ?? []} /><p className="chat-doc__note">{t("chat.result.stageFailed")}</p></>;
  } else if (episodeId && (step === "render" || step === "export" || thread.blocked?.code === "nothing_to_chat")) {
    body = <EpisodeOutputs productionId={productionId} episodeId={episodeId} />;
  } else if (thread.blocked?.code === "busy") {
    body = <p className="chat-doc__note">{t("chat.result.busy", { step: step ? t(stepLabelKey(step)) : "" })}</p>;
  } else if (thread.blocked?.code === "nothing_to_chat") {
    body = <p className="chat-doc__note">{t("chat.result.allDone")}</p>;
  }

  return (
    <aside className="chat-aside" aria-label={t("chat.result.label")}>
      <div className="chat-aside__head">
        <h2>{step ? t(stepLabelKey(step)) : t("chat.result.label")}</h2>
        {badge ? <span className={`chat-badge chat-badge--${badgeTone}`}>{badge}</span> : null}
        {versioned && scope?.scope !== "intake" ? (
          <span className="chat-aside__version">{changes ? t("chat.result.versionChanges", { n, k: changes }) : t("chat.result.version", { n })}</span>
        ) : null}
      </div>
      <div className="chat-aside__body">{body}</div>
      <div className="chat-aside__foot">
        {draft !== null ? (
          <>
            <button type="button" className="chat-primary" disabled={saving} onClick={() => void saveDraft()}>{t("chat.edit.save")}</button>
            <button type="button" className="chat-card__button chat-button--secondary" onClick={() => setDraft(null)}>{t("chat.edit.cancel")}</button>
          </>
        ) : primary === "approve" && scope?.stageKey === KIT_GATE ? (
          <ApproveAndRender disabled={!!busy || !canApprove} initial={renderDefault} nodes={renderNodes}
            onConfirm={(m, node) => onPrimary("approve", { renderMachine: m, renderNodeId: node })} />
        ) : primary === "renderAgain" ? (
          <button type="button" className="chat-primary" disabled={busy || !canRenderFinal || !canApprove} onClick={() => onMenu("finalRender")}>
            {t("chat.result.primary.renderAgain")}
          </button>
        ) : primary ? (
          <button type="button" className="chat-primary" disabled={busy || startDisabled || !canApprove} onClick={() => onPrimary(primary)}>
            {t(`chat.result.primary.${primary}`)}
          </button>
        ) : <span className="chat-aside__spacer" />}
        {draft === null && canEditHere ? (
          <button type="button" className="chat-card__button chat-button--secondary" disabled={busy} onClick={() => setDraft(structuredClone(doc))}>{t("chat.edit.button")}</button>
        ) : null}
        <Dropdown menu={{ items: menu, onClick: ({ key }) => onMenu(key as MenuAction) }} trigger={["click"]} placement="topRight">
          <button type="button" className="chat-icon-button" aria-label={t("chat.menu.more")}><MoreHorizontal size={18} /></button>
        </Dropdown>
      </div>
    </aside>
  );
}
