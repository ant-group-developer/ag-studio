import { useState } from "react";
import { Select } from "antd";
import { useQuery } from "@tanstack/react-query";
import { LayoutGrid } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useWorkspaceClient } from "../../api/workspace-client";

/**
 * The project crumb of the header: the page's project, and a switch to another project of the same team (found by
 * name), or back to the team's list. Reads the same query as the team's projects page, so it is cached both ways.
 */
export function ProjectPicker({ teamId, project }: {
  teamId: string;
  /** The page's project: shown before the team's list arrives, and when it is not in it (archived). */
  project: { id: string; name: string };
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useWorkspaceClient();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({ queryKey: ["projects", teamId], queryFn: () => client.listProjects(teamId), enabled: !!teamId, staleTime: 30_000 });
  const listed = data?.projects ?? [];
  const options = [
    ...(listed.some((p) => p.id === project.id) ? [] : [{ value: project.id, label: project.name }]),
    ...listed.map((p) => ({ value: p.id, label: p.name })),
  ];
  return (
    <Select
      className="ws-crumbs__select" suffixIcon={null} size="small" variant="borderless" value={project.id} popupMatchSelectWidth={260}
      showSearch optionFilterProp="label" options={options} open={open} onOpenChange={setOpen}
      notFoundContent={t("ws.shell.noProjectFound")}
      onSelect={(id: string) => { setOpen(false); navigate(`/p/${id}`); }}
      popupRender={(menu) => (
        <>
          {menu}
          <div className="ws-team-actions">
            <button type="button" className="ws-icon-button" onClick={() => { setOpen(false); navigate(`/t/${teamId}`); }}>
              <LayoutGrid size={14} aria-hidden />{t("ws.shell.allProjects")}
            </button>
          </div>
        </>
      )}
      aria-label={t("ws.shell.project")}
    />
  );
}
