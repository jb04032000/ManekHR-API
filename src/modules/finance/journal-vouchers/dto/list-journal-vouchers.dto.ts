import { IsDateString, IsIn, IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListJournalVouchersDto {
  @IsOptional()
  @IsIn(['draft', 'posted', 'cancelled'])
  state?: string;

  @IsOptional()
  @IsIn(['journal', 'contra'])
  voucherType?: string;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
