import { IsIn } from 'class-validator';

export class UpdateMemberRoleDto {
  @IsIn(['owner', 'producer', 'editor', 'viewer'])
  role!: string;
}
