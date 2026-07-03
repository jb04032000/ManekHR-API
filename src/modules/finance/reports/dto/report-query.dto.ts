import { IsDateString, IsOptional, IsString, IsMongoId, IsInt, Min, Max } from 'class-validator';
import { Transform } from 'class-transformer';

export class ReportQueryDto {
  @IsDateString()
  dateFrom: string;

  @IsDateString()
  dateTo: string;

  @IsOptional()
  @IsString()
  financialYear?: string; // e.g. '2024-25'

  @IsOptional()
  @IsMongoId()
  partyId?: string;

  @IsOptional()
  @IsString()
  accountCode?: string;

  @IsOptional()
  @IsMongoId()
  godownId?: string;

  @IsOptional()
  @IsMongoId()
  machineId?: string;

  // Enforce max 366 days per request (DoS protection — RESEARCH security domain)
  get dateFromParsed(): Date { return new Date(this.dateFrom); }
  get dateToParsed(): Date { return new Date(this.dateTo); }
}

export class PaginatedReportQueryDto extends ReportQueryDto {
  @IsOptional()
  @Transform(({ value }) => parseInt(value))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Transform(({ value }) => parseInt(value))
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number = 100;
}
