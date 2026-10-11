import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgGoClient } from './client';

const envelope = (data: unknown) => new Response(JSON.stringify({ success: true, requestId: 'r', data, timestamp: 't' }), {
  status: 200, headers: { 'content-type': 'application/json' },
});

describe('AgGoClient footage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends every footage filter ag-go knows, lists comma-joined, as the user', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return envelope({ items: [], nextCursor: null, total: 0 });
    });
    const c = new AgGoClient({ baseUrl: 'https://go.test/api/', serviceKey: 'k' });
    await c.searchFootage('auth0|u', {
      projectIds: ['p1', 'p2'], q: 'thuyền', categoryIds: ['c1'], ownerUserIds: ['o1'], provinceIds: ['pr1'], resolutions: ['4k', '1080p'],
      tags: ['sông'], genres: ['travel'], timesOfDay: ['day'], orientations: ['landscape'], minDurationMs: 1000, maxDurationMs: 60000,
      usability: 'all', page: 2, limit: 40, sortBy: 'duration', sortOrder: 'asc',
    });
    const u = new URL(seen[0]!.url);
    expect(u.pathname).toBe('/api/footage/search');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      projectIds: 'p1,p2', q: 'thuyền', categoryIds: 'c1', ownerUserIds: 'o1', provinceIds: 'pr1', resolutions: '4k,1080p', tags: 'sông',
      genres: 'travel', timesOfDay: 'day', orientations: 'landscape', minDurationMs: '1000', maxDurationMs: '60000', usability: 'all',
      page: '2', limit: '40', sortBy: 'duration', sortOrder: 'asc',
    });
    expect(seen[0]!.headers).toMatchObject({ 'X-Service-Key': 'k', 'X-Act-As-User': 'auth0|u' });
  });

  it('asks the facets of the same filters, without paging', async () => {
    const urls: string[] = [];
    const facets = { tags: [{ value: 'sông', count: 3 }], genres: [], timesOfDay: [], orientations: [], resolutions: [], categories: [], provinces: [], projects: [], authors: [] };
    vi.stubGlobal('fetch', async (url: string) => { urls.push(url); return envelope(facets); });
    const c = new AgGoClient({ baseUrl: 'https://go.test/api', serviceKey: 'k' });
    expect(await c.getFootageFacets('auth0|u', { projectIds: ['p1'], usability: 'usable' })).toEqual(facets);
    expect(urls).toEqual(['https://go.test/api/footage/facets?projectIds=p1&usability=usable']);
  });
});
