import { Type } from 'class-transformer';
import {
  IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, Matches,
  Max, MaxLength, Min, MinLength, ValidateNested, ArrayMaxSize, ArrayMinSize,
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
 * All production fields that map to the brief / the productions table.
 * Both `CreateProductionDto` and `UpdateProductionDto` extend this.
 *
 * Research first: only the footage folders and something to research (channels or keywords) are needed to start;
 * description, goal, audience, tone, notes, episode length and count are HINTS the R&D keeps when given and
 * proposes when empty. Lengths match the documents they end up in (`studio.seed/v1` hints, `studio.brief/v2`).
 */
export class BriefFieldsDto {
  /** What this series is about (stored in productions.brief). */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  goal?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  audience?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  tone?: string;

  /** Extra producer notes passed verbatim to the AI. */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  /** ag-go folder ids that make up the footage pool (1–50). */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  sources?: string[];

  /** The team's own YouTube channels (links, @handles or channel ids): the R&D assesses them. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(300, { each: true })
  ownChannels?: string[];

  /** Reference channels to learn from (own + reference together at most 20). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(300, { each: true })
  youtubeChannels?: string[];

  /** Keywords to research (each 1–100 chars, max 20). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(100, { each: true })
  keywords?: string[];

  /** Target episode duration in seconds (10–3600); null / absent = the R&D proposes it. */
  @IsOptional()
  @IsNumber()
  @Min(10)
  @Max(3600)
  episodeTargetSeconds?: number | null;

  /** Maximum number of episodes (1–30); null / absent = the R&D proposes it. */
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(30)
  maxEpisodes?: number | null;

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
