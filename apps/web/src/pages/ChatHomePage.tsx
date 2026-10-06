import { useTranslation } from "react-i18next";
import { ChatShell } from "../modules/chat/ChatShell";

/** Home of the chat UI (mockup screen 1): what to make, in one message. */
export function ChatHomePage() {
  const { t } = useTranslation();
  return (
    <ChatShell>
      <main className="chat-main chat-home">
        <h1 className="chat-home__title">{t("chat.home.title")}</h1>
        <p className="chat-home__lead">{t("chat.home.lead")}</p>
      </main>
    </ChatShell>
  );
}
