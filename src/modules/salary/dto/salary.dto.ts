import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsIn,
  ValidateNested,
  IsArray,
  ArrayMinSize,
  Min,
  Max,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';

class SplitLineDto {
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

class UpiDebitedAccountDto {
  @IsString() @IsNotEmpty() bankName: string;
  @IsString() @IsNotEmpty() accountNumber: string;
  @IsString() @IsOptional() upiRef?: string;
}

class BankFromAccountDto {
  @IsString() @IsNotEmpty() bankName: string;
  @IsString() @IsNotEmpty() accountNumber: string;
}

export class UpdateSalaryRecordDto {
  @IsNumber() @IsOptional() baseSalary?: number;
  @IsNumber() @IsOptional() additions?: number;
  @IsNumber() @IsOptional() deductions?: number;
}

export type SetBasePayComponentOverrideDto = {
  componentId: string;
  calcMode?: string;
  value?: number;
};

export type SalaryDayBasisDto = 'fixed_month_days' | 'calendar_month_days';

export type AttendancePayModeDto = 'default' | 'enabled' | 'disabled';

type SetBasePaySalaryConfigBaseDto = {
  salaryAmount?: number;
  salaryType?: 'monthly' | 'hourly';
  salaryDayBasis?: SalaryDayBasisDto;
  fixedMonthDays?: number | null;
  attendancePayMode?: AttendancePayModeDto;
  preferredMethod?: 'BANK' | 'UPI';
  upiDetails?: {
    upiId: string;
    qrCodeUrl?: string;
  };
  bankDetails?: {
    bankName: string;
    accountHolderName: string;
    accountNumber: string;
    ifscCode: string;
    passbookImageUrl?: string;
  };
};

export type MonthlySetBasePaySalaryConfigDto = SetBasePaySalaryConfigBaseDto & {
  salaryType?: 'monthly';
  ctcAmount?: number | null;
  componentTemplateId?: string | null;
  componentOverrides?: SetBasePayComponentOverrideDto[];
};

export type HourlySetBasePaySalaryConfigDto = SetBasePaySalaryConfigBaseDto & {
  salaryType?: 'hourly';
  finalMonthlyOverride?: number | null;
  dailyHours?: number;
};

export type SetBasePaySalaryConfigDto =
  | MonthlySetBasePaySalaryConfigDto
  | HourlySetBasePaySalaryConfigDto;

export type SetBasePayBodyDto = {
  teamMemberId?: string;
  salaryConfig?: SetBasePaySalaryConfigDto;
  salaryRecordUpdate?: {
    salaryId: string;
    baseSalary: number;
  };
};

export class CreateSalaryAdjustmentDto {
  @IsEnum(['addition', 'deduction'])
  type: 'addition' | 'deduction';

  @IsMongoId()
  @IsOptional()
  correctionOfAdjustmentId?: string;

  // Statutory system categories: 'pf_employee' | 'esi_employee' | 'pt_employee' | 'tds_employee'
  @IsString()
  @IsNotEmpty()
  category: string;

  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsString()
  @IsNotEmpty()
  reasonTitle: string;

  @IsString()
  @IsOptional()
  note?: string;

  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @IsOptional()
  attachments?: string[];
}

export class ReverseSalaryAdjustmentDto {
  @IsString()
  @IsNotEmpty()
  reversalReason: string;
}

export class ReversePaymentDto {
  @IsString()
  @IsNotEmpty()
  reversalReason: string;
}

export class RecordPaymentDto {
  @IsString() @IsOptional() salaryId?: string;
  @IsString() @IsOptional() teamMemberId?: string;
  @IsNumber() @IsOptional() month?: number;
  @IsNumber() @IsOptional() year?: number;
  @IsNumber() @IsNotEmpty() @Min(0) amount: number;
  @IsString() @IsNotEmpty() paymentDate: string;
  @IsEnum(['cash', 'bank_transfer', 'upi', 'cheque', 'split', 'other'])
  paymentMode: string;
  @IsString() @IsOptional() note?: string;
  @IsString() @IsOptional() referenceNo?: string;
  @IsString() @IsOptional() transactionId?: string;
  @IsString() @IsOptional() voucherNo?: string;

