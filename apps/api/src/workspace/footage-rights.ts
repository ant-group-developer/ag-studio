import type { Logger } from '@nestjs/common';
import { AgGoClientError } from '../ag-go/client';
import type { FootageLotAnswer, ProjectFootageService } from './project-footage.service';

/** Why a render's link is not given: `footage_scope` ag-go does not serve a video of it; `footage_check_failed` ag-go did not answer. */
export type FootageVerdict = 'footage_scope' | 'footage_check_failed';

/** A definite answer (ag-go serves the video to that person, or does not) is kept this long. */
const KNOWN_MS = 10 * 60_000;
/** ag-go not answering is kept this long, so the Preview tab polling does not pile checks on it. */
const FAILED_MS = 30_000;
/** A check slower than this is logged. */
const SLOW_MS = 2_000;
/** Waiting on checks other requests started gives up after this many rounds and asks itself. */
const WAIT_ROUNDS = 3;

type Asset = { at: number; state: 'served' | 'out' | 'failed' };

/**
 * Whether ag-go serves every video of a timeline to a person, remembered per (person, ag-go video): a new revision with
 * the same footage (most edits) is answered without asking ag-go, and only the videos not known yet are asked. Checks
 * under way are shared, so the panel's polling and two tabs join one instead of asking again.
 *
 * ag-go answers 404 naming the first video out of the person's scope: that video is known out. A 404 that names none of
 * the videos asked still says one of them is out, not which: that set is kept as "holds a video out of scope", so a
 * timeline using every video of it (the revision asked, or a later one with the same footage) is hidden, while a
 * timeline using only some of them is asked about those (it may well be served). ag-go not answering is never taken
 * for a lack of rights; it is kept 30 s so polling does not ask again at once.
 */
export class FootageRights {
  private readonly assets = new Map<string, Asset>();
  /** Sets of videos ag-go said hold one out of a person's scope without naming it. */
  private readonly outSets = new Map<string, { at: number; ids: string[] }[]>();
  private readonly asking = new Map<string, Promise<void>>();

  constructor(
    private readonly footage: Pick<ProjectFootageService, 'checkLots'>,
    private readonly logger: Pick<Logger, 'warn'>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Why ag-go does not serve every one of these videos to this person, or null when it does. */
  async verdict(userId: string, assetIds: string[], what: string): Promise<FootageVerdict | null> {
    const ids = [...new Set(assetIds)];
    if (ids.length === 0) return 'footage_scope';
    for (let round = 0; ; round++) {
      const unknown: string[] = [];
      const pending = new Set<Promise<void>>();
      let failed = false;
      for (const id of ids) {
        const a = this.known(userId, id);
        if (a?.state === 'out') return 'footage_scope';
        if (a?.state === 'failed') failed = true;
        else if (!a) {
          const p = this.asking.get(key(userId, id));
          if (p && round < WAIT_ROUNDS) pending.add(p);
          else unknown.push(id);
        }
      }
      if (this.holdsOutSet(userId, ids)) return 'footage_scope';
      if (failed) return 'footage_check_failed';
      if (unknown.length === 0 && pending.size === 0) return null;
      if (round > WAIT_ROUNDS) return 'footage_check_failed'; // asked and still nothing known: say so rather than loop
      await Promise.all([...pending, ...(unknown.length ? [this.ask(userId, unknown, what)] : [])]);
    }
  }

  private known(userId: string, id: string): Asset | undefined {
    const a = this.assets.get(key(userId, id));
    if (!a) return undefined;
    if (this.now() - a.at < (a.state === 'failed' ? FAILED_MS : KNOWN_MS)) return a;
    this.assets.delete(key(userId, id));
    return undefined;
  }

  /**
   * Whether these videos take in every video of a set ag-go said holds one out of scope. The video out is not one ag-go
   * is known to serve, so those are left out of the set first.
   */
  private holdsOutSet(userId: string, ids: string[]): boolean {
    const sets = this.outSets.get(userId);
    if (!sets) return false;
    const have = new Set(ids);
    const fresh = sets.filter((s) => this.now() - s.at < KNOWN_MS);
    if (fresh.length !== sets.length) {
      if (fresh.length) this.outSets.set(userId, fresh);
      else this.outSets.delete(userId);
    }
    return fresh.some((s) => {
      const maybeOut = s.ids.filter((id) => this.known(userId, id)?.state !== 'served');
      return maybeOut.length > 0 && maybeOut.every((id) => have.has(id));
    });
  }

  private ask(userId: string, ids: string[], what: string): Promise<void> {
    const asked = this.askAgGo(userId, ids, what).finally(() => {
      for (const id of ids) if (this.asking.get(key(userId, id)) === asked) this.asking.delete(key(userId, id));
    });
    for (const id of ids) this.asking.set(key(userId, id), asked);
    return asked;
  }

  private async askAgGo(userId: string, ids: string[], what: string): Promise<void> {
    const started = this.now();
    let answers: FootageLotAnswer[];
    try {
      answers = await this.footage.checkLots(userId, ids);
    } catch (error) {
      answers = [{ assetIds: ids, error }];
    }
    const at = this.now();
    if (at - started > SLOW_MS) this.logger.warn(`ag-go footage check for ${what}, user ${userId} took ${at - started} ms (${ids.length} videos)`);
    this.sweep(at);
    for (const a of answers) {
      if ('served' in a) {
        for (const id of a.served) this.assets.set(key(userId, id), { at, state: 'served' });
        for (const id of a.missing) this.assets.set(key(userId, id), { at, state: 'out' });
        if (a.missing.length) this.logger.warn(`ag-go does not serve ${a.missing.length} videos of ${what} to user ${userId}: ${a.missing.join(', ')}`);
        continue;
      }
      this.logger.warn(`ag-go footage check for ${what}, user ${userId} (${a.assetIds.length} videos): ${agGoFailure(a.error)}`);
      if (a.error instanceof AgGoClientError && a.error.status === 404) {
        const named = namedIn(a.error.body, a.assetIds);
        if (named.length) for (const id of named) this.assets.set(key(userId, id), { at, state: 'out' });
        else this.outSets.set(userId, [...(this.outSets.get(userId) ?? []), { at, ids: a.assetIds }]);
      } else {
        for (const id of a.assetIds) this.assets.set(key(userId, id), { at, state: 'failed' });
      }
    }
  }

  /** Drops what is too old to be used, now and then, so the maps do not grow with every video ever asked. */
  private sweep(at: number): void {
    if (this.assets.size < 5_000) return;
    for (const [k, a] of this.assets) if (at - a.at >= (a.state === 'failed' ? FAILED_MS : KNOWN_MS)) this.assets.delete(k);
  }
}

const key = (userId: string, assetId: string) => `${userId}\n${assetId}`;

/** The videos asked that ag-go's 404 names (`Video not found or not in scope: <id>`), as whole words of its body. */
function namedIn(body: unknown, asked: string[]): string[] {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  const words = new Set(text.match(/[A-Za-z0-9_-]+/g) ?? []);
  return asked.filter((id) => words.has(id));
}

export function agGoFailure(e: unknown): string {
  if (e instanceof AgGoClientError) {
    const b = e.body as { message?: unknown; error?: { message?: unknown } } | string | null;
    const msg = typeof b === 'string' ? b : b?.error?.message ?? b?.message;
    return `HTTP ${e.status}${msg ? ` ${String(msg).slice(0, 300)}` : ''}`;
  }
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
