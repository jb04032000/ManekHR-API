import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateAdvanceRequestDto {
  // SECURITY: the requesting member is NEVER taken from the body. The controller
  // resolves the caller's own teamMemberId from the JWT via CallerScopeService and
  // passes it to the service (mirrors GET /mine). A body-supplied member id would
  // let a self-scoped worker file a request on another member's behalf (IDOR).
  // Links: advance-salary-request.controller.ts createRequest, advance-salary-request.service.ts createRequest.

  /** Amount requested in paise (integer, >= 1) */
  @IsInt()
  @Min(1)
  requestedAmount: number;

  /** Month (1–12) the advance is requested against — must be current month */
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  /** Calendar year */
  @IsInt()
  year: number;
}

/**
 * Approve = approve + disburse + start interest-free installment recovery.
 * The approver sets the recovery terms here; on approval the advance is recorded
 * as a Payment and wired into the existing AdvanceRecoveryPlan engine, which
 * deducts it from future months. Interest is NEVER a field — the self-service
 * advance is always interest-free (interest-bearing lending lives only in the
 * separate EmployerLoan tool).
 * Links: salary.service.ts approveAndDisburseAdvanceRequest, createAdvanceRecoveryPlan.
 */
export class ApproveAdvanceRequestDto {
  /** Amount approved by the owner, in paise (integer, >= 1). May differ from requested. */
  @IsInt()
  @Min(1)
  approvedAmount: number;

  @IsOptional()
  @IsString()
  reviewNote?: string;

  /**
   * Number of equal monthly installments to recover the advance over. Provide
   * EITHER installmentCount OR installmentAmount (not both). Omit both for a
   * single lump recovery in the start month. Max 24 (mirrors PreviewAdvanceScheduleDto).
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24)
  installmentCount?: number;

  /** Fixed paise amount to recover each month (alternative to installmentCount). */
  @IsOptional()
  @IsInt()
  @Min(1)
  installmentAmount?: number;

  /**
   * Month/year the FIRST recovery installment lands in. Defaults to the month
   * after the request month (a grace cycle, per industry norm). 1-12 for month.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  startMonth?: number;

  @IsOptional()
  @IsInt()
  startYear?: number;

  /** How the advance is paid out. Defaults to 'cash'. */
  @IsOptional()
  @IsIn(['cash', 'bank_transfer', 'upi', 'cheque', 'split', 'other'])
  paymentMode?: string;

  /** Optional Chart-of-Accounts account for the finance ledger posting (D-06/D-10). */
  @IsOptional()
  @IsMongoId()
  coaAccountId?: string;

  /**
   * Proceed even if an installment month breaches a hard compliance rule
   * (50% deduction cap or minimum-wage floor); applies the clamped compliant
   * amount and audits the override. Requires overrideReason.
   */
  @IsOptional()
  @IsBoolean()
  overrideCompliance?: boolean;

  @IsOptional()
  @IsString()
  overrideReason?: string;
}

export class RejectAdvanceRequestDto {
  @IsOptional()
  @IsString()
  reviewNote?: string;
}

/**
 * VerifyAdvanceRequestDto — body for the reporting-person VERIFY action
 * (PATCH :requestId/verify, Phase 3a). The reporting person may leave an
 * optional advisory note (capped at 500 chars). Verify is advisory only: it
 * stamps verifiedBy/verifiedAt/verifyNote and never changes request status nor
 * gates the owner approve path. The reviewer's identity + their own
 * teamMemberId are resolved server-side from the JWT, never the body.
 * Links: advance-salary-request.controller.ts verify, advance-salary-request.service.ts verifyRequest.
 */
export class VerifyAdvanceRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * Split-payment line for an advance disbursement. Mirrors the (unexported)
 * SplitLineDto used by RecordPaymentDto in salary.dto.ts so the disburse step
 * accepts the same split-line shape the salary Pay drawer already produces.
 * Persisted verbatim on Payment.splitLines (a Record<string, any>[] sub-doc).
 */
export class AdvancePaySplitLineDto {
  @IsEnum(['cash', 'upi', 'bank_transfer', 'cheque', 'other']) method: string;
  @IsNumber() amount: number;
  @IsString() @IsOptional() dateTime?: string;
  @IsString() @IsOptional() accountNumber?: string;
  @IsString() @IsOptional() bankName?: string;
  @IsString() @IsOptional() upiRef?: string;
  @IsString() @IsOptional() transactionId?: string;
  @IsString() @IsOptional() voucherNo?: string;
  @IsString() @IsOptional() paidBy?: string;
  @IsString() @IsOptional() paymentFrom?: string;
  @IsString() @IsOptional() referenceNo?: string;
  @IsString() @IsOptional() note?: string;
  @IsArray() @IsString({ each: true }) @IsOptional() proofUrls?: string[];
}

/**
 * PayAdvanceRequestDto — owner DISBURSES an already-approved advance request on
 * the payout day (Phase 1b two-step). Records the cash/bank Payment (capturing
 * method/split-lines/reference/proof and WHO handed it over), posts the finance
 * ledger journal (Dr 1014 Salary Advance / Cr cash-bank), CREATES the 0-interest
 * recovery (multi-installment plan or single deduction), then flips the request
 * to 'paid' so the next month's salary auto-recovers it. The amount is NOT taken
 * from the client; it is the request's owner-approved amount (paise), converted
 * to rupees for the salary-side Payment.
 * Links: salary.service.ts payApprovedAdvance.
 */
export class PayAdvanceRequestDto {
  /** Payment mode for the outflow ('split' enables splitLines). Defaults to 'cash'. */
  @IsOptional()
  @IsIn(['cash', 'bank_transfer', 'upi', 'cheque', 'split', 'other'])
  paymentMode?: 'cash' | 'bank_transfer' | 'upi' | 'cheque' | 'split' | 'other';

  /** Optional finance CoA cash/bank account to credit; falls back to 1001 Cash. */
  @IsOptional()
  @IsMongoId()
  coaAccountId?: string;

  /** Optional ISO payment date; defaults to now. */
  @IsOptional()
  @IsString()
  paymentDate?: string;

  @IsOptional()
  @IsString()
  referenceNo?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsString()
  paidBy?: string;

  // ── Recovery terms (lifted to the disburse step in Phase 1b) ────────────────
  // Recovery is created HERE now (was at approve). Provide EITHER installmentCount
  // OR installmentAmount (not both); omit both for a single lump deduction in the
  // start month. Defaults mirror the legacy combined method.

  /** Equal monthly installments to recover the advance over (max 24). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24)
  installmentCount?: number;

  /** Fixed paise amount to recover each month (alternative to installmentCount). */
  @IsOptional()
  @IsInt()
  @Min(1)
  installmentAmount?: number;

  /** Month the FIRST recovery installment lands in. Defaults to request.month + 1. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  startMonth?: number;

  @IsOptional()
  @IsInt()
  startYear?: number;

  /** Proceed even if an installment month breaches a hard compliance rule. */
  @IsOptional()
  @IsBoolean()
  overrideCompliance?: boolean;

  @IsOptional()
  @IsString()
  overrideReason?: string;

  // ── Disbursement capture (Phase 1b) ─────────────────────────────────────────

  /** Split-payment lines (used when paymentMode === 'split'). Gated on splitPayments. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdvancePaySplitLineDto)
  splitLines?: AdvancePaySplitLineDto[];

  /** Proof attachment URLs (receipts/screenshots) for the payout. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  proofUrls?: string[];

  /** Free-text name of the person who actually handed over the money (anti-fraud). */
  @IsOptional()
  @IsString()
  disbursedByName?: string;
}
