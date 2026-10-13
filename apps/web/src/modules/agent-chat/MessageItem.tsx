import { useState } from "react";
import { ChevronRight, ListChecks, Paperclip, Sparkles, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentPart, ChatMessage } from "../../api/workspace-client";
import { useAiTranslation } from "../common/assistant-name";
import { useNow } from "../common/sse";
import { Markdown } from "../files/Markdown";
import { clock } from "../workspace/time";
import { phaseLabel, type Translate } from "./labels";
import { ChangedFiles } from "./ChangedFiles";
import { ToolChip } from "./ToolChip";

/** Not a step of the work: the reply chips the agent offers at the end. */
const SUGGEST = "mcp__studio__suggest_replies";

/** Which turns a person unfolded (or folded) in this session, kept while they move between chats. */
const unfolded = new Map<string, boolean>();

/** "45 giây", "1 phút 20 giây", "1 giờ 5 phút": how long a turn took, in words. */
export function spokenDuration(t: Translate, seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return t("ws.chat.duration.seconds", { s });
  if (s < 3600) {
    const m = Math.floor(s / 60);
    return s % 60 ? t("ws.chat.duration.minutesSeconds", { m, s: s % 60 }) : t("ws.chat.duration.minutes", { m });
  }
  return t("ws.chat.duration.hours", { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
}

/**
 * An answer split in two: the work (text between steps, the steps themselves, the reply chips) and the final answer,
 * the text after the last step, which always shows.
 */
export function splitTurn(parts: AgentPart[]): { visible: AgentPart[]; work: AgentPart[]; answer: AgentPart[]; steps: number } {
  const visible = parts.filter((p) => p.kind === "tool" || p.text.trim());
  let last = -1;
  visible.forEach((p, i) => { if (p.kind === "tool" && p.name !== SUGGEST) last = i; });
  const steps = visible.filter((p) => p.kind === "tool" && p.name !== SUGGEST).length;
  const after = visible.slice(last + 1);
  return { visible, work: [...visible.slice(0, last + 1), ...after.filter((p) => p.kind === "tool")], answer: after.filter((p) => p.kind === "text"), steps };
}

/** The live line of a running turn: who works, on what, for how long; and a Stop. It unfolds the steps so far. */
export function TurnStatus({ message, onStop, open, onToggle }: {
  message: ChatMessage;
  onStop?: (() => void) | undefined;
  open?: boolean;
  onToggle?: (() => void) | undefined;
}) {
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
      {onToggle ? (
        <button type="button" className="ws-turn-fold__caret" aria-expanded={!!open} aria-label={t(open ? "ws.chat.hideSteps" : "ws.chat.showSteps")} onClick={onToggle}>
          <ChevronRight size={13} aria-hidden />
        </button>
      ) : null}
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
export function MessageItem({ message, projectId, onStop, onOpenFile }: {
  message: ChatMessage;
  /** The project, for the drawer that shows what a changed file changed. */
  projectId?: string | undefined;
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
  return <AgentMessage message={message} projectId={projectId} onStop={onStop} onOpenFile={onOpenFile} />;
}

/**
 * The agent's answer as one folded line of work ("Đã làm 5 bước · 1 phút 20 giây", or the live status while it runs)
 * over the final answer. Unfolded, the steps show in order with what was said between them.
 */
function AgentMessage({ message, projectId, onStop, onOpenFile }: {
  message: ChatMessage;
  projectId?: string | undefined;
  onStop?: (() => void) | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  const [open, setOpenState] = useState(() => unfolded.get(message.id) ?? false);
  const setOpen = (v: boolean) => { unfolded.set(message.id, v); setOpenState(v); };
  const { visible, work, answer, steps } = splitTurn(message.parts);
  const running = message.status === "running";
  const folds = steps > 0;
  const renderPart = (p: AgentPart, i: number) => (p.kind === "text"
    ? <Markdown key={`t${i}`} text={p.text} />
    : <ToolChip key={p.id} part={p} onOpenFile={onOpenFile} />);
  const seconds = message.startedAt && message.finishedAt ? (Date.parse(message.finishedAt) - Date.parse(message.startedAt)) / 1000 : null;
  return (
    <div className="ws-msg ws-msg--agent">
      {running ? <TurnStatus message={message} onStop={onStop} open={open} onToggle={folds ? () => setOpen(!open) : undefined} /> : null}
      {!running && folds ? (
        <button type="button" className="ws-turn-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight size={13} className="ws-turn-fold__chevron" aria-hidden />
          <ListChecks size={13} aria-hidden />
          <span>{t("ws.chat.workSummary", { count: steps })}{seconds !== null && Number.isFinite(seconds) ? ` · ${spokenDuration(t, seconds)}` : ""}</span>
        </button>
      ) : null}
      {folds && open ? <div className="ws-turn-work">{work.map(renderPart)}</div> : null}
      {(folds ? answer : visible).map(renderPart)}
      {!visible.length && message.text ? <Markdown text={message.text} /> : null}
      {running ? null : <TurnStatus message={message} onStop={onStop} />}
      {projectId && !running && message.changedFiles?.length
        ? <ChangedFiles projectId={projectId} files={message.changedFiles} onOpenFile={onOpenFile} /> : null}
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
