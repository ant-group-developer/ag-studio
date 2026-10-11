import { AuditTable } from "../modules/audit/AuditTable";
import { useAiTranslation } from "../modules/common/assistant-name";
import { WorkspaceShell } from "../modules/workspace/WorkspaceShell";

/** The activity log of the teams a person may read (a Studio admin: every team and Studio-wide changes). */
export function AuditPage() {
  const { t } = useAiTranslation();
  return (
    <WorkspaceShell crumbs={[{ label: t("ws.audit.title") }]}>
      <main className="ws-page">
        <div className="ws-page__inner ws-page__inner--wide">
          <div className="ws-page__head">
            <div>
              <h1 className="ws-page__title">{t("ws.audit.title")}</h1>
              <p className="ws-page__lead">{t("ws.audit.lead")}</p>
            </div>
          </div>
          <AuditTable />
        </div>
      </main>
    </WorkspaceShell>
  );
}
