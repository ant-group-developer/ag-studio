import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../auth/roles.guard';
import { StudioDbService } from '../db/studio-db.service';
import { AccountApiService } from '../auth/account-api.service';
import { ROLES_KEY } from '../auth/roles.decorator';

function makeContext(
  userId: string,
  teamId: string | undefined,
  productionId?: string,
): ExecutionContext {
  const request = {
    authContext: { userId, accessToken: 'token', isAdmin: false },
    params: {
      ...(teamId ? { teamId } : {}),
      ...(productionId ? { id: productionId } : {}),
    },
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;
  let db: StudioDbService;
  let accountApi: AccountApiService;

  beforeEach(() => {
    reflector = new Reflector();
    db = {
      get: vi.fn(),
      all: vi.fn(),
      run: vi.fn(),
    } as unknown as StudioDbService;
    accountApi = {
      getUserProfile: vi.fn().mockResolvedValue({ userId: 'u', userType: 'USER', permissions: [] }),
    } as unknown as AccountApiService;
    guard = new RolesGuard(reflector, db, accountApi);
  });

  it('should allow when no roles required', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([]);
    const ctx = makeContext('user-1', 'team-1');
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('should allow owner to add member', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
      if (key === ROLES_KEY) return ['owner'];
      return undefined;
    });
    (db.get as ReturnType<typeof vi.fn>).mockReturnValue({ role: 'owner' });

    const ctx = makeContext('owner-user', 'team-1');
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('should deny non-owner from adding member', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
      if (key === ROLES_KEY) return ['owner'];
      return undefined;
    });
    (db.get as ReturnType<typeof vi.fn>).mockReturnValue({ role: 'viewer' });

    const ctx = makeContext('viewer-user', 'team-1');
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('should allow viewer to pass with no role requirement', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(null);
    const ctx = makeContext('viewer-user', 'team-1');
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('should deny when user is not a team member', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
      if (key === ROLES_KEY) return ['viewer'];
      return undefined;
    });
    (db.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const ctx = makeContext('outsider-user', 'team-1');
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('should allow studio admin to bypass role check', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
      if (key === ROLES_KEY) return ['owner'];
      return undefined;
    });
    (accountApi.getUserProfile as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: 'admin', userType: 'ADMIN', permissions: [] });
    // db.get is never called because admin bypasses role check
    (db.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const request = { authContext: { userId: 'admin', accessToken: 'tok' }, params: { teamId: 'team-1' } };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    expect(await guard.canActivate(ctx)).toBe(true);
  });
});
