import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useStudioClient } from "../../api/studio-client";
import { EditorView } from "./EditorView";
import type { AssetMediaLookup } from "./types";

export function EditorPage() {
  const { productionId, episodeId } = useParams<{ productionId: string; episodeId: string }>();
  const client = useStudioClient();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const media: AssetMediaLookup = useCallback(
    async (assetId: string) => {
      if (!productionId) return null;
      try {
        return await client.getAssetMedia(productionId, assetId);
      } catch {
        return null;
      }
    },
    [client, productionId]
  );

  if (!productionId || !episodeId) return null;

  return (
    <>
      <div className="editor-back-to-chat">
        <Link to={`/v/${productionId}/e/${episodeId}`}>{t("chat.manual.backToChat")}</Link>
      </div>
      <EditorView
        productionId={productionId}
        episodeId={episodeId}
        client={client}
        media={media}
        onRerender={async () => {
          try {
            await client.rerenderEpisode(productionId, episodeId);
            navigate(`/productions/${productionId}`);
          } catch (e) {
            console.error("Rerender failed:", e);
          }
        }}
      />
    </>
  );
}
