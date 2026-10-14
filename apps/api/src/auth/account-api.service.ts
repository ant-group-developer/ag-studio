import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface UserProfile {
  userId: string;
  userType: 'ADMIN' | 'USER';
  permissions: string[];
}

/** ag-go permissions that allow seeing originals (same rule as ag-go's footage resolve). */
export const ORIGINAL_PERMISSIONS = ['go.project.download_original', 'go.project.evaluate'] as const;

/** Studio admins, and people who may download originals in ag-go, may pack originals (Premiere "bản gốc"). */
export function mayDownloadOriginals(p: UserProfile): boolean {
  return p.userType === 'ADMIN' || ORIGINAL_PERMISSIONS.some((x) => p.permissions.includes(x));
}

interface CacheEntry {
  profile: UserProfile;
  cachedAt: number;
}

/** Account API's `/v2/users/me` answer: `{ user_type, permissions, … }`, inside `{ statusCode, message, data }`. */
type CurrentUser = { id?: string; user_type?: string; userType?: string; permissions?: unknown };

/** How long Account API may take to answer before Studio stops waiting. */
export const ACCOUNT_API_TIMEOUT_MS = 5000;

/**
 * The caller's profile from Account API, IN AG-GO's APPLICATION (`application=ant-go-v2` by default): Studio users are
 * ag-go users, Studio admins are the application's ADMINs, and the ag-go permissions decide who may see originals.
 * Without the parameter Account API picks the application from the token's client id.
 *
 * Kept 5 minutes per person; the requests of one person that come together (a page asks many things at once) share one
 * lookup; Account API is given 5 s. When it fails (an error status, no answer in time, the network), the profile known
 * from the last hour serves meanwhile, not cached again so the next request asks anew; with none, a plain user.
 */
@Injectable()
export class AccountApiService {
  private readonly logger = new Logger(AccountApiService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<UserProfile>>();
  private readonly cacheTtlMs = 5 * 60 * 1000;
  private readonly staleTtlMs = 60 * 60 * 1000;

  constructor(private readonly config: ConfigService) {}

  async getUserProfile(accessToken: string, userId: string): Promise<UserProfile> {
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
      return cached.profile;
    }
    const running = this.inflight.get(userId);
    if (running) return running;
    const lookup = this.lookUp(accessToken, userId).finally(() => this.inflight.delete(userId));
    this.inflight.set(userId, lookup);
    return lookup;
  }

  /** Asks Account API; a failure answers with the profile known from the last hour, or a plain user. Never throws. */
  private async lookUp(accessToken: string, userId: string): Promise<UserProfile> {
    let why: string;
    try {
      const profile = await this.fetchProfile(accessToken, userId);
      if (typeof profile !== 'string') {
        this.cache.set(userId, { profile, cachedAt: Date.now() });
        return profile;
      }
      why = profile;
    } catch (e) {
      why = (e as Error).name === 'TimeoutError' ? `no answer in ${ACCOUNT_API_TIMEOUT_MS / 1000} s` : (e as Error).message;
    }
    const stale = this.cache.get(userId);
    if (stale && Date.now() - stale.cachedAt < this.staleTtlMs) {
      this.logger.warn(`Account API failed for user ${userId} (${why}): using the profile from ${Math.round((Date.now() - stale.cachedAt) / 60_000)} min ago`);
      return stale.profile;
    }
    // Not cached: the next request asks again instead of keeping someone a plain user for five minutes.
    this.logger.warn(`Account API failed for user ${userId} (${why})`);
    return { userId, userType: 'USER', permissions: [] };
  }

  /** The profile, or why Account API gave none (an error status). Throws on a timeout or a network error. */
  private async fetchProfile(accessToken: string, userId: string): Promise<UserProfile | string> {

    const baseUrl = this.config.get<string>('ACCOUNT_API_URL') as string;
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/v2/users/me`);
    url.searchParams.set('application', this.config.get<string>('ACCOUNT_APPLICATION_CODE')?.trim() || 'ant-go-v2');

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    };
    const apiKey = this.config.get<string>('ACCOUNT_API_KEY');
    if (apiKey) {
      headers['X-API-Key'] = apiKey;
    }

    const response = await fetch(url, { headers, signal: AbortSignal.timeout(ACCOUNT_API_TIMEOUT_MS) });
    if (!response.ok) return `status ${response.status}`;

    const body = (await response.json()) as CurrentUser | { data?: CurrentUser; success?: boolean };
    const user: CurrentUser = 'data' in body && body.data && typeof body.data === 'object' ? body.data : (body as CurrentUser);
    const type = (user.user_type ?? user.userType ?? '').toUpperCase();
    return {
      userId,
      userType: type === 'ADMIN' ? 'ADMIN' : 'USER',
      permissions: Array.isArray(user.permissions) ? user.permissions.filter((p): p is string => typeof p === 'string') : [],
    };
  }
}
