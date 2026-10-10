import { App as AntApp } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient, type Project, type Video } from "../../api/workspace-client";

/** The status of a video, as a small badge. */
export function VideoStatusBadge({ status }: { status: Video["status"] }) {
  const { t } = useTranslation();
  return <span className={`ws-badge ws-badge--${status}`}>{t(`ws.video.status.${status}`)}</span>;
}

/** Left column of a project: the channel, a new video, the videos (newest first). */
export function ProjectNav({ project, videos, videoId, canCreate }: {
  project: Project;
  videos: Video[];
  videoId?: string | undefined;
  canCreate: boolean;
}) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () => client.createVideo(project.id),
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: ["project", project.id] });
      navigate(`/p/${project.id}/v/${v.id}`);
    },
    onError: (e) => void message.error(e instanceof StudioHttpError ? e.message : t("ws.video.createFailed")),
  });

  return (
    <nav className="ws-nav" aria-label={t("ws.nav.label")}>
      <div className="ws-nav__head">
        <div className="ws-nav__project">
          <Link to={`/p/${project.id}`} className="ws-nav__project-name" aria-current={videoId ? undefined : "page"}>{project.name}</Link>
          {project.channelUrl ? <span className="ws-nav__channel" title={project.channelUrl}>{project.channelUrl}</span> : null}
        </div>
        {canCreate ? (
          <button type="button" className="ws-nav__new" onClick={() => create.mutate()} disabled={create.isPending}>
            <Plus size={16} aria-hidden />{t("ws.video.new")}
          </button>
        ) : null}
      </div>
      <div className="ws-nav__scroll">
        <div className="ws-nav__label">{t("ws.nav.videos")}</div>
        {videos.length === 0 ? <p className="ws-nav__empty">{t("ws.nav.noVideos")}</p> : (
          <ul className="ws-nav__list">
            {videos.map((v) => (
              <li key={v.id}>
                <Link to={`/p/${project.id}/v/${v.id}`} className="ws-nav__item" aria-current={v.id === videoId ? "page" : undefined}>
                  <span className="ws-nav__num">#{v.idx}</span>
                  <span className="ws-nav__title" title={v.title}>{v.title}</span>
                  <VideoStatusBadge status={v.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}
