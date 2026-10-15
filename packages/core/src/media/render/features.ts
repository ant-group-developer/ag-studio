/** Which render workers can take a composition. A render worker validates `composition.json` with the strict
 * `CompositionSchema` it was built with, so a field it does not know fails the whole job (`text_style` on prod,
 * 2026-10-14). Every field the composition gains bumps `RENDER_FEATURE_LEVEL`; the worker reports its level to the
 * farm (`engines.studio_render`) and Studio asks for the level a composition needs (`requirements.studio_render_min`),
 * so a job only ever goes to a machine that reads it. Pure. */
import type { Composition } from "@harness/contracts";

/**
 * The composition features this build renders:
 * - 1: `music.duck.enabled` (music that does not duck under the voice);
 * - 2: `inspect` in the render payload (the worker checks the file it rendered and names `inspect.json` and the
 *   contact sheets in its manifest, `inspect.ts`).
 */
export const RENDER_FEATURE_LEVEL = 2;

/** The level a render payload with `inspect: true` needs: an older worker refuses the key. */
export const RENDER_INSPECT_LEVEL = 2;

/** The lowest `RENDER_FEATURE_LEVEL` that renders `c`: 0 when any render worker does. */
export function compositionFeatureLevel(c: Composition): number {
  if (c.music?.duck.enabled !== undefined) return 1;
  return 0;
}
