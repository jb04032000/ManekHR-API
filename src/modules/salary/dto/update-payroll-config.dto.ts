import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  Max,
  ValidateNested,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

class PayrollFeaturesDto {
  @IsBoolean() @IsOptional() attendanceBasedPay?: boolean;
  @IsBoolean() @IsOptional() adjustments?: boolean;
  @IsBoolean() @IsOptional() advancePayments?: boolean;
  @IsBoolean() @IsOptional() splitPayments?: boolean;
  @IsBoolean() @IsOptional() commissionTracking?: boolean;
  @IsBoolean() @IsOptional() salaryComponents?: boolean;
  @IsBoolean() @IsOptional() payslipGeneration?: boolean;
  @IsBoolean() @IsOptional() bankDetails?: boolean;
  @IsBoolean() @IsOptional() proofAttachments?: boolean;
  @IsBoolean() @IsOptional() hourlySalary?: boolean;
  @IsBoolean() @IsOptional() bulkPayments?: boolean;
  @IsBoolean() @IsOptional() autoGenerate?: boolean;
  @IsBoolean() @IsOptional() salaryRevisions?: boolean;
  @IsBoolean() @IsOptional() salaryIncrements?: boolean;
  @IsBoolean() @IsOptional() loanManagement?: boolean;
  @IsBoolean() @IsOptional() bonusTracking?: boolean;
  @IsBoolean() @IsOptional() dailyWageLedger?: boolean;
}

class PayrollDisplayDto {
  @IsString() @IsOptional() currencyCode?: string;
  @IsString() @IsOptional() currencySymbol?: string;
  @IsString() @IsOptional() currencyLocale?: string;
  @IsNumber() @IsOptional() defaultWorkingDays?: number;
  @IsNumber() @IsOptional() payDay?: number;
  @IsEnum(['monthly', 'biweekly', 'weekly']) @IsOptional() payCycle?: string;
}

class PayrollRulesDto {
  @IsEnum(['enabled', 'disabled'])
  @IsOptional()
  attendancePayModeDefault?: 'enabled' | 'disabled';
}

class PtCustomSlabDto {
  @IsNumber()
  minSalary: number;

  @IsNumber()
  @IsOptional()
  maxSalary: number | null;

  @IsNumber()
  ptAmount: number;
}

class PayrollStatutoryDto {
  @IsBoolean()
  @IsOptional()
  pfEnabled?: boolean;

  @IsString()
  @IsOptional()
  pfEstablishmentCode?: string;

  @IsNumber()
  @IsOptional()
  pfWageCeiling?: number;

  @IsBoolean()
  @IsOptional()
  esiEnabled?: boolean;

  @IsString()
  @IsOptional()
  esiCode?: string;

  @IsNumber()
  @IsOptional()
  esiGrossThreshold?: number;

  @IsBoolean()
  @IsOptional()
  ptEnabled?: boolean;

  @IsBoolean()
  @IsOptional()
  tdsEnabled?: boolean;

  @IsBoolean()
  @IsOptional()
  lwfEnabled?: boolean;

  @IsString()
  @IsOptional()
  ptState?: string;

  @IsBoolean()
  @IsOptional()
  ptUseCustomSlabs?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PtCustomSlabDto)
  @IsOptional()
  ptCustomSlabs?: PtCustomSlabDto[];
}

class PayrollComplianceDto {
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  @IsOptional()
  minimumWageMonthly?: number | null;

  @IsEnum(['unskilled', 'semi_skilled', 'skilled', 'highly_skilled'])
  @IsOptional()
  minimumWageCategory?: 'unskilled' | 'semi_skilled' | 'skilled' | 'highly_skilled';

  @IsIn([50, 75])
  @IsOptional()
  deductionCapPercent?: 50 | 75;

  @IsBoolean()
  @IsOptional()
  installmentAdvisoryOneThirdEnabled?: boolean;

  @IsNumber()
  @Min(1)
  @Max(60)
  @IsOptional()
  installmentAdvisoryMaxMonths?: number;
}

/**
 * loanConfig.self-apply settings (employee-originated LoanRequest layer).
 * Additive + all-optional so existing update payloads are unaffected. Each is
 * nullable where the schema treats null as "off / no limit": the web layer sends
 * null to clear selfApplyMinTenureMonths / selfApplyMaxAmount.
 * Links: payroll-config.schema.ts loanConfig, loan-request.schema.ts.
 */
class PayrollLoanConfigDto {
  /** AND-gate for the self-service 0% loan request; OFF by default. */
  @IsBoolean()
  @IsOptional()
  selfApplyEnabled?: boolean;

  /** Minimum tenure months (since join) required to self-apply; null = no minimum. */
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  @IsOptional()
  selfApplyMinTenureMonths?: number | null;

  /** Max self-apply requestedAmount in paise; null = no cap. */
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(1)
  @IsOptional()
  selfApplyMaxAmount?: number | null;
}

class PayrollDeductorDto {
  @IsString()
  @IsOptional()
  tan?: string;

  @IsString()
  @IsOptional()
  pan?: string;

  @IsString()
  @IsOptional()
  branchDivision?: string;

  @IsString()
  @IsOptional()
  address1?: string;

  @IsString()
  @IsOptional()
  address2?: string;

  @IsString()
  @IsOptional()
  city?: string;

  @IsString()
  @IsOptional()
  state?: string;

  @IsString()
  @IsOptional()
  pincode?: string;

  @IsString()
  @IsOptional()
  phone?: string;

  @IsString()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  responsiblePersonName?: string;

  @IsString()
  @IsOptional()
  responsiblePersonPan?: string;

  @IsString()
  @IsOptional()
  responsiblePersonDesignation?: string;
}

export class UpdatePayrollConfigDto {
  @IsEnum(['basic', 'standard', 'professional', 'enterprise', 'custom'])
  @IsOptional()
  preset?: string;

  @ValidateNested()
  @Type(() => PayrollFeaturesDto)
  @IsOptional()
  features?: PayrollFeaturesDto;

  @ValidateNested()
  @Type(() => PayrollDisplayDto)
  @IsOptional()
  display?: PayrollDisplayDto;

  @ValidateNested()
  @Type(() => PayrollRulesDto)
  @IsOptional()
  rules?: PayrollRulesDto;

  @ValidateNested()
  @Type(() => PayrollStatutoryDto)
  @IsOptional()
  statutory?: PayrollStatutoryDto;

  @ValidateNested()
  @Type(() => PayrollDeductorDto)
  @IsOptional()
  deductor?: PayrollDeductorDto;

  @ValidateNested()
  @Type(() => PayrollComplianceDto)
  @IsOptional()
  compliance?: PayrollComplianceDto;

  // loanConfig self-apply settings (additive). Foundation only — the
  // updatePayrollConfig service does not yet persist loanConfig; that consumer
  // wiring lands in Task 2 with the LoanRequest endpoints.
  @ValidateNested()
  @Type(() => PayrollLoanConfigDto)
  @IsOptional()
  loanConfig?: PayrollLoanConfigDto;
}
