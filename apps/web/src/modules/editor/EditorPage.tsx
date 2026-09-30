import { useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useStudioClient } from "../../api/studio-client";
import { EditorView } from "./EditorView";
import type { AssetMediaLookup } from "./types";

export function EditorPage() {
  const { productionId, episodeId } = useParams<{ productionId: string; episodeId: string }>();
  const client = useStudioClient();
  const navigate = useNavigate();

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
  );
}
