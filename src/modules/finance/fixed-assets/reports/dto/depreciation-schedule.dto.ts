import { IsOptional, IsString, Matches } from 'class-validator';

export class DepreciationScheduleDto {
  @IsString() @Matches(/^\d{4}-\d{2}$/) @IsOptional() fromMonth?: string;
  @IsString() @Matches(/^\d{4}-\d{2}$/) @IsOptional() toMonth?: string;
}
