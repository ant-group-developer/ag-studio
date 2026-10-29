/**
 * Work on a video happens in that video's chat (plan 2026-10-28 P4): an agent in the channel's chat (or a free one)
 * that starts on a video hands the work over — Studio posts what to do into the video's thread, its agent takes it up,
 * and the page of whoever is watching follows to that chat. The video's own work refused elsewhere says how.
 */
import { StudioRunError } from "../errors.js";
import type { VideoRecord } from "../workspace/project-db.js";
import { postSystemMessage, videoThread } from "./threads-db.js";
import type { AgentToolContext } from "./tools.js";

/** What a tool answers on a hand-over; the web reads `handoff` to open the video's chat. */
export interface Handoff { video_id: string; video_idx: number; video_title: string; thread_id: string }

/** Posts `text` into the video's thread from this one, as a note the video's agent acts on, for this turn's person. */
export async function handOffToVideo(ctx: AgentToolContext, video: VideoRecord, text: string): Promise<Handoff> {
  const now = ctx.now();
  const thread = await videoThread(ctx.db, { projectId: ctx.project.id, videoId: video.id, title: video.title, createdBy: ctx.claims.sub }, now);
  await postSystemMessage(ctx.db, {
    threadId: thread.id, text: `**Chuyển từ luồng "${ctx.thread.title}"**\n\n${text.trim()}`, trigger: "system", continueAgent: true,
    actor: { id: ctx.claims.sub, role: ctx.role },
  }, now);
  return { video_id: video.id, video_idx: video.idx, video_title: video.title, thread_id: thread.id };
}

/** What the agent is told once the work is handed over: say so in a sentence and stop. */
export const HANDOFF_NEXT = "Việc đã chuyển sang luồng chat của video (Studio mở luồng đó cho người dùng, agent ở đó làm tiếp). Viết một câu ngắn báo người dùng rồi dừng lượt này; đừng làm tiếp việc của video ở đây.";

/** A video's own work runs in its thread: anywhere else it is refused, saying to hand it over with `video_focus`. */
export function requireVideoThread(ctx: AgentToolContext, v: VideoRecord): void {
  if (ctx.video?.id === v.id) return;
  throw new StudioRunError(
    "rejected",
    `Việc của video #${v.idx} "${v.title}" làm trong luồng chat của video đó, không ở luồng này. Gọi video_focus {video_id: "${v.id}", message: "<việc cần làm và điều đã bàn>"} để chuyển việc sang đó, rồi dừng lượt này.`,
    { code: "use_video_thread" },
  );
}
