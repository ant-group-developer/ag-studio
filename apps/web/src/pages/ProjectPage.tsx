import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Result, Spin } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Clapperboard, Film, FolderOpen, Settings, TrendingUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { StudioHttpError } from "../api/http";
import { useWorkspaceClient, type Learning } from "../api/workspace-client";
import { ActivityButton } from "../modules/agent-chat/ActivityButton";
import { ChatPanel } from "../modules/agent-chat/ChatPanel";
import { LearningModal } from "../modules/agent-chat/NewWorkModals";
import { useProjectEvents, useThread } from "../modules/agent-chat/use-thread";
import { FilesPanel } from "../modules/files/FilesPanel";
import { InputsPanel } from "../modules/inputs/InputsPanel";
import { ResearchPanel } from "../modules/research/ResearchPanel";
import { VideoPanel } from "../modules/video/VideoPanel";
import { StepRail } from "../modules/playbook/StepRail";
import { ColumnResizer, useColumnWidths } from "../modules/workspace/ColumnResizer";
import { ProjectNav, VideoStatusBadge } from "../modules/workspace/ProjectNav";
import { ProjectSettingsPanel } from "../modules/workspace/ProjectSettingsPanel";
import { useTeamRole } from "../modules/workspace/use-team-role";
import { WorkspaceShell } from "../modules/workspace/WorkspaceShell";

type AsideTab = "preview" | "files" | "inputs" | "research" | "settings";
const TABS: { key: AsideTab; icon: typeof FolderOpen; video?: boolean }[] = [
  { key: "preview", icon: Clapperboard, video: true }, { key: "files", icon: FolderOpen }, { key: "inputs", icon: Film }, { key: "research", icon: TrendingUp },
  { key: "settings", icon: Settings },
];

/**
 * `/p/:projectId` (the channel's chat), `/p/:projectId/c/:threadId` (another chat of the project) and
 * `/p/:projectId/v/:videoId` (a video's chat): the project's chats and videos · the chat with the agent · files and
 * settings. Like a Claude project: every chat shares the project's knowledge, each has its own session.
 */
