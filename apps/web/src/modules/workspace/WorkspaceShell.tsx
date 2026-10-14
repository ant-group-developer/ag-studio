import { Fragment, useState, type ReactNode } from "react";
import { Avatar, Dropdown } from "antd";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, ChevronRight, Compass, Plus, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useStudioClient } from "../../api/studio-client";
import { rememberedTeam } from "../../helpers/last-team";
import { useAppUserMenu } from "../common/use-app-user-menu";
import { useReplayTour } from "../onboarding/ProductTour";
import { StartChecklist } from "../onboarding/StartChecklist";
import { NewTeamModal } from "./NewTeamModal";
import { ProjectPicker } from "./ProjectPicker";
import { TeamPicker } from "./TeamPicker";
import "./workspace.css";

export interface Crumb {
  label: string;
  to?: string;
}

/** The first page of teams the person belongs to (or of every team, for a Studio admin); the picker searches the rest. */
export function useTeams() {
  const client = useStudioClient();
  return useQuery({ queryKey: ["teams", "all"], queryFn: () => client.listTeams({ page: 1, pageSize: 100 }), staleTime: 60_000 });
}

/** One team as `GET /teams/:id` knows it: its name (breadcrumbs), the caller's role, whether they are in it. */
export function useTeam(teamId: string | undefined) {
  const client = useStudioClient();
  return useQuery({ queryKey: ["team", teamId], queryFn: () => client.getTeam(teamId!), enabled: !!teamId, staleTime: 60_000 });
}

/**
 * Header of the workspace screens: brand, then where you are as one breadcrumb — the team (switch, make one, manage
 * them), the project (switch within the team), then the page's own crumbs — and the person's menu.
 */
export function WorkspaceShell({ teamId, teamCrumb = true, project, crumbs = [], actions, children }: {
  teamId?: string | undefined;
  /** False on the team management pages: their crumbs name the teams themselves. */
  teamCrumb?: boolean;
  /** The page's project: the crumb after the team, a switch to the team's other projects. */
  project?: { id: string; name: string } | undefined;
  /** What follows the team (and the project): a video, a chat, the page's title. */
  crumbs?: Crumb[];
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { data: teams } = useTeams();
  const { data: current } = useTeam(teamId);
  const items = teams?.items ?? [];
  const replayTour = useReplayTour(items);
  const { menu, picture, initials, nickname, isAdmin } = useAppUserMenu([
    ...(teamId ? [{ key: "team-settings", label: <Link to={`/teams/${teamId}`}>{t("ws.shell.teamSettings")}</Link> }] : []),
    { key: "tour", icon: <Compass size={14} />, label: t("ws.tour.replay"), onClick: replayTour },
  ]);
  // the activity log and the Claude stats: Studio admins and team owners
  const canReview = isAdmin || items.some((x) => x.role === "owner");
  // Studio-wide screens (Queue, music) have no team of their own: show the one worked in last
  const shown = teamId ?? items.find((x) => x.id === rememberedTeam())?.id ?? null;
  const [newTeam, setNewTeam] = useState(false);
  return (
    <div className="ws-app">
      <header className="ws-header">
        <Link to="/" className="ws-header__brand"><img src="/favicon.png" alt="" />{t("app.title")}</Link>
        {(teamCrumb && teams) || crumbs.length > 0 ? (
          <nav className="ws-crumbs" aria-label={t("ws.shell.breadcrumbs")}>
            {teamCrumb && teams ? <ChevronRight size={14} aria-hidden /> : null}
            {!teamCrumb ? null : teams && items.length > 0 ? (
              <TeamPicker value={shown} teams={teams} current={current} isAdmin={isAdmin} onNewTeam={() => setNewTeam(true)} />
            ) : teams ? (
              <button type="button" className="ws-icon-button ws-icon-button--outline" data-tour="team" onClick={() => setNewTeam(true)}>
                <Plus size={14} aria-hidden />{t("ws.shell.newTeam")}
              </button>
            ) : null}
            {teamId && project ? (
              <>
                <ChevronRight size={14} aria-hidden />
                <ProjectPicker teamId={teamId} project={project} />
              </>
            ) : null}
            {crumbs.map((c, i) => (
              <Fragment key={`${i}-${c.label}`}>
                <ChevronRight size={14} aria-hidden />
                {c.to && i < crumbs.length - 1 ? <Link to={c.to}>{c.label}</Link> : <span className="ws-crumbs__current">{c.label}</span>}
              </Fragment>
            ))}
          </nav>
        ) : null}
        <div className="ws-header__right">
          {actions}
          <StartChecklist />
          <Link to="/guide" className="ws-icon-button" data-tour="guide"><BookOpen size={14} aria-hidden />{t("ws.shell.guide")}</Link>
          {canReview ? <Link to="/stats" className="ws-icon-button">{t("ws.shell.stats")}</Link> : null}
          {canReview ? <Link to="/audit" className="ws-icon-button">{t("ws.shell.audit")}</Link> : null}
          {isAdmin ? <Link to="/queue" className="ws-icon-button">{t("ws.shell.queue")}</Link> : null}
          <Dropdown menu={menu} trigger={["click"]} placement="bottomRight">
            <button type="button" className="ws-icon-button" aria-label={nickname}>
              <Avatar src={picture} size="small">{picture ? undefined : initials}</Avatar>
            </button>
          </Dropdown>
        </div>
      </header>
      {isAdmin && current && !current.isMember ? (
        <div className="ws-admin-banner" role="note"><ShieldCheck size={14} aria-hidden />{t("ws.shell.adminView")}</div>
      ) : null}
      {children}
      <NewTeamModal open={newTeam} onClose={() => setNewTeam(false)} />
    </div>
  );
}
