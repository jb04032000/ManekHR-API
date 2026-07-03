import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsHexColor,
  IsIn,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

const HALF_DAY = ['none', 'first_half', 'second_half'] as const;

export class ApplyLeaveDto {
  /** Target member — ignored for self-scoped callers (resolved server-side). */
  @IsOptional()
  @IsMongoId()
  memberId?: string;

  @IsMongoId()
  leaveTypeId: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'fromDate must be YYYY-MM-DD' })
  fromDate: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'toDate must be YYYY-MM-DD' })
  toDate: string;

  @IsOptional()
  @IsEnum(HALF_DAY)
  firstDayHalf?: (typeof HALF_DAY)[number];

  @IsOptional()
  @IsEnum(HALF_DAY)
  lastDayHalf?: (typeof HALF_DAY)[number];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  attachments?: string[];
}

export class UpdateLeaveSettingsDto {
  @IsArray()
  @IsMongoId({ each: true })
  approverUserIds: string[];

  @IsBoolean()
  sandwichLeave: boolean;

  @IsInt()
  @Min(0)
  @Max(365)
  retroMaxDaysBack: number;

  @IsInt()
  @Min(0)
  @Max(10)
  maxAttachmentsPerRequest: number;
}

export class ApplyCompOffDto {
  /** Target member — ignored for self-scoped callers (resolved server-side). */
  @IsOptional()
  @IsMongoId()
  memberId?: string;

  /** The holiday / weekly-off the member worked. */
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'workDate must be YYYY-MM-DD' })
  workDate: string;

  /** Days earned — a full day (1) or half day (0.5). */
  @IsNumber()
  @IsIn([0.5, 1])
  quantity: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  attachments?: string[];
}

export class DecideLeaveDto {
  /** Optional approver note recorded on the approval-chain step. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CreateDelegationDto {
  /** The delegate who may act in the caller's place. */
  @IsMongoId()
  toUserId: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'startsOn must be YYYY-MM-DD' })
  startsOn: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'endsOn must be YYYY-MM-DD' })
  endsOn: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ListDelegationsQuery {
  @IsOptional()
  @IsMongoId()
  fromUserId?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  includeInactive?: string;
}

export class TeamConflictQuery {
  /** Target member — ignored for self-scoped callers (resolved server-side). */
  @IsOptional()
  @IsMongoId()
  memberId?: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to: string;
}

export class LeaveCalendarQuery {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to: string;
}

export class ListLeaveRequestsQuery {
  @IsOptional()
  @IsEnum(['pending', 'approved', 'rejected', 'cancelled', 'withdrawn'])
  status?: string;

  @IsOptional()
  @IsMongoId()
  memberId?: string;
}

/** `GET /types` query — opt-in to include archived (`isActive: false`) types. */
export class ListLeaveTypesQuery {
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeInactive?: boolean;
}

/** `GET /balances` query — leave year + optional target member (HR view). */
export class GetBalancesQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2200)
  year?: number;

  @IsOptional()
  @IsMongoId()
  memberId?: string;
}

// ── Leave-type catalogue CRUD (L5a admin config) ───────────────────────────

const LEAVE_UNIT = ['full_day', 'half_day_capable'] as const;
const STATUTORY_BASIS = ['factories_act', 'shops_act', 'maternity_act', 'voluntary'] as const;
const ACCRUAL_MODE = ['upfront_annual', 'periodic_accrual', 'none'] as const;
const ACCRUAL_FREQUENCY = ['monthly', 'quarterly', 'annual'] as const;
const GENDER_APPLICABILITY = ['male', 'female', 'any'] as const;

class LeaveTypeLabelsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  en: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  'gu-en'?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  'hi-en'?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  gu?: string;
}

class LeaveTypeApplicabilityDto {
  @IsOptional()
  @IsIn(GENDER_APPLICABILITY)
  gender?: (typeof GENDER_APPLICABILITY)[number];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(36500)
  minTenureDays?: number | null;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  designationIds?: string[];
}

