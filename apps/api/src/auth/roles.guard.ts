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

const ROLE_ORDER: TeamRole[] = ['viewer', 'editor', 'producer', 'owner'];

function hasRole(userRole: TeamRole, requiredRole: TeamRole): boolean {
  return ROLE_ORDER.indexOf(userRole) >= ROLE_ORDER.indexOf(requiredRole);
}

interface TeamMemberRow {
  role: TeamRole;
}

interface ProductionRow {
  team_id: string;
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: StudioDbService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
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
    const params = request.params as Record<string, string>;
    let teamId = params['teamId'];

    if (!teamId && params['id']) {
      // Try to look up from production
      const prod = this.db.get<ProductionRow>(
        'SELECT team_id FROM productions WHERE id = ?',
        [params['id']],
      );
      if (prod) {
        teamId = prod.team_id;
      }
    }

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
}
