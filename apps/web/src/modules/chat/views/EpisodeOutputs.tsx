import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStudioClient } from "../../../api/studio-client";

/** Render and export of an episode (mockup screen 11, without picking a machine — phase 3): progress, video, files. */
export function EpisodeOutputs({ productionId, episodeId }: { productionId: string; episodeId: string }) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const { data: ep } = useQuery({
    queryKey: ["episode", productionId, episodeId],
    queryFn: () => client.getEpisode(productionId, episodeId),
    refetchInterval: (q) => (q.state.data?.status === "producing" ? 5000 : false),
  });
  if (!ep) return null;
  return (
    <div className="chat-outputs">
      {ep.progress !== null ? (
        <div className="chat-progress" role="progressbar" aria-valuenow={ep.progress} aria-valuemin={0} aria-valuemax={100} aria-label={t("chat.outputs.rendering")}>
          <span style={{ width: `${ep.progress}%` }} />
        </div>
      ) : null}
      {ep.finalVideoUrl ? <video className="chat-timeline__video" src={ep.finalVideoUrl} controls preload="metadata" /> : null}
      {ep.exportFiles.length ? (
        <ul className="chat-doc__list">
          {ep.exportFiles.map((f) => <li key={f.url}><a href={f.downloadUrl}>{f.name}</a></li>)}
        </ul>
      ) : <p className="chat-doc__note">{t("chat.outputs.notYet")}</p>}
    </div>
  );
}
