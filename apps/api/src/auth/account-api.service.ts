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

/**
 * The caller's profile from Account API, IN AG-GO's APPLICATION (`application=ant-go-v2` by default): Studio users are
 * ag-go users, Studio admins are the application's ADMINs, and the ag-go permissions decide who may see originals.
 * Without the parameter Account API picks the application from the token's client id.
 */
@Injectable()
export class AccountApiService {
  private readonly logger = new Logger(AccountApiService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs = 5 * 60 * 1000;

  constructor(private readonly config: ConfigService) {}

  async getUserProfile(accessToken: string, userId: string): Promise<UserProfile> {
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
      return cached.profile;
    }

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

    const response = await fetch(url, { headers });
    if (!response.ok) {
      // Not cached: the next request asks again instead of keeping someone a plain user for five minutes.
      this.logger.warn(`Account API returned ${response.status} for user ${userId}`);
      return { userId, userType: 'USER', permissions: [] };
    }

    const body = (await response.json()) as CurrentUser | { data?: CurrentUser; success?: boolean };
    const user: CurrentUser = 'data' in body && body.data && typeof body.data === 'object' ? body.data : (body as CurrentUser);
    const type = (user.user_type ?? user.userType ?? '').toUpperCase();
    const profile: UserProfile = {
      userId,
      userType: type === 'ADMIN' ? 'ADMIN' : 'USER',
      permissions: Array.isArray(user.permissions) ? user.permissions.filter((p): p is string => typeof p === 'string') : [],
    };
    this.cache.set(userId, { profile, cachedAt: Date.now() });
    return profile;
  }
}
