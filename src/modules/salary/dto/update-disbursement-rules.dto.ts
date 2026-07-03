import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// Mirrors PayrollConfig.disbursementRules.advanceRequestPolicy
// (schemas/payroll-config.schema.ts advanceRequestPolicy sub-doc) and the
// three modes used by advance-request-window.util.ts. Used by UpdateDisbursementRulesDto.
export class AdvanceRequestPolicyInputDto {
  @IsIn(['any_day', 'window', 'fixed_day'])
  mode: 'any_day' | 'window' | 'fixed_day';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(28)
  fixedDay?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  windowStartDay?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  windowEndDay?: number;
}

export class UpdateDisbursementRulesDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(28)
  salaryDate?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(28)
  payoutWindowDays?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(28)
  advanceRequestDay?: number;

  // Day-of-month the advance batch is distributed on (Phase 1b two-step disburse),
  // separate from salaryDate. 1-28 so every month has the day. Optional; null = no
  // fixed payout day configured (informational on the disburse step).
  // Links: payroll-config.schema.ts disbursementRules.advancePayoutDay,
  //        salary.service.ts updateDisbursementRules / payApprovedAdvance.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(28)
  advancePayoutDay?: number;

  // Structured request-window policy (any_day | window | fixed_day).
  // Persisted by salary.service.ts updateDisbursementRules; read by
  // advance-request-window.util.ts on create and by getWindowForMember.
  // Links: AdvanceRequestPolicyInputDto, advance-request-window.util.ts.
  @IsOptional()
  @ValidateNested()
  @Type(() => AdvanceRequestPolicyInputDto)
  advanceRequestPolicy?: AdvanceRequestPolicyInputDto;

  // ── Phase 3b: advance ELIGIBILITY CAPS (owner-configurable, OFF by default) ──
  // Persisted by salary.service.ts updateDisbursementRules and enforced in
  // advance-salary-request.service.ts createRequest. Each is optional; omit to
  // leave a cap unchanged. To clear a cap (turn it OFF) the web layer sends null.
  // Links: payroll-config.schema.ts disbursementRules, DisbursementRulesPanel.tsx.

  /** Single request may not exceed X% of the member's monthly figure (1-100). */
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  advanceMaxPercentOfNet?: number | null;

  /** Max number of advance requests a member may make per calendar year (>=1). */
  @IsOptional()
  @IsInt()
  @Min(1)
  advanceMaxPerYear?: number | null;

  /** Member must have at least N months of tenure (from dateOfJoining) to request (>=0). */
  @IsOptional()
  @IsInt()
  @Min(0)
  advanceMinTenureMonths?: number | null;
}

export class UpdateSalaryLossConfigDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  regularizationWindowDays?: number;

  @IsOptional()
  @IsBoolean()
  salaryLossEnabled?: boolean;
}

export class UpdateAttendanceRulesDto {
  @IsOptional()
  @IsBoolean()
  holidayCountsAsPresent?: boolean;

  @IsOptional()
  @IsBoolean()
  weekOffCountsAsPresent?: boolean;

  @IsOptional()
  @IsBoolean()
  lateMarkAsHalfDay?: boolean;
}