  @IsBoolean() @IsOptional() proofAttached?: boolean;
  @IsString() @IsOptional() proofUrl?: string;
  @IsArray() @IsString({ each: true }) @IsOptional() proofUrls?: string[];
  @IsString() @IsOptional() paymentFrom?: string;
  @IsString() @IsOptional() paidBy?: string;

  @ValidateNested()
  @Type(() => UpiDebitedAccountDto)
  @IsOptional()
  upiDebitedAccount?: UpiDebitedAccountDto;
  @ValidateNested()
  @Type(() => BankFromAccountDto)
  @IsOptional()
  bankFromAccount?: BankFromAccountDto;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SplitLineDto)
  @IsOptional()
  splitLines?: SplitLineDto[];

  @IsNumber()
  @IsOptional()
  @Min(0)
  commission?: number;

  @IsString()
  @IsOptional()
  commissionNote?: string;

  @IsString()
  @IsOptional()
  commissionTitle?: string;

  @IsOptional()
  @IsString()
  @IsIn(['next_month', 'this_month'])
  advanceTarget?: 'next_month' | 'this_month';

  /**
   * Optional installment config for multi-month advance recovery (EMI).
   * When installmentCount > 1 (or installmentAmount is supplied), a full
   * AdvanceRecoveryPlan is created and the advance is spread across months.
   * When absent or installmentCount === 1, the legacy single-month recovery
   * path is used unchanged.
   */
  @IsOptional()
  advanceInstallments?: {
    installmentCount?: number;
    installmentAmount?: number;
  };

  /**
   * Set to true to proceed when one or more installment months breach a hard
   * compliance rule (deduction cap or minimum-wage floor). When true, the system
   * applies the clamped compliant amount rather than the original and emits an
   * audit event. Requires overrideReason.
   */
  @IsOptional()
  @IsBoolean()
  overrideCompliance?: boolean;

  /**
   * Human-readable justification for the override. Conceptually required when
   * overrideCompliance is true; enforced in the service, not the DTO validator,
   * so the client receives a clear operational error rather than a validation one.
   */
  @IsOptional()
  @IsString()
  overrideReason?: string;

  /**
   * D-10: COA cash/bank account to credit for this payment.
   * When supplied, the ledger entry credits this account; otherwise defaults
   * to account 1001 (Cash). Persisted as last-used for pre-selection.
   */
  @IsOptional()
  @IsMongoId()
  coaAccountId?: string;
}

export class BulkPaymentItemDto {
  @IsOptional()
  @IsString()
  salaryId?: string;

  @IsOptional()
  @IsString()
  teamMemberId?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  month?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  year?: number;

  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  amount: number;

  @IsString()
  @IsIn(['cash', 'bank_transfer', 'upi', 'cheque', 'other'])
  paymentMode: string;

  @IsString()
  paymentDate: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsString()
  referenceNo?: string;

  @IsOptional()
  @IsString()
  paymentFrom?: string;

  @IsOptional()
  @IsString()
  paidBy?: string;

  @IsOptional()
  @IsString()
  @IsIn(['next_month', 'this_month'])
  advanceTarget?: 'next_month' | 'this_month';

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  commission?: number;

  @IsOptional()
  @IsString()
  commissionTitle?: string;

  @IsOptional()
  @IsString()
  commissionNote?: string;
}

export class BulkRecordPaymentDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkPaymentItemDto)
  @ArrayMinSize(1)
  payments: BulkPaymentItemDto[];
}

export class CreateIncrementDto {
  @IsMongoId()
  @IsNotEmpty()
  teamMemberId: string;

  @IsNumber()
  @Min(1)
  @Max(12)
  effectiveMonth: number;

  @IsNumber()
  @Min(2000)
  effectiveYear: number;

