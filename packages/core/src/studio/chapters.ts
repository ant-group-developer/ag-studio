/**
 * YouTube chapter generation from a Timeline v3 layout (GĐ2).
 *
 * YouTube rules: first chapter must be at 0:00, at least 3 chapters total, each at least 10 s.
 * We merge short sections into the previous one and return [] when the result has fewer than 3 chapters.
 */
import type { YoutubeChapter } from "@harness/contracts";
import type { TimelineLayout } from "./layout.js";

const MIN_CHAPTER_SECONDS = 10;

/**
 * Build the chapter list from sections in the timeline layout.
 *
 * - First chapter is always at 0; if the first clip has no section title, uses the first section title in the
 *   timeline (if any) or "Mở đầu".
 * - Sections shorter than 10 s are merged into the previous chapter.
 * - Returns [] when fewer than 3 chapters remain after merging.
 */
export function youtubeChapters(layout: TimelineLayout): YoutubeChapter[] {
  if (!layout.duration) return [];

  // Build raw chapters from sections. We always need a chapter at 0.
  const sections = layout.sections;
  const firstTitle = sections[0]?.start === 0 ? sections[0].title : (sections[0]?.title ?? "Mở đầu");
  const raw: YoutubeChapter[] = [{ start_s: 0, title: sections[0]?.start === 0 ? sections[0].title : "Mở đầu" }];
  for (const s of sections) {
    if (s.start === 0) {
      raw[0] = { start_s: 0, title: s.title };
    } else {
      raw.push({ start_s: s.start, title: s.title });
    }
  }
  // Deduplicate by start time (keep last definition wins in case of duplicates)
  const byStart = new Map(raw.map((c) => [c.start_s, c]));
  const sorted = [...byStart.values()].sort((a, b) => a.start_s - b.start_s);

  // Ensure first chapter is at 0
  if (!sorted.length || sorted[0]!.start_s !== 0) {
    sorted.unshift({ start_s: 0, title: firstTitle });
  }

  // Merge chapters shorter than MIN_CHAPTER_SECONDS into the previous one
  const merged: YoutubeChapter[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const curr = sorted[i]!;
    const nextStart = sorted[i + 1]?.start_s ?? layout.duration;
    const chapterLen = nextStart - curr.start_s;
    if (chapterLen < MIN_CHAPTER_SECONDS && merged.length) {
      // too short — skip (discard this chapter; its footage becomes part of the previous one)
      continue;
    }
    merged.push(curr);
  }

  if (merged.length < 3) return [];
  return merged;
}

/**
 * Format the chapter list for the YouTube description, one line per chapter:
 * - `0:00 Title` (m:ss format)
 * - `1:00:00 Title` (h:mm:ss format, only when the episode is >= 1 hour)
 */
export function formatChapters(chapters: YoutubeChapter[]): string {
  const hasHours = chapters.some((c) => c.start_s >= 3600);
  return chapters.map((c) => `${stamp(c.start_s, hasHours)} ${c.title}`).join("\n");
}

function stamp(seconds: number, withHours: boolean): string {
  const totalMs = Math.max(0, Math.round(seconds));
  const h = Math.floor(totalMs / 3600);
  const m = Math.floor((totalMs % 3600) / 60);
  const s = totalMs % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return withHours ? `${h}:${mm}:${ss}` : `${h > 0 ? h + ":" : ""}${h > 0 ? mm : m}:${ss}`;
}
