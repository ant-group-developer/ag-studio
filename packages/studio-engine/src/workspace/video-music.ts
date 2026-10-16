/**
 * A video's music on its timeline: when the video's own music changes (or it goes back to the project's), its latest
 * timeline takes it as a new revision, so the next preview render plays it without building the timeline again.
 */
import { applyTimelineOps } from "@harness/core";
import type { StudioDb } from "../studio-db.js";
import { writeTimelineSnapshot } from "./fit.js";
import { musicForVideo } from "./project-audio.js";
import { latestVideoRevision, saveVideoRevision } from "./project-db.js";

/**
 * The revision the video's timeline now plays its music in, or null when nothing was written: no timeline yet (the
 * fit takes the music when it builds one), the timeline already has it, or neither the video nor the project has
 * music (the timeline keeps what Studio picked by mood).
 */
export async function videoMusicToTimeline(db: StudioDb, o: { workspaceDir: string; projectId: string; videoId: string; authorId: string; now?: string }): Promise<number | null> {
  const latest = await latestVideoRevision(db, o.videoId);
  if (!latest) return null;
  const m = await musicForVideo(db, o.projectId, o.videoId);
  // the volume line is the timeline's own: it stays whatever the music is
  const playing = latest.data.music ? { track: latest.data.music.track, gain_db: latest.data.music.gain_db, ducking: latest.data.music.ducking } : null;
  if (!m || JSON.stringify(playing) === JSON.stringify(m.music)) return null;
  const next = applyTimelineOps(latest.data, [{ op: "setMusic", music: m.music }], latest.data.assets);
  const { revision } = await saveVideoRevision(db, o.videoId, { baseRevision: latest.revision, data: next, authorId: o.authorId, label: "music" });
  await writeTimelineSnapshot(db, o.workspaceDir, o.projectId, o.videoId, o.now);
  return revision;
}
