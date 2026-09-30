import { Type } from 'class-transformer';
import {
  IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, Matches,
  Max, MaxLength, Min, ValidateNested, ArrayMaxSize, ArrayMinSize,
} from 'class-validator';

const LIBRARY_INPUT = /^library:[A-Za-z0-9._\-/]+$/;

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

/**
 * All production fields that map to the v3 brief / the productions table.
 * Both `CreateProductionDto` and `UpdateProductionDto` extend this.
 */
export class BriefFieldsDto {
  /** Description of what this series is about (stored in productions.brief). */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /** What the series should achieve ("goal" in the v3 brief). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  goal?: string;

  /** Target audience ("audience" in the v3 brief). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  audience?: string;

  /** Tone of voice ("tone" in the v3 brief). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  tone?: string;

  /** Extra producer notes passed verbatim to the AI. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  /** ag-go folder ids that make up the footage pool (1–50). */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  sources?: string[];

  /** YouTube channel ids to include in trend research. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  youtubeChannels?: string[];

  /** SEO keywords for the series (each ≤ 100 chars, max 20). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  keywords?: string[];

  /** Target episode duration in seconds (10–3600). */
  @IsOptional()
  @IsNumber()
  @Min(10)
  @Max(3600)
  episodeTargetSeconds?: number;

  /** Maximum number of episodes to plan (1–30). Default 10. */
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(30)
  maxEpisodes?: number;

  @IsOptional()
  @IsIn(['16:9', '9:16'])
  aspect?: '16:9' | '9:16';

  @IsOptional()
  @IsString()
  @MaxLength(10)
  language?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MusicDto)
  music?: MusicDto | null;
}
