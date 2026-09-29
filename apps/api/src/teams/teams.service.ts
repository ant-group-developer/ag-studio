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

@Injectable()
export class TeamsService {
  constructor(private readonly db: StudioDbService) {}

  createTeam(name: string, ownerId: string): { id: string; name: string; createdAt: string; members: { userId: string; role: TeamRole }[] } {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db.run('INSERT INTO teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', [
      id,
      name,
      now,
      now,
    ]);
    this.db.run(
      'INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      [id, ownerId, 'owner', now],
    );

    return {
      id,
      name,
      createdAt: now,
      members: [{ userId: ownerId, role: 'owner' }],
    };
  }

  listTeams(userId: string): { id: string; name: string; createdAt: string; role: TeamRole }[] {
    const rows = this.db.all<TeamRow & { role: TeamRole }>(
      `SELECT t.id, t.name, t.created_at, tm.role
       FROM teams t
       JOIN team_members tm ON tm.team_id = t.id
       WHERE tm.user_id = ?
       ORDER BY t.created_at DESC`,
      [userId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, role: r.role }));
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

  addMember(teamId: string, userId: string, role: TeamRole): void {
    const existing = this.db.get<TeamMemberRow>(
      'SELECT team_id FROM team_members WHERE team_id = ? AND user_id = ?',
      [teamId, userId],
    );
    if (existing) {
      throw new ConflictException(`User ${userId} is already a member`);
    }
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      [teamId, userId, role, now],
    );
  }

  removeMember(teamId: string, userId: string): void {
    const result = this.db.run(
      'DELETE FROM team_members WHERE team_id = ? AND user_id = ?',
      [teamId, userId],
    );
    if (result.changes === 0) {
      throw new NotFoundException(`Member ${userId} not found in team ${teamId}`);
    }
  }

  updateMemberRole(teamId: string, userId: string, role: TeamRole): void {
    const result = this.db.run(
      'UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?',
      [role, teamId, userId],
    );
    if (result.changes === 0) {
      throw new NotFoundException(`Member ${userId} not found in team ${teamId}`);
    }
  }
}
