import { useEffect, useState } from "react";
import { App as AntApp, Drawer } from "antd";
import { ArrowDown, ArrowLeft } from "lucide-react";
import type { EpisodeRerunGate } from "../api/studio-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { StudioHttpError, useStudioClient, type ChatThreadView, type ChatTurn, type RenderMachine } from "../api/studio-client";
import { ChatComposer } from "../modules/chat/ChatComposer";
import { ChatShell } from "../modules/chat/ChatShell";
import { ChatThread, type CardOptions, type ChatCard } from "../modules/chat/ChatThread";
import { StepPane } from "../modules/chat/StepPane";
import { useStickToBottom } from "../modules/chat/use-stick-to-bottom";
import { ResultPane, type MenuAction, type ResultAction } from "../modules/chat/ResultPane";
import { episodeStepsFor, isCutWorkflow, PLAN_STEPS, STEP_SHOWS, stepLabelKey, stepOf, stepPosition, type ChatStep } from "../modules/chat/steps";
import { gateProblems } from "../modules/production/gate-problems";
import { LlmLogPanel } from "../modules/production/LlmLogPanel";
import { RenderFinalModal } from "../modules/render/RenderFinalModal";
import { useAiTranslation } from "../modules/common/assistant-name";

const MANAGES = new Set(["producer", "owner"]);

/** "cắt theo shot · khoảng 10 phút · có lời dẫn" from the episode's plan (null for a whole-video episode). */
export function cutHeader(plan: unknown, t: (k: string, o?: Record<string, unknown>) => string): string | null {
  const p = (plan ?? {}) as { edit_style?: string; target_seconds?: number; narration?: "tts" | "original" | "none" };
  if (p.edit_style !== "cut") return null;
  const s = p.target_seconds ?? 0;
  const length = s >= 90 ? t("chat.cut.minutes", { n: Math.round(s / 60) }) : t("chat.cut.seconds", { n: s });
  return t("chat.cut.header", { length, narration: t(`chat.cut.narration.${p.narration ?? "none"}`) });
}
const EDITS = new Set(["editor", "producer", "owner"]);

function stillWorking(thread: ChatThreadView | undefined): boolean {
  return !!thread?.turns.some((x) => x.role === "assistant" && (x.status === "pending" || x.status === "running")) || thread?.blocked?.code === "busy";
}

