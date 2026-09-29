import { useNavigate, useParams } from "react-router-dom";
import { useStudioClient } from "../../api/studio-client";
import { useSegmentMedia } from "../common/use-segment-media";
import { EditorView } from "./EditorView";

export function EditorPage() {
  const { productionId } = useParams<{ productionId: string }>();
  const client = useStudioClient();
  const media = useSegmentMedia();
  const navigate = useNavigate();

  if (!productionId) return null;

  return (
    <EditorView
      productionId={productionId}
      client={client}
      media={media}
      onDone={() => navigate(`/productions/${productionId}`)}
    />
  );
}
