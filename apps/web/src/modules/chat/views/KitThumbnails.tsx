import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { message } from "antd";
import { StudioHttpError, useStudioClient } from "../../../api/studio-client";
import { useAiTranslation } from "../../common/assistant-name";

/** How many keyframes of a video the kit gate offers per thumbnail idea. */
const KEYFRAMES_SHOWN = 6;

const thumbnailsKey = (productionId: string, episodeId: string) => ["thumbnails", productionId, episodeId] as const;

/** One idea of the kit: its video's keyframes; a click makes that picture, with the idea's words, the thumbnail. */
function IdeaKeyframes({ productionId, episodeId, assetId, text, onPick, busy }: {
  productionId: string; episodeId: string; assetId: string; text: string; busy: boolean;
  onPick: (keyframe: number) => void;
}) {
  const { t } = useAiTranslation();
  const client = useStudioClient();
  const { data: media, isError } = useQuery({
    queryKey: ["asset-media", productionId, assetId], queryFn: () => client.getAssetMedia(productionId, assetId), retry: false, staleTime: 5 * 60_000,
  });
  return (
    <div className="chat-kit-thumbs__idea">
      <div className="chat-files__label">“{text}”</div>
      {isError ? <p className="chat-doc__note">{t("chat.kitThumbs.noFrames")}</p> : (
        <div className="chat-kit-thumbs__frames">
          {(media?.keyframes ?? []).slice(0, KEYFRAMES_SHOWN).map((k, i) => (
            <button key={k.url} type="button" className="chat-kit-thumbs__frame" disabled={busy} onClick={() => onPick(i)}
              aria-label={t("chat.kitThumbs.pick", { text, s: Math.round(k.tMs / 1000) })}>
              <img src={k.url} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * At the YouTube kit gate (mockup screen 10): pick the thumbnail before the render, from a keyframe of each idea's
 * video; the idea's words are drawn on it in the branding style. Hidden without the footage scope.
 */
export function KitThumbnails({ productionId, episodeId, ideas, canEdit }: {
  productionId: string; episodeId: string; ideas: { asset_id: string; text: string }[]; canEdit: boolean;
}) {
  const { t } = useAiTranslation();
  const client = useStudioClient();
  const qc = useQueryClient();
  const { data: list } = useQuery({
    queryKey: thumbnailsKey(productionId, episodeId), queryFn: () => client.listThumbnails(productionId, episodeId), retry: false,
  });
  const pick = useMutation({
    mutationFn: (p: { assetId: string; keyframe: number; text: string }) => client.pickFootageThumbnail(productionId, episodeId, p),
    onSuccess: () => { void message.success(t("chat.kitThumbs.picked")); void qc.invalidateQueries({ queryKey: thumbnailsKey(productionId, episodeId) }); },
    onError: (e) => { void message.error(e instanceof StudioHttpError ? e.message : String(e)); },
  });
  if (!list || list.footageHidden || ideas.length === 0) return null;
  const selected = list.items.find((x) => x.id === list.selectedId) ?? null;
  return (
    <section className="chat-kit-thumbs" aria-label={t("chat.kitThumbs.title")}>
      <h3>{t("chat.kitThumbs.title")}</h3>
      {selected ? (
        <figure className="chat-kit-thumbs__selected">
          <img src={selected.url} alt={t("chat.kitThumbs.selected")} />
          <figcaption className="chat-doc__note">{t("chat.kitThumbs.selected")}</figcaption>
        </figure>
      ) : <p className="chat-doc__note">{t("chat.kitThumbs.none")}</p>}
      {canEdit ? (
        <>
          <p className="chat-doc__note">{t("chat.kitThumbs.hint")}</p>
          {ideas.map((idea, i) => (
            <IdeaKeyframes key={`${idea.asset_id}-${i}`} productionId={productionId} episodeId={episodeId} assetId={idea.asset_id} text={idea.text}
              busy={pick.isPending} onPick={(keyframe) => pick.mutate({ assetId: idea.asset_id, keyframe, text: idea.text })} />
          ))}
        </>
      ) : null}
    </section>
  );
}
