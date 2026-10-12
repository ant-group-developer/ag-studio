import { useEffect, useMemo, useState } from "react";
import { Button, Input, Spin, Table, Tag, Tooltip, type TableColumnsType } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useWorkspaceClient, type ProjectListItem } from "../api/workspace-client";
import { rememberTeam } from "../helpers/last-team";
import { sortRows, type SortDirection } from "../helpers/compare-sort-values";
import { SortDropdown } from "../helpers/sort-dropdown";
import { useViewMode, ViewModeToggle } from "../modules/inputs/picker/PickerParts";
import { NewProjectModal } from "../modules/workspace/NewProjectModal";
import { useTeams, WorkspaceShell } from "../modules/workspace/WorkspaceShell";
import { relativeTime } from "../modules/workspace/time";

const CAN_CREATE = new Set(["producer", "owner"]);
type SortField = "lastActivityAt" | "name" | "videoCount" | "createdAt";
const SORT_VALUE: Record<SortField, (p: ProjectListItem) => string | number> = {
  lastActivityAt: (p) => Date.parse(p.lastActivityAt),
  name: (p) => p.name,
  videoCount: (p) => p.videoCount,
  createdAt: (p) => Date.parse(p.createdAt),
};

function ProjectCard({ p }: { p: ProjectListItem }) {
  const { t, i18n } = useTranslation();
  return (
    <Link to={`/p/${p.id}`} className="ws-card">
      <span className="ws-card__title">{p.name}</span>
      {p.channelUrl ? <span className="ws-card__channel">{p.channelUrl}</span> : null}
      <p className="ws-card__desc">{p.description || t("ws.projects.noDescription")}</p>
      <span className="ws-card__meta">
        <span>{t("ws.projects.videoCount", { count: p.videoCount })}</span>
        <span>{relativeTime(p.lastActivityAt, i18n.language)}</span>
      </span>
    </Link>
  );
}

