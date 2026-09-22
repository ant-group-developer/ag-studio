import { z } from "zod";

export const checksumSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<hex>");
export const timestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/,
  "expected ISO 8601 UTC with Z suffix",
);
export const revisionSchema = z.number().int().min(1);
export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
export const secretRefSchema = z.string().regex(/^secret:\/\/[a-z0-9-]+\/[a-z0-9-]+$/);
export const jsonObjectSchema = z.record(z.string(), z.unknown());
export const mediaInfoSchema = z.object({
  width: z.number().int().min(1), height: z.number().int().min(1), fps: z.number().positive().nullable(), has_audio: z.boolean(),
}).strict();

export function schemaVersion<N extends string, V extends number = 1>(name: N, version: V = 1 as V) {
  return z.literal(`harness.${name}/v${version}` as const);
}

/** Declared shape of one stage output (spec §3); shared by workflow stage definitions and stage requests. */
export const expectedOutputSchema = z.object({
  type: z.string().min(1),
  mime_type: z.string().min(1),
  kind: z.enum(["file", "directory"]).default("file"),
  name: z.string().min(1).optional(),
  /**
   * Sub-project 5B: an output the stage MAY write but does not have to (`plan-edit`'s `overlays.json` --
   * an edit plan with no text at all is a legitimate plan). Absent/false means the usual "this stage must
   * produce it". Deliberately `.optional()` rather than `.default(false)`: `loadWorkflow` digests the
   * PARSED definition (`canonicalDigest(parsed.data)`), so a default would silently change the digest of
   * every already-released workflow (1.0.0/1.1.0/1.2.0, style-study, channel-*) and add `optional: false`
   * to every `expected_outputs` entry in every `stage-request.json` ever written. An absent key changes
   * nothing anywhere except the one output that opts in.
   */
  optional: z.boolean().optional(),
}).strict();

export type Checksum = z.infer<typeof checksumSchema>;
export type Timestamp = z.infer<typeof timestampSchema>;
export type ExpectedOutput = z.infer<typeof expectedOutputSchema>;
