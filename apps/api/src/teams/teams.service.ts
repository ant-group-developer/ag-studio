import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { StudioDbService } from '../db/studio-db.service';
import { TeamRole } from '../auth/roles.decorator';

interface TeamRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface TeamMemberRow {
  team_id: string;
  user_id: string;
  role: TeamRole;
  joined_at: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class TeamsService {
  constructor(private readonly db: StudioDbService) {}

  createTeam(name: string, ownerId: string): { id: string; name: string; createdAt: string; members: { userId: string; role: TeamRole }[] } {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db.run('INSERT INTO teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', [id, name, now, now]);
    this.db.run('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', [id, ownerId, 'owner', now]);

    return { id, name, createdAt: now, members: [{ userId: ownerId, role: 'owner' }] };
  }

  updateTeam(teamId: string, name: string): { id: string; name: string; createdAt: string; updatedAt: string } {
    const existing = this.db.get<TeamRow>('SELECT * FROM teams WHERE id = ?', [teamId]);
    if (!existing) throw new NotFoundException(`Team ${teamId} not found`);
    const now = new Date().toISOString();
    this.db.run('UPDATE teams SET name = ?, updated_at = ? WHERE id = ?', [name, now, teamId]);
    return { id: existing.id, name, createdAt: existing.created_at, updatedAt: now };
  }

  deleteTeam(teamId: string): void {
    const existing = this.db.get<TeamRow>('SELECT id FROM teams WHERE id = ?', [teamId]);
    if (!existing) throw new NotFoundException(`Team ${teamId} not found`);

    // 409 team_has_active_runs: any production of this team has an active run
    const active = this.db.get<{ n: number }>(
      `SELECT COUNT(*) as n FROM productions p
       JOIN runs r ON r.run_id = p.run_id
       WHERE p.team_id = ? AND r.state NOT IN ('SUCCEEDED','FAILED','CANCELLED')`,
      [teamId],
    );
    if ((active?.n ?? 0) > 0) {
      throw new ConflictException({ code: 'team_has_active_runs', message: 'Team has productions with active runs' });
    }

    this.db.run('DELETE FROM teams WHERE id = ?', [teamId]);
  }

  listTeams(userId: string): { id: string; name: string; createdAt: string; role: TeamRole }[] {
    const rows = this.db.all<TeamRow & { role: TeamRole }>(
      `SELECT t.id, t.name, t.created_at, tm.role
       FROM teams t JOIN team_members tm ON tm.team_id = t.id
       WHERE tm.user_id = ? ORDER BY t.created_at DESC`,
      [userId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, role: r.role }));
  }

