import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, MessageSquarePlus, MessagesSquare, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { useWorkspaceClient, type Project, type Video } from "../../api/workspace-client";
import { NewChatModal, NewVideoModal } from "../agent-chat/NewWorkModals";

/** The status of a video, as a small badge. */
export function VideoStatusBadge({ status }: { status: Video["status"] }) {
  const { t } = useTranslation();
  return <span className={`ws-badge ws-badge--${status}`}>{t(`ws.video.status.${status}`)}</span>;
}

/**
 * Left column of a project (like a Claude project): its chats (the channel's, and free ones), a new chat, a new
 * video, and the videos — each with its own chat. A spinner marks where the agent is working.
 */
export function ProjectNav({ project, videos, current, canCreate }: {
  project: Project;
  videos: Video[];
  /** What the middle column shows: a project thread or a video. */
  current: { threadId?: string | undefined; videoId?: string | undefined };
  canCreate: boolean;
}) {
  const { t } = useTranslation();
  const client = useWorkspaceClient();
  const navigate = useNavigate();
  const [newVideo, setNewVideo] = useState(false);
  const [newChat, setNewChat] = useState(false);
  const { data } = useQuery({ queryKey: ["threads", project.id], queryFn: () => client.listThreads(project.id) });
  const threads = data?.threads ?? [];
  const chats = threads.filter((x) => x.kind === "project");
  const busyVideos = new Set(threads.filter((x) => x.kind === "video" && x.busy).map((x) => x.videoId));

  return (
    <nav className="ws-nav" aria-label={t("ws.nav.label")}>
      <div className="ws-nav__head">
        <div className="ws-nav__project">
          <Link to={`/p/${project.id}`} className="ws-nav__project-name">{project.name}</Link>
          {project.channelUrl ? <span className="ws-nav__channel" title={project.channelUrl}>{project.channelUrl}</span> : null}
        </div>
        {canCreate ? (
          <button type="button" className="ws-nav__new" onClick={() => setNewVideo(true)}>
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
          {chats.map((c) => (
            <li key={c.id}>
              <Link to={`/p/${project.id}/c/${c.id}`} className="ws-nav__item" aria-current={current.threadId === c.id ? "page" : undefined}>
                {c.busy ? <Loader2 size={14} className="ws-spin" aria-hidden /> : <MessagesSquare size={14} aria-hidden />}
                <span className="ws-nav__title" title={c.title}>{c.title}</span>
              </Link>
            </li>
          ))}
        </ul>
        <div className="ws-nav__label">{t("ws.nav.videos")}</div>
        {videos.length === 0 ? <p className="ws-nav__empty">{t("ws.nav.noVideos")}</p> : (
          <ul className="ws-nav__list">
            {videos.map((v) => (
              <li key={v.id}>
                <Link to={`/p/${project.id}/v/${v.id}`} className="ws-nav__item" aria-current={v.id === current.videoId ? "page" : undefined}>
                  <span className="ws-nav__num">{busyVideos.has(v.id) ? <Loader2 size={13} className="ws-spin" aria-hidden /> : `#${v.idx}`}</span>
                  <span className="ws-nav__title" title={v.title}>{v.title}</span>
                  <VideoStatusBadge status={v.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      <NewVideoModal projectId={project.id} open={newVideo} onClose={() => setNewVideo(false)} />
      <NewChatModal projectId={project.id} open={newChat} onClose={() => setNewChat(false)} onCreated={(c) => navigate(`/p/${project.id}/c/${c.id}`)} />
    </nav>
  );
}
