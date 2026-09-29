import { IsString, IsIn } from 'class-validator';

export class AddMemberDto {
  @IsString()
  userId!: string;

  @IsIn(['owner', 'producer', 'editor', 'viewer'])
  role!: string;
}
