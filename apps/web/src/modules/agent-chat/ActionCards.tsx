import { Alert, App as AntApp, Button, Tag, Tooltip } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient, type ActionView, type TeamRoleName } from "../../api/workspace-client";
import { Markdown } from "../files/Markdown";
import { relativeTime } from "../workspace/time";

/**
 * Work with a real effect the agent proposed in this chat (render the final video, export for Premiere, delete a
 * video, a large crawl, download reference videos), waiting for a person: what and why, the role it needs, Confirm or
 * Reject. Decided cards leave the list; the chat says who decided. While YouTube blocks the Studio server, a reference
 * download card says it would most likely fail.
 */
export function ActionCards({ projectId, threadId, canDecide }: { projectId: string; threadId: string; canDecide: (needs: TeamRoleName) => boolean }) {
  const { t, i18n } = useTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["actions", threadId], queryFn: () => client.listActions(threadId), refetchInterval: 30_000 });
  const decide = useMutation({
    mutationFn: (p: { a: ActionView; confirm: boolean }) => (p.confirm ? client.confirmAction(projectId, p.a.id) : client.rejectAction(projectId, p.a.id)),
    onSettled: () => {
      for (const k of [["actions", threadId], ["thread", threadId], ["activity", projectId], ["jobs", projectId]]) void qc.invalidateQueries({ queryKey: k });
    },
    onError: (e) => void message.error(
      e instanceof StudioHttpError && e.code === "expired" ? t("ws.actions.expired") : e instanceof StudioHttpError ? e.message : t("ws.actions.failed"),
    ),
  });
  const open = (data?.actions ?? []).filter((a) => a.status === "proposed");
  const blocked = data?.youtubeBlocked ?? null;
  if (!open.length) return null;
  return (
    <section className="ws-chat__actions" aria-label={t("ws.actions.title")}>
      {open.map((a) => {
        const allowed = canDecide(a.needs);
        const busy = decide.isPending && decide.variables?.a.id === a.id;
        return (
          <div key={a.id} className="ws-action" role="group" aria-label={a.title}>
            <div className="ws-action__head">
              <ShieldCheck size={15} aria-hidden />
              <strong>{a.title}</strong>
              <Tag>{t(`ws.actions.kind.${a.kind}`)}</Tag>
            </div>
            <div className="ws-action__why"><Markdown text={a.summary} /></div>
            {a.kind === "reference_download" && blocked ? (
              <Alert type="warning" showIcon className="ws-action__warn"
                message={t(blocked.where === "farm" ? "ws.actions.youtubeBlockedFarm" : "ws.actions.youtubeBlocked", { since: new Date(blocked.blockedAt).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" }) })} />
            ) : null}
            <div className="ws-action__meta">
              {a.revision !== null ? `${t("ws.actions.revision", { revision: a.revision })} · ` : ""}
              {t("ws.actions.needs", { role: t(`roles.${a.needs}`) })} · {t("ws.actions.expires", { when: relativeTime(a.expiresAt, i18n.language) })}
            </div>
            <div className="ws-action__buttons">
              <Tooltip title={allowed ? undefined : t("ws.actions.notAllowed", { role: t(`roles.${a.needs}`) })}>
                <Button type="primary" size="small" disabled={!allowed} loading={busy && decide.variables?.confirm} onClick={() => decide.mutate({ a, confirm: true })}>
                  {t("ws.actions.confirm")}
                </Button>
              </Tooltip>
              <Button size="small" disabled={!canDecide("editor")} loading={busy && !decide.variables?.confirm} onClick={() => decide.mutate({ a, confirm: false })}>
                {t("ws.actions.reject")}
              </Button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
