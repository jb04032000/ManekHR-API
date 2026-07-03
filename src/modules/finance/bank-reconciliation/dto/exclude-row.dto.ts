import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ExcludeRowDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
