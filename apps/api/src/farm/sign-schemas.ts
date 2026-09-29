/**
 * Inlined from @ag-farm/protocol sign.ts to avoid ESM/CJS interop issues.
 */
import { z } from 'zod';

const IsoDateTimeSchema = z.string().datetime({ offset: true });
const RelativePathSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9._\-/]+$/)
  .refine(
    (value) => {
      const segments = value.split('/');
      return !segments.some((s) => s === '..' || s === '.' || s === '');
    },
    { message: 'Path must not contain empty, . or .. segments' },
  );

const InputNameSchema = z
  .string()
  .min(1)
  .max(320)
  .regex(/^[a-z][a-z0-9_]*(:[A-Za-z0-9._\-/]+)?$/);

const ContentTypeSchema = z.string().min(3).max(120);
const UploadIdSchema = z.string().min(1).max(1024);

export const SignOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('get'), input: InputNameSchema }),
  z.object({ op: z.literal('put'), output: RelativePathSchema, content_type: ContentTypeSchema }),
  z.object({
    op: z.literal('mp_create'),
    output: RelativePathSchema,
    content_type: ContentTypeSchema,
  }),
  z.object({
    op: z.literal('mp_part_urls'),
    output: RelativePathSchema,
    upload_id: UploadIdSchema,
    parts: z.array(z.number().int().min(1).max(10000)).min(1).max(100),
  }),
  z.object({
    op: z.literal('mp_complete'),
    output: RelativePathSchema,
    upload_id: UploadIdSchema,
    parts: z
      .array(
        z.object({
          part_number: z.number().int().min(1).max(10000),
          etag: z.string().min(1).max(200),
        }),
      )
      .min(1)
      .max(10000),
  }),
  z.object({ op: z.literal('mp_abort'), output: RelativePathSchema, upload_id: UploadIdSchema }),
]);
export type SignOp = z.infer<typeof SignOpSchema>;

export const SignRequestSchema = z.object({
  ops: z.array(SignOpSchema).min(1).max(100),
});
export type SignRequest = z.infer<typeof SignRequestSchema>;

const SourceMetaSchema = z.object({
  source_kind: z.enum(['original', 'proxy', 'preview']),
  watermarked: z.boolean(),
  start_ms: z.number().int().nonnegative().nullable(),
  end_ms: z.number().int().nonnegative().nullable(),
});

export const SignResultSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('get'),
    input: InputNameSchema,
    url: z.string().url(),
    expires_at: IsoDateTimeSchema,
    size_bytes: z.number().int().nonnegative().nullable(),
    content_type: z.string().nullable(),
    cache_key: z.string().max(200).nullable(),
    source: SourceMetaSchema.nullable(),
  }),
  z.object({
    op: z.literal('put'),
    output: RelativePathSchema,
    url: z.string().url(),
    expires_at: IsoDateTimeSchema,
    headers: z.record(z.string(), z.string()),
  }),
  z.object({
    op: z.literal('mp_create'),
    output: RelativePathSchema,
    upload_id: UploadIdSchema,
  }),
  z.object({
    op: z.literal('mp_part_urls'),
    output: RelativePathSchema,
    upload_id: UploadIdSchema,
    expires_at: IsoDateTimeSchema,
    urls: z.array(
      z.object({ part_number: z.number().int().min(1).max(10000), url: z.string().url() }),
    ),
  }),
  z.object({ op: z.literal('mp_complete'), output: RelativePathSchema }),
  z.object({ op: z.literal('mp_abort'), output: RelativePathSchema }),
]);
export type SignResult = z.infer<typeof SignResultSchema>;

export const SignResponseSchema = z.object({
  results: z.array(SignResultSchema),
});
export type SignResponse = z.infer<typeof SignResponseSchema>;

// --------------------------------------------------------------------------
// Inlined from @ag-farm/owner-client resolveOutputKey
// --------------------------------------------------------------------------
export function resolveOutputKey(prefix: string, relativePath: string): string {
  const parsed = RelativePathSchema.safeParse(relativePath);
  if (!parsed.success) {
    throw new Error(`Invalid relative path: ${relativePath}`);
  }
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `${p}${parsed.data}`;
}

// --------------------------------------------------------------------------
// Key-layout helpers — MUST match packages/executors/src/farm-executor.ts
// (stageInputPrefix / jobOutputPrefix). The sign.spec.ts asserts this.
// --------------------------------------------------------------------------

/**
 * S3 key prefix for stage input files that the executor uploaded before job
 * submission. Sign endpoint authorises `stage:<filename>` → this prefix + filename.
 *
 * Mirror of `stageInputPrefix()` in packages/executors/src/farm-executor.ts.
 */
export function getStageInputPrefix(
  productionId: string,
  stageKey: string,
  attemptId: string,
): string {
  return `productions/${productionId}/jobs/${stageKey}/${attemptId}/in/`;
}

/**
 * S3 prefix for one job's outputs. The worker uploads relative paths (e.g.
 * `render.json`, `renders/1/preview.mp4`) under it, so jobs never overwrite each other.
 *
 * Mirror of `jobOutputPrefix()` in packages/executors/src/farm-executor.ts.
 */
export function getJobOutputPrefix(
  productionId: string,
  stageKey: string,
  attemptId: string,
): string {
  return `productions/${productionId}/jobs/${stageKey}/${attemptId}/out/`;
}
