import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
  ValidateIf,
  ArrayMinSize,
} from 'class-validator';
import { OmitType, PartialType } from '@nestjs/mapped-types';
import { IsAadhaar } from '../../../common/helpers/aadhaar.validator';
import { FULL_INDIAN_RE, transformMobile } from '../../auth/utils/mobile-normalizer';

export class ScheduleDto {
  @IsString() @IsNotEmpty() startTime: string;
  @IsString() @IsNotEmpty() endTime: string;
}

export class BankDetailsDto {
  @IsString() @IsOptional() bankName?: string;
  @IsString() @IsOptional() accountHolderName?: string;
  @Matches(/^[0-9]{9,18}$/, { message: 'Account number must be 9–18 digits' })
  @IsOptional()
  accountNumber?: string;
  @Matches(/^[A-Z]{4}0[A-Z0-9]{6}$/, {
    message: 'Invalid IFSC code (e.g. SBIN0001234)',
  })
  @IsOptional()
  ifscCode?: string;
  @IsString() @IsOptional() passbookImageUrl?: string;
}

export class UpiDetailsDto {
  @Matches(/^[a-zA-Z0-9.\-_]{2,}@[a-zA-Z]{2,}$/, {
    message: 'Invalid UPI ID format (e.g. name@bank)',
  })
  @IsOptional()
  upiId?: string;
  @IsString() @IsOptional() qrCodeUrl?: string;
}

export class ComponentOverrideDto {
  @IsString() @IsNotEmpty() componentId: string;
  @IsIn(['fixed', 'percent_of_ctc', 'percent_of_component'])
  @IsOptional()
  calcMode?: string;
  @IsNumber() @Min(0) @IsOptional() value?: number;
}

export enum TaxRegime {
  OLD = 'old',
  NEW = 'new',
}

export enum EmploymentType {
  FULL_TIME = 'full_time',
  PART_TIME = 'part_time',
  CONTRACT = 'contract',
  INTERN = 'intern',
  CONSULTANT = 'consultant',
}

export enum MaritalStatus {
  SINGLE = 'single',
  MARRIED = 'married',
  DIVORCED = 'divorced',
  WIDOWED = 'widowed',
}

export class CreateTeamMemberDto {
  @IsString() @IsNotEmpty() name: string;
  // Reuse the same Indian-mobile contract as the auth signup/login DTOs
  // (see crewroster-backend/src/modules/auth/dto/sms-otp.dto.ts). The
  // `@Transform` normalises any of `9876543210` / `+919876543210` / `91 9876
  // 543 210` etc. to the canonical `919876543210` form before `@Matches` runs.
  // Stored value is therefore the 12-digit `91XXXXXXXXXX` shape — same as
  // every mobile already persisted via the auth flow.
  @Transform(transformMobile)
  @Matches(FULL_INDIAN_RE, {
    message: 'Enter a valid Indian mobile number (10 digits, +91 prefix optional)',
  })
  @IsOptional()
  mobile?: string;
  @IsEmail() @IsOptional() email?: string;
  @IsString() @IsOptional() designation?: string;
  @IsString() @IsOptional() department?: string;
  // `location` is the denormalised location NAME (legacy free-text, also used by
  // the ID card). `locationId` is the canonical reference into the workspace
  // Locations master list (shared with the Machines module). Both are sent
  // together; the FE sets the name from the picked location.
  @IsString() @IsOptional() location?: string;
  @ValidateIf((_, v) => v !== null)
  @IsMongoId()
  @IsOptional()
  locationId?: string | null;
  @IsString() @IsOptional() avatar?: string;

  @ValidateIf((_, v) => v !== null)
  @IsMongoId()
  @IsOptional()
  rbacRoleId?: string | null;
  @ValidateIf((object, value) => value !== null)
  @IsMongoId()
  @IsOptional()
  shiftId?: string | null;
  @ValidateIf((_, v) => v !== null)
  @IsMongoId()
  @IsOptional()
  reportsTo?: string | null;
  @IsIn(['shift', 'custom']) @IsOptional() scheduleType?: string;
  @IsArray() @IsString({ each: true }) @IsOptional() weeklyOff?: string[];
  @ValidateNested()
  @Type(() => ScheduleDto)
  @IsOptional()
  customSchedule?: ScheduleDto;

