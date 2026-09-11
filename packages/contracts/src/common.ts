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

export function schemaVersion<N extends string>(name: N) {
  return z.literal(`harness.${name}/v1` as const);
}

export type Checksum = z.infer<typeof checksumSchema>;
export type Timestamp = z.infer<typeof timestampSchema>;
