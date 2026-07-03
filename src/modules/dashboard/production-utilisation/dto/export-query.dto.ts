import {
  IsOptional,
  IsDateString,
  IsArray,
  ArrayMaxSize,
  IsMongoId,
  IsIn,
} from 'class-validator';

/**
 * Phase 25 Plan 04 — Export query DTO.
 *
 * Mirrors KpiQueryDto filters and adds the export `format` discriminator.
 * `raw` returns JSON (used by the web export pipeline before PDF/Excel
 * generation); `pdf` and `excel` are reserved for direct backend export
 * if/when the web pattern is bypassed.
 */
export type ExportFormat = 'pdf' | 'excel' | 'raw';

export class ExportQueryDto {
  @IsIn(['pdf', 'excel', 'raw'])
  format!: ExportFormat;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsMongoId({ each: true })
  machineIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsMongoId({ each: true })
  locationIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsMongoId({ each: true })
  shiftIds?: string[];
}
