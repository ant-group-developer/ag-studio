import { useEffect, useRef } from "react";
import { App as AntApp } from "antd";
import { ArrowRight, Clapperboard } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import type { AgentPart, ChatMessage } from "../../api/workspace-client";
import { useAiTranslation } from "../common/assistant-name";
import { toolKey } from "./labels";

/** The work of a video handed to its own chat (plan 2026-10-28 P4): what `video_focus` / `video_create {start}` answer. */
export interface Handoff { video_id: string; video_idx: number; video_title: string; thread_id: string; part_id: string; ended_at: string }

const HANDOFF_TOOLS = new Set(["video_focus", "video_create"]);

/** The hand-overs a turn made, from its tools' answers. */
export function handoffsOf(parts: AgentPart[]): Handoff[] {
  const out: Handoff[] = [];
  for (const p of parts) {
    if (p.kind !== "tool" || !HANDOFF_TOOLS.has(toolKey(p.name)) || p.is_error || !p.ended_at || !p.result) continue;
    try {
      const h = (JSON.parse(p.result) as { handoff?: Omit<Handoff, "part_id" | "ended_at"> }).handoff;
      if (h?.video_id) out.push({ ...h, part_id: p.id, ended_at: p.ended_at });
    } catch { /* a shortened or older answer: no card */ }
  }
  return out;
}

/** Under the turn: the video chat the work went to, a link there. */
export function HandoffCards({ parts, projectId }: { parts: AgentPart[]; projectId: string }) {
  const { t } = useAiTranslation();
  const list = handoffsOf(parts);
  if (!list.length) return null;
  return (
    <>
      {list.map((h) => (
        <Link key={h.part_id} to={`/p/${projectId}/v/${h.video_id}`} className="ws-handoff">
          <Clapperboard size={14} aria-hidden />
          <span className="ws-handoff__text">{t("ws.chat.handoff", { idx: h.video_idx, title: h.video_title })}</span>
          <ArrowRight size={14} aria-hidden />
        </Link>
      ))}
    </>
  );
}

/**
 * Follows a hand-over made while the chat is open: the page goes to the video's chat and says so. Hand-overs already
 * there when the chat opened are only cards.
 */
export function useFollowHandoff(messages: ChatMessage[], projectId: string) {
  const { t } = useAiTranslation();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const opened = useRef(new Date().toISOString());
  const followed = useRef(new Set<string>());
  useEffect(() => {
    const fresh = messages.flatMap((m) => (m.role === "assistant" ? handoffsOf(m.parts) : []))
      .filter((h) => h.ended_at > opened.current && !followed.current.has(h.part_id));
    const last = fresh.at(-1);
    if (!last) return;
    for (const h of fresh) followed.current.add(h.part_id);
    void message.info(t("ws.chat.handoffFollowed", { idx: last.video_idx, title: last.video_title }));
    navigate(`/p/${projectId}/v/${last.video_id}`);
  }, [messages, projectId, navigate, message, t]);
}
