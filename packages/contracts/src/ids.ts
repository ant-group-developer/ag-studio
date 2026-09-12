import { monotonicFactory } from "ulid";
import { z } from "zod";

export const ID_PREFIXES = {
  run: "run",
  stage_run: "stage",
  attempt: "attempt",
  artifact: "artifact",
  external_operation: "op",
  check_result: "check",
  event: "evt",
  source_item: "src",
  content_item: "content",
  content_variant: "variant",
  channel_package: "pkg",
  publication_job: "pub",
  incident: "inc",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const ULID_RE = "[0-9A-HJKMNP-TV-Z]{26}";

// Monotonic so ids generated in rapid succession (e.g. inserting several stage_runs for one
// run within the same millisecond) stay strictly increasing; `listStageRuns` etc. rely on
// `ORDER BY id` to reflect insertion order.
const ulid = monotonicFactory();

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${ulid()}`;
}

export function idSchema(kind: IdKind): z.ZodString {
  return z.string().regex(new RegExp(`^${ID_PREFIXES[kind]}_${ULID_RE}$`), `expected ${kind} id`);
}
