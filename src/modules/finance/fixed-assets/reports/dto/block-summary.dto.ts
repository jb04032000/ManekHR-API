import { IsString, Matches } from 'class-validator';

/**
 * financialYear: Indian FY format "YYYY-YY" e.g. "2024-25", "2025-26"
 */
export class BlockSummaryDto {
  @IsString() @Matches(/^\d{4}-\d{2}$/) financialYear: string;
}
