import { useAiTranslation } from "../modules/common/assistant-name";
import { ClaudeStatsView } from "../modules/stats/ClaudeStatsView";
import { WorkspaceShell } from "../modules/workspace/WorkspaceShell";

/** Claude chat statistics of the teams a person may read (a Studio admin: every team). */
export function StatsPage() {
  const { t } = useAiTranslation();
  return (
    <WorkspaceShell crumbs={[{ label: t("ws.stats.title") }]}>
      <main className="ws-page">
        <div className="ws-page__inner ws-page__inner--wide">
          <div className="ws-page__head">
            <div>
              <h1 className="ws-page__title">{t("ws.stats.title")}</h1>
              <p className="ws-page__lead">{t("ws.stats.lead")}</p>
            </div>
          </div>
          <ClaudeStatsView />
        </div>
      </main>
    </WorkspaceShell>
  );
}
