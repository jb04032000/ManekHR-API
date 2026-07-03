/**
 * DTOs for the Employer Loan endpoints.
 *
 * Spec reference: phase-2-loan-module.md section 5.3
 */

import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  Max,
  ValidateNested,
  IsArray,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  LOAN_TYPES,
  INTEREST_TYPES,
  LoanType,
  InterestType,
} from '../schemas/employer-loan.schema';

// ---------------------------------------------------------------------------
// Nested sub-DTOs
// ---------------------------------------------------------------------------

export class ApprovalStepDto {
  @IsMongoId()
  approverId: string;

  @IsString()
  @IsNotEmpty()
  approverName: string;
}

// ---------------------------------------------------------------------------
// CreateLoanDto
// ---------------------------------------------------------------------------

/**
 * POST loans
 *
 * Spec: phase-2-loan-module.md section 5.3 CreateLoanDto
 */
export class CreateLoanDto {
  @IsMongoId()
  teamMemberId: string;

  @IsEnum(LOAN_TYPES)
  loanType: LoanType;

  @IsNumber()
  @Min(1)
  principalAmount: number;

  @IsOptional()
  @IsBoolean()
  disbursedOutsideApp?: boolean;

  @IsString()
  @IsNotEmpty()
  disbursementDate: string;

  @IsOptional()
  @IsString()
  disbursementReferenceNo?: string;

  @IsOptional()
  @IsString()
  disbursementNote?: string;

  @IsEnum(INTEREST_TYPES)
  interestType: InterestType;

  /**
   * Annual interest rate in percent.
   * Must be 0 when interestType is 'zero'.
   */
  @IsNumber()
  @Min(0)
  annualInterestRate: number;

  @IsInt()
  @Min(1)
  @Max(120)
  tenorMonths: number;

  @IsInt()
  @Min(1)
  @Max(12)
  startMonth: number;

  @IsInt()
  startYear: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ApprovalStepDto)
  approvalChain?: ApprovalStepDto[];

  @IsOptional()
  @IsBoolean()
  medicalLoanExempt?: boolean;

  @IsOptional()
  @IsString()
  note?: string;
}

// ---------------------------------------------------------------------------
// PreviewLoanScheduleDto
// ---------------------------------------------------------------------------

/**
 * POST loans/preview
 *
 * Same fields as CreateLoanDto minus teamMemberId and disbursement fields.
 * Returns the computed installment schedule without persisting.
 *
 * Spec: phase-2-loan-module.md section 5.3 PreviewLoanScheduleDto
 */
export class PreviewLoanScheduleDto {
  @IsEnum(LOAN_TYPES)
  loanType: LoanType;

  @IsNumber()
  @Min(1)
  principalAmount: number;

  @IsEnum(INTEREST_TYPES)
  interestType: InterestType;

  @IsNumber()
  @Min(0)
  annualInterestRate: number;

  @IsInt()
  @Min(1)
  @Max(120)
  tenorMonths: number;

  @IsInt()
  @Min(1)
  @Max(12)
  startMonth: number;

  @IsInt()
  startYear: number;
}

// ---------------------------------------------------------------------------
// Lifecycle DTOs (Slice 3) - stubs included so controller can reference them
// ---------------------------------------------------------------------------

export class ApproveLoanDto {
  @IsIn(['approve', 'reject'])
  decision: 'approve' | 'reject';

  @IsOptional()
  @IsString()
  comment?: string;
}

export class SkipInstallmentDto {
  @IsInt()
  @Min(0)
  installmentIndex: number;

  @IsIn(['extend_tenor', 'raise_emi'])
  knockOnChoice: 'extend_tenor' | 'raise_emi';

  @IsString()
  @IsNotEmpty()
  skipReason: string;
}

export class PauseResumeLoanDto {
  @IsIn(['pause', 'resume'])
  action: 'pause' | 'resume';

  @IsOptional()
  @IsString()
  pauseResumeDate?: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class EarlyPayoffLoanDto {
  @IsNumber()
  @Min(0.01)
  payoffAmount: number;

  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class TopUpLoanDto {
  @IsNumber()
  @Min(1)
  additionalAmount: number;

  @IsString()
  @IsNotEmpty()
  disbursementDate: string;

  @IsOptional()
  @IsBoolean()
  disbursedOutsideApp?: boolean;

  @IsOptional()
  @IsString()
  disbursementReferenceNo?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  newTenorMonths?: number;

  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class WriteOffLoanDto {
  @IsNumber()
  @Min(0.01)
  writeOffAmount: number;

  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class ComputePerquisiteMonthDto {
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @IsInt()
  year: number;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
