import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Name, email and avatar of a Studio user, keyed by the Auth0 subject Studio stores (`auth0|<account id>`). */
export interface UserSummary {
  userId: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
}

interface AccountUser {
  id: string;
  name?: unknown;
  email?: unknown;
  avatar?: unknown;
}

const AUTH0_PREFIX = 'auth0|';
const CACHE_TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 5000;

/**
 * Account API id of an Auth0 subject: database users are `auth0|<account id>` (the convention ag-go-api's
 * Auth0Guard and Account API's own JWT strategy use). Other identity providers have no Account id this way.
 */
export function accountIdOf(userId: string): string | null {
  return userId.startsWith(AUTH0_PREFIX) ? userId.slice(AUTH0_PREFIX.length) : null;
}

export function userIdOf(accountId: string): string {
  return `${AUTH0_PREFIX}${accountId}`;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Who a Studio user is, from Account API: `public/users` by id with the service API key (member lists), and
 * `users?keyword=` with the caller's own token (picking a member), so Account API's visibility rules decide
 * whom a person can find. Lookups never fail a page: an unreachable Account API leaves the summary empty.
 */
@Injectable()
export class AccountDirectoryService {
  private readonly logger = new Logger(AccountDirectoryService.name);
  private readonly cache = new Map<string, { value: UserSummary | null; expiresAt: number }>();

  constructor(private readonly config: ConfigService) {}

  async summaries(userIds: string[]): Promise<Map<string, UserSummary>> {
    const result = new Map<string, UserSummary>();
    const now = Date.now();
    const missing: string[] = [];
    for (const userId of new Set(userIds)) {
      const hit = this.cache.get(userId);
      if (hit && hit.expiresAt > now) {
        if (hit.value) result.set(userId, hit.value);
      } else if (accountIdOf(userId)) {
        missing.push(userId);
      }
    }
    for (let i = 0; i < missing.length; i += 50) {
      const chunk = missing.slice(i, i + 50);
      const url = this.url('public/users');
      if (!url) break;
      url.searchParams.set('user_ids', chunk.map((u) => accountIdOf(u)!).join(','));
      url.searchParams.set('fields', 'id,name,email,avatar');
      url.searchParams.set('page_size', String(chunk.length));
      const apiKey = this.config.get<string>('ACCOUNT_API_KEY')?.trim();
      const users = await this.fetchUsers(url, apiKey ? { 'x-api-key': apiKey } : {});
      if (!users) continue; // not cached: try again next time
      const found = new Map(users.map((u) => [userIdOf(u.id), this.toSummary(u)]));
      for (const userId of chunk) {
        const value = found.get(userId) ?? null;
        this.cache.set(userId, { value, expiresAt: now + CACHE_TTL_MS });
        if (value) result.set(userId, value);
      }
    }
    return result;
  }

  /** People matching `keyword` (name or email) that the caller may see in Account API. */
  async search(accessToken: string, keyword: string, limit = 20): Promise<UserSummary[]> {
    const url = this.url('users');
    if (!url) return [];
    url.searchParams.set('page', '1');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('is_active', 'true');
    url.searchParams.set('sort_by', 'name');
    url.searchParams.set('sort_order', 'asc');
    if (keyword.trim()) url.searchParams.set('keyword', keyword.trim());
    const users = await this.fetchUsers(url, { authorization: `Bearer ${accessToken}` });
    return (users ?? []).map((u) => this.toSummary(u));
  }

  private toSummary(u: AccountUser): UserSummary {
    return { userId: userIdOf(u.id), name: text(u.name), email: text(u.email), avatar: text(u.avatar) };
  }

  private url(path: string): URL | null {
    const base = this.config.get<string>('ACCOUNT_API_URL')?.trim();
    if (!base) return null;
    return new URL(`v2/${path}`, `${base.replace(/\/+$/, '')}/`);
  }

  private async fetchUsers(url: URL, headers: Record<string, string>): Promise<AccountUser[] | null> {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) {
        this.logger.warn(`Account API ${url.pathname} returned ${res.status}`);
        return null;
      }
      // Lists are { data: [...], meta }, wrapped by the response envelope ({ statusCode, message, data } or
      // { success, data }) depending on the deployment: descend until `data` is the list.
      let data = (await res.json()) as unknown;
      for (let i = 0; i < 3 && data && typeof data === 'object' && !Array.isArray(data); i++) data = (data as { data?: unknown }).data;
      if (!Array.isArray(data)) {
        this.logger.warn(`Account API ${url.pathname} returned no user list`);
        return null;
      }
      return data.filter((u): u is AccountUser => !!u && typeof u === 'object' && typeof (u as AccountUser).id === 'string');
    } catch (err) {
      this.logger.warn(`Account API ${url.pathname} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
