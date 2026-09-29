import { IsInt, IsObject, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';

export class SubmitGateDto {
  /** treatment.json (approve-treatment) or selection.json (shot-board); ignored by `edit`. */
  @IsOptional()
  @IsObject()
  document?: Record<string, unknown>;
}

export class SaveRevisionDto {
  /** The revision this edit was made on; 0 when there is none yet. A stale base answers 409. */
  @IsInt()
  @Min(0)
  baseRevision!: number;

  /** Full Timeline v2 (`studio.timeline/v2`). */
  @IsObject()
  data!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;
}

export class LineTtsDto {
  @Matches(/^L\d{3}$/)
  lineId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1200)
  text!: string;
}

export class PreviewDto {
  @IsInt()
  @Min(1)
  revision!: number;
}
