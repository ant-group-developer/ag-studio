/** Which render workers can take a composition. A render worker validates `composition.json` with the strict
 * `CompositionSchema` it was built with, so a field it does not know fails the whole job (`text_style` on prod,
 * 2026-10-14). Every field the composition gains bumps `RENDER_FEATURE_LEVEL`; the worker reports its level to the
 * farm (`engines.studio_render`) and Studio asks for the level a composition needs (`requirements.studio_render_min`),
 * so a job only ever goes to a machine that reads it. Pure. */
import type { Composition, TextEvent, TextFont } from "@harness/contracts";

/**
 * The composition features this build renders:
 * - 1: `music.duck.enabled` (music that does not duck under the voice);
 * - 2: `inspect` in the render payload (the worker checks the file it rendered and names `inspect.json` and the
 *   contact sheets in its manifest, `inspect.ts`);
 * - 3: `text_events[].size`, `text_style.shadow`, and texts at one position that overlap in time, which this build
 *   stacks (`buildAss`) where an older one drew them on top of each other;
 * - 4: `text_style.font` (a font the render worker ships, `TEXT_FONTS`);
 * - 5: `segments[].gain_db`, `source_even`, `music.envelope` (feedback-vps §4.3);
 * - 6: `look`, the colour grade of the picture (feedback-vps §4.6);
 * - 7: a Premiere export scales each clip to the sequence as the render fits it (Basic Motion), so a sequence larger
 *   than the proxies (4K) is filled;
 * - 8: the fonts of `TEXT_FONTS` after the first six (batch 1 of the fonts sheet, 2026-10-27).
 */
export const RENDER_FEATURE_LEVEL = 8;

/** The fonts render level 4 ships; any other font of `TEXT_FONTS` needs `RENDER_FONT_BATCH1_LEVEL`. */
const LEVEL4_FONTS: ReadonlySet<TextFont> = new Set<TextFont>(["Arial", "Be Vietnam Pro", "Noto Sans JP", "Noto Sans KR", "Noto Serif", "Playfair Display"]);

/** The level that ships batch 1 of the fonts sheet. */
export const RENDER_FONT_BATCH1_LEVEL = 8;

/** The level that reads a segment's gain, evens the source sound and draws the music's volume line. */
export const RENDER_AUDIO_LEVEL = 5;

/** The level that grades the picture (`look`). */
export const RENDER_LOOK_LEVEL = 6;

/** The level whose Premiere export scales clips to the sequence: a Premiere export at 4K needs it. */
export const RENDER_PREMIERE_SCALE_LEVEL = 7;

/** The level that stacks texts and reads a text's size and the text look's shadow. */
export const RENDER_TEXT_LEVEL = 3;

/** The level that ships the fonts of `TEXT_FONTS` and reads `text_style.font`. A render worker missing a shipped font
 * reports the level below (its self-check), so a composition set in one never goes to it. */
export const RENDER_FONT_LEVEL = 4;

/** The level a render payload with `inspect: true` needs: an older worker refuses the key. */
export const RENDER_INSPECT_LEVEL = 2;

/** The lowest `RENDER_FEATURE_LEVEL` that renders `c`: 0 when any render worker does. */
export function compositionFeatureLevel(c: Composition): number {
  const needs = [
    c.music?.duck.enabled !== undefined ? 1 : 0,
    c.text_events.some((t) => t.size !== undefined) || c.text_style?.shadow !== undefined || textsOverlap(c.text_events) ? RENDER_TEXT_LEVEL : 0,
    c.text_style?.font === undefined ? 0 : LEVEL4_FONTS.has(c.text_style.font) ? RENDER_FONT_LEVEL : RENDER_FONT_BATCH1_LEVEL,
    c.segments.some((s) => s.gain_db !== undefined) || c.source_even !== undefined || c.music?.envelope !== undefined ? RENDER_AUDIO_LEVEL : 0,
    c.look !== undefined ? RENDER_LOOK_LEVEL : 0,
  ];
  return Math.max(...needs);
}

/** Two texts at one position on screen at the same time (an older render worker draws them over each other). */
export function textsOverlap(events: readonly TextEvent[]): boolean {
  return events.some((a, i) => events.some((b, j) => j > i && a.position === b.position && a.start < b.end && b.start < a.end));
}
