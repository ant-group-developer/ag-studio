import { useMemo, useState } from "react";
import { Alert, App, Button, Checkbox, DatePicker, Empty, Segmented, Table, Tabs, Tag, Tooltip, type TableColumnsType } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText } from "lucide-react";
import { Link } from "react-router-dom";
import { StudioHttpError, useStudioClient } from "../../api/studio-client";
import type {
  ErrorGroup, FarmErrorGroup, JobCount, RenderKindStats, RenderNodeStats, SlowRender, StuckJob, VideoFlagSeverity, VideoQualityRow,
} from "../../api/diagnostics-types";
import { useAiTranslation } from "../common/assistant-name";
import { DailyBars } from "../stats/DailyBars";
import "../stats/stats.css";
import "./diagnostics.css";

type Preset = "7" | "14" | "30" | "custom";
type TabKey = "overview" | "errors" | "renders" | "videos";

const DAY_MS = 86_400_000;
const MAX_DAYS = 90;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export function periodOf(preset: Preset, custom: { from: Date; to: Date } | null, now = new Date()): { from: Date; to: Date } {
  if (preset === "custom" && custom) return custom;
  const to = new Date(startOfDay(now).getTime() + DAY_MS);
  return { from: new Date(to.getTime() - Number(preset === "custom" ? 14 : preset) * DAY_MS), to };
}

const SEVERITY_COLOR: Record<VideoFlagSeverity, string> = { error: "red", warning: "orange", info: "default" };
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "—");
const mins = (s: number | null) => (s === null ? "—" : s >= 120 ? `${(s / 60).toFixed(1)}′` : `${Math.round(s)} s`);
const sumJobs = (rows: JobCount[], kind?: string, status?: string) =>
  rows.filter((j) => (!kind || j.kind === kind) && (!status || j.status === status)).reduce((n, j) => n + j.n, 0);
const sourceGroup = (s: string) => (s.startsWith("log:") ? "log" : s);

/**
 * The admin's diagnostics of a period (plan 2026-11-07): a period (7 / 14 / 30 days or chosen, at most 90), then
 * Overview (jobs, agent turns, stuck jobs, failures by day), Errors (grouped by their shape, new or gone against
 * the period before, examples linked), Renders (by kind, by machine, the farm's own errors) and Video quality (one row
 * per video rendered, its issues). The whole period downloads as a report or as data to give Claude.
 */
