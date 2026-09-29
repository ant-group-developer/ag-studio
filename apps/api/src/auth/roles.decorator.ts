import { SetMetadata } from '@nestjs/common';

export type TeamRole = 'owner' | 'producer' | 'editor' | 'viewer';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: TeamRole[]) => SetMetadata(ROLES_KEY, roles);
