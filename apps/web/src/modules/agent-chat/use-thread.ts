import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWorkspaceClient, type ChatMessage, type ThreadDetail } from "../../api/workspace-client";
import { useEventStream } from "../common/sse";

/** Messages merged by id (the newer copy wins), in thread order. A refetch replaces the list (a turn the server
 *  dropped to answer later messages leaves it then). */
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) {
    const old = byId.get(m.id);
    if (!old || old.updatedAt <= m.updatedAt) byId.set(m.id, m);
  }
  return [...byId.values()].sort((x, y) => x.seq - y.seq);
}

/**
 * A thread and its messages, kept live: the thread's event stream pushes each message as it changes (a running turn
 * streams its text and tool calls), merged into the query cache. Without the stream it polls.
 */
export function useThread(threadId: string | null) {
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const key = ["thread", threadId];
  const live = useEventStream(threadId ? `thread:${threadId}` : null, (signal) => client.openThreadEvents(threadId!, signal), (e) => {
    if (e.event !== "messages") return;
    const { messages } = JSON.parse(e.data) as { messages: ChatMessage[] };
    qc.setQueryData<ThreadDetail>(key, (old) => (old ? { ...old, messages: mergeMessages(old.messages, messages) } : old));
    // a turn may have proposed a card, a decision posts a line: the cards follow the messages
    void qc.invalidateQueries({ queryKey: ["actions", threadId] });
  });
  const query = useQuery({
    queryKey: key,
    queryFn: () => client.getThread(threadId!),
    enabled: !!threadId,
    refetchInterval: (q) => {
      if (live) return false;
      const busy = q.state.data?.messages.some((m) => m.role === "assistant" && (m.status === "pending" || m.status === "running"));
      return busy ? 1500 : 10_000;
    },
  });
  return { ...query, live };
}

/** Refetches a project's lists (threads, videos, activity) whenever something in it changes on the server. */
export function useProjectEvents(projectId: string | null): boolean {
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  return useEventStream(projectId ? `project:${projectId}` : null, (signal) => client.openProjectEvents(projectId!, signal), (e) => {
    if (e.event !== "changed") return;
    void qc.invalidateQueries({ queryKey: ["project", projectId] });
    void qc.invalidateQueries({ queryKey: ["threads", projectId] });
    void qc.invalidateQueries({ queryKey: ["activity", projectId] });
    void qc.invalidateQueries({ queryKey: ["playbook", projectId] });
    void qc.invalidateQueries({ queryKey: ["lessons", projectId] });
    void qc.invalidateQueries({ queryKey: ["sources", projectId] });
    void qc.invalidateQueries({ queryKey: ["jobs", projectId] });
  });
}
