/**
 * DTOs for the employee-originated Loan Request layer (self-service).
 *
 * Mirrors the AdvanceSalaryRequest self-service pattern: an employee creates a
 * lightweight request (amount + desired months), and later the OWNER approves it,
 * at which point the system materializes a real EmployerLoan (interestType='zero')
 * via the EXISTING LoanService.createLoan. The EmployerLoan engine and its
 * Separation-of-Duties guard are NOT touched by this layer.
 *
 * The CONSUMER (controller + service) lands in Task 2; this file is the
 * validation foundation only.
 */

import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { INTEREST_TYPES, InterestType } from '../schemas/employer-loan.schema';
import { ApprovalStepDto } from './loan.dto';

/**
 * POST loan-requests — the employee self-applies for a 0% installment loan.
 *
 * SECURITY: the requesting member is NEVER taken from the body. The controller
 * (Task 2) resolves the caller's own teamMemberId from the JWT and passes it to
 * the service (mirrors CreateAdvanceRequestDto). A body-supplied member id would
 * let a self-scoped worker file a request on another member's behalf (IDOR), so
 * the controller ValidationPipe (whitelist + forbidNonWhitelisted) rejects any
 * extra field such as `teamMemberId`.
 */
export class CreateLoanRequestDto {
  /** Amount requested in paise (integer, >= 1). Same unit as AdvanceSalaryRequest.requestedAmount. */
  @IsInt()
  @Min(1)
  requestedAmount: number;

  /** Desired repayment timeline in months (1–120). Final terms are set by the owner at approval. */
  @IsInt()
  @Min(1)
  @Max(120)
  desiredTenorMonths: number;

  /** Optional free-text reason for the request. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  purpose?: string;
}

/**
 * POST loan-requests/:requestId/approve — the OWNER sets the final loan terms.
 *
 * On approval (Task 2) the service calls the existing LoanService.createLoan with
 * interestType='zero', materializing the real EmployerLoan and recording its id on
 * the request's createdEmployerLoanId. Mirrors the CreateLoanDto term fields so the
 * approve step accepts the same term shape the owner Loan composer already produces.
 */
export class ApproveLoanRequestDto {
  /** Final repayment tenor in months (1–120). May differ from the requested timeline. */
  @IsInt()
  @Min(1)
  @Max(120)
  tenorMonths: number;

  /** Month (1–12) the first installment recovery lands in. */
  @IsInt()
  @Min(1)
  @Max(12)
  startMonth: number;

  /** Calendar year of the first installment. */
  @IsInt()
  startYear: number;

  /**
   * Interest type — defaults to 'zero' (the self-service loan is always interest-free).
   * Restricted to the existing INTEREST_TYPES enum (matches CreateLoanDto). The
   * default is applied during transformation so an omitted value resolves to 'zero'.
   */
  @IsOptional()
  @Transform(({ value }): unknown => value ?? 'zero')
  @IsEnum(INTEREST_TYPES)
  interestType?: InterestType = 'zero';

  /**
   * Final principal in paise. If omitted, the service uses the request's
   * requestedAmount (the owner may approve a different amount).
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  principalAmount?: number;

  /**
   * Optional approval chain override; cloned into the materialized loan. Mirrors
   * CreateLoanDto.approvalChain (defaults to the workspace loanConfig chain).
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ApprovalStepDto)
  approvalChain?: ApprovalStepDto[];
}

/**
 * POST loan-requests/:requestId/reject — the OWNER declines the request with a reason.
 */
export class RejectLoanRequestDto {
  /** Reason shown to the employee. Required. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