/** A team's projects — one per YouTube channel — as cards or a table, found by name, sorted, and a new one. */
export function ProjectsPage() {
  const { t, i18n } = useTranslation();
  const { teamId = "" } = useParams();
  const navigate = useNavigate();
  const client = useWorkspaceClient();
  const { data: teams } = useTeams();
  const [creating, setCreating] = useState(false);
  const [find, setFind] = useState("");
  const [sort, setSort] = useState<{ sortBy: SortField; sortOrder: SortDirection }>({ sortBy: "lastActivityAt", sortOrder: "desc" });
  const [view, setView] = useViewMode("studio.projects.viewMode", "grid");
  const { data, isLoading } = useQuery({ queryKey: ["projects", teamId], queryFn: () => client.listProjects(teamId), enabled: !!teamId });
  const team = teams?.items.find((x) => x.id === teamId);
  const canCreate = !!team?.role && CAN_CREATE.has(team.role);
  useEffect(() => { if (teamId) rememberTeam(teamId); }, [teamId]);

  const projects = data?.projects ?? [];
  const shown = useMemo(() => {
    const q = find.trim().toLocaleLowerCase("vi");
    const found = q ? projects.filter((p) => [p.name, p.channelUrl ?? "", p.description].some((s) => s.toLocaleLowerCase("vi").includes(q))) : projects;
    return sortRows(found, SORT_VALUE[sort.sortBy], sort.sortOrder);
  }, [projects, find, sort]);
  const sortFields: { value: SortField; label: string }[] = [
    { value: "lastActivityAt", label: t("ws.projects.sort.lastActivityAt") },
    { value: "name", label: t("ws.projects.sort.name") },
    { value: "videoCount", label: t("ws.projects.sort.videoCount") },
    { value: "createdAt", label: t("ws.projects.sort.createdAt") },
  ];
  const columns: TableColumnsType<ProjectListItem> = [
    {
      key: "name", title: t("ws.projects.column.name"), render: (_, p) => (
        <div className="ws-projects__name">
          <Link to={`/p/${p.id}`}>{p.name}</Link>
          {p.channelUrl ? <span className="ws-hint">{p.channelUrl}</span> : null}
        </div>
      ),
    },
    {
      key: "description", title: t("ws.projects.column.description"), ellipsis: { showTitle: false }, render: (_, p) => (
        p.description ? <Tooltip title={p.description} placement="topLeft"><span>{p.description}</span></Tooltip> : <span className="ws-hint">{t("ws.projects.noDescription")}</span>
      ),
    },
    { key: "aspect", title: t("ws.projects.aspect"), width: 120, render: (_, p) => <Tag bordered={false}>{p.aspect === "9:16" ? t("ws.projects.portrait") : t("ws.projects.landscape")}</Tag> },
    { key: "videos", title: t("ws.projects.column.videos"), width: 90, align: "right", render: (_, p) => p.videoCount },
    { key: "activity", title: t("ws.projects.column.lastActivity"), width: 160, render: (_, p) => <span title={new Date(p.lastActivityAt).toLocaleString(i18n.language)}>{relativeTime(p.lastActivityAt, i18n.language)}</span> },
    { key: "created", title: t("ws.projects.column.created"), width: 130, render: (_, p) => new Date(p.createdAt).toLocaleDateString(i18n.language) },
  ];

  return (
    <WorkspaceShell teamId={teamId} crumbs={team ? [{ label: team.name }] : []}>
      <main className="ws-page">
        <div className="ws-page__inner">
          <div className="ws-page__head">
            <div>
              <h1 className="ws-page__title">{t("ws.projects.title")}</h1>
              <p className="ws-page__lead">{t("ws.projects.lead")}</p>
            </div>
            {canCreate ? (
              <div className="ws-page__actions">
                <Button type="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>{t("ws.projects.new")}</Button>
              </div>
            ) : null}
          </div>
          {isLoading ? <div className="ws-center"><Spin /></div> : projects.length === 0 ? (
            <div className="ws-empty">
              <h2>{t("ws.projects.emptyTitle")}</h2>
              <p>{t(canCreate ? "ws.projects.emptyLead" : "ws.projects.emptyViewer")}</p>
              {canCreate ? <Button type="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>{t("ws.projects.new")}</Button> : null}
            </div>
          ) : (
            <>
              <div className="ws-projects__bar">
                <Input
                  allowClear value={find} onChange={(e) => setFind(e.target.value)} prefix={<Search size={15} aria-hidden />}
                  placeholder={t("ws.projects.search")} aria-label={t("ws.projects.search")} style={{ width: "clamp(200px, 32vw, 340px)" }}
                />
                <span className="ws-hint">{t("ws.projects.count", { count: shown.length })}</span>
                <span className="ws-spacer" />
                <SortDropdown fields={sortFields} sortBy={sort.sortBy} sortOrder={sort.sortOrder} onChange={(c) => setSort((s) => ({ ...s, ...c }))} />
                <ViewModeToggle value={view} onChange={setView} />
              </div>
              {shown.length === 0 ? <div className="ws-empty"><p>{t("ws.projects.noMatch")}</p></div> : view === "grid" ? (
                <div className="ws-grid">{shown.map((p) => <ProjectCard key={p.id} p={p} />)}</div>
              ) : (
                <Table<ProjectListItem>
                  rowKey="id" size="middle" columns={columns} dataSource={shown} pagination={shown.length > 50 ? { pageSize: 50, showSizeChanger: false } : false}
                  scroll={{ x: 820 }} onRow={(p) => ({ onDoubleClick: () => navigate(`/p/${p.id}`) })}
                />
              )}
            </>
          )}
        </div>
      </main>
      {teamId ? <NewProjectModal teamId={teamId} open={creating} onClose={() => setCreating(false)} /> : null}
    </WorkspaceShell>
  );
}
