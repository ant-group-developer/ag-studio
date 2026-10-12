import { useState } from "react";
import { ChevronDown, ChevronRight, ChevronUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { JobView } from "../../api/workspace-client";
import { clock } from "../workspace/time";
import { JobCard } from "./JobCard";

const isLive = (j: JobView) => j.status === "queued" || j.status === "running";

/** How far the jobs are together (a waiting job counts as not started) and the longest time left any of them gives. */
export function jobsOverall(jobs: JobView[]): { percent: number; etaSeconds: number | null } {
  const percent = jobs.length ? Math.round((jobs.reduce((s, j) => s + (j.progress ?? 0), 0) / jobs.length) * 100) : 0;
  const etas = jobs.map((j) => j.etaSeconds).filter((x): x is number => typeof x === "number" && x > 0);
  return { percent, etaSeconds: etas.length ? Math.max(...etas) : null };
}

/**
 * Background jobs as one line that unfolds: how many, how many run and wait, how far the live ones are together and
 * the time left. With none live (only jobs just finished), it says they are done.
 */
export function JobsLine({ jobs, open, onToggle }: { jobs: JobView[]; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const live = jobs.filter(isLive);
  const running = live.filter((j) => j.status === "running").length;
  const { percent, etaSeconds } = jobsOverall(live);
  const failed = jobs.filter((j) => j.status === "failed").length;
  return (
    <button type="button" className="ws-thread-jobs" aria-expanded={open} onClick={onToggle}>
      <ChevronRight size={13} className="ws-thread-jobs__chevron" aria-hidden />
      <span className={`ws-dot ${running ? "ws-dot--run" : live.length ? "ws-dot--wait" : failed ? "ws-dot--failed" : "ws-dot--done"}`} aria-hidden />
      <strong>{t("ws.jobs.summary", { count: jobs.length })}</strong>
      {live.length ? (
        <>
          <span className="ws-hint">{t("ws.jobs.running", { count: running })} · {t("ws.jobs.queued", { count: live.length - running })}</span>
          <span className="ws-thread-jobs__bar" aria-hidden><span style={{ width: `${percent}%` }} /></span>
          <span className="ws-thread-jobs__num">
            {t("ws.jobs.overall", { percent })}{etaSeconds !== null ? ` · ${t("ws.jobs.eta", { time: clock(etaSeconds) })}` : ""}
          </span>
        </>
      ) : (
        <span className="ws-hint">{failed ? t("ws.jobs.recentFailed", { count: failed }) : t("ws.jobs.recentDone")}</span>
      )}
    </button>
  );
}

/** Cards shown before the list folds into a summary: a chat that prepares dozens of videos keeps its message box. */
const SHOWN = 2;

/**
 * Background jobs as cards. Past a couple, a summary line (how many run, how many wait) shows the running ones first
 * and unfolds the rest in a box of its own height, so the panel around it stays usable however many there are.
 */
export function JobList({ jobs, onStop, stopping, fold = true }: {
  jobs: JobView[];
  onStop?: ((job: JobView) => void) | undefined;
  stopping?: string | null;
  /** false: every card, no summary (the caller already shows one). */
  fold?: boolean;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const live = (j: JobView) => j.status === "queued" || j.status === "running";
  const running = jobs.filter((j) => j.status === "running");
  const waiting = jobs.filter((j) => j.status === "queued");
  const folds = fold && jobs.length > SHOWN;
  const ordered = [...running, ...waiting, ...jobs.filter((j) => !live(j))];
  const shown = !folds || all ? ordered : ordered.slice(0, SHOWN);
  return (
    <div className="ws-jobs">
      {folds ? (
        <div className="ws-jobs__head">
          <strong>{t("ws.jobs.summary", { count: jobs.length })}</strong>
          <span className="ws-hint">{t("ws.jobs.running", { count: running.length })} · {t("ws.jobs.queued", { count: waiting.length })}</span>
          <button type="button" className="ws-link" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? <><ChevronUp size={13} aria-hidden /> {t("ws.jobs.showLess")}</> : <><ChevronDown size={13} aria-hidden /> {t("ws.jobs.showAll")}</>}
          </button>
        </div>
      ) : null}
      <div className="ws-jobs__list">
        {shown.map((j) => <JobCard key={j.id} job={j} onStop={live(j) ? onStop : undefined} stopping={stopping === j.id} />)}
      </div>
    </div>
  );
}
