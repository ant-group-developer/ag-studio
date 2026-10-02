import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { TEAM_SKILL_LIMITS, TEAM_SKILL_STEPS, type TeamSkillStep } from '@ag-studio/engine';

/** A team skill: markdown the team's Claude calls follow (limits shared with the engine). */
export class CreateTeamSkillDto {
  @IsString()
  @MinLength(1)
  @MaxLength(TEAM_SKILL_LIMITS.name)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(TEAM_SKILL_LIMITS.purpose)
  purpose?: string;

  /** Steps it applies to; empty or absent = every step. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TEAM_SKILL_STEPS.length)
  @IsIn(TEAM_SKILL_STEPS, { each: true })
  appliesTo?: TeamSkillStep[];

  @IsString()
  @MinLength(1)
  @MaxLength(TEAM_SKILL_LIMITS.content)
  content!: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  position?: number;
}

export class UpdateTeamSkillDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(TEAM_SKILL_LIMITS.name)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(TEAM_SKILL_LIMITS.purpose)
  purpose?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TEAM_SKILL_STEPS.length)
  @IsIn(TEAM_SKILL_STEPS, { each: true })
  appliesTo?: TeamSkillStep[];

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(TEAM_SKILL_LIMITS.content)
  content?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  position?: number;
}
