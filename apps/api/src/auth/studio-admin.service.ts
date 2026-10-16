import { ForbiddenException, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { StudioDbService } from '../db/studio-db.service';
import { AccountApiService } from './account-api.service';

/** What a person may see on the Studio-wide screens (activity log, Claude stats): everything, or some teams. */
export type ViewScope = { all: true } | { all: false; teamIds: string[] };

/**
 * Studio admins (`user_type = ADMIN` from the Account API) and team owners. The admin answer is cached on the
 * request, as `RolesGuard` does, so one request asks the Account API once.
 */
@Injectable()
export class StudioAdminService {
  constructor(
    private readonly accountApi: AccountApiService,
    private readonly db: StudioDbService,
  ) {}

  async isAdmin(req: Request): Promise<boolean> {
    const ctx = req.authContext!;
    if (ctx.isAdmin === undefined) {
      try { ctx.isAdmin = (await this.accountApi.getUserProfile(ctx.accessToken, ctx.userId)).userType === 'ADMIN'; }
      catch { ctx.isAdmin = false; }
    }
    return ctx.isAdmin;
  }

  async requireAdmin(req: Request): Promise<void> {
    if (!(await this.isAdmin(req))) throw new ForbiddenException('Requires a Studio admin');
  }

  async ownedTeamIds(userId: string): Promise<string[]> {
    return (await this.db
      .all<{ team_id: string }>("SELECT team_id FROM team_members WHERE user_id = ? AND role = 'owner' ORDER BY team_id", [userId]))
      .map((r) => r.team_id);
  }

  /**
   * An admin sees every team; anyone else the teams they own, narrowed to `teamId` when given. Owning none, or
   * asking for a team one does not own, is a 403.
   */
  async viewScope(req: Request, teamId?: string): Promise<ViewScope> {
    if (await this.isAdmin(req)) return teamId ? { all: false, teamIds: [teamId] } : { all: true };
    const owned = await this.ownedTeamIds(req.authContext!.userId);
    if (teamId) {
      if (!owned.includes(teamId)) throw new ForbiddenException('Requires the owner of this team');
      return { all: false, teamIds: [teamId] };
    }
    if (owned.length === 0) throw new ForbiddenException('Requires a Studio admin or a team owner');
    return { all: false, teamIds: owned };
  }
}
