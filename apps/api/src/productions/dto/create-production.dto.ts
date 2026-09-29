import { IsString, IsOptional, MinLength, MaxLength, IsObject, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';
import { ValidateNested } from 'class-validator';

export class CanvasDto {
  @IsNumber()
  width!: number;

  @IsNumber()
  height!: number;
}

export class CreateProductionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsString()
  @IsOptional()
  brief?: string;

  @IsObject()
  @IsOptional()
  @ValidateNested()
  @Type(() => CanvasDto)
  canvas?: CanvasDto;
}
