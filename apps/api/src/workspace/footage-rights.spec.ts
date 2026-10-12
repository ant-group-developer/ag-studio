/**
 * Footage rights remembered per (person, ag-go video): a revision with footage already known is answered without
 * asking ag-go, only the videos not known yet are asked, ag-go not answering is kept 30 s and never taken for a lack of
 * rights, and ag-go's 404 hides what it can prove holds a video out of scope — no more.
 */
import { describe, expect, it } from 'vitest';
import { AgGoClientError } from '../ag-go/client';
import { FootageRights } from './footage-rights';
import type { FootageLotAnswer } from './project-footage.service';

type Answer = (userId: string, ids: string[]) => FootageLotAnswer[] | Promise<FootageLotAnswer[]>;
const served = (ids: string[], out: string[] = []): FootageLotAnswer => ({ assetIds: ids, served: ids.filter((id) => !out.includes(id)), missing: ids.filter((id) => out.includes(id)) });

function rights(answer: Answer) {
  let t = 1_000_000;
  const asked: string[][] = [];
  const warnings: string[] = [];
  const r = new FootageRights(
    { checkLots: async (userId: string, ids: string[]) => { asked.push([userId, ...ids]); return answer(userId, ids); } },
    { warn: (m: unknown) => void warnings.push(String(m)) },
    () => t,
  );
  return { r, asked, warnings, later: (ms: number) => { t += ms; } };
}

