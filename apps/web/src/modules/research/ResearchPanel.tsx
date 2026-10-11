import { useEffect, useMemo, useState } from "react";
import { Alert, App as AntApp, Button, Input, InputNumber, Segmented, Select } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient, type CrawlInput, type JobView } from "../../api/workspace-client";
import { JobCard } from "../inputs/JobCard";
import { relativeTime } from "../workspace/time";
import "../inputs/inputs.css";
import "./research.css";

type Kind = CrawlInput["kind"];
const KINDS: Kind[] = ["trending", "topic", "top_channels", "channel_top"];
const REGIONS = ["VN", "US", "GB", "JP", "KR", "TH", "ID", "PH", "IN", "FR", "DE"];
/** YouTube video categories the Research tab offers for trending (ids of the Data API). */
const CATEGORIES = ["", "19", "22", "24", "26", "10", "17", "20", "25", "27", "28", "1", "2", "15"];
const DAYS = [7, 30, 90, 365];

/** `value` once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/**
 * The Research tab (spec 2026-10-10 agent-workspace §P5): crawl YouTube — trending in a region, the most viewed videos
 * of a topic, the top channels of a topic, a channel's most viewed videos — with the quota it costs shown first. Each
 * crawl runs in the background and lands in research/<date>-<slug>.md, listed below with the project's other research.
 */
