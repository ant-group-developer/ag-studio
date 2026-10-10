import { useMemo } from "react";
import { App as AntApp, Spin } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, BookOpen } from "lucide-react";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient, type ChatMessage } from "../../api/workspace-client";
import { useAiTranslation } from "../common/assistant-name";
import { useStickToBottom } from "../common/use-stick-to-bottom";
import { LessonCards } from "../playbook/LessonCards";
import { ThreadJobs } from "../inputs/ThreadJobs";
import { Composer } from "./Composer";
import { MessageItem } from "./MessageItem";
import { useThread } from "./use-thread";

/** The options of the agent's last `suggest_replies` call in the newest answer, to send with one click. */
export function suggestionsOf(messages: ChatMessage[]): string[] {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  if (!last || last.status !== "done") return [];
  const call = [...last.parts].reverse().find((p) => p.kind === "tool" && p.name === "mcp__studio__suggest_replies");
  const options = call && call.kind === "tool" ? (call.input as { options?: unknown } | null)?.options : null;
  return Array.isArray(options) ? options.filter((o): o is string => typeof o === "string").slice(0, 4) : [];
}

/**
 * A chat thread with the agent (spec 2026-10-10 agent-workspace): its messages as they stream, a Stop while a turn
 * runs, quick replies the agent suggested, and the message box. The page owns the draft and the attachments so the
 * files panel can add to them.
 */
export function ChatPanel({ threadId, projectId, canWrite, onOpenFile, draft, onDraftChange, attachments, onAttachmentsChange, onEditLearning, emptyHint, nextSteps = [] }: {
  threadId: string;
  projectId: string;
  canWrite: boolean;
  onOpenFile: (path: string) => void;
  draft: string;
  onDraftChange: (text: string) => void;
  attachments: string[];
  onAttachmentsChange: (paths: string[]) => void;
  onEditLearning?: (() => void) | undefined;
  emptyHint?: string | undefined;
  /** Steps of the playbook to suggest (their "do" prompt fills the message box). */
  nextSteps?: { key: string; title: string; prompt: string }[];
}) {
  const { t } = useAiTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const { data: thread, isLoading } = useThread(threadId);
  const messages = thread?.messages ?? [];
  const lastUpdate = messages.at(-1)?.updatedAt ?? "";
  const signal = `${messages.length}:${lastUpdate}:${messages.at(-1)?.text.length ?? 0}`;
  const { ref, onScroll, atBottom, toBottom } = useStickToBottom(threadId, signal);
  const active = useMemo(() => [...messages].reverse().find((m) => m.role === "assistant" && (m.status === "running" || m.status === "pending")), [messages]);
  const suggestions = useMemo(() => suggestionsOf(messages), [messages]);

  const send = useMutation({
    mutationFn: (text: string) => client.sendMessage(threadId, { text, ...(attachments.length ? { attachments } : {}) }),
    onSuccess: () => {
      onAttachmentsChange([]);
      void qc.invalidateQueries({ queryKey: ["thread", threadId] });
    },
    onError: (e) => void message.error(e instanceof StudioHttpError ? e.message : t("ws.chat.sendFailed")),
  });
  const stop = useMutation({
    mutationFn: (messageId: string) => client.cancelTurn(threadId, messageId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["thread", threadId] }),
  });

  return (
    <div className="ws-chat">
      {thread && (thread.refs.length || !thread.useLessons || onEditLearning) ? (
        <div className="ws-chat__learning">
          <BookOpen size={13} aria-hidden />
          <span>
            {thread.useLessons ? t("ws.chat.learning.lessons") : t("ws.chat.learning.noLessons")}
            {thread.refs.length ? ` · ${t("ws.chat.learning.threads", { titles: thread.refs.map((r) => r.title).join(", ") })}` : ""}
          </span>
          {onEditLearning && canWrite ? <button type="button" className="ws-link" onClick={onEditLearning}>{t("ws.chat.learning.edit")}</button> : null}
        </div>
      ) : null}
      <div className="ws-chat__scroll" ref={ref} onScroll={onScroll}>
        <div className="ws-chat__inner">
          {isLoading ? <div className="ws-center"><Spin /></div> : messages.length === 0 ? (
            <div className="ws-chat__empty">{emptyHint ?? t("ws.chat.empty")}</div>
          ) : messages.map((m) => (
            <MessageItem
              key={m.id} message={m} onOpenFile={onOpenFile}
              onStop={canWrite && m.role === "assistant" && (m.status === "running" || m.status === "pending") ? () => stop.mutate(m.id) : undefined}
            />
          ))}
        </div>
      </div>
      {!atBottom ? (
        <button type="button" className="ws-chat__latest" onClick={toBottom} aria-label={t("ws.chat.latest")}><ArrowDown size={16} /></button>
      ) : null}
      <ThreadJobs projectId={projectId} threadId={threadId} canStop={canWrite} />
      <LessonCards projectId={projectId} threadId={threadId} canWrite={canWrite} />
      {canWrite ? (
        <div className="ws-chat__foot">
          {suggestions.length && !active ? (
            <div className="ws-suggestions">
              {suggestions.map((s) => <button key={s} type="button" onClick={() => send.mutate(s)} disabled={send.isPending}>{s}</button>)}
            </div>
          ) : !active && nextSteps.length && !draft.trim() ? (
            <div className="ws-suggestions ws-suggestions--steps">
              <span>{t("ws.steps.next")}</span>
              {nextSteps.map((n) => <button key={n.key} type="button" onClick={() => onDraftChange(n.prompt)}>{n.title}</button>)}
            </div>
          ) : null}
          <Composer
            draft={draft} onDraftChange={onDraftChange} attachments={attachments}
            onRemoveAttachment={(p) => onAttachmentsChange(attachments.filter((a) => a !== p))}
            running={!!active} onStop={active ? () => stop.mutate(active.id) : undefined}
            onSend={(text) => send.mutateAsync(text)}
          />
        </div>
      ) : null}
    </div>
  );
}
