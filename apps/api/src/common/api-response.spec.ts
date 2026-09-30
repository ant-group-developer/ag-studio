/**
 * Unit tests for the API envelope: ApiResponseInterceptor and ApiExceptionFilter.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpException, HttpStatus } from '@nestjs/common';
import { of } from 'rxjs';
import { ApiResponseInterceptor } from './api-response.interceptor';
import { ApiExceptionFilter } from './api-exception.filter';
import { AgGoClientError } from '../ag-go/client';
import { Logger } from '@nestjs/common';
import type { ArgumentsHost, ExecutionContext } from '@nestjs/common';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(
  overrides: { statusCode?: number; requestId?: string; contentType?: string | null } = {},
): ExecutionContext {
  const request = { requestId: overrides.requestId ?? 'req-test-id' };
  const headers: Record<string, string | undefined> = {};
  if (overrides.contentType !== null) {
    headers['content-type'] = overrides.contentType ?? 'application/json';
  }
  const response = {
    headersSent: false,
    statusCode: overrides.statusCode ?? 200,
    getHeader: (name: string) => headers[name],
    setHeader: vi.fn(),
  };
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function makeHost(overrides: { requestId?: string } = {}): ArgumentsHost {
  const request = { requestId: overrides.requestId ?? 'req-host-id' };
  let statusCode = 200;
  let body: unknown = undefined;
  const response = {
    status(s: number) { statusCode = s; return response; },
    json(b: unknown) { body = b; },
    getHeader: () => undefined,
    getStatusCode: () => statusCode,
    _body: () => body,
  };
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    _response: () => response,
  } as unknown as ArgumentsHost;
}

// ---------------------------------------------------------------------------
// ApiResponseInterceptor
// ---------------------------------------------------------------------------

describe('ApiResponseInterceptor', () => {
  const reflector = { getAllAndOverride: vi.fn().mockReturnValue(false) } as never;
  let interceptor: ApiResponseInterceptor;

  beforeEach(() => {
    interceptor = new ApiResponseInterceptor(reflector);
  });

  it('wraps a plain object in the envelope', async () => {
    const ctx = makeContext();
    const handler = { handle: () => of({ foo: 'bar' }) };
    const result = await new Promise((resolve) => {
      interceptor.intercept(ctx, handler as never).subscribe(resolve);
    });

    expect(result).toMatchObject({
      success: true,
      data: { foo: 'bar' },
      requestId: 'req-test-id',
      error: null,
    });
    expect(typeof (result as Record<string, unknown>).timestamp).toBe('string');
  });

  it('does not double-wrap an already-enveloped body', async () => {
    const ctx = makeContext();
    const alreadyWrapped = { data: 42, requestId: 'x', timestamp: 't', success: true, error: null };
    const handler = { handle: () => of(alreadyWrapped) };
    const result = await new Promise((resolve) => {
      interceptor.intercept(ctx, handler as never).subscribe(resolve);
    });
    expect(result).toEqual(alreadyWrapped);
  });

  it('skips wrapping for 204 responses', async () => {
    const ctx = makeContext({ statusCode: 204 });
    const handler = { handle: () => of(undefined) };
    const result = await new Promise((resolve) => {
      interceptor.intercept(ctx, handler as never).subscribe(resolve);
    });
    expect(result).toBeUndefined();
  });

  it('skips wrapping for non-JSON content-type', async () => {
    const ctx = makeContext({ contentType: 'text/plain' });
    const data = 'some plain text';
    const handler = { handle: () => of(data) };
    const result = await new Promise((resolve) => {
      interceptor.intercept(ctx, handler as never).subscribe(resolve);
    });
    expect(result).toBe(data);
  });

  it('echoes requestId in the envelope', async () => {
    const ctx = makeContext({ requestId: 'my-request-123' });
    const handler = { handle: () => of({ ok: true }) };
    const result = await new Promise<Record<string, unknown>>((resolve) => {
      interceptor.intercept(ctx, handler as never).subscribe(resolve as never);
    });
    expect(result.requestId).toBe('my-request-123');
  });

  it('wraps null data correctly', async () => {
    const ctx = makeContext();
    const handler = { handle: () => of(null) };
    const result = await new Promise<Record<string, unknown>>((resolve) => {
      interceptor.intercept(ctx, handler as never).subscribe(resolve as never);
    });
    expect(result.data).toBeNull();
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ApiExceptionFilter
// ---------------------------------------------------------------------------

describe('ApiExceptionFilter', () => {
  let filter: ApiExceptionFilter;

  beforeEach(() => {
    filter = new ApiExceptionFilter();
  });

  function runFilter(exception: unknown, requestId?: string) {
    const host = makeHost({ requestId });
    filter.catch(exception, host);
    const response = (host as unknown as { _response: () => { _body: () => unknown } })._response();
    return response._body() as {
      success: boolean;
      data: null;
      error: { code: string; message: string; details?: unknown; fieldErrors?: unknown };
      requestId: string;
      timestamp: string;
    };
  }

  function statusOf(exception: unknown): number {
    const host = makeHost();
    filter.catch(exception, host);
    return (host as unknown as { _response: () => { getStatusCode: () => number } })._response().getStatusCode();
  }

  it('reports an ag-go failure as a bad gateway with the reason ag-go gave', () => {
    const upstream = new AgGoClientError(503, {
      data: null, requestId: 'r', timestamp: 't', success: false,
      error: { code: 'HTTP_503', message: 'Account API request failed' },
    });
    const body = runFilter(upstream);
    expect(statusOf(upstream)).toBe(502);
    expect(body.error.code).toBe('AG_GO_ERROR');
    expect(body.error.message).toBe('ag-go: Account API request failed');
    expect(body.error.details).toMatchObject({ upstreamStatus: 503, upstreamCode: 'HTTP_503' });
  });

  it('passes ag-go refusing the user (403) through', () => {
    expect(statusOf(new AgGoClientError(403, { message: 'no folder access' }))).toBe(403);
  });

  it('logs every 5xx with its request id', () => {
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    runFilter(new Error('something broke'), 'req-500');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('req-500'));
    expect(spy.mock.calls[0]![0]).toContain('something broke');
    spy.mockClear();
    runFilter(new HttpException('nope', HttpStatus.NOT_FOUND));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('wraps an unknown error as INTERNAL_SERVER_ERROR', () => {
    const body = runFilter(new Error('something broke'));
    expect(body.success).toBe(false);
    expect(body.data).toBeNull();
    expect(body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(body.error.message).toBe('Internal server error');
  });

  it('wraps an HttpException with code and message', () => {
    const body = runFilter(
      new HttpException({ code: 'not_found', message: 'Production not found' }, HttpStatus.NOT_FOUND),
    );
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toBe('Production not found');
  });

  it('puts extra thrown fields into details (revision_conflict)', () => {
    const body = runFilter(
      new HttpException(
        { code: 'revision_conflict', message: 'stale', currentRevision: 5, baseRevision: 3 },
        HttpStatus.CONFLICT,
      ),
    );
    expect(body.error.code).toBe('revision_conflict');
    expect(body.error.message).toBe('stale');
    const details = body.error.details as Record<string, unknown>;
    expect(details.currentRevision).toBe(5);
    expect(details.baseRevision).toBe(3);
  });

  it('puts extra thrown fields into details (gate rejection problems)', () => {
    const body = runFilter(
      new HttpException(
        { code: 'rejected', message: 'Treatment invalid', missing: ['x'], failed: [{ check_id: 'c1' }] },
        HttpStatus.UNPROCESSABLE_ENTITY,
      ),
    );
    expect(body.error.code).toBe('rejected');
    const details = body.error.details as Record<string, unknown>;
    expect(details.missing).toEqual(['x']);
    expect(details.failed).toEqual([{ check_id: 'c1' }]);
  });

  it('handles NestJS validation errors (array message)', () => {
    const body = runFilter(
      new HttpException({ message: ['name must be a string', 'email is required'], error: 'Bad Request', statusCode: 400 }, 400),
    );
    expect(body.error.message).toBe('Request validation failed');
    const details = body.error.details as Record<string, unknown>;
    expect((details.messages as string[]).length).toBe(2);
  });

  it('defaults code to HTTP_<status> when none provided', () => {
    const body = runFilter(new HttpException({ message: 'gone' }, HttpStatus.GONE));
    expect(body.error.code).toBe('HTTP_410');
  });

  it('echoes requestId from the request', () => {
    const body = runFilter(
      new HttpException({ code: 'err', message: 'oops' }, 400),
      'echo-me-123',
    );
    expect(body.requestId).toBe('echo-me-123');
  });
});
