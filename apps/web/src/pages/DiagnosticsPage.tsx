import { useAiTranslation } from "../modules/common/assistant-name";
import { DiagnosticsView } from "../modules/diagnostics/DiagnosticsView";
import { WorkspaceShell } from "../modules/workspace/WorkspaceShell";

/** A Studio admin's diagnostics of a period: errors, renders, the quality of the videos made (plan 2026-11-07). */
export function DiagnosticsPage() {
  const { t } = useAiTranslation();
  return (
    <WorkspaceShell crumbs={[{ label: t("ws.diag.title") }]}>
      <main className="ws-page">
        <div className="ws-page__inner ws-page__inner--wide">
          <div className="ws-page__head">
            <div>
              <h1 className="ws-page__title">{t("ws.diag.title")}</h1>
              <p className="ws-page__lead">{t("ws.diag.lead")}</p>
            </div>
          </div>
          <DiagnosticsView />
        </div>
      </main>
    </WorkspaceShell>
  );
}
