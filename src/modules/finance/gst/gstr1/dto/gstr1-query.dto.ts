import { IsString, Matches } from 'class-validator';

/**
 * Gstr1QueryDto — query parameters for all GSTR-1 endpoints.
 *
 * period: 'MMYYYY' format (6 digits), e.g. '042025' = April 2025.
 * Enforced via regex — T-12-W3-10 mitigation (period bounded to one month).
 */
export class Gstr1QueryDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'period must be MMYYYY format (6 digits, e.g. 042025)' })
  period: string;
}
