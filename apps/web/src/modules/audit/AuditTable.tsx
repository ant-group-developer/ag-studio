import { useEffect, useState } from "react";
import { Button, DatePicker, Select, Table, Tag, Tooltip, type TableColumnsType } from "antd";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { useStudioClient, type AuditItem, type AuditKind, type AuditQuery } from "../../api/studio-client";
import { useWorkspaceClient } from "../../api/workspace-client";
import { useAiTranslation } from "../common/assistant-name";
import { PAGE_TABLE_STICKY } from "../../helpers/sticky-table-header";
import { UserCell } from "../common/UserCell";
import { toolLabel } from "../agent-chat/labels";
import "./audit.css";

const PAGE = 50;
const usd = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
const took = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`);

/**
 * The activity log as a table: who did what, where, how it ended, how long, what it cost; a row opens to its details.
 * Filters by team (unless `teamId` fixes it), project, person, kind, outcome and dates. The API decides what the
 * viewer may see (a Studio admin: all; a team owner: their teams).
 */
export function AuditTable({ teamId: fixedTeam }: { teamId?: string }) {
  const { t, i18n } = useAiTranslation();
  const client = useStudioClient();
  const ws = useWorkspaceClient();
  const [teamId, setTeamId] = useState<string | undefined>(fixedTeam);
  const [projectId, setProjectId] = useState<string | undefined>();
  const [actorId, setActorId] = useState<string | undefined>();
  const [kind, setKind] = useState<AuditKind | undefined>();
  const [outcome, setOutcome] = useState<"ok" | "error" | undefined>();
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [page, setPage] = useState(1);
  useEffect(() => setTeamId(fixedTeam), [fixedTeam]);
  useEffect(() => setProjectId(undefined), [teamId]);
  useEffect(() => setPage(1), [teamId, projectId, actorId, kind, outcome, range]);

  const scope = useQuery({ queryKey: ["audit", "scope"], queryFn: () => client.getAuditScope(), staleTime: 60_000, enabled: !fixedTeam });
  const projects = useQuery({ queryKey: ["projects", teamId], queryFn: () => ws.listProjects(teamId!), enabled: Boolean(teamId), staleTime: 60_000 });
  const actors = useQuery({ queryKey: ["audit", "actors", teamId ?? null], queryFn: () => client.listAuditActors(teamId), staleTime: 60_000 });
  const query: AuditQuery = {
    ...(teamId ? { teamId } : {}), ...(projectId ? { projectId } : {}), ...(actorId ? { actorId } : {}), ...(kind ? { kind } : {}),
    ...(outcome ? { outcome } : {}), ...range, page, pageSize: PAGE,
  };
  const list = useQuery({ queryKey: ["audit", "list", query], queryFn: () => client.listAudit(query), placeholderData: (prev) => prev });

  const kinds: Record<AuditKind, string> = {
    http: t("ws.audit.kinds.http"), tool: t("ws.audit.kinds.tool"), turn: t("ws.audit.kinds.turn"), job: t("ws.audit.kinds.job"),
  };
  const who = (r: AuditItem) => {
    const name = r.actor?.name || r.actor?.email || r.actorId || "?";
    if (r.actorKind === "agent") return <span>{t("ws.audit.agentFor", { name })}</span>;
    if (r.actorKind === "studio") return <span>{t("ws.audit.studioFor", { name })}</span>;
    return r.actor ? <UserCell user={r.actor} size={24} /> : <span>{name}</span>;
  };
  const what = (r: AuditItem) => {
    const head = r.kind === "http" ? `${r.method ?? ""} ${r.route ?? ""}`.trim() : r.kind === "job" ? r.action.replace(/^job\./, "") : r.kind === "turn" ? kinds.turn : r.kind === "tool" ? toolLabel(t, r.action) : r.action;
    return (
      <div className="ws-audit__what">
        <Tooltip title={r.action}><code>{head}</code></Tooltip>
        {r.target ? <span className="ws-hint">{r.target}</span> : null}
      </div>
    );
  };
  const where = (r: AuditItem) => (
    <div className="ws-audit__where">
      {r.team && !fixedTeam ? <span>{r.team.name ?? r.team.id}</span> : null}
      {r.project ? (r.project.name ? <Link to={`/p/${r.project.id}`}>{r.project.name}</Link> : <span className="ws-hint">{r.project.id}</span>) : null}
      {r.video && r.project ? <Link to={`/p/${r.project.id}/v/${r.video.id}`}>{r.video.title ?? r.video.id}</Link> : null}
    </div>
  );
  const columns: TableColumnsType<AuditItem> = [
    { key: "at", title: t("ws.audit.column.at"), width: 150, render: (_, r) => new Date(r.at).toLocaleString(i18n.language) },
    { key: "who", title: t("ws.audit.column.who"), width: 210, render: (_, r) => who(r) },
    { key: "kind", title: t("ws.audit.column.kind"), width: 110, render: (_, r) => <Tag bordered={false}>{kinds[r.kind]}</Tag> },
    { key: "what", title: t("ws.audit.column.what"), render: (_, r) => what(r) },
    { key: "where", title: t("ws.audit.column.where"), width: 220, render: (_, r) => where(r) },
    { key: "result", title: t("ws.audit.column.result"), width: 110, render: (_, r) => (
      <Tooltip title={r.summary ?? undefined}>
        <Tag color={r.outcome === "ok" ? "green" : "red"}>{r.outcome === "ok" ? t("ws.audit.outcomes.ok") : t("ws.audit.outcomes.error")}{r.statusCode ? ` ${r.statusCode}` : ""}</Tag>
      </Tooltip>
    ) },
    { key: "duration", title: t("ws.audit.column.duration"), width: 90, align: "right", render: (_, r) => (r.durationMs == null ? "—" : took(r.durationMs)) },
    { key: "cost", title: t("ws.audit.column.cost"), width: 80, align: "right", render: (_, r) => (r.costUsd ? usd(r.costUsd) : "—") },
  ];

  const teamOptions = (scope.data?.teams ?? []).map((x) => ({ value: x.id, label: x.name }));
  return (
    <div className="ws-audit">
      <div className="ws-audit__filters">
        {!fixedTeam ? (
          <Select allowClear placeholder={t("ws.audit.allTeams")} aria-label={t("ws.audit.team")} value={teamId} onChange={setTeamId} options={teamOptions} style={{ minWidth: 160 }} />
        ) : null}
        <Select allowClear showSearch optionFilterProp="label" placeholder={t("ws.audit.allProjects")} aria-label={t("ws.audit.project")} value={projectId}
          onChange={setProjectId} disabled={!teamId} style={{ minWidth: 180 }}
          options={(projects.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))} />
        <Select allowClear showSearch optionFilterProp="label" placeholder={t("ws.audit.everyone")} aria-label={t("ws.audit.who")} value={actorId}
          onChange={setActorId} style={{ minWidth: 180 }}
          options={(actors.data?.actors ?? []).map((a) => ({ value: a.userId, label: a.name || a.email || a.userId }))} />
        <Select allowClear placeholder={t("ws.audit.allKinds")} aria-label={t("ws.audit.kind")} value={kind} onChange={setKind} style={{ minWidth: 130 }}
          options={(Object.keys(kinds) as AuditKind[]).map((k) => ({ value: k, label: kinds[k] }))} />
        <Select allowClear placeholder={t("ws.audit.anyOutcome")} aria-label={t("ws.audit.outcome")} value={outcome} onChange={setOutcome} style={{ minWidth: 130 }}
          options={[{ value: "ok", label: t("ws.audit.outcomes.ok") }, { value: "error", label: t("ws.audit.outcomes.error") }]} />
        <DatePicker.RangePicker aria-label={t("ws.audit.time")} onChange={(v) => setRange(v && v[0] && v[1]
          ? { from: v[0].startOf("day").toISOString(), to: v[1].add(1, "day").startOf("day").toISOString() } : {})} />
        <Button icon={<RefreshCw size={14} />} onClick={() => void list.refetch()} loading={list.isFetching} aria-label={t("ws.audit.refresh")} />
      </div>
      <Table<AuditItem>
        rowKey="id" size="small" columns={columns} dataSource={list.data?.items ?? []} loading={list.isLoading} scroll={{ x: 1100 }} sticky={PAGE_TABLE_STICKY}
        locale={{ emptyText: t("ws.audit.none") }}
        pagination={{ current: page, pageSize: PAGE, total: list.data?.total ?? 0, showSizeChanger: false, onChange: setPage }}
        expandable={{
          expandedRowRender: (r) => (
            <div className="ws-audit__details">
              {r.route ? <p><strong>{t("ws.audit.route")}:</strong> <code>{r.method} {r.route}</code> · <code>{r.action}</code></p> : null}
              {r.summary ? <p className="ws-error">{r.summary}</p> : null}
              <p className="ws-audit__links">
                {r.threadId && r.project ? <Link to={`/p/${r.project.id}/c/${r.threadId}`}>{t("ws.audit.openThread")}</Link> : null}
                {r.video && r.project ? <Link to={`/p/${r.project.id}/v/${r.video.id}`}>{t("ws.audit.openVideo")}</Link> : null}
                {r.project ? <Link to={`/p/${r.project.id}`}>{t("ws.audit.openProject")}</Link> : null}
              </p>
              {r.details ? <pre aria-label={t("ws.audit.details")}>{JSON.stringify(r.details, null, 2)}</pre> : null}
            </div>
          ),
        }}
      />
    </div>
  );
}