describe('FootageRights', () => {
  it('asks ag-go only about videos not known yet, per person, and again after ten minutes', async () => {
    const { r, asked, later } = rights((_u, ids) => [served(ids)]);
    expect(await r.verdict('u1', ['a', 'b', 'a'], 'v r1')).toBeNull();
    expect(await r.verdict('u1', ['b', 'a'], 'v r2')).toBeNull(); // a new revision with the same footage
    expect(await r.verdict('u1', ['a', 'b', 'c'], 'v r3')).toBeNull();
    expect(await r.verdict('u2', ['a'], 'v r3')).toBeNull();
    expect(asked).toEqual([['u1', 'a', 'b'], ['u1', 'c'], ['u2', 'a']]);
    later(9 * 60_000);
    expect(await r.verdict('u1', ['a'], 'v r4')).toBeNull();
    expect(asked).toHaveLength(3);
    later(2 * 60_000);
    expect(await r.verdict('u1', ['a'], 'v r4')).toBeNull();
    expect(asked[3]).toEqual(['u1', 'a']);
  });

  it('a video ag-go does not serve hides every timeline using it, and no timeline without it', async () => {
    const { r, asked } = rights((_u, ids) => [served(ids, ['b'])]);
    expect(await r.verdict('u1', ['a', 'b'], 'v r1')).toBe('footage_scope');
    expect(await r.verdict('u1', ['b', 'c'], 'v r2')).toBe('footage_scope');
    expect(await r.verdict('u1', ['a', 'c'], 'v r3')).toBeNull();
    expect(asked).toEqual([['u1', 'a', 'b'], ['u1', 'c']]);
    expect(await r.verdict('u1', [], 'v r4')).toBe('footage_scope'); // a timeline without footage has nothing to show
    expect(asked).toHaveLength(2);
  });

  it('ag-go not answering is not a lack of rights, is kept 30 s so polling does not ask again, then asked again', async () => {
    let down = true;
    const { r, asked, later, warnings } = rights((_u, ids) => (down ? [{ assetIds: ids, error: new AgGoClientError(502, 'Bad Gateway') }] : [served(ids)]));
    expect(await r.verdict('u1', ['a'], 'v r1')).toBe('footage_check_failed');
    expect(await r.verdict('u1', ['a'], 'v r1')).toBe('footage_check_failed');
    expect(asked).toHaveLength(1);
    expect(warnings[0]).toContain('HTTP 502 Bad Gateway');
    later(31_000);
    down = false;
    expect(await r.verdict('u1', ['a'], 'v r1')).toBeNull();
    expect(asked).toHaveLength(2);
    // a check that throws outright is the same
    const thrown = rights(() => { throw new Error('socket hang up'); });
    expect(await thrown.r.verdict('u1', ['a'], 'v r1')).toBe('footage_check_failed');
  });

  it('a lot ag-go could not answer does not hide what it could: a known-out video still hides the timeline', async () => {
    const { r, asked } = rights((_u, ids) => [served(ids.slice(0, 1), ['a']), { assetIds: ids.slice(1), error: new AgGoClientError(503, 'down') }]);
    expect(await r.verdict('u1', ['a', 'b'], 'v r1')).toBe('footage_scope');
    const ok = rights((_u, ids) => [served(ids.slice(0, 1)), { assetIds: ids.slice(1), error: new AgGoClientError(503, 'down') }]);
    expect(await ok.r.verdict('u1', ['a', 'b'], 'v r1')).toBe('footage_check_failed');
    expect(await ok.r.verdict('u1', ['a'], 'v r2')).toBeNull(); // a was answered
    expect(ok.asked).toHaveLength(1);
    expect(asked).toHaveLength(1);
  });

  it("ag-go's 404 naming a video: that video is out, the others of the lot are still unknown", async () => {
    const { r, asked } = rights((_u, ids) => (ids.includes('b')
      ? [{ assetIds: ids, error: new AgGoClientError(404, { success: false, error: { message: 'Video not found or not in scope: b' } }) }]
      : [served(ids)]));
    expect(await r.verdict('u1', ['a', 'b', 'c'], 'v r1')).toBe('footage_scope');
    expect(await r.verdict('u1', ['b'], 'v r2')).toBe('footage_scope');
    expect(await r.verdict('u1', ['a', 'c'], 'v r3')).toBeNull();
    expect(asked).toEqual([['u1', 'a', 'b', 'c'], ['u1', 'a', 'c']]);
  });

  it("ag-go's 404 naming no video asked hides timelines using that whole set, and asks about any part of it", async () => {
    // ag-go says one of a, b is out without saying which: a later revision with the same footage is hidden without
    // asking, a revision using only a cannot be judged from that and is asked; once a is known served, b is the one
    // out, so a timeline with b is hidden at once.
    const { r, asked } = rights((_u, ids) => (ids.length > 1
      ? [{ assetIds: ids, error: new AgGoClientError(404, { message: 'Video not found or not in scope' }) }]
      : [served(ids)]));
    expect(await r.verdict('u1', ['a', 'b'], 'v r1')).toBe('footage_scope');
    expect(await r.verdict('u1', ['b', 'a', 'x'], 'v r2')).toBe('footage_scope');
    expect(asked).toEqual([['u1', 'a', 'b']]);
    expect(await r.verdict('u1', ['a'], 'v r3')).toBeNull();
    expect(asked).toEqual([['u1', 'a', 'b'], ['u1', 'a']]);
    expect(await r.verdict('u1', ['b', 'x'], 'v r4')).toBe('footage_scope');
    expect(asked).toHaveLength(2);
    // ids that are only part of a word in the body are not taken as named
    const partial = rights((_u, ids) => [{ assetIds: ids, error: new AgGoClientError(404, 'not in scope: a10') }]);
    expect(await partial.r.verdict('u1', ['a1', 'a10'], 'v r1')).toBe('footage_scope');
    expect(await partial.r.verdict('u1', ['a1'], 'v r2')).toBe('footage_scope');
    expect(partial.asked).toEqual([['u1', 'a1', 'a10'], ['u1', 'a1']]);
  });

  it('checks asked at once share what is under way: one ask per video', async () => {
    const gates: (() => void)[] = [];
    const { r, asked } = rights((_u, ids) => new Promise((done) => gates.push(() => done([served(ids)]))));
    const both = Promise.all([r.verdict('u1', ['a', 'b'], 'v r1'), r.verdict('u1', ['b', 'c'], 'v r2'), r.verdict('u1', ['a', 'b'], 'v r1')]);
    await new Promise((x) => setTimeout(x, 0));
    expect(asked).toEqual([['u1', 'a', 'b'], ['u1', 'c']]);
    for (const g of gates) g();
    expect(await both).toEqual([null, null, null]);
    expect(asked).toHaveLength(2);
  });

  it('logs a check slower than two seconds', async () => {
    const box: { later?: (ms: number) => void } = {};
    const { r, warnings, later } = rights((_u, ids) => { box.later!(2_500); return [served(ids)]; });
    box.later = later;
    expect(await r.verdict('u1', ['a'], 'video v r1')).toBeNull();
    expect(warnings).toEqual([expect.stringContaining('video v r1, user u1 took 2500 ms (1 videos)')]);
  });
});
