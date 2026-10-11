import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useWorkspaceClient, type Activity, type JobView } from "../../api/workspace-client";
import { JobList } from "./JobList";
import "./inputs.css";

/** An activity row of a job as the card shows it. */
function asJob(a: Activity, projectId: string): JobView {
  return {
    id: a.id, projectId, videoId: a.videoId, threadId: a.threadId, kind: a.jobKind ?? "prepare_asset", status: a.status === "running" ? "running" : "queued",
    title: a.title, request: null, result: null, error: null, phase: a.detail, progress: a.progress, etaSeconds: a.etaSeconds, nodeId: a.node,
    cancelRequested: !a.cancellable, createdBy: "", createdAt: a.startedAt ?? "", startedAt: a.startedAt, finishedAt: null,
  };
}

/**
 * The background jobs this chat started (the agent asked to prepare videos, render…), above the message box while
 * they run: who works on each, how far, time spent and left, Stop; many of them fold into a summary. When one ends,
 * Studio writes it in the chat.
 */
export function ThreadJobs({ projectId, threadId, canStop }: { projectId: string; threadId: string; canStop: boolean }) {
  const { t } = useTranslation();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["activity", projectId], queryFn: () => client.getActivity(projectId), refetchInterval: 5000 });
  const jobs = (data?.activity ?? []).filter((a) => a.kind === "job" && a.threadId === threadId).map((a) => asJob(a, projectId));
  const stop = useMutation({
    mutationFn: (j: JobView) => client.cancelJob(projectId, j.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["activity", projectId] });
      void qc.invalidateQueries({ queryKey: ["jobs", projectId] });
    },
  });
  if (!jobs.length) return null;
  return (
    <section className="ws-chat__jobs" aria-label={t("ws.jobs.title")}>
      <JobList jobs={jobs} onStop={canStop ? (x) => stop.mutate(x) : undefined} stopping={stop.isPending ? stop.variables?.id ?? null : null} />
    </section>
  );
}
