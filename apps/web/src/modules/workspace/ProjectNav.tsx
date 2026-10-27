import { useState, type MouseEvent } from "react";
import { Dropdown } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Ellipsis, Loader2, MessageSquarePlus, MessagesSquare, Pencil, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { useWorkspaceClient, type Project, type Video } from "../../api/workspace-client";
import { NewChatModal, NewVideoModal } from "../agent-chat/NewWorkModals";
import { CHANNEL_THREAD_TITLE, InlineRename, useRename } from "./InlineRename";

/** The status of a video, as a small badge. */
export function VideoStatusBadge({ status }: { status: Video["status"] }) {
  const { t } = useTranslation();
  return <span className={`ws-badge ws-badge--${status}`}>{t(`ws.video.status.${status}`)}</span>;
}

/** The ⋯ of a chat or a video in the nav: its commands (renaming, for now). */
function ItemMenu({ name, onRename }: { name: string; onRename: () => void }) {
  const { t } = useTranslation();
  return (
    <Dropdown trigger={["click"]} placement="bottomRight"
      menu={{ items: [{ key: "rename", icon: <Pencil size={14} />, label: t("ws.rename.action"), onClick: onRename }] }}>
      <button type="button" className="ws-icon-button ws-nav__more" aria-label={t("ws.rename.more", { name })}>
        <Ellipsis size={14} aria-hidden />
      </button>
    </Dropdown>
  );
}

/**
 * Left column of a project (like a Claude project): its chats (the channel's, and free ones), a new chat, a new
 * video, and the videos — each with its own chat. A spinner marks where the agent is working. Whoever may renames the
 * project, a chat or a video in place: double-click it, or its ⋯ → Rename.
 */
export function ProjectNav({ project, videos, current, canCreate, canRename, canRenameProject }: {
  project: Project;
  videos: Video[];
  /** What the middle column shows: a project thread or a video. */
  current: { threadId?: string | undefined; videoId?: string | undefined };
  canCreate: boolean;
  /** Rename the chats and the videos (editor and up). */
  canRename: boolean;
  /** Rename the project (producer and up). */
  canRenameProject: boolean;
}) {
  const { t } = useTranslation();
  const client = useWorkspaceClient();
  const navigate = useNavigate();
  const [newVideo, setNewVideo] = useState(false);
  const [newChat, setNewChat] = useState(false);
  // what is being renamed: "project", "t:<threadId>" or "v:<videoId>"
  const [editing, setEditing] = useState<string | null>(null);
  const rename = useRename(project);
  const startOn = (key: string) => (e: MouseEvent) => { e.preventDefault(); setEditing(key); };
  const { data } = useQuery({ queryKey: ["threads", project.id], queryFn: () => client.listThreads(project.id) });
  const threads = data?.threads ?? [];
  const chats = threads.filter((x) => x.kind === "project");
  const busyVideos = new Set(threads.filter((x) => x.kind === "video" && x.busy).map((x) => x.videoId));

  return (
    <nav className="ws-nav" aria-label={t("ws.nav.label")}>
      <div className="ws-nav__head">
        <div className="ws-nav__project">
          {editing === "project" ? (
            <InlineRename value={project.name} label={t("ws.rename.projectLabel")} maxLength={120} onDone={() => setEditing(null)}
              onSave={(title) => rename({ kind: "project", id: project.id, title })} />
          ) : (
            <div className="ws-nav__row">
              <Link to={`/p/${project.id}`} className="ws-nav__project-name" onDoubleClick={canRenameProject ? startOn("project") : undefined}>{project.name}</Link>
              {canRenameProject ? (
                <button type="button" className="ws-icon-button ws-nav__more" aria-label={t("ws.rename.project")} title={t("ws.rename.project")}
                  onClick={() => setEditing("project")}>
                  <Pencil size={13} aria-hidden />
                </button>
              ) : null}
            </div>
          )}
          {project.channelUrl ? <span className="ws-nav__channel" title={project.channelUrl}>{project.channelUrl}</span> : null}
        </div>
        {canCreate ? (
          <button type="button" className="ws-nav__new" data-tour="new-video" onClick={() => setNewVideo(true)}>
            <Plus size={16} aria-hidden />{t("ws.video.new")}
          </button>
        ) : null}
      </div>
      <div className="ws-nav__scroll">
        <div className="ws-nav__label">
          {t("ws.nav.chats")}
          {canCreate ? (
            <button type="button" className="ws-icon-button" onClick={() => setNewChat(true)} aria-label={t("ws.chat.new")} title={t("ws.chat.new")}>
              <MessageSquarePlus size={14} />
            </button>
          ) : null}
        </div>
        <ul className="ws-nav__list">
          {chats.map((c) => {
            const icon = c.busy ? <Loader2 size={14} className="ws-spin" aria-hidden /> : <MessagesSquare size={14} aria-hidden />;
            // the channel's chat keeps its name: the project's page finds it by it
            const renamable = canRename && c.title !== CHANNEL_THREAD_TITLE;
            return (
              <li key={c.id} className="ws-nav__row">
                {editing === `t:${c.id}` ? (
                  <div className="ws-nav__item ws-nav__item--editing">
                    {icon}
                    <InlineRename value={c.title} label={t("ws.rename.chatLabel")} maxLength={200} onDone={() => setEditing(null)}
                      onSave={(title) => rename({ kind: "thread", id: c.id, title })} />
                  </div>
                ) : (
                  <>
                    <Link to={`/p/${project.id}/c/${c.id}`} className="ws-nav__item" aria-current={current.threadId === c.id ? "page" : undefined}
                      onDoubleClick={renamable ? startOn(`t:${c.id}`) : undefined}>
                      {icon}
                      <span className="ws-nav__title" title={c.title}>{c.title}</span>
                    </Link>
                    {renamable ? <ItemMenu name={c.title} onRename={() => setEditing(`t:${c.id}`)} /> : null}
                  </>
                )}
              </li>
            );
          })}
        </ul>
        <div className="ws-nav__label">{t("ws.nav.videos")}</div>
        {videos.length === 0 ? <p className="ws-nav__empty">{t("ws.nav.noVideos")}</p> : (
          <ul className="ws-nav__list">
            {videos.map((v) => {
              const num = <span className="ws-nav__num">{busyVideos.has(v.id) ? <Loader2 size={13} className="ws-spin" aria-hidden /> : `#${v.idx}`}</span>;
              return (
                <li key={v.id} className="ws-nav__row">
                  {editing === `v:${v.id}` ? (
                    <div className="ws-nav__item ws-nav__item--editing">
                      {num}
                      <InlineRename value={v.title} label={t("ws.rename.videoLabel")} maxLength={200} onDone={() => setEditing(null)}
                        onSave={(title) => rename({ kind: "video", id: v.id, title })} />
                    </div>
                  ) : (
                    <>
                      <Link to={`/p/${project.id}/v/${v.id}`} className="ws-nav__item" aria-current={v.id === current.videoId ? "page" : undefined}
                        onDoubleClick={canRename ? startOn(`v:${v.id}`) : undefined}>
                        {num}
                        <span className="ws-nav__title" title={v.title}>{v.title}</span>
                        <VideoStatusBadge status={v.status} />
                      </Link>
                      {canRename ? <ItemMenu name={v.title} onRename={() => setEditing(`v:${v.id}`)} /> : null}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <NewVideoModal projectId={project.id} open={newVideo} onClose={() => setNewVideo(false)} />
      <NewChatModal projectId={project.id} open={newChat} onClose={() => setNewChat(false)} onCreated={(c) => navigate(`/p/${project.id}/c/${c.id}`)} />
    </nav>
  );
}
