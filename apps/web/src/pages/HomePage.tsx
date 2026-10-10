import { Spin } from "antd";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router-dom";
import { rememberedTeam } from "../helpers/last-team";
import { useTeams, WorkspaceShell } from "../modules/workspace/WorkspaceShell";

/** `/`: the projects of the team you worked in last (or your first team). */
export function HomePage() {
  const { t } = useTranslation();
  const { data: teams, isLoading } = useTeams();
  const items = teams?.items ?? [];
  const remembered = rememberedTeam();
  const team = items.find((x) => x.id === remembered) ?? items[0];
  if (team) return <Navigate to={`/t/${team.id}`} replace />;
  return (
    <WorkspaceShell>
      <main className="ws-page">
        <div className="ws-page__inner">
          {isLoading ? <div className="ws-center"><Spin /></div> : (
            <div className="ws-empty">
              <h2>{t("ws.home.noTeamTitle")}</h2>
              <p>{t("ws.home.noTeamLead")}</p>
            </div>
          )}
        </div>
      </main>
    </WorkspaceShell>
  );
}
