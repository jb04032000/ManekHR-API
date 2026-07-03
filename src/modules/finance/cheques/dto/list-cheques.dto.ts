import { IsOptional, IsEnum, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';

export class ListChequesDto {
  @IsOptional()
  @IsEnum(['issued', 'received'])
  chequeType?: string;

  @IsOptional()
  @IsEnum(['pending_maturity', 'in_transit', 'cleared', 'bounced', 'stopped', 'void'])
  status?: string;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @IsOptional()
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  limit?: number;
}
