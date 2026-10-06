import { useParams } from "react-router-dom";
import { ChatShell } from "../modules/chat/ChatShell";

/** One video (or one of its episodes): the chat in the middle, the result of the step on the right. */
export function ChatProductionPage() {
  const { productionId, episodeId } = useParams();
  return (
    <ChatShell productionId={productionId} episodeId={episodeId}>
      <main className="chat-main" />
    </ChatShell>
  );
}
