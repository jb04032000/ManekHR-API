import { IsDateString, IsInt, IsNumber, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * PreviewScheduleDto — input for POST /loan-accounts/preview-schedule
 *
 * Computes an amortisation schedule without persisting any data.
 * Used by the web LoanForm's AmortisationPreviewCard to show live EMI estimate.
 */
export class PreviewScheduleDto {
  /**
   * Loan principal in paise (integer).
   * Must be >= 1 paise.
   */
  @IsInt()
  @Min(1)
  @Type(() => Number)
  sanctionedAmountPaise!: number;

  /**
   * Annual interest rate as percentage (e.g. 12.5 for 12.5% p.a.).
   * Range: 0–50.
   */
  @IsNumber()
  @Min(0)
  @Max(50)
  @Type(() => Number)
  interestRateAnnual!: number;

  /**
   * Loan tenure in months. Must be >= 1.
   */
  @IsInt()
  @Min(1)
  @Type(() => Number)
  tenureMonths!: number;

  /**
   * ISO date string for first repayment date (YYYY-MM-DD).
   */
  @IsDateString()
  repaymentStartDate!: string;
}
