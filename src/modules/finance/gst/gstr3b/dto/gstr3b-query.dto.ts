import { IsString, Matches } from 'class-validator';

/**
 * Gstr3bQueryDto — query parameters for GSTR-3B report and export endpoints.
 *
 * period: 'MMYYYY' format (6 digits), e.g. '042025' = April 2025.
 * Enforced via regex — T-12-W3-16 mitigation (period bounded to one month).
 */
export class Gstr3bQueryDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'period must be MMYYYY format (6 digits, e.g. 042025)' })
  period: string;
}
