import { useRef, type CSSProperties } from "react";
import { Button, Result, Spin } from "antd";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, Pencil, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { StudioHttpError } from "../api/http";
import { useWorkspaceClient, type Project, type Video } from "../api/workspace-client";
import { FilesPanel } from "../modules/files/FilesPanel";
import { Markdown } from "../modules/files/Markdown";
import { ColumnResizer, useColumnWidths } from "../modules/workspace/ColumnResizer";
import { ProjectNav, VideoStatusBadge } from "../modules/workspace/ProjectNav";
import { ProjectSettingsPanel } from "../modules/workspace/ProjectSettingsPanel";
import { useTeamRole } from "../modules/workspace/use-team-role";
import { WorkspaceShell } from "../modules/workspace/WorkspaceShell";

type AsideTab = "files" | "settings";
const TABS: { key: AsideTab; icon: typeof FolderOpen }[] = [{ key: "files", icon: FolderOpen }, { key: "settings", icon: Settings }];

/** The project's CLAUDE.md, read here; the pencil opens it in the files panel to edit. */
function ProjectHome({ project, onOpenFile }: { project: Project; onOpenFile: (path: string) => void }) {
  const { t } = useTranslation();
  const client = useWorkspaceClient();
  const { data: claude } = useQuery({ queryKey: ["file", project.id, "CLAUDE.md"], queryFn: () => client.readFile(project.id, "CLAUDE.md") });
  return (
    <div className="ws-overview">
      <div className="ws-overview__inner">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <span style={{ color: "var(--ws-faint)", fontSize: 13 }}>{t("ws.home.claudeMd")}</span>
          <Button size="small" icon={<Pencil size={14} />} onClick={() => onOpenFile("CLAUDE.md")}>{t("ws.files.edit")}</Button>
        </div>
        {claude?.text ? <Markdown text={claude.text} /> : <Spin />}
      </div>
    </div>
  );
}

/** A video before its chat exists: its title and number, and where its files live. */
function VideoHome({ video, onOpenFolder }: { video: Video; onOpenFolder: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="ws-overview">
      <div className="ws-overview__inner">
        <p style={{ margin: 0, color: "var(--ws-faint)" }}>#{video.idx} <VideoStatusBadge status={video.status} /></p>
        <h1>{video.title}</h1>
        <p>{t("ws.video.lead")}</p>
        <Button icon={<FolderOpen size={14} />} onClick={onOpenFolder}>{t("ws.video.openFolder")}</Button>
      </div>
    </div>
  );
}

/** `/p/:projectId` and `/p/:projectId/v/:videoId`: the project's videos · the work · files and settings. */
export function ProjectPage() {
  const { t } = useTranslation();
  const { projectId = "", videoId } = useParams();
  const [search, setSearch] = useSearchParams();
  const client = useWorkspaceClient();
  const body = useRef<HTMLDivElement>(null);
  const { widths, set } = useColumnWidths();
  const { data: project, error, isLoading } = useQuery({ queryKey: ["project", projectId], queryFn: () => client.getProject(projectId), enabled: !!projectId });
  const { atLeast, teamName } = useTeamRole(project?.teamId);

  const tab = (search.get("tab") as AsideTab | null) ?? "files";
  const openFile = search.get("file");
  const setAside = (next: { tab?: AsideTab; file?: string | null }) => {
    const params = new URLSearchParams(search);
    if (next.tab) params.set("tab", next.tab);
    if (next.file !== undefined) { if (next.file) params.set("file", next.file); else params.delete("file"); }
    setSearch(params, { replace: true });
  };

  if (isLoading) return <WorkspaceShell><div className="ws-center"><Spin /></div></WorkspaceShell>;
  if (!project) {
    return (
      <WorkspaceShell>
        <Result status="404" title={t("ws.project.notFound")} subTitle={error instanceof StudioHttpError ? error.message : undefined}
          extra={<Link to="/">{t("common.backHome")}</Link>} />
      </WorkspaceShell>
    );
  }

  const video = project.videos.find((v) => v.id === videoId);
  const style = {
    ...(widths.nav ? { "--ws-nav-w": `${widths.nav}px` } : {}),
    ...(widths.aside ? { "--ws-aside-w": `${widths.aside}px` } : {}),
  } as CSSProperties;
  const crumbs = [
    ...(teamName ? [{ label: teamName, to: `/t/${project.teamId}` }] : []),
    { label: project.name, to: `/p/${project.id}` },
    ...(video ? [{ label: video.title }] : []),
  ];

  return (
    <WorkspaceShell teamId={project.teamId} crumbs={crumbs}>
      <div className="ws-body" ref={body} style={style}>
        <ProjectNav project={project} videos={project.videos} videoId={videoId} canCreate={atLeast("editor")} />
        <main className="ws-main">
          {video ? <VideoHome video={video} onOpenFolder={() => setAside({ tab: "files", file: null })} />
            : <ProjectHome project={project} onOpenFile={(file) => setAside({ tab: "files", file })} />}
        </main>
        <aside className="ws-aside" aria-label={t("ws.aside.label")}>
          <div className="ws-tabs" role="tablist">
            {TABS.map(({ key, icon: Icon }) => (
              <button key={key} type="button" role="tab" className="ws-tab" aria-selected={tab === key} onClick={() => setAside({ tab: key })}>
                <Icon size={15} aria-hidden />{t(`ws.aside.${key}`)}
              </button>
            ))}
          </div>
          <div className="ws-tabpanel" role="tabpanel">
            {tab === "files" ? (
              <FilesPanel projectId={project.id} canEdit={atLeast("editor")} openPath={openFile} onOpen={(file) => setAside({ file })} />
            ) : (
              <ProjectSettingsPanel project={project} canEdit={atLeast("producer")} canArchive={atLeast("owner")} />
            )}
          </div>
        </aside>
        <ColumnResizer column="nav" body={() => body.current} onResize={(w, persist) => set("nav", w, persist)} />
        <ColumnResizer column="aside" body={() => body.current} onResize={(w, persist) => set("aside", w, persist)} />
      </div>
    </WorkspaceShell>
  );
}