export function DiagnosticsView() {
  const { t, i18n } = useAiTranslation();
  const client = useStudioClient();
  const { message } = App.useApp();
  const [preset, setPreset] = useState<Preset>("14");
  const [custom, setCustom] = useState<{ from: Date; to: Date } | null>(null);
  const [tab, setTab] = useState<TabKey>("overview");
  const [chats, setChats] = useState(false);
  const [busy, setBusy] = useState<"md" | "json" | null>(null);
  const { from, to } = periodOf(preset, custom);
  const query = { from: from.toISOString(), to: to.toISOString(), tz: -new Date().getTimezoneOffset() };

  const overview = useQuery({ queryKey: ["diag", "overview", query], queryFn: () => client.getDiagnosticsOverview(query), placeholderData: (p) => p, retry: false });
  const errors = useQuery({ queryKey: ["diag", "errors", query], queryFn: () => client.getDiagnosticsErrors(query), placeholderData: (p) => p, enabled: tab === "errors" });
  const renders = useQuery({ queryKey: ["diag", "renders", query], queryFn: () => client.getDiagnosticsRenders(query), placeholderData: (p) => p, enabled: tab === "renders" });
  const videos = useQuery({ queryKey: ["diag", "videos", query], queryFn: () => client.getDiagnosticsVideos(query), placeholderData: (p) => p, enabled: tab === "videos" });

  const num = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const when = (iso: string) => new Date(iso).toLocaleString(i18n.language, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const dayLabel = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(i18n.language, { day: "numeric", month: "short" });

  async function download(format: "md" | "json") {
    setBusy(format);
    try {
      const blob = await client.exportDiagnostics({ ...query, format, chats });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `chan-doan-${ymd(from)}-${ymd(new Date(to.getTime() - DAY_MS))}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) {
      message.error(t("ws.diag.export.failed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  }

  if (overview.error instanceof StudioHttpError && overview.error.status === 403) return <Alert type="warning" showIcon message={t("ws.diag.denied")} />;

  const controls = (
    <div className="ws-stats__controls">
      <Segmented<Preset> aria-label={t("ws.diag.period")} value={preset} onChange={setPreset} options={[
        { value: "7", label: t("ws.diag.days", { count: 7 }) }, { value: "14", label: t("ws.diag.days", { count: 14 }) },
        { value: "30", label: t("ws.diag.days", { count: 30 }) }, { value: "custom", label: t("ws.diag.custom") },
      ]} />
      {preset === "custom" ? (
        <Tooltip title={t("ws.diag.maxDays")}>
          <DatePicker.RangePicker aria-label={t("ws.diag.period")}
            disabledDate={(d, info) => !!info.from && Math.abs(d.diff(info.from, "day")) >= MAX_DAYS || d.toDate().getTime() >= startOfDay(new Date()).getTime() + DAY_MS}
            onChange={(v) => setCustom(v && v[0] && v[1] ? { from: v[0].startOf("day").toDate(), to: v[1].add(1, "day").startOf("day").toDate() } : null)} />
        </Tooltip>
      ) : null}
      <span className="ws-diag__spacer" />
      <Checkbox checked={chats} onChange={(e) => setChats(e.target.checked)}>{t("ws.diag.export.chats")}</Checkbox>
      <Button icon={<FileText size={14} />} loading={busy === "md"} onClick={() => void download("md")}>{t("ws.diag.export.md")}</Button>
      <Button icon={<Download size={14} />} loading={busy === "json"} onClick={() => void download("json")}>{t("ws.diag.export.json")}</Button>
    </div>
  );

  return (
    <div className="ws-stats ws-diag">
      {controls}
      <Tabs activeKey={tab} onChange={(k) => setTab(k as TabKey)} items={[
        { key: "overview", label: t("ws.diag.tabs.overview"), children: <OverviewTab data={overview.data} loading={overview.isLoading} num={num} when={when} dayLabel={dayLabel} from={from} to={to} /> },
        { key: "errors", label: t("ws.diag.tabs.errors"), children: <ErrorsTab data={errors.data} loading={errors.isLoading} when={when} /> },
        { key: "renders", label: t("ws.diag.tabs.renders"), children: <RendersTab data={renders.data} loading={renders.isLoading} when={when} /> },
        { key: "videos", label: t("ws.diag.tabs.videos"), children: <VideosTab data={videos.data} loading={videos.isLoading} /> },
      ]} />
    </div>
  );
}

function OverviewTab({ data, loading, num, when, dayLabel, from, to }: {
  data: Awaited<ReturnType<ReturnType<typeof useStudioClient>["getDiagnosticsOverview"]>> | undefined; loading: boolean;
  num: Intl.NumberFormat; when: (iso: string) => string; dayLabel: (d: string) => string; from: Date; to: Date;
}) {
  const { t } = useAiTranslation();
  const series = useMemo(() => {
    const byDay = new Map((data?.daily ?? []).map((d) => [d.day, d.jobsFailed]));
    const days: { day: string; value: number }[] = [];
    for (let d = startOfDay(from); d < to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) days.push({ day: ymd(d), value: byDay.get(ymd(d)) ?? 0 });
    return days;
  }, [data, from.getTime(), to.getTime()]);
  if (!data) return <Table loading={loading} dataSource={[]} />;
  const jobs = sumJobs(data.jobs);
  const failed = sumJobs(data.jobs, undefined, "failed");
  const prevJobs = sumJobs(data.previousJobs);
  const prevFailed = sumJobs(data.previousJobs, undefined, "failed");
  const turns = Object.values(data.turns.byStatus).reduce((a, n) => a + n, 0);
  const turnsBad = (data.turns.byStatus.failed ?? 0) + (data.turns.byStatus.rate_limited ?? 0);
  const prevTurnsBad = (data.previousTurns.byStatus.failed ?? 0) + (data.previousTurns.byStatus.rate_limited ?? 0);
  const tiles = [
    { key: "jobs", label: t("ws.diag.overview.jobs"), value: num.format(jobs), sub: t("ws.diag.vsPrevious", { value: num.format(prevJobs) }) },
    { key: "failed", label: t("ws.diag.overview.jobsFailed"), value: `${num.format(failed)} (${pct(failed, jobs)})`, sub: t("ws.diag.vsPrevious", { value: `${num.format(prevFailed)} (${pct(prevFailed, prevJobs)})` }) },
    { key: "turns", label: t("ws.diag.overview.turns"), value: num.format(turns) },
    { key: "turnsBad", label: t("ws.diag.overview.turnsFailed"), value: num.format(turnsBad), sub: t("ws.diag.vsPrevious", { value: num.format(prevTurnsBad) }) },
    { key: "timeout", label: t("ws.diag.overview.timeout"), value: num.format(data.turns.byTrigger.timeout ?? 0) },
    { key: "cost", label: t("ws.diag.overview.cost"), value: `$${data.turns.costUsd.toFixed(2)}`, sub: t("ws.diag.vsPrevious", { value: `$${data.previousTurns.costUsd.toFixed(2)}` }) },
    { key: "stuck", label: t("ws.diag.overview.stuck"), value: num.format(data.stuck.length) },
  ];
  const kinds = [...new Set([...data.jobs, ...data.previousJobs].map((j) => j.kind))].sort();
  const rows = kinds.map((kind) => ({
    kind, total: sumJobs(data.jobs, kind), failed: sumJobs(data.jobs, kind, "failed"), prevTotal: sumJobs(data.previousJobs, kind), prevFailed: sumJobs(data.previousJobs, kind, "failed"),
  }));
  const columns: TableColumnsType<(typeof rows)[number]> = [
    { key: "kind", title: t("ws.diag.overview.kind"), dataIndex: "kind" },
    { key: "total", title: t("ws.diag.overview.total"), align: "right", sorter: (a, b) => a.total - b.total, render: (_, r) => num.format(r.total) },
    { key: "failed", title: t("ws.diag.overview.failed"), align: "right", defaultSortOrder: "descend", sorter: (a, b) => a.failed - b.failed, render: (_, r) => num.format(r.failed) },
    { key: "rate", title: t("ws.diag.overview.rate"), align: "right", render: (_, r) => pct(r.failed, r.total) },
    { key: "prev", title: t("ws.diag.overview.previous"), align: "right", render: (_, r) => `${r.prevFailed}/${r.prevTotal} (${pct(r.prevFailed, r.prevTotal)})` },
  ];
  const stuckColumns: TableColumnsType<StuckJob> = [
    { key: "kind", title: t("ws.diag.overview.kind"), render: (_, r) => <><Tag>{r.kind}</Tag>{r.status}</> },
    { key: "project", title: t("ws.diag.videos.project"), render: (_, r) => <Link to={r.videoId ? `/p/${r.projectId}/v/${r.videoId}` : `/p/${r.projectId}`}>{r.projectName ?? r.projectId}</Link> },
    { key: "title", title: "", dataIndex: "title" },
    { key: "node", title: t("ws.diag.renders.node"), render: (_, r) => r.nodeId ?? "—" },
    { key: "minutes", title: "", align: "right", render: (_, r) => t("ws.diag.overview.minutes", { count: r.minutes }) },
  ];
  return (
    <div className="ws-diag__tab">
      <dl className="ws-stats__tiles">
        {tiles.map((x) => (
          <div key={x.key} className="ws-stats__tile"><dt>{x.label}</dt><dd>{x.value}</dd>{x.sub ? <dd className="ws-hint">{x.sub}</dd> : null}</div>
        ))}
      </dl>
      <section className="ws-stats__chart" aria-label={t("ws.diag.overview.byDay")}>
        <div className="ws-stats__charthead"><h2>{t("ws.diag.overview.byDay")}</h2></div>
        <DailyBars data={series} format={(v) => num.format(v)} label={t("ws.diag.overview.jobsFailed")} dayLabel={dayLabel} />
      </section>
      <Table size="small" rowKey="kind" columns={columns} dataSource={rows} pagination={false} locale={{ emptyText: <Empty description={t("ws.diag.noData")} /> }} />
      {data.stuck.length ? (
        <section>
          <h2 className="ws-diag__h2">{t("ws.diag.overview.stuckTitle")}</h2>
          <Table size="small" rowKey="id" columns={stuckColumns} dataSource={data.stuck} pagination={false} />
        </section>
      ) : null}
      {data.accounts.length ? (
        <section>
          <h2 className="ws-diag__h2">{t("ws.diag.overview.accounts")}</h2>
          <ul className="ws-diag__list">{data.accounts.map((a) => <li key={a.id}><strong>{a.label}</strong> · {when(a.lastErrorAt)} · {a.lastError}</li>)}</ul>
        </section>
      ) : null}
    </div>
  );
}

function ErrorsTab({ data, loading, when }: {
  data: Awaited<ReturnType<ReturnType<typeof useStudioClient>["getDiagnosticsErrors"]>> | undefined; loading: boolean; when: (iso: string) => string;
}) {
  const { t } = useAiTranslation();
  const [source, setSource] = useState<string>("all");
  const [onlyNew, setOnlyNew] = useState(false);
  const groups = (data?.groups ?? []).filter((g) => (source === "all" || sourceGroup(g.source) === source) && (!onlyNew || g.trend === "new"));
  const sources = ["all", ...new Set((data?.groups ?? []).map((g) => sourceGroup(g.source)))];
  const sourceLabel = (s: string) => (s === "all" ? t("ws.diag.errors.all") : t(`ws.diag.errors.sources.${sourceGroup(s)}`, { defaultValue: s }));
  const columns: TableColumnsType<ErrorGroup> = [
    { key: "source", title: t("ws.diag.errors.source"), width: 120, render: (_, g) => <Tag>{g.source.startsWith("log:") ? g.source.slice(4) : sourceLabel(g.source)}</Tag> },
    { key: "signature", title: t("ws.diag.errors.signature"), render: (_, g) => (
      <span className="ws-diag__sig">{g.trend === "new" ? <Tag color="red">{t("ws.diag.errors.new")}</Tag> : null}{g.signature}</span>
    ) },
    { key: "kinds", title: t("ws.diag.errors.kinds"), width: 160, render: (_, g) => <span className="ws-hint">{g.kinds.slice(0, 3).join(", ")}{g.kinds.length > 3 ? "…" : ""}</span> },
    { key: "count", title: t("ws.diag.errors.count"), align: "right", width: 90, defaultSortOrder: "descend", sorter: (a, b) => a.count - b.count, render: (_, g) => g.count },
    { key: "prev", title: t("ws.diag.errors.previous"), align: "right", width: 90, sorter: (a, b) => a.previousCount - b.previousCount, render: (_, g) => g.previousCount || "—" },
    { key: "projects", title: t("ws.diag.errors.projects"), align: "right", width: 80, render: (_, g) => g.projects || "—" },
    { key: "last", title: t("ws.diag.errors.last"), width: 140, sorter: (a, b) => a.lastAt.localeCompare(b.lastAt), render: (_, g) => when(g.lastAt) },
  ];
  return (
    <div className="ws-diag__tab">
      <div className="ws-stats__controls">
        <Segmented value={source} onChange={(v) => setSource(String(v))} options={sources.map((s) => ({ value: s, label: sourceLabel(s) }))} />
        <Checkbox checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)}>{t("ws.diag.errors.onlyNew")}</Checkbox>
        {data ? <span className="ws-hint">{t("ws.diag.errors.total", { count: data.total, groups: data.groups.length })}</span> : null}
      </div>
      {data?.truncated ? <Alert type="info" showIcon message={t("ws.diag.errors.truncated")} /> : null}
      <Table size="small" rowKey="key" loading={loading} columns={columns} dataSource={groups} pagination={{ pageSize: 50, hideOnSinglePage: true }}
        locale={{ emptyText: <Empty description={t("ws.diag.noData")} /> }}
        expandable={{ expandedRowRender: (g) => (
          <ul className="ws-diag__examples" aria-label={t("ws.diag.errors.examples")}>
            {g.examples.map((x, i) => (
              <li key={i}>
                <span className="ws-hint">{when(x.at)}</span>{" "}
                {x.projectId ? <Link to={x.videoId ? `/p/${x.projectId}/v/${x.videoId}` : `/p/${x.projectId}`}>{x.projectName ?? x.projectId}</Link> : null}
                {x.repeats ? <span className="ws-hint"> ×{x.repeats}</span> : null}
                <pre>{x.message}</pre>
              </li>
            ))}
          </ul>
        ) }} />
      {data?.gone.length ? (
        <details className="ws-diag__gone">
          <summary>{t("ws.diag.errors.gone", { count: data.gone.length })}</summary>
          <ul className="ws-diag__list">{data.gone.map((g) => <li key={g.key}><Tag>{sourceLabel(g.source)}</Tag>{g.signature} <span className="ws-hint">×{g.previousCount}</span></li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}

function RendersTab({ data, loading, when }: {
  data: Awaited<ReturnType<ReturnType<typeof useStudioClient>["getDiagnosticsRenders"]>> | undefined; loading: boolean; when: (iso: string) => string;
}) {
  const { t } = useAiTranslation();
  const kindLabel = (k: string) => t(`ws.diag.renders.kinds.${k}`, { defaultValue: k });
  const prev = (k: string) => data?.previousKinds.find((x) => x.kind === k);
  const kindColumns: TableColumnsType<RenderKindStats> = [
    { key: "kind", title: t("ws.diag.renders.kind"), render: (_, k) => kindLabel(k.kind) },
    { key: "total", title: t("ws.diag.renders.total"), align: "right", render: (_, k) => <>{k.total} <span className="ws-hint">({prev(k.kind)?.total ?? 0})</span></> },
    { key: "done", title: t("ws.diag.renders.done"), align: "right", dataIndex: "done" },
    { key: "failed", title: t("ws.diag.renders.failed"), align: "right", render: (_, k) => <>{k.failed} ({pct(k.failed, k.total)}) <span className="ws-hint">({prev(k.kind)?.failed ?? 0})</span></> },
    { key: "wall", title: t("ws.diag.renders.wall"), align: "right", render: (_, k) => `${mins(k.wallP50)} / ${mins(k.wallP90)}` },
    { key: "wait", title: t("ws.diag.renders.wait"), align: "right", render: (_, k) => mins(k.waitP50) },
    { key: "speed", title: <Tooltip title={t("ws.diag.renders.speedHint")}>{t("ws.diag.renders.speed")}</Tooltip>, align: "right", render: (_, k) => (k.speedP50 === null ? "—" : `${k.speedP50}×`) },
    { key: "retried", title: t("ws.diag.renders.retried"), align: "right", dataIndex: "retried" },
    { key: "heights", title: t("ws.diag.renders.heights"), render: (_, k) => Object.entries(k.byHeight).map(([h, n]) => <Tag key={h}>{h}p ×{n}</Tag>) },
  ];
  const nodeColumns: TableColumnsType<RenderNodeStats> = [
    { key: "node", title: t("ws.diag.renders.node"), render: (_, n) => n.name ?? n.nodeId },
    { key: "jobs", title: t("ws.diag.renders.jobs"), align: "right", defaultSortOrder: "descend", sorter: (a, b) => a.jobs - b.jobs, dataIndex: "jobs" },
    { key: "failed", title: t("ws.diag.renders.failed"), align: "right", sorter: (a, b) => a.failed - b.failed, render: (_, n) => `${n.failed} (${pct(n.failed, n.jobs)})` },
    { key: "speed", title: t("ws.diag.renders.speed"), align: "right", sorter: (a, b) => (a.speedP50 ?? 0) - (b.speedP50 ?? 0), render: (_, n) => (n.speedP50 === null ? "—" : `${n.speedP50}×`) },
    { key: "finals", title: t("ws.diag.renders.finals"), align: "right", dataIndex: "finals" },
    { key: "finalWall", title: t("ws.diag.renders.finalWall"), align: "right", render: (_, n) => mins(n.finalWallP50) },
  ];
  const farmColumns: TableColumnsType<FarmErrorGroup> = [
    { key: "type", title: t("ws.diag.renders.kind"), dataIndex: "type" },
    { key: "code", title: t("ws.diag.renders.code"), render: (_, g) => <Tag>{g.code}</Tag> },
    { key: "sig", title: t("ws.diag.errors.signature"), render: (_, g) => <Tooltip title={<pre className="ws-diag__tip">{g.example}</pre>}><span className="ws-diag__sig">{g.signature}</span></Tooltip> },
    { key: "count", title: t("ws.diag.errors.count"), align: "right", dataIndex: "count" },
    { key: "nodes", title: t("ws.diag.renders.nodesOf"), render: (_, g) => <span className="ws-hint">{g.nodes.join(", ")}</span> },
    { key: "last", title: t("ws.diag.errors.last"), render: (_, g) => when(g.lastAt) },
  ];
  const slowColumns: TableColumnsType<SlowRender> = [
    { key: "video", title: t("ws.diag.videos.video"), render: (_, r) => (r.videoId ? <Link to={`/p/${r.projectId}/v/${r.videoId}`}>{r.videoTitle ?? r.videoId}</Link> : r.projectName) },
    { key: "kind", title: t("ws.diag.renders.kind"), render: (_, r) => <>{kindLabel(r.kind)} {r.height ? <Tag>{r.height}p</Tag> : null}</> },
    { key: "node", title: t("ws.diag.renders.node"), render: (_, r) => data?.nodes.find((n) => n.nodeId === r.nodeId)?.name ?? r.nodeId ?? "—" },
    { key: "wall", title: t("ws.diag.renders.wall"), align: "right", render: (_, r) => `${mins(r.wallSeconds)}${r.videoSeconds ? ` / ${mins(r.videoSeconds)}` : ""}` },
    { key: "at", title: t("ws.diag.errors.last"), render: (_, r) => when(r.finishedAt) },
  ];
  return (
    <div className="ws-diag__tab">
      <Table size="small" rowKey="kind" loading={loading} columns={kindColumns} dataSource={(data?.kinds ?? []).filter((k) => k.total || prev(k.kind)?.total)} pagination={false}
        locale={{ emptyText: <Empty description={t("ws.diag.noData")} /> }} />
      <section><h2 className="ws-diag__h2">{t("ws.diag.renders.nodes")}</h2>
        <Table size="small" rowKey="nodeId" columns={nodeColumns} dataSource={data?.nodes ?? []} pagination={false} /></section>
      <section><h2 className="ws-diag__h2">{t("ws.diag.renders.farm")}</h2>
        {data?.farmError ? <Alert type="warning" showIcon message={t("ws.diag.renders.farmDown", { message: data.farmError })} /> : null}
        {data?.farm?.truncated ? <Alert type="info" showIcon message={t("ws.diag.renders.farmTruncated")} /> : null}
        <Table size="small" rowKey={(g) => `${g.type}|${g.code}|${g.signature}`} columns={farmColumns} dataSource={data?.farm?.errors ?? []} pagination={{ pageSize: 20, hideOnSinglePage: true }} /></section>
      <section><h2 className="ws-diag__h2">{t("ws.diag.renders.slowest")}</h2>
        <Table size="small" rowKey="id" columns={slowColumns} dataSource={data?.slowest ?? []} pagination={false} /></section>
    </div>
  );
}

function VideosTab({ data, loading }: { data: Awaited<ReturnType<ReturnType<typeof useStudioClient>["getDiagnosticsVideos"]>> | undefined; loading: boolean }) {
  const { t } = useAiTranslation();
  const [flag, setFlag] = useState<string | null>(null);
  const flagLabel = (code: string) => t(`ws.diag.flag.${code}`, { defaultValue: code });
  const rows = (data?.rows ?? []).filter((r) => !flag || r.flags.some((f) => f.code === flag));
  const columns: TableColumnsType<VideoQualityRow> = [
    { key: "video", title: t("ws.diag.videos.video"), render: (_, r) => (
      <span className="ws-diag__video"><Link to={`/p/${r.projectId}/v/${r.videoId}`}>{r.videoTitle}</Link><span className="ws-hint">{r.projectName}</span></span>
    ) },
    { key: "render", title: t("ws.diag.videos.render"), width: 110, render: (_, r) => <>{r.kind === "render_final" ? t("ws.diag.videos.final") : t("ws.diag.videos.preview")} {r.height ? <Tag>{r.height}p</Tag> : null}</> },
    { key: "shots", title: t("ws.diag.videos.shots"), align: "right", width: 100, sorter: (a, b) => (a.shotMedian ?? 0) - (b.shotMedian ?? 0), render: (_, r) => `${r.shots} (${r.shotMedian ?? "—"} s)` },
    { key: "longest", title: t("ws.diag.videos.longest"), align: "right", width: 100, sorter: (a, b) => (a.longestShot ?? 0) - (b.longestShot ?? 0), render: (_, r) => (r.longestShot === null ? "—" : `${r.longestShot} s`) },
    { key: "gap", title: t("ws.diag.videos.voiceGap"), align: "right", width: 110, sorter: (a, b) => (a.maxVoiceGap ?? 0) - (b.maxVoiceGap ?? 0), render: (_, r) => (r.maxVoiceGap === null ? "—" : `${Math.round(r.maxVoiceGap)} s`) },
    { key: "renders", title: t("ws.diag.videos.renders"), align: "right", width: 80, sorter: (a, b) => a.renders - b.renders, dataIndex: "renders" },
    { key: "asks", title: <Tooltip title={t("ws.diag.videos.asksHint")}>{t("ws.diag.videos.asks")}</Tooltip>, align: "right", width: 80, sorter: (a, b) => a.asksAfterFirstRender - b.asksAfterFirstRender, dataIndex: "asksAfterFirstRender" },
    { key: "flags", title: t("ws.diag.videos.flags"), sorter: (a, b) => weight(a) - weight(b), defaultSortOrder: "descend", render: (_, r) => (
      <span className="ws-diag__flags">
        {r.flags.map((f) => <Tooltip key={f.code} title={f.detail}><Tag color={SEVERITY_COLOR[f.severity]}>{flagLabel(f.code)}</Tag></Tooltip>)}
        {r.inspect?.loudnessMedianLufs != null ? <span className="ws-hint">{t("ws.diag.videos.loudness", { value: r.inspect.loudnessMedianLufs.toFixed(1) })}</span> : null}
      </span>
    ) },
  ];
  const s = data?.summary;
  return (
    <div className="ws-diag__tab">
      {s ? <p className="ws-hint">{t("ws.diag.videos.summary", { count: s.videos, shot: s.shotMedian ?? "—", renders: s.rendersMedian ?? "—", asks: s.asksMedian ?? "—" })}</p> : null}
      {data?.truncated ? <Alert type="info" showIcon message={t("ws.diag.videos.truncated")} /> : null}
      {s?.flags.length ? (
        <div className="ws-diag__flagbar" aria-label={t("ws.diag.videos.filter")}>
          {s.flags.map((f) => (
            <Tag.CheckableTag key={f.code} checked={flag === f.code} onChange={(on) => setFlag(on ? f.code : null)}>
              <span className={`ws-diag__dot ws-diag__dot--${f.severity}`} />{flagLabel(f.code)} · {f.videos}
            </Tag.CheckableTag>
          ))}
          {flag ? <Button size="small" type="link" onClick={() => setFlag(null)}>{t("ws.diag.videos.clear")}</Button> : null}
        </div>
      ) : null}
      <Table size="small" rowKey="videoId" loading={loading} columns={columns} dataSource={rows} pagination={{ pageSize: 50, hideOnSinglePage: true }}
        locale={{ emptyText: <Empty description={t("ws.diag.noData")} /> }} />
    </div>
  );
}

/** Errors first, then warnings, for sorting the videos by their issues. */
const weight = (r: VideoQualityRow) => r.flags.reduce((n, f) => n + (f.severity === "error" ? 100 : f.severity === "warning" ? 10 : 1), 0);
