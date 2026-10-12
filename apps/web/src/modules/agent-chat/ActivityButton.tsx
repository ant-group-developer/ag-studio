import { Badge, Popover } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity as ActivityIcon, Loader2, Square } from "lucide-react";
import { Link } from "react-router-dom";
import { useWorkspaceClient, type Activity } from "../../api/workspace-client";
import { useAiTranslation } from "../common/assistant-name";
import { withoutIds } from "../common/no-ids";
import { useNow } from "../common/sse";
import { clock } from "../workspace/time";
import { phaseLabel, toolLabel } from "./labels";

/** One thing running (a turn, a tool it calls, a job): who, what, since when, time left, Stop. `projectName`: shown
 * on the Queue, where rows of many projects meet. */
export function ActivityRow({ a, projectId, projectName, now, onStop }: {
  a: Activity; projectId: string; projectName?: string; now: number; onStop: (a: Activity) => void;
}) {
  const { t } = useAiTranslation();
  const elapsed = a.startedAt ? clock((now - Date.parse(a.startedAt)) / 1000) : null;
  const where = a.videoId ? `/p/${projectId}/v/${a.videoId}` : a.threadId ? `/p/${projectId}/c/${a.threadId}` : `/p/${projectId}`;
  const what = a.kind === "agent_turn"
    ? (a.status === "waiting" ? t("ws.activity.waiting") : a.status === "rate_limited" ? t("ws.activity.rateLimited") : phaseLabel(t, a.phase, []))
    : a.kind === "tool_call" ? toolLabel(t, a.title) : withoutIds(a.title, t("ws.inputs.unnamedVideo"));
  return (
    <li className={`ws-activity__row${a.parentId ? " ws-activity__row--child" : ""}`}>
      {a.status === "running" ? <Loader2 size={13} className="ws-spin" aria-hidden /> : <span className="ws-dot ws-dot--wait" aria-hidden />}
      <div className="ws-activity__text">
        <div><strong>{a.kind === "agent_turn" ? t("ws.chat.agentName") : a.kind === "tool_call" ? t("ws.activity.tool") : t("ws.activity.job")}</strong> · {what}</div>
        {a.kind === "job" ? (
          <div className="ws-activity__detail">
            {a.status === "waiting" ? t("ws.activity.queued") : a.detail ?? t("ws.activity.starting")}
            {a.progress !== null ? ` · ${Math.round(a.progress * 100)}%` : ""}
          </div>
        ) : null}
        {!a.parentId && (a.threadTitle || projectName) ? (
          <Link to={where} className="ws-activity__where">{[projectName, a.threadTitle].filter(Boolean).join(" · ")}</Link>
        ) : null}
      </div>
      {elapsed ? <span className="ws-activity__time">{elapsed}{a.etaSeconds ? ` · ${t("ws.activity.eta", { eta: clock(a.etaSeconds) })}` : ""}</span> : null}
      {a.cancellable ? (
        <button type="button" className="ws-icon-button" aria-label={t("ws.chat.stop")} title={t("ws.chat.stop")} onClick={() => onStop(a)}><Square size={12} /></button>
      ) : null}
    </li>
  );
}

/** Header: how many things run in the project now; opens the list (who, what, since when, Stop). */
export function ActivityButton({ projectId }: { projectId: string }) {
  const { t } = useAiTranslation();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["activity", projectId], queryFn: () => client.getActivity(projectId), refetchInterval: 5000 });
  const list = data?.activity ?? [];
  const top = list.filter((a) => !a.parentId);
  const now = useNow(1000, top.length > 0);
  const stop = useMutation({
    mutationFn: async (a: Activity): Promise<void> => { if (a.kind === "job") await client.cancelJob(projectId, a.id); else await client.cancelTurn(a.threadId!, a.id); },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["activity", projectId] });
      void qc.invalidateQueries({ queryKey: ["jobs", projectId] });
    },
  });
  const content = top.length === 0 ? <p className="ws-activity__empty">{t("ws.activity.none")}</p> : (
    <ul className="ws-activity">
      {list.map((a) => <ActivityRow key={a.id} a={a} projectId={projectId} now={now} onStop={(x) => stop.mutate(x)} />)}
    </ul>
  );
  return (
    <Popover content={content} title={t("ws.activity.title")} trigger="click" placement="bottomRight">
      <button type="button" className="ws-icon-button" aria-label={t("ws.activity.button", { count: top.length })}>
        <Badge count={top.length} size="small" offset={[4, -2]}><ActivityIcon size={16} /></Badge>
        <span>{t("ws.activity.short")}</span>
      </button>
    </Popover>
  );
}
