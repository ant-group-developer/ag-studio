/**
 * Unit tests for Me/Teams GĐ3 API:
 * GET /me, PATCH /teams/:id, DELETE /teams/:id (409 team_has_active_runs),
 * last-owner protection (409 last_owner).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { TeamsService } from './teams.service';
import { StudioDbService } from '../db/studio-db.service';

function makeDb(overrides: Partial<StudioDbService> = {}): StudioDbService {
  return {
    get: vi.fn(),
    all: vi.fn().mockReturnValue([]),
    run: vi.fn().mockReturnValue({ changes: 1 }),
    ...overrides,
  } as unknown as StudioDbService;
}

describe('TeamsService — updateTeam', () => {
  it('returns updated team data', () => {
    const db = makeDb();
    (db.get as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      id: 'team-1',
      name: 'Old Name',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    });
    const svc = new TeamsService(db);
    const result = svc.updateTeam('team-1', 'New Name');
    expect(result.name).toBe('New Name');
    expect(result.id).toBe('team-1');
    expect(result.createdAt).toBe('2024-01-01T00:00:00.000Z');
    expect(result.updatedAt).not.toBe('2024-01-01T00:00:00.000Z'); // updated
  });

  it('throws 404 when team does not exist', () => {
    const db = makeDb();
    (db.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);
    const svc = new TeamsService(db);
    expect(() => svc.updateTeam('missing', 'Name')).toThrow(NotFoundException);
  });
});

describe('TeamsService — deleteTeam', () => {
  it('deletes team when no active runs', () => {
    const db = makeDb();
    (db.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ id: 'team-1' }) // team exists
      .mockReturnValueOnce({ n: 0 }); // no active runs
    const svc = new TeamsService(db);
    svc.deleteTeam('team-1');
    expect(db.run).toHaveBeenCalledWith('DELETE FROM teams WHERE id = ?', ['team-1']);
  });

  it('throws 409 team_has_active_runs when team has active runs', () => {
    const db = makeDb();
    (db.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ id: 'team-1' }) // team exists
      .mockReturnValueOnce({ n: 2 }); // 2 active runs
    const svc = new TeamsService(db);
    let caught: unknown;
    try {
      svc.deleteTeam('team-1');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    const response = (caught as ConflictException).getResponse() as { code: string };
    expect(response.code).toBe('team_has_active_runs');
  });

  it('throws 404 when team does not exist', () => {
    const db = makeDb();
    (db.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);
    const svc = new TeamsService(db);
    expect(() => svc.deleteTeam('missing')).toThrow(NotFoundException);
  });
});

describe('TeamsService — last-owner protection', () => {
  it('allows removing a non-owner member', () => {
    const db = makeDb();
    (db.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ role: 'editor' }); // member role
    (db.run as ReturnType<typeof vi.fn>).mockReturnValue({ changes: 1 });
    const svc = new TeamsService(db);
    expect(() => svc.removeMember('team-1', 'user-1')).not.toThrow();
  });

  it('throws 409 last_owner when removing last owner', () => {
    const db = makeDb();
    (db.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ role: 'owner' }) // member is owner
      .mockReturnValueOnce({ n: 1 }); // only 1 owner
    const svc = new TeamsService(db);
    let caught: unknown;
    try {
      svc.removeMember('team-1', 'last-owner');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    const response = (caught as ConflictException).getResponse() as { code: string };
    expect(response.code).toBe('last_owner');
  });

  it('allows removing an owner when there are multiple owners', () => {
    const db = makeDb();
    (db.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ role: 'owner' }) // member is owner
      .mockReturnValueOnce({ n: 2 }); // 2 owners exist
    (db.run as ReturnType<typeof vi.fn>).mockReturnValue({ changes: 1 });
    const svc = new TeamsService(db);
    expect(() => svc.removeMember('team-1', 'owner-1')).not.toThrow();
  });

  it('throws 409 last_owner when demoting last owner', () => {
    const db = makeDb();
    (db.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ role: 'owner' }) // member is owner
      .mockReturnValueOnce({ n: 1 }); // only 1 owner
    const svc = new TeamsService(db);
    expect(() => svc.updateMemberRole('team-1', 'last-owner', 'editor')).toThrow(ConflictException);
  });

  it('allows demoting an owner when there are multiple owners', () => {
    const db = makeDb();
    (db.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ role: 'owner' }) // member is owner
      .mockReturnValueOnce({ n: 2 }); // 2 owners
    (db.run as ReturnType<typeof vi.fn>).mockReturnValue({ changes: 1 });
    const svc = new TeamsService(db);
    expect(() => svc.updateMemberRole('team-1', 'owner-1', 'producer')).not.toThrow();
  });

  it('allows promoting a member to owner (no owner count check needed)', () => {
    const db = makeDb();
    (db.run as ReturnType<typeof vi.fn>).mockReturnValue({ changes: 1 });
    const svc = new TeamsService(db);
    expect(() => svc.updateMemberRole('team-1', 'user-1', 'owner')).not.toThrow();
    // db.get should NOT be called for last-owner check when promoting to owner
    expect(db.get).not.toHaveBeenCalled();
  });
});

describe('TeamsService — listTeamsPaged', () => {
  it('returns paged result with memberCount and productionCount', () => {
    const db = makeDb();
    (db.all as ReturnType<typeof vi.fn>).mockReturnValueOnce([
      { id: 'team-1', name: 'Alpha', created_at: '2024-01-01T00:00:00.000Z' },
    ]);
    (db.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ n: 1 })             // total count
      .mockReturnValueOnce({ role: 'owner' })    // team member role
      .mockReturnValueOnce({ n: 3 })             // member count
      .mockReturnValueOnce({ n: 5 });            // production count
    const svc = new TeamsService(db);
    const result = svc.listTeamsPaged('user-1', false, { page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
    expect(result.items[0].memberCount).toBe(3);
    expect(result.items[0].productionCount).toBe(5);
    expect(result.items[0].role).toBe('owner');
  });

  it('admins see all teams (no team_members filter)', () => {
    const db = makeDb();
    (db.all as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
    (db.get as ReturnType<typeof vi.fn>).mockReturnValueOnce({ n: 0 });
    const svc = new TeamsService(db);
    svc.listTeamsPaged('admin-user', true, {});
    const sql = (db.all as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).not.toContain('team_members tm2');
  });

  it('non-admins only see their teams', () => {
    const db = makeDb();
    (db.all as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
    (db.get as ReturnType<typeof vi.fn>).mockReturnValueOnce({ n: 0 });
    const svc = new TeamsService(db);
    svc.listTeamsPaged('user-1', false, {});
    const sql = (db.all as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain('team_members tm2');
  });
});