/** One video, or one of its episodes (mockup screens 2–13): the chat in the middle, the result of the step on the right. */
export function ChatProductionPage() {
  const { productionId = "", episodeId } = useParams();
  const { t } = useAiTranslation();
  const { message, modal } = AntApp.useApp();
  const navigate = useNavigate();
  const client = useStudioClient();
  const qc = useQueryClient();
  const [logOpen, setLogOpen] = useState(false);
  // a step looked at again in the result column (null: the step the video is at)
  const [viewing, setViewing] = useState<ChatStep | null>(null);
  useEffect(() => { setViewing(null); }, [productionId, episodeId]);
  const [finalOpen, setFinalOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const threadKey = ["chat", productionId, episodeId ?? null];
  const { data: thread } = useQuery({
    queryKey: threadKey,
    queryFn: () => client.getChatThread(productionId, episodeId),
    refetchInterval: (q) => (stillWorking(q.state.data) ? 2000 : 5000),
  });
  const { data: production } = useQuery({ queryKey: ["production", productionId], queryFn: () => client.getProduction(productionId) });
  const { data: episode } = useQuery({
    queryKey: ["episode", productionId, episodeId], queryFn: () => client.getEpisode(productionId, episodeId!), enabled: !!episodeId,
  });
  const workflow = episode?.workflow ?? null;
  const cut = isCutWorkflow(workflow);
  // the footage step's divider counts the videos and shots (frames show footage: only with the footage scope)
  const { data: shots } = useQuery({
    queryKey: ["episode-shots", productionId, episodeId], queryFn: () => client.getEpisodeShots(productionId, episodeId!),
    enabled: !!episodeId && cut && !episode?.footageHidden, retry: false,
  });
  const notes: Partial<Record<ChatStep, string>> = shots?.shots.length
    ? { footage: t("chat.cut.footageNote", { videos: new Set(shots.shots.map((x) => x.sourceId)).size, shots: shots.shots.length }) }
    : {};
  const { data: teams } = useQuery({ queryKey: ["teams", "all"], queryFn: () => client.listTeams({ page: 1, pageSize: 100 }) });
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => client.getMe(), staleTime: 5 * 60_000 });
  const role = teams?.items.find((x) => x.id === production?.teamId)?.role ?? null;
  const canManage = !!me?.isAdmin || (!!role && MANAGES.has(role));
  const canEdit = !!me?.isAdmin || (!!role && EDITS.has(role));

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["chat", productionId] });
    void qc.invalidateQueries({ queryKey: ["overview"] });
    void qc.invalidateQueries({ queryKey: ["production", productionId] });
    void qc.invalidateQueries({ queryKey: ["step-doc", productionId] });
    if (episodeId) void qc.invalidateQueries({ queryKey: ["episode", productionId, episodeId] });
    if (episodeId) void qc.invalidateQueries({ queryKey: ["episode-shots", productionId, episodeId] });
  };
  const fail = (e: unknown) => {
    const problems = gateProblems(e);
    void message.error(problems.length ? problems.join("\n") : e instanceof StudioHttpError ? e.message : t("chat.page.failed"));
    refresh();
  };

  const send = useMutation({ mutationFn: (text: string) => client.sendChat(productionId, text, episodeId), onSuccess: refresh, onError: fail });
  const manual = useMutation({
    mutationFn: (m: { stageKey: string; document: unknown }) => client.saveManualEdit(productionId, { ...m, episodeId }),
    onSuccess: () => { void message.success(t("chat.edit.saved")); refresh(); },
    onError: fail,
  });
  const act = useMutation({
    mutationFn: async (a: { kind: ResultAction | ChatCard; turn?: ChatTurn; options?: CardOptions | undefined }) => {
      const scope = thread?.scope;
      switch (a.kind) {
        case "approve": return client.approveChat(productionId, {
          stageKey: scope!.stageKey, episodeId, turnId: thread?.current?.turnId ?? null,
          ...(a.options?.renderMachine ? { renderMachine: a.options.renderMachine } : {}),
        });
        case "start": return client.startProduction(productionId);
        case "apply": return client.applyChatProposal(productionId, a.turn?.id ?? thread!.current!.turnId!);
        case "retry": return client.retryChatStep(productionId, scope!.stageKey, episodeId);
        case "rerunStep": {
          const stage = thread!.blocked!.stage!;
          return episodeId ? client.retryEpisodeStage(productionId, episodeId, stage) : client.retryStage(productionId, stage);
        }
        case "render": {
          const tl = await client.getTimeline(productionId, episodeId!);
          return client.renderPreview(productionId, episodeId!, tl.revision);
        }
        case "export": return client.exportPremiere(productionId, episodeId!, "proxy");
      }
    },
    onSuccess: (_r, a) => {
      if (a.kind === "render") void message.success(t("chat.page.previewStarted"));
      if (a.kind === "export") void message.success(t("chat.page.exportStarted"));
      void qc.invalidateQueries({ queryKey: ["preview", productionId, episodeId] });
      refresh();
    },
    onError: fail,
  });

  const renderFinal = useMutation({
    mutationFn: (machine: RenderMachine) => client.rerenderEpisode(productionId, episodeId!, machine),
    onSuccess: (r) => {
      setFinalOpen(false);
      void message.success(t(r.from === "render-final" || r.from === "freeze-timeline" ? "chat.render.started" : "chat.render.startedAfterApproval"));
      refresh();
    },
    onError: fail,
  });

  const rerun = useMutation({
    mutationFn: (stage: EpisodeRerunGate) => client.rerunEpisodeFrom(productionId, episodeId!, stage),
    onSuccess: () => { void message.success(t("chat.rerun.started")); refresh(); },
    onError: fail,
  });
  const confirmRerun = (stage: EpisodeRerunGate) => {
    const which = stage === "approve-survey" ? "survey" : "editPlan";
    void modal.confirm({
      title: t(`chat.rerun.${which}.title`), content: t(`chat.rerun.${which}.body`),
      okText: t("chat.rerun.ok"), cancelText: t("chat.rerun.cancel"), onOk: () => rerun.mutateAsync(stage),
    });
  };

  const onMenu = (m: MenuAction) => {
    if (m === "rerunSurvey" && episodeId) confirmRerun("approve-survey");
    if (m === "rerunEditPlan" && episodeId) confirmRerun("approve-edit-plan");
    if (m === "editor" && episodeId) navigate(`/productions/${productionId}/episodes/${episodeId}/editor`);
    if (m === "preview") act.mutate({ kind: "render" });
    if (m === "finalRender") setFinalOpen(true);
    if (m === "export") act.mutate({ kind: "export" });
    if (m === "log") setLogOpen(true);
    if (m === "oldScreen") navigate(`/productions/${productionId}`);
  };

  // An episode whose run ended chats about its timeline, but its chips show where the run is: all done when it is
  // ready, else the step it stopped at (a failed render).
  const ended = !!episodeId && thread?.scope?.scope === "timeline" && !!episode?.run;
  const step = stepOf((ended && episode?.status !== "ready" ? episode?.currentStage : null) ?? thread?.scope?.stageKey ?? thread?.blocked?.stage ?? null, workflow);
  const row = episodeId ? episodeStepsFor(workflow) : PLAN_STEPS;
  const header = episodeId && episode ? cutHeader(episode.plan, t) : null;
  const at = stepPosition(step, row);
  const finished = thread?.blocked?.code === "nothing_to_chat" || (ended && episode?.status === "ready");
  const looking = viewing && viewing !== step ? viewing : null;
  const shown = looking ?? step;
  const title = episodeId ? (episode ? t("chat.episodeTitle", { idx: episode.idx, title: episode.title }) : "") : production?.title ?? "";
  const last = thread?.turns.at(-1);
  const stick = useStickToBottom(`${productionId}/${episodeId ?? ""}`, `${thread?.turns.length ?? 0}:${last?.id ?? ""}:${last?.status ?? ""}:${thread?.scope?.stageKey ?? ""}`);
  const placeholder = thread?.blocked
    ? t(thread.blocked.code === "busy" ? "chat.page.busy" : thread.blocked.code === "needs_voice" ? "chat.page.needsVoice"
      : thread.blocked.code === "stage_failed" ? "chat.page.stageFailed" : "chat.page.finished")
    : thread?.scope?.scope === "intake" ? t("chat.page.intakePlaceholder") : t("chat.composer.placeholder");

  return (
    <ChatShell productionId={productionId} episodeId={episodeId}>
      <main className="chat-main chat-main--thread">
        <div className="chat-main__head">
          <div className="chat-main__inner">
            <div className="chat-page__head">
              {episodeId ? (
                <button type="button" className="chat-page__back" onClick={() => navigate(`/v/${productionId}`)}>
                  <ArrowLeft size={14} aria-hidden />{t("chat.page.backToSeries")}
                </button>
              ) : null}
              <h1>{title}</h1>
            </div>
            {header ? <p className="chat-page__sub">{header}</p> : null}
            {thread?.scope?.scope !== "intake" ? (
              <ol className="chat-steps" aria-label={t("chat.page.steps")}>
                {row.map((s, i) => {
                  const cls = [finished || i < at ? "chat-steps__done" : i === at ? "chat-steps__now" : "", shown === s ? "chat-steps__open" : ""].filter(Boolean).join(" ") || undefined;
                  const text = <>{finished || i < at ? "✓ " : `${i + 1} · `}{t(stepLabelKey(s))}</>;
                  // a step passed or the one the video is at opens its document on the right
                  const open = (finished || i <= at) && !!STEP_SHOWS[s];
                  return (
                    <li key={s} className={cls}>
                      {open ? (
                        <button type="button" aria-pressed={shown === s} aria-label={t("chat.stepDoc.viewStep", { step: t(stepLabelKey(s)) })}
                          onClick={() => setViewing(s === step ? null : s)}>{text}</button>
                      ) : text}
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </div>
        </div>
        <div className="chat-main__scroll" ref={stick.ref} onScroll={stick.onScroll}>
          <div className="chat-main__inner">
            {thread ? (
              <ChatThread thread={thread} episode={!!episodeId} workflow={workflow} notes={notes} busyCard={act.isPending ? (act.variables?.kind as ChatCard) : null}
                renderDefault={episode?.render?.defaultMachine}
                onCard={(card, turn, options) => (card === "renderFinal" ? setFinalOpen(true) : act.mutate({ kind: card, turn, options }))}
                onQuickAnswer={(text) => { stick.toBottom(); send.mutate(text); }}
                onViewStep={(s) => setViewing(s === step ? null : s)} />
            ) : null}
          </div>
        </div>
        <div className="chat-main__foot">
          {!stick.atBottom ? (
            <button type="button" className="chat-jump" onClick={stick.toBottom}><ArrowDown size={14} aria-hidden />{t("chat.nav.latest")}</button>
          ) : null}
          <div className="chat-main__inner">
            <ChatComposer value={draft} onValueChange={setDraft} disabled={!thread || !!thread.blocked || !canEdit}
              placeholder={placeholder} onSend={(text) => { stick.toBottom(); return send.mutateAsync(text); }} />
          </div>
        </div>
      </main>
      {looking ? (
        <StepPane productionId={productionId} episodeId={episodeId} step={looking} workflow={workflow} canManage={canManage} canEdit={canEdit}
          onBack={() => setViewing(null)} onChanged={refresh} onOpenEditor={() => onMenu("editor")} />
      ) : thread ? (
        <ResultPane productionId={productionId} episodeId={episodeId} thread={thread} busy={act.isPending} canApprove={canManage || thread.scope?.scope === "timeline"}
          renderDefault={episode?.render?.defaultMachine} canRenderFinal={!!episode?.render && episode.render.restartFrom !== null} workflow={workflow}
          onPrimary={(a, options) => act.mutate({ kind: a, options })} onMenu={onMenu}
          onSaveEdit={(stageKey, document) => manual.mutateAsync({ stageKey, document })} onAudioChanged={refresh} />
      ) : null}
      <Drawer open={logOpen} onClose={() => setLogOpen(false)} width="min(900px, 100vw)" title={t("chat.menu.log")} destroyOnClose>
        <LlmLogPanel productionId={productionId} live={stillWorking(thread)} />
      </Drawer>
      {episode?.render ? (
        <RenderFinalModal open={finalOpen} render={episode.render} busy={renderFinal.isPending} onClose={() => setFinalOpen(false)}
          onConfirm={(m) => renderFinal.mutate(m)} />
      ) : null}
    </ChatShell>
  );
}
