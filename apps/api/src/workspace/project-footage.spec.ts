/**
 * Which videos ag-go's trusted mode serves a project (those of its ag-go projects): a long list is asked in lots (ag-go
 * signs video by video and one request for all of them outlasts the timeout); and whether a person may add an ag-go
 * project.
 */
import { describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { AgGoClientError } from '../ag-go/client';
import { addability, ProjectFootageService } from './project-footage.service';

const config = { get: (k: string) => (k === 'AG_GO_API_URL' ? 'http://ag-go.test/api' : 'key') } as unknown as ConfigService;
const ids = Array.from({ length: 78 }, (_, i) => `a${i}`);

function service(answer: (lot: string[]) => Promise<{ items: { assetId: string }[]; missing?: string[] }>) {
  const s = new ProjectFootageService(config);
  const lots: string[][] = [];
  const bodies: unknown[] = [];
  let open = 0;
  let most = 0;
  Object.assign((s as unknown as { agGo: object }).agGo, {
    studioResolveAssets: async (body: { projectIds: string[]; assetIds: string[] }) => {
      lots.push(body.assetIds);
      bodies.push(body);
      most = Math.max(most, ++open);
      try { await new Promise((r) => setTimeout(r, 5)); return await answer(body.assetIds); } finally { open--; }
    },
  });
  return { s, lots, bodies, most: () => most };
}

describe('ProjectFootageService.check', () => {
  it("asks a long list in lots of ten, four at a time, within the project's ag-go projects, and merges what ag-go does not serve", async () => {
    const { s, lots, bodies, most } = service(async (lot) => ({ items: lot.filter((id) => id !== 'a5').map((assetId) => ({ assetId })), missing: lot.includes('a70') ? ['a70'] : [] }));
    const r = await s.check(['p1', 'p2'], ids);
    expect(lots.map((l) => l.length)).toEqual([10, 10, 10, 10, 10, 10, 10, 8]);
    expect(lots.flat().sort()).toEqual([...ids].sort());
    expect(bodies[0]).toEqual({ projectIds: ['p1', 'p2'], assetIds: ids.slice(0, 10), purpose: 'preview' });
    expect(most()).toBe(4);
    expect(r.missing).toEqual(['a5', 'a70']);
    expect(r.ok).toHaveLength(76);
  });

  it('asks a lot again once when ag-go answers 503, and fails when it still does not answer', async () => {
    let failures = 0;
    const flaky = service(async (lot) => {
      if (lot.includes('a30') && failures++ === 0) throw new AgGoClientError(503, { message: 'unavailable' });
      return { items: lot.map((assetId) => ({ assetId })) };
    });
    expect((await flaky.s.check(['p1'], ids)).missing).toEqual([]);
    expect(flaky.lots).toHaveLength(9);
    const down = service(async (lot) => { if (lot.includes('a30')) throw new AgGoClientError(503, 'down'); return { items: lot.map((assetId) => ({ assetId })) }; });
    await expect(down.s.check(['p1'], ids)).rejects.toMatchObject({ status: 503 });
    expect(down.lots.filter((l) => l.includes('a30'))).toHaveLength(2);
  });

  it('without an ag-go project none is served, and ag-go is not asked', async () => {
    const { s, lots } = service(async () => ({ items: [] }));
    expect(await s.check([], ['a1', 'a2'])).toEqual({ ok: [], missing: ['a1', 'a2'] });
    expect(lots).toEqual([]);
  });
});

describe('addability', () => {
  const a = (over: object) => ({ projectId: 'p', canView: true, canDownloadOriginals: true, analyzedVideos: 2, usableVideos: 1, ...over });
  it('adds a project the person may download the originals of, with a usable video', () => {
    expect(addability(a({}))).toBe('addable');
    expect(addability(a({ canDownloadOriginals: false }))).toBe('view_only');
    expect(addability(a({ usableVideos: 0 }))).toBe('no_videos');
    expect(addability(a({ canView: false, canDownloadOriginals: false }))).toBe('not_visible');
    expect(addability(undefined)).toBe('not_visible');
  });
});
