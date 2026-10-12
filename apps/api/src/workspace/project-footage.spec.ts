/**
 * Whether ag-go serves videos to a user: a long timeline is asked in lots (ag-go signs video by video and one request
 * for all of them outlasts the timeout), and what ag-go could not answer is not taken for a lack of rights.
 */
import { describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { AgGoClientError } from '../ag-go/client';
import { ProjectFootageService } from './project-footage.service';

const config = { get: (k: string) => (k === 'AG_GO_API_URL' ? 'http://ag-go.test/api' : 'key') } as unknown as ConfigService;
const ids = Array.from({ length: 78 }, (_, i) => `a${i}`);

function service(answer: (lot: string[]) => Promise<{ items: { assetId: string }[]; missing?: string[] }>) {
  const s = new ProjectFootageService(config);
  const lots: string[][] = [];
  let open = 0;
  let most = 0;
  Object.assign((s as unknown as { agGo: object }).agGo, {
    resolveAssets: async (_actAs: string, body: { assetIds: string[] }) => {
      lots.push(body.assetIds);
      most = Math.max(most, ++open);
      try { await new Promise((r) => setTimeout(r, 5)); return await answer(body.assetIds); } finally { open--; }
    },
  });
  return { s, lots, most: () => most };
}

describe('ProjectFootageService.check', () => {
  it('asks a long timeline in lots of ten, four at a time, and merges what ag-go cannot serve', async () => {
    const { s, lots, most } = service(async (lot) => ({ items: lot.filter((id) => id !== 'a5').map((assetId) => ({ assetId })), missing: lot.includes('a70') ? ['a70'] : [] }));
    const r = await s.check('u1', ids);
    expect(lots.map((l) => l.length)).toEqual([10, 10, 10, 10, 10, 10, 10, 8]);
    expect(lots.flat().sort()).toEqual([...ids].sort());
    expect(most()).toBe(4);
    expect(r.missing).toEqual(['a5', 'a70']);
    expect(r.ok).toHaveLength(76);
  });

  it('a lot ag-go could not answer fails the check before one it answered 404', async () => {
    const out = (lot: string[]) => (lot.includes('a0') ? new AgGoClientError(404, 'not in scope') : lot.includes('a40') ? new AgGoClientError(502, 'Bad Gateway') : null);
    const { s } = service(async (lot) => { const e = out(lot); if (e) throw e; return { items: lot.map((assetId) => ({ assetId })) }; });
    await expect(s.check('u1', ids)).rejects.toMatchObject({ status: 502 });
    const only404 = service(async (lot) => { if (lot.includes('a0')) throw new AgGoClientError(404, 'not in scope'); return { items: lot.map((assetId) => ({ assetId })) }; });
    await expect(only404.s.check('u1', ids)).rejects.toMatchObject({ status: 404 });
  });
});
