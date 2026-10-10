import { useEffect, useState } from "react";
import { Button, Spin } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";
import { useWorkspaceClient, type ProjectListItem } from "../api/workspace-client";
import { rememberTeam } from "../helpers/last-team";
import { NewProjectModal } from "../modules/workspace/NewProjectModal";
import { useTeams, WorkspaceShell } from "../modules/workspace/WorkspaceShell";
import { relativeTime } from "../modules/workspace/time";

const CAN_CREATE = new Set(["producer", "owner"]);

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

/** A team's projects — one per YouTube channel — and a new one. */
export function ProjectsPage() {
  const { t } = useTranslation();
  const { teamId = "" } = useParams();
  const client = useWorkspaceClient();
  const { data: teams } = useTeams();
  const [creating, setCreating] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ["projects", teamId], queryFn: () => client.listProjects(teamId), enabled: !!teamId });
  const team = teams?.items.find((x) => x.id === teamId);
  const canCreate = !!team?.role && CAN_CREATE.has(team.role);
  useEffect(() => { if (teamId) rememberTeam(teamId); }, [teamId]);

  const projects = data?.projects ?? [];
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
            <div className="ws-grid">{projects.map((p) => <ProjectCard key={p.id} p={p} />)}</div>
          )}
        </div>
      </main>
      {teamId ? <NewProjectModal teamId={teamId} open={creating} onClose={() => setCreating(false)} /> : null}
    </WorkspaceShell>
  );
}
