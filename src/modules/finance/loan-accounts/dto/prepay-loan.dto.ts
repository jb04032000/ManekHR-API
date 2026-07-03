import { IsString, IsNumber, IsDateString, IsOptional, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO for recording a loan prepayment.
 *
 * Prepayment:
 *  - Reduces principalOutstandingPaise by amountPaise
 *  - Posts: Dr loanLiabilityCode (principal) / Cr bankCoaCode
 *  - Recomputes remaining schedule: preserves EMI, shortens tenure
 *
 * Security (T-F06W5-06): amountPaise validated server-side against principalOutstandingPaise.
 */
export class PrepayLoanDto {
  /** Prepayment amount in paise. Must be >= 1 and <= principalOutstandingPaise (enforced in service). */
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  amountPaise: number;

  /** Date on which the prepayment is made. Used as the ledger entry date. */
  @IsDateString()
  prepaymentDate: string;

  /** CoA code of the bank account to debit for the prepayment. */
  @IsString()
  @MinLength(1)
  bankCoaCode: string;

  /** Narration for the ledger entry (e.g. "Part-prepayment of HDFC Term Loan"). */
  @IsOptional()
  @IsString()
  @MinLength(5)
  narration?: string;
}
