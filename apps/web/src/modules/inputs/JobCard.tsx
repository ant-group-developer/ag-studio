import { Progress } from "antd";
import { Cpu, Loader2, Server, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { JobView } from "../../api/workspace-client";
import { withoutIds } from "../common/no-ids";
import { useNow } from "../common/sse";
import { clock } from "../workspace/time";

/** Who works on a job now: a farm machine when its phase names one, else this Studio's ffmpeg / worker. */
export function jobWorker(job: Pick<JobView, "phase" | "nodeId" | "status">, t: (k: string, o?: Record<string, unknown>) => string): { farm: boolean; label: string } {
  if (job.status === "queued") return { farm: false, label: t("ws.jobs.inLine") };
  if (job.nodeId || job.phase?.startsWith("Farm")) return { farm: true, label: job.nodeId ? t("ws.jobs.farmNode", { node: job.nodeId }) : t("ws.jobs.farm") };
  return { farm: false, label: t("ws.jobs.studio") };
}

/**
 * A background job as it runs (like a download in a desktop app): what it is, who works on it (Studio or which farm
 * machine), what it does now, a progress bar (moving stripes when it cannot tell), time spent, time left, and Stop.
 */
export function JobCard({ job, onStop, stopping }: { job: JobView; onStop?: (job: JobView) => void; stopping?: boolean }) {
  const { t } = useTranslation();
  const active = job.status === "queued" || job.status === "running";
  const title = withoutIds(job.title, t("ws.inputs.unnamedVideo"));
  const now = useNow(1000, active);
  const elapsed = job.startedAt ? ((job.finishedAt ? Date.parse(job.finishedAt) : now) - Date.parse(job.startedAt)) / 1000 : null;
  const worker = jobWorker(job, t);
  const WorkerIcon = worker.farm ? Server : Cpu;
  return (
    <div className={`ws-job ws-job--${job.status}`} role="group" aria-label={title}>
      <div className="ws-job__head">
        {job.status === "running" ? <Loader2 size={14} className="ws-spin" aria-hidden /> : <span className={`ws-dot ws-dot--${active ? "wait" : job.status}`} aria-hidden />}
        <strong className="ws-job__title" title={title}>{title}</strong>
        {active && onStop ? (
          <button type="button" className="ws-icon-button" aria-label={t("ws.jobs.stop")} title={t("ws.jobs.stop")} disabled={stopping || job.cancelRequested}
            onClick={() => onStop(job)}>
            <Square size={12} />
          </button>
        ) : null}
      </div>
      <div className="ws-job__who"><WorkerIcon size={12} aria-hidden /> {worker.label}{job.cancelRequested && active ? ` · ${t("ws.jobs.stopping")}` : ""}</div>
      {active ? (
        <>
          <div className="ws-job__phase">{job.status === "queued" ? t("ws.jobs.waiting") : job.phase ?? t("ws.jobs.starting")}</div>
          <Progress percent={job.progress === null ? 100 : Math.round(job.progress * 100)} size="small" showInfo={job.progress !== null}
            status="active" strokeColor={job.progress === null ? "var(--ws-chip-strong, #c9cfd8)" : undefined} aria-label={t("ws.jobs.progress")} />
          <div className="ws-job__times">
            {elapsed !== null ? <span>{t("ws.jobs.elapsed", { time: clock(elapsed) })}</span> : null}
            {job.etaSeconds !== null && job.status === "running" ? <span>{t("ws.jobs.eta", { time: clock(job.etaSeconds) })}</span> : null}
          </div>
        </>
      ) : (
        <div className="ws-job__phase">
          {job.status === "done" ? t("ws.jobs.done", { time: elapsed !== null ? clock(elapsed) : "" })
            : job.status === "cancelled" ? t("ws.jobs.cancelled") : t("ws.jobs.failed", { error: job.error ?? "" })}
        </div>
      )}
    </div>
  );
}