class LeaveTypeAccrualRuleDto {
  @IsIn(ACCRUAL_MODE)
  mode: (typeof ACCRUAL_MODE)[number];

  @IsNumber()
  @Min(0)
  @Max(366)
  annualQuantity: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(366)
  rate?: number | null;

  @IsOptional()
  @IsIn(ACCRUAL_FREQUENCY)
  frequency?: (typeof ACCRUAL_FREQUENCY)[number] | null;

  @IsBoolean()
  proRateFirstPeriod: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(999)
  accrualCap?: number | null;

  @IsInt()
  @Min(0)
  @Max(3650)
  eligibleAfterDays: number;
}

class LeaveTypeYearEndRuleDto {
  @IsNumber()
  @Min(0)
  @Max(999)
  carryForwardCap: number;

  @IsBoolean()
  lapseExcess: boolean;

  @IsBoolean()
  encashable: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(999)
  encashmentCap?: number | null;
}

class LeaveTypeCompOffDto {
  @IsBoolean()
  isCompOff: boolean;

  @IsInt()
  @Min(1)
  @Max(730)
  validityDays: number;
}

export class CreateLeaveTypeDto {
  /** Short uppercase code, unique per workspace. Immutable once created. */
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,11}$/, {
    message: 'code must be 2-12 uppercase letters/digits, starting with a letter',
  })
  code: string;

  @ValidateNested()
  @Type(() => LeaveTypeLabelsDto)
  labels: LeaveTypeLabelsDto;

  @IsOptional()
  @IsHexColor()
  color?: string;

  @IsBoolean()
  isPaid: boolean;

  @IsIn(LEAVE_UNIT)
  unit: (typeof LEAVE_UNIT)[number];

  @IsIn(STATUTORY_BASIS)
  statutoryBasis: (typeof STATUTORY_BASIS)[number];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(366)
  maxPerRequest?: number | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => LeaveTypeApplicabilityDto)
  applicability?: LeaveTypeApplicabilityDto;

  @ValidateNested()
  @Type(() => LeaveTypeAccrualRuleDto)
  accrualRule: LeaveTypeAccrualRuleDto;

  @ValidateNested()
  @Type(() => LeaveTypeYearEndRuleDto)
  yearEndRule: LeaveTypeYearEndRuleDto;

  @ValidateNested()
  @Type(() => LeaveTypeCompOffDto)
  compOff: LeaveTypeCompOffDto;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class PostAdjustmentDto {
  @IsMongoId()
  teamMemberId: string;

  @IsMongoId()
  leaveTypeId: string;

  @IsInt()
  @Min(2000)
  @Max(2200)
  year: number;

  /** Signed correction — a positive value credits days, a negative value debits. */
  @IsNumber()
  @Min(-999)
  @Max(999)
  quantity: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export class UpdateLeaveTypeDto {
  // `code` is intentionally omitted — a leave type's code is immutable
  // (the ledger / requests reference the type by `_id`, but the code is the
  // workspace-facing identity and changing it post-hoc is confusing).
  @IsOptional()
  @ValidateNested()
  @Type(() => LeaveTypeLabelsDto)
  labels?: LeaveTypeLabelsDto;

  @IsOptional()
  @IsHexColor()
  color?: string;

  @IsOptional()
  @IsBoolean()
  isPaid?: boolean;

  @IsOptional()
  @IsIn(LEAVE_UNIT)
  unit?: (typeof LEAVE_UNIT)[number];

  @IsOptional()
  @IsIn(STATUTORY_BASIS)
  statutoryBasis?: (typeof STATUTORY_BASIS)[number];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(366)
  maxPerRequest?: number | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => LeaveTypeApplicabilityDto)
  applicability?: LeaveTypeApplicabilityDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LeaveTypeAccrualRuleDto)
  accrualRule?: LeaveTypeAccrualRuleDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LeaveTypeYearEndRuleDto)
  yearEndRule?: LeaveTypeYearEndRuleDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LeaveTypeCompOffDto)
  compOff?: LeaveTypeCompOffDto;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
