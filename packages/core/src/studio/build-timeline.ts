/**
 * `build-timeline` (GĐ2): builds a Timeline v3 draft for one episode from the approved series plan.
 *
 * Each item in the plan becomes one clip (the whole asset); section titles are copied; on-screen texts are
 * placed from the episode's texts_suggested and standard title/lower_third rules. Texts that would overlap
 * an earlier text at the same screen position are dropped.
 */
import {
  TEXT_POSITIONS_V2, TimelineV3Schema,
  type PlannedEpisode, type StudioBrief, type TimelineClip, type TimelineText, type TimelineV3,
} from "@harness/contracts";

export interface BuildTimelineInput {
  brief: Pick<StudioBrief, "music" | "canvas" | "fps" | "language" | "aspect">;
  episode: PlannedEpisode & {
    production_id: string;
    episode_id: string;
    assets: TimelineV3["assets"];
    alternates: TimelineV3["alternates"];
  };
}

type Position = (typeof TEXT_POSITIONS_V2)[number];

/** The longest on-screen text (`TimelineTextSchema.text`); the plan's titles may be up to 100. */
const MAX_TEXT_CHARS = 64;

/** A title fitted to the screen: cut at the last word that fits, with an ellipsis. */
function fitText(text: string): string {
  const s = text.trim();
  if (s.length <= MAX_TEXT_CHARS) return s;
  const head = s.slice(0, MAX_TEXT_CHARS - 1);
  const space = head.lastIndexOf(" ");
  return `${(space > MAX_TEXT_CHARS / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

/**
 * Build the draft TimelineV3 from the episode plan. Returns a validated v3 timeline.
 *
 * Clip numbering: C001, C002, ... Text numbering: T001, T002, ...
 */
export function buildEpisodeTimeline(input: BuildTimelineInput): TimelineV3 {
  const { brief, episode } = input;
  const assets = episode.assets;

  // --- clips (one per item, order preserved) ---
  let clipNo = 0;
  const clips: TimelineClip[] = episode.items.map((item) => ({
    clip_id: `C${String(++clipNo).padStart(3, "0")}`,
    asset_id: item.asset_id,
    section_title: item.section_title ?? null,
  }));

  // --- absolute start times for each clip (needed for text placement) ---
  const clipStarts: number[] = [];
  let cursor = 0;
  for (const c of clips) {
    clipStarts.push(cursor);
    cursor += assets[c.asset_id]?.duration_s ?? 0;
  }

  // --- texts ---
  // We track the "last end time" for each screen position to avoid overlaps.
  const lastEndAt = new Map<Position, number>();
  const occupies = (pos: Position, start: number, end: number): boolean => {
    const prev = lastEndAt.get(pos);
    return prev !== undefined && start < prev;
  };
  const place = (pos: Position, start: number, end: number): boolean => {
    if (occupies(pos, start, end)) return false;
    lastEndAt.set(pos, end);
    return true;
  };

  let textNo = 0;
  const texts: TimelineText[] = [];

  const push = (
    kind: TimelineText["kind"],
    text: string,
    start: number,
    duration: number,
    position: Position,
  ) => {
    if (place(position, start, start + duration)) {
      texts.push({
        text_id: `T${String(++textNo).padStart(3, "0")}`,
        kind,
        text: fitText(text),
        start: Math.round(start * 1000) / 1000,
        duration,
        position,
      });
    }
  };

  // Episode title at 0.5 s for 3.5 s (top_left)
  push("title", episode.title, 0.5, 3.5, "top_left");

  // Each section title after the first: lower_third at the section start for 3 s (bottom_left)
  let firstSection = true;
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!;
    if (clip.section_title) {
      if (firstSection) { firstSection = false; continue; } // skip the first section
      push("lower_third", clip.section_title, clipStarts[i]!, 3, "bottom_left");
    }
  }

  // texts_suggested at their item's clip start
  const kindToPos: Record<TimelineText["kind"], Position> = {
    title: "top_left",
    callout: "bottom_center",
    lower_third: "bottom_left",
  };
  for (const ts of episode.texts_suggested) {
    const itemStart = clipStarts[ts.at_item];
    if (itemStart === undefined) continue;
    push(ts.kind, ts.text, itemStart, 3.5, kindToPos[ts.kind]);
  }

  const timeline: TimelineV3 = {
    schema_version: "studio.timeline/v3",
    production_id: episode.production_id,
    episode_id: episode.episode_id,
    canvas: brief.canvas,
    fps: brief.fps,
    language: brief.language,
    clips,
    texts,
    music: brief.music,
    source_audio: { muted: false },
    assets,
    alternates: episode.alternates,
  };

  return TimelineV3Schema.parse(timeline);
}
