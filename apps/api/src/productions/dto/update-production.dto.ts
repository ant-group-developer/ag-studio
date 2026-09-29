import { BriefFieldsDto } from './brief-fields.dto';
import { IsString, IsOptional, MaxLength, IsObject, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';
import { ValidateNested } from 'class-validator';

export class CanvasUpdateDto {
  @IsNumber()
  width!: number;

  @IsNumber()
  height!: number;
}

export class UpdateProductionDto extends BriefFieldsDto {
  @IsString()
  @IsOptional()
  @MaxLength(200)
  title?: string;

  @IsString()
  @IsOptional()
  brief?: string;

  @IsObject()
  @IsOptional()
  @ValidateNested()
  @Type(() => CanvasUpdateDto)
  canvas?: CanvasUpdateDto;

}
