import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CompleteSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
