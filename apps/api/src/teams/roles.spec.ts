import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../auth/roles.guard';
import { StudioDbService } from '../db/studio-db.service';
import { ROLES_KEY } from '../auth/roles.decorator';

function makeContext(
  userId: string,
  teamId: string | undefined,
  productionId?: string,
): ExecutionContext {
  const request = {
    authContext: { userId, accessToken: 'token' },
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

  beforeEach(() => {
    reflector = new Reflector();
    db = {
      get: vi.fn(),
      all: vi.fn(),
      run: vi.fn(),
    } as unknown as StudioDbService;
    guard = new RolesGuard(reflector, db);
  });

  it('should allow when no roles required', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([]);
    const ctx = makeContext('user-1', 'team-1');
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should allow owner to add member', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
      if (key === ROLES_KEY) return ['owner'];
      return undefined;
    });
    (db.get as ReturnType<typeof vi.fn>).mockReturnValue({ role: 'owner' });

    const ctx = makeContext('owner-user', 'team-1');
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should deny non-owner from adding member', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
      if (key === ROLES_KEY) return ['owner'];
      return undefined;
    });
    (db.get as ReturnType<typeof vi.fn>).mockReturnValue({ role: 'viewer' });

    const ctx = makeContext('viewer-user', 'team-1');
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should allow viewer to pass with no role requirement', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(null);
    const ctx = makeContext('viewer-user', 'team-1');
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should deny when user is not a team member', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
      if (key === ROLES_KEY) return ['viewer'];
      return undefined;
    });
    (db.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const ctx = makeContext('outsider-user', 'team-1');
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
