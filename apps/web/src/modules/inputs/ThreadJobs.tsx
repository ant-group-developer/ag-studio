import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useWorkspaceClient, type Activity, type JobView } from "../../api/workspace-client";
import { JobList, JobsLine } from "./JobList";
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
 * they run, as one line: how many, how far together, time left; it unfolds to each job (who works on it, how far, time
 * spent and left, Stop). When one ends, Studio writes it in the chat.
 */
export function ThreadJobs({ projectId, threadId, canStop }: { projectId: string; threadId: string; canStop: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
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
      <JobsLine jobs={jobs} open={open} onToggle={() => setOpen(!open)} />
      {open ? (
        <JobList jobs={jobs} fold={false} onStop={canStop ? (x) => stop.mutate(x) : undefined} stopping={stop.isPending ? stop.variables?.id ?? null : null} />
      ) : null}
    </section>
  );
}
