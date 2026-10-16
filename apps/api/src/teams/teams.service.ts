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

  async createTeam(name: string, ownerId: string): Promise<{ id: string; name: string; createdAt: string; members: { userId: string; role: TeamRole }[] }> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.db.tx(async () => {
      await this.db.run('INSERT INTO teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', [id, name, now, now]);
      await this.db.run('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', [id, ownerId, 'owner', now]);
    });

    return { id, name, createdAt: now, members: [{ userId: ownerId, role: 'owner' }] };
  }

  /** One team with the caller's role (null for an admin who is not a member) and its counts. */
  async getTeam(teamId: string, userId: string): Promise<{ id: string; name: string; createdAt: string; updatedAt: string; role: TeamRole | null; isMember: boolean; memberCount: number; projectCount: number }> {
    const team = await this.db.get<TeamRow>('SELECT * FROM teams WHERE id = ?', [teamId]);
    if (!team) throw new NotFoundException(`Team ${teamId} not found`);
    const role = (await this.db.get<{ role: TeamRole }>('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', [teamId, userId]))?.role ?? null;
    const memberCount = (await this.db.get<{ n: number }>('SELECT COUNT(*) as n FROM team_members WHERE team_id = ?', [teamId]))?.n ?? 0;
    const projectCount = (await this.db.get<{ n: number }>('SELECT COUNT(*) as n FROM projects WHERE team_id = ? AND archived_at IS NULL', [teamId]))?.n ?? 0;
    return { id: team.id, name: team.name, createdAt: team.created_at, updatedAt: team.updated_at, role, isMember: role !== null, memberCount, projectCount };
  }

  async updateTeam(teamId: string, name: string): Promise<{ id: string; name: string; createdAt: string; updatedAt: string }> {
    const now = new Date().toISOString();
    const updated = await this.db.get<TeamRow>('UPDATE teams SET name = ?, updated_at = ? WHERE id = ? RETURNING *', [name, now, teamId]);
    if (!updated) throw new NotFoundException(`Team ${teamId} not found`);
    return { id: updated.id, name, createdAt: updated.created_at, updatedAt: now };
  }

  async deleteTeam(teamId: string): Promise<void> {
    await this.db.tx(async () => {
      const existing = await this.db.get<TeamRow>('SELECT id FROM teams WHERE id = ?', [teamId]);
      if (!existing) throw new NotFoundException(`Team ${teamId} not found`);

      // 409 team_has_active_runs: a job or an agent turn of one of its projects is still going
      const busy = (await this.db.get<{ n: number }>(
        `SELECT (SELECT COUNT(*) FROM project_jobs j JOIN projects p ON p.id = j.project_id WHERE p.team_id = ? AND j.status IN ('queued', 'running'))
              + (SELECT COUNT(*) FROM agent_messages m JOIN agent_threads t ON t.id = m.thread_id JOIN projects p ON p.id = t.project_id
                  WHERE p.team_id = ? AND m.status IN ('pending', 'running')) AS n`,
        [teamId, teamId],
      ))?.n ?? 0;
      if (busy > 0) {
        throw new ConflictException({ code: 'team_has_active_runs', message: 'Team has projects with work running' });
      }

      await this.db.run('DELETE FROM teams WHERE id = ?', [teamId]);
    });
  }

  async listTeams(userId: string): Promise<{ id: string; name: string; createdAt: string; role: TeamRole }[]> {
    const rows = await this.db.all<TeamRow & { role: TeamRole }>(
      `SELECT t.id, t.name, t.created_at, tm.role
       FROM teams t JOIN team_members tm ON tm.team_id = t.id
       WHERE tm.user_id = ? ORDER BY t.created_at DESC`,
      [userId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, role: r.role }));
  }

  /** Paged teams list for the caller. Admins get all teams; `isMember` says which ones the caller is in. */
  async listTeamsPaged(
    userId: string,
    isAdmin: boolean,
    opts: { page?: number; pageSize?: number; sortBy?: string; sortOrder?: 'asc' | 'desc'; q?: string },
  ): Promise<Paged<{ id: string; name: string; createdAt: string; role: TeamRole | null; isMember: boolean; memberCount: number; projectCount: number }>> {
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
      conditions.push('t.name ILIKE ?');
      params.push(`%${opts.q}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT t.id, t.name, t.created_at FROM teams t ${where} ORDER BY ${orderCol} ${orderDir} LIMIT ? OFFSET ?`;
    const countSql = `SELECT COUNT(*) as n FROM teams t ${where}`;

    const rows = await this.db.all<TeamRow>(sql, [...params, pageSize, offset]);
    const total = (await this.db.get<{ n: number }>(countSql, params))?.n ?? 0;

    const items = await Promise.all(rows.map(async (r) => {
      const member = await this.db.get<{ role: TeamRole }>(
        'SELECT role FROM team_members WHERE team_id = ? AND user_id = ?',
        [r.id, userId],
      );
      const memberCount = (await this.db.get<{ n: number }>(
        'SELECT COUNT(*) as n FROM team_members WHERE team_id = ?',
        [r.id],
      ))?.n ?? 0;
      const projectCount = (await this.db.get<{ n: number }>(
        'SELECT COUNT(*) as n FROM projects WHERE team_id = ? AND archived_at IS NULL',
        [r.id],
      ))?.n ?? 0;

      return {
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        role: member?.role ?? null,
        isMember: member !== undefined,
        memberCount,
        projectCount,
      };
    }));

    return { items, total, page, pageSize };
  }

  async listMembers(teamId: string): Promise<{ userId: string; role: TeamRole; joinedAt: string }[]> {
    const team = await this.db.get<TeamRow>('SELECT id FROM teams WHERE id = ?', [teamId]);
    if (!team) throw new NotFoundException(`Team ${teamId} not found`);
    const rows = await this.db.all<TeamMemberRow>(
      'SELECT user_id, role, joined_at FROM team_members WHERE team_id = ? ORDER BY joined_at',
      [teamId],
    );
    return rows.map((r) => ({ userId: r.user_id, role: r.role, joinedAt: r.joined_at }));
  }

  /** Paged members list. */
  async listMembersPaged(
    teamId: string,
    opts: { page?: number; pageSize?: number; sortBy?: string; sortOrder?: 'asc' | 'desc'; q?: string },
  ): Promise<Paged<{ userId: string; role: TeamRole; joinedAt: string }>> {
    const team = await this.db.get<TeamRow>('SELECT id FROM teams WHERE id = ?', [teamId]);
    if (!team) throw new NotFoundException(`Team ${teamId} not found`);

    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
    const offset = (page - 1) * pageSize;

    const colMap: Record<string, string> = { role: 'role', joinedAt: 'joined_at', name: 'user_id' };
    const orderCol = colMap[opts.sortBy ?? 'joinedAt'] ?? 'joined_at';
    const orderDir = opts.sortOrder === 'desc' ? 'DESC' : 'ASC';

    const rows = await this.db.all<TeamMemberRow>(
      `SELECT user_id, role, joined_at FROM team_members WHERE team_id = ? ORDER BY ${orderCol} ${orderDir} LIMIT ? OFFSET ?`,
      [teamId, pageSize, offset],
    );
    const total = (await this.db.get<{ n: number }>('SELECT COUNT(*) as n FROM team_members WHERE team_id = ?', [teamId]))?.n ?? 0;

    return {
      items: rows.map((r) => ({ userId: r.user_id, role: r.role, joinedAt: r.joined_at })),
      total,
      page,
      pageSize,
    };
  }

  async addMember(teamId: string, userId: string, role: TeamRole): Promise<void> {
    const now = new Date().toISOString();
    const added = await this.db.run(
      'INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?) ON CONFLICT (team_id, user_id) DO NOTHING',
      [teamId, userId, role, now],
    );
    if (added.changes === 0) throw new ConflictException(`User ${userId} is already a member`);
  }

  async removeMember(teamId: string, userId: string): Promise<void> {
    await this.db.tx(async () => {
      // Last-owner protection
      await this.checkNotLastOwner(teamId, userId);
      const result = await this.db.run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', [teamId, userId]);
      if (result.changes === 0) throw new NotFoundException(`Member ${userId} not found in team ${teamId}`);
    });
  }

  async updateMemberRole(teamId: string, userId: string, role: TeamRole): Promise<void> {
    await this.db.tx(async () => {
      // Demoting last owner → 409
      if (role !== 'owner') await this.checkNotLastOwner(teamId, userId);
      const result = await this.db.run(
        'UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?',
        [role, teamId, userId],
      );
      if (result.changes === 0) throw new NotFoundException(`Member ${userId} not found in team ${teamId}`);
    });
  }

  private async checkNotLastOwner(teamId: string, userId: string): Promise<void> {
    const member = await this.db.get<{ role: TeamRole }>(
      'SELECT role FROM team_members WHERE team_id = ? AND user_id = ?',
      [teamId, userId],
    );
    if (member?.role !== 'owner') return; // not an owner, no constraint
    const ownerCount = (await this.db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM team_members WHERE team_id = ? AND role = 'owner'",
      [teamId],
    ))?.n ?? 0;
    if (ownerCount <= 1) {
      throw new ConflictException({ code: 'last_owner', message: 'Cannot remove or demote the last owner of a team' });
    }
  }
}
