import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { AccountApiService, mayDownloadOriginals } from './account-api.service';

const config = (over: Record<string, string> = {}) =>
  ({ get: (k: string) => ({ ACCOUNT_API_URL: 'https://account.test/', ...over })[k] }) as unknown as ConfigService;

function answer(status: number, body: unknown) {
  const calls: URL[] = [];
  vi.stubGlobal('fetch', async (url: URL) => {
    calls.push(new URL(String(url)));
    return new Response(JSON.stringify(body), { status });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('AccountApiService.getUserProfile', () => {
  it("reads user_type and permissions inside Account API's envelope, asking for ag-go's application", async () => {
    const calls = answer(200, { statusCode: 200, message: 'ok', data: { id: 'a1', user_type: 'ADMIN', permissions: ['go.project.evaluate'] } });
    const p = await new AccountApiService(config()).getUserProfile('token', 'auth0|u1');
    expect(p).toEqual({ userId: 'auth0|u1', userType: 'ADMIN', permissions: ['go.project.evaluate'] });
    expect(calls[0]?.pathname).toBe('/v2/users/me');
    expect(calls[0]?.searchParams.get('application')).toBe('ant-go-v2');
  });

  it('honours ACCOUNT_APPLICATION_CODE and an unwrapped answer', async () => {
    const calls = answer(200, { user_type: 'USER', permissions: [] });
    const p = await new AccountApiService(config({ ACCOUNT_APPLICATION_CODE: 'other-app' })).getUserProfile('token', 'u2');
    expect(p.userType).toBe('USER');
    expect(calls[0]?.searchParams.get('application')).toBe('other-app');
  });

  it('caches a profile, but not a failed lookup', async () => {
    const svc = new AccountApiService(config());
    let calls = answer(500, {});
    expect((await svc.getUserProfile('t', 'u3')).userType).toBe('USER');
    calls = answer(200, { data: { user_type: 'ADMIN', permissions: [] } });
    expect((await svc.getUserProfile('t', 'u3')).userType).toBe('ADMIN');
    await svc.getUserProfile('t', 'u3');
    expect(calls).toHaveLength(1);
  });

  it('asks once for the requests of one person that come together', async () => {
    let calls = 0;
    let answer!: () => void;
    vi.stubGlobal('fetch', () => {
      calls++;
      return new Promise<Response>((resolve) => { answer = () => resolve(new Response(JSON.stringify({ data: { user_type: 'ADMIN', permissions: [] } }), { status: 200 })); });
    });
    const svc = new AccountApiService(config());
    const asked = [svc.getUserProfile('t', 'u4'), svc.getUserProfile('t', 'u4'), svc.getUserProfile('t', 'u4')];
    await Promise.resolve();
    answer();
    expect((await Promise.all(asked)).map((p) => p.userType)).toEqual(['ADMIN', 'ADMIN', 'ADMIN']);
    expect(calls).toBe(1);
    // another person is asked apart
    const other = svc.getUserProfile('t', 'u5');
    await Promise.resolve();
    answer();
    await other;
    expect(calls).toBe(2);
  });

  it('gives Account API 5 s, then serves the profile known from the last hour, else a plain user', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    let fail = false;
    vi.stubGlobal('fetch', async (_url: URL, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      if (fail) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return new Response(JSON.stringify({ data: { user_type: 'ADMIN', permissions: ['go.project.evaluate'] } }), { status: 200 });
    });
    const now = vi.spyOn(Date, 'now');
    const t0 = 1_800_000_000_000;
    now.mockReturnValue(t0);
    const svc = new AccountApiService(config());
    expect((await svc.getUserProfile('t', 'u6')).userType).toBe('ADMIN');
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    // the profile is 10 minutes old and Account API does not answer: the known one serves, and the next request asks again
    fail = true;
    now.mockReturnValue(t0 + 10 * 60_000);
    expect(await svc.getUserProfile('t', 'u6')).toEqual({ userId: 'u6', userType: 'ADMIN', permissions: ['go.project.evaluate'] });
    expect(await svc.getUserProfile('t', 'u6')).toMatchObject({ userType: 'ADMIN' });
    expect(signals).toHaveLength(3);
    // an error status is a failure as well
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }));
    expect((await svc.getUserProfile('t', 'u6')).userType).toBe('ADMIN');
    // older than an hour: not trusted any more
    now.mockReturnValue(t0 + 61 * 60_000);
    expect(await svc.getUserProfile('t', 'u6')).toEqual({ userId: 'u6', userType: 'USER', permissions: [] });
    now.mockRestore();
  });
});

describe('mayDownloadOriginals', () => {
  it('admins and holders of the ag-go original rights only', () => {
    expect(mayDownloadOriginals({ userId: 'a', userType: 'ADMIN', permissions: [] })).toBe(true);
    expect(mayDownloadOriginals({ userId: 'b', userType: 'USER', permissions: ['go.project.download_original'] })).toBe(true);
    expect(mayDownloadOriginals({ userId: 'c', userType: 'USER', permissions: ['go.project.evaluate'] })).toBe(true);
    expect(mayDownloadOriginals({ userId: 'd', userType: 'USER', permissions: ['go.footage.search'] })).toBe(false);
  });
});
