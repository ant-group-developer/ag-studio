/** Which render workers can take a composition. A render worker validates `composition.json` with the strict
 * `CompositionSchema` it was built with, so a field it does not know fails the whole job (`text_style` on prod,
 * 2026-10-14). Every field the composition gains bumps `RENDER_FEATURE_LEVEL`; the worker reports its level to the
 * farm (`engines.studio_render`) and Studio asks for the level a composition needs (`requirements.studio_render_min`),
 * so a job only ever goes to a machine that reads it. Pure. */
import type { Composition, TextEvent } from "@harness/contracts";

/**
 * The composition features this build renders:
 * - 1: `music.duck.enabled` (music that does not duck under the voice);
 * - 2: `inspect` in the render payload (the worker checks the file it rendered and names `inspect.json` and the
 *   contact sheets in its manifest, `inspect.ts`);
 * - 3: `text_events[].size`, `text_style.shadow`, and texts at one position that overlap in time, which this build
 *   stacks (`buildAss`) where an older one drew them on top of each other.
 */
export const RENDER_FEATURE_LEVEL = 3;

/** The level that stacks texts and reads a text's size and the text look's shadow. */
export const RENDER_TEXT_LEVEL = 3;

/** The level a render payload with `inspect: true` needs: an older worker refuses the key. */
export const RENDER_INSPECT_LEVEL = 2;

/** The lowest `RENDER_FEATURE_LEVEL` that renders `c`: 0 when any render worker does. */
export function compositionFeatureLevel(c: Composition): number {
  const needs = [
    c.music?.duck.enabled !== undefined ? 1 : 0,
    c.text_events.some((t) => t.size !== undefined) || c.text_style?.shadow !== undefined || textsOverlap(c.text_events) ? RENDER_TEXT_LEVEL : 0,
  ];
  return Math.max(...needs);
}

/** Two texts at one position on screen at the same time (an older render worker draws them over each other). */
export function textsOverlap(events: readonly TextEvent[]): boolean {
  return events.some((a, i) => events.some((b, j) => j > i && a.position === b.position && a.start < b.end && b.start < a.end));
}
