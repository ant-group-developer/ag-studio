import { IsInt, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class SubmitGateDto {
  /** The gate's document (rnd.json, branding.json, series-plan.json), or the R&D / branding a person saves. */
  @IsOptional()
  @IsObject()
  document?: Record<string, unknown>;
}

export class SaveRevisionDto {
  /** The revision this edit was based on; 0 when there is none yet. A stale base answers 409. */
  @IsInt()
  @Min(0)
  baseRevision!: number;

  /** Full TimelineV3 (`studio.timeline/v3`). */
  @IsObject()
  data!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;
}

export class PreviewDto {
  @IsInt()
  @Min(1)
  revision!: number;
}
