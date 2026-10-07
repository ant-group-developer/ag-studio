import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStudioClient, type EpisodeRender } from "../../../api/studio-client";
import { OutputFiles } from "./OutputFiles";

/** A queued job no node took for this long: maybe none fits its machine type (the farm does not say why). */
const STUCK_MINUTES = 10;

/** Where the final render is: on which kind of farm machine, waiting for one, or done on one. */
function RenderMachineLine({ render }: { render: EpisodeRender }) {
  const { t } = useTranslation();
  const job = render.job;
  if (!job?.machine) return null;
  const machine = t(`chat.render.inline.${job.machine}`);
  const farm = render.farmStatus;
  if (farm?.status === "queued") {
    const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(job.createdAt)) / 60_000));
    return (
      <>
        <p className="chat-outputs__machine">{t("chat.outputs.waiting", { min: minutes })}</p>
        {minutes >= STUCK_MINUTES ? <p className="chat-doc__note chat-outputs__stuck">{job.machine === "any" ? t("chat.outputs.stuckAny") : t("chat.outputs.stuck", { machine })}</p> : null}
      </>
    );
  }
  if (farm?.status === "paused") return <p className="chat-outputs__machine">{t("chat.outputs.paused", { machine })}</p>;
  if (farm) {
    return <p className="chat-outputs__machine">{farm.progress !== null ? t("chat.outputs.farm", { machine, p: farm.progress }) : t("chat.outputs.farmNoProgress", { machine })}</p>;
  }
  return render.restartFrom !== null ? <p className="chat-outputs__machine">{t("chat.outputs.renderedOn", { machine })}</p> : null;
}

/** Render and export of an episode (mockup screen 11): the machine type, progress, video, files. */
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
      {ep.render ? <RenderMachineLine render={ep.render} /> : null}
      {ep.progress !== null ? (
        <div className="chat-progress" role="progressbar" aria-valuenow={ep.progress} aria-valuemin={0} aria-valuemax={100} aria-label={t("chat.outputs.rendering")}>
          <span style={{ width: `${ep.progress}%` }} />
        </div>
      ) : null}
      {ep.finalVideoUrl ? <video className="chat-timeline__video" src={ep.finalVideoUrl} controls preload="metadata" /> : null}
      {ep.exportFiles.length ? <OutputFiles files={ep.exportFiles} productionId={productionId} episodeId={episodeId} />
        : <p className="chat-doc__note">{t("chat.outputs.notYet")}</p>}
    </div>
  );
}
