import { IsArray, IsString } from 'class-validator';

export class SetSourcesDto {
  @IsArray()
  @IsString({ each: true })
  folderIds!: string[];
}
