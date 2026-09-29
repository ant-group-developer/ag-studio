import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface UserProfile {
  userId: string;
  userType: 'ADMIN' | 'USER';
  permissions: string[];
}

interface CacheEntry {
  profile: UserProfile;
  cachedAt: number;
}

@Injectable()
export class AccountApiService {
  private readonly logger = new Logger(AccountApiService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs = 60 * 1000; // 60s

  constructor(private readonly config: ConfigService) {}

  async getUserProfile(accessToken: string, userId: string): Promise<UserProfile> {
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
      return cached.profile;
    }

    const baseUrl = this.config.get<string>('ACCOUNT_API_URL') as string;
    const url = `${baseUrl.replace(/\/$/, '')}/v2/users/me`;

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
      this.logger.warn(`Account API returned ${response.status} for user ${userId}`);
      // Return a minimal profile on failure
      return { userId, userType: 'USER', permissions: [] };
    }

    const data = (await response.json()) as { userId?: string; userType?: string; permissions?: string[] };
    const profile: UserProfile = {
      userId: data.userId ?? userId,
      userType: (data.userType as 'ADMIN' | 'USER') ?? 'USER',
      permissions: data.permissions ?? [],
    };

    this.cache.set(userId, { profile, cachedAt: Date.now() });
    return profile;
  }
}
