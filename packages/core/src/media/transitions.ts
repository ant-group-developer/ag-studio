/** Per-segment transition assignment: never moves the timeline (`start`/`end`/`in`/`out` stay whatever
 * `timeline.video[]` already says), only decides what happens across each cut -- sub-project 5B Task 4, spec
 * §4.3. Pure: no I/O, no clock, no randomness. */
import type { BrandProfile, Composition, CompositionSegment, CompositionTransitionKind, Overlays, Timeline } from "@harness/contracts";
import { EPS } from "./time.js";

/**
 * One `transition_out` per `timeline.video[]` segment, in order. For every segment but the last, `kind`
 * comes from `overlays.transitions[before_order = next.order]` if the agent set one, else
 * `brand.transition.kind`, else `"cut"`; `seconds` is `brand?.transition.seconds ?? 0.4` regardless of kind.
 * The last segment is always `{ kind: "cut", seconds, tail_available: false }` and never counts toward
 * `requested`.
 *
 * `dissolve` needs a real tail on the outgoing source (`out + seconds <= duration(source)`, a missing
 * duration counts as no tail -> `"no_tail"`) and a long-enough incoming segment (`next duration >= 2 *
 * seconds` -> otherwise `"next_too_short"`); either failing downgrades to `cut`. `dip_black` needs both
 * segments at least `seconds` long -> otherwise downgrades to `cut` with reason `"too_short"`. `applied =
 * requested - downgraded.length`.
 */
export function assignTransitions(p: {
  timeline: Timeline;
  overlays: Overlays | null;
  brand: BrandProfile | null;
  sourceDurations: ReadonlyMap<string, number>;
}): { transition_out: CompositionSegment["transition_out"][]; summary: Composition["transitions"] } {
  const { timeline, overlays, brand, sourceDurations } = p;
  const segs = [...timeline.video].sort((a, b) => a.order - b.order);
  const seconds = brand?.transition.seconds ?? 0.4;
  const transitionOut: CompositionSegment["transition_out"][] = [];
  const downgraded: Composition["transitions"]["downgraded"] = [];
  let requested = 0;

  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k]!;

    if (k === segs.length - 1) {
      transitionOut.push({ kind: "cut", seconds, tail_available: false });
      continue;
    }

    const next = segs[k + 1]!;
    const requestedKind: CompositionTransitionKind = overlays?.transitions.find((t) => t.before_order === next.order)?.kind ?? brand?.transition.kind ?? "cut";
    if (requestedKind !== "cut") requested++;

    let kind: CompositionTransitionKind = requestedKind;
    let tailAvailable = false;

    if (requestedKind === "dissolve") {
      const sourceDuration = sourceDurations.get(seg.source_id);
      const hasTail = sourceDuration !== undefined && seg.out + seconds <= sourceDuration + EPS;
      const nextLongEnough = next.end - next.start >= 2 * seconds - EPS;
      if (!hasTail) {
        downgraded.push({ before_order: next.order, reason: "no_tail" });
        kind = "cut";
      } else if (!nextLongEnough) {
        downgraded.push({ before_order: next.order, reason: "next_too_short" });
        kind = "cut";
      } else {
        tailAvailable = true;
      }
    } else if (requestedKind === "dip_black") {
      const curLongEnough = seg.end - seg.start >= seconds - EPS;
      const nextLongEnough = next.end - next.start >= seconds - EPS;
      if (!curLongEnough || !nextLongEnough) {
        downgraded.push({ before_order: next.order, reason: "too_short" });
        kind = "cut";
      }
    }

    transitionOut.push({ kind, seconds, tail_available: tailAvailable });
  }

  return { transition_out: transitionOut, summary: { requested, applied: requested - downgraded.length, downgraded } };
}