  @IsIn(['monthly', 'hourly']) @IsOptional() salaryType?: string;
  @IsNumber() @Min(0) @Max(100_000_000) @IsOptional() salaryAmount?: number;
  @IsNumber() @IsOptional() dailyHours?: number;
  @IsNumber() @IsOptional() workingDays?: number;
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  @IsOptional()
  finalMonthlyOverride?: number | null;

  @IsIn(['fixed_month_days', 'calendar_month_days'])
  @IsOptional()
  salaryDayBasis?: 'fixed_month_days' | 'calendar_month_days';

  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(1)
  @Max(31)
  @IsOptional()
  fixedMonthDays?: number | null;

  @IsIn(['default', 'enabled', 'disabled'])
  @IsOptional()
  attendancePayMode?: 'default' | 'enabled' | 'disabled';

  @IsNumber() @Min(0) @IsOptional() ctcAmount?: number;

  @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]$/, {
    message: 'Invalid PAN format (e.g. ABCDE1234F)',
  })
  @IsOptional()
  pan?: string;
  @Matches(/^[0-9]{12}$/, { message: 'UAN must be exactly 12 digits' })
  @IsOptional()
  uan?: string;
  @IsEnum(TaxRegime) @IsOptional() taxRegime?: TaxRegime;
  @IsString() @IsOptional() stateOfEmployment?: string;
  @IsEnum(EmploymentType) @IsOptional() employmentType?: EmploymentType;
  @IsBoolean() @IsOptional() pfApplicable?: boolean;
  @IsBoolean() @IsOptional() pfOptedOut?: boolean;
  @IsBoolean() @IsOptional() esiApplicable?: boolean;
  @IsString() @IsOptional() esiIpNumber?: string;
  @IsEnum(MaritalStatus) @IsOptional() maritalStatus?: MaritalStatus;
  @IsBoolean() @IsOptional() isNonItrFiler?: boolean;

  @IsBoolean() @IsOptional() isKarigar?: boolean;

  @IsOptional()
  @IsEnum(['zari', 'embroidery', 'print', 'dyeing', 'cutting', 'finishing', 'other'])
  karigarSkillType?: 'zari' | 'embroidery' | 'print' | 'dyeing' | 'cutting' | 'finishing' | 'other';

  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  @IsOptional()
  karigarDailyRatePaise?: number | null;

  @ValidateIf((_, v) => v !== null)
  @IsMongoId()
  @IsOptional()
  componentTemplateId?: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ComponentOverrideDto)
  @IsOptional()
  componentOverrides?: ComponentOverrideDto[];

  @ValidateNested()
  @Type(() => BankDetailsDto)
  @IsOptional()
  bankDetails?: BankDetailsDto;
  @ValidateNested()
  @Type(() => UpiDetailsDto)
  @IsOptional()
  upiDetails?: UpiDetailsDto;
  @IsIn(['BANK', 'UPI', 'CASH']) @IsOptional() preferredMethod?: 'BANK' | 'UPI' | 'CASH';

  @IsAadhaar() @IsOptional() aadhaar?: string;
  @IsString() @IsOptional() aadhaarImageUrl?: string;
  @IsString() @IsOptional() fatherOrSpouseName?: string;
  @IsString() @IsOptional() nationality?: string;

  @Matches(/^[A-Za-z0-9_-]{1,32}$/, {
    message:
      'Employee code may only contain letters, digits, hyphens, and underscores (max 32 chars)',
  })
  @IsOptional()
  employeeCode?: string;

  @IsDateString({}, { message: 'dateOfBirth must be ISO 8601 (YYYY-MM-DD)' })
  @IsOptional()
  dateOfBirth?: string;
  @IsDateString({}, { message: 'dateOfJoining must be ISO 8601 (YYYY-MM-DD)' })
  @IsOptional()
  dateOfJoining?: string;
  @IsDateString({}, { message: 'dateOfResignation must be ISO 8601 (YYYY-MM-DD)' })
  @IsOptional()
  dateOfResignation?: string;
  @IsIn(['male', 'female', 'other']) @IsOptional() gender?: string;
  @IsString() @IsOptional() bloodGroup?: string;
  @IsString() @IsOptional() emergencyContactName?: string;
  // Same Indian-mobile contract as `mobile` above. ValidateIf so empty /
  // unset values short-circuit (the field is optional, unlike `name`).
  @ValidateIf((_, v) => typeof v === 'string' && v.trim().length > 0)
  @Transform(transformMobile)
  @Matches(FULL_INDIAN_RE, {
    message: 'Enter a valid Indian mobile number (10 digits, +91 prefix optional)',
  })
  @IsOptional()
  emergencyContactNumber?: string;
  @IsString() @IsOptional() address?: string;
  @IsBoolean() @IsOptional() isActive?: boolean;

  /**
   * Phase 1 compliance — per-member minimum-wage monthly override (INR).
   * When set, overrides the workspace-level PayrollConfig.compliance.minimumWageMonthly
   * for the compliance guard. Null clears the override (falls through to workspace default).
   * Write-gated to HR and Owner via the 'statutory' field group
   * (same gate as pan, uan, aadhaar).
   */
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  @IsOptional()
  minimumWageMonthlyOverride?: number | null;

  /**
   * Phase 1f.1 — optional mobile-verify proof token.
   * When present, assertProofToken validates the JWT and stamps
   * mobileVerifiedAt / mobileVerifiedBy on the persisted TeamMember.
   * When absent, mobileVerifiedAt is left null (verification was skipped).
   */
  @IsString() @IsOptional() mobileVerifyToken?: string;
}

