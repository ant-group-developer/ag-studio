import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { JobView } from "../../api/workspace-client";
import { JobCard } from "./JobCard";

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
