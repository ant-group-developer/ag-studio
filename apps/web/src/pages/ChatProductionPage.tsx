import { useState } from "react";
import { App as AntApp, Drawer } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { StudioHttpError, useStudioClient, type ChatThreadView, type ChatTurn } from "../api/studio-client";
import { ChatComposer } from "../modules/chat/ChatComposer";
import { ChatShell } from "../modules/chat/ChatShell";
import { ChatThread, type ChatCard } from "../modules/chat/ChatThread";
import { ManualEditDrawer } from "../modules/chat/ManualEditDrawer";
import { ResultPane, type MenuAction, type ResultAction } from "../modules/chat/ResultPane";
import { EPISODE_STEPS, PLAN_STEPS, stepLabelKey, stepOf, stepPosition } from "../modules/chat/steps";
import { gateProblems } from "../modules/production/gate-problems";
import { LlmLogPanel } from "../modules/production/LlmLogPanel";

const MANAGES = new Set(["producer", "owner"]);
const EDITS = new Set(["editor", "producer", "owner"]);

function stillWorking(thread: ChatThreadView | undefined): boolean {
  return !!thread?.turns.some((x) => x.role === "assistant" && (x.status === "pending" || x.status === "running")) || thread?.blocked?.code === "busy";
}

/** One video, or one of its episodes (mockup screens 2–13): the chat in the middle, the result of the step on the right. */
export function ChatProductionPage() {
  const { productionId = "", episodeId } = useParams();
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const client = useStudioClient();
  const qc = useQueryClient();
  const [logOpen, setLogOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
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
  const { data: teams } = useQuery({ queryKey: ["teams", "all"], queryFn: () => client.listTeams({ page: 1, pageSize: 100 }) });
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => client.getMe(), staleTime: 5 * 60_000 });
  const role = teams?.items.find((x) => x.id === production?.teamId)?.role ?? null;
  const canManage = !!me?.isAdmin || (!!role && MANAGES.has(role));
  const canEdit = !!me?.isAdmin || (!!role && EDITS.has(role));

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["chat", productionId] });
    void qc.invalidateQueries({ queryKey: ["overview"] });
    void qc.invalidateQueries({ queryKey: ["production", productionId] });
    if (episodeId) void qc.invalidateQueries({ queryKey: ["episode", productionId, episodeId] });
  };
  const fail = (e: unknown) => {
    const problems = gateProblems(e);
    void message.error(problems.length ? problems.join("\n") : e instanceof StudioHttpError ? e.message : t("chat.page.failed"));
    refresh();
  };

  const send = useMutation({ mutationFn: (text: string) => client.sendChat(productionId, text, episodeId), onSuccess: refresh, onError: fail });
  const act = useMutation({
    mutationFn: async (a: { kind: ResultAction | ChatCard; turn?: ChatTurn }) => {
      const scope = thread?.scope;
      switch (a.kind) {
        case "approve": return client.approveChat(productionId, { stageKey: scope!.stageKey, episodeId, turnId: thread?.current?.turnId ?? null });
        case "start": return client.startProduction(productionId);
        case "apply": return client.applyChatProposal(productionId, a.turn?.id ?? thread!.current!.turnId!);
        case "retry": return client.retryChatStep(productionId, scope!.stageKey, episodeId);
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

  const onMenu = (m: MenuAction) => {
    if (m === "manual") setManualOpen(true);
    if (m === "editor" && episodeId) navigate(`/productions/${productionId}/episodes/${episodeId}/editor`);
    if (m === "preview") act.mutate({ kind: "render" });
    if (m === "export") act.mutate({ kind: "export" });
    if (m === "log") setLogOpen(true);
    if (m === "oldScreen") navigate(`/productions/${productionId}`);
  };

  const step = stepOf(thread?.scope?.stageKey ?? thread?.blocked?.stage ?? null);
  const row = episodeId ? EPISODE_STEPS : PLAN_STEPS;
  const at = stepPosition(step, row);
  const finished = thread?.blocked?.code === "nothing_to_chat";
  const title = episodeId ? (episode ? t("chat.episodeTitle", { idx: episode.idx, title: episode.title }) : "") : production?.title ?? "";
  const placeholder = thread?.blocked
    ? t(thread.blocked.code === "busy" ? "chat.page.busy" : "chat.page.finished")
    : thread?.scope?.scope === "intake" ? t("chat.page.intakePlaceholder") : t("chat.composer.placeholder");

  return (
    <ChatShell productionId={productionId} episodeId={episodeId}>
      <main className="chat-main">
        <div className="chat-page__head">
          <h1>{title}</h1>
          {episodeId ? <button type="button" className="chat-link-button" onClick={() => navigate(`/v/${productionId}`)}>{t("chat.page.backToSeries")}</button> : null}
        </div>
        {thread?.scope?.scope !== "intake" ? (
          <ol className="chat-steps" aria-label={t("chat.page.steps")}>
            {row.map((s, i) => (
              <li key={s} className={finished || i < at ? "chat-steps__done" : i === at ? "chat-steps__now" : undefined}>
                {finished || i < at ? "✓ " : `${i + 1} · `}{t(stepLabelKey(s))}
              </li>
            ))}
          </ol>
        ) : null}
        {thread ? (
          <ChatThread thread={thread} episode={!!episodeId} busyCard={act.isPending ? (act.variables?.kind as ChatCard) : null}
            onCard={(card, turn) => act.mutate({ kind: card, turn })}
            onQuickAnswer={(text) => send.mutate(text)} />
        ) : null}
        <ChatComposer value={draft} onValueChange={setDraft} disabled={!thread || !!thread.blocked || !canEdit}
          placeholder={placeholder} onSend={(text) => send.mutateAsync(text)} />
      </main>
      {thread ? (
        <ResultPane productionId={productionId} episodeId={episodeId} thread={thread} busy={act.isPending} canApprove={canManage || thread.scope?.scope === "timeline"}
          onPrimary={(a) => act.mutate({ kind: a })} onMenu={onMenu} />
      ) : null}
      <Drawer open={logOpen} onClose={() => setLogOpen(false)} width="min(900px, 100vw)" title={t("chat.menu.log")} destroyOnClose>
        <LlmLogPanel productionId={productionId} live={stillWorking(thread)} />
      </Drawer>
      {thread ? <ManualEditDrawer open={manualOpen} onClose={() => setManualOpen(false)} productionId={productionId} episodeId={episodeId} thread={thread} onSaved={refresh} /> : null}
    </ChatShell>
  );
}
