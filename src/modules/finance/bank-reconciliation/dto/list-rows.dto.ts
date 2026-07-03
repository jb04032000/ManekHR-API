import { IsOptional, IsIn, IsInt, Min, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';

export class ListRowsDto {
  @IsOptional()
  @IsIn(['unmatched', 'matched', 'excluded', 'disputed', 'new_voucher', 'all'])
  status?: string;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number; // default 50, max 200
}