export function ResearchPanel({ projectId, canRun, onOpenFile }: { projectId: string; canRun: boolean; onOpenFile: (path: string) => void }) {
  const { t, i18n } = useTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const [kind, setKind] = useState<Kind>("topic");
  const [q, setQ] = useState("");
  const [channel, setChannel] = useState("");
  const [region, setRegion] = useState("VN");
  const [category, setCategory] = useState("");
  const [days, setDays] = useState(90);
  const [order, setOrder] = useState<"viewCount" | "relevance" | "date">("viewCount");
  const [max, setMax] = useState<number>(30);
  useEffect(() => { setMax(kind === "top_channels" ? 10 : 30); }, [kind]);

  const crawl: CrawlInput | null = useMemo(() => {
    if (kind === "trending") return { kind, region, max, ...(category ? { category } : {}) };
    if (kind === "topic") return q.trim() ? { kind, q: q.trim(), region, days, order, max } : null;
    if (kind === "top_channels") return q.trim() ? { kind, q: q.trim(), region, max } : null;
    return channel.trim() ? { kind, channel: channel.trim(), max } : null;
  }, [kind, q, channel, region, category, days, order, max]);
  const debounced = useDebounced(crawl);
  const estimate = useQuery({
    queryKey: ["researchEstimate", projectId, debounced], queryFn: () => client.estimateResearch(projectId, debounced!), enabled: !!debounced, retry: false,
  });
  const files = useQuery({ queryKey: ["research", projectId], queryFn: () => client.listResearch(projectId) });
  const jobs = useQuery({
    queryKey: ["jobs", projectId, "research"], queryFn: () => client.listJobs(projectId),
    refetchInterval: (x) => (x.state.data?.jobs.some((j) => j.kind === "research" && (j.status === "queued" || j.status === "running")) ? 2000 : false),
  });
  const refresh = () => {
    for (const k of ["jobs", "activity", "research", "files"]) void qc.invalidateQueries({ queryKey: [k, projectId] });
  };
  const run = useMutation({
    mutationFn: () => client.runResearch(projectId, crawl!),
    onSuccess: () => { refresh(); void message.success(t("ws.research.started")); },
    onError: (e) => void message.error(e instanceof StudioHttpError ? e.message : t("ws.research.runFailed")),
  });
  const stop = useMutation({ mutationFn: (j: JobView) => client.cancelJob(projectId, j.id), onSuccess: refresh });

  const researchJobs = (jobs.data?.jobs ?? []).filter((j) => j.kind === "research");
  const active = researchJobs.filter((j) => j.status === "queued" || j.status === "running");
  const failed = researchJobs.filter((j) => j.status === "failed").slice(0, 2);
  const est = estimate.data && debounced === crawl ? estimate.data : null;

  return (
    <div className="ws-inputs ws-research">
      <section aria-label={t("ws.research.newTitle")}>
        <h4 className="ws-inputs__h">{t("ws.research.newTitle")}</h4>
        <Segmented block size="small" value={kind} onChange={(v) => setKind(v as Kind)} options={KINDS.map((k) => ({ value: k, label: t(`ws.research.kind.${k}`) }))} />
        <div className="ws-research__form">
          {kind === "topic" || kind === "top_channels" ? (
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("ws.research.topicPlaceholder")} aria-label={t("ws.research.topic")} maxLength={200} />
          ) : null}
          {kind === "channel_top" ? (
            <Input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder={t("ws.research.channelPlaceholder")} aria-label={t("ws.research.channel")} maxLength={300} />
          ) : null}
          <div className="ws-research__row">
            {kind !== "channel_top" ? (
              <label>{t("ws.research.region")}
                <Select size="small" value={region} onChange={setRegion} options={REGIONS.map((r) => ({ value: r, label: r }))} aria-label={t("ws.research.region")} />
              </label>
            ) : null}
            {kind === "trending" ? (
              <label>{t("ws.research.category")}
                <Select size="small" value={category} onChange={setCategory} style={{ minWidth: 150 }} aria-label={t("ws.research.category")}
                  options={CATEGORIES.map((c) => ({ value: c, label: t(`ws.research.categories.c${c || "all"}`) }))} />
              </label>
            ) : null}
            {kind === "topic" ? (
              <>
                <label>{t("ws.research.days")}
                  <Select size="small" value={days} onChange={setDays} options={DAYS.map((d) => ({ value: d, label: t("ws.research.daysN", { count: d }) }))} aria-label={t("ws.research.days")} />
                </label>
                <label>{t("ws.research.order")}
                  <Select size="small" value={order} onChange={setOrder} aria-label={t("ws.research.order")}
                    options={(["viewCount", "relevance", "date"] as const).map((o) => ({ value: o, label: t(`ws.research.orders.${o}`) }))} />
                </label>
              </>
            ) : null}
            <label>{kind === "top_channels" ? t("ws.research.channels") : t("ws.research.videos")}
              <InputNumber size="small" min={1} max={kind === "top_channels" ? 50 : 200} value={max} onChange={(v) => setMax(v ?? 1)} aria-label={kind === "top_channels" ? t("ws.research.channels") : t("ws.research.videos")} />
            </label>
          </div>
          {est ? (
            <p className="ws-hint" role="status">
              {est.source === "youtube_api" ? t("ws.research.costApi", { units: est.units }) : t("ws.research.costYtDlp")}
            </p>
          ) : null}
          {est?.large ? <Alert type="warning" showIcon message={t("ws.research.large")} /> : null}
          {canRun ? (
            <Button type="primary" icon={<Play size={14} />} disabled={!crawl} loading={run.isPending} onClick={() => run.mutate()}>{t("ws.research.run")}</Button>
          ) : null}
        </div>
      </section>

      {active.length || failed.length ? (
        <section aria-label={t("ws.research.running")}>
          <h4 className="ws-inputs__h">{t("ws.research.running")}</h4>
          <div className="ws-inputs__jobs">
            {active.map((j) => <JobCard key={j.id} job={j} onStop={canRun ? (x) => stop.mutate(x) : undefined} stopping={stop.isPending && stop.variables?.id === j.id} />)}
            {failed.map((j) => <JobCard key={j.id} job={j} />)}
          </div>
        </section>
      ) : null}

      <section aria-label={t("ws.research.files")}>
        <h4 className="ws-inputs__h">{t("ws.research.files")}</h4>
        {files.data?.files.length ? (
          <ul className="ws-inputs__list">
            {files.data.files.map((f) => (
              <li key={f.path} className="ws-inputs__row">
                <FileText size={14} aria-hidden />
                <div className="ws-inputs__text">
                  <button type="button" className="ws-link ws-inputs__name" onClick={() => onOpenFile(f.path)}>{f.title}</button>
                  <span className="ws-hint">
                    {relativeTime(f.modifiedAt, i18n.language)}
                    {f.crawl ? ` · ${f.crawl.channels ? t("ws.research.nChannels", { count: f.crawl.channels }) : t("ws.research.nVideos", { count: f.crawl.videos })}`
                      + ` · ${f.crawl.source === "youtube_api" ? t("ws.research.viaApi", { units: f.crawl.quotaUnits }) : t("ws.research.viaYtDlp")}` : ""}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="ws-hint">{t("ws.research.noFiles")}</p>}
      </section>
    </div>
  );
}
