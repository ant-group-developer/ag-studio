/** `loudnorm print_format=json` stderr parsing -- sub-project 5B Task 7, spec §5.3. Pure: no I/O, no clock,
 * no randomness. The runner (`run.ts`) makes two ffmpeg passes over the audio graph: the first one
 * (`measureOnly: true`) only exists to produce the `measured_*` numbers this module lifts out of stderr, and
 * the second one prints its own block whose `output_*` values become `render-report.loudness`. */
// `LoudnormMeasured` lives in `audio-graph.ts` (which needs it to build the second pass's filter) and is only
// IMPORTED here: re-exporting it would make the two `export *` lines in `packages/core/src/index.ts`
// ambiguous for that one name.
import type { LoudnormMeasured } from "./audio-graph.js";

/** The `output_*` half of a `loudnorm` json block: what the filter actually delivered on this pass. */
export interface LoudnormOutput {
  output_i: number;
  output_tp: number;
  output_lra: number;
}

/** A fully silent mix measures as `-inf`, which is not a JSON number and would poison every later
 * comparison (and `loudnorm`'s own `measured_I=` argument) as `-Infinity`. Spec §5.3 resolution: clamp it to
 * a finite floor well below anything a real programme reaches. */
const NEG_INF_FLOOR = -99;

const MEASURED_KEYS = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"] as const;
const OUTPUT_KEYS = ["output_i", "output_tp", "output_lra"] as const;

/** ffmpeg prints every value as a *string* ("-23.47", "-inf"); anything that is neither a finite number nor
 * an infinity marker is a parse failure, not a zero. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : v < 0 ? NEG_INF_FLOOR : -NEG_INF_FLOOR;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "-inf" || t === "-Infinity") return NEG_INF_FLOOR;
  if (t === "inf" || t === "+inf" || t === "Infinity") return -NEG_INF_FLOOR;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The `{...}` starting at or after `from`, brace-matched so a truncated block is rejected rather than
 * silently re-parsed against the wrong closing brace. */
function jsonBlockAfter(text: string, from: number): string | null {
  const open = text.indexOf("{", from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * The LAST `loudnorm` json block in `stderr`, split into its `measured_*` inputs (what the next pass feeds
 * back to the filter) and its `output_*` results (what `render-report.loudness` records).
 *
 * Last, not first: the render pass's stderr tail can still carry the measurement pass's block when both were
 * collected into one buffer, and a graph with more than one `loudnorm` instance would print one block each.
 * `null` whenever the block is absent, truncated, not JSON, or missing any of the eight values -- the caller
 * turns that into an `IO_ERROR` (measurement pass) or a `loudnorm_output_unparsed` warning (render pass).
 */
export function parseLoudnorm(stderr: string): { measured: LoudnormMeasured; output: LoudnormOutput } | null {
  const at = stderr.lastIndexOf("[Parsed_loudnorm");
  if (at < 0) return null;
  const block = jsonBlockAfter(stderr, at);
  if (block === null) return null;

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(block);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const values: Record<string, number> = {};
  for (const key of [...MEASURED_KEYS, ...OUTPUT_KEYS]) {
    const n = num(raw[key]);
    if (n === null) return null;
    values[key] = n;
  }

  return {
    measured: {
      input_i: values.input_i!,
      input_tp: values.input_tp!,
      input_lra: values.input_lra!,
      input_thresh: values.input_thresh!,
      target_offset: values.target_offset!,
    },
    output: { output_i: values.output_i!, output_tp: values.output_tp!, output_lra: values.output_lra! },
  };
}
