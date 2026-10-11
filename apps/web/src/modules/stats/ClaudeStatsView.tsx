import { useEffect, useMemo, useState } from "react";
import { DatePicker, Segmented, Select, Table, type TableColumnsType } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useStudioClient, type ClaudeStatsGroup, type ClaudeStatsRow } from "../../api/studio-client";
import { useAiTranslation } from "../common/assistant-name";
import { UserCell } from "../common/UserCell";
import { clock } from "../workspace/time";
import { ClaudeTurns, type TurnScope } from "./ClaudeTurns";
import { DailyBars } from "./DailyBars";
import "./stats.css";

type Preset = "7" | "30" | "90" | "custom";
type Metric = "cost" | "turns" | "tokens";

const DAY_MS = 86_400_000;
/** `YYYY-MM-DD` of a local date. */
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

function periodOf(preset: Preset, custom: { from: Date; to: Date } | null): { from: Date; to: Date } {
  if (preset === "custom" && custom) return custom;
  const to = new Date(startOfDay(new Date()).getTime() + DAY_MS);
  return { from: new Date(to.getTime() - Number(preset === "custom" ? 30 : preset) * DAY_MS), to };
}

/**
 * Claude chat statistics: a period, a grouping (team, project, video, person), the totals as tiles, one measure by
 * day, a sortable table, and the turns one by one (a row of the table narrows them; a turn opens in full). `teamId` fixes the team (a team's own Stats tab); otherwise the viewer picks among the
 * teams they may see.
 */
