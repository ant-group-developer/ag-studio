import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/** A request body checked by a contracts schema: 400 `invalid` with every issue, else the parsed value. */
export function parseBody<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new BadRequestException({
      code: 'invalid',
      message: parsed.error.issues.map((x) => `${x.path.join('.') || 'body'}: ${x.message}`).join('; '),
    });
  }
  return parsed.data;
}