export function ProjectPage() {
  const { t } = useTranslation();
  const { projectId = "", videoId, threadId: routeThread } = useParams();
  const [search, setSearch] = useSearchParams();
  const client = useWorkspaceClient();
  const body = useRef<HTMLDivElement>(null);
  const { widths, set } = useColumnWidths();
  const { data: project, error, isLoading } = useQuery({ queryKey: ["project", projectId], queryFn: () => client.getProject(projectId), enabled: !!projectId });
  const { data: threads } = useQuery({ queryKey: ["threads", projectId], queryFn: () => client.listThreads(projectId), enabled: !!projectId });
  const { data: video } = useQuery({ queryKey: ["video", videoId], queryFn: () => client.getVideo(videoId!), enabled: !!videoId });
  const { atLeast, teamName } = useTeamRole(project?.teamId);
  useProjectEvents(projectId || null);

  // the chat in the middle: the video's thread, the one in the URL, or the channel's first thread
  const channelThread = threads?.threads.find((x) => x.kind === "project" && x.title === "Kênh") ?? threads?.threads.find((x) => x.kind === "project");
  const threadId = videoId ? video?.threadId ?? null : routeThread ?? channelThread?.id ?? null;
  const { data: thread } = useThread(threadId);
  const { data: playbook } = useQuery({
    queryKey: ["playbook", projectId, videoId ?? null], queryFn: () => client.getPlaybook(projectId, videoId ?? null), enabled: !!projectId, refetchInterval: 15_000,
  });

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [attached, setAttached] = useState<Record<string, string[]>>({});
  const [learningOpen, setLearningOpen] = useState(false);
  useEffect(() => { setLearningOpen(false); }, [threadId]);

  const asked = search.get("tab") as AsideTab | null;
  const tab: AsideTab = asked && (asked !== "preview" || videoId) ? asked : videoId ? "preview" : "files";
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

  const currentVideo = project.videos.find((v) => v.id === videoId);
  const style = {
    ...(widths.nav ? { "--ws-nav-w": `${widths.nav}px` } : {}),
    ...(widths.aside ? { "--ws-aside-w": `${widths.aside}px` } : {}),
  } as CSSProperties;
  const crumbs = [
    ...(teamName ? [{ label: teamName, to: `/t/${project.teamId}` }] : []),
    { label: project.name, to: `/p/${project.id}` },
    ...(currentVideo ? [{ label: currentVideo.title }] : thread && thread.kind === "project" ? [{ label: thread.title }] : []),
  ];
  const key = threadId ?? "";
  const attach = (path: string) => setAttached((a) => ({ ...a, [key]: [...new Set([...(a[key] ?? []), path])] }));
  const setDraft = (text: string) => setDrafts((d) => ({ ...d, [key]: text }));
  const allSteps = playbook ? [...playbook.project, ...(playbook.video ?? [])] : [];
  const nextSteps = (playbook?.next ?? []).map((n) => allSteps.find((x) => x.key === n.key)!).filter(Boolean)
    .map((x) => ({ key: x.key, title: x.title, prompt: x.prompts.do }));
  const learning: Learning = { useLessons: thread?.useLessons ?? true, threads: (thread?.refs ?? []).map((r) => ({ threadId: r.threadId, mode: r.mode })) };

  return (
    <WorkspaceShell teamId={project.teamId} crumbs={crumbs} actions={<ActivityButton projectId={project.id} />}>
      <div className="ws-body" ref={body} style={style}>
        <ProjectNav project={project} videos={project.videos} current={{ threadId: videoId ? undefined : threadId ?? undefined, videoId }} canCreate={atLeast("editor")} />
        <main className="ws-main">
          {currentVideo ? (
            <div className="ws-main__head">
              <span className="ws-nav__num">#{currentVideo.idx}</span>
              <h1>{currentVideo.title}</h1>
              <VideoStatusBadge status={currentVideo.status} />
              <button type="button" className="ws-link" onClick={() => setAside({ tab: "files", file: null })}>{t("ws.video.openFolder")}</button>
            </div>
          ) : null}
          {playbook ? (
            <StepRail status={playbook} scope={videoId ? "video" : "project"} projectId={project.id} videoId={videoId ?? null}
              canWrite={atLeast("editor")} onPrompt={setDraft} onOpenFile={(file) => setAside({ tab: "files", file })} />
          ) : null}
          {threadId ? (
            <ChatPanel
              threadId={threadId} projectId={project.id} canWrite={atLeast("editor")} canDecide={atLeast} nextSteps={nextSteps}
              onOpenFile={(file) => setAside({ tab: "files", file })}
              draft={drafts[key] ?? ""} onDraftChange={setDraft}
              attachments={attached[key] ?? []} onAttachmentsChange={(paths) => setAttached((a) => ({ ...a, [key]: paths }))}
              onEditLearning={() => setLearningOpen(true)}
              emptyHint={currentVideo ? t("ws.chat.emptyVideo") : t("ws.chat.emptyProject")}
            />
          ) : <div className="ws-center"><Spin /></div>}
        </main>
        <aside className="ws-aside" aria-label={t("ws.aside.label")}>
          <div className="ws-tabs" role="tablist">
            {TABS.filter((x) => !x.video || videoId).map(({ key: k, icon: Icon }) => (
              <button key={k} type="button" role="tab" className="ws-tab" aria-selected={tab === k} onClick={() => setAside({ tab: k })}>
                <Icon size={15} aria-hidden />{t(`ws.aside.${k}`)}
              </button>
            ))}
          </div>
          <div className="ws-tabpanel" role="tabpanel">
            {tab === "preview" && videoId ? (
              <VideoPanel videoId={videoId} atLeast={atLeast} />
            ) : tab === "files" ? (
              <FilesPanel projectId={project.id} canEdit={atLeast("editor")} openPath={openFile} onOpen={(file) => setAside({ file })}
                onAttach={threadId && atLeast("editor") ? attach : undefined} />
            ) : tab === "inputs" ? (
              <InputsPanel projectId={project.id} {...(videoId ? { videoId } : {})} canEdit={atLeast("editor")} canProduce={atLeast("producer")} onOpenFile={(file) => setAside({ tab: "files", file })} />
            ) : tab === "research" ? (
              <ResearchPanel projectId={project.id} canRun={atLeast("editor")} onOpenFile={(file) => setAside({ tab: "files", file })} />
            ) : (
              <ProjectSettingsPanel project={project} canEdit={atLeast("producer")} canArchive={atLeast("owner")} onOpenFile={(file) => setAside({ tab: "files", file })} />
            )}
          </div>
        </aside>
        <ColumnResizer column="nav" body={() => body.current} onResize={(w, persist) => set("nav", w, persist)} />
        <ColumnResizer column="aside" body={() => body.current} onResize={(w, persist) => set("aside", w, persist)} />
      </div>
      {threadId ? <LearningModal projectId={project.id} threadId={threadId} current={learning} open={learningOpen} onClose={() => setLearningOpen(false)} /> : null}
    </WorkspaceShell>
  );
}
