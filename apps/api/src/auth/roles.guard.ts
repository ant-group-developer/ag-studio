import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { StudioDbService } from '../db/studio-db.service';
import { ROLES_KEY, TeamRole } from './roles.decorator';
import { AccountApiService } from './account-api.service';

const ROLE_ORDER: TeamRole[] = ['viewer', 'editor', 'producer', 'owner'];

function hasRole(userRole: TeamRole, requiredRole: TeamRole): boolean {
  return ROLE_ORDER.indexOf(userRole) >= ROLE_ORDER.indexOf(requiredRole);
}

interface TeamMemberRow {
  role: TeamRole;
}

interface TeamOfRow {
  team_id: string;
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: StudioDbService,
    private readonly accountApi: AccountApiService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<TeamRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const authCtx = request.authContext;
    if (!authCtx) {
      throw new UnauthorizedException('Not authenticated');
    }

    const userId = authCtx.userId;

    // Admins bypass all role checks. Cache the result on the request for this session.
    if (authCtx.isAdmin === undefined) {
      try {
        const profile = await this.accountApi.getUserProfile(authCtx.accessToken, userId);
        authCtx.isAdmin = profile.userType === 'ADMIN';
      } catch {
        authCtx.isAdmin = false;
      }
    }
    if (authCtx.isAdmin) return true;

    const params = request.params as Record<string, string>;
    const teamId = params['teamId'] ?? this.teamOfWorkspaceParam(params);

    if (!teamId) {
      throw new ForbiddenException('Cannot determine team for authorization');
    }

    const member = this.db.get<TeamMemberRow>(
      'SELECT role FROM team_members WHERE team_id = ? AND user_id = ?',
      [teamId, userId],
    );

    if (!member) {
      throw new ForbiddenException('Not a member of this team');
    }

    const minRequired = requiredRoles.reduce<TeamRole>((min, r) => {
      return ROLE_ORDER.indexOf(r) < ROLE_ORDER.indexOf(min) ? r : min;
    }, requiredRoles[0] as TeamRole);

    if (!hasRole(member.role, minRequired)) {
      throw new ForbiddenException(`Requires role: ${minRequired}`);
    }

    return true;
  }

  /** The team of a workspace route (`:projectId`, `:videoId`, `:threadId`); unknown ids leave it undetermined. */
  private teamOfWorkspaceParam(params: Record<string, string>): string | undefined {
    if (params['projectId']) {
      return this.db.get<TeamOfRow>('SELECT team_id FROM projects WHERE id = ?', [params['projectId']])?.team_id;
    }
    if (params['videoId']) {
      return this.db.get<TeamOfRow>(
        'SELECT p.team_id FROM videos v JOIN projects p ON p.id = v.project_id WHERE v.id = ?', [params['videoId']],
      )?.team_id;
    }
    if (params['threadId']) {
      return this.db.get<TeamOfRow>(
        'SELECT p.team_id FROM agent_threads t JOIN projects p ON p.id = t.project_id WHERE t.id = ?', [params['threadId']],
      )?.team_id;
    }
    return undefined;
  }
}
