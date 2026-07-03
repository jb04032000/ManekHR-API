import { IsEnum, IsMongoId, IsOptional, IsString, Matches } from 'class-validator';

export class Itc04QueryDto {
  @IsEnum(['Q1', 'Q2', 'Q3', 'Q4'])
  quarter: 'Q1' | 'Q2' | 'Q3' | 'Q4';

  /**
   * FY string. Accepts "2526", "2025-26", or "25-26".
   * Service normalizes to extract start/end year.
   */
  @IsString()
  @Matches(/^(\d{2}|\d{4})-?\d{2}$/)
  fy: string;

  @IsOptional()
  @IsMongoId()
  partyId?: string;
}
