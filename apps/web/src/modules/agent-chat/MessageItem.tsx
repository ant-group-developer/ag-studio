import { Paperclip, Sparkles, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChatMessage } from "../../api/workspace-client";
import { useAiTranslation } from "../common/assistant-name";
import { useNow } from "../common/sse";
import { Markdown } from "../files/Markdown";
import { clock } from "../workspace/time";
import { phaseLabel } from "./labels";
import { ToolChip } from "./ToolChip";

/** The live line under a running turn: who works, on what, for how long; and a Stop. */
export function TurnStatus({ message, onStop }: { message: ChatMessage; onStop?: (() => void) | undefined }) {
  const { t } = useAiTranslation();
  const running = message.status === "running";
  const now = useNow(1000, running || message.status === "pending");
  if (message.status === "pending") {
    return <div className="ws-turn-status"><span className="ws-dot ws-dot--wait" aria-hidden />{t("ws.chat.waiting")}</div>;
  }
  if (message.status === "rate_limited") {
    const at = message.notBefore ? new Date(message.notBefore).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    return <div className="ws-turn-status ws-turn-status--wait">{t("ws.chat.rateLimited", { at })}</div>;
  }
  if (!running) return null;
  const elapsed = message.startedAt ? (now - Date.parse(message.startedAt)) / 1000 : 0;
  const tools = message.parts.filter((p) => p.kind === "tool").length;
  return (
    <div className="ws-turn-status" role="status">
      <span className="ws-dot ws-dot--run" aria-hidden />
      <span className="ws-turn-status__who"><Sparkles size={13} aria-hidden />{t("ws.chat.agentName")}</span>
      <span className="ws-turn-status__what">{message.cancelRequested ? t("ws.chat.stopping") : phaseLabel(t, message.phase, message.parts)}</span>
      <span className="ws-turn-status__time">{clock(elapsed)}{tools ? ` · ${t("ws.chat.toolCount", { count: tools })}` : ""}</span>
      {onStop && !message.cancelRequested ? (
        <button type="button" className="ws-icon-button ws-icon-button--outline" onClick={onStop}><Square size={12} aria-hidden />{t("ws.chat.stop")}</button>
      ) : null}
    </div>
  );
}

/** One message of a thread: a person's bubble, Studio's note, or the agent's answer (text and tool calls in order). */
export function MessageItem({ message, onStop, onOpenFile }: {
  message: ChatMessage;
  onStop?: (() => void) | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  if (message.role === "user") {
    return (
      <div className="ws-msg ws-msg--user">
        <div className="ws-bubble">
          <div className="ws-bubble__text">{message.text}</div>
          {message.attachments.length ? (
            <div className="ws-attachments">
              {message.attachments.map((a) => (
                <button key={a} type="button" className="ws-attachment" onClick={() => onOpenFile?.(a)}><Paperclip size={12} aria-hidden />{a}</button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  if (message.role === "system") {
    return <div className="ws-msg ws-msg--system"><Markdown text={message.text} /></div>;
  }
  const visible = message.parts.filter((p) => p.kind === "tool" || p.text.trim());
  return (
    <div className="ws-msg ws-msg--agent">
      {visible.map((p, i) => (p.kind === "text"
        ? <Markdown key={i} text={p.text} />
        : <ToolChip key={p.id} part={p} onOpenFile={onOpenFile} />))}
      {!visible.length && message.text ? <Markdown text={message.text} /> : null}
      <TurnStatus message={message} onStop={onStop} />
      {message.status === "failed" ? <div className="ws-msg__error">{t("ws.chat.failed", { error: errorText(t, message.error) })}</div> : null}
      {message.status === "cancelled" ? <div className="ws-msg__note">{t("ws.chat.cancelled")}</div> : null}
      {message.status === "done" && message.error === "max_turns" ? <div className="ws-msg__note">{t("ws.chat.maxTurns")}</div> : null}
    </div>
  );
}

function errorText(t: (k: string) => string, error: string | null): string {
  if (error === "timeout") return t("ws.chat.errors.timeout");
  if (!error) return t("ws.chat.errors.unknown");
  return error;
}
