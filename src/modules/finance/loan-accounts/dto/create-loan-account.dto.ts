import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsNumber,
  IsDateString,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateLoanAccountDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  lenderName: string;

  @IsOptional()
  @IsString()
  lenderPartyId?: string;

  @IsEnum(['term_loan', 'overdraft', 'cash_credit'])
  loanType: string;

  /**
   * Total sanctioned amount in paise.
   */
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  sanctionedAmountPaise: number;

  /**
   * Actually disbursed amount in paise.
   * For OD/CC this is the initial draw-down amount.
   */
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  disbursedAmountPaise: number;

  @IsDateString()
  disbursementDate: string;

  /**
   * Annual interest rate as percentage. e.g., 11.5 for 11.5% p.a.
   */
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  interestRateAnnual: number;

  /**
   * Loan tenure in months (0 for OD/CC revolving facilities).
   */
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  tenureMonths: number;

  @IsDateString()
  repaymentStartDate: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  processingFeePaise?: number;

  /**
   * CoA liability account ObjectId — sub-account under 2017 (Loan from Bank)
   * or 2017 itself. Caller must create the Account first via Accounts API.
   */
  @IsString()
  @IsNotEmpty()
  coaLiabilityAccountId: string;

  @IsString()
  @IsNotEmpty()
  coaLiabilityAccountCode: string;
}
