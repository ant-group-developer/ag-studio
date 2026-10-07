import { useState } from "react";
import { Dropdown, Popover, type MenuProps } from "antd";
import { MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { EditPlan, StoredTimeline, StudioSurvey } from "@harness/contracts";
import type { ChatThreadView, ChatTurn, RenderMachine } from "../../api/studio-client";
import { RenderMachinePicker } from "../render/RenderMachinePicker";
import { KIT_GATE, type CardOptions } from "./ChatThread";
import { diffDoc } from "./diff-doc";
import { isCutWorkflow, stepLabelKey, stepOf } from "./steps";
import { DocView } from "./views/DocView";
import { docKindOf } from "./views/doc-specs";
import { EpisodeOutputs } from "./views/EpisodeOutputs";
import { HAND_EDITABLE } from "./ManualEditDrawer";
import { EditPlanResult } from "./views/EditPlanResult";
import { SurveyResult } from "./views/SurveyResult";
import { TimelineResult } from "./views/TimelineResult";

export type ResultAction = "approve" | "start" | "apply" | "retry";
export type MenuAction = "manual" | "editor" | "preview" | "finalRender" | "export" | "rerunSurvey" | "rerunEditPlan" | "log" | "oldScreen";

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
  /** ⋯ → Render bản cuối… can start now (the episode is not producing). */
  canRenderFinal?: boolean | undefined;
  /** The episode run's workflow (`id@version`). */
  workflow?: string | null | undefined;
}

/** Duyệt on the YouTube kit: it starts the final render, so it confirms the machine type first (spec §2.5, §3.4). */
function ApproveAndRender({ disabled, initial, onConfirm }: { disabled: boolean; initial: RenderMachine; onConfirm: (m: RenderMachine) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [machine, setMachine] = useState<RenderMachine>(initial);
  const content = (
    <div className="chat-card chat-card--column chat-card--popover">
      <span>{t("chat.cards.approveRender.question")}</span>
      <RenderMachinePicker value={machine} onChange={setMachine} />
      <button type="button" className="chat-card__button" onClick={() => { setOpen(false); onConfirm(machine); }}>{t("chat.cards.approveRender.button")}</button>
    </div>
  );
  return (
    <Popover open={open} onOpenChange={(o) => { if (o) setMachine(initial); setOpen(o); }} trigger="click" placement="topLeft" content={content}>
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
  const { t } = useTranslation();
  if (!problems.length) return null;
  return (
    <section className="chat-reply__problems">
      <p>{t("chat.result.problems")}</p>
      <ol>{problems.map((p, i) => <li key={i}>{p.message}</li>)}</ol>
    </section>
  );
}

/** The result column (spec local-chat §2.3–2.4): the step's document, readable, changes marked; one main button; ⋯. */
export function ResultPane({ productionId, episodeId, thread, onPrimary, onMenu, busy, canApprove = true, renderDefault = "any", canRenderFinal = false, workflow }: Props) {
  const { t } = useTranslation();
  const scope = thread.scope;
  const stageKey = scope?.stageKey ?? thread.blocked?.stage ?? null;
  const step = stepOf(stageKey, workflow);
  const kind = scope ? docKindOf(scope.stageKey) : null;
  const isTimeline = !!episodeId && (scope?.stageKey === "approve-timeline" || scope?.scope === "timeline");
  const cut = !!episodeId && isCutWorkflow(workflow);
  // shot-cut episodes (phase 5): the scene selection shot by shot
  const isSurvey = !!episodeId && scope?.scope === "gate" && scope.stageKey === "approve-survey";
  const isEditPlan = !!episodeId && scope?.scope === "gate" && scope.stageKey === "approve-edit-plan";
  const versioned = !!kind || isSurvey || isEditPlan;
  const { n, previous } = versionOf(thread);
  const doc = thread.current?.document;
  const changes = previous !== undefined && versioned ? diffDoc(previous, doc).length : 0;

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
  } else if (scope?.scope === "timeline") {
    primary = thread.current?.pendingApply ? "apply" : null;
  } else if (thread.blocked?.code === "busy") {
    badge = t("chat.result.running");
  }
  const startDisabled = primary === "start" && intakeMissing(doc as Parameters<typeof intakeMissing>[0]).length > 0;
  const badgeTone = scope?.scope === "failed" ? "needs_attention" : scope?.scope === "intake" && !startDisabled ? "done" : scope ? "waiting_you" : "running";

  const menu: MenuProps["items"] = [
    ...(kind && HAND_EDITABLE.has(kind) && scope?.scope === "gate" ? [{ key: "manual", label: t("chat.menu.manual") }] : []),
    ...(episodeId ? [
      { key: "editor", label: t("chat.menu.editor") },
      { key: "preview", label: t("chat.menu.preview") },
      { key: "finalRender", label: t("chat.menu.finalRender"), disabled: !canRenderFinal || !canApprove },
      // Premiere cannot read trims, transitions or narration yet (phase 4)
      ...(cut ? [] : [{ key: "export", label: t("chat.menu.export") }]),
      ...(cut ? [
        { key: "rerunSurvey", label: t("chat.menu.rerunSurvey"), disabled: !canApprove },
        { key: "rerunEditPlan", label: t("chat.menu.rerunEditPlan"), disabled: !canApprove },
      ] : []),
    ] : []),
    { key: "log", label: t("chat.menu.log") },
    { key: "oldScreen", label: t("chat.menu.oldScreen") },
  ];

  let body: React.ReactNode = null;
  if (isSurvey && doc) {
    body = <SurveyResult productionId={productionId} episodeId={episodeId!} survey={doc as StudioSurvey} previous={previous as StudioSurvey | undefined} />;
  } else if (isEditPlan && doc) {
    body = <EditPlanResult plan={doc as EditPlan} previous={previous as EditPlan | undefined} />;
  } else if (isTimeline && doc) {
    const pending = thread.current?.pendingApply ? thread.turns.find((x) => x.id === thread.current?.turnId) : undefined;
    body = <TimelineResult productionId={productionId} episodeId={episodeId!} timeline={doc as StoredTimeline}
      proposal={(pending?.proposal as { timeline?: StoredTimeline } | undefined)?.timeline ?? null} />;
  } else if (kind && doc) {
    body = (
      <>
        {scope?.scope === "failed" ? <Problems problems={thread.current?.problems ?? []} /> : null}
        <DocView kind={kind} doc={doc} previous={previous} names={folderNames(thread)} />
      </>
    );
  } else if (scope?.scope === "failed") {
    body = <><Problems problems={thread.current?.problems ?? []} /><p className="chat-doc__note">{t("chat.result.failedNoDoc")}</p></>;
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
        {primary === "approve" && scope?.stageKey === KIT_GATE ? (
          <ApproveAndRender disabled={!!busy || !canApprove} initial={renderDefault} onConfirm={(m) => onPrimary("approve", { renderMachine: m })} />
        ) : primary ? (
          <button type="button" className="chat-primary" disabled={busy || startDisabled || !canApprove} onClick={() => onPrimary(primary)}>
            {t(`chat.result.primary.${primary}`)}
          </button>
        ) : <span className="chat-aside__spacer" />}
        <Dropdown menu={{ items: menu, onClick: ({ key }) => onMenu(key as MenuAction) }} trigger={["click"]} placement="topRight">
          <button type="button" className="chat-icon-button" aria-label={t("chat.menu.more")}><MoreHorizontal size={18} /></button>
        </Dropdown>
      </div>
    </aside>
  );
}
