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
});

describe('mayDownloadOriginals', () => {
  it('admins and holders of the ag-go original rights only', () => {
    expect(mayDownloadOriginals({ userId: 'a', userType: 'ADMIN', permissions: [] })).toBe(true);
    expect(mayDownloadOriginals({ userId: 'b', userType: 'USER', permissions: ['go.project.download_original'] })).toBe(true);
    expect(mayDownloadOriginals({ userId: 'c', userType: 'USER', permissions: ['go.project.evaluate'] })).toBe(true);
    expect(mayDownloadOriginals({ userId: 'd', userType: 'USER', permissions: ['go.footage.search'] })).toBe(false);
  });
});