  /** Paged teams list for the caller. Admins get all teams. */
  listTeamsPaged(
    userId: string,
    isAdmin: boolean,
    opts: { page?: number; pageSize?: number; sortBy?: string; sortOrder?: 'asc' | 'desc'; q?: string },
  ): Paged<{ id: string; name: string; createdAt: string; role: TeamRole | null; memberCount: number; productionCount: number }> {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
    const offset = (page - 1) * pageSize;

    const colMap: Record<string, string> = { name: 't.name', createdAt: 't.created_at' };
    const orderCol = colMap[opts.sortBy ?? 'name'] ?? 't.name';
    const orderDir = opts.sortOrder === 'desc' ? 'DESC' : 'ASC';

    const params: (string | number)[] = [];
    const conditions: string[] = [];

    if (!isAdmin) {
      conditions.push('EXISTS (SELECT 1 FROM team_members tm2 WHERE tm2.team_id = t.id AND tm2.user_id = ?)');
      params.push(userId);
    }
    if (opts.q) {
      conditions.push('t.name LIKE ?');
      params.push(`%${opts.q}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT t.id, t.name, t.created_at FROM teams t ${where} ORDER BY ${orderCol} ${orderDir} LIMIT ? OFFSET ?`;
    const countSql = `SELECT COUNT(*) as n FROM teams t ${where}`;

    const rows = this.db.all<TeamRow>(sql, [...params, pageSize, offset]);
    const total = this.db.get<{ n: number }>(countSql, params)?.n ?? 0;

    const items = rows.map((r) => {
      const member = this.db.get<{ role: TeamRole }>(
        'SELECT role FROM team_members WHERE team_id = ? AND user_id = ?',
        [r.id, userId],
      );
      const memberCount = this.db.get<{ n: number }>(
        'SELECT COUNT(*) as n FROM team_members WHERE team_id = ?',
        [r.id],
      )?.n ?? 0;
      const productionCount = this.db.get<{ n: number }>(
        "SELECT COUNT(*) as n FROM productions WHERE team_id = ? AND status != 'archived'",
        [r.id],
      )?.n ?? 0;

      return {
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        role: member?.role ?? null,
        memberCount,
        productionCount,
      };
    });

    return { items, total, page, pageSize };
  }

  listMembers(teamId: string): { userId: string; role: TeamRole; joinedAt: string }[] {
    const team = this.db.get<TeamRow>('SELECT id FROM teams WHERE id = ?', [teamId]);
    if (!team) throw new NotFoundException(`Team ${teamId} not found`);
    const rows = this.db.all<TeamMemberRow>(
      'SELECT user_id, role, joined_at FROM team_members WHERE team_id = ? ORDER BY joined_at',
      [teamId],
    );
    return rows.map((r) => ({ userId: r.user_id, role: r.role, joinedAt: r.joined_at }));
  }

  /** Paged members list. */
  listMembersPaged(
    teamId: string,
    opts: { page?: number; pageSize?: number; sortBy?: string; sortOrder?: 'asc' | 'desc'; q?: string },
  ): Paged<{ userId: string; role: TeamRole; joinedAt: string }> {
    const team = this.db.get<TeamRow>('SELECT id FROM teams WHERE id = ?', [teamId]);
    if (!team) throw new NotFoundException(`Team ${teamId} not found`);

    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
    const offset = (page - 1) * pageSize;

    const colMap: Record<string, string> = { role: 'role', joinedAt: 'joined_at', name: 'user_id' };
    const orderCol = colMap[opts.sortBy ?? 'joinedAt'] ?? 'joined_at';
    const orderDir = opts.sortOrder === 'desc' ? 'DESC' : 'ASC';

    const rows = this.db.all<TeamMemberRow>(
      `SELECT user_id, role, joined_at FROM team_members WHERE team_id = ? ORDER BY ${orderCol} ${orderDir} LIMIT ? OFFSET ?`,
      [teamId, pageSize, offset],
    );
    const total = this.db.get<{ n: number }>('SELECT COUNT(*) as n FROM team_members WHERE team_id = ?', [teamId])?.n ?? 0;

    return {
      items: rows.map((r) => ({ userId: r.user_id, role: r.role, joinedAt: r.joined_at })),
      total,
      page,
      pageSize,
    };
  }

  addMember(teamId: string, userId: string, role: TeamRole): void {
    const existing = this.db.get<TeamMemberRow>(
      'SELECT team_id FROM team_members WHERE team_id = ? AND user_id = ?',
      [teamId, userId],
    );
    if (existing) throw new ConflictException(`User ${userId} is already a member`);
    const now = new Date().toISOString();
    this.db.run('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', [teamId, userId, role, now]);
  }

  removeMember(teamId: string, userId: string): void {
    // Last-owner protection
    this.checkNotLastOwner(teamId, userId);
    const result = this.db.run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', [teamId, userId]);
    if (result.changes === 0) throw new NotFoundException(`Member ${userId} not found in team ${teamId}`);
  }

  updateMemberRole(teamId: string, userId: string, role: TeamRole): void {
    // Demoting last owner → 409
    if (role !== 'owner') this.checkNotLastOwner(teamId, userId);
    const result = this.db.run(
      'UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?',
      [role, teamId, userId],
    );
    if (result.changes === 0) throw new NotFoundException(`Member ${userId} not found in team ${teamId}`);
  }

  private checkNotLastOwner(teamId: string, userId: string): void {
    const member = this.db.get<{ role: TeamRole }>(
      'SELECT role FROM team_members WHERE team_id = ? AND user_id = ?',
      [teamId, userId],
    );
    if (member?.role !== 'owner') return; // not an owner, no constraint
    const ownerCount = this.db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM team_members WHERE team_id = ? AND role = 'owner'",
      [teamId],
    )?.n ?? 0;
    if (ownerCount <= 1) {
      throw new ConflictException({ code: 'last_owner', message: 'Cannot remove or demote the last owner of a team' });
    }
  }
}
