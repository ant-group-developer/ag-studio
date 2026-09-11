import { ulid } from "ulid";
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

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${ulid()}`;
}

export function idSchema(kind: IdKind): z.ZodString {
  return z.string().regex(new RegExp(`^${ID_PREFIXES[kind]}_${ULID_RE}$`), `expected ${kind} id`);
}
