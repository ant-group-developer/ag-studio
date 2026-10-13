import { useState } from "react";
import { Button, Spin } from "antd";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router-dom";
import { rememberedTeam } from "../helpers/last-team";
import { NewTeamModal } from "../modules/workspace/NewTeamModal";
import { useTeams, WorkspaceShell } from "../modules/workspace/WorkspaceShell";

/** `/`: the projects of the team you worked in last (or your first team); in no team yet, make one. */
export function HomePage() {
  const { t } = useTranslation();
  const { data: teams, isLoading } = useTeams();
  const items = teams?.items ?? [];
  const remembered = rememberedTeam();
  // a Studio admin lists every team: start in one of their own before any other
  const team = items.find((x) => x.id === remembered) ?? items.find((x) => x.isMember) ?? items[0];
  const [newTeam, setNewTeam] = useState(false);
  if (team) return <Navigate to={`/t/${team.id}`} replace />;
  return (
    <WorkspaceShell>
      <main className="ws-page">
        <div className="ws-page__inner">
          {isLoading ? <div className="ws-center"><Spin /></div> : (
            <div className="ws-empty">
              <h2>{t("ws.home.noTeamTitle")}</h2>
              <p>{t("ws.home.noTeamLead")}</p>
              <Button type="primary" onClick={() => setNewTeam(true)}>{t("ws.teams.create")}</Button>
              <NewTeamModal open={newTeam} onClose={() => setNewTeam(false)} />
            </div>
          )}
        </div>
      </main>
    </WorkspaceShell>
  );
}
