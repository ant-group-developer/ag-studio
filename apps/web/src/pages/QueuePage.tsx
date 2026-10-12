import { Alert, App as AntApp } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useStudioClient, type QueueItem } from "../api/studio-client";
import { useWorkspaceClient } from "../api/workspace-client";
import { AssistantNameForm } from "../modules/admin/AssistantNameForm";
import { ClaudeSettingsForm } from "../modules/admin/ClaudeSettingsForm";
import { ActivityRow } from "../modules/agent-chat/ActivityButton";
import { useAiTranslation } from "../modules/common/assistant-name";
import { useNow } from "../modules/common/sse";
import { WorkspaceShell } from "../modules/workspace/WorkspaceShell";
import "../modules/admin/admin.css";

/**
 * The Queue: everything running in the projects a person can see (agent turns, the tools they call, jobs with their
 * farm machine), with Stop; Claude calls against the cap; the farm's machines. A Studio admin also names the AI and
 * sets the cap here, and is told when YouTube blocks downloads from the Studio server.
 */
export function QueuePage() {
  const { t, i18n } = useAiTranslation();
  const { message } = AntApp.useApp();
  const client = useStudioClient();
  const ws = useWorkspaceClient();
  const qc = useQueryClient();
  const { data: queue } = useQuery({ queryKey: ["queue"], queryFn: () => client.getQueue(), refetchInterval: 5000 });
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => client.getMe(), staleTime: 5 * 60_000 });
  const items = queue?.items ?? [];
  const now = useNow(1000, items.length > 0);
  const when = (iso: string) => new Date(iso).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" });
  const stop = useMutation({
    mutationFn: async (a: QueueItem): Promise<void> => { if (a.kind === "job") await ws.cancelJob(a.projectId, a.id); else await ws.cancelTurn(a.threadId!, a.id); },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["queue"] }),
    onError: () => void message.error(t("ws.queue.stopFailed")),
  });

  return (
    <WorkspaceShell crumbs={[{ label: t("ws.queue.title") }]}>
      <main className="ws-page">
        <div className="ws-page__inner">
          <div className="ws-page__head"><h1 className="ws-page__title">{t("ws.queue.title")}</h1></div>
          {me?.isAdmin && queue?.youtube ? (
            <Alert type="warning" showIcon className="ws-queue__youtube"
              message={t("ws.queue.youtubeBlocked", { since: when(queue.youtube.blockedAt), until: when(queue.youtube.until) })}
              description={t("ws.queue.youtubeBlockedHint")} />
          ) : null}
          <div className="ws-admin">
            <div className="ws-admin__main">
              <section className="ws-admin__section" aria-label={t("ws.queue.running")}>
                <div className="ws-admin__head">
                  <h2>{t("ws.queue.running")}</h2>
                  {queue ? <span>{t("ws.admin.claude.now", { running: queue.claude.running, max: queue.claude.max })}</span> : null}
                </div>
                {items.length ? (
                  <ul className="ws-activity">
                    {items.map((a) => (
                      <ActivityRow key={a.id} a={a} projectId={a.projectId} projectName={a.parentId ? undefined : a.projectName} now={now} onStop={(x) => stop.mutate(x as QueueItem)} />
                    ))}
                  </ul>
                ) : queue ? <p className="ws-admin__note">{t("ws.queue.none")}</p> : null}
                {queue?.hidden ? <p className="ws-admin__note">{t("ws.queue.hidden", { n: queue.hidden })}</p> : null}
              </section>
            </div>
            <aside className="ws-admin__aside" aria-label={t("ws.queue.title")}>
              {me?.isAdmin ? <><h2>{t("ws.admin.assistant.title")}</h2><AssistantNameForm /></> : null}
              <h2>{t("ws.admin.claude.title")}</h2>
              {queue ? <ClaudeSettingsForm usage={queue.claude} isAdmin={me?.isAdmin ?? false} /> : null}
              <h2>{t("ws.music.title")}</h2>
              <Link to="/music">{t("ws.music.open")}</Link>
              <h2>{t("ws.queue.farmMachines")}</h2>
              {queue && !queue.farm.ok ? <p className="ws-admin__note ws-admin__bad">{t("ws.queue.farmDown", { error: queue.farm.error })}</p> : null}
              {queue?.machines?.length ? (
                <ul className="ws-admin__list">
                  {queue.machines.map((m) => (
                    <li key={m.id}>
                      <strong>{m.name}</strong>{m.gpus.some((g) => g.nvenc) ? " · NVENC" : m.gpus.length ? " · GPU" : ""}
                      <div className="ws-admin__note">{t("ws.queue.machineLine", { state: t(m.online ? "ws.queue.online" : "ws.queue.offline"), jobs: m.running_jobs })}</div>
                    </li>
                  ))}
                </ul>
              ) : queue?.farm.ok ? <p className="ws-admin__note">{t("ws.queue.noMachines")}</p> : null}
            </aside>
          </div>
        </div>
      </main>
    </WorkspaceShell>
  );
}
