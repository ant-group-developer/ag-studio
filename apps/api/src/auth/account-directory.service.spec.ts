import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AccountDirectoryService, accountIdOf, userIdOf } from './account-directory.service';

function config(values: Record<string, string>): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

function reply(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

describe('accountIdOf / userIdOf', () => {
  it('maps Auth0 database subjects to Account ids and back; other providers have none', () => {
    expect(accountIdOf('auth0|0668552e-206a-4401-bf69-2e15a1108cbb')).toBe('0668552e-206a-4401-bf69-2e15a1108cbb');
    expect(accountIdOf('google-oauth2|123')).toBeNull();
    expect(userIdOf('abc')).toBe('auth0|abc');
  });
});

describe('AccountDirectoryService', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const svc = () => new AccountDirectoryService(config({ ACCOUNT_API_URL: 'http://account.local/', ACCOUNT_API_KEY: 'k' }));

  it('looks members up by Account id with the API key, unwraps the envelope and caches', async () => {
    fetchMock.mockImplementation(() =>
      reply({ success: true, data: { data: [{ id: 'u-1', name: 'Nguyễn An', email: 'an@ant-group.net', avatar: 'https://x/a.png' }], meta: {} } }),
    );
    const s = svc();
    const people = await s.summaries(['auth0|u-1', 'auth0|u-2', 'google-oauth2|9']);
    expect(people.get('auth0|u-1')).toEqual({ userId: 'auth0|u-1', name: 'Nguyễn An', email: 'an@ant-group.net', avatar: 'https://x/a.png' });
    expect(people.has('auth0|u-2')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toContain('/v2/public/users?');
    expect(url.searchParams.get('user_ids')).toBe('u-1,u-2');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('k');
    // both ids are cached, the unknown one as "no match"
    await s.summaries(['auth0|u-1', 'auth0|u-2']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads the { statusCode, message, data } envelope of the local Account API', async () => {
    fetchMock.mockImplementation(() =>
      reply({ statusCode: 200, message: 'ok', data: { data: [{ id: 'u-9', name: 'Demo', email: 'demo@ant-group.net', avatar: 'https://x/d.png' }], meta: {} }, timestamp: 'now' }),
    );
    expect((await svc().summaries(['auth0|u-9'])).get('auth0|u-9')?.email).toBe('demo@ant-group.net');
  });

  it('an Account API failure leaves the summaries empty and is not cached', async () => {
    fetchMock.mockImplementationOnce(() => reply({ message: 'down' }, 503));
    const s = svc();
    expect((await s.summaries(['auth0|u-1'])).size).toBe(0);
    fetchMock.mockImplementationOnce(() => reply({ data: [{ id: 'u-1', name: 'An' }] }));
    expect((await s.summaries(['auth0|u-1'])).get('auth0|u-1')?.name).toBe('An');
  });

  it('searches with the caller token, never the API key', async () => {
    fetchMock.mockImplementation(() => reply({ data: [{ id: 'u-3', name: ' Bình ', email: 'binh@ant-group.net', avatar: '' }], meta: {} }));
    const found = await svc().search('user-token', ' binh ');
    expect(found).toEqual([{ userId: 'auth0|u-3', name: 'Bình', email: 'binh@ant-group.net', avatar: null }]);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/v2/users');
    expect(url.searchParams.get('keyword')).toBe('binh');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer user-token');
    expect(headers['x-api-key']).toBeUndefined();
  });
});