// Employee code is immutable after creation — omit from UpdateTeamMemberDto.
export class UpdateTeamMemberDto extends PartialType(
  OmitType(CreateTeamMemberDto, ['employeeCode'] as const),
) {
  @IsBoolean() @IsOptional() isNonItrFiler?: boolean;
}

export class GrantAccessDto {
  @IsMongoId() rbacRoleId: string;
  @IsIn(['auto', 'link', 'both']) sendMethod: string;
  @IsEmail() @IsOptional() email?: string;
}

export class ImportMembersDto {
  @IsMongoId() sourceWorkspaceId: string;
  @IsArray() @IsMongoId({ each: true }) memberIds: string[];
  @IsMongoId() rbacRoleId: string;
}

export class OffboardMemberDto {
  @IsString() @IsNotEmpty() lastWorkingDate: string;
  @IsString() @IsOptional() resignationNote?: string;
}

export class RevealStatutoryDto {
  @IsIn(['aadhaar', 'pan']) field: 'aadhaar' | 'pan';
}

export class BulkStatusDto {
  @IsArray()
  @IsMongoId({ each: true })
  @ArrayMinSize(1)
  memberIds: string[];

  @IsIn(['active', 'inactive'])
  status: 'active' | 'inactive';
}

export class BulkDeleteDto {
  @IsArray()
  @IsMongoId({ each: true })
  @ArrayMinSize(1)
  memberIds: string[];
}

export class BulkRestoreDto {
  @IsArray()
  @IsMongoId({ each: true })
  @ArrayMinSize(1)
  memberIds: string[];
}

// CSV bulk-import payload. The web import wizard parses a CSV, maps the
// columns (combining first/last name into the single `name` field), then
// posts the normalized rows here. Each row is a full CreateTeamMemberDto so
// it reuses the exact same per-member validation + employee-code generation
// as single create. Capped at 500 rows/request — the wizard chunks larger
// files. Keep MAX in sync with team.controller `bulk-create` + the web
// `MAX_BULK_IMPORT_ROWS`.
export class BulkCreateTeamMembersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateTeamMemberDto)
  members: CreateTeamMemberDto[];
}
