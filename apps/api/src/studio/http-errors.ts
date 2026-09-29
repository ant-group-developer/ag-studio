import {
  ConflictException,
  HttpException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { RevisionConflictError, StudioRunError } from '@ag-studio/engine';

/** Engine errors -> HTTP: not_found 404, conflict/stale revision 409, invalid/rejected 422 (with details). */
export function toHttpError(e: unknown): unknown {
  if (e instanceof HttpException) return e;
  if (e instanceof RevisionConflictError) {
    return new ConflictException({ message: e.message, code: 'revision_conflict', currentRevision: e.current, baseRevision: e.base });
  }
  if (e instanceof StudioRunError) {
    const body = { message: e.message, code: e.code, ...e.details };
    if (e.code === 'not_found') return new NotFoundException(body);
    if (e.code === 'conflict') return new ConflictException(body);
    return new UnprocessableEntityException(body);
  }
  return e;
}

export async function mapErrors<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toHttpError(e);
  }
}
