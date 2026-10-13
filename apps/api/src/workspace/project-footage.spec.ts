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
  const order: { lot: string; alone: boolean }[] = [];
  let open = 0;
  let most = 0;
  Object.assign((s as unknown as { agGo: object }).agGo, {
    resolveAssets: async (_actAs: string, body: { assetIds: string[] }) => {
      lots.push(body.assetIds);
      most = Math.max(most, ++open);
      order.push({ lot: body.assetIds[0]!, alone: open === 1 });
      try { await new Promise((r) => setTimeout(r, 5)); return await answer(body.assetIds); } finally { open--; }
    },
  });
  return { s, lots, order, most: () => most };
}

describe('ProjectFootageService.check and checkLots', () => {
  it('asks a long timeline in lots of ten, the first alone then four at a time, and merges what ag-go cannot serve', async () => {
    const { s, lots, order, most } = service(async (lot) => ({ items: lot.filter((id) => id !== 'a5').map((assetId) => ({ assetId })), missing: lot.includes('a70') ? ['a70'] : [] }));
    const r = await s.check('u1', ids);
    expect(lots.map((l) => l.length)).toEqual([10, 10, 10, 10, 10, 10, 10, 8]);
    expect(lots.flat().sort()).toEqual([...ids].sort());
    expect(most()).toBe(4);
    expect(order[0]).toEqual({ lot: 'a0', alone: true });
    expect(r.missing).toEqual(['a5', 'a70']);
    expect(r.ok).toHaveLength(76);
  });

  it('asks a lot again once when ag-go answers 503 (the Account API did not answer in time)', async () => {
    let failures = 0;
    const flaky = service(async (lot) => {
      if (lot.includes('a30') && failures++ === 0) throw new AgGoClientError(503, { message: 'Account API is unavailable' });
      return { items: lot.map((assetId) => ({ assetId })) };
    });
    expect((await flaky.s.check('u1', ids)).missing).toEqual([]);
    expect(flaky.lots).toHaveLength(9);
    const down = service(async (lot) => { if (lot.includes('a30')) throw new AgGoClientError(503, 'down'); return { items: lot.map((assetId) => ({ assetId })) }; });
    await expect(down.s.check('u1', ids)).rejects.toMatchObject({ status: 503 });
    expect(down.lots.filter((l) => l.includes('a30'))).toHaveLength(2);
  });

  it('answers lot by lot: what ag-go serves in the lots it answered, and the error of each lot it did not', async () => {
    const { s } = service(async (lot) => {
      if (lot.includes('a0')) throw new AgGoClientError(404, 'not in scope: a3');
      if (lot.includes('a40')) throw new AgGoClientError(500, 'boom');
      return { items: lot.filter((id) => id !== 'a12').map((assetId) => ({ assetId })) };
    });
    const answers = await s.checkLots('u1', ids);
    expect(answers.map((a) => a.assetIds[0])).toEqual(['a0', 'a10', 'a20', 'a30', 'a40', 'a50', 'a60', 'a70']);
    expect(answers[0]).toMatchObject({ error: { status: 404 } });
    expect(answers[4]).toMatchObject({ error: { status: 500 } });
    expect(answers[1]).toEqual({ assetIds: ids.slice(10, 20), served: ids.slice(10, 20).filter((id) => id !== 'a12'), missing: ['a12'] });
  });

  it('a lot ag-go could not answer fails the check before one it answered 404', async () => {
    const out = (lot: string[]) => (lot.includes('a0') ? new AgGoClientError(404, 'not in scope') : lot.includes('a40') ? new AgGoClientError(502, 'Bad Gateway') : null);
    const { s } = service(async (lot) => { const e = out(lot); if (e) throw e; return { items: lot.map((assetId) => ({ assetId })) }; });
    await expect(s.check('u1', ids)).rejects.toMatchObject({ status: 502 });
    const only404 = service(async (lot) => { if (lot.includes('a0')) throw new AgGoClientError(404, 'not in scope'); return { items: lot.map((assetId) => ({ assetId })) }; });
    await expect(only404.s.check('u1', ids)).rejects.toMatchObject({ status: 404 });
  });
});