  @IsEnum(['fixed_amount', 'percentage'])
  type: 'fixed_amount' | 'percentage';

  @IsNumber()
  @Min(0.01)
  value: number;

  @IsString()
  @IsOptional()
  note?: string;
}

export class GetSalaryRecordsPaginatedDto {
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(1)
  @Max(12)
  month?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(2000)
  year?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  shiftId?: string;

  @IsOptional()
  @IsString()
  teamMemberId?: string;

  @IsOptional()
  @IsString()
  @IsIn(['all', 'pending', 'partial', 'paid', 'advance', 'salary_not_set', 'not_generated'])
  status?: string;

  @IsOptional()
  @IsString()
  @IsIn(['name', 'netSalary', 'paidAmount', 'status'])
  sortBy?: string;

  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}

export class GetSalaryShiftSummariesDto {
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(1)
  @Max(12)
  month?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(2000)
  year?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  teamMemberId?: string;

  @IsOptional()
  @IsString()
  @IsIn(['all', 'pending', 'partial', 'paid', 'advance', 'salary_not_set', 'not_generated'])
  status?: string;
}

export class GetPaymentRegisterDto {
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(1)
  @Max(12)
  month?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(2000)
  year?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(1)
  page?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(1)
  limit?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  @IsIn(['all', 'active', 'reversed'])
  status?: 'all' | 'active' | 'reversed';

  @IsOptional()
  @IsString()
  teamMemberId?: string;
}

export class GetTaxDeclarationQueryDto {
  @IsNumber()
  @Type(() => Number)
  @Min(2000)
  financialYear: number;
}

export class UpsertTaxDeclarationDto {
  @IsNumber()
  @Type(() => Number)
  @Min(2000)
  financialYear: number;

  @IsEnum(['old', 'new'])
  @IsOptional()
  taxRegime?: 'old' | 'new';

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  hraExemption?: number;

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  deduction80C?: number;

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  deduction80D?: number;

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  deduction80G?: number;

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  deduction80CCD1B?: number;

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  deduction80TTA?: number;

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  otherDeductions?: number;

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  previousEmployerGross?: number;

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  previousEmployerTds?: number;

  @IsString()
  @IsOptional()
  notes?: string;

  // OQ-S6: HR-only declaration lock toggle. The salary service strips this for
  // self-scoped (worker) callers, so a worker submitting it is ignored.
  @IsBoolean()
  @IsOptional()
  isLocked?: boolean;
}

export class GetTdsPreviewQueryDto {
  @IsNumber()
  @Type(() => Number)
  @Min(1)
  @Max(12)
  month: number;

  @IsNumber()
  @Type(() => Number)
  @Min(2000)
  year: number;
}

// ---------------------------------------------------------------------------
// Advance Recovery Plan DTOs (Task 5)
// ---------------------------------------------------------------------------

export class EditAdvanceRecoveryPlanDto {
  @IsOptional()
  @IsNumber()
  @Min(1)
  installmentAmount?: number;

  @IsOptional()
  @IsIn(['pause', 'resume'])
  action?: 'pause' | 'resume';
}

export class EarlyPayoffAdvanceRecoveryPlanDto {
  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class PreviewAdvanceScheduleDto {
  @IsNumber()
  @Min(1)
  totalAmount: number;

  @IsInt()
  @Min(1)
  @Max(12)
  startMonth: number;

  @IsInt()
  startYear: number;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(24)
  installmentCount?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  installmentAmount?: number;

  @IsOptional()
  @IsMongoId()
  teamMemberId?: string;

  /**
   * Set to true to receive the compliance result (breaches + warnings) in the
   * preview response even when breaches are present. Preview never throws; this
   * flag is informational.
   */
  @IsOptional()
  @IsBoolean()
  overrideCompliance?: boolean;

  /**
   * Reason for override. Surfaced in the preview response when present so the
   * web client can pre-fill the override modal.
   */
  @IsOptional()
  @IsString()
  overrideReason?: string;
}
