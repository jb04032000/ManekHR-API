import { IsDateString, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';

export class GetStatementDto {
  /** Inclusive lower bound of entryDate. ISO date string (YYYY-MM-DD). */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** Inclusive upper bound of entryDate. ISO date string (YYYY-MM-DD). */
  @IsOptional()
  @IsDateString()
  to?: string;

  /** 1-based page number. Defaults to 1. */
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : parseInt(value, 10)))
  @IsInt()
  @Min(1)
  page?: number;

  /** Page size. Defaults to 100. Max 500 to bound memory. */
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : parseInt(value, 10)))
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
