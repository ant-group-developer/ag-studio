/** Shared time arithmetic for the media modules (sub-project 5A). Internal: not re-exported from
 * `packages/core/src/index.ts`, because `EPS` and `round3` are far too generic to belong to the public
 * surface of `@harness/core`. */

/**
 * Seconds below which two times count as equal.
 *
 * Every duration here is a decimal subtracted from another decimal, so a nominally exact comparison is not
 * one: `10.4 - 10.0` is `0.40000000000000036` and `9.95 - 9.8` is `0.1499999999999999`. Bounds that the
 * spec states as inclusive (a gap "of at least 0.15s", an edge "within 0.4s") are therefore compared with
 * this tolerance, which is three orders of magnitude finer than the 3-decimal output grid and so only ever
 * absorbs floating-point dust.
 */
export const EPS = 1e-6;

/** Rounds a time to the 3-decimal grid every emitted value uses. */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
