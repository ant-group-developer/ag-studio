import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

const LIBRARY_INPUT = /^library:[A-Za-z0-9._\-/]+$/;

/** Narration voice (OmniVoice); `reference` null = the engine's default voice. */
export class VoiceDto {
  @IsOptional()
  @Matches(LIBRARY_INPUT)
  reference?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  referenceText?: string | null;

  @IsNumber()
  @Min(0.5)
  @Max(2)
  speed!: number;
}

/** Background music from the team library (`library:music/...`). */
export class MusicDto {
  @Matches(LIBRARY_INPUT)
  track!: string;

  @IsNumber()
  @Min(-40)
  @Max(0)
  gainDb!: number;

  @IsBoolean()
  ducking!: boolean;
}

/** The brief fields `intake` freezes (plan 4.1). All optional here; `startRun` refuses without a duration. */
export class BriefFieldsDto {
  @IsOptional()
  @IsNumber()
  @Min(10)
  @Max(1800)
  targetSeconds?: number;

  @IsOptional()
  @IsIn(['16:9', '9:16'])
  aspect?: '16:9' | '9:16';

  @IsOptional()
  @IsString()
  @MaxLength(10)
  language?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => VoiceDto)
  voice?: VoiceDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => MusicDto)
  music?: MusicDto | null;
}
