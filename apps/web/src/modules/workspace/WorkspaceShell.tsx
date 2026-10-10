import { Fragment, type ReactNode } from "react";
import { Avatar, Dropdown, Select } from "antd";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { useStudioClient } from "../../api/studio-client";
import { rememberTeam } from "../../helpers/last-team";
import { useAppUserMenu } from "../common/use-app-user-menu";
import "./workspace.css";

export interface Crumb {
  label: string;
  to?: string;
}

/** Every team the person belongs to (or every team, for a Studio admin). */
export function useTeams() {
  const client = useStudioClient();
  return useQuery({ queryKey: ["teams", "all"], queryFn: () => client.listTeams({ page: 1, pageSize: 100 }), staleTime: 60_000 });
}

/** Header of the workspace screens: brand, the team, where you are, the person's menu. */
export function WorkspaceShell({ teamId, crumbs = [], actions, children }: {
  teamId?: string | undefined;
  crumbs?: Crumb[];
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: teams } = useTeams();
  const { menu, picture, initials, nickname, isAdmin } = useAppUserMenu([
    ...(teamId ? [{ key: "team-settings", label: <Link to={`/teams/${teamId}`}>{t("ws.shell.teamSettings")}</Link> }] : []),
  ]);
  const items = teams?.items ?? [];
  return (
    <div className="ws-app">
      <header className="ws-header">
        <Link to="/" className="ws-header__brand"><img src="/favicon.png" alt="" />{t("app.title")}</Link>
        {items.length > 0 ? (
          <Select
            size="small" variant="borderless" value={teamId ?? null} placeholder={t("ws.shell.pickTeam")} style={{ minWidth: 160 }}
            options={items.map((x) => ({ value: x.id, label: x.name }))}
            onChange={(id: string) => { rememberTeam(id); navigate(`/t/${id}`); }}
            aria-label={t("ws.shell.team")}
          />
        ) : null}
        {crumbs.length > 0 ? (
          <nav className="ws-crumbs" aria-label={t("ws.shell.breadcrumbs")}>
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
          {isAdmin ? <Link to="/queue" className="ws-icon-button">{t("ws.shell.queue")}</Link> : null}
          <Dropdown menu={menu} trigger={["click"]} placement="bottomRight">
            <button type="button" className="ws-icon-button" aria-label={nickname}>
              <Avatar src={picture} size="small">{picture ? undefined : initials}</Avatar>
            </button>
          </Dropdown>
        </div>
      </header>
      {children}
    </div>
  );
}