export function ClaudeStatsView({ teamId: fixedTeam }: { teamId?: string }) {
  const { t, i18n } = useAiTranslation();
  const client = useStudioClient();
  const [teamId, setTeamId] = useState<string | undefined>(fixedTeam);
  const [preset, setPreset] = useState<Preset>("30");
  const [custom, setCustom] = useState<{ from: Date; to: Date } | null>(null);
  const [groupBy, setGroupBy] = useState<ClaudeStatsGroup>(fixedTeam ? "project" : "team");
  const [metric, setMetric] = useState<Metric>("cost");
  const { from, to } = periodOf(preset, custom);
  const team = fixedTeam ?? teamId;
  const [turnScope, setTurnScope] = useState<TurnScope | null>(null);
  useEffect(() => setTurnScope(null), [groupBy, team]);

  const scope = useQuery({ queryKey: ["audit", "scope"], queryFn: () => client.getAuditScope(), staleTime: 60_000, enabled: !fixedTeam });
  const query = { from: from.toISOString(), to: to.toISOString(), groupBy, tz: -new Date().getTimezoneOffset(), ...(team ? { teamId: team } : {}) };
  const stats = useQuery({ queryKey: ["claude-stats", query], queryFn: () => client.getClaudeStats(query), placeholderData: (prev) => prev });

  const num = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const compact = useMemo(() => new Intl.NumberFormat(i18n.language, { notation: "compact", maximumFractionDigits: 1 }), [i18n.language]);
  const usd = (n: number) => `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`;
  const dayLabel = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(i18n.language, { day: "numeric", month: "short" });

  // every day of the period has a slot
  const series = useMemo(() => {
    const byDay = new Map((stats.data?.daily ?? []).map((d) => [d.day, d]));
    const days: { day: string; value: number }[] = [];
    for (let d = startOfDay(from); d < to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      const x = byDay.get(ymd(d));
      days.push({ day: ymd(d), value: !x ? 0 : metric === "cost" ? x.costUsd : metric === "turns" ? x.turns : x.inputTokens + x.outputTokens });
    }
    return days;
  }, [stats.data, from.getTime(), to.getTime(), metric]);

  const totals = stats.data?.totals;
  const cacheShare = totals && totals.inputTokens ? Math.round((totals.cacheReadTokens / totals.inputTokens) * 100) : null;
  const groups: Record<ClaudeStatsGroup, string> = {
    team: t("ws.stats.by.team"), project: t("ws.stats.by.project"), video: t("ws.stats.by.video"), user: t("ws.stats.by.user"),
  };
  const name = (r: ClaudeStatsRow) => {
    if (groupBy === "user") return r.user ? <UserCell user={r.user} size={24} /> : <span>{r.label ?? r.key}</span>;
    if (groupBy === "video" && !r.key) return <span className="ws-hint">{t("ws.stats.projectChats")}</span>;
    const text = r.label ?? r.key ?? "—";
    if (groupBy === "project" && r.key && r.label) return <Link to={`/p/${r.key}`}>{text}</Link>;
    if (groupBy === "video" && r.key && r.projectId && r.label) return <Link to={`/p/${r.projectId}/v/${r.key}`}>{text}</Link>;
    return <span>{text}</span>;
  };
  const scopeOf = (r: ClaudeStatsRow): TurnScope => {
    const label = `${groups[groupBy]}: ${groupBy === "video" && !r.key ? t("ws.stats.projectChats") : r.user?.name ?? r.label ?? r.key ?? "—"}`;
    if (groupBy === "team") return { label, teamId: r.key ?? undefined };
    if (groupBy === "project") return { label, projectId: r.key ?? undefined };
    if (groupBy === "video") return { label, videoId: r.key ?? "" };
    return { label, userId: r.key ?? undefined };
  };
  const columns: TableColumnsType<ClaudeStatsRow> = [
    { key: "name", title: groups[groupBy], render: (_, r) => name(r) },
    { key: "turns", title: t("ws.stats.turns"), align: "right", sorter: (a, b) => a.turns - b.turns, render: (_, r) => num.format(r.turns) },
    { key: "threads", title: t("ws.stats.threads"), align: "right", sorter: (a, b) => a.threads - b.threads, render: (_, r) => num.format(r.threads) },
    { key: "messages", title: t("ws.stats.messages"), align: "right", sorter: (a, b) => a.userMessages - b.userMessages, render: (_, r) => num.format(r.userMessages) },
    { key: "input", title: t("ws.stats.inputTokens"), align: "right", sorter: (a, b) => a.inputTokens - b.inputTokens, render: (_, r) => compact.format(r.inputTokens) },
    { key: "cache", title: t("ws.stats.cacheShare"), align: "right", render: (_, r) => (r.inputTokens ? `${Math.round((r.cacheReadTokens / r.inputTokens) * 100)}%` : "—") },
    { key: "output", title: t("ws.stats.outputTokens"), align: "right", sorter: (a, b) => a.outputTokens - b.outputTokens, render: (_, r) => compact.format(r.outputTokens) },
    { key: "cost", title: t("ws.stats.cost"), align: "right", defaultSortOrder: "descend", sorter: (a, b) => a.costUsd - b.costUsd, render: (_, r) => usd(r.costUsd) },
    { key: "time", title: t("ws.stats.time"), align: "right", sorter: (a, b) => a.wallSeconds - b.wallSeconds, render: (_, r) => clock(r.wallSeconds) },
    { key: "failed", title: t("ws.stats.failed"), align: "right", sorter: (a, b) => a.failed + a.rateLimited - b.failed - b.rateLimited,
      render: (_, r) => (r.failed || r.rateLimited ? `${r.failed} / ${r.rateLimited}` : "—") },
  ];
  const tiles = totals ? [
    { key: "cost", label: t("ws.stats.cost"), value: usd(totals.costUsd) },
    { key: "turns", label: t("ws.stats.turns"), value: num.format(totals.turns), sub: t("ws.stats.inThreads", { count: totals.threads }) },
    { key: "messages", label: t("ws.stats.messages"), value: num.format(totals.userMessages) },
    { key: "tokens", label: t("ws.stats.tokens"), value: compact.format(totals.inputTokens + totals.outputTokens),
      sub: t("ws.stats.tokensSplit", { input: compact.format(totals.inputTokens), output: compact.format(totals.outputTokens) }) },
    { key: "cache", label: t("ws.stats.cacheShare"), value: cacheShare === null ? "—" : `${cacheShare}%` },
    { key: "failed", label: t("ws.stats.failed"), value: num.format(totals.failed), sub: t("ws.stats.rateLimited", { count: totals.rateLimited }) },
  ] : [];
  const metricLabel: Record<Metric, string> = { cost: t("ws.stats.costByDay"), turns: t("ws.stats.turnsByDay"), tokens: t("ws.stats.tokensByDay") };
  const format = (v: number) => (metric === "cost" ? usd(v) : compact.format(v));

  return (
    <div className="ws-stats">
      <div className="ws-stats__controls">
        {!fixedTeam ? (
          <Select allowClear placeholder={t("ws.audit.allTeams")} aria-label={t("ws.audit.team")} value={teamId} onChange={setTeamId} style={{ minWidth: 160 }}
            options={(scope.data?.teams ?? []).map((x) => ({ value: x.id, label: x.name }))} />
        ) : null}
        <Segmented<Preset> aria-label={t("ws.stats.period")} value={preset} onChange={setPreset} options={[
          { value: "7", label: t("ws.stats.days", { count: 7 }) }, { value: "30", label: t("ws.stats.days", { count: 30 }) },
          { value: "90", label: t("ws.stats.days", { count: 90 }) }, { value: "custom", label: t("ws.stats.custom") },
        ]} />
        {preset === "custom" ? (
          <DatePicker.RangePicker aria-label={t("ws.stats.period")} onChange={(v) => setCustom(v && v[0] && v[1]
            ? { from: v[0].startOf("day").toDate(), to: v[1].add(1, "day").startOf("day").toDate() } : null)} />
        ) : null}
        <Segmented<ClaudeStatsGroup> aria-label={t("ws.stats.groupBy")} value={groupBy} onChange={setGroupBy}
          options={(Object.keys(groups) as ClaudeStatsGroup[]).map((g) => ({ value: g, label: groups[g] }))} />
      </div>

      <dl className="ws-stats__tiles">
        {tiles.map((x) => (
          <div key={x.key} className="ws-stats__tile">
            <dt>{x.label}</dt>
            <dd>{x.value}</dd>
            {x.sub ? <dd className="ws-hint">{x.sub}</dd> : null}
          </div>
        ))}
      </dl>

      <section className="ws-stats__chart" aria-label={metricLabel[metric]}>
        <div className="ws-stats__charthead">
          <h2>{metricLabel[metric]}</h2>
          <Segmented<Metric> size="small" aria-label={t("ws.stats.measure")} value={metric} onChange={setMetric} options={[
            { value: "cost", label: t("ws.stats.cost") }, { value: "turns", label: t("ws.stats.turns") }, { value: "tokens", label: t("ws.stats.tokens") },
          ]} />
        </div>
        <DailyBars data={series} format={format} label={metricLabel[metric]} dayLabel={dayLabel} />
      </section>

      <Table<ClaudeStatsRow> rowKey={(r) => r.key ?? "_none"} size="small" columns={columns} dataSource={stats.data?.rows ?? []} loading={stats.isLoading}
        pagination={{ pageSize: 50, hideOnSinglePage: true }} scroll={{ x: 1000 }} locale={{ emptyText: t("ws.stats.none") }}
        rowClassName={(r) => `ws-turns__row${turnScope && turnScope.label === scopeOf(r).label ? " ws-turns__row--on" : ""}`}
        onRow={(r) => ({ onClick: (e) => { if (!(e.target as HTMLElement).closest("a")) setTurnScope(scopeOf(r)); }, title: t("ws.stats.turn.rowHint") })} />
      <p className="ws-hint">{t("ws.stats.note")}</p>
      <ClaudeTurns period={{ from: from.toISOString(), to: to.toISOString() }} teamId={team} scope={turnScope} onClearScope={() => setTurnScope(null)} />
    </div>
  );
}
