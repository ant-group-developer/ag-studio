import { BriefFieldsDto } from './brief-fields.dto';
import { IsString, IsOptional, MinLength, MaxLength, IsObject, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';
import { ValidateNested } from 'class-validator';

export class CanvasDto {
  @IsNumber()
  width!: number;

  @IsNumber()
  height!: number;
}

export class CreateProductionDto extends BriefFieldsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsObject()
  @IsOptional()
  @ValidateNested()
  @Type(() => CanvasDto)
  canvas?: CanvasDto;
}
