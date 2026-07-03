import { IsOptional, IsString, Matches } from 'class-validator';

/**
 * VerifyDataRunDto — body for POST /verify-data/run.
 * period: 'MMYYYY' format (6 digits), e.g. '042025' = April 2025.
 */
export class VerifyDataRunDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'period must be MMYYYY format (6 digits, e.g. 042025)' })
  period: string;
}

/**
 * VerifyDataQueryDto — query parameters for GET /verify-data/results.
 * period: optional filter; if omitted, returns all recent results for the firm.
 */
export class VerifyDataQueryDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'period must be MMYYYY format (6 digits, e.g. 042025)' })
  period?: string;
}
